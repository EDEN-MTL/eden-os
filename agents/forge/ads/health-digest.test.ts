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

describe("formatHealthDigest", () => {
  it("leads with totals, budget and the lead-source caveat once", () => {
    const text = formatHealthDigest("3% Realty East Coast", report([entity({})]));
    expect(text).toContain("📊 *Forge daily ad health: 3% Realty East Coast*");
    expect(text).toContain("Last 14 days: $656 spent · 8 leads · $82/lead");
    expect(text).toContain("Daily budget: $50 of the $75 cap");
    expect(text.match(/Meta's own/g)).toHaveLength(1);
  });

  it("lists kills and scales with their next step, and watches without", () => {
    const text = formatHealthDigest(
      "3%",
      report([
        entity({ id: "k", name: "Loser", verdict: "kill", recommendation: "Pause this ad." }),
        entity({ id: "s", name: "Winner", scope: "adset", verdict: "scale", recommendation: "Raise the daily budget by 20%." }),
        entity({ id: "w", name: "Meh", verdict: "watch", recommendation: "No action yet." }),
      ])
    );
    expect(text).toContain("🔴 *Turn off* (1)\n• Ad *Loser*: Main reason.\n   → Pause this ad.");
    expect(text).toContain("🟢 *Scale* (1)\n• Ad set *Winner*: Main reason.\n   → Raise the daily budget by 20%.");
    expect(text).toContain("🟡 *Watch* (1)\n• Ad *Meh*: Main reason.");
    expect(text).not.toContain("No action yet.");
    expect(text).toContain("Ask Forge to make any of these changes.");
  });

  it("says plainly when there's nothing to act on, and carries the near-kill warning on a watch", () => {
    const text = formatHealthDigest(
      "3%",
      report([entity({ reasons: ["CPL is high.", "Close to the kill line: $2.10 more spend without improvement makes it a kill."] })])
    );
    expect(text).toContain("✅ *Nothing to turn off or scale today.*");
    expect(text).toContain("CPL is high. Close to the kill line: $2.10 more");
    expect(text).toContain("No changes needed. Forge will check again tomorrow.");
  });

  it("only surfaces a too-early ad when it's already under target, with its early numbers", () => {
    const text = formatHealthDigest(
      "3%",
      report([
        entity({ id: "p", name: "New hit", verdict: "too_early", reasons: ["Losing delivery to sibling ads.", "Early signal is good: 2 lead(s) at $15.06. Worth watching closely."], metrics: { ...entity({}).metrics, cpl: 15 } }),
        entity({ id: "q", name: "New dud", verdict: "too_early", metrics: { ...entity({}).metrics, cpl: null, lead_count: 0 } }),
      ])
    );
    expect(text).toContain("✨ *Promising, too new to scale* (1)\n• Ad *New hit*: Early signal is good: 2 lead(s) at $15.06");
    expect(text).not.toContain("New dud");
    expect(text).toContain("Also running: 2 too early to judge.");
  });

  it("explains each target, its basis and what the budget buys", () => {
    const text = formatHealthDigest("3%", report([entity({})]));
    expect(text).toContain(
      "• *Sellers:* $79/lead (their 60-day average, 15 leads) · $20/day ≈ 1.8 leads/week\n" +
        "   Turn off at $196 with no leads or $137+/lead · scale at ≤$63 with 3+ leads"
    );
  });

  it("flags a missing live-status read so paused items aren't mistaken for running ones", () => {
    const text = formatHealthDigest("3%", report([entity({})], { liveStateError: "rate limited" }));
    expect(text).toContain("Couldn't read live status from Meta (rate limited)");
  });
});
