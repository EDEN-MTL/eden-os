import { describe, expect, it } from "vitest";
import { decideNextAttempt, describeAttempt, nextAttempt, totalAttempts } from "./cadence";
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
