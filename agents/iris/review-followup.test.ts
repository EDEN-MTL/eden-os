import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../shared/db", () => db);

const ghl = vi.hoisted(() => ({ getContact: vi.fn(), getGhlConfig: vi.fn() }));
vi.mock("../../shared/ghl", () => ghl);

const slack = vi.hoisted(() => ({ sendMessage: vi.fn(async () => ({})) }));
vi.mock("../../shared/slack", () => slack);

const dialPending = vi.hoisted(() => ({
  queueColdLeadSweep: vi.fn(async (_c: string, ids: string[], at: Date) => ids.map((id) => ({ contactId: id, name: id, callAfter: at }))),
}));
vi.mock("./dial-pending", () => dialPending);

const lead = vi.hoisted(() => ({ latestReview: vi.fn() }));
vi.mock("./lead-review", () => ({
  latestReview: lead.latestReview,
  isWithAgentStage: (n: string) => ["live transferred", "appointment set"].includes(String(n).toLowerCase()),
}));

const humanTouch = vi.hoisted(() => ({ checkHumanTouch: vi.fn(async () => ({ status: "none" })), DEFAULT_HUMAN_HANDS_OFF_DAYS: 7 }));
vi.mock("./human-touch", () => humanTouch);

const iris = vi.hoisted(() => ({ loadIrisConfig: vi.fn() }));
vi.mock("./index", () => iris);

import { formatDailyFollowUpPost, pickFollowUpLeads, runDailyLeadFollowUp } from "./review-followup";

// Thursday 2026-11-12, 09:50 NST (13:20 UTC): inside calling hours
const NOW = new Date("2026-11-12T13:20:00.000Z");
const ranAt = new Date(NOW.getTime() - 2 * 3_600_000);

const finding = (id: string, name: string, over: any = {}) => ({
  kind: "qualified_untouched",
  contactId: id,
  name,
  stageName: "Buyer Leads",
  score: 80,
  headline: `${name} is qualified and untouched`,
  evidence: [],
  lastContact: "",
  suggested: "",
  assignedTo: null,
  ...over,
});
const reviewOf = (...findings: any[]) => lead.latestReview.mockResolvedValue({ ranAt, scanned: 100, findings });
const contact = (over: any = {}) => ({ contact: { phone: "+17095550101", tags: [], dnd: false, dateAdded: new Date(NOW.getTime() - 20 * 86_400_000).toISOString(), ...over } });

beforeEach(() => {
  db.query.mockResolvedValue([{ n: "0" }]);
  ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
  ghl.getContact.mockResolvedValue(contact());
  humanTouch.checkHumanTouch.mockResolvedValue({ status: "none" });
  iris.loadIrisConfig.mockReturnValue({ timezone: "America/St_Johns", dailyFollowUp: { enabled: true, maxPerDay: 5, kinds: ["owed_contact", "qualified_untouched", "only_missed_attempts"], snoozeDays: 3 } });
});
afterEach(() => vi.clearAllMocks());

describe("pickFollowUpLeads", () => {
  it("counts only a queue row due within a day as 'in hand', so a row parked for a text reply (Magar) doesn't hide the lead", async () => {
    await pickFollowUpLeads("3pc", [finding("m", "Magar")], { humanHandsOffDays: 7, now: NOW, reviewRanAt: ranAt });
    const sql = String(db.query.mock.calls[0][0]);
    expect(sql).toContain("status = 'pending' AND call_after < now() + interval '1 day'");
  });

  it("leaves out do-not-call, no-calls and teammate-touched leads, with the reason", async () => {
    ghl.getContact.mockImplementation(async (id: string) => (id === "dnc" ? contact({ tags: ["do not call"] }) : id === "nc" ? contact({ tags: ["no calls"] }) : contact()));
    humanTouch.checkHumanTouch.mockImplementation(async (id: string) => ({ status: id === "tm" ? "human" : "none" }));
    const out = await pickFollowUpLeads("3pc", [finding("dnc", "A"), finding("nc", "B"), finding("tm", "C"), finding("ok", "D")], { humanHandsOffDays: 7, now: NOW, reviewRanAt: ranAt });
    expect(out.eligible.map((e) => e.id)).toEqual(["ok"]);
    expect(out.left).toEqual(["A (do not call)", "B (no calls)", "C (a teammate has been in touch)"]);
  });
});

