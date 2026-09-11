import { describe, expect, it } from "vitest";
import {
  decideNextAttempt,
  describeAttempt,
  nextAttempt,
  nextAttemptTime,
  totalAttempts,
  clampToLegalCallingWindow,
  isWithinLegalCallingWindow,
} from "./cadence";
import { OutreachCadenceConfig } from "./qualification";

const cadence: OutreachCadenceConfig = { attemptsPerDay: 2, days: 4, recheckBeforeEachAttempt: true };

describe("totalAttempts", () => {
  it("multiplies attempts per day by days", () => {
    expect(totalAttempts(cadence)).toBe(8);
  });
});

describe("describeAttempt", () => {
  it("maps attempt 1 to day 1 morning and attempt 2 to day 1 afternoon", () => {
    expect(describeAttempt(cadence, 1)).toEqual({ day: 1, slotOfDay: 1 });
    expect(describeAttempt(cadence, 2)).toEqual({ day: 1, slotOfDay: 2 });
  });

  it("rolls over to day 2 on attempt 3", () => {
    expect(describeAttempt(cadence, 3)).toEqual({ day: 2, slotOfDay: 1 });
    expect(describeAttempt(cadence, 4)).toEqual({ day: 2, slotOfDay: 2 });
  });

  it("reaches day 4 on the last two attempts", () => {
    expect(describeAttempt(cadence, 7)).toEqual({ day: 4, slotOfDay: 1 });
    expect(describeAttempt(cadence, 8)).toEqual({ day: 4, slotOfDay: 2 });
  });

  it("returns null outside the sequence", () => {
    expect(describeAttempt(cadence, 0)).toBeNull();
    expect(describeAttempt(cadence, 9)).toBeNull();
  });
});

describe("nextAttempt", () => {
  it("is attempt 1 when nothing has been tried yet", () => {
    expect(nextAttempt(cadence, 0)).toEqual({ day: 1, slotOfDay: 1 });
  });

  it("advances as attempts are made", () => {
    expect(nextAttempt(cadence, 2)).toEqual({ day: 2, slotOfDay: 1 });
  });

  it("is null once all 8 attempts are used", () => {
    expect(nextAttempt(cadence, 8)).toBeNull();
  });
});

describe("decideNextAttempt", () => {
  it("attempts when the lead is still first-touch and the sequence isn't exhausted", () => {
    expect(decideNextAttempt(cadence, 0, { firstTouch: true })).toBe("attempt");
    expect(decideNextAttempt(cadence, 5, { firstTouch: true })).toBe("attempt");
  });

  /**
   * This is the case the human-ISA overlap makes real: a lead the ISA
   * reached on day 2 must stop being called on days 3 and 4. Re-checking
   * before every attempt (not just at sequence start) is what catches it.
   */
  it("stops once a fresh check shows someone else already contacted the lead", () => {
    expect(decideNextAttempt(cadence, 3, { firstTouch: false })).toBe("stop-already-contacted");
  });

  it("reports the sequence exhausted once every attempt has been used, even if still untouched", () => {
    expect(decideNextAttempt(cadence, 8, { firstTouch: true })).toBe("sequence-exhausted");
  });

  it("skips the re-check when recheckBeforeEachAttempt is off, gating only on attempt count", () => {
    const noRecheck: OutreachCadenceConfig = { ...cadence, recheckBeforeEachAttempt: false };
    expect(decideNextAttempt(noRecheck, 3, { firstTouch: false })).toBe("attempt");
  });
});

/**
 * America/St_Johns specifically because config/clients/3-percent-east-coast
 * .json's own comments flag it (UTC-02:30, a half-hour offset) as "a
 * classic source of scheduling bugs." Asserting by rendering the result
 * BACK through Intl in that same zone, rather than hand-computing UTC
 * offsets for the expected value — self-consistent and avoids baking my
 * own arithmetic mistake into the test.
 */
