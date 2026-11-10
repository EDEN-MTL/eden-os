import { describe, expect, it } from "vitest";
import { attributionEvidence, computeAttribution, methodology } from "./attribution";
import { AppointmentRow, computeMetrics, LeadRow, MetaRow, MetricsInput } from "./metrics";

const TZ = "America/St_Johns";
const at = (iso: string) => new Date(iso);
const NOW = at("2026-10-27T15:00:00Z");
const meta = (date: string, campaignId: string, spend: number): MetaRow => ({ date, campaignId, campaignName: `Camp ${campaignId}`, spend, impressions: 1000, clicks: 20, reach: 900, leads: 2 });
const lead = (id: string, createdAt: string, campaignId: string | null, over: Partial<LeadRow> = {}): LeadRow => ({ contactId: id, createdAt: at(createdAt), campaignId, stage: "Replied", dealValue: null, closedAt: null, tags: [], source: "Facebook", name: `Lead ${id}`, ...over });
const closed = (id: string, campaignId: string | null, value: number | null, over: Partial<LeadRow> = {}) => lead(id, "2026-09-01T15:00:00Z", campaignId, { stage: "Deal Closed", dealValue: value, closedAt: at("2026-10-12T15:00:00Z"), ...over });
const appt = (id: string, contactId: string, over: Partial<AppointmentRow> = {}): AppointmentRow => ({ id, contactId, start: at("2026-10-12T15:00:00Z"), bookedAt: at("2026-10-08T15:00:00Z"), status: "attended", ...over });

const base = (over: Partial<MetricsInput> = {}): MetricsInput & { metaHistoryStarts: string } => ({
  range: { from: "2026-10-01", to: "2026-10-31" },
  timeZone: TZ,
  now: NOW,
  meta: [meta("2026-10-05", "111111111111", 300)],
  knownCampaignIds: new Set(["111111111111"]),
  campaignNames: new Map([["111111111111", "Buyer Campaign"], ["120239794885580259", "Seller Campaign - EDEN"]]),
  leads: [
    lead("a", "2026-10-05T15:00:00Z", "111111111111"), // confirmed
    lead("b", "2026-10-06T15:00:00Z", "Typed label"), // partial (label only)
    lead("c", "2026-10-07T15:00:00Z", null, { source: "Facebook / paid social" }), // partial (source only)
    lead("d", "2026-10-08T15:00:00Z", null, { source: null }), // unknown
    closed("e", "120239794885580259", 4048.5), // confirmed, closed this month
    closed("f", null, 6225, { source: "Facebook" }), // partial, closed this month
    closed("g", "111111111111", null), // confirmed, closed, NO value recorded
    closed("h", "111111111111", 9000, { closedAt: at("2026-08-12T15:00:00Z") }), // closed in August: not in this period
  ],
  appointments: [appt("1", "a"), appt("2", "e"), appt("3", "e", { start: at("2026-10-14T15:00:00Z") }), appt("4", "b", { status: "cancelled" })],
  otherCosts: [],
  config: { closedStages: ["Deal Closed"], qualifiedStages: [], unqualifiedStages: [] },
  sources: { meta: true, appointments: true },
  metaHistoryStarts: "2026-01-12",
  ...over,
});

describe("the chain", () => {
  it("splits every step into confirmed, partial and unknown, and the three add up to the total", () => {
    const r = computeAttribution(base());
    for (const s of r.chain) {
      expect((s.confirmed ?? 0) + (s.partial ?? 0) + (s.unknown ?? 0)).toBeCloseTo(s.total ?? 0);
    }
    const leads = r.chain.find((s) => s.id === "leads")!;
    expect(leads).toMatchObject({ total: 4, confirmed: 1, partial: 2, unknown: 1 });
    expect(r.chain.find((s) => s.id === "closed")).toMatchObject({ total: 3, confirmed: 2, partial: 1, unknown: 0 });
    expect(r.chain.find((s) => s.id === "revenue")).toMatchObject({ total: 10273.5, confirmed: 4048.5, partial: 6225 });
  });

  it("matches the KPI cards: the same numbers computed two ways", () => {
    const input = base();
    const r = computeAttribution(input);
    const k = computeMetrics(input).kpis;
    expect(r.chain.find((s) => s.id === "leads")!.total).toBe(k.totalLeads.value);
    expect(r.chain.find((s) => s.id === "closed")!.confirmed).toBe(k.closedDealsAttributed.value);
    expect(r.chain.find((s) => s.id === "revenue")!.confirmed).toBe(k.revenueAttributed.value);
    expect(r.chain.find((s) => s.id === "booked")!.confirmed).toBe(k.appointmentsBookedAttributed.value);
  });

  it("carries the ad spend and Meta leads for the period", () => {
    expect(computeAttribution(base()).ads).toEqual({ spend: 300, metaLeads: 2 });
  });
});

