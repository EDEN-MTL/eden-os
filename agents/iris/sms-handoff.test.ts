import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/claude", () => ({ chatWithTools: vi.fn() }));
vi.mock("../../shared/slack", () => ({ sendMessage: vi.fn(async () => ({})) }));
vi.mock("../../shared/conversation-memory", () => ({
  loadHistory: vi.fn(async () => []),
  appendHistory: vi.fn(async () => {}),
}));
vi.mock("./text-signals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./text-signals")>();
  return { ...actual, classifyInboundText: vi.fn(async () => ({ type: "none" })) };
});

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../shared/db", () => db);

const ghl = vi.hoisted(() => ({
  getGhlConfig: vi.fn(),
  getLocationTimezone: vi.fn(),
  getCustomFieldDefs: vi.fn(),
  updateContact: vi.fn(),
  addContactTags: vi.fn(),
  sendSMS: vi.fn(),
}));
vi.mock("../../shared/ghl", () => ghl);

const vapiTools = vi.hoisted(() => ({ handleCheckAvailability: vi.fn(), handleBookAppointment: vi.fn() }));
vi.mock("../../webhooks/vapi-tools", () => vapiTools);

vi.mock("./human-touch", () => ({ checkHumanTouch: vi.fn(async () => ({ status: "none" })), DEFAULT_HUMAN_HANDS_OFF_DAYS: 7 }));
vi.mock("../ember/store", () => ({ lastEmberTouchText: vi.fn(async () => "Hi Catherine, still on the hunt? Reply STOP to opt out.") }));

const readFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, readFileSync: readFileSyncMock };
});

import { chatWithTools } from "../../shared/claude";
import { sendMessage } from "../../shared/slack";
import { appendHistory, loadHistory } from "../../shared/conversation-memory";
import { classifyInboundText } from "./text-signals";
const NO_WAIT = { wait: async () => {} };
import { irisHandleInboundSms, hasActiveSmsConversation, humanReplyDelayMs } from "./sms";

function toolUseBlock(id: string, name: string, input: any) {
  return { type: "tool_use" as const, id, name, input };
}
function endTurn(text: string) {
  return { content: [{ type: "text" as const, text, citations: null }], stop_reason: "end_turn" } as any;
}
function toolTurn(...blocks: ReturnType<typeof toolUseBlock>[]) {
  return { content: blocks, stop_reason: "tool_use" } as any;
}

const CLIENT_CONFIG = JSON.stringify({
  clientName: "3 Percent East Coast",
  market: { city: "St. John's" },
  iris: {
    qualificationQuestions: ["Are you looking to buy or sell?", "What area?", "What type of home?", "Timeline?", "Budget?"],
    writeFields: { timeline: "contact.lf_timeframe", budget: "contact.lf_budget", propertyInterest: "contact.lf_proprety", preApproved: "contact.are_you_pre_approuved" },
    outreachCadence: { attemptsPerDay: 2, days: 4, recheckBeforeEachAttempt: true },
    transferNumbers: { buyer: "+15551110000", seller: "+15551110001" },
    callbacks: { notesFieldKey: "contact.isa_notes" },
    timezone: "America/St_Johns",
    warmScoreThreshold: 40,
  },
  scout: { calendars: { buyer: "cal-1", seller: "cal-2" } },
});

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


const HANDOFF_CONFIG = JSON.stringify({
  ...JSON.parse(CLIENT_CONFIG),
  iris: { ...JSON.parse(CLIENT_CONFIG).iris, sms: { callHandoff: true }, callbacks: { notesFieldKey: "contact.isa_notes", calendarIds: { buyer: "cal-buy", seller: "cal-sell" } } },
});

beforeEach(() => {
  vi.clearAllMocks();
  readFileSyncMock.mockReturnValue(HANDOFF_CONFIG);
  ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
  ghl.getLocationTimezone.mockResolvedValue("America/St_Johns");
  ghl.getCustomFieldDefs.mockResolvedValue([{ fieldKey: "contact.isa_notes", id: "field-notes-1" }]);
  ghl.updateContact.mockResolvedValue({});
  ghl.addContactTags.mockResolvedValue({});
  ghl.sendSMS.mockResolvedValue({});
  db.query.mockResolvedValue([]);
});

const row = (over: any = {}) => [{ client_id: "eden-sub-account-one", contact_id: "contact-1", lead: LEAD, status: "pending", source: null, ...over }];
const toolNames = () => (vi.mocked(chatWithTools).mock.calls[0][2] as any[]).map((t) => t.name);
const systemPrompt = () => vi.mocked(chatWithTools).mock.calls[0][0] as string;
const STRONG = { intent: "buyer", area: "Downtown", propertyDetails: "3 bed detached", timeline: "within 1 month", budget: "500k", financing: "pre-approved" };

