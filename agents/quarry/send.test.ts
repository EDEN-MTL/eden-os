import { afterEach, describe, expect, it, vi } from "vitest";

const configMod = vi.hoisted(() => ({ loadQuarryConfig: vi.fn() }));
vi.mock("./config", () => configMod);

const store = vi.hoisted(() => ({ listLeads: vi.fn() }));
vi.mock("./store", () => store);

const depsMod = vi.hoisted(() => ({
  buildOutreachDeps: vi.fn(async () => ({ sendMMS: vi.fn(), sendSMS: vi.fn(), moveStage: vi.fn(), wait: vi.fn() })),
  buildEmailDeps: vi.fn(async () => ({ sendEmail: vi.fn(), moveStage: vi.fn(), wait: vi.fn() })),
}));
vi.mock("./deps", () => depsMod);

const outreachMod = vi.hoisted(() => ({
  sendSmsBatch: vi.fn(async (leads: any[]) => ({
    attempted: leads.length, sent: leads.length, skipped: [], failed: [], capReached: false,
  })),
  sendEmailBatch: vi.fn(async (leads: any[]) => ({
    attempted: leads.length, sent: leads.length, skipped: [], failed: [], capReached: false,
  })),
}));
vi.mock("./outreach", () => outreachMod);

import { QuarryDisabledError, sendPending } from "./send";
import { QuarryLead } from "./types";

afterEach(() => vi.clearAllMocks());

const CONFIG: any = {
  enabled: true,
  outreach: {
    nudgeAfterDays: 3,
    email: { fromDomain: "edensites.ca", physicalAddress: "123 Rue Test", nudgeScheduleDays: [4, 10] },
  },
};

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function lead(over: Partial<QuarryLead> = {}): QuarryLead {
  return {
    id: 1, clientId: "eden", placeId: "p", name: "Biz", formattedAddress: null,
    phone: "+15145550100", phoneLineType: "mobile", isMobile: true, email: null,
    emailSource: null, hasPublicEmail: false, website: null, category: "trade-service",
    searchQuery: null, rating: null, userRatingsTotal: null, businessStatus: null,
    photoRefs: [], isCandidate: true, reasons: [], outdatedScore: null, outdatedReasoning: null,
    previewUrl: "https://p.test", previewImageUrl: "https://p.test/i.png", generator: "lovable",
    generationError: null, ghlContactId: "c1", ghlOpportunityId: "o1", pipelineStage: "New Lead",
    approvalStatus: "approved", dnclChecked: false, holdoutReason: null, sentAt: null, repliedAt: null,
    emailSentAt: null, emailRepliedAt: null, emailOptedOut: false, emailNudgeCount: 0, emailUnsubscribeToken: "tok",
    lastLookupAt: null, createdAt: "", updatedAt: "", ...over,
  };
}

describe("sendPending — guards", () => {
  it("refuses to run when the kill switch is off", async () => {
    configMod.loadQuarryConfig.mockReturnValue({ ...CONFIG, enabled: false });
    store.listLeads.mockResolvedValue([]);
    await expect(sendPending("eden", { log: () => {} })).rejects.toBeInstanceOf(QuarryDisabledError);
  });

  it("skips email cleanly, without throwing, when the channel isn't configured", async () => {
    configMod.loadQuarryConfig.mockReturnValue({
      ...CONFIG,
      outreach: { ...CONFIG.outreach, email: { ...CONFIG.outreach.email, fromDomain: "" } },
    });
    store.listLeads.mockResolvedValue([lead()]);
    const report = await sendPending("eden", { log: () => {} });
    expect(report.emailPitch.attempted).toBe(0);
    expect(outreachMod.sendEmailBatch).not.toHaveBeenCalled();
    // SMS must still run — one channel not being ready must not block the other.
    expect(outreachMod.sendSmsBatch).toHaveBeenCalled();
  });
});

