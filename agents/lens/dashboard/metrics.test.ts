import { describe, expect, it } from "vitest";
import { attributionOf, AppointmentRow, compareMetrics, computeMetrics, LeadRow, MetaRow, MetricsInput } from "./metrics";

const TZ = "America/St_Johns";
const NOW = new Date("2026-10-27T15:00:00.000Z");
const RANGE = { from: "2026-10-01", to: "2026-10-31" };
const at = (iso: string) => new Date(iso);

const meta = (over: Partial<MetaRow> = {}): MetaRow => ({ date: "2026-10-05", campaignId: "c1", campaignName: "Buyers", spend: 100, impressions: 10000, clicks: 200, reach: 8000, leads: 4, ...over });
const lead = (over: Partial<LeadRow> = {}): LeadRow => ({ contactId: "L1", createdAt: at("2026-10-05T15:00:00Z"), campaignId: "c1", stage: "Replied", dealValue: null, closedAt: null, ...over });
const appt = (over: Partial<AppointmentRow> = {}): AppointmentRow => ({ id: "A1", contactId: "L1", start: at("2026-10-10T15:00:00Z"), bookedAt: at("2026-10-06T15:00:00Z"), status: "attended", ...over });

const input = (over: Partial<MetricsInput> = {}): MetricsInput => ({
  range: RANGE,
  timeZone: TZ,
  now: NOW,
  meta: [meta()],
  leads: [lead()],
  appointments: [appt()],
  otherCosts: [],
  config: { closedStages: ["Deal Closed"], qualifiedStages: ["Appointment Set", "Showed Up"], unqualifiedStages: ["Not Qualified/Not Interested"] },
  ...over,
});
const v = (r: ReturnType<typeof computeMetrics>, key: keyof ReturnType<typeof computeMetrics>["kpis"]) => r.kpis[key].value;

describe("Meta metrics", () => {
  it("adds up the days in the period and calculates the ratios from the totals", () => {
    const r = computeMetrics(input({ meta: [meta(), meta({ date: "2026-10-06", spend: 50, impressions: 5000, clicks: 100, reach: 4000, leads: 1 }), meta({ date: "2026-09-30", spend: 999 })] }));
    expect(v(r, "spend")).toBe(150);
    expect(v(r, "impressions")).toBe(15000);
    expect(v(r, "clicks")).toBe(300);
    expect(v(r, "reach")).toBe(12000);
    expect(v(r, "ctr")).toBeCloseTo(2);
    expect(v(r, "cpc")).toBeCloseTo(0.5);
    expect(v(r, "metaLeads")).toBe(5);
    expect(v(r, "cpl")).toBeCloseTo(30);
  });

  it("is N/A, never zero or infinity, when a denominator is zero", () => {
    const r = computeMetrics(input({ meta: [meta({ impressions: 0, clicks: 0, leads: 0 })] }));
    expect(v(r, "ctr")).toBeNull();
    expect(v(r, "cpc")).toBeNull();
    expect(v(r, "cpl")).toBeNull();
  });

  it("says reach is a sum of daily reach", () => {
    expect(computeMetrics(input()).kpis.reach.note).toMatch(/unique reach/);
  });
});

describe("attribution", () => {
  const known = new Set(["c1"]);
  it("is confirmed when the lead carries a real Meta campaign id, whether or not we hold that campaign's data", () => {
    expect(attributionOf({ campaignId: "c1" }, known)).toBe("confirmed");
    expect(attributionOf({ campaignId: "120239794885580259" }, known)).toBe("confirmed"); // an older campaign, before our synced history
  });
  it("is partial for text only (a utm label), and unknown for nothing", () => {
    expect(attributionOf({ campaignId: "Seller Campaign - EDEN" }, known)).toBe("partial");
    expect(attributionOf({ campaignId: null }, known)).toBe("unknown");
  });

  it("splits leads into confirmed, partial and unknown, and counts only confirmed as from ads", () => {
    const r = computeMetrics(input({ leads: [lead({ contactId: "a" }), lead({ contactId: "b", campaignId: "some text" }), lead({ contactId: "c", campaignId: null })] }));
    expect(r.detail.leadsByAttribution).toEqual({ confirmed: 1, partial: 1, unknown: 1 });
    expect(v(r, "totalLeads")).toBe(3);
    expect(v(r, "attributedLeads")).toBe(1);
  });

  it("counts a closed deal from an older campaign as from ads (Seller Campaign - EDEN, 3% Realty)", () => {
    const r = computeMetrics(input({ leads: [lead({ contactId: "old", campaignId: "120239794885580259", stage: "Deal Closed", dealValue: 4048.5, closedAt: at("2026-10-07T15:00:00Z") })] }));
    expect(v(r, "closedDealsAttributed")).toBe(1);
    expect(v(r, "revenueAttributed")).toBe(4048.5);
  });
});

