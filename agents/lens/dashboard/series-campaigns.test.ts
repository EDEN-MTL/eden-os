import { describe, expect, it } from "vitest";
import { computeCampaignTable } from "./campaigns";
import { AppointmentRow, computeMetrics, LeadRow, MetaRow, MetricsInput } from "./metrics";
import { bucketRanges, computeSeries, pickGranularity } from "./series";

const TZ = "America/St_Johns";
const at = (iso: string) => new Date(iso);
const NOW = at("2026-10-27T15:00:00Z");

describe("buckets", () => {
  it("picks day, week or month by the length of the period", () => {
    expect(pickGranularity({ from: "2026-10-01", to: "2026-10-31" })).toBe("day");
    expect(pickGranularity({ from: "2026-08-01", to: "2026-10-31" })).toBe("week");
    expect(pickGranularity({ from: "2026-01-01", to: "2026-10-31" })).toBe("month");
  });

  it("covers the period exactly with no gaps or overlaps, for every granularity", () => {
    const range = { from: "2026-10-01", to: "2026-12-20" }; // starts on a Thursday, ends mid-month
    for (const g of ["day", "week", "month"] as const) {
      const buckets = bucketRanges(range, g);
      expect(buckets[0].from).toBe(range.from);
      expect(buckets.at(-1)!.to).toBe(range.to);
      for (let i = 1; i < buckets.length; i++) {
        const prevEnd = new Date(`${buckets[i - 1].to}T00:00:00Z`).getTime();
        expect(new Date(`${buckets[i].from}T00:00:00Z`).getTime() - prevEnd).toBe(86_400_000);
      }
    }
  });

  it("weeks end on Sunday and months on the last day", () => {
    expect(bucketRanges({ from: "2026-10-01", to: "2026-10-20" }, "week").map((b) => b.to)).toEqual(["2026-10-04", "2026-10-11", "2026-10-18", "2026-10-20"]);
    expect(bucketRanges({ from: "2026-10-15", to: "2026-12-05" }, "month")).toEqual([
      { from: "2026-10-15", to: "2026-10-31" },
      { from: "2026-11-01", to: "2026-11-30" },
      { from: "2026-12-01", to: "2026-12-05" },
    ]);
  });
});

const meta = (date: string, campaignId: string, spend: number, leads = 1): MetaRow => ({ date, campaignId, campaignName: `Campaign ${campaignId}`, spend, impressions: 1000, clicks: 20, reach: 900, leads });
const lead = (id: string, createdAt: string, campaignId: string | null, over: Partial<LeadRow> = {}): LeadRow => ({ contactId: id, createdAt: at(createdAt), campaignId, stage: "Replied", dealValue: null, closedAt: null, tags: [], ...over });
const appt = (id: string, contactId: string, over: Partial<AppointmentRow> = {}): AppointmentRow => ({ id, contactId, start: at("2026-10-12T15:00:00Z"), bookedAt: at("2026-10-08T15:00:00Z"), status: "attended", ...over });

const base = (over: Partial<MetricsInput> = {}): MetricsInput => ({
  range: { from: "2026-10-01", to: "2026-10-31" },
  timeZone: TZ,
  now: NOW,
  meta: [meta("2026-10-05", "111111111111", 100), meta("2026-10-06", "111111111111", 50), meta("2026-10-05", "222222222222", 200)],
  knownCampaignIds: new Set(["111111111111", "222222222222"]),
  leads: [
    lead("a", "2026-10-05T15:00:00Z", "111111111111"),
    lead("b", "2026-10-06T15:00:00Z", "111111111111", { stage: "Deal Closed", dealValue: 5000, closedAt: at("2026-10-20T15:00:00Z") }),
    lead("c", "2026-10-07T15:00:00Z", "222222222222"),
    lead("d", "2026-10-08T15:00:00Z", "Seller Campaign - typed label"), // partial
    lead("e", "2026-10-09T15:00:00Z", null, { stage: "Deal Closed", dealValue: 3000, closedAt: at("2026-10-21T15:00:00Z") }), // unknown, closed anyway
  ],
  appointments: [appt("1", "a"), appt("2", "b"), appt("3", "d")],
  otherCosts: [],
  config: { closedStages: ["Deal Closed"], qualifiedStages: [], unqualifiedStages: [] },
  ...over,
});

describe("trend series", () => {
  it("every chart point comes from the same definitions as the cards, and the points add back up to the totals", () => {
    const input = base();
    const { granularity, points } = computeSeries(input);
    expect(granularity).toBe("day");
    expect(points).toHaveLength(31);
    const total = computeMetrics(input).kpis;
    expect(points.reduce((s, p) => s + (p.spend ?? 0), 0)).toBeCloseTo(total.spend.value!);
    expect(points.reduce((s, p) => s + (p.totalLeads ?? 0), 0)).toBe(total.totalLeads.value);
    expect(points.reduce((s, p) => s + (p.closedDealsAttributed ?? 0), 0)).toBe(total.closedDealsAttributed.value);
    expect(points.find((p) => p.from === "2026-10-05")!.spend).toBe(300);
    expect(points.find((p) => p.from === "2026-10-05")!.cpl).toBe(150);
    expect(points.find((p) => p.from === "2026-10-20")!.revenueAttributed).toBe(5000);
  });

  it("a day with no spend has an N/A cost per lead, not a zero", () => {
    expect(computeSeries(base()).points.find((p) => p.from === "2026-10-15")!.cpl).toBeNull();
  });
});

