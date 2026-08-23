import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComplianceError } from "../../../shared/meta/compliance";

vi.mock("./queue", () => ({
  get: vi.fn(),
  markExecuted: vi.fn(),
  markFailed: vi.fn(),
  decide: vi.fn(),
}));
vi.mock("./audit", () => ({
  record: vi.fn(),
}));

import * as audit from "./audit";
import * as queue from "./queue";
import { ActionExecutor, ExecutionError } from "./executor";

function makePendingRow(overrides: Partial<any> = {}) {
  return {
    id: 1,
    rule_id: "high_cpl_pause",
    entity_type: "adset",
    entity_id: "adset_1",
    entity_name: "Test Adset",
    action_type: "pause",
    action_payload: {},
    ...overrides,
  };
}

function fakeResult(actionType: string) {
  return { entityType: "adset", entityId: "adset_1", actionType, before: {}, after: {}, requestPayload: {}, response: {} };
}

function makeFakeActions(overrides: Partial<any> = {}) {
  return {
    pause: vi.fn(async () => fakeResult("pause")),
    resume: vi.fn(async () => fakeResult("resume")),
    setDailyBudget: vi.fn(async () => fakeResult("set_budget")),
    adjustBudgetByPercent: vi.fn(async () => fakeResult("adjust_budget")),
    createCampaign: vi.fn(async () => fakeResult("create_campaign")),
    createAdset: vi.fn(async () => fakeResult("create_adset")),
    createAd: vi.fn(async () => fakeResult("create_ad")),
    uploadImage: vi.fn(async () => fakeResult("upload_image")),
    createAdCreative: vi.fn(async () => fakeResult("create_ad_creative")),
    updateAdCreative: vi.fn(async () => fakeResult("update_ad_creative")),
    duplicateAdset: vi.fn(async () => fakeResult("duplicate_adset")),
    setAdsetSpendTargets: vi.fn(async () => fakeResult("set_adset_spend_targets")),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ActionExecutor.executePending", () => {
  it("throws if the pending action doesn't exist", async () => {
    (queue.get as any).mockResolvedValue(null);
    const executor = new ActionExecutor(makeFakeActions() as any);
    await expect(executor.executePending(999, "user")).rejects.toThrow(ExecutionError);
  });

  it("handles notify_only without calling Meta at all", async () => {
    (queue.get as any).mockResolvedValue(makePendingRow({ action_type: "notify_only" }));
    const actions = makeFakeActions();
    const executor = new ActionExecutor(actions as any);
    const result = await executor.executePending(1, "user", true);

    expect(result.status).toBe("executed");
    expect(actions.pause).not.toHaveBeenCalled();
    expect(queue.markExecuted).toHaveBeenCalledWith(1);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ result: "success", actionType: "notify_only" }));
  });

  it("dispatches 'pause' and records success with the correct actor for auto vs human", async () => {
    (queue.get as any).mockResolvedValue(makePendingRow());
    const actions = makeFakeActions();
    const executor = new ActionExecutor(actions as any);

    await executor.executePending(1, "jacob", false);
    expect(actions.pause).toHaveBeenCalledWith("adset_1", "adset");
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ actor: "human:jacob", result: "success" }));
    expect(queue.markExecuted).toHaveBeenCalledWith(1);

    vi.clearAllMocks();
    (queue.get as any).mockResolvedValue(makePendingRow());
    await executor.executePending(1, "jacob", true);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ actor: "rule:high_cpl_pause" }));
  });

  it("routes set_budget/increase_budget/decrease_budget with correctly transformed payloads", async () => {
    const actions = makeFakeActions();
    const executor = new ActionExecutor(actions as any);

    (queue.get as any).mockResolvedValue(makePendingRow({ action_type: "set_budget", action_payload: { daily_budget_cents: 5000 } }));
    await executor.executePending(1, "u");
    expect(actions.setDailyBudget).toHaveBeenCalledWith("adset_1", "adset", 5000);

    (queue.get as any).mockResolvedValue(makePendingRow({ action_type: "increase_budget", action_payload: { percent: 20, max_daily_budget_cents: 10000 } }));
    await executor.executePending(1, "u");
    expect(actions.adjustBudgetByPercent).toHaveBeenCalledWith("adset_1", "adset", 20, 10000);

    (queue.get as any).mockResolvedValue(makePendingRow({ action_type: "decrease_budget", action_payload: { percent: 20 } }));
    await executor.executePending(1, "u");
    expect(actions.adjustBudgetByPercent).toHaveBeenCalledWith("adset_1", "adset", -20, undefined, 100);
  });

  it("marks failed and records failure, then rethrows, when the action throws a compliance error", async () => {
    (queue.get as any).mockResolvedValue(makePendingRow());
    const actions = makeFakeActions({ pause: vi.fn(async () => { throw new ComplianceError("nope"); }) });
    const executor = new ActionExecutor(actions as any);

    await expect(executor.executePending(1, "u")).rejects.toThrow(ComplianceError);
    expect(queue.markFailed).toHaveBeenCalledWith(1);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ result: "failure", detail: "nope" }));
    expect(queue.markExecuted).not.toHaveBeenCalled();
  });

  it("rejects creative-test action types with a clear not-yet-implemented error, without touching the queue", async () => {
    (queue.get as any).mockResolvedValue(makePendingRow({ action_type: "creative_test_lock_winner" }));
    const executor = new ActionExecutor(makeFakeActions() as any);
    await expect(executor.executePending(1, "u")).rejects.toThrow(/isn't ported yet/);
    expect(queue.markFailed).not.toHaveBeenCalled();
    expect(queue.markExecuted).not.toHaveBeenCalled();
  });
});

describe("ActionExecutor.executeManual", () => {
  it("records success without a rule_id or pending_action_id", async () => {
    const actions = makeFakeActions();
    const executor = new ActionExecutor(actions as any);
    await executor.executeManual("pause", "adset", "adset_1", "Test Adset", {}, "jacob");
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "human:jacob", result: "success" })
    );
    const call = (audit.record as any).mock.calls[0][0];
    expect(call.ruleId).toBeUndefined();
    expect(call.pendingActionId).toBeUndefined();
  });

  it("records failure and rethrows on error", async () => {
    const actions = makeFakeActions({ pause: vi.fn(async () => { throw new Error("boom"); }) });
    const executor = new ActionExecutor(actions as any);
    await expect(executor.executeManual("pause", "adset", "adset_1", null, {}, "jacob")).rejects.toThrow("boom");
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ result: "failure" }));
  });
});

describe("ActionExecutor.reject", () => {
  it("marks the pending action rejected and records it", async () => {
    (queue.get as any).mockResolvedValue(makePendingRow());
    const executor = new ActionExecutor(makeFakeActions() as any);
    await executor.reject(1, "jacob", "false alarm");
    expect(queue.decide).toHaveBeenCalledWith(1, "rejected", "jacob");
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ result: "rejected", detail: "false alarm" }));
  });

  it("throws if the pending action doesn't exist", async () => {
    (queue.get as any).mockResolvedValue(null);
    const executor = new ActionExecutor(makeFakeActions() as any);
    await expect(executor.reject(999, "jacob")).rejects.toThrow(ExecutionError);
  });
});
