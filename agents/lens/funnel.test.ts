import { describe, expect, it } from "vitest";
import { countFunnel, formatFunnelLines, FunnelConfig, reachedStep } from "./funnel";

const config: FunnelConfig = {
  since: "2026-08-01",
  sides: [
    { name: "Buyers", tags: ["buyer lead"] },
    { name: "Sellers", tags: ["seller lead"] },
  ],
  steps: [
    { label: "Live transferred", tags: ["live transferred"], stages: ["Live Transferred"] },
    { label: "Appointment booked", tags: ["appt booked"], stages: ["Appointment Set", "Showed Up", "Deal Closed"] },
    { label: "Showed up", tags: ["showed up"], stages: ["Showed Up", "Deal Closed"] },
    { label: "Signed / closed", stages: ["Deal Closed"] },
  ],
};

describe("reachedStep", () => {
  it("matches on a tag even after the card has moved to another column", () => {
    expect(reachedStep({ tags: ["seller lead", "appt booked"], stage: "Replied" }, config.steps[1])).toBe(true);
  });

  it("matches on a later column with no tag, since the card moves on", () => {
    expect(reachedStep({ tags: [], stage: "Showed Up" }, config.steps[1])).toBe(true);
  });

  it("ignores case and stray spaces in tags and stages", () => {
    expect(reachedStep({ tags: [" Live Transferred "], stage: null }, config.steps[0])).toBe(true);
    expect(reachedStep({ tags: [], stage: "deal closed" }, config.steps[3])).toBe(true);
  });

  it("doesn't count a lead that never got there", () => {
    expect(reachedStep({ tags: ["buyer lead", "replied"], stage: "Replied" }, config.steps[2])).toBe(false);
  });
});

describe("countFunnel", () => {
  it("counts each step per side and in total; an unlabelled lead counts in the total only", () => {
    const counts = countFunnel(
      [
        { tags: ["buyer lead", "live transferred"], stage: "Live Transferred" },
        { tags: ["seller lead", "appt booked", "showed up"], stage: "Showed Up" },
        { tags: ["seller lead"], stage: "Deal Closed" },
        { tags: ["replied"], stage: "Replied" },
      ],
      config
    );
    expect(counts.leads).toEqual({ Buyers: 1, Sellers: 2, Total: 4 });
    expect(counts.steps.map((s) => [s.label, s.counts])).toEqual([
      ["Live transferred", { Buyers: 1, Sellers: 0, Total: 1 }],
      ["Appointment booked", { Buyers: 0, Sellers: 2, Total: 2 }],
      ["Showed up", { Buyers: 0, Sellers: 2, Total: 2 }],
      ["Signed / closed", { Buyers: 0, Sellers: 1, Total: 1 }],
    ]);
  });
});

describe("formatFunnelLines", () => {
  it("reads as one line per stage with the buyer/seller split, singular where it's 1", () => {
    const lines = formatFunnelLines(
      countFunnel([{ tags: ["buyer lead", "live transferred"], stage: null }, { tags: ["seller lead"], stage: null }], config),
      config
    );
    expect(lines[0]).toBe("New leads: 2 (1 buyer, 1 seller)");
    expect(lines[1]).toBe("Live transferred: 1 (1 buyer, 0 sellers)");
  });
});
