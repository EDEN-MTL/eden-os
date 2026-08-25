/**
 * Turns a raw GHL contact payload into a normalised lead.
 *
 * Kept free of I/O so the parsing and scoring rules can be tested directly —
 * these are the rules most likely to drift as the client changes their forms,
 * and a silent drift here is expensive: a wrong field key returns null rather
 * than throwing, so leads quietly score as if the answer were "no".
 */

export interface ScoutFieldMap {
  propertyInterest: string;
  budget: string;
  timeline: string;
  preApproved: string;
  leadSource: string;
}

export interface ScoutConfig {
  pipelineId: string;
  intakeStages: Record<string, string>;
  qualifiedTags: string[];
  calendars: { buyer: string; seller: string };
  fields: ScoutFieldMap;
}

export interface NormalisedLead {
  contactId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  propertyInterest: string | null;
  budget: string | null;
  timeline: string | null;
  preApproved: boolean | null;
  leadSource: string | null;
  /** Ad-level attribution, when the lead carried it through from the ad click. */
  attribution: {
    fbclid: string | null;
    utmSource: string | null;
    utmCampaign: string | null;
    metaCampaignId: string | null;
    metaAdsetId: string | null;
    metaAdId: string | null;
  };
  attributed: boolean;
  qualified: boolean;
  intent: "buyer" | "seller" | "downsize" | "upgrading" | "unknown";
  score: number;
  scoreReasons: string[];
}

/**
 * Maps fieldKey -> GHL's internal field id.
 *
 * This is the crux of reading anything from a GHL contact. The REST API
 * returns customFields keyed by an opaque internal id (uOO2RgUu7n1w9LjJHsQQ),
 * NOT by the readable fieldKey (contact.lf_timeframe) that config files are
 * written in. Matching on the key alone silently returns null for every
 * field — verified against this location, where the list endpoint returns
 * customFields: [] and the individual GET returns id-keyed entries.
 *
 * Webhook payloads are a different shape again, which is why readField below
 * still accepts key-shaped objects. Pass the lookup when reading an API
 * contact; omit it when reading a webhook body.
 */
export function buildKeyToId(customFieldDefs: any[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const def of customFieldDefs) if (def?.fieldKey && def?.id) m.set(def.fieldKey, def.id);
  return m;
}

/**
 * Reads one field across every shape GHL actually sends:
 *   - API contact:  [{ id: "<internal id>", value: "..." }]   (needs keyToId)
 *   - webhook body: { "contact.lf_budget": "..." } or { lf_budget: "..." }
 *   - webhook array:[{ key: "contact.lf_budget", value: "..." }]
 *
 * Empty string counts as absent — a blank answer is not an answer.
 */
export function readField(customFields: any, key: string, keyToId?: Map<string, string>): string | null {
  if (!customFields) return null;
  const bare = key.replace(/^contact\./, "");
  const fieldId = keyToId?.get(key);
  const clean = (v: any) => (v === undefined || v === null || v === "" ? null : String(v));

  if (!Array.isArray(customFields)) {
    for (const k of [key, bare]) {
      const hit = clean(customFields[k]);
      if (hit !== null) return hit;
    }
    return fieldId ? clean(customFields[fieldId]) : null;
  }
  for (const entry of customFields) {
    const id = entry?.key ?? entry?.fieldKey ?? entry?.id;
    if (id === key || id === bare || (fieldId && entry?.id === fieldId)) {
      return clean(entry?.value ?? entry?.field_value);
    }
  }
  return null;
}

/**
 * GHL stores yes/no answers as free text, and this client's form has been
 * through several revisions, so the stored values are inconsistent.
 * Anything unrecognised stays null rather than defaulting to false —
 * "we don't know" and "no" lead to different follow-up.
 */
export function parseYesNo(raw: string | null): boolean | null {
  if (raw === null) return null;
  const v = raw.trim().toLowerCase();
  if (["yes", "y", "true", "1", "oui", "pre-approved", "approved"].includes(v)) return true;
  if (["no", "n", "false", "0", "non", "not approved", "not yet"].includes(v)) return false;
  return null;
}

/**
 * Intent comes from the intake STAGE, not from the lead form.
 *
 * Mark's notes say lead type is "captured separately in
 * customFields.propertyInterest", but that field is empty on every one of
 * the 80 live contacts checked — it appears on the form and is never written.
 * The pipeline itself carries the answer: a lead lands directly in Buyer
 * Leads / Seller Leads / Downsize Leads / Upgrading Leads. The stage name is
 * the signal, so read that first and treat the field as a bonus if the
 * client ever starts populating it.
 */
export function intentFromStage(stageName: string | null): NormalisedLead["intent"] {
  const v = (stageName || "").toLowerCase();
  if (v.includes("downsiz")) return "downsize";
  if (v.includes("upgrad")) return "upgrading";
  if (v.includes("seller")) return "seller";
  if (v.includes("buyer")) return "buyer";
  return "unknown";
}

/**
 * Resolves intent from the opportunity's stage ID.
 *
 * The API returns pipelineStageId, never a stage name — checked across 222
 * live opportunities, all of which carry an id like
 * f83b5ac8-e445-4a3e-b1e0-ac99a4747b56 and no name field at all. So the
 * intakeStages map in config (stage name -> stage id) has to be read
 * backwards to turn that id into something meaningful.
 */
