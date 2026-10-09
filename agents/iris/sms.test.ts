import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/claude", () => ({ chatWithTools: vi.fn() }));
vi.mock("../../shared/slack", () => ({ sendMessage: vi.fn(async () => ({})) }));
vi.mock("../../shared/conversation-memory", () => ({
  loadHistory: vi.fn(async () => []),
  appendHistory: vi.fn(async () => {}),
}));
const textSignals = vi.hoisted(() => ({
  classifyInboundText: vi.fn(async () => ({ type: "none" })),
  lastInboundText: vi.fn(async () => null),
  recentTexts: vi.fn(async () => []),
}));
vi.mock("./text-signals", () => textSignals);
vi.mock("./notes", () => ({ appendNoteToContact: vi.fn(async () => {}) }));
const humanTouch = vi.hoisted(() => ({ checkHumanTouch: vi.fn(async () => ({ status: "none" })), DEFAULT_HUMAN_HANDS_OFF_DAYS: 7 }));
vi.mock("./human-touch", () => humanTouch);

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
import { classifyInboundText, lastInboundText } from "./text-signals";
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
  humanTouch.checkHumanTouch.mockResolvedValue({ status: "none" });
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

/**
 * Real gap found live, 2026-09-25 (Kaitlyn Sheppard): a bare "Yes!" doesn't
 * name a specific time, so it isn't caught by the schedule_for short-circuit
 * above — it fell all the way through to the qualification loop with the
 * model having no idea it was answering "you'll get a call from Iris — what
 * time works?", not opting into a text conversation.
 */
