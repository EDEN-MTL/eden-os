import { describe, expect, it } from "vitest";
import { assessEntity, buildHealthReport, buildPlaybook, HealthPlaybook, LiveEntityState, resolveFunnel } from "./health";
import { EntityMetrics } from "./types";

function makeRow(overrides: Partial<EntityMetrics> = {}): EntityMetrics {
  const spend = overrides.spend ?? 100;
  const leads = overrides.lead_count ?? 0;
  return {
    entity_id: "ad_1",
    entity_name: "Seller - AI image 10",
    spend,
    impressions: 8000,
    clicks: 100,
    frequency: 1.4,
    lead_count: leads,
    crm_lead_count: 0,
    meta_lead_count: leads,
    lead_source: leads ? "meta" : "none",
    won_count: 0,
    revenue: 0,
    ctr: 0.0125,
    cpc: 1,
    cpm: 12.5,
    cpl: leads ? spend / leads : null,
    roas: 0,
    first_date: "2026-09-25",
    last_date: "2026-10-07",
    active_days: 10,
    ...overrides,
  };
}

const playbook: HealthPlaybook = buildPlaybook({
  cplThreshold: 40,
  fatigueThreshold: 3,
  dailyBudgetCap: 75,
  health: {
    funnels: [
      { name: "buyer", match: "buyer", targetCpl: 30 },
      { name: "seller", match: "seller", targetCpl: 60 },
    ],
  },
})!;

describe("buildPlaybook", () => {
  it("falls back to cplThreshold/fatigueThreshold and generic defaults when forge.health is absent", () => {
    const p = buildPlaybook({ cplThreshold: 35, fatigueThreshold: 2.5 })!;
    expect(p).toMatchObject({ targetCpl: 35, fatigueFrequency: 2.5, killSpendMultiple: 2.5, lookbackDays: 14, funnels: [] });
  });

  it("returns null with no CPL target at all, rather than judging against a made-up one", () => {
    expect(buildPlaybook({})).toBeNull();
    expect(buildPlaybook(null)).toBeNull();
  });

  it("drops malformed funnels instead of letting one with no match string catch everything", () => {
    const p = buildPlaybook({ cplThreshold: 35, health: { funnels: [{ name: "buyer", match: "" }, { name: "seller", match: "seller", targetCpl: 50 }] } })!;
    expect(p.funnels.map((f) => f.name)).toEqual(["seller"]);
  });
});

describe("buildPlaybook calibration", () => {
  const campaign = (name: string, spend: number, leads: number) =>
    makeRow({ entity_id: name, entity_name: name, spend, lead_count: leads, cpl: leads ? spend / leads : null });
  const baseline = [
    campaign("Aug 2026 | Buyer Campaign | EDEN", 1648, 29),
    campaign("Aug 2026 | Seller Campaign | EDEN", 1178, 15),
    campaign("[04/03/2024] Promoting https://www.homesbyhickey.ca", 500, 0),
  ];
  const cfg = { cplThreshold: 110, health: { funnels: [{ name: "buyer", match: "buyer" }, { name: "seller", match: "seller" }] } };

  it("sets each funnel's target to its own blended CPL over the baseline", () => {
    const p = buildPlaybook(cfg, baseline)!;
    expect(p.funnels).toEqual([
      { name: "buyer", match: "buyer", targetCpl: 1648 / 29, targetSource: "auto", basis: { days: 60, spend: 1648, leads: 29 } },
      { name: "seller", match: "seller", targetCpl: 1178 / 15, targetSource: "auto", basis: { days: 60, spend: 1178, leads: 15 } },
    ]);
  });

  it("leaves never-lead-gen campaigns (boosted posts) out of the account target", () => {
    const p = buildPlaybook(cfg, baseline)!;
    expect(p.targetCpl).toBeCloseTo((1648 + 1178) / 44);
    expect(p.targetSource).toBe("auto");
  });

  it("lets a hand-set funnel target win over calibration", () => {
    const p = buildPlaybook({ ...cfg, health: { funnels: [{ name: "seller", match: "seller", targetCpl: 90 }] } }, baseline)!;
    expect(p.funnels[0]).toMatchObject({ targetCpl: 90, targetSource: "config" });
  });

  it("borrows the account target for a funnel with too few leads to calibrate", () => {
    const thin = [campaign("Buyer Campaign", 1000, 20), campaign("Seller Campaign", 300, 4)];
    const p = buildPlaybook(cfg, thin)!;
    expect(p.funnels[1]).toMatchObject({ name: "seller", targetCpl: 1300 / 24, targetSource: "auto" });
  });

  it("falls back to cplThreshold with no usable history at all", () => {
    const p = buildPlaybook(cfg, [campaign("Buyer Campaign", 100, 2)])!;
    expect(p).toMatchObject({ targetCpl: 110, targetSource: "fallback" });
    expect(p.funnels[0]).toMatchObject({ targetCpl: 110, targetSource: "fallback" });
  });
});

