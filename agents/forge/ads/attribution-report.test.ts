import { describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../../../shared/db", () => ({ query: (...args: unknown[]) => queryMock(...args) }));
vi.mock("./client-config", () => ({ loadOutcomeStages: () => ({ activeStages: ["Buyer Confirmed"] }) }));

import { attributionReport } from "./attribution";

describe("attributionReport", () => {
  it("aggregates leads separately from per-day spend, limited to the report's dates", async () => {
    queryMock.mockResolvedValueOnce([]);

    await attributionReport("2026-10-01", "2026-10-07", "3-percent-east-coast");

    const [sql, params] = queryMock.mock.calls[0];
    // Leads joined once per ad, never onto the per-day snapshot rows (that
    // repeated each lead once per day and multiplied won/revenue).
    expect(sql).toMatch(/WITH spend AS[\s\S]*leads AS[\s\S]*FROM spend s LEFT JOIN leads l ON l.meta_ad_id = s.ad_id/);
    expect(sql).toMatch(/created_at >= \$2::date AND created_at < \(\$3::date \+ 1\)/);
    expect(params).toEqual(["3-percent-east-coast", "2026-10-01", "2026-10-07", ["buyer confirmed"]]);
  });
});
