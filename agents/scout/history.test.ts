import { describe, expect, it } from "vitest";
import { classifyLeadHistory, HistoryConfig, HistoryOpportunity, HistorySubject, resolveAssignee } from "./history";

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

  it("counts ISA notes an agent wrote, but never Iris's own status lines", () => {
    const human = subject({ dateAdded: daysAgo(20), isaNotes: "ISA NOTES : Buyer: Justin — first-time home buyer<br/>Timeline: 1–4 months" });
    expect(classifyLeadHistory({ self: human, now: NOW }, CONFIG).reasons).toContainEqual({ kind: "human_notes" });

    const irisOnly = subject({
      dateAdded: daysAgo(20),
      isaNotes: "Iris call Thursday, September 24 at 5:47 PM — ❌ No answer (`customer-did-not-answer`). Duration: 30s.\n\nIris: lead asked to be called back — scheduled for Thursday, October 1 at 6:54 PM.",
    });
    expect(classifyLeadHistory({ self: irisOnly, now: NOW }, CONFIG).returning).toBe(false);
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

/**
 * Mark, 2026-10-11: 102 of 289 cards in 3%'s pipeline carry an OLD user code for
 * Genna Hickey, Charlene Harnum or Stephanie McGrath — the same people under an
 * earlier user record. Koren Pye's card carried Genna's old code, which read as
 * "not an agent" and left Genna with no alert.
 */
describe("legacy user codes", () => {
  const GENNA_OLD = "0bl2mebGKSbtIX4OrQuH";
  const GENNA_NOW = "XnTRNyagVeoyvpqDAHda";
  const LEGACY = { [GENNA_OLD]: GENNA_NOW, tX9WeRoJ6eWbDsqZVLs3: "1A5sJpqYGI2IvSYpS5s3" };
  const WITH_LEGACY: HistoryConfig = { ...CONFIG, legacyUserIds: LEGACY };

  it("reads Koren Pye — an old lead whose CARD carries Genna's old code — as returning, owned by Genna's current id", () => {
    const koren = subject({ dateAdded: daysAgo(224) }, [opp({ createdAt: daysAgo(224), assignedTo: GENNA_OLD })]);

    const out = classifyLeadHistory({ self: koren, now: NOW }, WITH_LEGACY);

    expect(out.returning).toBe(true);
    expect(out.assignedUserId).toBe(GENNA_NOW);
    expect(out.reasons).toContainEqual({ kind: "assigned", userId: GENNA_NOW });
  });

  it("translates an old code on the contact itself too", () => {
    const lead = subject({ dateAdded: daysAgo(40), assignedTo: "tX9WeRoJ6eWbDsqZVLs3" });

    expect(classifyLeadHistory({ self: lead, now: NOW }, WITH_LEGACY).assignedUserId).toBe("1A5sJpqYGI2IvSYpS5s3");
  });

  it("leaves a current user's id, and an id it has never heard of, exactly as they are", () => {
    expect(resolveAssignee(STEPHANIE, LEGACY)).toBe(STEPHANIE);
    expect(resolveAssignee("someUnknownCode123", LEGACY)).toBe("someUnknownCode123");
    expect(resolveAssignee(GENNA_OLD, undefined)).toBe(GENNA_OLD);
  });

  it("still matches a code that was copied by eye with l/I/1 or O/0 mixed up", () => {
    expect(resolveAssignee("Obl2mebGKSbtlX4OrQuH", LEGACY)).toBe(GENNA_NOW);
    expect(resolveAssignee("0BL2MEBGKSBTIX4ORQUH", LEGACY)).toBe(GENNA_NOW);
  });
});
