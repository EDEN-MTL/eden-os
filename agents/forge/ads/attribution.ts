/**
 * Attribution: joins GHL leads/pipeline data back to specific Meta
 * campaigns/ad sets/ads.
 *
 * Two things happen here:
 *   1. syncLeads — pulls GHL contacts + opportunities, resolves each
 *      contact's custom fields (per config/ghl-field-map.<client>.json) into
 *      fbclid, utm_ fields, and meta_id values, and upserts one row per
 *      contact into the ad_leads table.
 *   2. attributionReport — aggregates spend (from meta_performance_snapshots,
 *      populated by jobs/sync.ts from the Meta side) against lead counts,
 *      pipeline stage, and closed deal value, joined by Meta campaign/adset/
 *      ad id, so "which ad actually produced revenue" is answerable.
 *
 * The join key is Meta's own numeric campaign/adset/ad id, expected to be
 * present in the lead's utm_campaign/utm_content/utm_term or dedicated
 * meta_*_id custom fields (see the field-map config for how those get
 * populated). Without that URL-tagging setup on the ad side, this join
 * has nothing to key on.
 */
import { getCustomFieldDefs, listContactsPaginated, listOpportunitiesPaginated, listPipelines } from "../../../shared/ghl";
import { query } from "../../../shared/db";
import { loadOutcomeStages } from "./client-config";

export type FieldMap = Record<string, string>;

/**
 * GHL contact.customFields entries are keyed by field *id*, not the
 * human-readable fieldKey — so we fetch the field defs once and map our
 * internal name -> id via the fieldKey in the config file.
 */
export function buildFieldIdLookup(customFieldDefs: any[], fieldMap: FieldMap): Record<string, string> {
  const keyToId = new Map<string, string>();
  for (const def of customFieldDefs) {
    if (def.fieldKey) keyToId.set(def.fieldKey, def.id);
  }
  const lookup: Record<string, string> = {};
  for (const [internalName, fieldKey] of Object.entries(fieldMap)) {
    if (internalName.startsWith("_")) continue; // skip _comment and similar
    const fieldId = keyToId.get(fieldKey);
    if (fieldId) {
      lookup[internalName] = fieldId;
    } else {
      console.warn(
        `[FORGE] GHL custom field '${fieldKey}' (mapped from '${internalName}' in the field map) not found on this location.`
      );
    }
  }
  return lookup;
}

export function extractAttribution(contact: any, idLookup: Record<string, string>): Record<string, string | null> {
  const valuesById = new Map<string, string>();
  for (const cf of contact.customFields || []) {
    if (cf.id) valuesById.set(cf.id, cf.value);
  }
  const out: Record<string, string | null> = {};
  for (const [internalName, fieldId] of Object.entries(idLookup)) {
    out[internalName] = valuesById.get(fieldId) ?? null;
  }
  return out;
}

export interface OutcomeStageMap {
  /** Pipeline stage names that mean the deal was won. Case-insensitive. */
  wonStages?: string[];
  /** Pipeline stage names that mean the deal was lost. Case-insensitive. */
  lostStages?: string[];
  /**
   * Stages that are NOT won, but carry real committed value — a signed
   * buyer, a live listing, a booked job. Case-insensitive.
   *
   * Won/lost/open is too coarse on its own. "Buyer Confirmed" is not
   * revenue, but it is also not the same as an untouched new lead, and
   * collapsing the two hides forecastable money. These stages stay
   * `won = null` (so they never inflate revenue or ROAS) and are totalled
   * separately as pipeline value.
   */
  activeStages?: string[];
}

/**
 * Decides whether an opportunity was won, lost, or is still open.
 *
 * GHL has an explicit `status` field (open/won/lost/abandoned), and that is
 * the most reliable signal when it's used — so it wins whenever it says
 * anything other than "open".
 *
 * But not every team uses it. 3 Percent East Coast, for instance, leaves
 * every opportunity at status "open" and instead drags the card into a
 * terminal column ("Deal Closed", "Not Qualified/Not Interested"). Reading
 * status alone returned null for all 149 of their leads, which zeroed out
 * revenue and made the ROAS rule permanently unfireable — the data was
 * there, we were looking in the wrong field.
 *
 * So when status is open/absent, fall back to the per-client stage mapping
 * in config. Stage names are client-specific and change over time, which is
 * exactly why they belong in config rather than hardcoded here.
 */
export function deriveWon(
  status: string | undefined,
  pipelineStage?: string | null,
  stageMap?: OutcomeStageMap
): boolean | null {
  const normalized = (status || "").toLowerCase();
  if (normalized === "won") return true;
  if (normalized === "lost" || normalized === "abandoned") return false;

  if (pipelineStage && stageMap) {
    const stage = pipelineStage.trim().toLowerCase();
    const matches = (list?: string[]) => (list || []).some((s) => s.trim().toLowerCase() === stage);
    if (matches(stageMap.wonStages)) return true;
    if (matches(stageMap.lostStages)) return false;
  }

  return null;
}