export function intentFromStageId(
  stageId: string | null | undefined,
  intakeStages: Record<string, string>
): NormalisedLead["intent"] {
  if (!stageId) return "unknown";
  for (const [name, id] of Object.entries(intakeStages)) {
    if (name.startsWith("_")) continue;
    if (id === stageId) return intentFromStage(name);
  }
  return "unknown";
}

export function deriveIntent(propertyInterest: string | null): NormalisedLead["intent"] {
  const v = (propertyInterest || "").toLowerCase();
  if (!v) return "unknown";
  if (v.includes("downsiz")) return "downsize";
  if (v.includes("upgrad")) return "upgrading";
  if (v.includes("sell") || v.includes("list")) return "seller";
  if (v.includes("buy") || v.includes("purchas")) return "buyer";
  return "unknown";
}

/**
 * Scoring leans on pre-approval because that is the one signal the team
 * actually uses today — Mark confirmed the ISA pre-screens on it, and that
 * GHL's built-in "Engagement Score" profile has never been switched on.
 * Deliberately simple: a score nobody can explain is a score nobody trusts.
 */
export function scoreLead(lead: Omit<NormalisedLead, "score" | "scoreReasons">): {
  score: number;
  reasons: string[];
} {
  let score = 0;
  const reasons: string[] = [];
  const add = (n: number, why: string) => { score += n; reasons.push(`${n > 0 ? "+" : ""}${n} ${why}`); };

  /*
   * Mark flagged pre-approval as the one signal the ISA screens on, and the
   * field does exist — but it is empty on all 80 live contacts checked, so
   * the ISA is evidently capturing it outside GHL (likely verbally or in
   * ISA NOTES). The rule stays because it is the right rule and costs
   * nothing while the field is blank; it simply cannot fire yet. Worth
   * asking the team to start recording it, since it would be the single
   * strongest input to this score.
   */
  if (lead.preApproved === true) add(40, "pre-approved");
  else if (lead.preApproved === false) add(-10, "not pre-approved");

  /*
   * Patterns are written against the values this location actually stores,
   * checked over 80 live contacts: "1-4 Months" (most common), "4+ months",
   * "ASAP", "1 - 4 months". An earlier version used textbook ranges (0-3,
   * 3-6, 6-12) and scored the single most common real value at zero.
   * Spacing varies because the form has been edited over time.
   */
  const t = (lead.timeline || "").toLowerCase().replace(/\s+/g, "");
  if (/asap|immediate|rightaway|thismonth|withinamonth/.test(t)) add(25, "urgent timeline");
  else if (/^1-4|0-3|1-3|1-6|fewmonths|soon/.test(t)) add(15, "near-term timeline");
  else if (/4\+|6\+|6-12|year|browsing|justlooking/.test(t)) add(5, "long timeline");

  if (lead.budget) add(10, "budget provided");
  if (lead.intent !== "unknown") add(10, "intent known");
  if (lead.phone) add(5, "phone present");
  if (lead.attributed) add(5, "ad-attributed");
  if (lead.qualified) add(20, "already qualified by ISA");

  return { score: Math.max(0, Math.min(100, score)), reasons };
}

/** First value that isn't "unknown", else "unknown". */
function firstKnown(...vals: NormalisedLead["intent"][]): NormalisedLead["intent"] {
  return vals.find((v) => v !== "unknown") ?? "unknown";
}

export function normaliseLead(
  payload: any,
  config: ScoutConfig,
  keyToId?: Map<string, string>
): NormalisedLead {
  const cf = payload.customFields ?? payload.customField ?? {};
  const f = config.fields;
  const read = (k: string) => readField(cf, k, keyToId);

  const attribution = {
    fbclid: read("contact.fbclid"),
    utmSource: read("contact.utm_source"),
    utmCampaign: read("contact.utm_campaign"),
    metaCampaignId: read("contact.meta_campaign_id"),
    metaAdsetId: read("contact.meta_adset_id"),
    metaAdId: read("contact.meta_ad_id"),
  };

  const tags: string[] = (payload.tags || []).map((t: string) => String(t).trim().toLowerCase());
  const propertyInterest = read(f.propertyInterest);

  const base = {
    contactId: payload.contactId ?? payload.id ?? "",
    name: [payload.firstName ?? payload.first_name, payload.lastName ?? payload.last_name]
      .filter(Boolean).join(" ").trim() || null,
    email: payload.email || null,
    phone: payload.phone || null,
    propertyInterest,
    budget: read(f.budget),
    timeline: read(f.timeline),
    preApproved: parseYesNo(read(f.preApproved)),
    // The built-in source field is the fallback, not the primary — it says
    // "Facebook" at best, never which ad.
    leadSource: attribution.utmSource || payload.source || null,
    attribution,
    attributed: Boolean(attribution.metaAdId || attribution.fbclid),
    qualified: config.qualifiedTags.some((t) => tags.includes(t.trim().toLowerCase())),
    // Stage id first (what the API actually returns), then a stage name if a
    // webhook supplies one, then the form field as a last resort.
    intent:
      firstKnown(
        intentFromStageId(payload.pipelineStageId, config.intakeStages),
        intentFromStage(payload.pipelineStageName ?? payload.stageName ?? null),
        deriveIntent(propertyInterest)
      ),
  };

  const { score, reasons } = scoreLead(base);
  return { ...base, score, scoreReasons: reasons };
}
