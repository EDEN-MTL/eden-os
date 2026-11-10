import type { CampaignRow, CampaignsResponse } from "./types";

export interface RevenueBar {
  key: string;
  name: string;
  revenue: number;
  deals: number | null;
  spend: number | null;
  roas: number | null;
  /** Share of all revenue recorded in the period (0 to 100); null when the total is zero or unknown. */
  share: number | null;
  /** False for the "not tied to a campaign" row: real revenue that cannot be traced to an ad. */
  tied: boolean;
}

export interface RevenueRanking {
  bars: RevenueBar[];
  top: RevenueBar | null;
  /** Total revenue recorded in the period, from the campaign table's own total. */
  total: number | null;
  /** Campaigns that spent money in the period but have no closed-deal revenue yet. */
  idle: { count: number; spend: number };
}

/**
 * Ranks campaigns by the revenue of the deals that closed in the period, biggest first. A campaign with no
 * revenue is left off the bars (it would be a zero-width line) and counted in `idle` instead, so nothing is
 * hidden. Revenue that cannot be traced to a campaign is shown last and never competes for "top campaign".
 */
export function rankRevenue(data: Pick<CampaignsResponse, "rows" | "totals">): RevenueRanking {
  const total = data.totals.revenue;
  const share = (revenue: number) => (total !== null && total > 0 ? (revenue / total) * 100 : null);
  const bar = (r: CampaignRow): RevenueBar => ({
    key: r.campaignId ?? "untied",
    name: r.name,
    revenue: r.revenue ?? 0,
    deals: r.closedDeals,
    spend: r.spend,
    roas: r.roas,
    share: share(r.revenue ?? 0),
    tied: r.campaignId !== null,
  });
  const earning = (r: CampaignRow) => (r.revenue ?? 0) > 0;
  const tied = data.rows.filter((r) => r.campaignId !== null && earning(r)).map(bar).sort((a, b) => b.revenue - a.revenue);
  const untied = data.rows.filter((r) => r.campaignId === null && earning(r)).map(bar);
  const idleRows = data.rows.filter((r) => r.campaignId !== null && !earning(r) && (r.spend ?? 0) > 0);
  return {
    bars: [...tied, ...untied],
    top: tied[0] ?? null,
    total,
    idle: { count: idleRows.length, spend: idleRows.reduce((sum, r) => sum + (r.spend ?? 0), 0) },
  };
}