/**
 * Whether an opportunity is sitting in a stage that carries committed but
 * unbanked value.
 *
 * Deliberately independent of deal size: a stage either represents a real
 * commitment or it doesn't. Anything already resolved (won or lost) is
 * excluded, so this never double-counts against revenue.
 */
export function derivePipelineActive(
  status: string | undefined,
  pipelineStage?: string | null,
  stageMap?: OutcomeStageMap
): boolean {
  if (deriveWon(status, pipelineStage, stageMap) !== null) return false;
  if (!pipelineStage || !stageMap?.activeStages) return false;
  const stage = pipelineStage.trim().toLowerCase();
  return stageMap.activeStages.some((s) => s.trim().toLowerCase() === stage);
}

/**
 * Pull all GHL contacts + opportunities, upsert attribution + pipeline
 * state into ad_leads. Returns the number of leads upserted.
 *
 * `pipelineName` scopes which pipeline's opportunities count toward
 * pipeline_stage/deal_value/won — a GHL location can have several
 * pipelines that aren't the actual sales pipeline Meta leads flow into.
 * Leave unset to consider every pipeline.
 */
export async function syncLeads(
  locationId: string,
  fieldMap: FieldMap,
  options: {
    pipelineName?: string;
    clientId?: string;
    apiKey?: string;
    /**
     * Skip contacts that neither carry ad attribution nor sit in the target
     * pipeline — i.e. other businesses' data on a shared GHL location.
     * Defaults to true; pass false only for a location you know is
     * dedicated to this one client and where you want every contact.
     */
    skipUnrelatedContacts?: boolean;
    /**
     * Which pipeline stages mean won/lost, for teams that don't set GHL's
     * won/lost status and instead signal the outcome by moving the card to
     * a terminal column. See deriveWon.
     */
    outcomeStages?: OutcomeStageMap;
  } = {}
): Promise<number> {
  const { pipelineName, clientId = "eden", apiKey, skipUnrelatedContacts = true, outcomeStages } = options;

  const [customFieldDefs, pipelines] = await Promise.all([
    getCustomFieldDefs(locationId, apiKey),
    listPipelines(locationId, apiKey),
  ]);
  const idLookup = buildFieldIdLookup(customFieldDefs, fieldMap);

  const stageNames = new Map<string, string>();
  for (const pipeline of pipelines) {
    for (const stage of pipeline.stages || []) {
      stageNames.set(stage.id, stage.name);
    }
  }

  let targetPipelines = pipelines;
  if (pipelineName) {
    const matched = pipelines.filter((p: any) => (p.name || "").trim().toLowerCase() === pipelineName.trim().toLowerCase());
    if (matched.length > 0) {
      targetPipelines = matched;
    } else {
      console.warn(
        `[FORGE] pipelineName ${JSON.stringify(pipelineName)} did not match any pipeline ` +
          `(found: ${pipelines.map((p: any) => p.name).join(", ")}) — considering all pipelines.`
      );
    }
  }

  const oppsByContact = new Map<string, any>();
  for (const pipeline of targetPipelines) {
    for await (const opp of listOpportunitiesPaginated(locationId, { pipelineId: pipeline.id, apiKey })) {
      if (!opp.contactId) continue;
      const existing = oppsByContact.get(opp.contactId);
      if (!existing || (opp.updatedAt || "") > (existing.updatedAt || "")) {
        oppsByContact.set(opp.contactId, opp);
      }
    }
  }

  let count = 0;
  let skipped = 0;
  for await (const contact of listContactsPaginated(locationId, { apiKey })) {
    if (!contact.id) continue;
    const attribution = extractAttribution(contact, idLookup);

    const metaCampaignId = attribution.meta_campaign_id || attribution.utm_campaign;
    const metaAdsetId = attribution.meta_adset_id || attribution.utm_term;
    const metaAdId = attribution.meta_ad_id || attribution.utm_content;

    const opp = oppsByContact.get(contact.id) || {};

    // A GHL location isn't always dedicated to one business — Matama's, for
    // instance, is shared with the owner's older real-estate work and holds
    // ~169 contacts that have nothing to do with floors. Importing those
    // would fill this client's lead list with other people's customers.
    //
    // A contact is relevant if EITHER it carries ad attribution (so it
    // demonstrably came from an ad) OR it has an opportunity in the target
    // pipeline (so someone deliberately put it in this business's process).
    // Everything else is another business's data and is skipped.
    if (skipUnrelatedContacts) {
      const hasAttribution = Boolean(attribution.fbclid || metaCampaignId || metaAdsetId || metaAdId);
      const inTargetPipeline = Boolean(opp.id);
      if (!hasAttribution && !inTargetPipeline) {
        skipped++;
        continue;
      }
    }
    const pipelineStage = stageNames.get(opp.pipelineStageId) ?? opp.pipelineStageId ?? null;
    const won = deriveWon(opp.status, pipelineStage, outcomeStages);

    await query(
      `INSERT INTO ad_leads (
         client_id, ghl_contact_id, fbclid, utm_source, utm_medium, utm_campaign,
         utm_content, utm_term, meta_campaign_id, meta_adset_id, meta_ad_id,
         pipeline_stage, deal_value, won, created_at, updated_at, raw
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now(), $16)
       ON CONFLICT (client_id, ghl_contact_id) DO UPDATE SET
         fbclid = excluded.fbclid, utm_source = excluded.utm_source,
         utm_medium = excluded.utm_medium, utm_campaign = excluded.utm_campaign,
         utm_content = excluded.utm_content, utm_term = excluded.utm_term,
         meta_campaign_id = excluded.meta_campaign_id,
         meta_adset_id = excluded.meta_adset_id, meta_ad_id = excluded.meta_ad_id,
         pipeline_stage = excluded.pipeline_stage, deal_value = excluded.deal_value,
         won = excluded.won, updated_at = now(), raw = excluded.raw`,
      [
        clientId, contact.id, attribution.fbclid, attribution.utm_source,
        attribution.utm_medium, attribution.utm_campaign, attribution.utm_content, attribution.utm_term,
        metaCampaignId, metaAdsetId, metaAdId,
        pipelineStage, opp.monetaryValue ?? null, won,
        contact.dateAdded || new Date().toISOString(),
        JSON.stringify({ contact, opportunity: opp }),
      ]
    );
    count++;
  }
  console.log(
    `[FORGE] Synced ${count} GHL leads for ${clientId}` +
      (skipped ? ` (skipped ${skipped} unrelated contacts on this location).` : ".")
  );
  return count;
}

