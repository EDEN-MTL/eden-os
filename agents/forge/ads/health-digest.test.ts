import { describe, expect, it } from "vitest";
import { formatHealthDigest } from "./health-digest";
import type { CampaignHealthReport, EntityHealth, FunnelSummary } from "./health";

function entity(overrides: Partial<EntityHealth>): EntityHealth {
  return {
    scope: "ad",
    id: "ad_1",
    name: "Seller - AI image 10",
    campaignName: "Seller Campaign",
    funnel: "seller",
    targetCpl: 79,
    verdict: "watch",
    reasons: ["Leads are Meta's own count; none are attributed in GHL yet, so lead quality and won deals are unknown.", "Main reason."],
    recommendation: "Do the thing.",
    metrics: { spend: 100, lead_count: 1, lead_source: "meta", cpl: 100, ctr: 0.01, cpm: 12, frequency: 1.3, active_days: 10 },
    ...overrides,
  };
}

const sellerFunnel: FunnelSummary = {
  funnel: "seller",
  targetCpl: 78.52,
  targetSource: "auto",
  basis: { days: 60, spend: 1178, leads: 15 },
  killNoLeadSpend: 196.3,
  killCpl: 137.4,
  scaleCpl: 62.8,
  scaleMinLeads: 3,
  scaleStepPercent: 20,
  dailyBudget: 20,
  expectedLeadsPerWeek: 1.78,
  killLineDaysOfBudget: 9.8,
};

function report(entities: EntityHealth[], overrides: Partial<CampaignHealthReport> = {}): CampaignHealthReport {
  const counts = { kill: 0, refresh_creative: 0, scale: 0, watch: 0, healthy: 0, too_early: 0 };
  for (const e of entities) counts[e.verdict]++;
  return {
    clientId: "3-percent-east-coast",
    lookbackDays: 14,
    playbook: {} as any,
    funnels: [sellerFunnel],
    totals: { spend: 656, leads: 8, cpl: 82, leadSource: "meta" },
    dailyBudget: { current: 50, cap: 75 },
    counts,
    entities,
    ...overrides,
  };
}

const NOW = new Date("2026-11-16T15:00:00Z");
const at = (iso: string) => Date.parse(iso);
const fmt = (entities: EntityHealth[], overrides: Partial<CampaignHealthReport> = {}) => formatHealthDigest("3%", report(entities, overrides), NOW);