describe("campaign table", () => {
  it("has one row per campaign with spend, leads, appointments, closed deals and revenue", () => {
    const rows = computeCampaignTable(base());
    const first = rows.find((r) => r.campaignId === "111111111111")!;
    expect(first).toMatchObject({ name: "Campaign 111111111111", spend: 150, leads: 2, closedDeals: 1, revenue: 5000, appointmentsBooked: 2, attendedAppointments: 2 });
    expect(first.roas).toBeCloseTo(5000 / 150);
    expect(first.costPerClosedDeal).toBe(150);
    expect(first.costPerAppointment).toBe(75);
    const second = rows.find((r) => r.campaignId === "222222222222")!;
    expect(second).toMatchObject({ spend: 200, leads: 1, closedDeals: 0, revenue: 0 });
    expect(second.costPerClosedDeal).toBeNull();
  });

  it("sorts by spend, biggest first, with the 'not tied to a campaign' row last", () => {
    const rows = computeCampaignTable(base());
    expect(rows.map((r) => r.campaignId)).toEqual(["222222222222", "111111111111", null]);
  });

  it("puts partial and unknown attribution in the untied row, with its closed deal but no spend or ROAS", () => {
    const untied = computeCampaignTable(base()).find((r) => r.campaignId === null)!;
    expect(untied.name).toBe("Not tied to a campaign");
    expect(untied.leads).toBe(2); // d (partial) and e (unknown)
    expect(untied.closedDeals).toBe(1);
    expect(untied.revenue).toBe(3000);
    expect(untied.spend).toBeNull();
    expect(untied.roas).toBeNull();
  });

  it("never counts a lead, a deal or revenue twice: the rows add up to the totals", () => {
    const input = base();
    const rows = computeCampaignTable(input);
    const total = computeMetrics(input).kpis;
    expect(rows.reduce((s, r) => s + r.leads, 0)).toBe(total.totalLeads.value);
    expect(rows.reduce((s, r) => s + (r.closedDeals ?? 0), 0)).toBe(total.closedDeals.value);
    expect(rows.reduce((s, r) => s + (r.revenue ?? 0), 0)).toBe(total.revenueAll.value);
    expect(rows.reduce((s, r) => s + (r.spend ?? 0), 0)).toBeCloseTo(total.spend.value!);
  });

  it("shows a campaign we hold no Meta data for (an older one) and says so", () => {
    const input = base({ knownCampaignIds: new Set(["111111111111", "222222222222"]), leads: [lead("old", "2026-10-05T15:00:00Z", "120239794885580259", { stage: "Deal Closed", dealValue: 4048.5, closedAt: at("2026-10-07T15:00:00Z") })] });
    const row = computeCampaignTable(input).find((r) => r.campaignId === "120239794885580259")!;
    expect(row.noMetaData).toBe(true);
    expect(row.name).toBe("Campaign 120239794885580259");
    expect(row.closedDeals).toBe(1);
    expect(row.revenue).toBe(4048.5);
  });

  it("a campaign we hold data for that did not run in the period shows its real name and a zero spend, not N/A", () => {
    // Seller Campaign - EDEN ran Feb-Jul; a deal from one of its leads closed this month
    const input = base({
      knownCampaignIds: new Set(["111111111111", "222222222222", "120239794885580259"]),
      campaignNames: new Map([["120239794885580259", "Seller Campaign - EDEN"]]),
      leads: [lead("old", "2026-04-05T15:00:00Z", "120239794885580259", { stage: "Deal Closed", dealValue: 4048.5, closedAt: at("2026-10-07T15:00:00Z") })],
    });
    const row = computeCampaignTable(input).find((r) => r.campaignId === "120239794885580259")!;
    expect(row.name).toBe("Seller Campaign - EDEN");
    expect(row.noMetaData).toBe(false);
    expect(row.spend).toBe(0);
    expect(row.closedDeals).toBe(1);
    expect(row.revenue).toBe(4048.5);
    expect(row.roas).toBeNull(); // no spend this period, so no ratio
  });

  it("a campaign with no spend, leads or deals in the period is left out", () => {
    const input = base({ meta: [meta("2026-09-05", "999999999999", 80)] });
    expect(computeCampaignTable(input).find((r) => r.campaignId === "999999999999")).toBeUndefined();
  });
});

describe("trend series before the client's GHL data", () => {
  it("leaves lead numbers as gaps (not zeros) for buckets before ghlDataStart, and keeps Meta numbers", () => {
    const input = base({ range: { from: "2026-10-01", to: "2026-10-14" }, config: { closedStages: ["Deal Closed"], qualifiedStages: [], unqualifiedStages: [], ghlDataStart: "2026-10-10" } });
    const { points } = computeSeries(input);
    const day = (d: string) => points.find((p) => p.from === d)!;
    expect(day("2026-10-05").totalLeads).toBeNull();
    expect(day("2026-10-05").spend).toBe(300);
    expect(day("2026-10-12").totalLeads).toBe(0);
  });
});
