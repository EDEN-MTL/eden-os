import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../../../shared/db", () => ({ query: (...args: unknown[]) => queryMock(...args) }));

import { syncMetaPerformance } from "./sync";
import { MetaClient } from "../../../shared/meta";

function fakeClient(rowsByLevel: Record<string, any[]>): MetaClient {
  return {
    getInsights: vi.fn(async ({ level }: { level: string }) => rowsByLevel[level] || []),
  } as unknown as MetaClient;
}

beforeEach(() => {
  queryMock.mockClear();
});

describe("syncMetaPerformance", () => {
  it("deletes existing rows for the fetched (level, day) pairs before inserting fresh ones", async () => {
    // Regression guard: sync runs on a schedule with an OVERLAPPING window
    // each time. Without deleting the previous rows for those exact days
    // first, every re-sync would append another full copy on top and
    // spend/CPL/ROAS would silently multiply by however many times sync
    // has run — a real bug class this file's own header comment documents.
    const client = fakeClient({
      campaign: [{ date_start: "2026-08-25", date_stop: "2026-08-25", spend: "10", impressions: "100", clicks: "5" }],
      adset: [],
      ad: [],
    });

    await syncMetaPerformance(client, "last_7d", "eden");

    const deleteCalls = queryMock.mock.calls.filter(([sql]) => sql.includes("DELETE FROM meta_performance_snapshots"));
    expect(deleteCalls).toHaveLength(1); // only "campaign" had rows — adset/ad had none to delete for
    expect(deleteCalls[0][1]).toEqual(["eden", "campaign", ["2026-08-25"]]);

    const insertIndex = queryMock.mock.calls.findIndex(([sql]) => sql.includes("INSERT INTO meta_performance_snapshots"));
    const deleteIndex = queryMock.mock.calls.findIndex(([sql]) => sql.includes("DELETE FROM meta_performance_snapshots"));
    expect(deleteIndex).toBeLessThan(insertIndex);
  });

  it("skips the DELETE entirely for a level with zero fetched rows", async () => {
    const client = fakeClient({ campaign: [], adset: [], ad: [] });

    const count = await syncMetaPerformance(client, "last_7d", "eden");

    expect(count).toBe(0);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("converts Meta's percent-based ctr into a fraction, and defaults missing numerics to 0/null", async () => {
    const client = fakeClient({
      campaign: [
        {
          date_start: "2026-08-25",
          date_stop: "2026-08-25",
          spend: "50",
          impressions: "1000",
          clicks: "20",
          ctr: "2.5", // Meta reports this as a percent (2.5%)
          // cpc, reach, frequency intentionally absent
        },
      ],
      adset: [],
      ad: [],
    });

    await syncMetaPerformance(client, "last_7d", "eden");

    const insertCall = queryMock.mock.calls.find(([sql]) => sql.includes("INSERT INTO meta_performance_snapshots"));
    const params = insertCall![1];
    // clientId, fetched_at, date_start, date_stop, level, campaign_id, campaign_name,
    // adset_id, adset_name, ad_id, ad_name, spend, impressions, clicks, ctr, cpc, reach, frequency, raw
    expect(params[11]).toBe(50); // spend
    expect(params[12]).toBe(1000); // impressions
    expect(params[13]).toBe(20); // clicks
    expect(params[14]).toBeCloseTo(0.025); // ctr as a fraction, not 2.5
    expect(params[15]).toBeNull(); // cpc absent
    expect(params[16]).toBeNull(); // reach absent
    expect(params[17]).toBeNull(); // frequency absent
  });

  it("returns the total row count across all three levels", async () => {
    const client = fakeClient({
      campaign: [{ date_start: "2026-08-25" }],
      adset: [{ date_start: "2026-08-25" }, { date_start: "2026-08-26" }],
      ad: [{ date_start: "2026-08-25" }],
    });

    const count = await syncMetaPerformance(client, "last_7d", "eden");

    expect(count).toBe(4);
  });
});
