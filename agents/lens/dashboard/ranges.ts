/**
 * Reporting periods for the Lens dashboard. A period is whole calendar days in the CLIENT's timezone,
 * inclusive at both ends ("2026-10-01" to "2026-10-07" is seven days). The presets follow Meta Ads Manager:
 * "Last 7 days" and "Last 30 days" are the complete days BEFORE today, so a half-finished day never makes
 * the latest numbers look worse than they are.
 */
import { zonedHourToUtc } from "../../iris/cadence";

export type RangePreset = "today" | "yesterday" | "last_7_days" | "last_30_days" | "this_month" | "custom";

export interface DateRange {
  /** YYYY-MM-DD, inclusive. */
  from: string;
  /** YYYY-MM-DD, inclusive. */
  to: string;
}

const MAX_RANGE_DAYS = 366;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date in the given timezone, as YYYY-MM-DD. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function parts(ymd: string): [number, number, number] {
  return [Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10))];
}

export function addDays(ymd: string, days: number): string {
  const [y, m, d] = parts(ymd);
  return new Date(Date.UTC(y, m, d + days)).toISOString().slice(0, 10);
}

export function daysInRange(r: DateRange): number {
  const [fy, fm, fd] = parts(r.from);
  const [ty, tm, td] = parts(r.to);
  return Math.round((Date.UTC(ty, tm, td) - Date.UTC(fy, fm, fd)) / 86_400_000) + 1;
}

export function isValidDate(ymd: unknown): ymd is string {
  if (typeof ymd !== "string" || !YMD.test(ymd)) return false;
  const [y, m, d] = parts(ymd);
  const date = new Date(Date.UTC(y, m, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m && date.getUTCDate() === d;
}

export type RangeResult = { ok: true; range: DateRange } | { ok: false; error: string };

export function resolveRange(preset: RangePreset, timeZone: string, now: Date = new Date(), custom?: { from?: string; to?: string }): RangeResult {
  const today = todayIn(timeZone, now);
  switch (preset) {
    case "today":
      return { ok: true, range: { from: today, to: today } };
    case "yesterday": {
      const y = addDays(today, -1);
      return { ok: true, range: { from: y, to: y } };
    }
    case "last_7_days":
      return { ok: true, range: { from: addDays(today, -7), to: addDays(today, -1) } };
    case "last_30_days":
      return { ok: true, range: { from: addDays(today, -30), to: addDays(today, -1) } };
    case "this_month":
      return { ok: true, range: { from: `${today.slice(0, 7)}-01`, to: today } };
    case "custom": {
      if (!isValidDate(custom?.from) || !isValidDate(custom?.to)) return { ok: false, error: "Pick a start and an end date." };
      if (custom!.from! > custom!.to!) return { ok: false, error: "The start date is after the end date." };
      const range = { from: custom!.from!, to: custom!.to! };
      if (daysInRange(range) > MAX_RANGE_DAYS) return { ok: false, error: `Pick a period of ${MAX_RANGE_DAYS} days or less.` };
      return { ok: true, range };
    }
    default:
      return { ok: false, error: `Unknown period "${String(preset)}".` };
  }
}

/** The period of the same length immediately before this one, for "compared with the previous period". */
export function previousRange(r: DateRange): DateRange {
  const n = daysInRange(r);
  return { from: addDays(r.from, -n), to: addDays(r.from, -1) };
}

/** The real instants a period covers: midnight at the start of `from` up to (not including) midnight after `to`. */
export function rangeBounds(r: DateRange, timeZone: string): { start: Date; end: Date } {
  const [fy, fm, fd] = parts(r.from);
  const [ty, tm, td] = parts(addDays(r.to, 1));
  return { start: zonedHourToUtc(fy, fm, fd, 0, timeZone), end: zonedHourToUtc(ty, tm, td, 0, timeZone) };
}

export function inRange(instant: Date | null | undefined, r: DateRange, timeZone: string): boolean {
  if (!instant) return false;
  const { start, end } = rangeBounds(r, timeZone);
  return instant.getTime() >= start.getTime() && instant.getTime() < end.getTime();
}

/** "Oct 1 to Oct 7, 2026" style label for the page and the exports. */
export function rangeLabel(r: DateRange): string {
  const fmt = (ymd: string, withYear: boolean) => {
    const [y, m, d] = parts(ymd);
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}) }).format(new Date(Date.UTC(y, m, d)));
  };
  return r.from === r.to ? fmt(r.from, true) : `${fmt(r.from, r.from.slice(0, 4) !== r.to.slice(0, 4))} to ${fmt(r.to, true)}`;
}