describe("runDailyLeadFollowUp", () => {
  it("does nothing while it is off for the client", async () => {
    iris.loadIrisConfig.mockReturnValue({ timezone: "America/St_Johns", dailyFollowUp: { enabled: false } });
    const out = await runDailyLeadFollowUp("3pc", { now: NOW });
    expect(out.skipped).toBe("daily follow-up is off");
    expect(dialPending.queueColdLeadSweep).not.toHaveBeenCalled();
  });

  it("does nothing on a review that is too old", async () => {
    lead.latestReview.mockResolvedValue({ ranAt: new Date(NOW.getTime() - 40 * 3_600_000), scanned: 1, findings: [finding("a", "Ann")] });
    expect((await runDailyLeadFollowUp("3pc", { now: NOW })).skipped).toContain("too old");
    expect(dialPending.queueColdLeadSweep).not.toHaveBeenCalled();
  });

  it("lines up the dropped leads, one sweep, and snoozes each from the review", async () => {
    reviewOf(finding("a", "Ann Lee"), finding("b", "Bo Chan", { kind: "owed_contact" }));
    const out = await runDailyLeadFollowUp("3pc", { now: NOW });
    expect(out.queued.map((q) => q.name)).toEqual(["Ann Lee", "Bo Chan"]);
    expect(dialPending.queueColdLeadSweep).toHaveBeenCalledTimes(1);
    expect(dialPending.queueColdLeadSweep.mock.calls[0][1]).toEqual(["a", "b"]);
    const snoozes = db.query.mock.calls.filter((c) => String(c[0]).includes("INSERT INTO lead_review_snoozes"));
    expect(snoozes.map((c) => c[1][1])).toEqual(["a", "b"]);
    expect(snoozes[0][1][3]).toBe("3");
  });

  it("never follows up a lead who is with an agent, parked on purpose, or whose last message is theirs", async () => {
    reviewOf(
      finding("lt", "Chioma", { stageName: "Live Transferred", withAgent: true }),
      finding("as", "Jim", { stageName: "Appointment Set" }),
      finding("nr", "Suzanne", { stageName: "Not Ready - [Endless Loop]" }),
      finding("ur", "Ololade", { kind: "unanswered_reply", stageName: "Replied" }),
      finding("ok", "Magar")
    );
    const out = await runDailyLeadFollowUp("3pc", { now: NOW });
    expect(out.queued.map((q) => q.name)).toEqual(["Magar"]);
    expect(out.forAPerson.map((f) => f.name)).toEqual(["Suzanne", "Ololade"]);
    expect(dialPending.queueColdLeadSweep.mock.calls[0][1]).toEqual(["ok"]);
  });

  it("stops at maxPerDay and names the rest as next in line", async () => {
    iris.loadIrisConfig.mockReturnValue({ timezone: "America/St_Johns", dailyFollowUp: { enabled: true, maxPerDay: 2, kinds: ["qualified_untouched"], snoozeDays: 3 } });
    reviewOf(finding("a", "A"), finding("b", "B"), finding("c", "C"));
    const out = await runDailyLeadFollowUp("3pc", { now: NOW });
    expect(out.queued.map((q) => q.name)).toEqual(["A", "B"]);
    expect(out.waiting.map((q) => q.name)).toEqual(["C"]);
    expect(formatDailyFollowUpPost(out)).toContain("Next in line (over today's limit): *C*");
  });

  it("a dry run reads and decides but queues and snoozes nothing, even while it is off", async () => {
    iris.loadIrisConfig.mockReturnValue({ timezone: "America/St_Johns", dailyFollowUp: { enabled: false } });
    reviewOf(finding("a", "Ann"));
    const out = await runDailyLeadFollowUp("3pc", { now: NOW, dryRun: true });
    expect(out.queued.map((q) => q.name)).toEqual(["Ann"]);
    expect(dialPending.queueColdLeadSweep).not.toHaveBeenCalled();
    expect(db.query.mock.calls.some((c) => String(c[0]).includes("lead_review_snoozes"))).toBe(false);
  });

  it("does not snooze a lead the sweep could not queue (no readable record, phone or name)", async () => {
    dialPending.queueColdLeadSweep.mockResolvedValueOnce([]);
    reviewOf(finding("a", "Ann"));
    const out = await runDailyLeadFollowUp("3pc", { now: NOW });
    expect(out.queued).toEqual([]);
    expect(out.left).toEqual(["Ann (no readable record, phone or name)"]);
    expect(db.query.mock.calls.some((c) => String(c[0]).includes("lead_review_snoozes"))).toBe(false);
  });
});

describe("formatDailyFollowUpPost", () => {
  it("says nothing when it was skipped or there is nothing to say", () => {
    expect(formatDailyFollowUpPost({ skipped: "off", queued: [], waiting: [], left: [], forAPerson: [], startAt: null, timeZone: "America/St_Johns" })).toBeNull();
    expect(formatDailyFollowUpPost({ queued: [], waiting: [], left: ["X (do not call)"], forAPerson: [], startAt: null, timeZone: "America/St_Johns" })).toBeNull();
  });

  it("lists who was lined up and who needs a person", () => {
    const post = formatDailyFollowUpPost({
      queued: [{ id: "a", name: "Magar Bhuma", kind: "qualified_untouched", headline: "Qualified and untouched" }],
      waiting: [],
      left: ["William (inquiry over 6 months old — needs Jacob's OK)"],
      forAPerson: [finding("o", "Ololade", { stageName: "Replied", headline: "They texted 5d ago and nobody has answered" }) as any],
      startAt: NOW,
      timeZone: "America/St_Johns",
    })!;
    expect(post).toContain("lined up 1 lead");
    expect(post).toContain("*Magar Bhuma*: Qualified and untouched");
    expect(post).toContain("*Needs a person to read their thread first:*");
    expect(post).toContain("*Ololade* (Replied)");
    expect(post).toContain("Left out: William");
  });
});