export interface AttributionReportRow {
  ad_id: string;
  ad_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  lead_count: number;
  won_count: number;
  revenue: number;
  /** Deals still in flight in a committed stage. Not counted in revenue. */
  active_count: number;
  /** Value of those in-flight deals. Forecastable, NOT banked — excluded from ROAS. */
  pipeline_value: number;
  cpl: number | null;
  roas: number | null;
}

/**
 * One row per Meta ad with spend (from meta_performance_snapshots) joined
 * against lead count / won count / deal value (from ad_leads), plus
 * derived CPL and ROAS. since/until are YYYY-MM-DD, applied to the
 * performance snapshot window.
 */
export async function attributionReport(since: string, until: string, clientId = "eden"): Promise<AttributionReportRow[]> {
  // Lower-cased here so the SQL comparison is a plain equality against an
  // array rather than a per-row function call.
  const activeStages = (loadOutcomeStages(clientId)?.activeStages || []).map((s) => s.trim().toLowerCase());

  const rows = await query<any>(
    `SELECT
       p.ad_id, p.ad_name, p.adset_id, p.adset_name, p.campaign_id, p.campaign_name,
       SUM(p.spend) AS spend,
       SUM(p.impressions) AS impressions,
       SUM(p.clicks) AS clicks,
       COUNT(DISTINCT l.id) AS lead_count,
       SUM(CASE WHEN l.won THEN 1 ELSE 0 END) AS won_count,
       SUM(CASE WHEN l.won THEN l.deal_value ELSE 0 END) AS revenue,
       COUNT(DISTINCT CASE WHEN l.won IS NULL AND lower(trim(l.pipeline_stage)) = ANY($4) THEN l.id END) AS active_count,
       SUM(CASE WHEN l.won IS NULL AND lower(trim(l.pipeline_stage)) = ANY($4) THEN l.deal_value ELSE 0 END) AS pipeline_value
     FROM meta_performance_snapshots p
     LEFT JOIN ad_leads l ON l.meta_ad_id = p.ad_id AND l.client_id = p.client_id
     WHERE p.client_id = $1 AND p.level = 'ad' AND p.date_start >= $2 AND p.date_stop <= $3
     GROUP BY p.ad_id, p.ad_name, p.adset_id, p.adset_name, p.campaign_id, p.campaign_name
     ORDER BY spend DESC`,
    [clientId, since, until, activeStages]
  );

  return rows.map((row) => {
    const spend = Number(row.spend) || 0;
    const leads = Number(row.lead_count) || 0;
    const revenue = Number(row.revenue) || 0;
    return {
      ...row,
      spend,
      impressions: Number(row.impressions) || 0,
      clicks: Number(row.clicks) || 0,
      lead_count: leads,
      won_count: Number(row.won_count) || 0,
      revenue,
      active_count: Number(row.active_count) || 0,
      pipeline_value: Number(row.pipeline_value) || 0,
      cpl: leads ? Math.round((spend / leads) * 100) / 100 : null,
      // Deliberately revenue-only. Folding pipeline_value in here would let
      // unbanked deals justify spend that hasn't been earned back yet.
      roas: spend ? Math.round((revenue / spend) * 100) / 100 : null,
    };
  });
}
