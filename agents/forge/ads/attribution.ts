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

/** 'won' | 'lost' | null (open) from GHL's opportunity status string. */
export function deriveWon(status: string | undefined): boolean | null {
  const normalized = (status || "").toLowerCase();
  if (normalized === "won") return true;
  if (normalized === "lost") return false;
  return null;
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
  options: { pipelineName?: string; clientId?: string } = {}
): Promise<number> {
  const { pipelineName, clientId = "eden" } = options;

  const [customFieldDefs, pipelines] = await Promise.all([
    getCustomFieldDefs(locationId),
    listPipelines(locationId),
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
    for await (const opp of listOpportunitiesPaginated(locationId, { pipelineId: pipeline.id })) {
      if (!opp.contactId) continue;
      const existing = oppsByContact.get(opp.contactId);
      if (!existing || (opp.updatedAt || "") > (existing.updatedAt || "")) {
        oppsByContact.set(opp.contactId, opp);
      }
    }
  }

  let count = 0;
  for await (const contact of listContactsPaginated(locationId)) {
    if (!contact.id) continue;
    const attribution = extractAttribution(contact, idLookup);

    const metaCampaignId = attribution.meta_campaign_id || attribution.utm_campaign;
    const metaAdsetId = attribution.meta_adset_id || attribution.utm_term;
    const metaAdId = attribution.meta_ad_id || attribution.utm_content;

    const opp = oppsByContact.get(contact.id) || {};
    const won = deriveWon(opp.status);
    const pipelineStage = stageNames.get(opp.pipelineStageId) ?? opp.pipelineStageId ?? null;

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
  console.log(`[FORGE] Synced ${count} GHL leads.`);
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
  const rows = await query<any>(
    `SELECT
       p.ad_id, p.ad_name, p.adset_id, p.adset_name, p.campaign_id, p.campaign_name,
       SUM(p.spend) AS spend,
       SUM(p.impressions) AS impressions,
       SUM(p.clicks) AS clicks,
       COUNT(DISTINCT l.id) AS lead_count,
       SUM(CASE WHEN l.won THEN 1 ELSE 0 END) AS won_count,
       SUM(CASE WHEN l.won THEN l.deal_value ELSE 0 END) AS revenue
     FROM meta_performance_snapshots p
     LEFT JOIN ad_leads l ON l.meta_ad_id = p.ad_id AND l.client_id = p.client_id
     WHERE p.client_id = $1 AND p.level = 'ad' AND p.date_start >= $2 AND p.date_stop <= $3
     GROUP BY p.ad_id, p.ad_name, p.adset_id, p.adset_name, p.campaign_id, p.campaign_name
     ORDER BY spend DESC`,
    [clientId, since, until]
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
      cpl: leads ? Math.round((spend / leads) * 100) / 100 : null,
      roas: spend ? Math.round((revenue / spend) * 100) / 100 : null,
    };
  });
}