describe("formatHealthDigest", () => {
  it("opens with two lines: the client, then spend, leads, cost per lead and budget", () => {
    const text = formatHealthDigest("3% Realty East Coast", report([entity({})]), NOW);
    expect(text.split("\n").slice(0, 2)).toEqual([
      "📊 *Forge daily ad health · 3% Realty East Coast*",
      "Last 14 days: $656 spent · 8 leads (Meta's count) · $82/lead · $50/day (cap $75)",
    ]);
  });

  it("has no closing boilerplate and no per-section counts", () => {
    const text = fmt([entity({ verdict: "kill" })]);
    expect(text).not.toContain("Ask Forge");
    expect(text).not.toContain("No changes needed");
    expect(text).not.toMatch(/\(\d+\)/);
  });

  describe("one win is told once", () => {
    const campaign = entity({ scope: "campaign", id: "c", campaignId: "c", name: "Evergreen", verdict: "scale", targetCpl: 45, recommendation: "Raise the daily budget by 20%.", metrics: { ...entity({}).metrics, spend: 400, lead_count: 19, cpl: 30 } });
    const adset = entity({ scope: "adset", id: "s", campaignId: "c", name: "Static", verdict: "scale", recommendation: "Budget lives at the campaign (CBO). Raise the campaign budget by 20% rather than this ad set's.", metrics: { ...entity({}).metrics, spend: 200, lead_count: 10, cpl: 21 } });
    const ad = entity({ scope: "ad", id: "a", campaignId: "c", adsetId: "s", name: "Image 1", verdict: "scale", recommendation: "Winning ad. Pause the weakest siblings.", metrics: { ...entity({}).metrics, spend: 100, lead_count: 10, cpl: 20.4 } });
    const text = fmt([campaign, adset, ad]);

    it("nests the ad set and ad under their campaign, each with only its own numbers", () => {
      expect(text).toContain(
        "🟢 *Scale*\n" +
          "Campaign *Evergreen* — 19 leads · $30/lead · 33% under goal\n" +
          "   ↳ Ad set *Static* — 10 leads · $21/lead\n" +
          "      ↳ Ad *Image 1* — 10 leads · $20/lead"
      );
    });

    it("says each instruction once and drops the ad set's 'budget lives at the campaign' echo", () => {
      expect(text.match(/→/g)).toHaveLength(2);
      expect(text).toContain("→ Raise the daily budget by 20%.\n→ Winning ad. Pause the weakest siblings.");
      expect(text).not.toContain("Budget lives at the campaign");
    });

    it("keeps an ad set's own budget note when its campaign is not in the list", () => {
      expect(fmt([adset])).toContain("→ Budget lives at the campaign (CBO).");
    });
  });

  it("repeats an identical instruction only once across several ads", () => {
    const winning = (id: string) => entity({ id, name: id, verdict: "scale", recommendation: "Winning ad. Pause the weakest siblings." });
    const text = fmt([winning("one"), winning("two"), winning("three")]);
    expect(text.match(/Winning ad/g)).toHaveLength(1);
  });

  it("gives turn-offs their own numbers, with no goal repeated on the line", () => {
    const text = fmt([
      entity({ id: "k1", name: "Dud", verdict: "kill", recommendation: "Pause this ad.", metrics: { ...entity({}).metrics, spend: 160, lead_count: 0, cpl: null } }),
      entity({ id: "k2", name: "Pricey", verdict: "kill", recommendation: "Pause this ad.", metrics: { ...entity({}).metrics, spend: 300, lead_count: 2, cpl: 150 } }),
    ]);
    expect(text).toContain("🔴 *Turn off*\nAd *Pricey* — $150/lead · $300 spent · 2 leads\nAd *Dud* — $160 spent, no leads\n→ Pause this ad.");
    expect(text).not.toContain("target");
  });

  it("carries the near-turn-off warning on a watch", () => {
    const text = fmt([entity({ verdict: "watch", reasons: ["CPL is high.", "Close to the kill line: $2.10 more spend without improvement makes it a kill."], recommendation: "No action yet." })]);
    expect(text).toContain("close to the turn-off line, $2.10 more spend without improvement makes it a kill.");
    expect(text).toContain("✅ *Nothing to turn off or scale today.*");
  });

  it("only surfaces a too-early ad when it's already under goal, with no instruction line", () => {
    const text = fmt([
      entity({ id: "p", name: "New hit", verdict: "too_early", recommendation: "Leave it alone.", metrics: { ...entity({}).metrics, cpl: 15, lead_count: 2, active_days: 2 } }),
      entity({ id: "q", name: "New dud", verdict: "too_early", metrics: { ...entity({}).metrics, cpl: null, lead_count: 0 } }),
    ]);
    expect(text).toContain("✨ *Promising, too new to scale*\nAd *New hit* — 2 leads · $15/lead in 2 days");
    expect(text).not.toContain("New dud");
    expect(text).not.toContain("Leave it alone");
    expect(text).toContain("Also running: 2 too early to judge");
  });

  it("puts goals and turn-off lines in one line per funnel", () => {
    const goal = { ...sellerFunnel, targetCpl: 60, targetSource: "config" as const, basis: undefined };
    expect(fmt([entity({})], { funnels: [goal] })).toContain("• *Sellers* $60/lead: turn off at $196 with no leads or $137+/lead · scale at ≤$63 with 3+ leads");
    expect(fmt([entity({})])).toContain("• *Sellers* $79/lead (their recent average): turn off at $196");
  });

  it("flags a missing live-status read so paused items aren't mistaken for running ones", () => {
    expect(fmt([entity({})], { liveStateError: "rate limited" })).toContain("Couldn't read live status from Meta (rate limited)");
  });

  it("strips asterisks from a name so it cannot break the bold", () => {
    expect(fmt([entity({ name: "Video 3*2*2", verdict: "kill" })])).toContain("Ad *Video 322*");
  });

  describe("launch dates sit on the line they date", () => {
    const created = { campaign: at("2026-07-31T12:00:00Z"), adset: at("2026-09-17T12:00:00Z"), ad: at("2026-11-02T12:00:00Z") };

    it("has no separate launch section", () => {
      expect(fmt([entity({ created })])).not.toContain("first launched");
    });

    it("gives a lone ad its own date plus its ad set's and campaign's", () => {
      expect(fmt([entity({ created })])).toContain("Ad *Seller - AI image 10* — $100/lead · $100 spent · 1 lead · launched Nov 2 (ad set Sep 17, campaign Jul 31)");
    });

    it("gives a line nested under its own ad set and campaign only its own date", () => {
      const campaign = entity({ scope: "campaign", id: "c", campaignId: "c", name: "Camp", verdict: "scale", created: { campaign: created.campaign } });
      const adset = entity({ scope: "adset", id: "s", campaignId: "c", name: "Set", verdict: "scale", created: { campaign: created.campaign, adset: created.adset } });
      const ad = entity({ scope: "ad", id: "a", campaignId: "c", adsetId: "s", name: "Ad one", verdict: "scale", created });
      const lines = fmt([campaign, adset, ad]).split("\n");
      expect(lines.find((l) => l.startsWith("Campaign"))).toMatch(/launched Jul 31$/);
      expect(lines.find((l) => l.includes("Ad set *Set*"))).toMatch(/launched Sep 17$/);
      expect(lines.find((l) => l.includes("Ad *Ad one*"))).toMatch(/launched Nov 2$/);
    });

    it("adds the ad set's date to an ad that sits under the campaign but not under an ad set line", () => {
      const campaign = entity({ scope: "campaign", id: "c", campaignId: "c", name: "Camp", verdict: "scale", created: { campaign: created.campaign } });
      const ad = entity({ scope: "ad", id: "a", campaignId: "c", adsetId: "other", name: "Ad two", verdict: "scale", created });
      const line = fmt([campaign, ad]).split("\n").find((l) => l.includes("Ad *Ad two*"));
      expect(line).toMatch(/^ {3}↳ .*launched Nov 2 \(ad set Sep 17\)$/);
    });

    it("leaves the date off when Meta gave none", () => {
      expect(fmt([entity({})])).not.toContain("launched");
    });
  });
});
