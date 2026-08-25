/**
 * Turns a raw GHL contact payload into a normalised lead.
 *
 * Kept free of I/O so the parsing and scoring rules can be tested directly —
 * these are the rules most likely to drift as the client changes their forms,
 * and a silent drift here is expensive: a wrong field key returns null rather
 * than throwing, so leads quietly score as if the answer were "no".
 */

import { Financing, parseIsaNotes } from "./isa-notes";

/**
 * A field can be a single key or a list tried in priority order.
 *
 * The list exists because this location has the same question stored under
 * several keys from successive form revisions — budget lives in both
 * what_is_your_budget (90 contacts) and lf_budget (12), and "working with a
 * realtor" exists three separate times. Which one is populated depends on
 * when the lead arrived and whether anyone has called them.
 */
export type FieldRef = string | string[];

export interface ScoutFieldMap {
  propertyInterest: FieldRef;
  budget: FieldRef;
  timeline: FieldRef;
  preApproved: FieldRef;
  leadSource: FieldRef;
  /** Free-text ISA call notes — richer than the form fields on this account. */
  isaNotes?: FieldRef;
  /** Captured for context; see scoreLead for why it is not scored. */
  workingWithRealtor?: FieldRef;
}

export interface ScoutConfig {
  pipelineId: string;
  intakeStages: Record<string, string>;
  qualifiedTags: string[];
  /** Tags the form workflow applies at creation. Scout's intake trigger. */
  newLeadTags?: string[];
  /** Any of these means the lead has already been engaged — see isFirstTouch. */
  touchedTags?: string[];
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
  /**
   * Richer than preApproved: distinguishes a cash buyer (no financing needed)
   * from someone who simply has not been approved. preApproved stays for
   * callers that only need the yes/no.
   */
  financing: Financing;
  /** Where each answer came from, so thin data is visible rather than assumed. */
  sources: { financing: "field" | "isa-notes" | null; timeline: "field" | "isa-notes" | null; budget: "field" | "isa-notes" | null };
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
  /**
   * True only when nothing has engaged this lead yet. Iris opens contact on
   * this and nothing else; a re-score of an already-worked lead must never
   * trigger another call.
   */
  firstTouch: boolean;
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

/**
 * Whether Iris should OPEN a new outreach sequence for this lead.
 *
 * Not "should Iris place a call" — Iris dials morning and afternoon for 3-4
 * days and owns that cadence internally. This gates the start of it.
 *
 * Checked against 150 live contacts, and a tags-only version of this was
 * WRONG on 14 of them: those carry ISA notes — a human demonstrably spoke to
 * them — but no touch tag, because the ISA writes the note and does not
 * always tag. A tags-only guard would have had Iris ring all 14 a second time.
 *
 * So evidence of contact is taken from anywhere it appears: a touch tag, ISA
 * notes, or a pipeline stage past intake. Any one of them is enough.
 *
 * Read from the CRM rather than from state Scout keeps, which matters more
 * than it looks: a restart, a replayed webhook, or GHL firing twice would all
 * produce a duplicate call if Scout were remembering this itself.
 *
 * Note that answering the text automation ('replied') is NOT contact: 10 of
 * 150 live contacts had replied to a text and never been called. Blocking
 * those would have skipped the most engaged leads on the board.
 *
 * Fails CLOSED — missing or unreadable input reads as "already touched". The
 * cost of wrongly skipping a lead is that it waits for the next trigger; the
 * cost of wrongly calling one is a real person phoned twice by a bot.
 */
export function isFirstTouch(input: {
  tags?: string[];
  touchedTags?: string[];
  /** Free-text ISA notes. Any content means somebody has had a conversation. */
  isaNotes?: string | null;
  /** Stage the lead sits in, if known. Anything past intake means worked. */
  stageId?: string | null;
  intakeStages?: Record<string, string>;
}): boolean {
  const { tags, touchedTags, isaNotes, stageId, intakeStages } = input;
  if (!Array.isArray(tags)) return false;

  const list = (touchedTags || []).map((t) => t.trim().toLowerCase());
  if (list.length === 0) return false;
  if (tags.map((t) => String(t).trim().toLowerCase()).some((t) => list.includes(t))) return false;

  // Notes exist only because someone had a conversation worth writing down.
  if (isaNotes && String(isaNotes).trim() !== "") return false;

  // Past the intake columns means the lead has been moved by someone.
  if (stageId && intakeStages) {
    const isIntake = Object.entries(intakeStages).some(([k, id]) => !k.startsWith("_") && id === stageId);
    if (!isIntake) return false;
  }

  return true;
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
/**
 * Earliest month the lead could transact, or null if unreadable.
 *
 * Handles every real value across both sources: the survey dropdown
 * ("ASAP", "3-6 Months", "12 + months", "7 - 12 months"), the ISA's typed
 * answers ("1-4 Months", "4+ months", "1 - 4 months"), and prose like
 * "sooner the better". Takes the LOWER bound of a range — "3-6 Months"
 * means they could move in three.
 */
export function parseTimelineMonths(raw: string | null): number | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (/asap|immediat|right away|sooner the better|soon as possible|this month|within a month/.test(v)) return 0;
  const m = v.match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n >= 0 && n <= 120 ? n : null;
}

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
  /*
   * A cash buyer outranks a pre-approved one — no lender, no appraisal, no
   * financing condition. Scoring them the same, or worse treating "no need"
   * as a negative, would penalise the strongest prospects on the board.
   */
  if (lead.financing === "cash") add(45, "cash buyer");
  else if (lead.financing === "pre-approved") add(40, "pre-approved");
  else if (lead.financing === "in-progress") add(15, "financing in progress");
  else if (lead.financing === "not-approved") add(-10, "not pre-approved");

