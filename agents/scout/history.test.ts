import { describe, expect, it } from "vitest";
import { classifyLeadHistory, HistoryConfig, HistoryOpportunity, HistorySubject } from "./history";

/**
 * Fixtures modeled on REAL 3% Realty data pulled 2026-10-04 — real stage
 * ids from GET /pipelines, and the real shapes of Glen White (an old lead
 * assigned to Stephanie McGrath, tagged "appt booked"), Saife Sarwar (a
 * genuinely new lead who replied to the text automation), and Justin
 * Denney (already live-transferred).
 */
const STAGE = {
  buyerLeads: "f83b5ac8-e445-4a3e-b1e0-ac99a4747b56",
  replied: "6b623173-a23b-42f2-ae96-2d162c17f112",
  day1: "915e02ff-ea09-4409-8e9d-681fa449d687",
  liveTransferred: "d4cb572b-5fa5-48e5-bced-46c88715e2da",
  appointmentSet: "790a0988-f755-4242-84da-bf8aeb38d2d6",
  showedUp: "60343259-792e-435f-a43e-2583abac6a5b",
  longTermNurturing: "c8095a84-6fd2-4d27-87ec-a7b04c974640",
};
const STEPHANIE = "FxhXD7440LRChvWfotmD";

const CONFIG: HistoryConfig = {
  touchedTags: ["appt booked", "appointment", "live transferred", "no show", "do not call"],
  historyStageIds: [STAGE.liveTransferred, STAGE.appointmentSet, STAGE.showedUp],
  returningMinAgeMinutes: 60,
};

