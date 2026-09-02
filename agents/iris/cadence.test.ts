import { describe, expect, it } from "vitest";
import { decideNextAttempt, describeAttempt, nextAttempt, nextAttemptTime, totalAttempts } from "./cadence";
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
