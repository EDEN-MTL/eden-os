import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn(async () => []) }));
vi.mock("../../shared/db", () => db);
vi.mock("../scout", () => ({ recheckFirstTouch: vi.fn(), refreshLead: vi.fn() }));
const irisIndex = vi.hoisted(() => ({ loadIrisConfig: vi.fn(), loadClientBranding: vi.fn() }));
vi.mock("./index", () => irisIndex);
vi.mock("./scripts", () => ({ buildLeadQualificationPrompt: vi.fn(), extractFirstName: vi.fn() }));
vi.mock("./calling", () => ({ placeCall: vi.fn(), CallingDisabledError: class extends Error {} }));
vi.mock("./qualification", () => ({ transferNumberForIntent: vi.fn(), callbackCalendarForIntent: vi.fn() }));
vi.mock("./text-signals", () => ({ classifyInboundText: vi.fn(), lastInboundText: vi.fn() }));
vi.mock("./sms", () => ({ hasActiveSmsConversation: vi.fn() }));
vi.mock("../../shared/ghl", () => ({ getGhlConfig: vi.fn(), getLocationTimezone: vi.fn(), addContactTags: vi.fn() }));

import { reopenAfterMissedCallback } from "./dial-pending";

const CONFIG = {
  timezone: "America/St_Johns",
  outreachCadence: { attemptsPerDay: 2, days: 4, recheckBeforeEachAttempt: true },
};
const CREATED = new Date("2026-10-01T16:36:06.698Z");

/** Real calling-hour arithmetic (St. John's is UTC-2:30 in October) — only the clock is faked. */
function at(iso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

beforeEach(() => {
  irisIndex.loadIrisConfig.mockReturnValue(CONFIG);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

/**
 * Mark, 2026-10-05: Saife Sarwar asked for a callback, Iris called at
 * 6:55pm, no answer, and nothing ever tried again.
 */
describe("reopenAfterMissedCallback", () => {
  it("first miss: retries ~2 hours later when that lands in a reasonable hour", async () => {
    at("2026-10-05T14:00:00.000Z"); // 11:30am NL
    const out = await reopenAfterMissedCallback(69, "3-percent-east-coast", 2, CREATED, 0);

    expect(out).toMatchObject({ reopened: true, misses: 1, phase: "quick-retry" });
    if (out.reopened) expect(out.callAfter.toISOString()).toBe("2026-10-05T16:00:00.000Z"); // 1:30pm NL
    const [sql, params] = db.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/status = 'pending'/);
    expect(params[0]).toBe(69);
    expect(params[2]).toBe(1);
  });

  it("first miss late in the evening: waits for the next morning's 10am slot instead of calling at 9pm", async () => {
    at("2026-10-01T21:25:00.000Z"); // 6:55pm NL — +2h = 8:55pm, past the 8pm cutoff
    const out = await reopenAfterMissedCallback(69, "3-percent-east-coast", 2, CREATED, 0);

    expect(out.reopened).toBe(true);
    if (out.reopened) expect(out.callAfter.toISOString()).toBe("2026-10-02T12:30:00.000Z"); // 10:00am NL
  });

  it("second miss: goes back to the cadence slots and never calls sooner than the next 10am", async () => {
    at("2026-10-05T14:00:00.000Z"); // 11:30am NL — today's 10am slot already passed
    const out = await reopenAfterMissedCallback(69, "3-percent-east-coast", 3, CREATED, 1);

    expect(out).toMatchObject({ reopened: true, misses: 2, phase: "cadence" });
    if (out.reopened) expect(out.callAfter.toISOString()).toBe("2026-10-06T12:30:00.000Z"); // tomorrow 10am NL
  });

  it("stops once the cadence's attempts are all used up", async () => {
    at("2026-10-05T14:00:00.000Z");
    const out = await reopenAfterMissedCallback(69, "3-percent-east-coast", 8, CREATED, 3);

    expect(out).toEqual({ reopened: false });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("does nothing when the client has no Iris config", async () => {
    irisIndex.loadIrisConfig.mockReturnValue(null);
    expect(await reopenAfterMissedCallback(69, "nope", 2, CREATED, 0)).toEqual({ reopened: false });
  });
});
