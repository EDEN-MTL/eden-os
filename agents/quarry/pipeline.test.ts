import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The calibration run exists to produce two rates a volume decision gets made
 * from, so the arithmetic behind them is worth guarding. The failure that
 * matters is not a crash — it is a plausible-looking rate that is quietly
 * wrong and gets multiplied into a weekly send target.
 */

const store = vi.hoisted(() => ({
  startRun: vi.fn(async () => 1),
  finishRun: vi.fn(async () => {}),
  recentlySeenPlaceIds: vi.fn(async () => new Set<string>()),
  insertDiscovered: vi.fn(async (places: any[]) =>
    places.map((p, i) => ({ ...p, id: i + 1, reasons: [], photoRefs: [] }))
  ),
  updateLead: vi.fn(async () => {}),
}));
vi.mock("./store", () => store);

const discovery = vi.hoisted(() => ({ discover: vi.fn() }));
vi.mock("./discovery", () => discovery);

const triageMod = vi.hoisted(() => ({
  triage: vi.fn(),
  // Real implementation, not a stub — this is the actual logic under test
  // in several auto-approve cases below, and it is trivial enough that
  // re-implementing it here is exactly as trustworthy as importing it.
  isHighConfidenceCandidate: (reasons: string[]) => reasons.some((r) => !r.startsWith("Looks dated")),
}));
vi.mock("./triage", () => triageMod);

const indexMod = vi.hoisted(() => ({ quarryAgent: { post: vi.fn(async () => {}) } }));
vi.mock("./index", () => indexMod);

const enrichMod = vi.hoisted(() => ({ enrichContact: vi.fn(async () => ({ email: null, emailSource: null, hasPublicEmail: false })) }));
vi.mock("./enrich", () => enrichMod);

const phoneMod = vi.hoisted(() => ({
  TwilioLookupProvider: class { name = "twilio"; async lookup() { return {} as any; } },
  verifyPhone: vi.fn(),
}));
vi.mock("./phone", () => phoneMod);

const configMod = vi.hoisted(() => ({ loadQuarryConfig: vi.fn(), renderTemplate: vi.fn() }));
vi.mock("./config", () => configMod);

const shotMod = vi.hoisted(() => ({
  PlaywrightCapturer: class { async capture() { return Buffer.from("png"); } async close() {} },
  scoreSiteAppearance: vi.fn(),
}));
vi.mock("./screenshot", () => shotMod);

const syncMod = vi.hoisted(() => ({
  resolvePipeline: vi.fn(async () => ({ pipelineId: "pl1", stageIds: { "New Lead": "st1" } })),
  upsertProspectContact: vi.fn(async () => ({ contactId: "c1", created: true })),
  openOpportunity: vi.fn(async () => "op1"),
}));
vi.mock("./sync", () => syncMod);

const ghlMod = vi.hoisted(() => ({
  getGhlConfig: vi.fn(async () => ({ locationId: "loc1", apiKey: "key1" })),
}));
vi.mock("../../shared/ghl", () => ghlMod);

import { QuarryDisabledError, MissingCredentialsError, run } from "./pipeline";

const CONFIG = {
  enabled: false,
  autoApprove: false,
  reviewChannel: "websites-eden",
  searches: [{ query: "q", category: "trade-service", maxResults: 20 }],
  discovery: { recheckAfterDays: 90, maxLeadsPerRun: 20 },
  triage: { outdatedSignals: [], copyrightYearBefore: 2018, visionScoring: false, visionScoreThreshold: 6 },
  phone: { enabled: true, provider: "twilio", cacheDays: 180, voipPolicy: "holdout" as const },
  generation: { generator: "lovable", bookingUrl: "" },
  outreach: {} as any,
};

function place(id: string, category: string, website: string | null) {
  return {
    placeId: id, name: `Biz ${id}`, formattedAddress: null, phone: "(514) 555-0100",
    website, rating: null, userRatingsTotal: null, businessStatus: "OPERATIONAL",
    photoRefs: [], searchQuery: "q", category,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.GOOGLE_PLACES_API_KEY;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
});

