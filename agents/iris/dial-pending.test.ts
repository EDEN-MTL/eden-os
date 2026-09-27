import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../shared/db", () => db);

const scout = vi.hoisted(() => ({ recheckFirstTouch: vi.fn(async () => true), refreshLead: vi.fn() }));
vi.mock("../scout", () => scout);

const irisIndex = vi.hoisted(() => ({ loadIrisConfig: vi.fn(), loadClientBranding: vi.fn() }));
vi.mock("./index", () => irisIndex);

vi.mock("./scripts", () => ({ buildLeadQualificationPrompt: vi.fn(() => "prompt"), extractFirstName: vi.fn((n: string) => n) }));

const calling = vi.hoisted(() => ({ placeCall: vi.fn(async () => ({ id: "call-1" })), CallingDisabledError: class CallingDisabledError extends Error {} }));
vi.mock("./calling", () => calling);

vi.mock("./cadence", () => ({
  decideNextAttempt: vi.fn(),
  nextAttemptTime: vi.fn(),
  clampToLegalCallingWindow: vi.fn((d: Date) => d),
}));

vi.mock("./qualification", () => ({ transferNumberForIntent: vi.fn(() => undefined), callbackCalendarForIntent: vi.fn(() => undefined) }));

const textSignals = vi.hoisted(() => ({
  classifyInboundText: vi.fn(async () => ({ type: "none" })),
  lastInboundText: vi.fn(),
}));
vi.mock("./text-signals", () => textSignals);

const smsModule = vi.hoisted(() => ({ hasActiveSmsConversation: vi.fn(async () => false) }));
vi.mock("./sms", () => smsModule);

const ghl = vi.hoisted(() => ({
  getGhlConfig: vi.fn(async () => ({ locationId: "loc-1", apiKey: "key-1" })),
  getLocationTimezone: vi.fn(async () => "America/St_Johns"),
  addContactTags: vi.fn(async () => ({})),
}));
vi.mock("../../shared/ghl", () => ghl);

import { runDialPendingCalls } from "./dial-pending";

const LEAD = {
  contactId: "contact-1",
  name: "Catherine Nonsense",
  email: null,
  phone: "+17091234567",
  propertyInterest: null,
  bedrooms: null,
  workingWithRealtor: null,
  budget: null,
  timeline: null,
  preApproved: null,
  financing: null,
  sources: { financing: null, timeline: null, budget: null },
  leadSource: "Facebook",
  intent: "buyer",
};

const DUE_ROW = {
  id: 42,
  client_id: "3-percent-east-coast",
  contact_id: "contact-1",
  lead: LEAD,
  attempts_made: 1,
  created_at: new Date("2026-09-20T12:00:00.000Z"),
  is_explicit_callback: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  db.query.mockImplementation(async (sql: string) => {
    if (sql.includes("WHERE status = 'pending' AND call_after <= now()")) return [DUE_ROW];
    return [];
  });
  scout.recheckFirstTouch.mockResolvedValue(true);
  irisIndex.loadIrisConfig.mockReturnValue({
    questions: ["q1"],
    hotScoreThreshold: 75,
    warmScoreThreshold: 40,
    calendars: { buyer: "cal-1", seller: "cal-2" },
    transferNumbers: { buyer: "+15551110000", seller: "+15551110001" },
    callbackNotesFieldKey: "contact.isa_notes",
    timezone: "America/St_Johns",
    writeFields: { timeline: "x", budget: "x", propertyInterest: "x", preApproved: "x" },
    outreachCadence: { attemptsPerDay: 2, days: 4, recheckBeforeEachAttempt: true },
  });
  irisIndex.loadClientBranding.mockReturnValue({ brandName: "3 Percent East Coast", city: "St. John's" });
  ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
  ghl.getLocationTimezone.mockResolvedValue("America/St_Johns");
  textSignals.classifyInboundText.mockResolvedValue({ type: "none" });
});

