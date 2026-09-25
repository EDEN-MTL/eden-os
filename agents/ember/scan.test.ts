import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  enrollLead: vi.fn(async (input: any) => ({ id: 99, ...input })),
  hasPendingIrisCall: vi.fn(async () => false),
  trackedByOpportunity: vi.fn(async () => new Map()),
  transitionStatus: vi.fn(async () => true),
}));
vi.mock("./store", () => store);

const configMod = vi.hoisted(() => ({
  loadEmberConfig: vi.fn(),
  loadEmberOutcomeStages: vi.fn(),
}));
vi.mock("./config", async (orig) => ({ ...(await orig<any>()), ...configMod }));

import { classifyForEnrollment, detectChange, detectIntent, EnrollContext, firstTouchAt, runEmberScanForClient, ScanDeps } from "./scan";
import { config, daysAgo, lead, NOW, opp, OUTCOME_STAGES, STAGES } from "./test-fixtures";

afterEach(() => vi.clearAllMocks());

const ctx = (over: Partial<EnrollContext> = {}): EnrollContext => ({
  config: config(),
  outcomeStages: OUTCOME_STAGES,
  stageNames: STAGES,
  now: NOW,
  thresholdDays: 45,
  ...over,
});

describe("classifyForEnrollment", () => {
  it("enrolls an open, quiet card inside the consent window", () => {
    expect(classifyForEnrollment(opp(), ctx())).toEqual({ eligible: true });
  });

  it.each([
    ["won stage", { pipelineStageId: "s_closed" }, "won/lost stage"],
    ["lost stage", { pipelineStageId: "s_lost" }, "won/lost stage"],
    ["active stage", { pipelineStageId: "s_confirmed" }, "active stage"],
    ["excluded stage", { pipelineStageId: "s_appt" }, "excluded stage"],
    ["GHL status lost", { status: "lost" }, "status lost"],
    ["other pipeline", { pipelineId: "p2" }, "other pipeline"],
    ["unknown stage id", { pipelineStageId: "nope" }, "unknown stage"],
    ["recent stage change", { lastStageChangeAt: daysAgo(10) }, "not dormant yet"],
  ])("skips %s", (_label, over, reason) => {
    expect(classifyForEnrollment(opp(over as any), ctx())).toEqual({ eligible: false, reason });
  });

  it("still enrolls a lead whose original inquiry is 6+ months old — consent is judged at the first touch, with history", () => {
    expect(classifyForEnrollment(opp({ createdAt: daysAgo(400), lastStageChangeAt: daysAgo(300) }), ctx())).toEqual({ eligible: true });
  });

  it("with includeStages set, only enrolls from those stages (Mark, 2026-09-25)", () => {
    const c = ctx({ config: config({ includeStages: ["Long Term Nurturing", "Replied"] }) });
    expect(classifyForEnrollment(opp({ pipelineStageId: "s_nurture" }), c)).toEqual({ eligible: true });
    expect(classifyForEnrollment(opp({ pipelineStageId: "s_day1" }), c)).toEqual({ eligible: false, reason: "not a nurture stage" });
  });

  it("skips a contact with no phone and no email", () => {
    const o = opp({ contact: { name: "X", phone: null, email: null, tags: [] } });
    expect(classifyForEnrollment(o, ctx())).toEqual({ eligible: false, reason: "no phone or email" });
  });

  it("skips a contact already tagged with renewed interest (case-insensitive)", () => {
    const o = opp({ contact: { name: "X", phone: "+1", email: null, tags: ["Renewed Interest"] } });
    expect(classifyForEnrollment(o, ctx())).toEqual({ eligible: false, reason: "renewed-interest tag" });
  });

  it("falls back to createdAt for a card that never changed stage", () => {
    expect(classifyForEnrollment(opp({ lastStageChangeAt: null, createdAt: daysAgo(50) }), ctx())).toEqual({ eligible: true });
    expect(classifyForEnrollment(opp({ lastStageChangeAt: null, createdAt: daysAgo(20) }), ctx()).eligible).toBe(false);
  });

  it("ignores updatedAt, which GHL bumps for non-deal edits", () => {
    expect(classifyForEnrollment(opp({ updatedAt: daysAgo(0) }), ctx())).toEqual({ eligible: true });
  });
});