describe("text-qualification ending — call handoff", () => {
  it("is not offered when the client hasn't turned callHandoff on (3% today)", async () => {
    readFileSyncMock.mockReturnValue(CLIENT_CONFIG);
    db.query.mockResolvedValueOnce(row());
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("Great, what area?"));
    await irisHandleInboundSms("contact-1", "yes still looking", NO_WAIT);
    expect(toolNames()).not.toContain("schedule_transfer_call");
    expect(systemPrompt()).toContain("request_human_followup once");
  });

  it("queues a live-transfer call when the lead qualifies", async () => {
    db.query.mockResolvedValueOnce(row());
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce(toolTurn(toolUseBlock("t1", "schedule_transfer_call", { ...STRONG, when: "now" })))
      .mockResolvedValueOnce(endTurn("Perfect — expect a call from us in a couple of minutes!"));

    await irisHandleInboundSms("contact-1", "now works", NO_WAIT);

    expect(toolNames()).toContain("schedule_transfer_call");
    const update = db.query.mock.calls.find((c) => String(c[0]).includes("sms_scheduled = true"));
    expect(update).toBeDefined();
    expect(update![1][0]).toBe("eden-sub-account-one");
    const callAt = (update![1][2] as Date).getTime();
    expect(callAt).toBeGreaterThan(Date.now());
    expect(sendMessage).toHaveBeenCalledWith("iris", expect.objectContaining({ text: expect.stringContaining("live transfer") }));
    expect(ghl.sendSMS).toHaveBeenCalledWith("contact-1", "Perfect — expect a call from us in a couple of minutes!", "loc-1", "key-1");
  });

  /**
   * Samir Benslimane, 2026-10-15: took every question by text (seller, $450K, address given) but
   * scored 25 against a bar of 40, so the call was refused and he got a vague "someone will
   * reach out". Anyone Iris takes through the questions is qualified and gets the call.
   */
  it("queues the call even when the numeric score is low — a lead who answered everything is qualified", async () => {
    db.query.mockResolvedValueOnce(row());
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce(toolTurn(toolUseBlock("t1", "schedule_transfer_call", { intent: "seller", area: "Hussey Drive", propertyDetails: "house with apartments", timeline: null, budget: "$450000", financing: null, when: "now" })))
      .mockResolvedValueOnce(endTurn("Thanks Samir — I'll give you a call shortly to connect you with one of our agents."));

    await irisHandleInboundSms("contact-1", "Take care", NO_WAIT);

    expect(db.query.mock.calls.find((c) => String(c[0]).includes("sms_scheduled = true"))).toBeDefined();
    const toolResult = (vi.mocked(chatWithTools).mock.calls[1][1] as any[]).at(-1).content[0].content as string;
    expect(toolResult).toMatch(/^Scheduled/);
    expect(toolResult).toContain("connect them with one of our agents");
    expect(toolResult).toMatch(/not a good time or they'd rather another time/);
  });

  it("tells the model to ask when they're free, book a named time, and call now only for 'now'", async () => {
    db.query.mockResolvedValueOnce(row());
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("What area?"));
    await irisHandleInboundSms("contact-1", "hi", NO_WAIT);
    const prompt = systemPrompt();
    expect(prompt).toContain("when are they available for a quick call with one of our agents");
    expect(prompt).toContain("call check_availability with that moment");
    expect(prompt).toContain("call book_appointment with the isoTime it gave, copied verbatim");
    expect(prompt).toContain("schedule_transfer_call with when = \"now\"");
    expect(prompt).toMatch(/Right now it is .*America\/St_Johns/);
    expect(prompt).toContain("Never say or imply an appointment is booked until book_appointment has confirmed it");
    expect(prompt).toContain("no asterisks, bold or other formatting");
  });

  it("rejects an unreadable time instead of guessing", async () => {
    db.query.mockResolvedValueOnce(row());
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce(toolTurn(toolUseBlock("t1", "schedule_transfer_call", { ...STRONG, when: "after lunch-ish" })))
      .mockResolvedValueOnce(endTurn("What time works best?"));
    await irisHandleInboundSms("contact-1", "after lunch-ish", NO_WAIT);
    expect(db.query.mock.calls.find((c) => String(c[0]).includes("sms_scheduled = true"))).toBeUndefined();
  });
});