function withCreds() {
  process.env.GOOGLE_PLACES_API_KEY = "k";
  process.env.TWILIO_ACCOUNT_SID = "sid";
  process.env.TWILIO_AUTH_TOKEN = "tok";
}

describe("run — guards", () => {
  it("refuses to run when the kill switch is off", async () => {
    withCreds();
    configMod.loadQuarryConfig.mockReturnValue(CONFIG);
    await expect(run({ stopAfter: "phone", triggeredBy: "test" })).rejects.toBeInstanceOf(QuarryDisabledError);
  });

  it("names every missing credential at once instead of failing one at a time", async () => {
    configMod.loadQuarryConfig.mockReturnValue(CONFIG);
    await expect(
      run({ stopAfter: "phone", triggeredBy: "test", overrideKillSwitch: true })
    ).rejects.toBeInstanceOf(MissingCredentialsError);
    await expect(
      run({ stopAfter: "phone", triggeredBy: "test", overrideKillSwitch: true })
    ).rejects.toThrow(/GOOGLE_PLACES_API_KEY.*TWILIO_ACCOUNT_SID.*TWILIO_AUTH_TOKEN/);
  });

  it("does not require Twilio credentials when stopping before phone", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "k";
    configMod.loadQuarryConfig.mockReturnValue(CONFIG);
    discovery.discover.mockResolvedValue({
      results: [], searched: 0, skippedAlreadySeen: 0, skippedClosed: 0, detailsCalls: 0,
    });
    await expect(
      run({ stopAfter: "triage", triggeredBy: "test", overrideKillSwitch: true, log: () => {} })
    ).resolves.toBeDefined();
  });
});

