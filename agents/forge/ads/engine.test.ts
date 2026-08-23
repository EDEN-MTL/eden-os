import { describe, expect, it } from "vitest";
import { applyOperator, buildProposedActions } from "./engine";
import { EntityMetrics, Rule } from "./types";

function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: "high_cpl_pause",
    clientId: "eden",
    name: "Pause on high CPL",
    scope: "adset",
    metric: "cpl",
    operator: "gt",
    threshold: 35,
    action: { type: "pause" },
    autoExecute: false,
    enabled: true,
    minSpend: 20,
    lookbackDays: 3,
    cooldownHours: 24,
    notes: "",
    ...overrides,
  };
}

function makeRow(overrides: Partial<EntityMetrics> = {}): EntityMetrics {
  return {
    entity_id: "adset_1",
    entity_name: "Test Adset",
    spend: 100,
    impressions: 1000,
    clicks: 50,
    frequency: 1.5,
    lead_count: 2,
    won_count: 0,
    revenue: 0,
    ctr: 0.05,
    cpc: 2,
    cpl: 50,
    roas: 0,
    ...overrides,
  };
}

describe("applyOperator", () => {
  it("evaluates each operator correctly", () => {
    expect(applyOperator("gt", 10, 5)).toBe(true);
    expect(applyOperator("gt", 5, 10)).toBe(false);
    expect(applyOperator("gte", 5, 5)).toBe(true);
    expect(applyOperator("lt", 3, 5)).toBe(true);
    expect(applyOperator("lte", 5, 5)).toBe(true);
  });
});

describe("buildProposedActions", () => {
  it("fires when the metric crosses the threshold", () => {
    const actions = buildProposedActions(makeRule(), [makeRow({ cpl: 50 })], false, () => false);
    expect(actions).toHaveLength(1);
    expect(actions[0].entityId).toBe("adset_1");
    expect(actions[0].actionType).toBe("pause");
  });

  it("does not fire when the metric doesn't cross the threshold", () => {
    const actions = buildProposedActions(makeRule(), [makeRow({ cpl: 20 })], false, () => false);
    expect(actions).toHaveLength(0);
  });

  it("skips entities below min_spend even if the metric would fire", () => {
    const actions = buildProposedActions(makeRule({ minSpend: 200 }), [makeRow({ spend: 100, cpl: 999 })], false, () => false);
    expect(actions).toHaveLength(0);
  });

  it("skips entities with a null metric value", () => {
    const actions = buildProposedActions(makeRule(), [makeRow({ cpl: null })], false, () => false);
    expect(actions).toHaveLength(0);
  });

  it("skips entities currently in cooldown", () => {
    const actions = buildProposedActions(makeRule(), [makeRow({ cpl: 50 })], false, () => true);
    expect(actions).toHaveLength(0);
  });

  it("marks auto_execute_eligible only when the rule allows it AND emergency hold is off", () => {
    const rule = makeRule({ autoExecute: true });
    const row = makeRow({ cpl: 50 });

    expect(buildProposedActions(rule, [row], false, () => false)[0].autoExecuteEligible).toBe(true);
    expect(buildProposedActions(rule, [row], true, () => false)[0].autoExecuteEligible).toBe(false);
    expect(buildProposedActions(makeRule({ autoExecute: false }), [row], false, () => false)[0].autoExecuteEligible).toBe(
      false
    );
  });

  it("includes the rule's notes in the reasoning when present", () => {
    const actions = buildProposedActions(
      makeRule({ notes: "Watch this one closely" }),
      [makeRow({ cpl: 50 })],
      false,
      () => false
    );
    expect(actions[0].reasoning).toContain("Watch this one closely");
  });

  it("evaluates multiple entities independently", () => {
    const actions = buildProposedActions(
      makeRule(),
      [makeRow({ entity_id: "a", cpl: 50 }), makeRow({ entity_id: "b", cpl: 10 }), makeRow({ entity_id: "c", cpl: 100 })],
      false,
      () => false
    );
    expect(actions.map((a) => a.entityId)).toEqual(["a", "c"]);
  });
});
