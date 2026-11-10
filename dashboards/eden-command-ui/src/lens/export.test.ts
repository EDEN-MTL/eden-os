import { describe, expect, it } from "vitest";
import { csvField, toCsv } from "./csv";
import { buildExportModel, headlineTiles, leadLabel, slug } from "./export-model";
import type { Report } from "./useLensReport";

const period = { from: "2026-02-01", to: "2026-10-26", label: "Feb 1 to Oct 26, 2026" };
const previous = { from: "2025-05-08", to: "2026-01-31", label: "May 8, 2025 to Jan 31, 2026" };

function report(compare = true): Report {
  return {
    kpis: {
      client: { clientId: "3-percent-east-coast", name: "3% Realty", timezone: "America/St_Johns", meta: { connected: true, lastDay: "2026-10-26" }, ghl: { connected: true }, missing: ["Other marketing costs are not entered"] },
      period, previousPeriod: compare ? previous : null, generatedAt: "2026-10-27T12:00:00.000Z", appointmentBasis: "pipeline", allLeadsFromAds: false,
      sections: [
        { id: "ads", title: "Advertising", metrics: [
          { key: "spend", label: "Ad spend", definition: "Money spent on Meta ads.", source: "Meta", unit: "currency", value: 9273.5, previous: 100, change: 9173.5, changePct: 9173.5 },
          { key: "cpl", label: "Cost per lead", definition: "Spend / leads.", source: "Meta", unit: "currency", value: null, previous: null, change: null, changePct: null },
        ] },
      ],
      attribution: { confirmed: 283, partial: 3, unknown: 15, note: "283 of 301 leads are confirmed from ads." }, notes: ["Test lead included."],
    },
    series: { period, granularity: "month", points: [{ from: "2026-10-01", to: "2026-10-26", label: "Oct", spend: 10, impressions: null, clicks: 5, metaLeads: 2, cpl: 5, totalLeads: 3, appointmentsBooked: 1, attendedAppointments: 0, showUpRate: null, leadToAppointment: 33.3, closedDealsAttributed: 0, revenueAttributed: 0, roas: 0 }] },
    campaigns: {
      period,
      rows: [
        { campaignId: "120239794885580259", name: "Seller Campaign - EDEN", noMetaData: false, spend: 778, impressions: 1, clicks: 1, metaLeads: 17, cpl: 45.76, leads: 15, appointmentsBooked: 6, attendedAppointments: 5, costPerAppointment: 129.67, closedDeals: 3, revenue: 15295.5, costPerClosedDeal: 259.33, roas: 19.66 },
        { campaignId: null, name: "Not tied to a campaign", noMetaData: false, spend: null, impressions: null, clicks: null, metaLeads: null, cpl: null, leads: 18, appointmentsBooked: 3, attendedAppointments: 2, costPerAppointment: null, closedDeals: 1, revenue: 6225, costPerClosedDeal: null, roas: null },
      ],
      totals: { spend: 778, leads: 33, closedDeals: 4, revenue: 21520.5 },
    },
    attribution: {
      period, basis: "pipeline", allLeadsFromAds: false, ads: { spend: 778, metaLeads: 17 },
      chain: [{ id: "leads", label: "Leads", unit: "count", total: 301, confirmed: 283, partial: 3, unknown: 15 }, { id: "revenue", label: "Revenue recorded", unit: "currency", total: 21520.5, confirmed: 15295.5, partial: 6225, unknown: 0 }],
      deals: [
        { contactId: "c1", name: "=HYPERLINK(\"http://x\")", leadDate: "2026-03-01", closedDate: "2026-05-03", daysToClose: 63, value: 5698.5, attribution: "confirmed", evidence: "Meta campaign ID 120239794885580259", campaignId: "120239794885580259", campaignName: "Seller Campaign - EDEN", adsetId: null, adId: null, source: "Facebook", formName: "New March Seller Form", appointments: [], booked: true, attended: true },
        { contactId: "c2", name: "Matthew Broders", leadDate: "2026-02-17", closedDate: "2026-10-08", daysToClose: 233, value: null, attribution: "partial", evidence: "Source is Facebook but no campaign ID was kept", campaignId: null, campaignName: null, adsetId: null, adId: null, source: "Facebook", formName: null, appointments: [], booked: true, attended: false },
      ],
      sources: [{ source: "Facebook", leads: 286, confirmed: 283, partial: 3, unknown: 0, booked: 108, closedDeals: 4, revenue: 21520.5 }],
      quality: { closedDealsMissingValue: [{ contactId: "c2", name: "Matthew Broders" }], closedDealsNotConfirmed: 1, metaHistoryStarts: "2026-02-01" },
      methodology: [{ title: "The chain", text: "Ad, lead, appointment, deal." }],
    },
  };
}