const NOW = new Date("2026-10-04T15:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const daysAgo = (d: number) => minutesAgo(d * 24 * 60);

function opp(over: Partial<HistoryOpportunity>): HistoryOpportunity {
  return { id: "opp", createdAt: daysAgo(1), pipelineStageId: STAGE.buyerLeads, assignedTo: null, ...over };
}
function subject(over: Partial<HistorySubject["contact"]>, opportunities: HistoryOpportunity[] = [], appointmentCount = 0): HistorySubject {
  return { contact: { id: "c1", dateAdded: daysAgo(30), assignedTo: null, tags: [], isaNotes: null, ...over }, opportunities, appointmentCount };
}

describe("classifyLeadHistory", () => {
  it("flags Glen White — an old lead assigned to Stephanie, tagged appt booked — as returning, owned by Stephanie", () => {
    const glen = subject(
      { id: "l0s8oGXEeGUMOMph6th8", dateAdded: daysAgo(46), assignedTo: STEPHANIE, tags: ["buyer lead", "appt booked"] },
      [
        opp({ id: "old", createdAt: daysAgo(46), pipelineStageId: STAGE.showedUp, assignedTo: STEPHANIE }),
        opp({ id: "fresh", createdAt: minutesAgo(2), pipelineStageId: STAGE.buyerLeads }),
      ]
    );

    const result = classifyLeadHistory({ self: glen, now: NOW }, CONFIG);

    expect(result.returning).toBe(true);
    expect(result.assignedUserId).toBe(STEPHANIE);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        { kind: "assigned", userId: STEPHANIE },
        { kind: "worked_stage", stageId: STAGE.showedUp },
        { kind: "touch_tag", tag: "appt booked" },
      ])
    );
    expect(result.firstSeen).toBe(daysAgo(46));
  });

  it("sees the OLD card in Live Transferred even though a fresh intake card is the newest — the case isFirstTouch's 'newest open opportunity' check misses", () => {
    const lead = subject({ dateAdded: daysAgo(10) }, [
      opp({ id: "old", createdAt: daysAgo(10), pipelineStageId: STAGE.liveTransferred }),
      opp({ id: "fresh", createdAt: minutesAgo(1), pipelineStageId: STAGE.buyerLeads }),
    ]);

    const result = classifyLeadHistory({ self: lead, now: NOW }, CONFIG);

    expect(result.returning).toBe(true);
    expect(result.reasons).toContainEqual({ kind: "worked_stage", stageId: STAGE.liveTransferred });
  });

  it("does NOT flag Saife Sarwar — a brand-new lead who replied to the text automation, with one same-day card and no assignee", () => {
    const saife = subject(
      { id: "grh8b9zNOX1h9VKZncmF", dateAdded: minutesAgo(3), tags: ["buyer lead", "replied"], isaNotes: null },
      [opp({ id: "only", createdAt: minutesAgo(3), pipelineStageId: STAGE.buyerLeads })]
    );

    expect(classifyLeadHistory({ self: saife, now: NOW }, CONFIG).returning).toBe(false);
  });

  it("does NOT treat a brand-new contact as returning even if GHL auto-assigned it at creation (a future client with round-robin)", () => {
    const autoAssigned = subject({ dateAdded: minutesAgo(1), assignedTo: STEPHANIE }, [opp({ createdAt: minutesAgo(1) })]);

    expect(classifyLeadHistory({ self: autoAssigned, now: NOW }, CONFIG).returning).toBe(false);
  });

  it("treats an old contact nobody ever worked as NEW (Mark's call) — only intake / automated stages, no assignee, no tags, no notes", () => {
    const stale = subject({ dateAdded: daysAgo(90), tags: ["buyer lead", "replied"] }, [
      opp({ createdAt: daysAgo(90), pipelineStageId: STAGE.day1 }),
      opp({ createdAt: daysAgo(80), pipelineStageId: STAGE.replied }),
      opp({ createdAt: daysAgo(70), pipelineStageId: STAGE.longTermNurturing }),
      opp({ createdAt: minutesAgo(1), pipelineStageId: STAGE.buyerLeads }),
    ]);

    expect(classifyLeadHistory({ self: stale, now: NOW }, CONFIG).returning).toBe(false);
  });

  it("flags an appointment-tagged lead with NO assignee as returning, with no owner to alert", () => {
    const orphan = subject({ dateAdded: daysAgo(20), tags: ["appt booked"] }, [opp({ createdAt: daysAgo(20) })]);

    const result = classifyLeadHistory({ self: orphan, now: NOW }, CONFIG);

    expect(result.returning).toBe(true);
    expect(result.assignedUserId).toBeNull();
  });

  it("picks up an assignee that exists only on an opportunity, not the contact", () => {
    const lead = subject({ dateAdded: daysAgo(20) }, [opp({ createdAt: daysAgo(20), assignedTo: STEPHANIE })]);

    const result = classifyLeadHistory({ self: lead, now: NOW }, CONFIG);

    expect(result.returning).toBe(true);
    expect(result.assignedUserId).toBe(STEPHANIE);
  });

  it("counts a real appointment on record", () => {
    const lead = subject({ dateAdded: daysAgo(20) }, [opp({ createdAt: daysAgo(20) })], 2);

    expect(classifyLeadHistory({ self: lead, now: NOW }, CONFIG).reasons).toContainEqual({ kind: "appointment", count: 2 });
  });

  it("counts ISA notes an agent wrote as a reason ALONGSIDE something stronger, but never Iris's own status lines", () => {
    const human = subject({ dateAdded: daysAgo(20), assignedTo: STEPHANIE, isaNotes: "ISA NOTES : Buyer: Justin — first-time home buyer<br/>Timeline: 1–4 months" });
    expect(classifyLeadHistory({ self: human, now: NOW }, CONFIG).reasons).toContainEqual({ kind: "human_notes" });

    const irisOnly = subject({
      dateAdded: daysAgo(20),
      isaNotes: "Iris call Thursday, September 24 at 5:47 PM — ❌ No answer (`customer-did-not-answer`). Duration: 30s.\n\nIris: lead asked to be called back — scheduled for Thursday, October 1 at 6:54 PM.",
    });
    expect(classifyLeadHistory({ self: irisOnly, now: NOW }, CONFIG).returning).toBe(false);
  });

  /**
   * Koren Pye, 2026-10-10: a Feb lead with old ISA notes and a card assigned
   * to a user who has since been deleted. Jacob: "that lead was not previously
   * assigned to an agent. So Iris should call them."
   */
  it("does NOT flag a lead whose only history is old ISA notes — nobody owns them, Iris should call", () => {
    const koren = subject({ dateAdded: daysAgo(224), isaNotes: "ISA NOTES: Buyer — wants a new build, 3 bed" }, [opp({ createdAt: daysAgo(224) })]);
    const out = classifyLeadHistory({ self: koren, now: NOW }, CONFIG);

    expect(out.returning).toBe(false);
    expect(out.preExisting).toBe(true); // an existing contact resubmitting — to be called as a new lead
  });

  it("ignores an assignment to a user who no longer exists (a deleted login is not an agent)", () => {
    const deleted = "0bl2mebGKSbtIX4OrQuH";
    const koren = subject({ dateAdded: daysAgo(224), isaNotes: "ISA NOTES: Buyer — wants a new build" }, [opp({ createdAt: daysAgo(224), assignedTo: deleted })]);

    const out = classifyLeadHistory({ self: koren, now: NOW, activeUserIds: [STEPHANIE, "someone-else"] }, CONFIG);

    expect(out.returning).toBe(false);
    expect(out.assignedUserId).toBeNull();
  });

  it("still counts an assignment to a current user", () => {
    const lead = subject({ dateAdded: daysAgo(30), assignedTo: STEPHANIE });

    const out = classifyLeadHistory({ self: lead, now: NOW, activeUserIds: [STEPHANIE] }, CONFIG);

    expect(out.returning).toBe(true);
    expect(out.assignedUserId).toBe(STEPHANIE);
  });

  it("counts every assignment when the user list couldn't be read — the cautious direction", () => {
    const lead = subject({ dateAdded: daysAgo(30), assignedTo: "whoever" });

    expect(classifyLeadHistory({ self: lead, now: NOW, activeUserIds: null }, CONFIG).returning).toBe(true);
  });

  it("ignores the 'replied' tag — answering the text automation is engagement, not contact", () => {
    const replied = subject({ dateAdded: daysAgo(20), tags: ["buyer lead", "replied"] }, [opp({ createdAt: daysAgo(20) })]);

    expect(classifyLeadHistory({ self: replied, now: NOW }, CONFIG).returning).toBe(false);
  });

  it("finds the history on a DUPLICATE contact record of the same person when the new record is clean", () => {
    const newRecord = subject({ id: "new", dateAdded: minutesAgo(2) }, [opp({ createdAt: minutesAgo(2) })]);
    const oldRecord = subject({ id: "old", dateAdded: daysAgo(40), assignedTo: STEPHANIE, tags: ["live transferred"] }, [
      opp({ createdAt: daysAgo(40), pipelineStageId: STAGE.liveTransferred, assignedTo: STEPHANIE }),
    ]);

    const result = classifyLeadHistory({ self: newRecord, duplicates: [oldRecord], now: NOW }, CONFIG);

    expect(result.returning).toBe(true);
    expect(result.assignedUserId).toBe(STEPHANIE);
    expect(result.historyContactId).toBe("old");
  });

  it("treats every card as history when even the newest is old — no fresh card was created for this re-entry", () => {
    const lead = subject({ dateAdded: daysAgo(20) }, [opp({ createdAt: daysAgo(20), pipelineStageId: STAGE.liveTransferred })]);

    expect(classifyLeadHistory({ self: lead, now: NOW }, CONFIG).returning).toBe(true);
  });

  it("reads a contact with no dateAdded as not-pre-existing rather than guessing it's old", () => {
    const lead = subject({ dateAdded: null, assignedTo: STEPHANIE });

    expect(classifyLeadHistory({ self: lead, now: NOW }, CONFIG).returning).toBe(false);
  });
});
