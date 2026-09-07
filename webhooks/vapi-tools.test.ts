import { describe, expect, it } from "vitest";
import { resolveRequestedTime, parseToolArguments, ToolCall } from "./vapi-tools";

/**
 * Mark's live feedback, 2026-09-08 (reviewing a call recording where every
 * single check_and_book_appointment call looped on "No requestedTime was
 * given" for the entire call): confirmed against every historical
 * iris_call_log row that this tool has NEVER once successfully read an
 * argument, on any call, for any client — because the old code read
 * `call.arguments?.requestedTime` directly, but Vapi's real ToolCall shape
 * (confirmed against their own OpenAPI schema AND a live call's stored raw
 * payload) nests a JSON-ENCODED STRING under `call.function.arguments`.
 * `call.arguments` never existed on the real wire format, so it was always
 * `undefined`. These tests build the tool call exactly the way Vapi's
 * schema and a real captured payload describe it — not the shape this
 * file's own (wrong) interface used to declare — so a regression back to
 * reading a flat `.arguments` field would be caught immediately.
 */
describe("parseToolArguments", () => {
  function realToolCall(name: string, args: Record<string, unknown>): ToolCall {
    return { id: "call_test123", type: "function", function: { name, arguments: JSON.stringify(args) } };
  }

  it("parses the real wire shape — a JSON-encoded string nested under function.arguments", () => {
    const call = realToolCall("check_and_book_appointment", { requestedTime: "2026-09-07T18:30:00" });
    expect(parseToolArguments(call)).toEqual({ requestedTime: "2026-09-07T18:30:00" });
  });

  /**
   * Reproduces the exact payload captured from a real call's raw Vapi
   * artifact (iris_call_log #30, 2026-09-07) that looped forever under the
   * old code.
   */
  it("extracts requestedTime from a real captured Vapi tool-call payload", () => {
    const raw = '{"requestedTime": "2026-09-07T18:30:00"}';
    const call: ToolCall = { id: "call_Vy12P18JbYXgc6uQHLivJukZ", type: "function", function: { name: "check_and_book_appointment", arguments: raw } };
    expect(parseToolArguments(call).requestedTime).toBe("2026-09-07T18:30:00");
  });

  it("degrades to an empty object on malformed JSON rather than throwing", () => {
    const call: ToolCall = { id: "call_bad", type: "function", function: { name: "check_and_book_appointment", arguments: "not json" } };
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