describe("resolveFunnel", () => {
  it("matches the campaign name first, case-insensitively", () => {
    expect(resolveFunnel(playbook, "Aug 2026 | Buyer Campaign | EDEN", "Seller lookalike")).toEqual({ funnel: "buyer", targetCpl: 30 });
  });

  it("falls back to the entity's own name, then to the account target", () => {
    expect(resolveFunnel(playbook, undefined, "Seller - test")).toEqual({ funnel: "seller", targetCpl: 60 });
    expect(resolveFunnel(playbook, "Brand awareness", "Video 1")).toEqual({ funnel: null, targetCpl: 40 });
  });
});

describe("assessEntity", () => {
  const seller: LiveEntityState = { campaignName: "Aug 2026 | Seller Campaign | EDEN" };

  it("kills at killSpendMultiple × the funnel's target with zero leads", () => {
    // seller target 60 × 2.5 = 150
    const h = assessEntity("ad", makeRow({ spend: 150 }), playbook, seller);
    expect(h.verdict).toBe("kill");
    expect(h.recommendation).toMatch(/Pause this ad/);
  });

  it("only watches the same zero-lead spend when it's still short of the kill line", () => {
    expect(assessEntity("ad", makeRow({ spend: 140 }), playbook, seller).verdict).toBe("watch");
  });

  it("warns when an over-target entity is within 20% of the kill line", () => {
    // 1 lead on 140 = 140 CPL ≥ 1.75 × 60; kill line 150
    const h = assessEntity("adset", makeRow({ spend: 140, lead_count: 1 }), playbook, seller);
    expect(h.verdict).toBe("watch");
    expect(h.reasons.join(" ")).toMatch(/Close to the kill line: \$10\.00 more/);
  });

  it("uses the buyer target for a buyer ad, so the same spend is already a kill there", () => {
    // buyer target 30 × 2.5 = 75
    expect(assessEntity("ad", makeRow({ spend: 140 }), playbook, { campaignName: "Buyer Campaign" }).verdict).toBe("kill");
  });

  it("kills a fast burn even before minActiveDays — waiting just spends more", () => {
    expect(assessEntity("ad", makeRow({ spend: 200, active_days: 1 }), playbook, seller).verdict).toBe("kill");
  });

  it("kills on CPL far over target once the spend floor is met", () => {
    // 2 leads on 240 = 120 CPL, 2× the 60 target
    expect(assessEntity("ad", makeRow({ spend: 240, lead_count: 2 }), playbook, seller).verdict).toBe("kill");
  });

  it("calls a new, barely-spent entity too_early instead of judging it", () => {
    const h = assessEntity("ad", makeRow({ spend: 20, active_days: 1 }), playbook, seller);
    expect(h.verdict).toBe("too_early");
  });

  it("explains a long-running, low-spend ad as starved by its siblings, not as new", () => {
    const h = assessEntity("ad", makeRow({ spend: 19, active_days: 13 }), playbook, seller);
    expect(h.verdict).toBe("too_early");
    expect(h.reasons.join(" ")).toMatch(/losing delivery to sibling ads/);
  });

  it("calls out a strong early signal without scaling on it", () => {
    const h = assessEntity("ad", makeRow({ spend: 30, lead_count: 2, active_days: 3 }), playbook, seller);
    expect(h.verdict).toBe("too_early");
    expect(h.reasons.join(" ")).toMatch(/Early signal is good: 2 lead/);
  });

  it("scales only with enough leads under the scale line", () => {
    // 4 leads on 160 = 40 CPL ≤ 0.8 × 60
    expect(assessEntity("adset", makeRow({ spend: 160, lead_count: 4 }), playbook, seller).verdict).toBe("scale");
    // 2 leads on 80 = 40 CPL, but under scaleMinLeads
    expect(assessEntity("adset", makeRow({ spend: 80, lead_count: 2 }), playbook, seller).verdict).toBe("healthy");
  });

  it("says to scale the campaign, not the ad set, when the campaign holds the budget", () => {
    const h = assessEntity("adset", makeRow({ spend: 160, lead_count: 4 }), playbook, { ...seller, campaignHoldsBudget: true });
    expect(h.recommendation).toMatch(/campaign budget/);
  });

  it("puts fatigue ahead of scale", () => {
    const h = assessEntity("adset", makeRow({ spend: 160, lead_count: 4, frequency: 3.4 }), playbook, seller);
    expect(h.verdict).toBe("refresh_creative");
  });

  it("flags that Meta-sourced leads carry no quality signal", () => {
    const h = assessEntity("ad", makeRow({ spend: 80, lead_count: 2 }), playbook, seller);
    expect(h.reasons.join(" ")).toMatch(/Meta's own count/);
  });

  it("notes learning phase and Learning Limited from live state", () => {
    const learning = assessEntity("adset", makeRow(), playbook, {
      ...seller,
      learning: { status: "LEARNING", conversions: 3, lastSignificantEditDaysAgo: 2 },
    });
    expect(learning.reasons.join(" ")).toMatch(/learning phase \(last significant edit 2 day/);
    const limited = assessEntity("adset", makeRow(), playbook, { ...seller, learning: { status: "FAIL", conversions: 10, lastSignificantEditDaysAgo: 20 } });
    expect(limited.reasons.join(" ")).toMatch(/Learning Limited/);
  });
});

describe("buildHealthReport", () => {
  const rows = {
    campaign: [makeRow({ entity_id: "c1", entity_name: "Seller Campaign", spend: 300, lead_count: 5 })],
    adset: [
      makeRow({ entity_id: "s1", entity_name: "Static Seller", spend: 300, lead_count: 5 }),
      makeRow({ entity_id: "s_old", entity_name: "Old boosted post", spend: 0 }),
    ],
    ad: [
      makeRow({ entity_id: "a1", entity_name: "AI image 10", spend: 200 }),
      makeRow({ entity_id: "a_paused", entity_name: "Paused since", spend: 100, lead_count: 5 }),
    ],
  };
  const live = new Map<string, LiveEntityState>([
    ["c1", { effectiveStatus: "ACTIVE", campaignName: "Seller Campaign", dailyBudget: 20 }],
    ["s1", { effectiveStatus: "ACTIVE", campaignName: "Seller Campaign", dailyBudget: null, campaignHoldsBudget: true }],
    ["s_old", { effectiveStatus: "ACTIVE" }],
    ["a1", { effectiveStatus: "ACTIVE", campaignName: "Seller Campaign" }],
    ["a_paused", { effectiveStatus: "PAUSED", campaignName: "Seller Campaign" }],
  ]);

  it("judges only delivering, still-active entities, most urgent first", () => {
    const report = buildHealthReport("3-percent-east-coast", playbook, rows, live, 14);
    expect(report.entities.map((e) => e.id)).toEqual(["a1", "c1", "s1"]);
    expect(report.entities[0].verdict).toBe("kill");
  });

  it("counts each daily budget once, at the level that holds it", () => {
    const report = buildHealthReport("3-percent-east-coast", playbook, rows, live, 14);
    expect(report.dailyBudget).toEqual({ current: 20, cap: 75 });
  });

  it("ties each funnel's target to its budget: leads per week and days to the kill line", () => {
    const report = buildHealthReport("3-percent-east-coast", playbook, rows, live, 14);
    const seller = report.funnels.find((f) => f.funnel === "seller")!;
    // target 60, budget 20/day
    expect(seller).toMatchObject({ targetCpl: 60, killNoLeadSpend: 150, killCpl: 105, scaleCpl: 48, dailyBudget: 20, expectedLeadsPerWeek: (20 * 7) / 60, killLineDaysOfBudget: 7.5 });
    expect(report.funnels.find((f) => f.funnel === "buyer")!.dailyBudget).toBeNull();
  });

  it("totals from campaign rows only, so nothing is counted three times", () => {
    const report = buildHealthReport("3-percent-east-coast", playbook, rows, live, 14);
    expect(report.totals).toEqual({ spend: 300, leads: 5, cpl: 60, leadSource: "meta" });
  });

  it("without live state, judges everything that spent and leaves the budget unknown", () => {
    const report = buildHealthReport("3-percent-east-coast", playbook, rows, null, 14);
    expect(report.entities.map((e) => e.id).sort()).toEqual(["a1", "a_paused", "c1", "s1"]);
    expect(report.dailyBudget.current).toBeNull();
  });
});
