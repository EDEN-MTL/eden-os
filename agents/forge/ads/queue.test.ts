import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../../../shared/db", () => ({ query: (...args: unknown[]) => queryMock(...args) }));

import { decide, enqueue, get, listAll, listPending, markExecuted, markFailed, recordSlackMessage } from "./queue";
import { ProposedAction } from "./types";

const proposed: ProposedAction = {
  rule: {
    id: "cpl_cap",
    clientId: "eden",
    name: "CPL cap",
    scope: "ad",
    metric: "cpl",
    operator: "gt",
    threshold: 50,
    action: { type: "pause" },
    autoExecute: false,
    enabled: true,
    minSpend: 20,
    lookbackDays: 7,
    cooldownHours: 24,
    notes: "",
  },
  entityType: "ad",
  entityId: "ad_1",
  entityName: "Aug 2026 image 6",
  actionType: "pause",
  actionPayload: { type: "pause" },
  reasoning: "CPL exceeded threshold",
  metricsSnapshot: { spend: 100, cpl: 60 } as any,
  autoExecuteEligible: false,
};

beforeEach(() => {
  queryMock.mockClear();
});

describe("enqueue", () => {
  it("inserts a pending row with the rule/action fields, JSON-encoding payload and metrics", async () => {
    queryMock.mockResolvedValueOnce([{ id: 9 }]);

    const id = await enqueue(proposed, "matama");

    expect(id).toBe(9);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO ad_pending_actions/);
    expect(sql).toMatch(/'pending'/);
    expect(params).toEqual([
      "matama",
      "cpl_cap",
      "CPL cap",
      "ad",
      "ad_1",
      "Aug 2026 image 6",
      "pause",
      JSON.stringify({ type: "pause" }),
      "CPL exceeded threshold",
      JSON.stringify({ spend: 100, cpl: 60 }),
      false,
    ]);
  });

  it("defaults to the eden client when none is given", async () => {
    queryMock.mockResolvedValueOnce([{ id: 1 }]);

    await enqueue(proposed);

    expect(queryMock.mock.calls[0][1][0]).toBe("eden");
  });
});

describe("listPending", () => {
  it("scopes to the client and only the pending status", async () => {
    queryMock.mockResolvedValueOnce([]);

    await listPending("matama");

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/status = 'pending'/);
    expect(params).toEqual(["matama"]);
  });
});

describe("listAll", () => {
  it("scopes to the client with the default limit", async () => {
    queryMock.mockResolvedValueOnce([]);

    await listAll("eden");

    expect(queryMock.mock.calls[0][1]).toEqual(["eden", 200]);
  });
});

describe("get", () => {
  it("returns the row when found", async () => {
    queryMock.mockResolvedValueOnce([{ id: 5 }]);
    expect(await get(5)).toEqual({ id: 5 });
  });

  it("returns null when not found, rather than undefined", async () => {
    queryMock.mockResolvedValueOnce([]);
    expect(await get(999)).toBeNull();
  });
});

describe("recordSlackMessage", () => {
  it("updates the channel and message ts for the given action", async () => {
    queryMock.mockResolvedValueOnce([]);

    await recordSlackMessage(5, "C123", "1700000000.000100");

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/UPDATE ad_pending_actions SET slack_channel/);
    expect(params).toEqual(["C123", "1700000000.000100", 5]);
  });
});

describe("decide", () => {
  it("rejects an invalid decision value before ever touching the database", async () => {
    await expect(decide(5, "maybe" as any, "human:jacob")).rejects.toThrow(/must be 'approved' or 'rejected'/);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("records who decided and when, but only while still pending", async () => {
    // The `AND status = 'pending'` guard is the actual correctness property
    // here — it's what makes a second, late decision on an already-decided
    // action a no-op instead of silently overwriting the first one (e.g. a
    // stale Slack button click after someone else already approved it).
    queryMock.mockResolvedValueOnce([]);

    await decide(5, "approved", "human:jacob");

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/status = \$1/);
    expect(sql).toMatch(/AND status = 'pending'/);
    expect(params).toEqual(["approved", "human:jacob", 5]);
  });
});

describe("markExecuted / markFailed", () => {
  it("markExecuted sets status and executed_at for the given id", async () => {
    queryMock.mockResolvedValueOnce([]);
    await markExecuted(5);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/status = 'executed'/);
    expect(params).toEqual([5]);
  });

  it("markFailed sets status without touching executed_at", async () => {
    queryMock.mockResolvedValueOnce([]);
    await markFailed(5);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/status = 'failed'/);
    expect(sql).not.toMatch(/executed_at/);
    expect(params).toEqual([5]);
  });
});
