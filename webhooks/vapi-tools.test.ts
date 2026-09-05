import { describe, expect, it } from "vitest";
import { resolveRequestedTime } from "./vapi-tools";

describe("resolveRequestedTime", () => {
  /**
   * Confirmed live, 2026-09-06: a real test call had the model send a bare
   * ISO string like "2026-09-05T18:00:00" (no offset) meaning "6 PM
   * Toronto" — bare `new Date(...)` on a string like that parses as the
   * SERVER's local time (a Render server runs in UTC), silently shifting
   * the intended moment by 4 hours and missing every real calendar slot.
   * Iris kept saying "trouble booking" because nothing ever matched, real
   * availability included. This is the fix: a naive (no-offset) string is
   * interpreted as wall-clock time in the given IANA timezone, not UTC.
   */
  it("interprets a bare (no-offset) timestamp as wall-clock time in the given timezone, not UTC", () => {
    // "6:30 PM" wall-clock in Toronto (EDT, UTC-4) is 22:30 UTC.
    const resolved = resolveRequestedTime("2026-09-05T18:30:00", "America/Toronto");
    expect(resolved).not.toBeNull();
    expect(resolved!.toISOString()).toBe("2026-09-05T22:30:00.000Z");
  });

  it("trusts a timestamp that already carries a 'Z' UTC marker", () => {
    const resolved = resolveRequestedTime("2026-09-05T22:30:00Z", "America/Toronto");
    expect(resolved!.toISOString()).toBe("2026-09-05T22:30:00.000Z");
  });

  it("trusts a timestamp that already carries an explicit offset", () => {
    const resolved = resolveRequestedTime("2026-09-05T18:30:00-04:00", "America/Toronto");
    expect(resolved!.toISOString()).toBe("2026-09-05T22:30:00.000Z");
  });

  it("handles a half-hour-offset timezone correctly (America/St_Johns, UTC-02:30)", () => {
    // St. John's is a classic source of scheduling bugs elsewhere in this
    // codebase (see agents/iris/cadence.ts's zonedHourToUtc) — same care
    // applies here.
    const resolved = resolveRequestedTime("2026-09-05T18:30:00", "America/St_Johns");
    expect(resolved!.toISOString()).toBe("2026-09-05T21:00:00.000Z");
  });

  it("returns null for an unparseable string", () => {
    expect(resolveRequestedTime("not a time", "America/Toronto")).toBeNull();
  });
});
