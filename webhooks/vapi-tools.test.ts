import { describe, expect, it } from "vitest";
import { resolveRequestedTime, parseToolArguments, ToolCall } from "./vapi-tools";

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
