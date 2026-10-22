import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn(async (..._a: unknown[]): Promise<any[]> => []) }));
vi.mock("../../shared/db", () => db);
const slack = vi.hoisted(() => ({ sendMessage: vi.fn(async () => ({})) }));
vi.mock("../../shared/slack", () => slack);
const ghl = vi.hoisted(() => ({
  createContactNote: vi.fn(async () => ({})),
  getContact: vi.fn(),
  getContactAppointments: vi.fn(async () => []),
  getConversationMessages: vi.fn(),
  getConversations: vi.fn(),
  getGhlConfig: vi.fn(),
  listOpportunitiesForContact: vi.fn(),
  listPipelines: vi.fn(),
  updateOpportunityStage: vi.fn(async () => ({})),
}));
vi.mock("../../shared/ghl", () => ghl);
const idx = vi.hoisted(() => ({ loadIrisConfig: vi.fn() }));
vi.mock("./index", () => idx);
const dial = vi.hoisted(() => ({ queueColdLeadSweep: vi.fn() }));
vi.mock("./dial-pending", () => dial);
const touch = vi.hoisted(() => ({ checkHumanTouch: vi.fn(), DEFAULT_HUMAN_HANDS_OFF_DAYS: 7 }));
vi.mock("./human-touch", () => touch);
vi.mock("./links", () => ({ linkLineFor: vi.fn(async () => "") }));

import { callAnswered, decideCohortMember, runFollowUpCohortCheck, type CohortFacts } from "./followup-cohort";

const NOW = new Date("2026-10-24T15:00:00.000Z"); // Saturday
const base = (over: Partial<CohortFacts> = {}): CohortFacts => ({
  now: NOW,
  deadline: new Date("2026-10-25T13:00:00.000Z"),
  rounds: [new Date("2026-10-23T12:30:00.000Z"), new Date("2026-10-24T16:30:00.000Z")],
  roundsDone: 1,
  optedOut: false,
  cardStillThere: true,
  teammateTouchedSince: false,
  replied: false,
  answeredCall: false,
  appointmentAhead: false,
  irisBusy: false,
  ...over,
});

describe("decideCohortMember", () => {
  it("waits while a round is not yet due", () => {
    expect(decideCohortMember(base()).action).toBe("wait");
  });
  it("queues the next round once it is due and Iris has nothing in flight", () => {
    expect(decideCohortMember(base({ now: new Date("2026-10-24T16:31:00.000Z") })).action).toBe("next_round");
    expect(decideCohortMember(base({ now: new Date("2026-10-24T16:31:00.000Z"), irisBusy: true })).action).toBe("wait");
    expect(decideCohortMember(base({ now: new Date("2026-10-24T16:31:00.000Z"), roundsDone: 2 })).action).toBe("wait");
  });
  it("moves to Not Ready at the deadline only when nothing was answered", () => {
    expect(decideCohortMember(base({ now: new Date("2026-10-25T13:01:00.000Z") }))).toMatchObject({ action: "not_ready" });
  });
  it("never moves a lead who replied, picked up a call, or booked, even at the deadline", () => {
    const late = new Date("2026-10-25T13:01:00.000Z");
    expect(decideCohortMember(base({ now: late, replied: true })).action).toBe("engaged");
    expect(decideCohortMember(base({ now: late, answeredCall: true })).action).toBe("engaged");
    expect(decideCohortMember(base({ now: late, appointmentAhead: true })).action).toBe("engaged");
  });
  it("moves an opted-out lead to Not Interested straight away", () => {
    expect(decideCohortMember(base({ optedOut: true })).action).toBe("not_interested");
  });
  it("drops a lead a teammate has taken over, and never touches a card someone else moved", () => {
    expect(decideCohortMember(base({ teammateTouchedSince: true, now: new Date("2026-10-25T13:01:00.000Z") })).action).toBe("dropped");
    expect(decideCohortMember(base({ cardStillThere: false, optedOut: true })).action).toBe("dropped");
  });
});

describe("callAnswered", () => {
  it("counts a call where the lead said something", () => {
    expect(callAnswered({ ended_reason: "customer-ended-call", transcript: "User: Hello?\nAI: Hi, this is Iris" })).toBe(true);
  });
  it("does not count no-answer, voicemail, a silent pickup, or an empty call", () => {
    expect(callAnswered({ ended_reason: "customer-did-not-answer", transcript: "User: You have reached" })).toBe(false);
    expect(callAnswered({ ended_reason: "customer-ended-call", transcript: "" })).toBe(false);
    expect(callAnswered({ ended_reason: "silence-timed-out", transcript: "" })).toBe(false);
    expect(callAnswered({ ended_reason: "customer-ended-call", transcript: "User: Please leave a message after the tone." })).toBe(false);
  });
});