describe("resolveOne — pause-while-texting gate (Mark's confirmed design, 2026-09-23)", () => {
  it("pauses the call (reschedules a recheck, does not dial) when the lead's last text was recent AND a real SMS qualification exchange is active", async () => {
    textSignals.lastInboundText.mockResolvedValue({
      text: "still deciding",
      precedingOutbound: null,
      dateAdded: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
    });
    smsModule.hasActiveSmsConversation.mockResolvedValue(true);

    await runDialPendingCalls();

    expect(calling.placeCall).not.toHaveBeenCalled();
    const updateCall = db.query.mock.calls.find((c) => String(c[0]).includes("texting with lead — call paused"));
    expect(updateCall).toBeDefined();
    expect(updateCall?.[1][0]).toBe(42);
  });

  it("does NOT pause — and proceeds to place the call — when the lead texted recently but there's no active two-way SMS exchange (just a one-off inbound read)", async () => {
    textSignals.lastInboundText.mockResolvedValue({
      text: "ok",
      precedingOutbound: null,
      dateAdded: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    smsModule.hasActiveSmsConversation.mockResolvedValue(false);

    await runDialPendingCalls();

    expect(calling.placeCall).toHaveBeenCalledTimes(1);
  });

  it("does NOT pause when the lead's last text is older than the 24h cold-off window, even with an active conversation on record", async () => {
    textSignals.lastInboundText.mockResolvedValue({
      text: "still deciding",
      precedingOutbound: null,
      dateAdded: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(), // 30h ago
    });
    smsModule.hasActiveSmsConversation.mockResolvedValue(true);

    await runDialPendingCalls();

    expect(calling.placeCall).toHaveBeenCalledTimes(1);
  });
});

describe("resolveOne — Ember handoffs and text-agreed calls (Mark, 2026-09-24)", () => {
  const scripts = () => import("./scripts");
  const withRow = (over: any) =>
    db.query.mockImplementation(async (sql: string) =>
      sql.includes("WHERE status = 'pending' AND call_after <= now()") ? [{ ...DUE_ROW, ...over }] : []
    );

  it("calls an Ember-handed old lead even though they're tagged live-transferred from months ago", async () => {
    withRow({ is_explicit_callback: true, source: "ember", sms_scheduled: false });
    scout.refreshLead.mockResolvedValue({ ...LEAD, qualified: true });
    textSignals.lastInboundText.mockResolvedValue(null);

    await runDialPendingCalls();

    expect(calling.placeCall).toHaveBeenCalledTimes(1);
  });

  it("still skips an already-qualified NORMAL callback — the bypass is Ember-only", async () => {
    withRow({ is_explicit_callback: true, source: null, sms_scheduled: false });
    scout.refreshLead.mockResolvedValue({ ...LEAD, qualified: true });

    await runDialPendingCalls();

    expect(calling.placeCall).not.toHaveBeenCalled();
  });

  it("does not pause a call the lead just agreed to by text", async () => {
    withRow({ is_explicit_callback: true, source: "ember", sms_scheduled: true });
    scout.refreshLead.mockResolvedValue({ ...LEAD, qualified: false });
    textSignals.lastInboundText.mockResolvedValue({ text: "yes call me now", precedingOutbound: null, dateAdded: new Date().toISOString() });
    smsModule.hasActiveSmsConversation.mockResolvedValue(true);

    await runDialPendingCalls();

    expect(calling.placeCall).toHaveBeenCalledTimes(1);
  });

  it("opens with the text-conversation line for Ember and text-agreed calls, the form line otherwise", async () => {
    const { buildLeadQualificationPrompt } = await scripts();
    withRow({ is_explicit_callback: true, source: "ember", sms_scheduled: false });
    scout.refreshLead.mockResolvedValue({ ...LEAD, qualified: false });
    textSignals.lastInboundText.mockResolvedValue(null);
    await runDialPendingCalls();
    expect(vi.mocked(buildLeadQualificationPrompt).mock.calls.at(-1)?.[7]).toBe("text");

    vi.clearAllMocks();
    withRow({ source: null, sms_scheduled: false });
    await runDialPendingCalls();
    expect(vi.mocked(buildLeadQualificationPrompt).mock.calls.at(-1)?.[7]).toBe("form");
  });
});