describe("the closed-deal ledger", () => {
  const r = computeAttribution(base());
  it("lists exactly the deals that closed in the period, newest first, one row per contact", () => {
    expect(r.deals.map((d) => d.contactId).sort()).toEqual(["e", "f", "g"]);
    expect(new Set(r.deals.map((d) => d.contactId)).size).toBe(r.deals.length);
    expect(r.deals.every((d, i, a) => i === 0 || a[i - 1].closedDate >= d.closedDate)).toBe(true);
  });

  it("gives each deal its evidence, campaign name, lead and close dates, and the appointments it came through", () => {
    const e = r.deals.find((d) => d.contactId === "e")!;
    expect(e).toMatchObject({ attribution: "confirmed", campaignName: "Seller Campaign - EDEN", leadDate: "2026-09-01", closedDate: "2026-10-12", daysToClose: 41, value: 4048.5, booked: true, attended: true });
    expect(e.appointments).toEqual(["2026-10-12", "2026-10-14"]);
    expect(e.evidence).toBe("Meta campaign ID 120239794885580259 (Seller Campaign - EDEN)");
    const f = r.deals.find((d) => d.contactId === "f")!;
    expect(f.attribution).toBe("partial");
    expect(f.evidence).toBe("Source is Facebook but no campaign ID was kept");
    expect(f.campaignId).toBeNull();
  });

  it("flags a closed deal with no recorded value and never invents one", () => {
    const g = r.deals.find((d) => d.contactId === "g")!;
    expect(g.value).toBeNull();
    expect(r.quality.closedDealsMissingValue).toEqual([{ contactId: "g", name: "Lead g" }]);
    expect(r.quality.closedDealsNotConfirmed).toBe(1);
  });
});

describe("by lead source", () => {
  it("groups leads by their original source with the attribution split and what they led to", () => {
    const r = computeAttribution(base());
    const fb = r.sources.find((s) => s.source === "Facebook")!;
    expect(fb.leads).toBe(3); // a, b, c arrived in October (d has no source)
    expect(fb).toMatchObject({ confirmed: 1, partial: 2, unknown: 0 });
    expect(fb.closedDeals).toBe(3); // e, f, g closed this month and carry the Facebook source
    expect(r.sources.find((s) => s.source === "(none)")!.leads).toBe(1);
  });
});

describe("pipeline mode (3% Realty)", () => {
  it("uses card stages for booked and attended, and the ledger says so per deal", () => {
    const pipeline = { bookedStages: ["Appointment Set", "Showed Up", "Deal Closed"], attendedStages: ["Showed Up", "Deal Closed"], noShowStages: ["No-Show"], bookedTags: [], attendedTags: [], noShowTags: [] };
    const r = computeAttribution(base({ appointments: [], config: { closedStages: ["Deal Closed"], qualifiedStages: [], unqualifiedStages: [], appointmentSource: "pipeline", pipeline } }));
    expect(r.basis).toBe("pipeline");
    const e = r.deals.find((d) => d.contactId === "e")!;
    expect(e.booked).toBe(true);
    expect(e.attended).toBe(true);
    expect(e.appointments).toEqual([]);
    expect(r.methodology.find((m) => m.title.startsWith("Which period"))!.text).toMatch(/follow the lead's arrival date/);
  });
});

describe("methodology", () => {
  it("states every rule, including where the Meta spend history starts", () => {
    const m = methodology("calendar", "2026-01-12");
    expect(m.map((x) => x.title)).toEqual(["The chain", "What confirms a lead came from an ad", "Partial and unknown", "Which period each number belongs to", "Revenue", "No double counting", "Known limits"]);
    expect(m.find((x) => x.title === "Known limits")!.text).toMatch(/from 2026-01-12/);
    expect(methodology("calendar", null).find((x) => x.title === "Known limits")!.text).toMatch(/No Meta spend history/);
  });
});

describe("evidence text", () => {
  it("covers the three cases", () => {
    expect(attributionEvidence(lead("x", "2026-10-01T00:00:00Z", "111111111111", { adsetId: "A1", adId: "B2" }), "confirmed", "Buyer")).toBe("Meta campaign ID 111111111111 (Buyer), ad set A1, ad B2");
    expect(attributionEvidence(lead("x", "2026-10-01T00:00:00Z", "Seller label"), "partial", null)).toMatch(/typed campaign label/);
    expect(attributionEvidence(lead("x", "2026-10-01T00:00:00Z", null, { source: null }), "unknown", null)).toBe("No campaign or ad source recorded on the lead");
  });
});

describe("methodology for a client whose leads all count as from ads", () => {
  it("says every lead counts, and no longer says partial or unknown leads are left out", () => {
    const plain = methodology("pipeline", "2026-02-01");
    const rule = methodology("pipeline", "2026-02-01", true);
    expect(plain.map((m) => m.title)).toContain("What confirms a lead came from an ad");
    expect(rule.map((m) => m.title)).toContain("What counts as from ads, and what names the campaign");
    const text = rule.map((m) => m.text).join(" ");
    expect(text).toMatch(/every lead counts as coming from ads/);
    expect(text).not.toMatch(/Neither is ever counted as from ads/);
    expect(text).toMatch(/cannot be placed on a campaign/);
    expect(rule).toHaveLength(plain.length);
  });
});
