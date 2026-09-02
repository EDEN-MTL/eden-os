import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../db", () => ({ query: (...args: unknown[]) => queryMock(...args) }));

import { loadNotes, saveNote } from "./index";

beforeEach(() => {
  queryMock.mockClear();
});

describe("loadNotes", () => {
  it("scopes the lookup to the given agent", async () => {
    queryMock.mockResolvedValueOnce([]);

    await loadNotes("forge");

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/agent_id = \$1/);
    expect(params).toEqual(["forge", 50]);
  });

  it("returns notes oldest-first even though the query fetches newest-first", async () => {
    queryMock.mockResolvedValueOnce([{ note: "third" }, { note: "second" }, { note: "first" }]);

    const notes = await loadNotes("forge");

    expect(notes).toEqual(["first", "second", "third"]);
  });
});

describe("saveNote", () => {
  it("inserts the note under the given agent", async () => {
    queryMock.mockResolvedValueOnce([]);

    await saveNote("forge", "Client X hates AI-generated creative — never suggest it.");

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO agent_notes/);
    expect(params).toEqual(["forge", "Client X hates AI-generated creative — never suggest it."]);
  });
});
