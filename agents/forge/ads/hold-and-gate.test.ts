import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn(async (..._a: unknown[]): Promise<any[]> => []) }));
vi.mock("../../../shared/db", () => db);
const m = vi.hoisted(() => ({ computeMetrics: vi.fn() }));
vi.mock("./metrics", async (importActual) => ({ ...(await importActual<typeof import("./metrics")>()), computeMetrics: m.computeMetrics }));
vi.mock("./settings", () => ({ readEmergencyHoldAll: async () => false }));

import { holdRecentlyChanged, LiveStatusLookup } from "./metrics";
import { parseMetaTime } from "./health";
import { evaluate, gateByHealth, holdAfterChangeHours } from "./engine";
import { EntityMetrics, ProposedAction, Rule } from "./types";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const HOUR = 3_600_000;
const ago = (h: number) => NOW.getTime() - h * HOUR;

const row = (id: string, over: Partial<EntityMetrics> = {}): EntityMetrics => ({
  entity_id: id, entity_name: id, spend: 100, impressions: 1000, clicks: 20, frequency: 1.2,
  lead_count: 1, crm_lead_count: 1, meta_lead_count: 1, lead_source: "crm", won_count: 0, revenue: 0,
  ctr: null, cpc: null, cpm: null, cpl: 100, roas: null, first_date: "2026-10-14", last_date: "2026-10-20", active_days: 6, ...over,
});

const live = (over: Record<string, any> = {}): LiveStatusLookup =>
  new Map<string, any>(
    Object.entries({
      camp: { kind: "campaign", effectiveStatus: "ACTIVE", updatedAt: ago(500) },
      set1: { kind: "adset", effectiveStatus: "ACTIVE", campaignId: "camp", updatedAt: ago(500) },
      ad1: { kind: "ad", effectiveStatus: "ACTIVE", adsetId: "set1", campaignId: "camp", updatedAt: ago(500) },
      ad2: { kind: "ad", effectiveStatus: "ACTIVE", adsetId: "set1", campaignId: "camp", updatedAt: ago(500) },
      ...over,
    })
  );

describe("parseMetaTime", () => {
  it("reads Meta's offset without a colon", () => {
    expect(parseMetaTime("2026-10-20T00:47:15-0230")).toBe(Date.parse("2026-10-20T03:17:15.000Z"));
    expect(parseMetaTime("2026-10-20T03:17:15+0000")).toBe(Date.parse("2026-10-20T03:17:15.000Z"));
    expect(parseMetaTime("2026-10-20T03:17:15-02:30")).toBe(Date.parse("2026-10-20T05:47:15.000Z"));
    expect(parseMetaTime(undefined)).toBeUndefined();
    expect(parseMetaTime("not a time")).toBeUndefined();
  });
});

describe("holdRecentlyChanged", () => {
  it("holds an ad set while one of its ads was changed inside the window (the pause on Oct 20)", () => {
    const l = live({ ad1: { kind: "ad", effectiveStatus: "PAUSED", adsetId: "set1", campaignId: "camp", updatedAt: ago(10) } });
    expect(holdRecentlyChanged([row("set1")], "adset", l, NOW, 72)).toEqual([]);
  });

  it("releases it once the change is older than the window", () => {
    const l = live({ ad1: { kind: "ad", effectiveStatus: "PAUSED", adsetId: "set1", campaignId: "camp", updatedAt: ago(73) } });
    expect(holdRecentlyChanged([row("set1")], "adset", l, NOW, 72)).toHaveLength(1);
  });

  it("holds an ad set on its own recent change (a budget edit), and a campaign on its ad sets' changes", () => {
    expect(holdRecentlyChanged([row("set1")], "adset", live({ set1: { kind: "adset", effectiveStatus: "ACTIVE", campaignId: "camp", updatedAt: ago(5) } }), NOW, 72)).toEqual([]);
    expect(holdRecentlyChanged([row("camp")], "campaign", live({ set1: { kind: "adset", effectiveStatus: "ACTIVE", campaignId: "camp", updatedAt: ago(5) } }), NOW, 72)).toEqual([]);
  });

  it("a campaign is not held by a change to an ad two levels down", () => {
    const l = live({ ad1: { kind: "ad", effectiveStatus: "ACTIVE", adsetId: "set1", campaignId: "camp", updatedAt: ago(5) } });
    expect(holdRecentlyChanged([row("camp")], "campaign", l, NOW, 72)).toHaveLength(1);
  });

  it("holds a brand-new or just-edited ad on its own change, but not an old one", () => {
    const l = live({ ad1: { kind: "ad", effectiveStatus: "ACTIVE", adsetId: "set1", campaignId: "camp", updatedAt: ago(2) } });
    expect(holdRecentlyChanged([row("ad1"), row("ad2")], "ad", l, NOW, 72).map((r) => r.entity_id)).toEqual(["ad2"]);
  });

  it("never holds an entity Meta gave no change time for, and hours 0 turns it off", () => {
    const l = live({ set1: { kind: "adset", effectiveStatus: "ACTIVE", campaignId: "camp" } });
    expect(holdRecentlyChanged([row("set1")], "adset", l, NOW, 72)).toHaveLength(1);
    const changed = live({ ad1: { kind: "ad", effectiveStatus: "ACTIVE", adsetId: "set1", updatedAt: ago(1) } });
    expect(holdRecentlyChanged([row("set1")], "adset", changed, NOW, 0)).toHaveLength(1);
  });
});