describe("buildExportModel", () => {
  it("names the client and the period it was made from, and is named for them", () => {
    const m = buildExportModel(report(), { includeNames: false });
    expect(m.client).toBe("3% Realty");
    expect(m.meta).toContainEqual(["Period", "Feb 1 to Oct 26, 2026 (2026-02-01 to 2026-10-26)"]);
    expect(m.fileBase).toBe("lens-3-realty-2026-02-01_to_2026-10-26");
  });

  it("leaves lead names out by default, in the ledger and in the notes, and puts them in when asked", () => {
    const hidden = JSON.stringify(buildExportModel(report(), { includeNames: false }));
    expect(hidden).not.toContain("Matthew Broders");
    expect(hidden).toContain("Lead 2");
    expect(hidden).not.toContain("c2");
    const shown = JSON.stringify(buildExportModel(report(), { includeNames: true }));
    expect(shown).toContain("Matthew Broders");
  });

  it("keeps N/A as N/A and a missing deal value as words, never zero", () => {
    const m = buildExportModel(report(), { includeNames: false });
    const cpl = m.tables[0].rows[1];
    expect(cpl[1]).toEqual({ v: null, unit: "currency" });
    const deals = m.tables.find((t) => t.id === "deals")!;
    expect(deals.rows[1][9]).toBe("No value recorded");
  });

  it("drops the comparison columns when the period is not compared", () => {
    expect(buildExportModel(report(false), { includeNames: false }).tables[0].columns).toEqual(["Metric", "Value"]);
    expect(buildExportModel(report(true), { includeNames: false }).tables[0].columns).toContain("Previous period");
  });

  it("always carries the notes about missing data", () => {
    const notes = buildExportModel(report(), { includeNames: false }).notes.join("\n");
    expect(notes).toMatch(/Other marketing costs are not entered/);
    expect(notes).toMatch(/1 closed deal has no value recorded/);
    expect(notes).toMatch(/not confirmed from ads/);
    expect(notes).toMatch(/Meta spend is held from 2026-02-01/);
    expect(notes).toMatch(/never shown as 0/);
  });

  it("words the not-confirmed note to match the client's rule: still counted in ROAS when every lead counts as from ads", () => {
    const r = report();
    r.attribution.allLeadsFromAds = true;
    const notes = buildExportModel(r, { includeNames: false }).notes.join("\n");
    expect(notes).toMatch(/still counts in ROAS and cost per closed deal but cannot be placed on a campaign/);
    expect(notes).not.toMatch(/left out of ROAS/);
  });

  it("totals the deal values under the deals table, counting a deal with no value as nothing", () => {
    const deals = buildExportModel(report(), { includeNames: false }).tables.find((t) => t.id === "deals")!;
    expect(deals.footer?.[0]).toBe("Total");
    expect(deals.footer?.[9]).toEqual({ v: 5698.5, unit: "currency" });
    const none = report();
    none.attribution.deals = [];
    expect(buildExportModel(none, { includeNames: false }).tables.find((t) => t.id === "deals")!.footer).toBeUndefined();
  });

  it("labels leads in the order shown", () => {
    expect(leadLabel({ name: "Ann" }, 0, false)).toBe("Lead 1");
    expect(leadLabel({ name: " Ann " }, 0, true)).toBe("Ann");
    expect(leadLabel({ name: null }, 3, true)).toBe("Unnamed lead");
  });

  it("makes a safe file name", () => {
    expect(slug("3% Realty / East Coast!")).toBe("3-realty-east-coast");
    expect(slug("***")).toBe("client");
  });
});

