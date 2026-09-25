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

const readFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, readFileSync: readFileSyncMock };
});

import { chatWithTools } from "../../shared/claude";
import { sendMessage } from "../../shared/slack";
import { appendHistory, loadHistory } from "../../shared/conversation-memory";
import { classifyInboundText } from "./text-signals";
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

beforeEach(() => {
  vi.clearAllMocks();
  readFileSyncMock.mockReturnValue(CLIENT_CONFIG);
  ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
  ghl.getLocationTimezone.mockResolvedValue("America/St_Johns");
  ghl.getCustomFieldDefs.mockResolvedValue([{ fieldKey: "contact.isa_notes", id: "field-notes-1" }]);
  ghl.updateContact.mockResolvedValue({});
  ghl.addContactTags.mockResolvedValue({});
  ghl.sendSMS.mockResolvedValue({});
});

describe("irisHandleInboundSms — not Iris's contact", () => {
  it("returns false and does nothing when the contact has no iris_pending_calls row at all", async () => {
    db.query.mockResolvedValue([]);
    const handled = await irisHandleInboundSms("stranger-contact", "hello");
    expect(handled).toBe(false);
    expect(chatWithTools).not.toHaveBeenCalled();
    expect(ghl.sendSMS).not.toHaveBeenCalled();
  });

  it("returns false when the row exists but is already resolved (not 'pending')", async () => {
    db.query.mockResolvedValue([{ client_id: "3-percent-east-coast", contact_id: "contact-1", lead: LEAD, status: "placed" }]);
    const handled = await irisHandleInboundSms("contact-1", "hello");
    expect(handled).toBe(false);
    expect(chatWithTools).not.toHaveBeenCalled();
  });
});

