import { afterEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../shared/db", () => db);
const scout = vi.hoisted(() => ({ recheckFirstTouch: vi.fn(), refreshLead: vi.fn() }));
vi.mock("../scout", () => scout);
const idx = vi.hoisted(() => ({ loadIrisConfig: vi.fn(), loadClientBranding: vi.fn() }));
vi.mock("./index", () => idx);
vi.mock("./scripts", () => ({ buildLeadQualificationPrompt: vi.fn(), extractFirstName: vi.fn() }));
vi.mock("./calling", () => ({ placeCall: vi.fn(), CallingDisabledError: class extends Error {} }));
vi.mock("./qualification", () => ({ transferNumberForIntent: vi.fn(), callbackCalendarForIntent: vi.fn() }));
vi.mock("./text-signals", () => ({ classifyInboundText: vi.fn(), lastInboundText: vi.fn() }));
vi.mock("./sms", () => ({ hasActiveSmsConversation: vi.fn() }));
vi.mock("../../shared/ghl", () => ({ getGhlConfig: vi.fn(), getLocationTimezone: vi.fn(), addContactTags: vi.fn() }));

import { reopenForNextAttempt } from "./dial-pending";
import { nextSlotAfter } from "./cadence";

const CADENCE = { attemptsPerDay: 2, days: 4, recheckBeforeEachAttempt: true };
const TZ = "America/St_Johns";

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function setup(now: string, firstCall: string | null) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
  idx.loadIrisConfig.mockReturnValue({ outreachCadence: CADENCE, timezone: TZ });
  db.query.mockImplementation(async (sql: string) => (sql.includes("min(l.created_at)") ? [{ first_call: firstCall ? new Date(firstCall) : null }] : []));
}
const scheduledFor = () => {
  const update = db.query.mock.calls.find((c) => String(c[0]).includes("SET call_after"));
  return (update?.[1] as unknown[])[1] as Date;
};

describe("reopenForNextAttempt — day 1 is the day of the first call (Cody Kennie, 2026-10-18)", () => {
  // Cody's form came in at 11:47 PM St. John's on Saturday Oct 17 (02:17Z Oct 18); his first call was Sunday 10:00 AM.
  const CREATED = new Date("2026-10-18T02:18:04Z");

  it("after the first call, the next attempt is that afternoon's 2pm slot — not five minutes later", async () => {
    setup("2026-10-18T12:30:20Z", "2026-10-18T12:30:01Z");
    await reopenForNextAttempt(103, "3-percent-east-coast", 1, CREATED);
    expect(scheduledFor().toISOString()).toBe("2026-10-18T16:30:00.000Z"); // Sun 2:00 PM NL
  });

  it("and the one after that is the next morning's 10am", async () => {
    setup("2026-10-18T16:30:20Z", "2026-10-18T12:30:01Z");
    await reopenForNextAttempt(103, "3-percent-east-coast", 2, CREATED);
    expect(scheduledFor().toISOString()).toBe("2026-10-19T12:30:00.000Z"); // Mon 10:00 AM NL
  });

  it("a slot that's already behind us waits for the next real slot, at least an hour out — never now + 5 minutes", async () => {
    // First call was three days ago, so attempt 2's own slot is long past.
    setup("2026-10-18T12:30:20Z", "2026-10-15T12:30:01Z");
    await reopenForNextAttempt(103, "3-percent-east-coast", 1, new Date("2026-10-15T02:00:00Z"));
    expect(scheduledFor().toISOString()).toBe("2026-10-18T16:30:00.000Z"); // today's 2pm, not 12:35Z
  });

  it("falls back to the row's created time when no call is on record", async () => {
    setup("2026-10-18T12:30:20Z", null);
    await reopenForNextAttempt(103, "3-percent-east-coast", 1, new Date("2026-10-18T12:00:00Z"));
    expect(scheduledFor().toISOString()).toBe("2026-10-18T16:30:00.000Z");
  });
});

describe("nextSlotAfter", () => {
  it("picks the next 10am/2pm slot at or after the given moment, in the client's timezone", () => {
    expect(nextSlotAfter(CADENCE, TZ, new Date("2026-10-18T13:30:00Z")).toISOString()).toBe("2026-10-18T16:30:00.000Z"); // 11:00 AM NL -> 2 PM
    expect(nextSlotAfter(CADENCE, TZ, new Date("2026-10-18T17:00:00Z")).toISOString()).toBe("2026-10-19T12:30:00.000Z"); // 2:30 PM NL -> tomorrow 10 AM
    expect(nextSlotAfter(CADENCE, TZ, new Date("2026-10-18T06:00:00Z")).toISOString()).toBe("2026-10-18T12:30:00.000Z"); // 3:30 AM NL -> 10 AM
  });
});