describe("appointments", () => {
  it("counts booked by the day it was booked and excludes cancelled, invalid and deleted", () => {
    const r = computeMetrics(input({
      appointments: [
        appt({ id: "1" }),
        appt({ id: "2", status: "cancelled" }),
        appt({ id: "3", status: "invalid" }),
        appt({ id: "4", status: "deleted" }),
        appt({ id: "5", bookedAt: at("2026-09-20T15:00:00Z") }), // booked before the period
      ],
    }));
    expect(v(r, "appointmentsBooked")).toBe(1);
  });

  it("uses only appointments from confirmed-attribution leads for cost per appointment", () => {
    const r = computeMetrics(input({
      leads: [lead({ contactId: "ad" }), lead({ contactId: "organic", campaignId: null })],
      appointments: [appt({ id: "1", contactId: "ad" }), appt({ id: "2", contactId: "organic" })],
      meta: [meta({ spend: 200 })],
    }));
    expect(v(r, "appointmentsBooked")).toBe(2);
    expect(v(r, "appointmentsBookedAttributed")).toBe(1);
    expect(v(r, "costPerAppointment")).toBe(200);
  });

  it("show-up rate = attended ÷ passed appointments in the period, leaving out cancelled and future ones", () => {
    const r = computeMetrics(input({
      appointments: [
        appt({ id: "1", status: "attended" }),
        appt({ id: "2", status: "no_show" }),
        appt({ id: "3", status: "attended" }),
        appt({ id: "4", status: "cancelled" }),
        appt({ id: "5", status: "confirmed", start: at("2026-10-30T15:00:00Z") }), // still ahead of "now"
      ],
    }));
    expect(v(r, "attendedAppointments")).toBe(2);
    expect(v(r, "noShowAppointments")).toBe(1);
    expect(v(r, "showUpRate")).toBeCloseTo((2 / 3) * 100);
    expect(v(r, "confirmedAppointments")).toBe(1);
  });

  it("keeps a past appointment with no recorded outcome in the denominator and says so", () => {
    const r = computeMetrics(input({ appointments: [appt({ id: "1", status: "attended" }), appt({ id: "2", status: "booked" })] }));
    expect(v(r, "showUpRate")).toBe(50);
    expect(r.detail.appointmentsWithoutOutcome).toBe(1);
    expect(r.notes.join(" ")).toMatch(/no outcome recorded/);
  });

  it("show-up rate is N/A when nothing was due", () => {
    expect(v(computeMetrics(input({ appointments: [] })), "showUpRate")).toBeNull();
  });

  it("a rescheduled appointment is one record, so it counts once", () => {
    // GHL changes the same event's time; the same id is stored once
    const r = computeMetrics(input({ appointments: [appt({ id: "same", start: at("2026-10-12T15:00:00Z") })] }));
    expect(v(r, "appointmentsBooked")).toBe(1);
    expect(v(r, "attendedAppointments")).toBe(1);
  });

  it("lead-to-appointment counts each lead once however many appointments it has", () => {
    const r = computeMetrics(input({
      leads: [lead({ contactId: "a" }), lead({ contactId: "b" }), lead({ contactId: "c" }), lead({ contactId: "d" })],
      appointments: [appt({ id: "1", contactId: "a" }), appt({ id: "2", contactId: "a", start: at("2026-10-20T15:00:00Z") }), appt({ id: "3", contactId: "b" }), appt({ id: "4", contactId: "c", status: "cancelled" })],
    }));
    expect(v(r, "leadToAppointment")).toBe(50);
  });

  it("the appointment metrics are N/A, not zero, when no appointments have synced", () => {
    const r = computeMetrics(input({ sources: { meta: true, appointments: false } }));
    expect(v(r, "appointmentsBooked")).toBeNull();
    expect(v(r, "showUpRate")).toBeNull();
    expect(v(r, "leadToAppointment")).toBeNull();
    expect(r.notes.join(" ")).toMatch(/Appointment metrics are N\/A/);
  });
});

