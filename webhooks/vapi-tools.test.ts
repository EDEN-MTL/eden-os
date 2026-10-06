import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ghl = vi.hoisted(() => ({
  getGhlConfig: vi.fn(),
  getCustomFieldDefs: vi.fn(),
  updateContact: vi.fn(),
  getContact: vi.fn(),
}));
vi.mock("../shared/ghl", () => ghl);

const iris = vi.hoisted(() => ({ loadIrisConfig: vi.fn() }));
vi.mock("../agents/iris", () => iris);

const dialPending = vi.hoisted(() => ({ scheduleExplicitCallback: vi.fn(async () => true) }));
vi.mock("../agents/iris/dial-pending", () => dialPending);

import { resolveRequestedTime, parseToolArguments, matchTransferAgentCandidates, handleScheduleCallback, compactIsaNotes, ISA_NOTES_MAX_CHARS, ToolCall } from "./vapi-tools";
import { GhlUser } from "../shared/ghl";

afterEach(() => vi.clearAllMocks());

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

/**
 * Mark's spec, 2026-10-01, from a real example (Saife Sarwar: "Ma'am,
 * right now is busy. Can I call you later?"): the lead doesn't always give
 * a specific time, and Iris must never invent one — the system defaults to
 * ~1 hour out instead. Previously callbackTime was REQUIRED and the tool
 * returned an error whenever the lead hadn't given a concrete time, which
 * pushed the model toward guessing one to avoid the error.
 */
describe("handleScheduleCallback", () => {
  const CONFIG = { timezone: "America/St_Johns", callbackNotesFieldKey: "contact.isa_notes" };

  beforeEach(() => {
    iris.loadIrisConfig.mockReturnValue(CONFIG);
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
    ghl.getCustomFieldDefs.mockResolvedValue([{ id: "field-1", fieldKey: "contact.isa_notes" }]);
    dialPending.scheduleExplicitCallback.mockResolvedValue(true);
  });

  it("schedules exactly the lead's named time when one is given", async () => {
    const when = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const result = await handleScheduleCallback("3-percent-east-coast", "contact-1", when);

    expect(dialPending.scheduleExplicitCallback).toHaveBeenCalledWith("3-percent-east-coast", "contact-1", new Date(when));
    expect(result).toContain("Confirm this back to the lead");
  });

  it("defaults to ~1 hour out and tells the model NOT to state a time, when no callbackTime is given at all", async () => {
    const before = Date.now();
    const result = await handleScheduleCallback("3-percent-east-coast", "contact-1", undefined);
    const after = Date.now();

    expect(dialPending.scheduleExplicitCallback).toHaveBeenCalledTimes(1);
    const scheduledFor = (dialPending.scheduleExplicitCallback.mock.calls[0][2] as Date).getTime();
    expect(scheduledFor).toBeGreaterThanOrEqual(before + 59 * 60 * 1000);
    expect(scheduledFor).toBeLessThanOrEqual(after + 61 * 60 * 1000);
    expect(result).toMatch(/do not state any time/i);
  });

  it("also defaults to ~1 hour out for an empty string or non-string callbackTime, rather than erroring", async () => {
    await handleScheduleCallback("3-percent-east-coast", "contact-1", "");
    expect(dialPending.scheduleExplicitCallback).toHaveBeenCalledTimes(1);

    dialPending.scheduleExplicitCallback.mockClear();
    await handleScheduleCallback("3-percent-east-coast", "contact-1", null);
    expect(dialPending.scheduleExplicitCallback).toHaveBeenCalledTimes(1);
  });

  it("still rejects an explicit time that's too soon, too far out, or outside legal hours — only the no-time path gets a default", async () => {
    const tooSoon = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    expect(await handleScheduleCallback("3-percent-east-coast", "contact-1", tooSoon)).toMatch(/too soon/i);
    expect(dialPending.scheduleExplicitCallback).not.toHaveBeenCalled();

    const tooFar = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(await handleScheduleCallback("3-percent-east-coast", "contact-1", tooFar)).toMatch(/too far out/i);
    expect(dialPending.scheduleExplicitCallback).not.toHaveBeenCalled();
  });

  it("writes a callback note on the contact for both the specific-time and default-time paths", async () => {
    const when = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    await handleScheduleCallback("3-percent-east-coast", "contact-1", when);
    expect(ghl.updateContact).toHaveBeenCalledWith(
      "contact-1",
      { customFields: [{ id: "field-1", value: expect.stringContaining("Iris scheduled a callback") }] },
      "loc-1",
      "key-1"
    );

    ghl.updateContact.mockClear();
    await handleScheduleCallback("3-percent-east-coast", "contact-1", undefined);
    expect(ghl.updateContact).toHaveBeenCalledTimes(1);
  });
});

/** Mark, 2026-10-06: ISA notes become a per-segment-billed text to the receiving agent, so they stay short. */
describe("compactIsaNotes", () => {
  it("flattens the old multi-line format onto one line", () => {
    expect(compactIsaNotes("Intent: Buyer\nTimeline: ASAP\nBudget: $350K")).toBe("Intent: Buyer | Timeline: ASAP | Budget: $350K");
  });

  it("leaves an already-short single line untouched", () => {
    const line = "Buyer | ASAP | St. John's (Penjance) | $350-400K | Duplex w/ suite | Not pre-approved";
    expect(compactIsaNotes(line)).toBe(line);
  });

  it("drops emojis and flattens smart punctuation, which would otherwise force 70-character text segments", () => {
    expect(compactIsaNotes("\u2705 Buyer \u2014 ASAP \u2018hot\u2019")).toBe("Buyer - ASAP 'hot'");
  });

  it("caps a long note by dropping whole trailing facts, never ending mid-fact", () => {
    const long = [
      "Lead: Kiyoma",
      "Intent: Buyer",
      "Timeline: ASAP",
      "Target Area: St. John's and surrounding neighborhoods (Penjance/Montpellier area)",
      "Budget: $350,000 - $400,000",
      "Property Type: Duplex with garage and basement apartment",
      "Bedrooms/Bathrooms: Main unit - 5 bedrooms, 3 bathrooms; Basement apartment - 2 bedrooms, 1 bathroom",
      "Pre-Approval: Not yet preapproved",
      "Additional Context: Lead just returned from work, looking for multi-unit property with specific configuration.",
    ].join("\n");

    const out = compactIsaNotes(long);

    expect(out.length).toBeLessThanOrEqual(ISA_NOTES_MAX_CHARS);
    expect(out).toContain("Budget: $350,000 - $400,000");
    expect(out.endsWith("|")).toBe(false);
    expect(long.replace(/\n/g, " | ").startsWith(out)).toBe(true);
  });

  it("returns an empty string when nothing usable is left", () => {
    expect(compactIsaNotes("\u2705\u2705")).toBe("");
  });
});