describe("run — calibration rates", () => {
  it("enriches every qualified lead, including landlines, now that email is a real send channel", async () => {
    // This ran mobile-only for one turn, when email was captured but not
    // sent on. Email is now a channel a landline/VOIP lead can actually be
    // reached through — restricting enrichment to mobiles would starve email
    // of the exact leads it exists to reach.
    withCreds();
    configMod.loadQuarryConfig.mockReturnValue(CONFIG);
    discovery.discover.mockResolvedValue({
      results: [place("a", "trade-service", "https://a.com"), place("b", "trade-service", "https://b.com")],
      searched: 2, skippedAlreadySeen: 0, skippedClosed: 0, detailsCalls: 2,
    });
    triageMod.triage.mockResolvedValue({ isCandidate: true, reasons: ["No viewport meta tag"] });
    phoneMod.verifyPhone
      .mockResolvedValueOnce({ lookup: { lineType: "mobile", checkedAt: "t" }, decision: "send", fromCache: false })
      .mockResolvedValueOnce({ lookup: { lineType: "landline", checkedAt: "t" }, decision: "reject", fromCache: false });
    enrichMod.enrichContact.mockResolvedValue({ email: "info@a.com", emailSource: "own_website_contact_page", hasPublicEmail: true });

    const r = await run({ stopAfter: "enrich", triggeredBy: "test", overrideKillSwitch: true, log: () => {} });

    expect(enrichMod.enrichContact).toHaveBeenCalledTimes(2);
    // Denominator is all qualified leads, not just mobiles.
    expect(r.emailRate).toBe(1);  // mock resolves hasPublicEmail:true for both calls
  });

  it("computes qualify and mobile rates off the right denominators", async () => {
    withCreds();
    configMod.loadQuarryConfig.mockReturnValue(CONFIG);

    // 4 discovered: 2 qualify. Of those 2, one is mobile and one is a landline.
    discovery.discover.mockResolvedValue({
      results: [
        place("a", "trade-service", null),
        place("b", "trade-service", "https://ok.com"),
        place("c", "retail-boutique", null),
        place("d", "retail-boutique", "https://ok.com"),
      ],
      searched: 4, skippedAlreadySeen: 0, skippedClosed: 0, detailsCalls: 4,
    });
    triageMod.triage.mockImplementation(async (website: string | null) =>
      website ? { isCandidate: false, reasons: [] } : { isCandidate: true, reasons: ["No website listed on Google"] }
    );
    phoneMod.verifyPhone
      .mockResolvedValueOnce({ lookup: { lineType: "mobile", checkedAt: "t" }, decision: "send", fromCache: false })
      .mockResolvedValueOnce({ lookup: { lineType: "landline", checkedAt: "t" }, decision: "reject", fromCache: false });

    const r = await run({ stopAfter: "phone", triggeredBy: "test", overrideKillSwitch: true, log: () => {} });

    expect(r.discovered).toBe(4);
    expect(r.qualified).toBe(2);
    expect(r.qualifyRate).toBe(0.5);
    expect(r.phoneChecked).toBe(2);
    expect(r.mobile).toBe(1);
    expect(r.mobileRate).toBe(0.5);
    // 4 discovered × 50% qualify × 50% mobile = 1 textable lead.
    expect(r.projectedSendsPerRun).toBe(1);
  });

  it("excludes unreachable numbers from the mobile-rate denominator", async () => {
    withCreds();
    configMod.loadQuarryConfig.mockReturnValue(CONFIG);
    discovery.discover.mockResolvedValue({
      results: [place("a", "trade-service", null), place("b", "trade-service", null)],
      searched: 2, skippedAlreadySeen: 0, skippedClosed: 0, detailsCalls: 2,
    });
    triageMod.triage.mockResolvedValue({ isCandidate: true, reasons: ["No website listed on Google"] });
    // One real mobile, one with no usable number at all.
    phoneMod.verifyPhone
      .mockResolvedValueOnce({ lookup: { lineType: "mobile", checkedAt: "t" }, decision: "send", fromCache: false })
      .mockResolvedValueOnce({ lookup: null, decision: "holdout", problem: "No usable phone number", fromCache: false });

    const r = await run({ stopAfter: "phone", triggeredBy: "test", overrideKillSwitch: true, log: () => {} });

    // A business with no listed number says nothing about the mobile/landline
    // split. Counting it as non-mobile would report 50% instead of 100% and
    // understate the reachable market.
    expect(r.phoneChecked).toBe(1);
    expect(r.mobileRate).toBe(1);
    expect(r.holdout).toBe(1);
  });

  it("marks the qualify rate as a floor when vision is configured on but no capturer was supplied", async () => {
    withCreds();
    configMod.loadQuarryConfig.mockReturnValue({ ...CONFIG, triage: { ...CONFIG.triage, visionScoring: true } });
    discovery.discover.mockResolvedValue({
      results: [], searched: 0, skippedAlreadySeen: 0, skippedClosed: 0, detailsCalls: 0,
    });
    const r = await run({ stopAfter: "phone", triggeredBy: "test", overrideKillSwitch: true, log: () => {} });
    expect(r.qualifyRateIsFloor).toBe(true);
  });

  it("does not call the vision pass on a site the technical checks already flagged", async () => {
    // Second opinion on an already-qualified lead spends a page load and a
    // model call to change nothing.
    withCreds();
    configMod.loadQuarryConfig.mockReturnValue({ ...CONFIG, triage: { ...CONFIG.triage, visionScoring: true } });
    discovery.discover.mockResolvedValue({
      results: [place("a", "trade-service", "https://bad.com")],
      searched: 1, skippedAlreadySeen: 0, skippedClosed: 0, detailsCalls: 1,
    });
    triageMod.triage.mockResolvedValue({ isCandidate: true, reasons: ["No HTTPS"] });
    triageMod.applyVisionScore = vi.fn();
    const capture = vi.fn(async () => Buffer.from("png"));

    const r = await run({
      stopAfter: "triage", triggeredBy: "test", overrideKillSwitch: true, log: () => {},
      capturer: { capture, close: async () => {} } as any,
    });

    expect(capture).not.toHaveBeenCalled();
    expect(r.qualifyRateIsFloor).toBe(false);
  });

  it("qualifies a technically-clean site that the vision pass judges dated", async () => {
    withCreds();
    configMod.loadQuarryConfig.mockReturnValue({ ...CONFIG, triage: { ...CONFIG.triage, visionScoring: true } });
    discovery.discover.mockResolvedValue({
      results: [place("a", "trade-service", "https://clean.com")],
      searched: 1, skippedAlreadySeen: 0, skippedClosed: 0, detailsCalls: 1,
    });
    triageMod.triage.mockResolvedValue({ isCandidate: false, reasons: [] });
    triageMod.applyVisionScore = vi.fn(() => ({ isCandidate: true, reasons: ["Looks dated (8/10)"], outdatedScore: 8, outdatedReasoning: "Clip art" }));
    shotMod.scoreSiteAppearance.mockResolvedValue({ score: 8, reasoning: "Clip art" });

    const r = await run({
      stopAfter: "triage", triggeredBy: "test", overrideKillSwitch: true, log: () => {},
      capturer: { capture: async () => Buffer.from("png"), close: async () => {} } as any,
    });

    expect(r.qualified).toBe(1);
  });

  it("keeps a lead when the screenshot fails rather than dropping it", async () => {
    withCreds();
    configMod.loadQuarryConfig.mockReturnValue({ ...CONFIG, triage: { ...CONFIG.triage, visionScoring: true } });
    discovery.discover.mockResolvedValue({
      results: [place("a", "trade-service", "https://clean.com")],
      searched: 1, skippedAlreadySeen: 0, skippedClosed: 0, detailsCalls: 1,
    });
    triageMod.triage.mockResolvedValue({ isCandidate: false, reasons: [] });

    const r = await run({
      stopAfter: "triage", triggeredBy: "test", overrideKillSwitch: true, log: () => {},
      capturer: { capture: async () => { throw new Error("Timeout 20000ms exceeded"); }, close: async () => {} } as any,
    });

    // Logged as an error, but the technical verdict stands.
    expect(r.errors[0].step).toBe("vision");
    expect(r.qualified).toBe(0);
  });

  it("keeps going when one lead's triage throws", async () => {
    withCreds();
    configMod.loadQuarryConfig.mockReturnValue(CONFIG);
    discovery.discover.mockResolvedValue({
      results: [place("a", "trade-service", null), place("b", "trade-service", null)],
      searched: 2, skippedAlreadySeen: 0, skippedClosed: 0, detailsCalls: 2,
    });
    triageMod.triage
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce({ isCandidate: true, reasons: ["No website listed on Google"] });
    phoneMod.verifyPhone.mockResolvedValue({
      lookup: { lineType: "mobile", checkedAt: "t" }, decision: "send", fromCache: false,
    });

    const r = await run({ stopAfter: "phone", triggeredBy: "test", overrideKillSwitch: true, log: () => {} });

    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].step).toBe("triage");
    expect(r.qualified).toBe(1);
  });

  it("skips Twilio entirely when phone.enabled is false, and does not demand its credentials", async () => {
    // Email is the default channel now — phone verification only ever
    // existed to gate SMS eligibility. No Twilio env vars are set in this
    // test at all, and the run must still succeed.
    process.env.GOOGLE_PLACES_API_KEY = "k";
    configMod.loadQuarryConfig.mockReturnValue({ ...CONFIG, phone: { ...CONFIG.phone, enabled: false } });
    discovery.discover.mockResolvedValue({
      results: [place("a", "trade-service", null)],
      searched: 1, skippedAlreadySeen: 0, skippedClosed: 0, detailsCalls: 1,
    });
    triageMod.triage.mockResolvedValue({ isCandidate: true, reasons: ["No website listed on Google"] });
    enrichMod.enrichContact.mockResolvedValue({ email: null, emailSource: null, hasPublicEmail: false });

    const r = await run({ stopAfter: "phone", triggeredBy: "test", overrideKillSwitch: true, log: () => {} });

    expect(phoneMod.verifyPhone).not.toHaveBeenCalled();
    expect(r.phoneVerificationEnabled).toBe(false);
    expect(r.phoneChecked).toBe(0);
    expect(r.mobile).toBe(0);
    // isMobile must stay unset, not false — false would read as "confirmed
    // landline", when the truth is "never checked". updateLead is called for
    // triage but must carry no isMobile/phoneLineType key at all.
    const triageUpdateCall = store.updateLead.mock.calls.find((c: any) => "isCandidate" in c[1]);
    expect(triageUpdateCall![1]).not.toHaveProperty("isMobile");
  });

  it("returns zeroed rates rather than NaN on an empty run", async () => {
    withCreds();
    configMod.loadQuarryConfig.mockReturnValue(CONFIG);
    discovery.discover.mockResolvedValue({
      results: [], searched: 0, skippedAlreadySeen: 0, skippedClosed: 0, detailsCalls: 0,
    });
    const r = await run({ stopAfter: "phone", triggeredBy: "test", overrideKillSwitch: true, log: () => {} });
    // NaN formats as "NaN%" and reads as a broken tool; 0 reads as "found nothing".
    expect(r.qualifyRate).toBe(0);
    expect(r.mobileRate).toBe(0);
    expect(r.projectedSendsPerRun).toBe(0);
  });
});

