import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn(async (..._a: unknown[]): Promise<any[]> => []) }));
vi.mock("../../shared/db", () => db);
const scout = vi.hoisted(() => ({ recheckFirstTouch: vi.fn(), refreshLead: vi.fn() }));
vi.mock("../scout", () => scout);
const idx = vi.hoisted(() => ({ loadIrisConfig: vi.fn(), loadClientBranding: vi.fn() }));
vi.mock("./index", () => idx);
vi.mock("./scripts", () => ({ buildLeadQualificationPrompt: vi.fn(() => "prompt"), extractFirstName: vi.fn(() => "Sabrina") }));
const calling = vi.hoisted(() => ({ placeCall: vi.fn(async () => ({ id: "call-1" })) }));
vi.mock("./calling", () => ({ ...calling, CallingDisabledError: class extends Error {} }));
vi.mock("./qualification", () => ({ transferNumberForIntent: vi.fn(), callbackCalendarForIntent: vi.fn() }));
vi.mock("./text-signals", () => ({ classifyInboundText: vi.fn(async () => ({ type: "none" })), lastInboundText: vi.fn(async () => null) }));
vi.mock("./sms", () => ({ hasActiveSmsConversation: vi.fn(async () => false) }));
const touch = vi.hoisted(() => ({ checkHumanTouch: vi.fn(), DEFAULT_HUMAN_HANDS_OFF_DAYS: 7 }));
vi.mock("./human-touch", () => touch);
const slack = vi.hoisted(() => ({ sendMessage: vi.fn(async () => ({})) }));
vi.mock("../../shared/slack", () => slack);
vi.mock("../../shared/ghl", () => ({ getGhlConfig: vi.fn(async () => ({ locationId: "loc", apiKey: "k" })), getLocationTimezone: vi.fn(async () => "America/St_Johns"), addContactTags: vi.fn() }));

import { runDialPendingCalls } from "./dial-pending";

const lead = { name: "Sabrina Marie", phone: "+17095550100", intent: "buyer", qualified: false };
const row = (over: Record<string, unknown> = {}) => ({
  id: 9,
  client_id: "3-percent-east-coast",
  contact_id: "contact-sabrina",
  lead,
  attempts_made: 3,
  created_at: new Date("2026-10-16T18:55:00.000Z"),
  is_explicit_callback: true,
  source: null,
  sms_scheduled: false,
  human_requested: false,
  ...over,
});

beforeEach(() => {
  idx.loadIrisConfig.mockReturnValue({ timezone: "America/St_Johns", humanTextBlocksCalls: true, humanHandsOffDays: 7, outreachCadence: { attemptsPerDay: 2, days: 4, recheckBeforeEachAttempt: true } });
  idx.loadClientBranding.mockReturnValue({ brandName: "3% Realty", city: "St. John's" });
  scout.refreshLead.mockResolvedValue(lead);
  db.query.mockImplementation(async () => []);
});
afterEach(() => vi.clearAllMocks());

function dueRows(r: unknown) {
  db.query.mockImplementation(async (...args: unknown[]) => (/FROM iris_pending_calls/.test(String(args[0])) && /call_after <= now/.test(String(args[0])) ? [r] : []));
}

describe("a due call to a lead a teammate is talking to", () => {
  it("is not placed: the row is closed and the team is told (Sabrina Marie, 2026-10-21)", async () => {
    dueRows(row());
    touch.checkHumanTouch.mockResolvedValue({ status: "human", kind: "text", at: "2026-10-20T18:50:00.000Z", userId: "jacob" });
    await runDialPendingCalls();
    expect(calling.placeCall).not.toHaveBeenCalled();
    expect(db.query.mock.calls.some((c) => /SET status = \$2, resolution_reason = \$3/.test(String(c[0])) && (c[1] as unknown[])[1] === "skipped")).toBe(true);
    expect(slack.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("is left due and retried when the thread cannot be read", async () => {
    dueRows(row());
    touch.checkHumanTouch.mockResolvedValue({ status: "unknown" });
    await runDialPendingCalls();
    expect(calling.placeCall).not.toHaveBeenCalled();
    expect(db.query.mock.calls.some((c) => /SET status = \$2/.test(String(c[0])))).toBe(false);
  });

  it("goes ahead when a teammate asked for the call in Slack", async () => {
    dueRows(row({ human_requested: true }));
    touch.checkHumanTouch.mockResolvedValue({ status: "human", kind: "text", at: "x", userId: "jacob" });
    await runDialPendingCalls();
    expect(touch.checkHumanTouch).not.toHaveBeenCalled();
    expect(calling.placeCall).toHaveBeenCalledTimes(1);
  });

  it("goes ahead for a cold-lead sweep Mark lined up by hand", async () => {
    dueRows(row({ source: "sweep" }));
    touch.checkHumanTouch.mockResolvedValue({ status: "human", kind: "text", at: "x", userId: "jacob" });
    await runDialPendingCalls();
    expect(calling.placeCall).toHaveBeenCalledTimes(1);
  });

  it("goes ahead when nobody on the team has been in touch", async () => {
    dueRows(row());
    touch.checkHumanTouch.mockResolvedValue({ status: "none" });
    await runDialPendingCalls();
    expect(calling.placeCall).toHaveBeenCalledTimes(1);
  });
});