describe("detectChange", () => {
  it("reports nothing when the card hasn't moved", () => {
    expect(detectChange(lead(), opp(), ctx())).toEqual({ kind: "none" });
  });

  it("reactivates when the card moved to another column", () => {
    const change = detectChange(lead(), opp({ pipelineStageId: "s_confirmed", lastStageChangeAt: daysAgo(0) }), ctx());
    expect(change).toEqual({ kind: "reactivated", reason: 'card moved from "Long Term Nurturing" to "Buyer Confirmed"' });
  });

  it("reactivates when the card was moved out and back", () => {
    expect(detectChange(lead(), opp({ lastStageChangeAt: daysAgo(0) }), ctx()).kind).toBe("reactivated");
  });

  it("reactivates on a renewed-interest tag", () => {
    const o = opp({ contact: { tags: ["renewed interest"] } });
    expect(detectChange(lead(), o, ctx())).toEqual({ kind: "reactivated", reason: 'tagged "renewed interest"' });
  });

  it("exits quietly when won or lost, even though the card moved", () => {
    expect(detectChange(lead(), opp({ pipelineStageId: "s_closed" }), ctx()).kind).toBe("exited");
    expect(detectChange(lead(), opp({ pipelineStageId: "s_lost" }), ctx()).kind).toBe("exited");
  });
});

describe("firstTouchAt", () => {
  it("offsets from enrollment by the first schedule entry", () => {
    expect(firstTouchAt(NOW, [2, 14])?.toISOString()).toBe(new Date(NOW.getTime() + 2 * 86_400_000).toISOString());
    expect(firstTouchAt(NOW, [])).toBeNull();
  });
});