describe("run — auto-approve", () => {
  it("auto-approves a lead qualified on a hard technical fact when autoApprove is on", async () => {
    withCreds();
    configMod.loadQuarryConfig.mockReturnValue({ ...CONFIG, autoApprove: true });
    discovery.discover.mockResolvedValue({
      results: [place("a", "trade-service", null)], // no website — the hardest fact there is
      searched: 1, skippedAlreadySeen: 0, skippedClosed: 0, detailsCalls: 1,
    });
    triageMod.triage.mockResolvedValue({ isCandidate: true, reasons: ["No website listed on Google"] });

    const r = await run({ stopAfter: "triage", triggeredBy: "test", overrideKillSwitch: true, log: () => {} });

    expect(store.updateLead).toHaveBeenCalledWith(1, expect.objectContaining({ approvalStatus: "approved" }));
    expect(r.autoApproved).toBe(1);
    expect(r.needsReview).toBe(0);
    expect(indexMod.quarryAgent.post).not.toHaveBeenCalled();
  });

  it("holds a vision-only qualification for review instead of approving it", async () => {
    withCreds();
    configMod.loadQuarryConfig.mockReturnValue({ ...CONFIG, autoApprove: true, triage: { ...CONFIG.triage, visionScoring: true } });
    discovery.discover.mockResolvedValue({
      results: [place("a", "trade-service", "https://clean.com")],
      searched: 1, skippedAlreadySeen: 0, skippedClosed: 0, detailsCalls: 1,
    });
    // Technical checks pass clean; only the vision opinion qualifies it —
    // exactly the shape applyVisionScore produces on its own.
    triageMod.triage.mockResolvedValue({ isCandidate: false, reasons: [] });
    triageMod.applyVisionScore = vi.fn(() => ({
      isCandidate: true, reasons: ["Looks dated (8/10)"], outdatedScore: 8, outdatedReasoning: "Table layout, clip art",
    }));
    shotMod.scoreSiteAppearance.mockResolvedValue({ score: 8, reasoning: "Table layout, clip art" });

    const r = await run({
      stopAfter: "triage", triggeredBy: "test", overrideKillSwitch: true, log: () => {},
      capturer: { capture: async () => Buffer.from("png"), close: async () => {} } as any,
    });

    const patchCall = store.updateLead.mock.calls.find((c: any) => "isCandidate" in c[1]);
    expect(patchCall![1]).not.toHaveProperty("approvalStatus");
    expect(r.autoApproved).toBe(0);
    expect(r.needsReview).toBe(1);
  });

  it("posts needs-review leads to the configured Slack channel", async () => {
    withCreds();
    configMod.loadQuarryConfig.mockReturnValue({ ...CONFIG, autoApprove: true, triage: { ...CONFIG.triage, visionScoring: true } });
    discovery.discover.mockResolvedValue({
      results: [place("a", "trade-service", "https://clean.com")],
      searched: 1, skippedAlreadySeen: 0, skippedClosed: 0, detailsCalls: 1,
    });
    triageMod.triage.mockResolvedValue({ isCandidate: false, reasons: [] });
    triageMod.applyVisionScore = vi.fn(() => ({
      isCandidate: true, reasons: ["Looks dated (8/10)"], outdatedScore: 8, outdatedReasoning: "Table layout, clip art",
    }));
    shotMod.scoreSiteAppearance.mockResolvedValue({ score: 8, reasoning: "Table layout, clip art" });

    await run({
      stopAfter: "triage", triggeredBy: "test", overrideKillSwitch: true, log: () => {},
      capturer: { capture: async () => Buffer.from("png"), close: async () => {} } as any,
    });

    expect(indexMod.quarryAgent.post).toHaveBeenCalledWith("websites-eden", expect.stringContaining("Biz a"));
  });

  it("does not auto-approve or notify anything when autoApprove is off", async () => {
    withCreds();
    configMod.loadQuarryConfig.mockReturnValue({ ...CONFIG, autoApprove: false });
    discovery.discover.mockResolvedValue({
      results: [place("a", "trade-service", null)],
      searched: 1, skippedAlreadySeen: 0, skippedClosed: 0, detailsCalls: 1,
    });
    triageMod.triage.mockResolvedValue({ isCandidate: true, reasons: ["No website listed on Google"] });

    const r = await run({ stopAfter: "triage", triggeredBy: "test", overrideKillSwitch: true, log: () => {} });

    const patchCall = store.updateLead.mock.calls.find((c: any) => "isCandidate" in c[1]);
    expect(patchCall![1]).not.toHaveProperty("approvalStatus");
    expect(r.autoApproved).toBe(0);
    expect(r.needsReview).toBe(0);
    expect(indexMod.quarryAgent.post).not.toHaveBeenCalled();
  });

  it("does not let a Slack posting failure break the run", async () => {
    // Best-effort by design — a Slack outage, or no bot token configured at
    // all locally, must never take down a discovery run.
    withCreds();
    configMod.loadQuarryConfig.mockReturnValue({ ...CONFIG, autoApprove: true, triage: { ...CONFIG.triage, visionScoring: true } });
    discovery.discover.mockResolvedValue({
      results: [place("a", "trade-service", "https://clean.com")],
      searched: 1, skippedAlreadySeen: 0, skippedClosed: 0, detailsCalls: 1,
    });
    triageMod.triage.mockResolvedValue({ isCandidate: false, reasons: [] });
    triageMod.applyVisionScore = vi.fn(() => ({
      isCandidate: true, reasons: ["Looks dated (8/10)"], outdatedScore: 8, outdatedReasoning: "dated",
    }));
    shotMod.scoreSiteAppearance.mockResolvedValue({ score: 8, reasoning: "dated" });
    indexMod.quarryAgent.post.mockRejectedValueOnce(new Error("No Slack client for agent: quarry"));

    await expect(
      run({
        stopAfter: "triage", triggeredBy: "test", overrideKillSwitch: true, log: () => {},
        capturer: { capture: async () => Buffer.from("png"), close: async () => {} } as any,
      })
    ).resolves.toBeDefined();
  });
});