const proposal = (ruleId: string, entityId: string): ProposedAction => ({
  rule: { id: ruleId, name: ruleId } as Rule,
  entityType: "adset", entityId, entityName: entityId, actionType: "notify_only", actionPayload: { type: "notify_only" },
  reasoning: "flat threshold text", metricsSnapshot: row(entityId), autoExecuteEligible: false,
});

describe("gateByHealth", () => {
  const verdicts = new Map([
    ["set1", { verdict: "scale", reasons: ["7 leads at $36"], recommendation: "Raise the budget." }],
    ["set2", { verdict: "kill", reasons: ["CPL $210 is 3.5x the $60 target on $210 spend, 1 lead(s)."], recommendation: "Pause this ad set." }],
  ]);

  it("drops the flat CPL flag on an ad set the health check calls a scale", () => {
    expect(gateByHealth([proposal("auto-cpl-high", "set1")], verdicts)).toEqual([]);
  });

  it("keeps it, with the health check's own words, when health also says kill", () => {
    const [p] = gateByHealth([proposal("auto-cpl-high", "set2")], verdicts);
    expect(p.reasoning).toBe("[Forge health: kill] CPL $210 is 3.5x the $60 target on $210 spend, 1 lead(s). Pause this ad set.");
  });

  it("drops it when health has nothing on the entity (not running, or no spend)", () => {
    expect(gateByHealth([proposal("auto-cpl-high", "ghost")], verdicts)).toEqual([]);
  });

  it("leaves other rules alone, and does nothing when there are no verdicts", () => {
    const fatigue = proposal("auto-fatigue-high", "set1");
    expect(gateByHealth([fatigue], verdicts)).toEqual([fatigue]);
    const flat = proposal("auto-cpl-high", "set1");
    expect(gateByHealth([flat], null)).toEqual([flat]);
  });
});

describe("evaluate, end to end on the Oct 20 case", () => {
  const rule = { id: "auto-cpl-high", client_id: "c", name: "CPL above config threshold", scope: "adset", metric: "cpl", operator: "gt", threshold: "110", action: { type: "notify_only" }, auto_execute: false, enabled: true, min_spend: "0", lookback_days: 7, cooldown_hours: 24, notes: "" };
  beforeEach(() => {
    db.query.mockImplementation(async (...a: unknown[]) => (/FROM ad_rules/.test(String(a[0])) ? [rule] : []));
    m.computeMetrics.mockImplementation(async (scope: string) =>
      scope === "adset"
        ? [row("set1", { spend: 116.27, lead_count: 1, cpl: 116.27 })]
        : [row("ad1", { spend: 98.97, lead_count: 1, crm_lead_count: 1 }), row("ad2", { spend: 17.3, lead_count: 0, crm_lead_count: 0, meta_lead_count: 0, cpl: null })]
    );
  });

  it("without live status the old flag fires", async () => {
    expect(await evaluate("c", null)).toHaveLength(1);
  });

  it("with live status it does not: the costly ad is off, and the change is recent", async () => {
    const l = live({ ad1: { kind: "ad", effectiveStatus: "PAUSED", adsetId: "set1", campaignId: "camp", updatedAt: ago(14) } });
    expect(await evaluate("c", l, { now: NOW, holdHours: 0 })).toEqual([]); // rolled up: $17, no leads
    expect(await evaluate("c", l, { now: NOW, holdHours: 72 })).toEqual([]); // and held besides
  });

  it("if the paused ad is old news but the rest still looks bad, the health gate decides", async () => {
    const l = live({ ad1: { kind: "ad", effectiveStatus: "ACTIVE", adsetId: "set1", campaignId: "camp", updatedAt: ago(500) } });
    const flagged = await evaluate("c", l, { now: NOW, holdHours: 72, healthVerdicts: new Map([["set1", { verdict: "scale", reasons: [], recommendation: "" }]]) });
    expect(flagged).toEqual([]);
    const killed = await evaluate("c", l, { now: NOW, holdHours: 72, healthVerdicts: new Map([["set1", { verdict: "kill", reasons: ["bad"], recommendation: "Pause." }]]) });
    expect(killed).toHaveLength(1);
    expect(killed[0].reasoning).toContain("[Forge health: kill] bad Pause.");
  });
});

describe("holdAfterChangeHours", () => {
  it("defaults to 72 hours; a client config can change it", () => {
    expect(holdAfterChangeHours("no-such-client")).toBe(72);
  });
});