describe("qualified leads", () => {
  it("counts by stage and is N/A, with a note, when none are configured", () => {
    const withConfig = computeMetrics(input({ leads: [lead({ contactId: "a", stage: "Appointment Set" }), lead({ contactId: "b", stage: "Not Qualified/Not Interested" }), lead({ contactId: "c", stage: "Replied" })] }));
    expect(v(withConfig, "qualifiedLeads")).toBe(1);
    expect(v(withConfig, "unqualifiedLeads")).toBe(1);
    const none = computeMetrics(input({ config: { closedStages: ["Deal Closed"], qualifiedStages: [], unqualifiedStages: [] } }));
    expect(v(none, "qualifiedLeads")).toBeNull();
    expect(none.notes.join(" ")).toMatch(/Qualified and unqualified leads are N\/A/);
  });
});

describe("closed deals and revenue", () => {
  const closed = (over: Partial<LeadRow> = {}) => lead({ stage: "Deal Closed", dealValue: 5000, closedAt: at("2026-10-20T15:00:00Z"), ...over });

  it("counts deals that closed IN the period, whenever the lead arrived, and only confirmed-attribution ones as from ads", () => {
    const r = computeMetrics(input({
      leads: [
        closed({ contactId: "ad", createdAt: at("2026-03-01T15:00:00Z") }),
        closed({ contactId: "organic", campaignId: null, dealValue: 8000 }),
        closed({ contactId: "old", closedAt: at("2026-08-01T15:00:00Z") }),
      ],
    }));
    expect(v(r, "closedDeals")).toBe(2);
    expect(v(r, "closedDealsAttributed")).toBe(1);
    expect(v(r, "revenueAttributed")).toBe(5000);
    expect(v(r, "revenueAll")).toBe(13000);
  });

  it("never invents a value: a closed deal with no value adds nothing and is flagged", () => {
    const r = computeMetrics(input({ leads: [closed({ contactId: "a" }), closed({ contactId: "b", dealValue: null })] }));
    expect(v(r, "closedDealsAttributed")).toBe(2);
    expect(v(r, "revenueAttributed")).toBe(5000);
    expect(r.detail.closedDealsMissingValue).toBe(1);
    expect(r.notes.join(" ")).toMatch(/no value recorded/);
  });

  it("revenue and deals are N/A when the client has no closed stage configured", () => {
    const r = computeMetrics(input({ config: { closedStages: [], qualifiedStages: [], unqualifiedStages: [] }, leads: [closed()] }));
    expect(v(r, "closedDeals")).toBeNull();
    expect(v(r, "revenueAttributed")).toBeNull();
    expect(v(r, "roas")).toBeNull();
    expect(v(r, "costPerClosedDeal")).toBeNull();
  });

  it("matches stage names without regard to case or spaces", () => {
    const r = computeMetrics(input({ leads: [closed({ stage: "  deal closed " })] }));
    expect(v(r, "closedDeals")).toBe(1);
  });
});

