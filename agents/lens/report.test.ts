import { describe, expect, it } from "vitest";
import { formatAllClientsReport, formatWeeklyReport, previousMonth } from "./report";

describe("formatWeeklyReport", () => {
  it("renders n/a for cpl and roas when nothing is computable", () => {
    const text = formatWeeklyReport("Eden", {
      spend: 0, leads: 0, won: 0, revenue: 0, pipelineValue: 0, activeCount: 0, cpl: null, roas: null,
    });
    expect(text).toContain("Blended CPL: n/a");
    expect(text).toContain("ROAS: n/a");
    expect(text).toContain("0 deals worth $0");
  });

  it("renders real figures and pluralises deal/deals correctly", () => {
    const text = formatWeeklyReport("3 Percent East Coast", {
      spend: 1200, leads: 20, won: 3, revenue: 6000, pipelineValue: 15000, activeCount: 1, cpl: 60, roas: 5,
    });
    expect(text).toContain("Spend: $1,200");
    expect(text).toContain("Blended CPL: $60");
    expect(text).toContain("ROAS: 5x");
    expect(text).toContain("1 deal worth $15,000");
  });

  it("distinguishes a genuine zero ROAS (spend with no revenue) from unknown", () => {
    const text = formatWeeklyReport("Client", {
      spend: 61, leads: 0, won: 0, revenue: 0, pipelineValue: 0, activeCount: 0, cpl: null, roas: 0,
    });
    expect(text).toContain("Blended CPL: n/a");
    expect(text).toContain("ROAS: 0x");
  });
});

describe("formatAllClientsReport", () => {
  it("labels the report as covering all clients, not one", () => {
    const text = formatAllClientsReport([
      { clientName: "Eden", totals: { spend: 0, leads: 0, won: 0, revenue: 0, pipelineValue: 0, activeCount: 0, cpl: null, roas: null } },
    ]);
    expect(text).toContain("Weekly ad performance — all clients");
  });

  it("includes a section per client, each under its own name", () => {
    const text = formatAllClientsReport([
      { clientName: "Eden", totals: { spend: 100, leads: 2, won: 0, revenue: 0, pipelineValue: 0, activeCount: 0, cpl: 50, roas: 0 } },
      { clientName: "3 Percent East Coast", totals: { spend: 1200, leads: 20, won: 3, revenue: 6000, pipelineValue: 15000, activeCount: 1, cpl: 60, roas: 5 } },
    ]);
    expect(text).toContain("*Eden*");
    expect(text).toContain("*3 Percent East Coast*");
    expect(text).toContain("Spend: $100");
    expect(text).toContain("Spend: $1,200");
  });
});

describe("formatAllClientsReport extras", () => {
  const zero = { spend: 0, leads: 0, won: 0, revenue: 0, pipelineValue: 0, activeCount: 0, cpl: null, roas: null };

  it("takes a custom title, for the monthly report", () => {
    expect(formatAllClientsReport([{ clientName: "Eden", totals: zero }], "Monthly ad performance — all clients (September 2026)")).toContain(
      "*Monthly ad performance — all clients (September 2026)*"
    );
  });

  it("puts each extra section under the client's stats with its heading", () => {
    const text = formatAllClientsReport([
      { clientName: "3%", totals: zero, sections: [{ heading: "Lead funnel: all leads since Aug 1, 2026", lines: ["New leads: 63 (34 buyers, 20 sellers)"] }] },
    ]);
    expect(text).toContain("(not yet counted in ROAS)\n\n_Lead funnel: all leads since Aug 1, 2026_\nNew leads: 63 (34 buyers, 20 sellers)");
  });
});

describe("previousMonth", () => {
  it("covers the whole previous calendar month, including across a year boundary", () => {
    expect(previousMonth(new Date("2026-11-01T12:00:00Z"))).toEqual({
      since: "2026-10-01", until: "2026-10-31", nextMonthStart: "2026-11-01", label: "October 2026",
    });
    expect(previousMonth(new Date("2027-01-01T12:00:00Z"))).toMatchObject({ since: "2026-12-01", until: "2026-12-31" });
  });
});