describe("sendPending — candidate selection", () => {
  it("sends a fresh pitch to a mobile lead that has never been texted", async () => {
    configMod.loadQuarryConfig.mockReturnValue(CONFIG);
    store.listLeads.mockResolvedValue([lead({ id: 1, sentAt: null })]);
    await sendPending("eden", { log: () => {} });
    const pitchCall = outreachMod.sendSmsBatch.mock.calls.find((c: any) => c[1] === "screenshot");
    expect(pitchCall![0]).toHaveLength(1);
  });

  it("does not re-pitch a lead already sent, and does not nudge one not yet due", async () => {
    configMod.loadQuarryConfig.mockReturnValue(CONFIG);
    store.listLeads.mockResolvedValue([
      lead({ id: 1, sentAt: daysAgo(1) }), // sent yesterday, not due for a nudge (needs 3 days)
    ]);
    await sendPending("eden", { log: () => {} });
    const pitchCall = outreachMod.sendSmsBatch.mock.calls.find((c: any) => c[1] === "screenshot")!;
    const nudgeCall = outreachMod.sendSmsBatch.mock.calls.find((c: any) => c[1] === "nudge")!;
    expect(pitchCall[0]).toHaveLength(0);
    expect(nudgeCall[0]).toHaveLength(0);
  });

  it("nudges a lead once its wait has passed with no reply", async () => {
    configMod.loadQuarryConfig.mockReturnValue(CONFIG);
    store.listLeads.mockResolvedValue([lead({ id: 1, sentAt: daysAgo(5), repliedAt: null })]);
    await sendPending("eden", { log: () => {} });
    const nudgeCall = outreachMod.sendSmsBatch.mock.calls.find((c: any) => c[1] === "nudge")!;
    expect(nudgeCall[0]).toHaveLength(1);
  });

  it("never nudges a lead that already replied", async () => {
    // The nudge exists to prompt silence, not to pester someone who answered.
    configMod.loadQuarryConfig.mockReturnValue(CONFIG);
    store.listLeads.mockResolvedValue([lead({ id: 1, sentAt: daysAgo(10), repliedAt: daysAgo(9) })]);
    await sendPending("eden", { log: () => {} });
    const nudgeCall = outreachMod.sendSmsBatch.mock.calls.find((c: any) => c[1] === "nudge")!;
    expect(nudgeCall[0]).toHaveLength(0);
  });

  it("sends nudges before new pitches", async () => {
    // A nudge is time-sensitive; a fresh pitch can wait a day if the shared
    // cap runs out on nudges first.
    configMod.loadQuarryConfig.mockReturnValue(CONFIG);
    store.listLeads.mockResolvedValue([
      lead({ id: 1, sentAt: daysAgo(5) }),
      lead({ id: 2, sentAt: null }),
    ]);
    await sendPending("eden", { log: () => {} });
    const steps = outreachMod.sendSmsBatch.mock.calls.map((c: any) => c[1]);
    expect(steps.indexOf("nudge")).toBeLessThan(steps.indexOf("screenshot"));
  });

  it("routes a landline lead to email only, never SMS", async () => {
    configMod.loadQuarryConfig.mockReturnValue(CONFIG);
    store.listLeads.mockResolvedValue([
      lead({ id: 1, isMobile: false, phoneLineType: "landline", email: "info@biz.ca" }),
    ]);
    await sendPending("eden", { log: () => {} });
    const smsPitchCall = outreachMod.sendSmsBatch.mock.calls.find((c: any) => c[1] === "screenshot")!;
    const emailPitchCall = outreachMod.sendEmailBatch.mock.calls.find((c: any) => c[1] === "email_pitch")!;
    expect(smsPitchCall[0]).toHaveLength(0);
    expect(emailPitchCall[0]).toHaveLength(1);
  });

  it("never emails a lead that opted out, even if otherwise due", async () => {
    configMod.loadQuarryConfig.mockReturnValue(CONFIG);
    store.listLeads.mockResolvedValue([
      lead({ id: 1, email: "info@biz.ca", emailOptedOut: true, emailSentAt: daysAgo(10) }),
    ]);
    await sendPending("eden", { log: () => {} });
    const emailNudgeCall = outreachMod.sendEmailBatch.mock.calls.find((c: any) => c[1] === "email_nudge")!;
    const emailPitchCall = outreachMod.sendEmailBatch.mock.calls.find((c: any) => c[1] === "email_pitch")!;
    expect(emailNudgeCall[0]).toHaveLength(0);
    expect(emailPitchCall[0]).toHaveLength(0);
  });

  describe("multi-touch email nudges", () => {
    it("sends the FIRST nudge at the first schedule threshold (day 4)", async () => {
      configMod.loadQuarryConfig.mockReturnValue(CONFIG);
      store.listLeads.mockResolvedValue([
        lead({ id: 1, email: "info@biz.ca", emailSentAt: daysAgo(4), emailNudgeCount: 0 }),
      ]);
      await sendPending("eden", { log: () => {} });
      const emailNudgeCall = outreachMod.sendEmailBatch.mock.calls.find((c: any) => c[1] === "email_nudge")!;
      expect(emailNudgeCall[0]).toHaveLength(1);
    });

    it("does not send a second nudge before its OWN threshold (day 10), even past the first", async () => {
      configMod.loadQuarryConfig.mockReturnValue(CONFIG);
      store.listLeads.mockResolvedValue([
        // 6 days since pitch, already had 1 nudge — next threshold is day 10.
        lead({ id: 1, email: "info@biz.ca", emailSentAt: daysAgo(6), emailNudgeCount: 1 }),
      ]);
      await sendPending("eden", { log: () => {} });
      const emailNudgeCall = outreachMod.sendEmailBatch.mock.calls.find((c: any) => c[1] === "email_nudge")!;
      expect(emailNudgeCall[0]).toHaveLength(0);
    });

    it("sends the SECOND nudge once day 10 has passed", async () => {
      configMod.loadQuarryConfig.mockReturnValue(CONFIG);
      store.listLeads.mockResolvedValue([
        lead({ id: 1, email: "info@biz.ca", emailSentAt: daysAgo(10), emailNudgeCount: 1 }),
      ]);
      await sendPending("eden", { log: () => {} });
      const emailNudgeCall = outreachMod.sendEmailBatch.mock.calls.find((c: any) => c[1] === "email_nudge")!;
      expect(emailNudgeCall[0]).toHaveLength(1);
    });

    it("stops nudging once every scheduled touch has been used up", async () => {
      // Schedule is [4, 10] — length 2. A lead with 2 nudges already sent has
      // had every touch and gets nothing further, no matter how much time
      // has passed since.
      configMod.loadQuarryConfig.mockReturnValue(CONFIG);
      store.listLeads.mockResolvedValue([
        lead({ id: 1, email: "info@biz.ca", emailSentAt: daysAgo(30), emailNudgeCount: 2 }),
      ]);
      await sendPending("eden", { log: () => {} });
      const emailNudgeCall = outreachMod.sendEmailBatch.mock.calls.find((c: any) => c[1] === "email_nudge")!;
      expect(emailNudgeCall[0]).toHaveLength(0);
    });
  });
});