describe("runEmberScanForClient", () => {
  function deps(opps: any[], over: Partial<ScanDeps> = {}): ScanDeps {
    return {
      listOpportunities: async function* () {
        for (const o of opps) yield o;
      },
      stageNames: async () => STAGES,
      hasPendingIrisCall: async () => false,
      alert: vi.fn(async () => {}),
      ...over,
    };
  }

  function setup() {
    configMod.loadEmberConfig.mockReturnValue(config());
    configMod.loadEmberOutcomeStages.mockReturnValue(OUTCOME_STAGES);
  }

  it("enrolls eligible cards and counts skip reasons", async () => {
    setup();
    const report = await runEmberScanForClient("c", {
      now: NOW,
      deps: deps([opp(), opp({ id: "o2", pipelineStageId: "s_closed" }), opp({ id: "o3", lastStageChangeAt: daysAgo(3) })]),
    });
    expect(report.enrolled.map((e) => e.opportunityId)).toEqual(["o1"]);
    expect(report.skipped).toEqual({ "won/lost stage": 1, "not dormant yet": 1 });
    expect(store.enrollLead).toHaveBeenCalledWith(
      expect.objectContaining({ ghlOpportunityId: "o1", enrolledStageName: "Long Term Nurturing", nextTouchAt: NOW.toISOString() })
    );
  });

  it("writes nothing in a dry run", async () => {
    setup();
    const report = await runEmberScanForClient("c", { now: NOW, dryRun: true, deps: deps([opp()]) });
    expect(report.eligible).toHaveLength(1);
    expect(report.enrolled).toHaveLength(0);
    expect(store.enrollLead).not.toHaveBeenCalled();
  });

  it("honours a threshold override for live validation", async () => {
    setup();
    const report = await runEmberScanForClient("c", {
      now: NOW,
      dryRun: true,
      thresholdDaysOverride: 1,
      deps: deps([opp({ lastStageChangeAt: daysAgo(3) })]),
    });
    expect(report.eligible).toHaveLength(1);
  });

  it("skips a contact Iris is about to call", async () => {
    setup();
    const report = await runEmberScanForClient("c", {
      now: NOW,
      deps: deps([opp()], { hasPendingIrisCall: async () => true }),
    });
    expect(report.skipped).toEqual({ "iris call pending": 1 });
    expect(store.enrollLead).not.toHaveBeenCalled();
  });

  it("marks a tracked lead reactivated and alerts once", async () => {
    setup();
    store.trackedByOpportunity.mockResolvedValueOnce(new Map([["o1", lead()]]));
    const d = deps([opp({ pipelineStageId: "s_confirmed", lastStageChangeAt: daysAgo(0) })]);
    const report = await runEmberScanForClient("c", { now: NOW, deps: d });
    expect(report.reactivated).toHaveLength(1);
    expect(store.transitionStatus).toHaveBeenCalledWith(1, ["nurturing", "paused", "completed"], expect.objectContaining({ status: "reactivated" }));
    expect(d.alert).toHaveBeenCalledTimes(1);
    expect((d.alert as any).mock.calls[0][0]).toContain("Jordan Smith");
  });

  it("does not alert when another path already reactivated the lead", async () => {
    setup();
    store.trackedByOpportunity.mockResolvedValueOnce(new Map([["o1", lead()]]));
    store.transitionStatus.mockResolvedValueOnce(false);
    const d = deps([opp({ pipelineStageId: "s_confirmed" })]);
    const report = await runEmberScanForClient("c", { now: NOW, deps: d });
    expect(report.reactivated).toHaveLength(0);
    expect(d.alert).not.toHaveBeenCalled();
  });

  it("leaves already-final leads alone", async () => {
    setup();
    store.trackedByOpportunity.mockResolvedValueOnce(new Map([["o1", lead({ status: "opted_out" })]]));
    const d = deps([opp({ pipelineStageId: "s_confirmed" })]);
    const report = await runEmberScanForClient("c", { now: NOW, deps: d });
    expect(report.reactivated).toHaveLength(0);
    expect(store.transitionStatus).not.toHaveBeenCalled();
  });

  it("fails loudly when the pipeline id resolves to no stages", async () => {
    setup();
    await expect(
      runEmberScanForClient("c", { now: NOW, deps: deps([], { stageNames: async () => ({}) }) })
    ).rejects.toThrow(/resolved to no stages/);
  });
});

describe("detectIntent", () => {
  const c = config();
  it("reads buyer/seller from tags first", () => {
    expect(detectIntent(opp({ contact: { tags: ["Buyer Lead"] } }), "Long Term Nurturing", c)).toBe("buyer");
    expect(detectIntent(opp({ contact: { tags: ["seller lead"] } }), "Buyer Leads", c)).toBe("seller");
  });
  it("falls back to the enrolled stage name", () => {
    expect(detectIntent(opp({ contact: { tags: [] } }), "Buyer Leads", c)).toBe("buyer");
  });
  it("is unknown when tags conflict or nothing matches — never a guess", () => {
    expect(detectIntent(opp({ contact: { tags: ["buyer lead", "seller lead"] } }), "Long Term Nurturing", c)).toBe("unknown");
    expect(detectIntent(opp({ contact: { tags: [] } }), "Long Term Nurturing", c)).toBe("unknown");
  });
});

describe("runEmberScanForClient — onlyOpportunityIds (live tests)", () => {
  it("ignores every other opportunity in the pipeline", async () => {
    configMod.loadEmberConfig.mockReturnValue(config());
    configMod.loadEmberOutcomeStages.mockReturnValue(OUTCOME_STAGES);
    const report = await runEmberScanForClient("c", {
      now: NOW,
      onlyOpportunityIds: ["o2"],
      deps: {
        listOpportunities: async function* () { yield opp({ id: "o1" }); yield opp({ id: "o2", contactId: "c2" }); },
        stageNames: async () => STAGES,
        hasPendingIrisCall: async () => false,
        alert: vi.fn(async () => {}),
      },
    });
    expect(report.scanned).toBe(1);
    expect(report.enrolled.map((e) => e.opportunityId)).toEqual(["o2"]);
  });
});