describe("a lead Ember reactivated (source 'ember')", () => {
  it("is Ember's to text, not Iris's — Iris returns false and sends nothing (Mark, 2026-10-06)", async () => {
    db.query.mockResolvedValueOnce(row({ source: "ember" }));
    expect(await irisHandleInboundSms("contact-1", "yes actually", NO_WAIT)).toBe(false);
    expect(chatWithTools).not.toHaveBeenCalled();
    expect(ghl.sendSMS).not.toHaveBeenCalled();
  });

  it("a normal new lead keeps the existing wording", async () => {
    db.query.mockResolvedValueOnce(row());
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("What area?"));
    await irisHandleInboundSms("contact-1", "hi", NO_WAIT);
    expect(systemPrompt()).not.toContain("OLDER lead");
  });
});

describe("humanReplyDelayMs — never reply instantly (Mark, 2026-09-25)", () => {
  const at = new Date("2026-09-25T15:00:00Z");
  it("waits at least 30s after the lead's text arrived, plus typing time and jitter", () => {
    expect(humanReplyDelayMs(at, "", at, () => 0)).toBe(30_000);
    expect(humanReplyDelayMs(at, "x".repeat(100), at, () => 0)).toBe(35_000);
    expect(humanReplyDelayMs(at, "x".repeat(1000), at, () => 0)).toBe(45_000); // typing capped at 15s
    expect(humanReplyDelayMs(at, "", at, () => 0.99)).toBe(39_900);
  });
  it("counts time already passed — a reply picked up late doesn't wait twice", () => {
    expect(humanReplyDelayMs(at, "", new Date(at.getTime() + 20_000), () => 0)).toBe(10_000);
    expect(humanReplyDelayMs(at, "", new Date(at.getTime() + 120_000), () => 0)).toBe(0);
  });
  it("delays Iris's own new-lead replies too — Mark confirmed the delay is for every Iris text (dev 9967a94)", async () => {
    db.query.mockResolvedValueOnce(row());
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("Great, what area are you looking in?"));
    const waits: number[] = [];
    await irisHandleInboundSms("contact-1", "yes still looking", { wait: async (ms) => { waits.push(ms); } });
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(29_000);
  });

  it("actually pauses before the reply goes out", async () => {
    db.query.mockResolvedValueOnce(row());
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("Great, what area are you looking in?"));
    const waits: number[] = [];
    await irisHandleInboundSms("contact-1", "yes still looking", { wait: async (ms) => { waits.push(ms); } });
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(29_000);
    expect(ghl.sendSMS).toHaveBeenCalledTimes(1);
  });
});

