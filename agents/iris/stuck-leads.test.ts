import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../shared/db", () => db);

const ghl = vi.hoisted(() => ({
  addContactTags: vi.fn(async () => ({})),
  createContactNote: vi.fn(async () => ({})),
  getContact: vi.fn(),
  getContactAppointments: vi.fn(async () => []),
  getConversationMessages: vi.fn(async () => ({ messages: { messages: [] } })),
  getConversations: vi.fn(async () => ({ conversations: [] })),
  getCustomFieldDefs: vi.fn(async () => []),
  getGhlConfig: vi.fn(async () => ({ locationId: "loc", apiKey: "key" })),
  listOpportunitiesForContact: vi.fn(async () => []),
  listOpportunitiesInStage: vi.fn(),
  listPipelines: vi.fn(),
  updateOpportunityStage: vi.fn(async () => ({})),
}));
vi.mock("../../shared/ghl", () => ghl);
vi.mock("../../shared/slack", () => ({ sendMessage: vi.fn(async () => ({})) }));
vi.mock("../scout/intake", () => ({ buildKeyToId: () => new Map(), readField: () => "" }));
vi.mock("../scout", () => ({ refreshLead: vi.fn(async (id: string) => ({ name: `Lead ${id}`, phone: "+17095550101", intent: "buyer", budget: null, timeline: null, propertyInterest: null, bedrooms: null, financing: null, workingWithRealtor: null })) }));

const vapi = vi.hoisted(() => ({ sendIrisText: vi.fn(async () => "delivered") }));
vi.mock("../../webhooks/vapi-webhook", () => vapi);
const asap = vi.hoisted(() => ({ openRowForReplies: vi.fn(async () => {}), composeAsapText: vi.fn() }));
vi.mock("./asap-watch", () => asap);
const dial = vi.hoisted(() => ({ queueColdLeadSweep: vi.fn(async (_c: string, ids: string[], at: Date) => ids.map((id) => ({ contactId: id, name: id, callAfter: at }))) }));
vi.mock("./dial-pending", () => dial);
const touch = vi.hoisted(() => ({ checkHumanTouch: vi.fn(async () => ({ status: "none" })), DEFAULT_HUMAN_HANDS_OFF_DAYS: 7 }));
vi.mock("./human-touch", () => touch);
const iris = vi.hoisted(() => ({ loadIrisConfig: vi.fn() }));
vi.mock("./index", () => iris);
const notes = vi.hoisted(() => ({ appendNoteToContact: vi.fn(async () => {}) }));
vi.mock("./notes", () => notes);
const optOut = vi.hoisted(() => ({ moveToNotInterested: vi.fn(async () => ({ moved: true, stageName: "Not Qualified/Not Interested" })) }));
vi.mock("./opt-out", () => optOut);

import { diagnoseStuckLead, formatStuckPost, isUnfinishedCall, retryStartAt, runStuckLeadCheck, saidWrongNumber, StuckFacts } from "./stuck-leads";
import type { ReviewEvent } from "./lead-review";