describe("irisHandleInboundSms — gives the model real context for a lead's first-ever reply", () => {
  it("fetches the real preceding outreach text and passes it into the system prompt, only for a first reply", async () => {
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast", contact_id: "contact-1", lead: LEAD, status: "pending" }]);
    vi.mocked(loadHistory).mockResolvedValueOnce([]);
    vi.mocked(lastInboundText).mockResolvedValueOnce({
      text: "Yes!",
      precedingOutbound: "You'll get a quick call from Iris — what time works?",
      dateAdded: null,
    });
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("Sounds good, talk soon!"));

    await irisHandleInboundSms("contact-1", "Yes!", { wait: async () => {} });

    expect(lastInboundText).toHaveBeenCalledWith("contact-1", "loc-1", "key-1");
    const systemPrompt = vi.mocked(chatWithTools).mock.calls[0][0] as string;
    expect(systemPrompt).toContain("You'll get a quick call from Iris — what time works?");
  });

  it("does NOT fetch it again once a real text conversation is already underway", async () => {
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast", contact_id: "contact-1", lead: LEAD, status: "pending" }]);
    vi.mocked(loadHistory).mockResolvedValueOnce([{ role: "assistant", content: "What area are you interested in?" }]);
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("Got it, thanks!"));

    await irisHandleInboundSms("contact-1", "Downtown area", { wait: async () => {} });

    expect(lastInboundText).not.toHaveBeenCalled();
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

/**
 * Mark, 2026-10-08, from Dawnie Kearney's thread: three things went wrong at
 * once in a fast text exchange alongside the GHL automation.
 */
describe("irisHandleInboundSms — a callback time named by text is stored right away", () => {
  const ROW = { client_id: "3-percent-east-coast", contact_id: "contact-1", lead: LEAD, status: "pending" };
  const WHEN = new Date("2026-10-13T14:00:00.000Z");

  it("saves the time on the queue row — not left for the pre-dial check, which only reads the lead's NEWEST text", async () => {
    db.query.mockResolvedValueOnce([ROW]);
    vi.mocked(loadHistory).mockResolvedValueOnce([]);
    vi.mocked(classifyInboundText).mockResolvedValueOnce({ type: "schedule_for", when: WHEN });

    await irisHandleInboundSms("contact-1", "Tuesday would be a good time", { wait: async () => {} });

    const update = db.query.mock.calls.find((c) => String(c[0]).includes("lead requested this time via text"));
    expect(update?.[1]).toEqual(["3-percent-east-coast", "contact-1", WHEN]);
    expect(String(update?.[0])).toMatch(/is_explicit_callback = true/);
  });

  it("also stores it mid-conversation, when the reply isn't the short-circuited canned one", async () => {
    db.query.mockResolvedValueOnce([ROW]);
    vi.mocked(loadHistory).mockResolvedValueOnce([{ role: "assistant", content: "What area?" }]);
    vi.mocked(classifyInboundText).mockResolvedValueOnce({ type: "schedule_for", when: WHEN });
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("Noted!"));

    await irisHandleInboundSms("contact-1", "call me Tuesday", { wait: async () => {} });

    expect(db.query.mock.calls.some((c) => String(c[0]).includes("lead requested this time via text"))).toBe(true);
  });
});

describe("irisHandleInboundSms — answers one text at a time, in order", () => {
  const ROW = { client_id: "3-percent-east-coast", contact_id: "contact-1", lead: LEAD, status: "pending" };

  it("does not start on a lead's second text until the reply to the first has gone out", async () => {
    db.query.mockResolvedValue([ROW]);
    vi.mocked(loadHistory).mockResolvedValue([]);
    vi.mocked(chatWithTools).mockResolvedValue(endTurn("ok"));
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    ghl.sendSMS.mockImplementation(async () => {
      events.push("sent");
      return {};
    });

    const first = irisHandleInboundSms("contact-1", "first text", {
      wait: async () => {
        events.push("first waiting");
        await firstGate;
      },
    });
    const second = irisHandleInboundSms("contact-1", "second text", {
      wait: async () => {
        events.push("second waiting");
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(["first waiting"]); // the second hasn't even started

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first waiting", "sent", "second waiting", "sent"]);
  });

  it("keeps going for later texts even if an earlier one failed", async () => {
    db.query.mockRejectedValueOnce(new Error("db down")).mockResolvedValue([ROW]);
    vi.mocked(loadHistory).mockResolvedValue([]);
    vi.mocked(chatWithTools).mockResolvedValue(endTurn("ok"));

    const first = irisHandleInboundSms("contact-1", "first", { wait: async () => {} });
    const second = irisHandleInboundSms("contact-1", "second", { wait: async () => {} });

    await expect(first).rejects.toThrow("db down");
    await expect(second).resolves.toBe(true);
  });
});

describe("irisHandleInboundSms — sees the whole thread, including the automation's own texts", () => {
  const ROW = { client_id: "3-percent-east-coast", contact_id: "contact-1", lead: { ...LEAD, intent: "seller" }, status: "pending" };

  it("puts the recent thread — automated lines included — into the prompt", async () => {
    db.query.mockResolvedValueOnce([ROW]);
    vi.mocked(loadHistory).mockResolvedValueOnce([]);
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("Got it!"));
    textSignals.recentTexts.mockResolvedValueOnce([
      { from: "us", text: "Quick question, why are you looking to sell?", at: "2026-10-08T21:36:50.000Z", source: "workflow" },
      { from: "lead", text: "Looking to relocate to west coast", at: "2026-10-08T21:37:12.000Z", source: null },
    ] as never);

    await irisHandleInboundSms("contact-1", "Looking to relocate to west coast", { wait: async () => {} });

    const systemPrompt = vi.mocked(chatWithTools).mock.calls[0][0] as string;
    expect(systemPrompt).toContain("Us: Quick question, why are you looking to sell?");
    expect(systemPrompt).toContain("Lead: Looking to relocate to west coast");
  });

  it("waits for the automation to finish its sequence before answering, then re-reads the thread", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T21:37:00.000Z"));
    try {
      db.query.mockResolvedValueOnce([ROW]);
      vi.mocked(loadHistory).mockResolvedValueOnce([]);
      vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("ok"));
      textSignals.recentTexts
        .mockResolvedValueOnce([{ from: "us", text: "Quick question…", at: "2026-10-08T21:36:50.000Z", source: "workflow" }] as never) // 10s ago
        .mockResolvedValueOnce([{ from: "us", text: "Quick question…", at: "2026-10-08T21:36:50.000Z", source: "workflow" }] as never);
      const waits: number[] = [];

      await irisHandleInboundSms("contact-1", "hi", { wait: async (ms) => void waits.push(ms) });

      expect(waits[0]).toBe(35_000); // 45s quiet period minus the 10s already elapsed
      expect(textSignals.recentTexts).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Mark, 2026-10-10: when a teammate (Mark, Jacob, any agent) has texted a
 * lead, Iris stays out of that text conversation.
 */
describe("irisHandleInboundSms — stays out when a teammate has texted the lead", () => {
  const ROW = { client_id: "3-percent-east-coast", contact_id: "contact-1", lead: LEAD, status: "pending" };

  it("sends no reply, calls no model, and still reports the text as handled so Ember doesn't answer it either", async () => {
    db.query.mockResolvedValueOnce([ROW]);
    humanTouch.checkHumanTouch.mockResolvedValue({ status: "human", at: "2026-10-09T15:00:00.000Z", userId: "user-mark" });

    const handled = await irisHandleInboundSms("contact-1", "Thanks, call me tomorrow", { wait: async () => {} });

    expect(handled).toBe(true);
    expect(chatWithTools).not.toHaveBeenCalled();
    expect(ghl.sendSMS).not.toHaveBeenCalled();
    expect(classifyInboundText).not.toHaveBeenCalled();
  });

  it("also stays quiet when it can't verify the thread — never risks talking over a person", async () => {
    db.query.mockResolvedValueOnce([ROW]);
    humanTouch.checkHumanTouch.mockResolvedValue({ status: "unknown" });

    const handled = await irisHandleInboundSms("contact-1", "hello", { wait: async () => {} });

    expect(handled).toBe(true);
    expect(ghl.sendSMS).not.toHaveBeenCalled();
  });

  it("uses the client's own window when one is configured", async () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ ...JSON.parse(CLIENT_CONFIG), iris: { ...JSON.parse(CLIENT_CONFIG).iris, humanHandsOff: { days: 3 } } }));
    db.query.mockResolvedValueOnce([ROW]);
    vi.mocked(loadHistory).mockResolvedValueOnce([]);
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("ok"));

    await irisHandleInboundSms("contact-1", "hello", { wait: async () => {} });

    expect(humanTouch.checkHumanTouch).toHaveBeenCalledWith("contact-1", "loc-1", "key-1", 3);
  });
});
