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
  //
  // And once attribution did work (2026-10-13), GHL turned out to count
  // FEWER leads than Meta for the same ads and dates (3% over 14 days: 6 vs
  // 10). GHL merges a repeat submitter into one existing contact (whose
  // dateAdded stays the original one) and not every form submission becomes
  // a contact. Both are counting form submissions, so the higher number is
  // the more complete one; taking GHL's lower count made every ad look
  // pricier than it is. GHL's job here is which ad a lead came from and what
  // happened to it, not the headcount.
  const leadSource: EntityMetrics["lead_source"] =
    crmLeads > 0 && crmLeads >= metaLeads ? "crm" : metaLeads > 0 ? "meta" : "none";
  const leadCount = Math.max(crmLeads, metaLeads);

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
 *
 * Leads are counted over the SAME window as spend (by the lead's GHL
 * dateAdded). Before 2026-10-13 they weren't date-filtered at all, which
 * nobody noticed while no lead carried an ad id; the first real attribution
 * sync then put every lead an ad set had EVER produced against 14 days of
 * spend, reading 3-percent-east-coast's static buyer ad set at $10/lead
 * (19 leads) when Meta counted 2 in that window.
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
       FROM ad_leads WHERE client_id = $1 AND ${leadCol} = $2
         AND created_at >= (CURRENT_DATE - $3::int)`,
      [clientId, row.entity_id, lookbackDays]
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
       FROM ad_leads WHERE client_id = $1 AND meta_ad_id = $2
         AND created_at >= (CURRENT_DATE - $3::int)`,
      [clientId, row.entity_id, lookbackDays]
    );
    results.push(deriveMetrics(row, lead));
  }
  return results;
}

/** What the roll-up needs to know about each entity's live state: whether it delivers, and where it sits. */
export type LiveStatusLookup = Map<string, { effectiveStatus?: string; adsetId?: string; campaignId?: string }>;

/**
 * An ad set or campaign judged on the ads that are still on.
 *
 * Forge used to judge an ad set on every dollar and lead of the last N days, including those of an ad
 * that had since been paused. 2026-10-20: Forge flagged "AUG 2026 | Testing | Static Seller" for a CPL
 * of $118 (1 lead). $99 of that $116 was one ad, "AI image new 5", which Jacob paused 12 minutes later.
 * The flag kept coming back because that ad's spend stayed inside the 7-day window.
 *
 * So for ad sets and campaigns the totals are re-added from the AD rows of the ads that are live right
 * now, and an entity that is not itself running is dropped. Ad rows are only filtered (a paused ad is
 * not a decision). If no ad rows exist for an entity (an ad-level sync gap) it is left as it was rather
 * than judged on nothing. Leads GHL attributed to the ad set but to no ad cannot be placed, so they drop
 * out with the paused ads.
 */
export function runningOnly(rows: EntityMetrics[], scope: RuleScope, adRows: EntityMetrics[], live: LiveStatusLookup): EntityMetrics[] {
  const running = (id: string) => live.get(id)?.effectiveStatus === "ACTIVE";
  if (scope === "ad") return rows.filter((r) => running(r.entity_id));

  const parentOf = (adId: string) => (scope === "adset" ? live.get(adId)?.adsetId : live.get(adId)?.campaignId);
  const out: EntityMetrics[] = [];
  for (const row of rows) {
    if (!running(row.entity_id)) continue;
    const mine = adRows.filter((a) => parentOf(a.entity_id) === row.entity_id);
    if (mine.length === 0) {
      out.push(row);
      continue;
    }
    const on = mine.filter((a) => running(a.entity_id));
    const sum = (f: (a: EntityMetrics) => number) => on.reduce((s, a) => s + f(a), 0);
    const freqs = on.map((a) => a.frequency).filter((f): f is number => typeof f === "number");
    out.push(
      deriveMetrics(
        {
          entity_id: row.entity_id,
          entity_name: row.entity_name,
          spend: String(sum((a) => a.spend)),
          impressions: String(sum((a) => a.impressions)),
          clicks: String(sum((a) => a.clicks)),
          frequency: freqs.length ? String(freqs.reduce((s, f) => s + f, 0) / freqs.length) : null,
          meta_leads: String(sum((a) => a.meta_lead_count)),
          first_date: row.first_date,
          last_date: row.last_date,
          active_days: String(row.active_days),
        },
        { lead_count: String(sum((a) => a.crm_lead_count)), won_count: String(sum((a) => a.won_count)), revenue: String(sum((a) => a.revenue)) }
      )
    );
  }
  return out;
}
