import { describe, expect, it } from "vitest";
import { bucketLabel, formatChange, formatCompact, formatValue, periodQuery, toneOf } from "./format";
import { linearScale, nearestIndex, niceTicks, segments } from "./chart-math";

describe("formatValue", () => {
  it("shows N/A for null, NaN and Infinity, never 0", () => {
    for (const bad of [null, undefined, NaN, Infinity]) expect(formatValue(bad as number, "currency")).toBe("N/A");
    expect(formatValue(0, "currency")).toBe("$0.00");
  });
  it("formats each unit", () => {
    expect(formatValue(1510.2, "currency")).toBe("$1,510.20");
    expect(formatValue(21520.5, "currency")).toBe("$21,521");
    expect(formatValue(104746, "count")).toBe("104,746");
    expect(formatValue(2.6789, "percent")).toBe("2.7%");
    expect(formatValue(169.7, "percent")).toBe("170%");
    expect(formatValue(2.684, "ratio")).toBe("2.68x");
    expect(formatValue(-12.5, "currency")).toBe("-$12.50");
  });
});

describe("formatCompact", () => {
  it("shortens axis labels", () => {
    expect(formatCompact(1500, "currency")).toBe("$1.5k");
    expect(formatCompact(25000, "count")).toBe("25k");
    expect(formatCompact(12.5, "percent")).toBe("12.5%");
    expect(formatCompact(null, "count")).toBe("N/A");
  });
});

describe("change against the previous period", () => {
  it("colours by what is good: a lower cost is good, more leads is good, spend is neutral", () => {
    expect(toneOf("cpl", -10)).toBe("good");
    expect(toneOf("cpl", 10)).toBe("bad");
    expect(toneOf("totalLeads", 5)).toBe("good");
    expect(toneOf("showUpRate", -5)).toBe("bad");
    expect(toneOf("noShowAppointments", 2)).toBe("bad");
    expect(toneOf("spend", 100)).toBe("neutral");
    expect(toneOf("cpl", null)).toBe("neutral");
    expect(toneOf("cpl", 0)).toBe("neutral");
  });
  it("shows a percentage when there is one, the plain change when the start was zero, nothing when N/A", () => {
    expect(formatChange(10, 25, "currency")).toBe("+25.0%");
    expect(formatChange(-3, -12.5, "count")).toBe("-12.5%");
    expect(formatChange(4, null, "count")).toBe("+4");
    expect(formatChange(0, null, "count")).toBe("no change");
    expect(formatChange(null, null, "count")).toBeNull();
  });
});

describe("period query and bucket labels", () => {
  it("sends from/to only for a custom range", () => {
    expect(periodQuery({ preset: "last_30_days", from: "x", to: "y", compare: true })).toBe("preset=last_30_days&compare=1");
    expect(periodQuery({ preset: "custom", from: "2026-10-01", to: "2026-10-07", compare: false })).toBe("preset=custom&compare=0&from=2026-10-01&to=2026-10-07");
  });
  it("labels buckets compactly", () => {
    expect(bucketLabel("2026-10-05", "2026-10-05", "day")).toBe("Oct 5");
    expect(bucketLabel("2026-10-05", "2026-10-11", "week")).toBe("Oct 5-11");
    expect(bucketLabel("2026-10-26", "2026-11-01", "week")).toBe("Oct 26-Nov 1");
    expect(bucketLabel("2026-10-01", "2026-10-31", "month")).toBe("Oct");
  });
});

describe("chart math", () => {
  it("nice ticks start at zero and cover the data with round steps", () => {
    const t = niceTicks(0, 1510);
    expect(t[0]).toBe(0);
    expect(t.at(-1)!).toBeGreaterThanOrEqual(1510);
    expect(t.every((v, i) => i === 0 || v > t[i - 1])).toBe(true);
    expect(niceTicks(0, 0)[0]).toBe(0);
    expect(niceTicks(0, 0).at(-1)!).toBeGreaterThan(0);
    expect(niceTicks(5, 5).at(-1)!).toBeGreaterThan(5);
  });
  it("scales linearly and survives a flat domain", () => {
    const s = linearScale([0, 100], [200, 0]);
    expect(s(0)).toBe(200);
    expect(s(100)).toBe(0);
    expect(s(50)).toBe(100);
    expect(linearScale([5, 5], [0, 10])(5)).toBe(5);
  });
  it("finds the nearest point to the pointer", () => {
    expect(nearestIndex(0, 5, 0, 100)).toBe(0);
    expect(nearestIndex(100, 5, 0, 100)).toBe(4);
    expect(nearestIndex(60, 5, 0, 100)).toBe(2);
    expect(nearestIndex(500, 5, 0, 100)).toBe(4);
    expect(nearestIndex(10, 1, 0, 100)).toBe(0);
  });
  it("breaks a line at a gap rather than dropping to zero", () => {
    expect(segments([1, 2, null, 4, 5, null, null, 8])).toEqual([
      [{ index: 0, value: 1 }, { index: 1, value: 2 }],
      [{ index: 3, value: 4 }, { index: 4, value: 5 }],
      [{ index: 7, value: 8 }],
    ]);
    expect(segments([null, null])).toEqual([]);
  });
});
