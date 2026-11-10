import { describe, expect, it } from "vitest";
import { freshnessNotes } from "./freshness";

describe("freshnessNotes", () => {
  it("warns when the period runs past the last Meta day", () => {
    const notes = freshnessNotes({ periodTo: "2026-10-27", metaConnected: true, metaLastDay: "2026-10-20" });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/no data after 2026-10-20/);
  });

  it("stays quiet when Meta is up to date, a day behind, or not connected", () => {
    expect(freshnessNotes({ periodTo: "2026-10-27", metaConnected: true, metaLastDay: "2026-10-27" })).toEqual([]);
    expect(freshnessNotes({ periodTo: "2026-10-27", metaConnected: true, metaLastDay: "2026-10-26" })).toEqual([]);
    expect(freshnessNotes({ periodTo: "2026-10-27", metaConnected: false, metaLastDay: null })).toEqual([]);
    expect(freshnessNotes({ periodTo: "2026-10-27", metaConnected: true, metaLastDay: null })).toEqual([]);
  });

  it("is quiet for a period that ended before the data did", () => {
    expect(freshnessNotes({ periodTo: "2026-09-30", metaConnected: true, metaLastDay: "2026-10-20" })).toEqual([]);
  });
});