describe("irisHandleInboundSms — opt-out", () => {
  it("tags 'do not call', ends the sequence, and sends an acknowledgment without ever starting the qualification loop", async () => {
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast", contact_id: "contact-1", lead: LEAD, status: "pending" }]);
    vi.mocked(classifyInboundText).mockResolvedValueOnce({ type: "opt_out" });

    const handled = await irisHandleInboundSms("contact-1", "stop texting me", { wait: async () => {} });

    expect(handled).toBe(true);
    expect(chatWithTools).not.toHaveBeenCalled();
    expect(ghl.addContactTags).toHaveBeenCalledWith("contact-1", ["do not call"], "loc-1", "key-1");
    expect(ghl.sendSMS).toHaveBeenCalledWith("contact-1", expect.stringMatching(/won't reach out again/i), "loc-1", "key-1");

    const updateCall = db.query.mock.calls.find((c) => String(c[0]).includes("UPDATE iris_pending_calls"));
    expect(updateCall?.[1]).toEqual(["3-percent-east-coast", "contact-1", "lead opted out via text — cadence stopped"]);
  });
});

/**
 * Real mistake found live, 2026-09-25 (Kaitlyn Sheppard): dial-pending.ts's
 * pre-dial recheck already reads and acts on a lead's first reply to the
 * initial "you'll get a call from Iris — what time works?" text (scheduling
 * the real callback via this same classifier). A bare "Yes!"/"After 4!"
 * isn't the start of a text qualification conversation — it's confirming a
 * callback time — but before this fix, irisHandleInboundSms had no
 * awareness of that signal at all and launched straight into "are you
 * looking to buy or sell?", ignoring what the lead actually said.
 */
describe("irisHandleInboundSms — schedule_for (confirming a callback time, not starting a text chat)", () => {
  it("acknowledges the callback time and stops — never starts the qualification loop — when this is the lead's first reply", async () => {
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast", contact_id: "contact-1", lead: LEAD, status: "pending" }]);
    vi.mocked(loadHistory).mockResolvedValueOnce([]);
    vi.mocked(classifyInboundText).mockResolvedValueOnce({ type: "schedule_for", when: new Date("2026-09-26T19:00:00.000Z") });

    const handled = await irisHandleInboundSms("contact-1", "After 4!", { wait: async () => {} });

    expect(handled).toBe(true);
    expect(chatWithTools).not.toHaveBeenCalled();
    expect(ghl.sendSMS).toHaveBeenCalledWith("contact-1", expect.stringMatching(/give you a call/i), "loc-1", "key-1");
    expect(appendHistory).toHaveBeenCalledWith("iris", "sms:3-percent-east-coast:contact-1", "user", "After 4!");
  });

  it("does NOT short-circuit a real ongoing qualification conversation — falls through to the normal loop when history already exists", async () => {
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast", contact_id: "contact-1", lead: LEAD, status: "pending" }]);
    vi.mocked(loadHistory).mockResolvedValueOnce([{ role: "assistant", content: "What area are you interested in?" }]);
    vi.mocked(classifyInboundText).mockResolvedValueOnce({ type: "schedule_for", when: new Date("2026-09-26T19:00:00.000Z") });
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("Got it, noted — and what area works for you?"));

    const handled = await irisHandleInboundSms("contact-1", "call me after 4 instead", { wait: async () => {} });

    expect(handled).toBe(true);
    expect(chatWithTools).toHaveBeenCalled();
    expect(ghl.sendSMS).toHaveBeenCalledWith("contact-1", "Got it, noted — and what area works for you?", "loc-1", "key-1");
  });
});

describe("irisHandleInboundSms — full qualification loop", () => {
  it("sends the model's plain-text reply as a real SMS and persists both sides of the exchange", async () => {
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast", contact_id: "contact-1", lead: LEAD, status: "pending" }]);
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("Great, and what area are you looking in?"));

    const handled = await irisHandleInboundSms("contact-1", "Looking to buy", { wait: async () => {} });

    expect(handled).toBe(true);
    expect(ghl.sendSMS).toHaveBeenCalledWith("contact-1", "Great, and what area are you looking in?", "loc-1", "key-1");
    expect(appendHistory).toHaveBeenCalledWith("iris", "sms:3-percent-east-coast:contact-1", "user", "Looking to buy");
    expect(appendHistory).toHaveBeenCalledWith("iris", "sms:3-percent-east-coast:contact-1", "assistant", "Great, and what area are you looking in?");
  });

  it("loads prior history under the sms: namespace, not the Slack channel: namespace", async () => {
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast", contact_id: "contact-1", lead: LEAD, status: "pending" }]);
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("Got it."));

    await irisHandleInboundSms("contact-1", "Buying", { wait: async () => {} });

    expect(loadHistory).toHaveBeenCalledWith("iris", "sms:3-percent-east-coast:contact-1");
  });

  it("save_qualification_notes writes a single structured note to the same field voice's save_isa_notes uses, then continues the loop", async () => {
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast", contact_id: "contact-1", lead: LEAD, status: "pending" }]);
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce(toolTurn(toolUseBlock("t1", "save_qualification_notes", { notes: "Buyer, area: downtown, budget 400k" })))
      .mockResolvedValueOnce(endTurn("Thanks! One of our team will reach out to book a time."));

    const handled = await irisHandleInboundSms("contact-1", "Downtown, around 400k", { wait: async () => {} });

    expect(handled).toBe(true);
    expect(ghl.updateContact).toHaveBeenCalledWith(
      "contact-1",
      { customFields: [{ id: "field-notes-1", value: "Buyer, area: downtown, budget 400k" }] },
      "loc-1",
      "key-1"
    );
    expect(ghl.sendSMS).toHaveBeenCalledWith("contact-1", "Thanks! One of our team will reach out to book a time.", "loc-1", "key-1");
  });

  it("request_human_followup tags the contact, alerts Slack, and ends the calling sequence — texting can't book or transfer", async () => {
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast", contact_id: "contact-1", lead: LEAD, status: "pending" }]);
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce(toolTurn(toolUseBlock("t1", "request_human_followup", { summary: "Catherine, buyer, downtown, 400k, ready to book" })))
      .mockResolvedValueOnce(endTurn("Thanks — someone from our team will reach out shortly to book a time!"));

    await irisHandleInboundSms("contact-1", "Sounds good", { wait: async () => {} });

    expect(ghl.addContactTags).toHaveBeenCalledWith("contact-1", ["iris sms qualified"], "loc-1", "key-1");
    expect(sendMessage).toHaveBeenCalledWith(
      "iris",
      expect.objectContaining({ text: expect.stringContaining("Catherine, buyer, downtown, 400k, ready to book") })
    );

    const updateCall = db.query.mock.calls.find((c) => String(c[0]).includes("UPDATE iris_pending_calls"));
    expect(updateCall?.[1]).toEqual(["3-percent-east-coast", "contact-1", "qualified via text — handed off for human follow-up"]);
  });
});

