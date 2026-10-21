import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn(async (..._a: unknown[]): Promise<any[]> => []) }));
vi.mock("../../../shared/db", () => db);

import { runningOnly, LiveStatusLookup } from "./metrics";
import { buildProposedActions } from "./engine";
import { EntityMetrics, Rule } from "./types";

const metrics = (over: Partial<EntityMetrics> & { entity_id: string }): EntityMetrics => ({
  entity_name: over.entity_id,
  spend: 0, impressions: 1000, clicks: 20, frequency: 1.2,
  lead_count: 0, crm_lead_count: 0, meta_lead_count: 0, lead_source: "none",
  won_count: 0, revenue: 0, ctr: null, cpc: null, cpm: null, cpl: null, roas: null,
  first_date: "2026-10-14", last_date: "2026-10-20", active_days: 6,
  ...over,
});

// The real case, 2026-10-20: one ad spent $98.97 of the ad set's $116.5 and got the only lead; Jacob paused it.
const ADSET = metrics({ entity_id: "adset-seller", entity_name: "AUG 2026 | Testing | Static  Seller", spend: 116.54, lead_count: 1, crm_lead_count: 1, meta_lead_count: 1, cpl: 116.54 });
const ADS = [
  metrics({ entity_id: "ad-new5", spend: 98.97, lead_count: 1, crm_lead_count: 1, meta_lead_count: 1, impressions: 8000, clicks: 160 }),
  metrics({ entity_id: "ad-new2", spend: 12.56 }),
  metrics({ entity_id: "ad-new1", spend: 4.94 }),
  metrics({ entity_id: "ad-new3", spend: 0.07 }),
];
const live = (over: Record<string, any> = {}): LiveStatusLookup =>
  new Map<string, any>(
    Object.entries({
      "adset-seller": { effectiveStatus: "ACTIVE", campaignId: "camp" },
      camp: { effectiveStatus: "ACTIVE" },
      "ad-new5": { effectiveStatus: "PAUSED", adsetId: "adset-seller", campaignId: "camp" },
      "ad-new2": { effectiveStatus: "ACTIVE", adsetId: "adset-seller", campaignId: "camp" },
      "ad-new1": { effectiveStatus: "ACTIVE", adsetId: "adset-seller", campaignId: "camp" },
      "ad-new3": { effectiveStatus: "ACTIVE", adsetId: "adset-seller", campaignId: "camp" },
      ...over,
    })
  );

describe("runningOnly", () => {
  it("judges an ad set on the ads still on: the paused ad's spend and lead drop out", () => {
    const [row] = runningOnly([ADSET], "adset", ADS, live());
    expect(row.spend).toBeCloseTo(17.57, 2);
    expect(row.lead_count).toBe(0);
    expect(row.cpl).toBeNull();
    expect(row.entity_name).toBe(ADSET.entity_name);
  });

  it("the CPL flag that fired on the old numbers no longer fires", () => {
    const rule: Rule = { id: "auto-cpl-high", clientId: "c", name: "CPL above config threshold", scope: "adset", metric: "cpl", operator: "gt", threshold: 110, action: { type: "notify_only" }, autoExecute: false, enabled: true, minSpend: 0, lookbackDays: 7, cooldownHours: 24, notes: "" };
    expect(buildProposedActions(rule, [ADSET], false, () => false)).toHaveLength(1); // before: flagged
    expect(buildProposedActions(rule, runningOnly([ADSET], "adset", ADS, live()), false, () => false)).toHaveLength(0); // after
  });

  it("keeps everything when every ad is still running", () => {
    const allOn = live({ "ad-new5": { effectiveStatus: "ACTIVE", adsetId: "adset-seller", campaignId: "camp" } });
    const [row] = runningOnly([ADSET], "adset", ADS, allOn);
    expect(row.spend).toBeCloseTo(116.54, 2);
    expect(row.lead_count).toBe(1);
    expect(row.cpl).toBeCloseTo(116.54, 2);
  });

  it("drops an ad set or campaign that is not itself running", () => {
    expect(runningOnly([ADSET], "adset", ADS, live({ "adset-seller": { effectiveStatus: "PAUSED" } }))).toEqual([]);
    expect(runningOnly([ADSET], "adset", ADS, live({ "adset-seller": { effectiveStatus: "CAMPAIGN_PAUSED" } }))).toEqual([]);
  });

  it("leaves an ad set as it was when there are no ad rows to rebuild it from", () => {
    expect(runningOnly([ADSET], "adset", [], live())).toEqual([ADSET]);
  });

  it("rolls a campaign up from its running ads across ad sets", () => {
    const camp = metrics({ entity_id: "camp", spend: 200, lead_count: 3, crm_lead_count: 3 });
    const more = metrics({ entity_id: "ad-other", spend: 50, lead_count: 2, crm_lead_count: 2, meta_lead_count: 2 });
    const l = live({ "ad-other": { effectiveStatus: "ACTIVE", adsetId: "adset-2", campaignId: "camp" } });
    const [row] = runningOnly([camp], "campaign", [...ADS, more], l);
    expect(row.spend).toBeCloseTo(67.57, 2);
    expect(row.lead_count).toBe(2);
  });

  it("for ads, only filters: a paused ad is not a decision", () => {
    expect(runningOnly(ADS, "ad", ADS, live()).map((a) => a.entity_id)).toEqual(["ad-new2", "ad-new1", "ad-new3"]);
  });

  it("an ad unknown to Meta (deleted) counts as not running", () => {
    const l = new Map(live());
    l.delete("ad-new2");
    const [row] = runningOnly([ADSET], "adset", ADS, l);
    expect(row.spend).toBeCloseTo(5.01, 2);
  });
});