// Tuesday 2026-11-17, 10:20 NST (13:50 UTC)
const NOW = new Date("2026-11-17T13:50:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => NOW.getTime() - days * DAY;

const cfg = {
  stageTags: { "buyer leads": "buyer lead" },
  quietDays: 3,
  giveUpAfterDays: 5,
  maxNudges: 2,
  recheckDays: 3,
  extraTriesForUnfinishedCalls: 2,
  autoContactMaxDays: 60,
};

const call = (daysAgo: number, over: Partial<StuckFacts["calls"][number]> = {}) => ({ at: ago(daysAgo), endedReason: "customer-did-not-answer", seconds: 0, leadTurns: 0, transcript: "", ...over });
const hungUp = (daysAgo: number) => call(daysAgo, { endedReason: "customer-ended-call", seconds: 37, leadTurns: 1, transcript: "AI: Hi, is this Chris?\nUser: Yes\nAI: I'm calling about your inquiry…" });
const irisText = (daysAgo: number): ReviewEvent => ({ at: ago(daysAgo), actor: "app", kind: "sms", direction: "out", text: "Hi, we missed you" });
const irisCallEvent = (daysAgo: number, reached = false): ReviewEvent => ({ at: ago(daysAgo), actor: "iris_call", kind: "call", direction: "out", text: "", reached });
const leadText = (daysAgo: number, text = "ok thanks"): ReviewEvent => ({ at: ago(daysAgo), actor: "lead", kind: "sms", direction: "in", text });

const facts = (over: Partial<StuckFacts> = {}): StuckFacts => ({
  contactId: "c1",
  name: "Chris Snook",
  stageName: "DAY 1 - AM FOLLOWUP",
  daysInStage: 8,
  createdAt: ago(10),
  tags: ["buyer lead"],
  dnd: false,
  hasPhone: true,
  notes: "",
  events: [],
  calls: [],
  irisQueue: null,
  hasUpcomingAppointment: false,
  teammateInTouch: false,
  nudges: 0,
  lastNudgeAt: null,
  lastActionAt: null,
  ...over,
});
const act = (f: StuckFacts) => diagnoseStuckLead(f, cfg, NOW).diagnosis.action;

describe("call helpers", () => {
  it("reads a wrong number only from what the lead said", () => {
    expect(saidWrongNumber({ transcript: "AI: Is this Ell?\nUser: No, wrong number\nAI: Sorry" })).toBe(true);
    expect(saidWrongNumber({ transcript: "AI: Is this Ell? You might say wrong number if not\nUser: Yes it is" })).toBe(false);
  });
  it("calls a connected call with no outcome unfinished, but not a wrong number or a no-answer", () => {
    expect(isUnfinishedCall(hungUp(8))).toBe(true);
    expect(isUnfinishedCall(call(8))).toBe(false);
    expect(isUnfinishedCall(call(8, { endedReason: "customer-ended-call", transcript: "User: wrong number" }))).toBe(false);
  });
  it("counts a call Iris ended herself as unfinished only when it was short", () => {
    expect(isUnfinishedCall(call(8, { endedReason: "assistant-ended-call", seconds: 94, leadTurns: 2 }))).toBe(true);
    expect(isUnfinishedCall(call(8, { endedReason: "assistant-ended-call", seconds: 190, leadTurns: 8 }))).toBe(false);
    expect(isUnfinishedCall(call(8, { endedReason: "assistant-ended-call", seconds: 0, leadTurns: 1 }))).toBe(true);
    expect(isUnfinishedCall(call(8, { endedReason: "customer-ended-call", seconds: 190, leadTurns: 8 }))).toBe(true);
  });
});

describe("diagnoseStuckLead: leave it alone", () => {
  it.each([
    ["do not call", { tags: ["do not call"] }],
    ["an appointment ahead", { hasUpcomingAppointment: true }],
    ["a teammate in touch", { teammateInTouch: true }],
    ["a call lined up (even tomorrow)", { irisQueue: { status: "pending", callAfter: NOW.getTime() + 2 * DAY, source: null } }],
    ["handled this check two days ago", { lastActionAt: ago(2), calls: [hungUp(9)] }],
  ] as [string, Partial<StuckFacts>][])("%s", (_n, over) => expect(act(facts(over))).toBe("leave"));

  it("waits for a reply to the text Iris sent yesterday", () => {
    expect(act(facts({ irisQueue: { status: "pending", callAfter: null, source: "sweep" }, events: [irisCallEvent(1), irisText(1)], calls: [call(1)] }))).toBe("leave");
  });
  it("leaves a lead Iris tried a day ago", () => {
    expect(act(facts({ events: [irisCallEvent(1), irisText(1)], calls: [call(1)] }))).toBe("leave");
  });
});

describe("diagnoseStuckLead: a person decides", () => {
  it("no phone", () => expect(act(facts({ hasPhone: false }))).toBe("person"));
  it("live transferred but the card never moved", () => expect(act(facts({ tags: ["buyer lead", "live transferred"] }))).toBe("person"));
  it("they texted last and nobody answered", () => expect(act(facts({ events: [irisText(5), leadText(4)] }))).toBe("person"));
  it("an inquiry over six months old", () => expect(act(facts({ createdAt: ago(200), events: [irisText(30)] }))).toBe("person"));
  it("an old leftover nobody follows up on automatically", () => expect(act(facts({ createdAt: ago(75), events: [irisText(40), leadText(39)] }))).toBe("person"));
  it("an old lead nobody ever contacted", () => expect(act(facts({ createdAt: ago(45) }))).toBe("person"));
  it("a qualified lead who answered us and then stopped moving", () => {
    expect(act(facts({ notes: "Budget $400k, timeline 3 months, area Paradise, pre-approved", events: [irisText(9), leadText(8), irisText(6)], calls: [call(9)] }))).toBe("person");
  });
});

describe("diagnoseStuckLead: the fixes", () => {
  it("closes a wrong number (Ell Dee)", () => {
    const f = facts({ calls: [call(14), { ...call(13), endedReason: "assistant-ended-call", seconds: 20, leadTurns: 1, transcript: "AI: Is this Ell?\nUser: Wrong number" }] });
    expect(diagnoseStuckLead(f, cfg, NOW).diagnosis.action).toBe("close_wrong_number");
  });

  it("calls a lead who hung up on the first call again (Chris Snook)", () => {
    const d = diagnoseStuckLead(facts({ calls: [call(9), hungUp(8)], events: [irisCallEvent(9), irisCallEvent(8, true), irisText(9)] }), cfg, NOW);
    expect(d.diagnosis.action).toBe("call_again");
    expect(d.diagnosis.why).toMatch(/never finished/);
  });

  it("texts instead of calling a lead who asked for no calls", () => {
    expect(act(facts({ tags: ["buyer lead", "no calls"], calls: [hungUp(8)], events: [irisCallEvent(8, true)] }))).toBe("text_follow_up");
  });

  it("does not call again a moment after Iris called", () => {
    expect(act(facts({ calls: [hungUp(0.2)], events: [irisCallEvent(0.2, true)] }))).toBe("leave");
  });

  it("stops retrying a hang-up after two extra tries and moves to the follow-up text", () => {
    const f = facts({ calls: [hungUp(12), hungUp(9), hungUp(6)], events: [irisCallEvent(12, true), irisCallEvent(9, true), irisCallEvent(6, true), irisText(11)] });
    expect(act(f)).toBe("text_follow_up");
  });

  it("makes the first call to a recent lead nobody has contacted", () => {
    expect(act(facts({ createdAt: ago(4) }))).toBe("call_again");
  });

  it("sends the one text after calls that went unanswered (Jerrett Warford)", () => {
    expect(act(facts({ calls: [call(17), call(16), call(15)], events: [irisCallEvent(17), irisCallEvent(16), irisCallEvent(15)] }))).toBe("text_follow_up");
  });

  it("moves a lead to Not Ready once the calls and the text got no answer for five days (Melanie Petten)", () => {
    const f = facts({ stageName: "WEEKEND - PM FOLLOW UP", calls: [call(11), call(10), call(9)], events: [irisCallEvent(11), irisCallEvent(10), irisCallEvent(9), irisText(8)] });
    expect(diagnoseStuckLead(f, cfg, NOW).diagnosis.action).toBe("park_not_ready");
  });
  it("but waits while the last text is under five days old", () => {
    const f = facts({ calls: [call(11), call(10)], events: [irisCallEvent(11), irisCallEvent(10), irisText(4)] });
    expect(act(f)).toBe("leave");
  });

  it("follows up a lead who talked to Iris and went quiet, from the history", () => {
    const f = facts({ calls: [{ ...call(8), endedReason: "assistant-ended-call", seconds: 150, leadTurns: 6, transcript: "User: looking in Paradise" }], events: [irisCallEvent(8, true), irisText(7), leadText(6)].slice(0, 2) });
    const d = diagnoseStuckLead(f, cfg, NOW);
    expect(d.diagnosis.action).toBe("text_follow_up");
  });

  it("moves a quiet lead to Not Ready after two follow-ups and five more silent days", () => {
    const f = facts({ nudges: 2, lastNudgeAt: ago(6), calls: [{ ...call(20), leadTurns: 3, endedReason: "assistant-ended-call", transcript: "User: hi" }], events: [irisCallEvent(20, true), irisText(6)] });
    expect(act(f)).toBe("park_not_ready");
    expect(act({ ...f, lastNudgeAt: ago(4), events: [irisCallEvent(20, true), irisText(4)] })).toBe("leave");
  });

  // Mark, 2026-11-17 (Magar Bhuma): qualified on a call, then nothing back to any text for a week. Iris follows up,
  // and moves the card when that gets no answer; she doesn't just list it for a person.
  describe("a qualified lead who never answered a text", () => {
    const QUALIFIED = "Budget $400k, timeline 3 months, area Paradise, pre-approved";
    const talked = { ...call(9), endedReason: "assistant-ended-call", seconds: 150, leadTurns: 6, transcript: "User: looking in Paradise" };
    it("is followed up with a text", () => {
      const f = facts({ notes: QUALIFIED, calls: [talked], events: [irisCallEvent(9, true), irisText(8)] });
      const d = diagnoseStuckLead(f, cfg, NOW);
      expect(d.diagnosis.action).toBe("text_follow_up");
      expect(d.diagnosis.why).toMatch(/qualified in the notes, never answered a text/);
    });
    it("is moved to Not Ready after two follow-ups and five silent days, and says why", () => {
      const f = facts({ notes: QUALIFIED, nudges: 2, lastNudgeAt: ago(6), calls: [talked], events: [irisCallEvent(20, true), irisText(6)] });
      const d = diagnoseStuckLead(f, cfg, NOW);
      expect(d.diagnosis.action).toBe("park_not_ready");
      expect(d.diagnosis.why).toMatch(/a person can pick them up from Not Ready/);
    });
    it("waits while the last follow-up is under five days old", () => {
      const f = facts({ notes: QUALIFIED, nudges: 2, lastNudgeAt: ago(4), calls: [talked], events: [irisCallEvent(20, true), irisText(4)] });
      expect(act(f)).toBe("leave");
    });
    it("but a qualified lead who did answer goes to a person, not to Not Ready", () => {
      const f = facts({ notes: QUALIFIED, nudges: 2, lastNudgeAt: ago(6), calls: [talked], events: [irisCallEvent(20, true), leadText(10), irisText(6)] });
      expect(act(f)).toBe("person");
    });
  });

  it("adds the stage's missing tag", () => {
    const d = diagnoseStuckLead(facts({ stageName: "Buyer Leads", tags: [], createdAt: ago(2) }), cfg, NOW);
    expect(d.tagsToAdd).toEqual(["buyer lead"]);
    expect(d.problems).toEqual(expect.arrayContaining(["no buyer/seller tag", "no notes", "never called"]));
  });
});

describe("retryStartAt", () => {
  it("calls a lead who last answered in the morning in the afternoon, and vice versa", () => {
    const morning = new Date("2026-11-16T14:00:00Z").getTime(); // 11:30 NST
    expect(retryStartAt(NOW, "America/St_Johns", morning).toISOString()).toBe("2026-11-17T17:30:00.000Z"); // 2:00 PM NST
    const afternoon = new Date("2026-11-16T18:30:00Z").getTime(); // 3:00 PM NST
    expect(retryStartAt(NOW, "America/St_Johns", afternoon).toISOString()).toBe("2026-11-18T13:30:00.000Z"); // tomorrow 10:00 AM NST
  });
  it("calls a lead nobody has called within minutes", () => {
    expect(retryStartAt(NOW, "America/St_Johns", null).getTime()).toBe(NOW.getTime() + 10 * 60_000);
  });
});

describe("formatStuckPost", () => {
  it("says what was done, what waits and who needs a person", () => {
    const entry = (name: string, action: string, why: string, over: any = {}) => ({ contactId: name, name, stageName: "DAY 1 - AM FOLLOWUP", diagnosed: { diagnosis: { action, why }, problems: [], tagsToAdd: [] }, ...over });
    const post = formatStuckPost({
      scanned: 3,
      timeZone: "America/St_Johns",
      startAts: {},
      entries: [entry("Ell Dee", "close_wrong_number", "wrong number", { did: "moved to Not Interested" }), entry("Kelly", "text_follow_up", "quiet", { deferred: true }), entry("Genna", "person", "over 6 months")],
    } as any);
    expect(post).toContain("*Ell Dee*");
    expect(post).toContain("first in line tomorrow: *Kelly*");
    expect(post).toContain("Needs a person");
    expect(formatStuckPost({ skipped: "off", scanned: 0, entries: [], timeZone: "x", startAts: {} })).toBeNull();
    expect(formatStuckPost({ scanned: 4, entries: [entry("A", "leave", "x")], timeZone: "x", startAts: {} } as any)).toBeNull();
  });
});

describe("runStuckLeadCheck", () => {
  const stuckCfg = { enabled: true, stagePatterns: ["^day [123] -", "^replied"], stageTags: {}, autoContactMaxDays: 60 };
  const created = new Date(NOW.getTime() - 10 * DAY).toISOString();
  const opp = (id: string) => ({ id: `opp-${id}`, contactId: id, status: "open", updatedAt: created, lastStageChangeAt: created, contact: { name: id } });

  function world(contacts: Record<string, { calls?: any[]; messages?: any[]; tags?: string[] }>) {
    ghl.listPipelines.mockResolvedValue([{ id: "p1", stages: [{ id: "s1", name: "DAY 1 - AM FOLLOWUP" }, { id: "s2", name: "Not Ready - [Endless Loop]" }] }]);
    ghl.listOpportunitiesInStage.mockImplementation(async (_l: string, _p: string, stageId: string) => (stageId === "s1" ? Object.keys(contacts).map(opp) : []));
    ghl.getContact.mockImplementation(async (id: string) => ({ contact: { firstName: id, phone: "+17095550101", tags: contacts[id]?.tags ?? ["buyer lead"], dateAdded: created } }));
    ghl.getConversations.mockImplementation(async () => ({ conversations: [{ id: "conv" }] }));
    db.query.mockImplementation(async (sql: string) => {
      if (/FROM iris_call_log/.test(sql)) return Object.entries(contacts).flatMap(([id, c]) => (c.calls ?? []).map((x) => ({ contact_id: id, ...x })));
      return [];
    });
  }
  const hungCall = (daysAgo: number) => ({ created_at: new Date(ago(daysAgo)), ended_at: new Date(ago(daysAgo) + 37_000), ended_reason: "customer-ended-call", transcript: "AI: Hi, is this Chris?\nUser: Yes\nAI: I'm calling about your inquiry" });

  beforeEach(() => {
    iris.loadIrisConfig.mockReturnValue({ timezone: "America/St_Johns", callbackNotesFieldKey: "contact.isa_notes", followUpCohort: { notReadyStage: "Not Ready - [Endless Loop]", notInterestedStage: "Not Qualified/Not Interested" }, stuckLeads: stuckCfg });
    touch.checkHumanTouch.mockResolvedValue({ status: "none" });
  });
  afterEach(() => vi.clearAllMocks());

  it("queues a call at another time of day for a lead who hung up, and records it", async () => {
    world({ chris: { calls: [hungCall(8)] } });
    const r = await runStuckLeadCheck("c", { now: NOW });
    expect(dial.queueColdLeadSweep).toHaveBeenCalledTimes(1);
    const [, ids, at] = dial.queueColdLeadSweep.mock.calls[0] as unknown as [string, string[], Date];
    expect(ids).toEqual(["chris"]);
    expect(at.getTime()).toBeGreaterThan(NOW.getTime());
    expect(db.query.mock.calls.some(([sql]) => /INSERT INTO iris_stuck_actions/.test(String(sql)))).toBe(true);
    expect(r.entries[0].did).toMatch(/call lined up/);
  });

  it("changes nothing in a dry run", async () => {
    world({ chris: { calls: [hungCall(8)] } });
    const r = await runStuckLeadCheck("c", { now: NOW, dryRun: true });
    expect(r.entries[0].did).toMatch(/call lined up/);
    expect(dial.queueColdLeadSweep).not.toHaveBeenCalled();
    expect(ghl.addContactTags).not.toHaveBeenCalled();
    expect(ghl.updateOpportunityStage).not.toHaveBeenCalled();
    expect(vapi.sendIrisText).not.toHaveBeenCalled();
  });

  it("closes a wrong number: tags it, moves the card, skips its queue row", async () => {
    world({ ell: { calls: [{ created_at: new Date(ago(14)), ended_at: new Date(ago(14) + 20_000), ended_reason: "assistant-ended-call", transcript: "AI: Is this Ell?\nUser: Wrong number\nAI: Sorry about that" }] } });
    await runStuckLeadCheck("c", { now: NOW });
    expect(ghl.addContactTags).toHaveBeenCalledWith("ell", ["wrong number", "do not call"], "loc", "key");
    expect(optOut.moveToNotInterested).toHaveBeenCalled();
    expect(dial.queueColdLeadSweep).not.toHaveBeenCalled();
  });

  it("never acts on a lead a teammate has been in touch with, read live", async () => {
    world({ chris: { calls: [hungCall(8)] } });
    touch.checkHumanTouch.mockResolvedValue({ status: "human", at: NOW.toISOString() });
    const r = await runStuckLeadCheck("c", { now: NOW });
    expect(dial.queueColdLeadSweep).not.toHaveBeenCalled();
    expect(r.entries[0].diagnosed.diagnosis.action).toBe("leave");
  });

  it("holds the extra leads over the daily call limit for tomorrow", async () => {
    iris.loadIrisConfig.mockReturnValue({ timezone: "America/St_Johns", callbackNotesFieldKey: "contact.isa_notes", followUpCohort: { notReadyStage: "Not Ready - [Endless Loop]", notInterestedStage: "x" }, stuckLeads: { ...stuckCfg, maxCallsPerDay: 1 } });
    world({ a: { calls: [hungCall(9)] }, b: { calls: [hungCall(8)] } });
    const r = await runStuckLeadCheck("c", { now: NOW });
    expect(dial.queueColdLeadSweep).toHaveBeenCalledTimes(1);
    expect(r.entries.filter((e) => e.deferred)).toHaveLength(1);
  });

  it("writes the follow-up text from the history, sends it and keeps the row open for a reply", async () => {
    world({ chris: { calls: [{ created_at: new Date(ago(8)), ended_at: new Date(ago(8) + 150_000), ended_reason: "assistant-ended-call", transcript: "AI: Hi\nUser: I'm looking in Paradise\nAI: Great" }] } });
    ghl.getConversationMessages.mockResolvedValue({ messages: { messages: [] } });
    asap.composeAsapText.mockResolvedValue({ text: "Hi Chris, you mentioned Paradise. Would tomorrow at 4:30 work for a quick call?" });
    await runStuckLeadCheck("c", { now: NOW });
    expect(asap.composeAsapText).toHaveBeenCalled();
    expect(vapi.sendIrisText).toHaveBeenCalledWith("c", "chris", expect.any(String), expect.stringContaining("Paradise"));
    expect(asap.openRowForReplies).toHaveBeenCalledWith("c", "chris", expect.anything(), expect.objectContaining({ source: "stuck" }));
  });

  it("does nothing when the check is off", async () => {
    iris.loadIrisConfig.mockReturnValue({ timezone: "America/St_Johns", stuckLeads: { ...stuckCfg, enabled: false } });
    const r = await runStuckLeadCheck("c", { now: NOW });
    expect(r.skipped).toMatch(/off/);
    expect(ghl.listPipelines).not.toHaveBeenCalled();
  });
});
