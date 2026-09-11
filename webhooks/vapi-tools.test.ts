import { describe, expect, it } from "vitest";
import { resolveRequestedTime, parseToolArguments, matchTransferAgentCandidates, ToolCall } from "./vapi-tools";
import { GhlUser } from "../shared/ghl";

/**
 * Round two of this bug, 2026-09-08. First fix assumed Vapi's own OpenAPI
 * schema was right that `function.arguments` is a JSON-encoded string —
 * deployed, then a live call STILL hit "No requestedTime was given" every
 * time. Temporary debug logging captured the real production webhook body
 * and found the actual shape: `function.arguments` arrives as an
 * ALREADY-PARSED OBJECT, not a string. `JSON.parse()` on that coerced it to
 * `"[object Object]"` (invalid JSON), threw, and the catch-all silently
 * returned `{}` — reproducing the exact same symptom in a new form.
 * Confirmed against every historical iris_call_log row: 100% of
 * schedule_callback/check_and_book_appointment tool results, across every
 * call for every client since this was built, hit the "no valid time" error
 * path before this fix. These tests cover BOTH real shapes seen, not just
 * whichever one was assumed correct this time.
 */
describe("parseToolArguments", () => {
  it("parses arguments already delivered as a parsed object — the real production shape", () => {
    // Captured verbatim from iris_call_log #34's raw Vapi payload, 2026-09-08.
    const call: ToolCall = {
      id: "call_FjrthOQhSRjD4spnvdYMuFDf",
      type: "function",
      function: { name: "check_and_book_appointment", arguments: { requestedTime: "2026-09-08T08:45:00" } },
    };
    expect(parseToolArguments(call)).toEqual({ requestedTime: "2026-09-08T08:45:00" });
  });

  it("also parses a JSON-encoded string, in case Vapi ever sends that shape instead", () => {
    const call: ToolCall = {
      id: "call_test123",
      type: "function",
      function: { name: "check_and_book_appointment", arguments: JSON.stringify({ requestedTime: "2026-09-07T18:30:00" }) },
    };
    expect(parseToolArguments(call)).toEqual({ requestedTime: "2026-09-07T18:30:00" });
  });

  it("degrades to an empty object on malformed JSON rather than throwing", () => {
    const call: ToolCall = { id: "call_bad", type: "function", function: { name: "check_and_book_appointment", arguments: "not json" } };
    expect(parseToolArguments(call)).toEqual({});
  });

  it("degrades to an empty object on null/undefined arguments rather than throwing", () => {
    const call: ToolCall = { id: "call_null", type: "function", function: { name: "check_and_book_appointment", arguments: null as unknown as string } };
    expect(parseToolArguments(call)).toEqual({});
  });
});

describe("resolveRequestedTime", () => {
  /**
   * Confirmed live, 2026-09-06: a real test call had the model send a bare
   * ISO string like "2026-09-05T18:00:00" (no offset) meaning "6 PM
   * Toronto" — bare `new Date(...)` on a string like that parses as the
   * SERVER's local time (a Render server runs in UTC), silently shifting
   * the intended moment by 4 hours and missing every real calendar slot.
   * Iris kept saying "trouble booking" because nothing ever matched, real
   * availability included. This is the fix: a naive (no-offset) string is
   * interpreted as wall-clock time in the given IANA timezone, not UTC.
   */
  it("interprets a bare (no-offset) timestamp as wall-clock time in the given timezone, not UTC", () => {
    // "6:30 PM" wall-clock in Toronto (EDT, UTC-4) is 22:30 UTC.
    const resolved = resolveRequestedTime("2026-09-05T18:30:00", "America/Toronto");
    expect(resolved).not.toBeNull();
    expect(resolved!.toISOString()).toBe("2026-09-05T22:30:00.000Z");
  });

  it("trusts a timestamp that already carries a 'Z' UTC marker", () => {
    const resolved = resolveRequestedTime("2026-09-05T22:30:00Z", "America/Toronto");
    expect(resolved!.toISOString()).toBe("2026-09-05T22:30:00.000Z");
  });

  it("trusts a timestamp that already carries an explicit offset", () => {
    const resolved = resolveRequestedTime("2026-09-05T18:30:00-04:00", "America/Toronto");
    expect(resolved!.toISOString()).toBe("2026-09-05T22:30:00.000Z");
  });

  it("handles a half-hour-offset timezone correctly (America/St_Johns, UTC-02:30)", () => {
    // St. John's is a classic source of scheduling bugs elsewhere in this
    // codebase (see agents/iris/cadence.ts's zonedHourToUtc) — same care
    // applies here.
    const resolved = resolveRequestedTime("2026-09-05T18:30:00", "America/St_Johns");
    expect(resolved!.toISOString()).toBe("2026-09-05T21:00:00.000Z");
  });

  it("returns null for an unparseable string", () => {
    expect(resolveRequestedTime("not a time", "America/Toronto")).toBeNull();
  });
});

/**
 * Mark's spec, 2026-09-12: post-transfer agent identification. "Andrew"
 * spoken should match a real "Andrew Fleming" user; an exact full name
 * should match too; two real Andrews should come back as both candidates
 * (ambiguous) rather than silently picking one — the confirmation step in
 * calling.ts's transferAssistant prompt depends on getting real candidates
 * back, not a single silent guess.
 */
describe("matchTransferAgentCandidates", () => {
  const andrewFleming: GhlUser = { id: "u1", firstName: "Andrew", lastName: "Fleming", name: "Andrew Fleming" };
  const andrewSmith: GhlUser = { id: "u2", firstName: "Andrew", lastName: "Smith", name: "Andrew Smith" };
  const jason: GhlUser = { id: "u3", firstName: "Jason", lastName: "Lee", name: "Jason Lee" };
  const roster = [andrewFleming, andrewSmith, jason];

  it("matches a bare first name to the one real user with that first name", () => {
    expect(matchTransferAgentCandidates("Jason", [jason])).toEqual([jason]);
  });

  it("matches an exact full name", () => {
    expect(matchTransferAgentCandidates("Andrew Fleming", roster)).toEqual([andrewFleming]);
  });

  it("is case-insensitive", () => {
    expect(matchTransferAgentCandidates("jason lee", roster)).toEqual([jason]);
    expect(matchTransferAgentCandidates("JASON", roster)).toEqual([jason]);
  });

  it("returns every candidate when a first name matches more than one real user, rather than guessing one", () => {
    const result = matchTransferAgentCandidates("Andrew", roster);
    expect(result).toHaveLength(2);
    expect(result).toEqual(expect.arrayContaining([andrewFleming, andrewSmith]));
  });

  it("returns no candidates for a name that matches nobody real", () => {
    expect(matchTransferAgentCandidates("Xavier", roster)).toEqual([]);
  });

  it("returns no candidates for an empty or blank name", () => {
    expect(matchTransferAgentCandidates("", roster)).toEqual([]);
    expect(matchTransferAgentCandidates("   ", roster)).toEqual([]);
  });

  it("falls back to a loose substring match for a partially-heard name", () => {
    // "Flemish" as a mishearing of "Fleming" — the exact scenario the
    // spec's own "reality check" section calls out.
    expect(matchTransferAgentCandidates("Fleming", roster)).toEqual([andrewFleming]);
  });
});
