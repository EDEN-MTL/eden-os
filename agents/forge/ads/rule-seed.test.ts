import { describe, expect, it, vi } from "vitest";
import { buildDefaultRuleSpecs } from "./rule-seed";

describe("buildDefaultRuleSpecs", () => {
  it("produces a CPL rule when forge.cplThreshold is a number", () => {
    const specs = buildDefaultRuleSpecs({ cplThreshold: 120 });
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ id: "auto-cpl-high", metric: "cpl", operator: "gt", threshold: 120, scope: "adset" });
  });

  it("produces a fatigue rule when forge.fatigueThreshold is a number", () => {
    const specs = buildDefaultRuleSpecs({ fatigueThreshold: 3 });
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ id: "auto-fatigue-high", metric: "frequency", operator: "gt", threshold: 3, scope: "ad" });
  });

  it("skips the ROAS rule when roasEnabled is false, even if roasTarget is set", () => {
    // Real case: both eden.json and 3-percent-east-coast.json currently
    // disable ROAS because there isn't enough revenue data yet.
    const specs = buildDefaultRuleSpecs({ roasEnabled: false, roasTarget: 3.5 });
    expect(specs.find((s) => s.id === "auto-roas-low")).toBeUndefined();
  });

  it("produces a ROAS rule when roasEnabled is true and roasTarget is a number", () => {
    const specs = buildDefaultRuleSpecs({ roasEnabled: true, roasTarget: 3.5 });
    const roasSpec = specs.find((s) => s.id === "auto-roas-low");
    expect(roasSpec).toMatchObject({ metric: "roas", operator: "lt", threshold: 3.5, scope: "adset" });
  });

  it("produces all three rules together for a fully-configured client", () => {
    const specs = buildDefaultRuleSpecs({ cplThreshold: 35, fatigueThreshold: 3, roasEnabled: true, roasTarget: 3.5 });
    expect(specs.map((s) => s.id).sort()).toEqual(["auto-cpl-high", "auto-fatigue-high", "auto-roas-low"]);
  });

  it("produces nothing for a missing or empty forge config", () => {
    expect(buildDefaultRuleSpecs(undefined)).toEqual([]);
    expect(buildDefaultRuleSpecs({})).toEqual([]);
  });

});

const queryMock = vi.fn();
vi.mock("../../../shared/db", () => ({ query: (...args: unknown[]) => queryMock(...args) }));

describe("ensureDefaultAdRules", () => {
  it("upserts one row per produced rule spec, scoped to the client's own id", async () => {
    queryMock.mockReset();
    queryMock.mockResolvedValueOnce([{ client_id: "eden" }]); // listMetaClientIds
    queryMock.mockResolvedValue([]); // every subsequent upsert

    vi.resetModules();
    vi.doMock("fs", () => ({
      readFileSync: vi.fn(() => JSON.stringify({ forge: { cplThreshold: 120, fatigueThreshold: 3 } })),
    }));
    const { ensureDefaultAdRules } = await import("./rule-seed");

    await ensureDefaultAdRules();

    const upsertCalls = queryMock.mock.calls.filter((call) => String(call[0]).includes("INSERT INTO ad_rules"));
    expect(upsertCalls).toHaveLength(2);
    expect(upsertCalls[0][1]).toEqual(expect.arrayContaining(["auto-cpl-high", "eden"]));
    // Never a specific prescribed change (pause/budget cut) — the right
    // remedy depends on account structure this function has no way to
    // know, so every seeded rule only ever flags, it never acts.
    for (const call of upsertCalls) {
      expect(call[1][7]).toBe(JSON.stringify({ type: "notify_only" }));
    }
  });

  it("skips a client whose config has no forge block at all, without throwing", async () => {
    queryMock.mockReset();
    queryMock.mockResolvedValueOnce([{ client_id: "no-forge-config" }]);

    vi.resetModules();
    vi.doMock("fs", () => ({ readFileSync: vi.fn(() => JSON.stringify({ clientName: "No Forge Config" })) }));
    const { ensureDefaultAdRules } = await import("./rule-seed");

    await expect(ensureDefaultAdRules()).resolves.toBeUndefined();
    const upsertCalls = queryMock.mock.calls.filter((call) => String(call[0]).includes("INSERT INTO ad_rules"));
    expect(upsertCalls).toHaveLength(0);
  });
});