describe("runFollowUpCohortCheck", () => {
  const ROW = {
    id: "1",
    client_id: "3pc",
    contact_id: "c-grace",
    contact_name: "Grace Penney",
    opportunity_id: "opp-1",
    stage_id: "stage-weekend",
    started_at: new Date("2026-10-22T18:00:00.000Z"),
    deadline_at: new Date("2026-10-25T13:00:00.000Z"),
    rounds: [new Date("2026-10-23T12:30:00.000Z"), new Date("2026-10-24T16:30:00.000Z")],
    rounds_done: 2,
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-25T13:30:00.000Z"));
    idx.loadIrisConfig.mockReturnValue({ timezone: "America/St_Johns", humanHandsOffDays: 7, followUpCohort: { notReadyStage: "Not Ready - [Endless Loop]", notInterestedStage: "Not Qualified/Not Interested" } });
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc", apiKey: "k" });
    ghl.listPipelines.mockResolvedValue([{ id: "p", stages: [{ id: "stage-weekend", name: "WEEKEND AM" }, { id: "stage-not-ready", name: "Not Ready - [Endless Loop]" }, { id: "stage-not-interested", name: "Not Qualified/Not Interested" }] }]);
    ghl.getContact.mockResolvedValue({ contact: { tags: [], dnd: false } });
    ghl.listOpportunitiesForContact.mockResolvedValue([{ id: "opp-1", pipelineStageId: "stage-weekend" }]);
    ghl.getConversations.mockResolvedValue({ conversations: [{ id: "cv" }] });
    ghl.getConversationMessages.mockResolvedValue({ messages: { messages: [] } });
    ghl.getContactAppointments.mockResolvedValue([]);
    touch.checkHumanTouch.mockResolvedValue({ status: "none" });
    dial.queueColdLeadSweep.mockResolvedValue([]);
    db.query.mockImplementation(async (...args: unknown[]) => (/FROM iris_followup_cohort WHERE status = 'active'/.test(String(args[0])) ? [ROW] : []));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("moves a lead who never answered to Not Ready at the deadline, with a note and a Slack line", async () => {
    await runFollowUpCohortCheck();
    expect(ghl.updateOpportunityStage).toHaveBeenCalledWith("opp-1", "stage-not-ready", "loc", "k");
    expect(ghl.createContactNote).toHaveBeenCalledTimes(1);
    expect(slack.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("moves an opted-out lead to Not Interested", async () => {
    ghl.getContact.mockResolvedValue({ contact: { tags: ["do not call"], dnd: false } });
    await runFollowUpCohortCheck();
    expect(ghl.updateOpportunityStage).toHaveBeenCalledWith("opp-1", "stage-not-interested", "loc", "k");
  });

  it("leaves a lead who replied exactly where they are", async () => {
    ghl.getConversationMessages.mockResolvedValue({ messages: { messages: [{ messageType: "TYPE_SMS", direction: "inbound", dateAdded: "2026-10-23T15:00:00.000Z" }] } });
    await runFollowUpCohortCheck();
    expect(ghl.updateOpportunityStage).not.toHaveBeenCalled();
  });

  it("leaves a lead whose card someone already moved", async () => {
    ghl.listOpportunitiesForContact.mockResolvedValue([{ id: "opp-1", pipelineStageId: "stage-not-ready" }]);
    await runFollowUpCohortCheck();
    expect(ghl.updateOpportunityStage).not.toHaveBeenCalled();
  });

  it("moves nobody when a configured stage cannot be found", async () => {
    ghl.listPipelines.mockResolvedValue([{ id: "p", stages: [{ id: "stage-weekend", name: "WEEKEND AM" }] }]);
    await runFollowUpCohortCheck();
    expect(ghl.updateOpportunityStage).not.toHaveBeenCalled();
  });

  it("does nothing on a thread it cannot read (waits for the next hour)", async () => {
    touch.checkHumanTouch.mockResolvedValue({ status: "unknown" });
    await runFollowUpCohortCheck();
    expect(ghl.updateOpportunityStage).not.toHaveBeenCalled();
  });

  it("queues the next call round, one at a time, when it is due", async () => {
    vi.setSystemTime(new Date("2026-10-24T17:00:00.000Z"));
    db.query.mockImplementation(async (...args: unknown[]) => (/FROM iris_followup_cohort WHERE status = 'active'/.test(String(args[0])) ? [{ ...ROW, rounds_done: 1 }] : []));
    dial.queueColdLeadSweep.mockResolvedValue([{ contactId: "c-grace", name: "Grace Penney", callAfter: new Date() }]);
    await runFollowUpCohortCheck();
    expect(dial.queueColdLeadSweep).toHaveBeenCalledWith("3pc", ["c-grace"], expect.any(Date));
    expect(ghl.updateOpportunityStage).not.toHaveBeenCalled();
  });
});
