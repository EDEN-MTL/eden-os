import { describe, expect, it } from "vitest";
import { checkCustomPeriod } from "./validate-period";

const TODAY = "2026-10-27";

describe("checkCustomPeriod", () => {
  it("accepts an ordinary past period", () => {
    expect(checkCustomPeriod("2026-10-01", "2026-10-20", TODAY)).toEqual({ error: null, warning: null });
    expect(checkCustomPeriod("2026-10-27", "2026-10-27", TODAY)).toEqual({ error: null, warning: null });
  });

  it("stops empty, impossible and backwards dates with a message", () => {
    expect(checkCustomPeriod("", "2026-10-20", TODAY).error).toMatch(/Pick a start date and an end date/);
    expect(checkCustomPeriod("2026-02-30", "2026-03-05", TODAY).error).toMatch(/not a real date/);
    expect(checkCustomPeriod("2026-10-20", "2026-10-01", TODAY).error).toMatch(/after the end date/);
  });

  it("stops a period longer than a year, counting both end days, and says how long it was", () => {
    expect(checkCustomPeriod("2025-10-27", "2026-10-26", TODAY).error).toBeNull();
    expect(checkCustomPeriod("2025-10-01", "2026-10-20", TODAY).error).toMatch(/366 days or less \(this one is 385\)/);
  });

  it("lets the future through with a warning, since the server answers it with empty data", () => {
    expect(checkCustomPeriod("2026-10-20", "2026-11-05", TODAY).warning).toMatch(/in the future/);
    expect(checkCustomPeriod("2026-11-01", "2026-11-05", TODAY)).toMatchObject({ error: null, warning: expect.stringMatching(/not started yet/) });
  });
});
