import { query } from "../../../shared/db";
import { EntityMetrics, RuleScope } from "./types";

const LEVEL_ID_COL: Record<RuleScope, string> = { campaign: "campaign_id", adset: "adset_id", ad: "ad_id" };
const LEVEL_NAME_COL: Record<RuleScope, string> = { campaign: "campaign_name", adset: "adset_name", ad: "ad_name" };
const LEVEL_LEAD_COL: Record<RuleScope, string> = {
  campaign: "meta_campaign_id",
  adset: "meta_adset_id",
  ad: "meta_ad_id",
};

interface PerfRow {
  entity_id: string;
  entity_name: string | null;
  spend: string | null;
  impressions: string | null;
  clicks: string | null;
  frequency: string | null;
  meta_leads?: string | null;
  first_date?: string | Date | null;
  last_date?: string | Date | null;
  active_days?: string | null;
}

/**
 * Meta's own lead count for a snapshot row, read out of the raw insights
 * `actions` array. `lead` is Meta's rolled-up lead action — it already
 * includes both on-Facebook instant-form leads (onsite_conversion.lead_grouped)
 * and pixel leads (offsite_conversion.fb_pixel_lead), so summing those too
 * would double-count. Verified against 3-percent-east-coast 2026-10-09:
 * `lead` and `onsite_conversion.lead_grouped` both read 23 over 30 days.
 */
const META_LEADS_SQL = `COALESCE((
  SELECT SUM((a->>'value')::numeric)
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(raw->'actions') = 'array' THEN raw->'actions' ELSE '[]'::jsonb END) a
  WHERE a->>'action_type' = 'lead'
), 0)`;

/**
 * Shared by both queries below. active_days counts days with a snapshot row,
 * and Meta's insights only return a row for a day the entity actually
 * delivered — so it's "days it ran", not calendar days since launch.
 */
const PERF_AGGREGATES_SQL = `SUM(spend) AS spend, SUM(impressions) AS impressions,
            SUM(clicks) AS clicks, AVG(frequency) AS frequency,
            SUM(${META_LEADS_SQL}) AS meta_leads,
            MIN(date_start) AS first_date, MAX(date_stop) AS last_date,
            COUNT(DISTINCT date_start) AS active_days`;

function toIsoDate(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 10);
}

interface LeadRow {
  lead_count: string;
  won_count: string;
  revenue: string | null;
}

function deriveMetrics(row: PerfRow, lead: LeadRow | undefined): EntityMetrics {
  const spend = Number(row.spend) || 0;
  const impressions = Number(row.impressions) || 0;
  const clicks = Number(row.clicks) || 0;
  const crmLeads = Number(lead?.lead_count) || 0;
  const metaLeads = Number(row.meta_leads) || 0;
  const revenue = Number(lead?.revenue) || 0;

  // CRM attribution is the better source when it exists (it's what lets a
  // lead be traced to a won deal), but on 2026-10-09 not one of
  // 3-percent-east-coast's 246 GHL leads carried an ad id — so every CPL read
  // null, and the "CPL above threshold" rule had never once fired while real
  // CPL sat near $65 against a $35 cap. Falling back to Meta's own count means
  // a missing attribution link degrades to "Meta's number", not "no number".
  const leadSource: EntityMetrics["lead_source"] = crmLeads > 0 ? "crm" : metaLeads > 0 ? "meta" : "none";
  const leadCount = crmLeads > 0 ? crmLeads : metaLeads;

  return {
    entity_id: row.entity_id,
    entity_name: row.entity_name,
    spend,
    impressions,
    clicks,
    frequency: row.frequency !== null ? Number(row.frequency) : null,
    lead_count: leadCount,
    crm_lead_count: crmLeads,
    meta_lead_count: metaLeads,
    lead_source: leadSource,
    won_count: Number(lead?.won_count) || 0,
    revenue,
    ctr: impressions ? clicks / impressions : null,
    cpc: clicks ? spend / clicks : null,
    cpm: impressions ? (spend / impressions) * 1000 : null,
    cpl: leadCount ? spend / leadCount : null,
    roas: spend ? revenue / spend : null,
    first_date: toIsoDate(row.first_date),
    last_date: toIsoDate(row.last_date),
    active_days: Number(row.active_days) || 0,
  };
}

/**
 * One row per entity at `scope` level, with performance from Meta and
 * lead/revenue counts joined in from GHL via the attribution linker.
 */
export async function computeMetrics(
  scope: RuleScope,
  lookbackDays: number,
  clientId = "eden"
): Promise<EntityMetrics[]> {
  const idCol = LEVEL_ID_COL[scope];
  const nameCol = LEVEL_NAME_COL[scope];
  const leadCol = LEVEL_LEAD_COL[scope];

  const perfRows = await query<PerfRow>(
    `SELECT ${idCol} AS entity_id, ${nameCol} AS entity_name,
            ${PERF_AGGREGATES_SQL}
     FROM meta_performance_snapshots
     WHERE client_id = $1 AND level = $2
       AND date_start >= (CURRENT_DATE - $3::int) AND date_stop <= CURRENT_DATE
       AND ${idCol} IS NOT NULL
     GROUP BY ${idCol}, ${nameCol}`,
    [clientId, scope, lookbackDays]
  );

  const results: EntityMetrics[] = [];
  for (const row of perfRows) {
    const [lead] = await query<LeadRow>(
      `SELECT COUNT(*) AS lead_count,
              SUM(CASE WHEN won THEN 1 ELSE 0 END) AS won_count,
              SUM(CASE WHEN won THEN deal_value ELSE 0 END) AS revenue
       FROM ad_leads WHERE client_id = $1 AND ${leadCol} = $2`,
      [clientId, row.entity_id]
    );
    results.push(deriveMetrics(row, lead));
  }
  return results;
}

/**
 * Same shape as computeMetrics(scope='ad'), but scoped to the ads within
 * one specific ad set — what the creative-testing engine compares siblings
 * against, rather than every ad in the account.
 */
export async function computeAdMetricsForAdset(
  adsetId: string,
  lookbackDays: number,
  clientId = "eden"
): Promise<EntityMetrics[]> {
  const perfRows = await query<PerfRow>(
    `SELECT ad_id AS entity_id, ad_name AS entity_name,
            ${PERF_AGGREGATES_SQL}
     FROM meta_performance_snapshots
     WHERE client_id = $1 AND level = 'ad' AND adset_id = $2
       AND date_start >= (CURRENT_DATE - $3::int) AND date_stop <= CURRENT_DATE
       AND ad_id IS NOT NULL
     GROUP BY ad_id, ad_name`,
    [clientId, adsetId, lookbackDays]
  );

  const results: EntityMetrics[] = [];
  for (const row of perfRows) {
    const [lead] = await query<LeadRow>(
      `SELECT COUNT(*) AS lead_count,
              SUM(CASE WHEN won THEN 1 ELSE 0 END) AS won_count,
              SUM(CASE WHEN won THEN deal_value ELSE 0 END) AS revenue
       FROM ad_leads WHERE client_id = $1 AND meta_ad_id = $2`,
      [clientId, row.entity_id]
    );
    results.push(deriveMetrics(row, lead));
  }
  return results;
}