describe("returns", () => {
  const base = () => input({ meta: [meta({ spend: 1000 })], leads: [lead({ stage: "Deal Closed", dealValue: 4000, closedAt: at("2026-10-20T15:00:00Z") })], appointments: [appt()] });

  it("ROAS = revenue from ads ÷ ad spend; cost per closed deal = spend ÷ closed deals from ads", () => {
    const r = computeMetrics(base());
    expect(v(r, "roas")).toBe(4);
    expect(v(r, "costPerClosedDeal")).toBe(1000);
    expect(v(r, "appointmentToSale")).toBe(100);
  });

  it("appointment-to-sale follows the leads who had an appointment, so it can never pass 100%", () => {
    // 4 deals closed this period, but only ONE lead had an appointment in it (Matama Floors, 2026-10-27: this read 400%)
    const closedLead = (id: string) => lead({ contactId: id, stage: "Deal Closed", dealValue: 4000, closedAt: at("2026-10-20T15:00:00Z") });
    const r = computeMetrics(input({
      leads: [closedLead("a"), closedLead("b"), closedLead("c"), closedLead("d"), lead({ contactId: "e" })],
      appointments: [appt({ id: "1", contactId: "a" }), appt({ id: "2", contactId: "a", start: at("2026-10-12T15:00:00Z") }), appt({ id: "3", contactId: "e" })],
    }));
    expect(v(r, "closedDealsAttributed")).toBe(4);
    expect(v(r, "appointmentToSale")).toBe(50); // leads a and e had appointments; only a has closed
  });

  it("appointment-to-sale ignores leads without confirmed ad attribution", () => {
    const r = computeMetrics(input({
      leads: [lead({ contactId: "x", campaignId: null, stage: "Deal Closed", dealValue: 4000, closedAt: at("2026-10-20T15:00:00Z") })],
      appointments: [appt({ id: "1", contactId: "x" })],
    }));
    expect(v(r, "appointmentToSale")).toBeNull();
  });

  it("ROI uses ad spend only until other costs are entered, and says which costs it included", () => {
    const adOnly = computeMetrics(base());
    expect(v(adOnly, "roi")).toBe(300);
    expect(adOnly.detail.costsIncluded).toBe("ad spend");
    expect(adOnly.kpis.roi.note).toMatch(/ad spend\./);
    const withOther = computeMetrics({ ...base(), otherCosts: [{ date: "2026-10-10", amount: 1000 }] });
    expect(v(withOther, "otherCosts")).toBe(1000);
    expect(v(withOther, "roi")).toBe(100);
    expect(v(withOther, "roas")).toBe(4); // ROAS never includes other costs
    expect(withOther.detail.costsIncluded).toBe("ad spend + other costs");
  });

  it("ignores other costs outside the period", () => {
    expect(v(computeMetrics({ ...base(), otherCosts: [{ date: "2026-09-10", amount: 500 }] }), "otherCosts")).toBeNull();
  });

  it("is N/A with no spend, 0 (a real result) with spend but no closed deals", () => {
    expect(v(computeMetrics({ ...base(), meta: [] }), "roas")).toBeNull();
    expect(v(computeMetrics({ ...base(), leads: [lead()] }), "roas")).toBe(0);
  });
});

describe("missing sources", () => {
  it("makes the ad metrics N/A, not a convincing zero, when Meta isn't connected", () => {
    const r = computeMetrics(input({ meta: [], sources: { meta: false, appointments: true } }));
    for (const k of ["spend", "cpl", "ctr", "roas", "roi", "costPerAppointment"] as const) expect(v(r, k)).toBeNull();
    expect(r.notes.join(" ")).toMatch(/no Meta ad data/);
    expect(v(r, "totalLeads")).toBe(1); // GHL numbers still work
  });
});

describe("comparing with the previous period", () => {
  it("reports the change and percent change, and no percentage from a zero or N/A start", () => {
    const current = computeMetrics(input({ meta: [meta({ spend: 150 })] }));
    const previous = computeMetrics(input({ range: { from: "2026-09-01", to: "2026-09-30" }, meta: [meta({ date: "2026-09-05", spend: 100 })] }));
    const c = compareMetrics(current, previous);
    expect(c.spend).toEqual({ previous: 100, change: 50, changePct: 50 });
    const empty = computeMetrics(input({ range: { from: "2026-08-01", to: "2026-08-31" }, meta: [] }));
    expect(compareMetrics(current, empty).spend.changePct).toBeNull();
    expect(compareMetrics(current, empty).cpl.change).toBeNull();
  });
});