describe("toCsv", () => {
  it("quotes commas, quotes and line breaks", () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
  });

  it("stops a typed name from running as a spreadsheet formula, but leaves numbers alone", () => {
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField("+1 555")).toBe("'+1 555");
    expect(csvField(-12.5)).toBe("-12.5");
    expect(csvField(null)).toBe("N/A");
  });

  it("writes the report with a header, raw numbers, N/A, the total row and the notes", () => {
    const csv = toCsv(buildExportModel(report(), { includeNames: true }));
    expect(csv.startsWith("﻿EDEN LENS CLIENT REPORT\r\n")).toBe(true);
    expect(csv).toContain("Client,3% Realty");
    expect(csv).toContain("Ad spend,9273.5,100,9173.5,9173.5");
    expect(csv).toContain("Cost per lead,N/A,N/A,N/A,N/A");
    expect(csv).toContain("All campaigns,778,33,,,,,,4,,21520.5,");
    expect(csv).toContain("Not tied to a campaign,N/A,18");
    expect(csv).toContain("Data notes");
    expect(csv).toContain("Trend data (monthly)");
    expect(csv).not.toContain("NaN");
    expect(csv).not.toContain("undefined");
  });

  it("rounds money and rates to two decimals but leaves counts whole", () => {
    const r = report();
    r.kpis.sections[0].metrics[0].value = 9335.659999999987;
    r.campaigns.rows[0].leads = 15;
    const csv = toCsv(buildExportModel(r, { includeNames: false }));
    expect(csv).toContain("Ad spend,9335.66,");
    expect(csv).not.toContain("9335.659999999987");
  });

  it("includes no lead names when they were not asked for", () => {
    expect(toCsv(buildExportModel(report(), { includeNames: false }))).not.toContain("Matthew Broders");
  });
});

describe("headlineTiles", () => {
  const withMetrics = (compare = true) => {
    const r = report(compare);
    r.kpis.sections = [
      { id: "meta", title: "Meta", metrics: [
        { key: "spend", label: "Ad spend", definition: "", source: "Meta", unit: "currency", value: 9335.66, previous: 8000, change: 1335.66, changePct: 16.7 },
        { key: "cpl", label: "Cost per lead", definition: "", source: "Meta", unit: "currency", value: null, previous: null, change: null, changePct: null },
      ] },
      { id: "rev", title: "Revenue", metrics: [
        { key: "revenueAll", label: "Revenue, all closed deals", definition: "", source: "GHL", unit: "currency", value: 21520.5, previous: 0, change: 21520.5, changePct: null },
        { key: "roas", label: "ROAS", definition: "", source: "Meta + GHL", unit: "ratio", value: 2.31, previous: 1.5, change: 0.81, changePct: 54 },
      ] },
    ];
    return r;
  };

  it("picks the key numbers in reading order, skips ones the report lacks (a client's hidden ROI is never a tile), and relabels", () => {
    const tiles = headlineTiles(withMetrics());
    expect(tiles.map((t) => t.key)).toEqual(["spend", "cpl", "revenueAll", "roas"]);
    expect(tiles.find((t) => t.key === "revenueAll")!.label).toBe("Revenue");
  });

  it("shows N/A for a number that cannot be worked out, with no change", () => {
    const cpl = headlineTiles(withMetrics()).find((t) => t.key === "cpl")!;
    expect(cpl.text).toBe("N/A");
    expect(cpl.change).toBeNull();
  });

  it("says how a number moved only when the period was compared", () => {
    expect(headlineTiles(withMetrics(true)).find((t) => t.key === "spend")!.change).toBe("+16.7% vs $8,000.00");
    expect(headlineTiles(withMetrics(false)).find((t) => t.key === "spend")!.change).toBeNull();
  });

  it("marks a rise in ROAS good and a rise in cost per lead bad", () => {
    const r = withMetrics();
    r.kpis.sections[0].metrics[1] = { key: "cpl", label: "Cost per lead", definition: "", source: "Meta", unit: "currency", value: 30, previous: 20, change: 10, changePct: 50 };
    const tiles = headlineTiles(r);
    expect(tiles.find((t) => t.key === "roas")!.tone).toBe("good");
    expect(tiles.find((t) => t.key === "cpl")!.tone).toBe("bad");
  });
});
