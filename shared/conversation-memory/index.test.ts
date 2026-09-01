import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../db", () => ({ query: (...args: unknown[]) => queryMock(...args) }));

import { appendHistory, loadHistory } from "./index";

beforeEach(() => {
  queryMock.mockClear();
});

describe("loadHistory", () => {
  it("scopes the lookup to the given agent and conversation thread", async () => {
    queryMock.mockResolvedValueOnce([]);

    await loadHistory("forge", "dm:U123");

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/agent_id = \$1 AND history_key = \$2/);
    expect(params).toEqual(["forge", "dm:U123", 20]);
  });

  it("returns rows oldest-first even though the query fetches newest-first", async () => {
    queryMock.mockResolvedValueOnce([
      { role: "assistant", content: "third" },
      { role: "user", content: "second" },
      { role: "user", content: "first" },
    ]);

    const history = await loadHistory("forge", "dm:U123");

    expect(history.map((m) => m.content)).toEqual(["first", "second", "third"]);
  });

  it("respects a custom limit", async () => {
    queryMock.mockResolvedValueOnce([]);

    await loadHistory("forge", "dm:U123", 5);

    expect(queryMock.mock.calls[0][1]).toEqual(["forge", "dm:U123", 5]);
  });
});

describe("appendHistory", () => {
  it("inserts with the given agent, thread, role, and content", async () => {
    queryMock.mockResolvedValueOnce([]);

    await appendHistory("forge", "dm:U123", "user", "how's the account doing?");

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO agent_conversations/);
    expect(params).toEqual(["forge", "dm:U123", "user", "how's the account doing?"]);
  });
});