  /*
   * Scored off a parsed month count rather than by matching the text.
   *
   * Two separate string-matching versions of this have now been wrong. The
   * first used textbook ranges and gave "1-4 Months" — the most common value
   * in the ISA notes — a zero. The second handled the notes but missed the
   * survey dropdown, scoring "3-6 Months", "4 - 6 months", "7 - 12 months"
   * and "12 + months" at zero: 32 of 113 real answers, 28%.
   *
   * The forms have been revised repeatedly and the two sources disagree on
   * format, so any pattern list will keep rotting. A number does not.
   */
  const months = parseTimelineMonths(lead.timeline);
  if (months !== null) {
    if (months === 0) add(25, "wants to move now");
    else if (months <= 3) add(18, `${months}+ month timeline`);
    else if (months <= 6) add(10, `${months}+ month timeline`);
    else add(5, `${months}+ month timeline`);
  }

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
  const read = (ref: FieldRef | undefined): string | null => {
    if (!ref) return null;
    for (const k of Array.isArray(ref) ? ref : [ref]) {
      const v = readField(cf, k, keyToId);
      if (v !== null) return v;
    }
    return null;
  };

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

  /*
   * The dedicated form fields win when populated, but on this account they
   * mostly are not — lf_proprety and are_you_pre_approuved are empty on all
   * 150 contacts checked, while ISA notes carry answers on 101 of them. The
   * ISA types into the notes box instead of filling the form in, so the notes
   * are the real source and the fields are the fallback, not the reverse.
   */
  const notes = parseIsaNotes(f.isaNotes ? read(f.isaNotes) : null);
  const fieldFinancing = parseYesNo(read(f.preApproved));
  const financing: Financing =
    fieldFinancing === true ? "pre-approved" :
    fieldFinancing === false ? "not-approved" :
    notes.financing;

  const fieldTimeline = read(f.timeline);
  const fieldBudget = read(f.budget);

  const base = {
    contactId: payload.contactId ?? payload.id ?? "",
    name: [payload.firstName ?? payload.first_name, payload.lastName ?? payload.last_name]
      .filter(Boolean).join(" ").trim() || null,
    email: payload.email || null,
    phone: payload.phone || null,
    propertyInterest,
    budget: fieldBudget ?? notes.budget,
    timeline: fieldTimeline ?? notes.timeline,
    preApproved: financing === null ? null : financing === "cash" || financing === "pre-approved",
    financing,
    sources: {
      financing: (fieldFinancing !== null ? "field" : notes.financing !== null ? "isa-notes" : null) as NormalisedLead["sources"]["financing"],
      timeline: (fieldTimeline ? "field" : notes.timeline ? "isa-notes" : null) as NormalisedLead["sources"]["timeline"],
      budget: (fieldBudget ? "field" : notes.budget ? "isa-notes" : null) as NormalisedLead["sources"]["budget"],
    },
    // The built-in source field is the fallback, not the primary — it says
    // "Facebook" at best, never which ad.
    leadSource: attribution.utmSource || payload.source || null,
    attribution,
    attributed: Boolean(attribution.metaAdId || attribution.fbclid),
    qualified: config.qualifiedTags.some((t) => tags.includes(t.trim().toLowerCase())),
    firstTouch: isFirstTouch({
      tags: payload.tags,
      touchedTags: config.touchedTags,
      isaNotes: f.isaNotes ? read(f.isaNotes) : null,
      stageId: payload.pipelineStageId,
      intakeStages: config.intakeStages,
    }),
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
