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
import { irisHandleInboundSms, hasActiveSmsConversation } from "./sms";

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

    const handled = await irisHandleInboundSms("contact-1", "stop texting me");

    expect(handled).toBe(true);
    expect(chatWithTools).not.toHaveBeenCalled();
    expect(ghl.addContactTags).toHaveBeenCalledWith("contact-1", ["do not call"], "loc-1", "key-1");
    expect(ghl.sendSMS).toHaveBeenCalledWith("contact-1", expect.stringMatching(/won't reach out again/i), "loc-1", "key-1");

    const updateCall = db.query.mock.calls.find((c) => String(c[0]).includes("UPDATE iris_pending_calls"));
    expect(updateCall?.[1]).toEqual(["3-percent-east-coast", "contact-1", "lead opted out via text — cadence stopped"]);
  });
});

describe("irisHandleInboundSms — full qualification loop", () => {
  it("sends the model's plain-text reply as a real SMS and persists both sides of the exchange", async () => {
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast", contact_id: "contact-1", lead: LEAD, status: "pending" }]);
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("Great, and what area are you looking in?"));

    const handled = await irisHandleInboundSms("contact-1", "Looking to buy");

    expect(handled).toBe(true);
    expect(ghl.sendSMS).toHaveBeenCalledWith("contact-1", "Great, and what area are you looking in?", "loc-1", "key-1");
    expect(appendHistory).toHaveBeenCalledWith("iris", "sms:3-percent-east-coast:contact-1", "user", "Looking to buy");
    expect(appendHistory).toHaveBeenCalledWith("iris", "sms:3-percent-east-coast:contact-1", "assistant", "Great, and what area are you looking in?");
  });

  it("loads prior history under the sms: namespace, not the Slack channel: namespace", async () => {
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast", contact_id: "contact-1", lead: LEAD, status: "pending" }]);
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("Got it."));

    await irisHandleInboundSms("contact-1", "Buying");

    expect(loadHistory).toHaveBeenCalledWith("iris", "sms:3-percent-east-coast:contact-1");
  });

  it("save_qualification_notes writes a single structured note to the same field voice's save_isa_notes uses, then continues the loop", async () => {
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast", contact_id: "contact-1", lead: LEAD, status: "pending" }]);
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce(toolTurn(toolUseBlock("t1", "save_qualification_notes", { notes: "Buyer, area: downtown, budget 400k" })))
      .mockResolvedValueOnce(endTurn("Thanks! One of our team will reach out to book a time."));

    const handled = await irisHandleInboundSms("contact-1", "Downtown, around 400k");

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

    await irisHandleInboundSms("contact-1", "Sounds good");

    expect(ghl.addContactTags).toHaveBeenCalledWith("contact-1", ["iris sms qualified"], "loc-1", "key-1");
    expect(sendMessage).toHaveBeenCalledWith(
      "iris",
      expect.objectContaining({ text: expect.stringContaining("Catherine, buyer, downtown, 400k, ready to book") })
    );

    const updateCall = db.query.mock.calls.find((c) => String(c[0]).includes("UPDATE iris_pending_calls"));
    expect(updateCall?.[1]).toEqual(["3-percent-east-coast", "contact-1", "qualified via text — handed off for human follow-up"]);
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