describe("nextAttemptTime", () => {
  const TZ = "America/St_Johns";

  function localHourAndDate(date: Date): { hour: number; date: string } {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: TZ,
        hour: "numeric",
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
        .formatToParts(date)
        .map((p) => [p.type, p.value])
    );
    return { hour: Number(parts.hour), date: `${parts.year}-${parts.month}-${parts.day}` };
  }

  // 2026-09-02T12:00:00Z is 09:30 local (NDT, UTC-02:30, daylight time in September).
  const sequenceStart = new Date("2026-09-02T12:00:00Z");

  it("returns null for attempt 1 — that's the immediate post-intake dial, not a fixed slot", () => {
    expect(nextAttemptTime(cadence, 1, sequenceStart, TZ)).toBeNull();
  });

  it("schedules attempt 2 at 2pm local, same day as sequence start", () => {
    const result = nextAttemptTime(cadence, 2, sequenceStart, TZ)!;
    expect(localHourAndDate(result)).toEqual({ hour: 14, date: "2026-09-02" });
  });

  it("schedules attempt 3 at 10am local the next day", () => {
    const result = nextAttemptTime(cadence, 3, sequenceStart, TZ)!;
    expect(localHourAndDate(result)).toEqual({ hour: 10, date: "2026-09-03" });
  });

  it("reaches day 4 (sequence start + 3 days) on the last two attempts", () => {
    expect(localHourAndDate(nextAttemptTime(cadence, 7, sequenceStart, TZ)!)).toEqual({
      hour: 10,
      date: "2026-09-05",
    });
    expect(localHourAndDate(nextAttemptTime(cadence, 8, sequenceStart, TZ)!)).toEqual({
      hour: 14,
      date: "2026-09-05",
    });
  });

  it("returns null once past the end of the sequence", () => {
    expect(nextAttemptTime(cadence, 9, sequenceStart, TZ)).toBeNull();
  });
});

/**
 * Mark's instruction, 2026-09-11: real calling-hours compliance, 8am-9pm in
 * the CLIENT's own configured business timezone. Three real gaps this
 * closes, all confirmed live the same day: the immediate ~5-minute
 * post-intake dial had no time-of-day check at all (a 2am form submission
 * got called at 2:05am), dial-pending.ts's already-past-the-slot retry
 * fallback had the same gap, and a lead's own stated callback preference
 * was never checked against business hours before being scheduled.
 */
describe("clampToLegalCallingWindow / isWithinLegalCallingWindow", () => {
  const TZ = "America/St_Johns";

  function localHour(date: Date): number {
    return Number(
      new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hour12: false }).format(date)
    );
  }

  function localDate(date: Date): string {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(date)
        .map((p) => [p.type, p.value])
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  it("leaves a time already inside 8am-9pm untouched", () => {
    // 2026-09-02T14:00:00Z is 11:30 local (NDT, UTC-02:30).
    const candidate = new Date("2026-09-02T14:00:00Z");
    expect(clampToLegalCallingWindow(candidate, TZ)).toEqual(candidate);
    expect(isWithinLegalCallingWindow(candidate, TZ)).toBe(true);
  });

  it("pushes a too-early time (2am local) forward to 8am the same day", () => {
    // 2026-09-02T04:30:00Z is 02:00 local.
    const candidate = new Date("2026-09-02T04:30:00Z");
    expect(isWithinLegalCallingWindow(candidate, TZ)).toBe(false);
    const clamped = clampToLegalCallingWindow(candidate, TZ);
    expect(localHour(clamped)).toBe(8);
    expect(localDate(clamped)).toBe(localDate(candidate));
  });

  it("pushes a too-late time (11pm local) forward to 8am the NEXT day, not later the same day", () => {
    // 2026-09-02T01:30:00Z is 23:00 local on 2026-09-01.
    const candidate = new Date("2026-09-02T01:30:00Z");
    expect(isWithinLegalCallingWindow(candidate, TZ)).toBe(false);
    const clamped = clampToLegalCallingWindow(candidate, TZ);
    expect(localHour(clamped)).toBe(8);
    expect(localDate(clamped)).toBe("2026-09-02");
  });

  it("treats exactly 9pm local as outside the window (end hour is exclusive)", () => {
    // 2026-09-02T23:30:00Z is 21:00 local.
    const candidate = new Date("2026-09-02T23:30:00Z");
    expect(isWithinLegalCallingWindow(candidate, TZ)).toBe(false);
  });

  it("treats exactly 8am local as inside the window (start hour is inclusive)", () => {
    // 2026-09-02T10:30:00Z is 08:00 local.
    const candidate = new Date("2026-09-02T10:30:00Z");
    expect(isWithinLegalCallingWindow(candidate, TZ)).toBe(true);
    expect(clampToLegalCallingWindow(candidate, TZ)).toEqual(candidate);
  });
});