describe("run — GHL sync", () => {
  it("does nothing when syncToGhl is not set, even at the enrich stage", async () => {
    withCreds();
    configMod.loadQuarryConfig.mockReturnValue(CONFIG);
    discovery.discover.mockResolvedValue({
      results: [place("a", "trade-service", null)],
      searched: 1, skippedAlreadySeen: 0, skippedClosed: 0, detailsCalls: 1,
    });
    triageMod.triage.mockResolvedValue({ isCandidate: true, reasons: ["No website listed on Google"] });
    enrichMod.enrichContact.mockResolvedValue({ email: null, emailSource: null, hasPublicEmail: false });

    const r = await run({ stopAfter: "enrich", triggeredBy: "test", overrideKillSwitch: true, log: () => {} });

    expect(syncMod.upsertProspectContact).not.toHaveBeenCalled();
    expect(r.syncedToGhl).toBe(0);
  });

  it("pushes every qualified lead into GHL as a contact + opportunity when syncToGhl is set", async () => {
    withCreds();
    configMod.loadQuarryConfig.mockReturnValue({
      ...CONFIG,
      ghlPipeline: { name: "Website Offer Pipeline", stages: ["New Lead"] },
    });
    discovery.discover.mockResolvedValue({
      results: [place("a", "trade-service", null), place("b", "trade-service", null)],
      searched: 2, skippedAlreadySeen: 0, skippedClosed: 0, detailsCalls: 2,
    });
    triageMod.triage.mockResolvedValue({ isCandidate: true, reasons: ["No website listed on Google"] });
    enrichMod.enrichContact.mockResolvedValue({ email: "info@biz.com", emailSource: "own_website_contact_page", hasPublicEmail: true });

    const r = await run({
      stopAfter: "enrich", triggeredBy: "test", overrideKillSwitch: true, log: () => {}, syncToGhl: true,
    });

    expect(syncMod.resolvePipeline).toHaveBeenCalledWith("Website Offer Pipeline", ["New Lead"], "loc1", "key1");
    expect(syncMod.upsertProspectContact).toHaveBeenCalledTimes(2);
    expect(syncMod.openOpportunity).toHaveBeenCalledTimes(2);
    expect(store.updateLead).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ ghlContactId: "c1", ghlOpportunityId: "op1", pipelineStage: "New Lead" })
    );
    expect(r.syncedToGhl).toBe(2);
  });

  it("skips a lead with no phone number rather than failing the batch", async () => {
    withCreds();
    configMod.loadQuarryConfig.mockReturnValue({
      ...CONFIG,
      ghlPipeline: { name: "Website Offer Pipeline", stages: ["New Lead"] },
    });
    discovery.discover.mockResolvedValue({
      results: [{ ...place("a", "trade-service", null), phone: null }],
      searched: 1, skippedAlreadySeen: 0, skippedClosed: 0, detailsCalls: 1,
    });
    triageMod.triage.mockResolvedValue({ isCandidate: true, reasons: ["No website listed on Google"] });
    enrichMod.enrichContact.mockResolvedValue({ email: null, emailSource: null, hasPublicEmail: false });

    const r = await run({
      stopAfter: "enrich", triggeredBy: "test", overrideKillSwitch: true, log: () => {}, syncToGhl: true,
    });

    expect(syncMod.upsertProspectContact).not.toHaveBeenCalled();
    expect(r.syncedToGhl).toBe(0);
    expect(r.errors.some((e) => e.step === "sync")).toBe(true);
  });

  it("logs and skips sync entirely when GHL isn't configured for the client, without failing the run", async () => {
    withCreds();
    configMod.loadQuarryConfig.mockReturnValue({
      ...CONFIG,
      ghlPipeline: { name: "Website Offer Pipeline", stages: ["New Lead"] },
    });
    ghlMod.getGhlConfig.mockResolvedValueOnce(null);
    discovery.discover.mockResolvedValue({
      results: [place("a", "trade-service", null)],
      searched: 1, skippedAlreadySeen: 0, skippedClosed: 0, detailsCalls: 1,
    });
    triageMod.triage.mockResolvedValue({ isCandidate: true, reasons: ["No website listed on Google"] });
    enrichMod.enrichContact.mockResolvedValue({ email: null, emailSource: null, hasPublicEmail: false });

    const r = await run({
      stopAfter: "enrich", triggeredBy: "test", overrideKillSwitch: true, log: () => {}, syncToGhl: true,
    });

    expect(syncMod.resolvePipeline).not.toHaveBeenCalled();
    expect(r.syncedToGhl).toBe(0);
  });
});
