import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../../../shared/db", () => ({ query: (...args: unknown[]) => queryMock(...args) }));

import { record, listRecent, forEntity } from "./audit";

beforeEach(() => {
  queryMock.mockClear();
});

describe("record", () => {
  it("applies defaults and returns the inserted row's id", async () => {
    queryMock.mockResolvedValueOnce([{ id: 42 }]);

    const id = await record({
      actor: "human:jacob",
      actionType: "pause",
      entityType: "ad",
      entityId: "ad_1",
    });

    expect(id).toBe(42);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO ad_audit_log/);
    // clientId, actor, ruleId, actionType, entityType, entityId, entityName,
    // autoExecuted, pendingActionId, beforeState, afterState, result, detail
    expect(params).toEqual(["eden", "human:jacob", null, "pause", "ad", "ad_1", null, false, null, null, null, "success", ""]);
  });

  it("passes every explicit field through, and JSON-encodes before/after state", async () => {
    queryMock.mockResolvedValueOnce([{ id: 7 }]);

    await record({
      clientId: "matama",
      actor: "rule:cpl_cap",
      actionType: "budget_change",
      entityType: "adset",
      entityId: "adset_9",
      entityName: "Seller test",
      ruleId: "cpl_cap",
      autoExecuted: true,
      pendingActionId: 3,
      beforeState: { dailyBudget: 50 },
      afterState: { dailyBudget: 30 },
      result: "failure",
      detail: "Meta API rejected the change",
    });

    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual([
      "matama",
      "rule:cpl_cap",
      "cpl_cap",
      "budget_change",
      "adset",
      "adset_9",
      "Seller test",
      true,
      3,
      JSON.stringify({ dailyBudget: 50 }),
      JSON.stringify({ dailyBudget: 30 }),
      "failure",
      "Meta API rejected the change",
    ]);
  });

  it("leaves before/after state as null rather than the string 'null' when absent", async () => {
    queryMock.mockResolvedValueOnce([{ id: 1 }]);

    await record({ actor: "system", actionType: "sync", entityType: "campaign", entityId: "c1" });

    const [, params] = queryMock.mock.calls[0];
    const beforeState = params[9];
    const afterState = params[10];
    expect(beforeState).toBeNull();
    expect(afterState).toBeNull();
  });
});

describe("listRecent", () => {
  it("scopes to the given client with the default limit", async () => {
    queryMock.mockResolvedValueOnce([]);

    await listRecent("eden");

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/WHERE client_id = \$1/);
    expect(params).toEqual(["eden", 200]);
  });

  it("respects a custom limit", async () => {
    queryMock.mockResolvedValueOnce([]);

    await listRecent("matama", 10);

    expect(queryMock.mock.calls[0][1]).toEqual(["matama", 10]);
  });
});

describe("forEntity", () => {
  it("scopes to the given entity with the default limit", async () => {
    queryMock.mockResolvedValueOnce([]);

    await forEntity("ad_1");

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/WHERE entity_id = \$1/);
    expect(params).toEqual(["ad_1", 100]);
  });
});
