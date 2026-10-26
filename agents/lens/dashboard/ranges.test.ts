import { describe, expect, it } from "vitest";
import { addDays, daysInRange, inRange, isValidDate, previousRange, rangeBounds, rangeLabel, resolveRange, todayIn } from "./ranges";

const TZ = "America/St_Johns"; // UTC-2:30 in October
// 2026-10-27 01:00 UTC is still Oct 26 at 10:30 PM in St. John's
const LATE = new Date("2026-10-27T01:00:00.000Z");

describe("periods follow the client's own calendar day", () => {
  it("uses the client's timezone for 'today', not UTC", () => {
    expect(todayIn(TZ, LATE)).toBe("2026-10-26");
    expect(todayIn("UTC", LATE)).toBe("2026-10-27");
  });

  it("matches Meta's presets: last 7 and 30 days are the complete days before today", () => {
    expect(resolveRange("last_7_days", TZ, LATE)).toEqual({ ok: true, range: { from: "2026-10-19", to: "2026-10-25" } });
    expect(resolveRange("last_30_days", TZ, LATE)).toEqual({ ok: true, range: { from: "2026-09-26", to: "2026-10-25" } });
    expect(resolveRange("today", TZ, LATE)).toEqual({ ok: true, range: { from: "2026-10-26", to: "2026-10-26" } });
    expect(resolveRange("yesterday", TZ, LATE)).toEqual({ ok: true, range: { from: "2026-10-25", to: "2026-10-25" } });
    expect(resolveRange("this_month", TZ, LATE)).toEqual({ ok: true, range: { from: "2026-10-01", to: "2026-10-26" } });
  });

  it("accepts a custom range and rejects bad ones with a plain message", () => {
    expect(resolveRange("custom", TZ, LATE, { from: "2026-10-01", to: "2026-10-07" })).toEqual({ ok: true, range: { from: "2026-10-01", to: "2026-10-07" } });
    expect(resolveRange("custom", TZ, LATE, { from: "2026-10-08", to: "2026-10-07" })).toMatchObject({ ok: false, error: expect.stringMatching(/after/) });
    expect(resolveRange("custom", TZ, LATE, { from: "2026-13-01", to: "2026-13-02" })).toMatchObject({ ok: false });
    expect(resolveRange("custom", TZ, LATE, { from: "2024-01-01", to: "2026-10-07" })).toMatchObject({ ok: false, error: expect.stringMatching(/366/) });
    expect(resolveRange("custom", TZ, LATE, {})).toMatchObject({ ok: false });
  });
});

describe("date arithmetic", () => {
  it("counts inclusive days and steps across months and leap years", () => {
    expect(daysInRange({ from: "2026-10-01", to: "2026-10-07" })).toBe(7);
    expect(daysInRange({ from: "2026-10-05", to: "2026-10-05" })).toBe(1);
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(isValidDate("2026-02-29")).toBe(false);
    expect(isValidDate("2028-02-29")).toBe(true);
  });

  it("the previous period is the same length immediately before", () => {
    expect(previousRange({ from: "2026-10-19", to: "2026-10-25" })).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(previousRange({ from: "2026-10-26", to: "2026-10-26" })).toEqual({ from: "2026-10-25", to: "2026-10-25" });
    // the same NUMBER of days (31), so it starts a day before September does
    expect(previousRange({ from: "2026-10-01", to: "2026-10-31" })).toEqual({ from: "2026-08-31", to: "2026-09-30" });
  });
});

describe("which instants fall in a period", () => {
  const range = { from: "2026-10-01", to: "2026-10-01" };
  it("a day runs from local midnight to local midnight", () => {
    const { start, end } = rangeBounds(range, TZ);
    expect(start.toISOString()).toBe("2026-10-01T02:30:00.000Z");
    expect(end.toISOString()).toBe("2026-10-02T02:30:00.000Z");
    expect(inRange(new Date("2026-10-02T02:29:59.000Z"), range, TZ)).toBe(true);
    expect(inRange(new Date("2026-10-02T02:30:00.000Z"), range, TZ)).toBe(false);
    expect(inRange(new Date("2026-10-01T02:29:59.000Z"), range, TZ)).toBe(false);
    expect(inRange(null, range, TZ)).toBe(false);
  });
});

describe("rangeLabel", () => {
  it("reads naturally", () => {
    expect(rangeLabel({ from: "2026-10-01", to: "2026-10-07" })).toBe("Oct 1 to Oct 7, 2026");
    expect(rangeLabel({ from: "2026-10-05", to: "2026-10-05" })).toBe("Oct 5, 2026");
    expect(rangeLabel({ from: "2025-12-20", to: "2026-01-05" })).toBe("Dec 20, 2025 to Jan 5, 2026");
  });
});
