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
