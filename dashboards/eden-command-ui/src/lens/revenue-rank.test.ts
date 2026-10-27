import { describe, expect, it } from "vitest";
import { rankRevenue } from "./revenue-rank";
import type { CampaignRow } from "./types";

const row = (over: Partial<CampaignRow>): CampaignRow => ({
  campaignId: "1", name: "Campaign", noMetaData: false, spend: 100, impressions: 1, clicks: 1, metaLeads: 1, cpl: 1, leads: 1,
  appointmentsBooked: 0, attendedAppointments: 0, costPerAppointment: null, closedDeals: 0, revenue: 0, costPerClosedDeal: null, roas: 0, ...over,
});

describe("rankRevenue", () => {
  const rows = [
    row({ campaignId: "a", name: "Buyer", spend: 3000, revenue: 0 }),
    row({ campaignId: "b", name: "Seller", spend: 778, closedDeals: 3, revenue: 15295.5, roas: 19.66 }),
    row({ campaignId: "c", name: "Small", spend: 50, closedDeals: 1, revenue: 1000, roas: 20 }),
    row({ campaignId: null, name: "Not tied to a campaign", spend: null, closedDeals: 1, revenue: 6225, roas: null }),
  ];
  const ranking = rankRevenue({ rows, totals: { spend: 3828, leads: 10, closedDeals: 5, revenue: 22520.5 } });

  it("puts the campaign with the most revenue first and names it the top campaign", () => {
    expect(ranking.bars.map((b) => b.name)).toEqual(["Seller", "Small", "Not tied to a campaign"]);
    expect(ranking.top?.name).toBe("Seller");
  });

  it("keeps revenue that cannot be traced to a campaign last, even when it is bigger than a campaign's", () => {
    const bigUntied = rankRevenue({ rows: [rows[2], row({ campaignId: null, name: "Not tied", revenue: 9000 })], totals: { spend: 50, leads: 1, closedDeals: 2, revenue: 10000 } });
    expect(bigUntied.bars.map((b) => b.tied)).toEqual([true, false]);
    expect(bigUntied.top?.name).toBe("Small");
  });

  it("gives each bar its share of the period's revenue", () => {
    expect(ranking.bars[0].share).toBeCloseTo(67.9, 1);
  });

  it("counts campaigns that spent money without revenue instead of drawing empty bars", () => {
    expect(ranking.idle).toEqual({ count: 1, spend: 3000 });
  });

  it("has no top campaign and no shares when nothing was earned, and never invents a share from a zero total", () => {
    const none = rankRevenue({ rows: [rows[0]], totals: { spend: 3000, leads: 1, closedDeals: 0, revenue: 0 } });
    expect(none.bars).toEqual([]);
    expect(none.top).toBeNull();
    const untiedOnly = rankRevenue({ rows: [rows[3]], totals: { spend: null, leads: 1, closedDeals: 1, revenue: null } });
    expect(untiedOnly.top).toBeNull();
    expect(untiedOnly.bars[0].share).toBeNull();
  });
});
