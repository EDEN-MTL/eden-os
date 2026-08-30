import { describe, expect, it } from "vitest";
import { formatWeeklyReport } from "./report";

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
