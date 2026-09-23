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


const HANDOFF_CONFIG = JSON.stringify({ ...JSON.parse(CLIENT_CONFIG), iris: { ...JSON.parse(CLIENT_CONFIG).iris, sms: { callHandoff: true } } });

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
    await irisHandleInboundSms("contact-1", "yes still looking");
    expect(toolNames()).not.toContain("schedule_transfer_call");
    expect(systemPrompt()).toContain("request_human_followup once");
  });

  it("queues a live-transfer call when the lead qualifies", async () => {
    db.query.mockResolvedValueOnce(row());
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce(toolTurn(toolUseBlock("t1", "schedule_transfer_call", { ...STRONG, when: "now" })))
      .mockResolvedValueOnce(endTurn("Perfect — expect a call from us in a couple of minutes!"));

    await irisHandleInboundSms("contact-1", "now works");

    expect(toolNames()).toContain("schedule_transfer_call");
    const update = db.query.mock.calls.find((c) => String(c[0]).includes("sms_scheduled = true"));
    expect(update).toBeDefined();
    expect(update![1][0]).toBe("eden-sub-account-one");
    const callAt = (update![1][2] as Date).getTime();
    expect(callAt).toBeGreaterThan(Date.now());
    expect(sendMessage).toHaveBeenCalledWith("iris", expect.objectContaining({ text: expect.stringContaining("live transfer") }));
    expect(ghl.sendSMS).toHaveBeenCalledWith("contact-1", "Perfect — expect a call from us in a couple of minutes!", "loc-1", "key-1");
  });

  it("refuses to queue a call for a lead who doesn't qualify — the model is told to hand to a human", async () => {
    db.query.mockResolvedValueOnce(row());
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce(toolTurn(toolUseBlock("t1", "schedule_transfer_call", { intent: "buyer", timeline: "maybe next year", financing: "not-approved", when: "now" })))
      .mockResolvedValueOnce(endTurn("No problem — someone from the team will follow up."));

    await irisHandleInboundSms("contact-1", "sure");

    expect(db.query.mock.calls.find((c) => String(c[0]).includes("sms_scheduled = true"))).toBeUndefined();
    const toolResult = (vi.mocked(chatWithTools).mock.calls[1][1] as any[]).at(-1).content[0].content as string;
    expect(toolResult).toMatch(/^NOT scheduled/);
    expect(toolResult).toContain("request_human_followup");
  });

  it("rejects an unreadable time instead of guessing", async () => {
    db.query.mockResolvedValueOnce(row());
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce(toolTurn(toolUseBlock("t1", "schedule_transfer_call", { ...STRONG, when: "after lunch-ish" })))
      .mockResolvedValueOnce(endTurn("What time works best?"));
    await irisHandleInboundSms("contact-1", "after lunch-ish");
    expect(db.query.mock.calls.find((c) => String(c[0]).includes("sms_scheduled = true"))).toBeUndefined();
  });
});

describe("an old lead Ember handed over", () => {
  it("gets the reactivation context, re-confirms buy/sell, and an honest virtual-assistant answer", async () => {
    db.query.mockResolvedValueOnce(row({ source: "ember" }));
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("Great to hear from you! Still looking to buy?"));
    await irisHandleInboundSms("contact-1", "yes actually");
    const prompt = systemPrompt();
    expect(prompt).toContain("OLDER lead");
    expect(prompt).toContain("still on the hunt");
    expect(prompt).toContain("Are you looking to buy or sell?");
    expect(prompt).toContain("virtual assistant");
  });

  it("a normal new lead keeps the existing wording", async () => {
    db.query.mockResolvedValueOnce(row());
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("What area?"));
    await irisHandleInboundSms("contact-1", "hi");
    expect(systemPrompt()).not.toContain("OLDER lead");
  });
});