describe("booking an appointment by text (Mark, 2026-10-15)", () => {
  const toolResultOf = (callIndex: number) => (vi.mocked(chatWithTools).mock.calls[callIndex][1] as any[]).at(-1).content[0].content as string;

  beforeEach(() => {
    vapiTools.handleCheckAvailability.mockReset();
    vapiTools.handleBookAppointment.mockReset();
  });

  it("offers check_availability and book_appointment alongside the call tools", async () => {
    db.query.mockResolvedValueOnce(row());
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("What area?"));
    await irisHandleInboundSms("contact-1", "hi", NO_WAIT);
    expect(toolNames()).toEqual(expect.arrayContaining(["check_availability", "book_appointment", "schedule_transfer_call"]));
  });

  it("is not offered when the client hasn't turned the handoff on", async () => {
    readFileSyncMock.mockReturnValue(CLIENT_CONFIG);
    db.query.mockResolvedValueOnce(row());
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("What area?"));
    await irisHandleInboundSms("contact-1", "hi", NO_WAIT);
    expect(toolNames()).not.toContain("check_availability");
    expect(toolNames()).not.toContain("book_appointment");
  });

  it("checks the real calendar for the lead's intent, with the time the model worked out", async () => {
    db.query.mockResolvedValueOnce(row());
    vapiTools.handleCheckAvailability.mockResolvedValue('That time is available. To lock it in, call book_appointment with isoTime: "2026-10-16T17:30:00.000Z"');
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce(toolTurn(toolUseBlock("t1", "check_availability", { intent: "seller", requestedTime: "2026-10-16T15:00:00" })))
      .mockResolvedValueOnce(endTurn("Let me lock that in."));

    await irisHandleInboundSms("contact-1", "Tomorrow at 3 works", NO_WAIT);

    expect(vapiTools.handleCheckAvailability).toHaveBeenCalledWith("eden-sub-account-one", "cal-sell", "2026-10-16T15:00:00");
    expect(toolResultOf(1)).toContain("That time is available");
  });

  it("books the real appointment, closes the lead's call queue, and tells the model to confirm only that time", async () => {
    db.query.mockResolvedValueOnce(row());
    vapiTools.handleBookAppointment.mockResolvedValue({
      success: true,
      result: 'Booked for Friday, October 16 at 3:00 PM. appointmentId: "abc" — if the lead wants to change this specific booking later...',
    });
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce(toolTurn(toolUseBlock("t1", "book_appointment", { intent: "seller", isoTime: "2026-10-16T17:30:00.000Z", notes: "Seller | Hussey Drive | $450K" })))
      .mockResolvedValueOnce(endTurn("You're all set for Friday, October 16 at 3:00 PM — one of our agents will give you a call then."));

    await irisHandleInboundSms("contact-1", "Yes 3 is great", NO_WAIT);

    expect(vapiTools.handleBookAppointment).toHaveBeenCalledWith(
      "eden-sub-account-one", "contact-1", "cal-sell", "seller", "2026-10-16T17:30:00.000Z", "Seller | Hussey Drive | $450K", undefined, undefined, "Iris (by text)"
    );
    expect(db.query.mock.calls.find((c) => String(c[0]).includes("UPDATE iris_pending_calls SET status = 'skipped'") && (c[1] as string[]).includes("qualified and booked by text — appointment made"))).toBeDefined();
    const result = toolResultOf(1);
    expect(result).toContain("Booked for Friday, October 16 at 3:00 PM");
    expect(result).toContain("one of our agents will give you a call then");
    expect(result).not.toContain("appointmentId");
    expect(ghl.sendSMS).toHaveBeenCalledWith("contact-1", expect.stringContaining("all set for Friday"), "loc-1", "key-1");
  });

  it("does not close the queue or claim a booking when the slot is gone", async () => {
    db.query.mockResolvedValueOnce(row());
    vapiTools.handleBookAppointment.mockResolvedValue({ success: false, result: "That exact time is no longer available — it may have just been taken. Do not claim it's booked." });
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce(toolTurn(toolUseBlock("t1", "book_appointment", { intent: "buyer", isoTime: "2026-10-16T17:30:00.000Z" })))
      .mockResolvedValueOnce(endTurn("That time just went — would another work?"));

    await irisHandleInboundSms("contact-1", "3 is good", NO_WAIT);

    expect(toolResultOf(1)).toContain("no longer available");
    expect(db.query.mock.calls.find((c) => (c[1] as string[] | undefined)?.includes("qualified and booked by text — appointment made"))).toBeUndefined();
  });

  it("with no calendar for the lead's kind, says so and sends the model to a human follow-up", async () => {
    db.query.mockResolvedValueOnce(row());
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce(toolTurn(toolUseBlock("t1", "check_availability", { intent: "unknown", requestedTime: "2026-10-16T15:00:00" })))
      .mockResolvedValueOnce(endTurn("Someone will be in touch."));
    await irisHandleInboundSms("contact-1", "tomorrow at 3", NO_WAIT);
    expect(vapiTools.handleCheckAvailability).not.toHaveBeenCalled();
    expect(toolResultOf(1)).toContain("request_human_followup");
  });

  it("a time named mid-conversation is booked by the model, not also queued as an Iris callback", async () => {
    vi.mocked(classifyInboundText).mockResolvedValueOnce({ type: "schedule_for", when: new Date(Date.now() + 86_400_000) });
    vi.mocked(loadHistory).mockResolvedValueOnce([{ role: "user", content: "hi" }, { role: "assistant", content: "When are you free for a quick call?" }] as any);
    db.query.mockResolvedValueOnce(row());
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("Let me check."));

    await irisHandleInboundSms("contact-1", "tomorrow at 3", NO_WAIT);

    expect(db.query.mock.calls.find((c) => String(c[0]).includes("lead requested this time via text"))).toBeUndefined();
  });

  it("but the first reply to the initial outreach text still schedules the callback it always did", async () => {
    vi.mocked(classifyInboundText).mockResolvedValueOnce({ type: "schedule_for", when: new Date(Date.now() + 86_400_000) });
    db.query.mockResolvedValueOnce(row());

    await irisHandleInboundSms("contact-1", "tomorrow at 3", NO_WAIT);

    expect(db.query.mock.calls.find((c) => String(c[0]).includes("lead requested this time via text"))).toBeDefined();
  });
});
