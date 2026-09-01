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
  const leadCount = Number(lead?.lead_count) || 0;
  const revenue = Number(lead?.revenue) || 0;

  return {
    entity_id: row.entity_id,
    entity_name: row.entity_name,
    spend,
    impressions,
    clicks,
    frequency: row.frequency !== null ? Number(row.frequency) : null,
    lead_count: leadCount,
    won_count: Number(lead?.won_count) || 0,
    revenue,
    ctr: impressions ? clicks / impressions : null,
    cpc: clicks ? spend / clicks : null,
    cpl: leadCount ? spend / leadCount : null,
    roas: spend ? revenue / spend : null,
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
            SUM(spend) AS spend, SUM(impressions) AS impressions,
            SUM(clicks) AS clicks, AVG(frequency) AS frequency
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
            SUM(spend) AS spend, SUM(impressions) AS impressions,
            SUM(clicks) AS clicks, AVG(frequency) AS frequency
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
