import { describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../../../shared/db", () => ({ query: (...args: unknown[]) => queryMock(...args) }));

import { computeAdMetricsForAdset, computeMetrics } from "./metrics";

describe("computeMetrics", () => {
  it("groups by both the id and name columns — a bare id-only GROUP BY fails in Postgres for a name column that isn't aggregated", async () => {
    queryMock.mockResolvedValueOnce([]);

    await computeMetrics("ad", 7, "eden");

    const [sql] = queryMock.mock.calls[0];
    expect(sql).toMatch(/GROUP BY ad_id, ad_name/);
  });

  it("joins performance with lead/revenue data and derives ctr/cpc/cpl/roas correctly", async () => {
    queryMock
      .mockResolvedValueOnce([
        { entity_id: "ad_1", entity_name: "Mount Pearl Sellers", spend: "100", impressions: "1000", clicks: "50", frequency: "1.2" },
      ])
      .mockResolvedValueOnce([{ lead_count: "5", won_count: "1", revenue: "500" }]);

    const [row] = await computeMetrics("ad", 7, "eden");

    expect(row).toMatchObject({
      entity_id: "ad_1",
      entity_name: "Mount Pearl Sellers",
      spend: 100,
      lead_count: 5,
      won_count: 1,
      revenue: 500,
      ctr: 50 / 1000,
      cpc: 100 / 50,
      cpl: 100 / 5,
      roas: 500 / 100,
    });
  });

  it("falls back to Meta's own lead count when no GHL lead is attributed, and says so", async () => {
    queryMock
      .mockResolvedValueOnce([
        { entity_id: "ad_1", entity_name: "Buyer Video", spend: "120", impressions: "8000", clicks: "300", frequency: "1.3", meta_leads: "3", first_date: new Date("2026-09-24T00:00:00Z"), last_date: "2026-10-07", active_days: "14" },
      ])
      .mockResolvedValueOnce([{ lead_count: "0", won_count: "0", revenue: null }]);

    const [row] = await computeMetrics("ad", 14, "3-percent-east-coast");

    expect(row).toMatchObject({
      lead_count: 3, crm_lead_count: 0, meta_lead_count: 3, lead_source: "meta",
      cpl: 40, cpm: 15, first_date: "2026-09-24", last_date: "2026-10-07", active_days: 14,
    });
  });

  it("prefers the CRM count whenever it has any, since that's what links a lead to a won deal", async () => {
    queryMock
      .mockResolvedValueOnce([{ entity_id: "ad_1", entity_name: "x", spend: "100", impressions: "1000", clicks: "10", frequency: "1", meta_leads: "5" }])
      .mockResolvedValueOnce([{ lead_count: "2", won_count: "0", revenue: null }]);

    const [row] = await computeMetrics("ad", 7, "eden");

    expect(row).toMatchObject({ lead_count: 2, crm_lead_count: 2, meta_lead_count: 5, lead_source: "crm", cpl: 50 });
  });

  it("reads Meta leads from the `lead` action only, so instant-form leads aren't counted twice", async () => {
    queryMock.mockResolvedValueOnce([]);

    await computeMetrics("adset", 7, "eden");

    // calls.at(-1), not [0]: mocks aren't reset between tests in this file.
    const [sql] = queryMock.mock.calls.at(-1)!;
    expect(sql).toMatch(/a->>'action_type' = 'lead'/);
    expect(sql).not.toMatch(/lead_grouped/);
  });

  it("returns null rates rather than dividing by zero when there's no spend/leads/clicks yet", async () => {
    queryMock
      .mockResolvedValueOnce([{ entity_id: "ad_1", entity_name: "New Ad", spend: "0", impressions: "0", clicks: "0", frequency: null }])
      .mockResolvedValueOnce([{ lead_count: "0", won_count: "0", revenue: null }]);

    const [row] = await computeMetrics("ad", 7, "eden");

    expect(row.ctr).toBeNull();
    expect(row.cpc).toBeNull();
    expect(row.cpl).toBeNull();
    expect(row.roas).toBeNull();
  });
});

describe("computeAdMetricsForAdset", () => {
  it("also groups by both ad_id and ad_name", async () => {
    queryMock.mockResolvedValueOnce([]);

    await computeAdMetricsForAdset("adset_1", 7, "eden");

    const [sql] = queryMock.mock.calls[0];
    expect(sql).toMatch(/GROUP BY ad_id, ad_name/);
  });
});