/**
 * Mark's instruction, 2026-09-25: never reply instantly — "so the lead
 * would not think they are chatting to an automation." Applies to every
 * reply, not a subset of leads.
 */
describe("humanReplyDelayMs", () => {
  it("is at least the 30s floor for an empty reply with no jitter", () => {
    const receivedAt = new Date("2026-09-25T12:00:00.000Z");
    const now = receivedAt; // no time elapsed yet
    expect(humanReplyDelayMs(receivedAt, "", now, () => 0)).toBe(30_000);
  });

  it("scales up with reply length, capped at 15s of added typing time", () => {
    const receivedAt = new Date("2026-09-25T12:00:00.000Z");
    const shortReply = "ok".repeat(1); // 2 chars
    const longReply = "x".repeat(500); // way past the cap
    const shortDelay = humanReplyDelayMs(receivedAt, shortReply, receivedAt, () => 0);
    const longDelay = humanReplyDelayMs(receivedAt, longReply, receivedAt, () => 0);
    expect(longDelay).toBeGreaterThan(shortDelay);
    expect(longDelay).toBe(30_000 + 15_000); // floor + capped typing time, no jitter
  });

  it("adds jitter so the same reply never waits the exact same amount twice", () => {
    const receivedAt = new Date("2026-09-25T12:00:00.000Z");
    expect(humanReplyDelayMs(receivedAt, "", receivedAt, () => 0)).toBe(30_000);
    expect(humanReplyDelayMs(receivedAt, "", receivedAt, () => 0.5)).toBe(35_000);
  });

  it("subtracts time already elapsed since the text arrived — never double-counts", () => {
    const receivedAt = new Date("2026-09-25T12:00:00.000Z");
    const now = new Date("2026-09-25T12:00:20.000Z"); // 20s already passed
    expect(humanReplyDelayMs(receivedAt, "", now, () => 0)).toBe(10_000);
  });

  it("never goes negative when more time has already passed than the target delay", () => {
    const receivedAt = new Date("2026-09-25T12:00:00.000Z");
    const now = new Date("2026-09-25T12:05:00.000Z"); // 5 minutes later
    expect(humanReplyDelayMs(receivedAt, "", now, () => 0)).toBe(0);
  });
});

describe("irisHandleInboundSms — reply delay", () => {
  it("waits before sending, computed from the injected receivedAt, not from whenever the function happens to run", async () => {
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast", contact_id: "contact-1", lead: LEAD, status: "pending" }]);
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("Great, what area?"));

    const waited: number[] = [];
    const receivedAt = new Date(Date.now() - 5_000); // arrived 5s ago
    await irisHandleInboundSms("contact-1", "Looking to buy", {
      receivedAt,
      wait: async (ms) => {
        waited.push(ms);
      },
    });

    expect(waited).toHaveLength(1);
    expect(waited[0]).toBeGreaterThan(0);
    expect(ghl.sendSMS).toHaveBeenCalledWith("contact-1", "Great, what area?", "loc-1", "key-1");
  });

  it("waits before the opt-out acknowledgment too, not just the qualification loop", async () => {
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast", contact_id: "contact-1", lead: LEAD, status: "pending" }]);
    vi.mocked(classifyInboundText).mockResolvedValueOnce({ type: "opt_out" });

    const waited: number[] = [];
    await irisHandleInboundSms("contact-1", "stop texting me", {
      wait: async (ms) => {
        waited.push(ms);
      },
    });

    expect(waited).toHaveLength(1);
  });
});

describe("hasActiveSmsConversation", () => {
  it("is true once there's any history under this contact's sms: key", async () => {
    vi.mocked(loadHistory).mockResolvedValueOnce([{ role: "user", content: "hi" }]);
    expect(await hasActiveSmsConversation("3-percent-east-coast", "contact-1")).toBe(true);
  });

  it("is false with no history yet", async () => {
    vi.mocked(loadHistory).mockResolvedValueOnce([]);
    expect(await hasActiveSmsConversation("3-percent-east-coast", "contact-1")).toBe(false);
  });
});
