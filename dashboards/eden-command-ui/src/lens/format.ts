import type { Preset, Unit } from "./types";

/** "N/A" for a metric that has no valid value (zero denominator, missing source). Never 0 or NaN. */
export const NA = "N/A";

const money = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moneyWhole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const count = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function formatValue(value: number | null | undefined, unit: Unit): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NA;
  switch (unit) {
    case "currency":
      // Whole dollars once a figure is big enough that cents are noise.
      return `${value < 0 ? "-" : ""}$${Math.abs(value) >= 10_000 ? moneyWhole.format(Math.abs(value)) : money.format(Math.abs(value))}`;
    case "count":
      return count.format(value);
    case "percent":
      return `${Math.abs(value) >= 100 ? Math.round(value) : value.toFixed(1)}%`;
    case "ratio":
      return `${value.toFixed(2)}x`;
  }
}

/** Short axis/tooltip label. */
export function formatCompact(value: number | null | undefined, unit: Unit): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NA;
  const abs = Math.abs(value);
  const short = abs >= 1_000_000 ? `${(abs / 1_000_000).toFixed(1)}M` : abs >= 10_000 ? `${Math.round(abs / 1000)}k` : abs >= 1000 ? `${(abs / 1000).toFixed(1)}k` : abs % 1 === 0 ? String(abs) : abs.toFixed(abs < 10 ? 2 : 1);
  const signed = `${value < 0 ? "-" : ""}${short}`;
  return unit === "currency" ? `$${signed}` : unit === "percent" ? `${signed}%` : unit === "ratio" ? `${signed}x` : signed;
}

/** Metrics where a LOWER number is the good direction. Everything else: higher is good, except the neutral ones below. */
const LOWER_IS_BETTER = new Set(["cpc", "cpl", "costPerAppointment", "costPerAttended", "costPerClosedDeal", "unqualifiedLeads", "noShowAppointments"]);
/** Spend and costs going up is neither good nor bad on its own. */
const NEUTRAL = new Set(["spend", "otherCosts"]);

export type Tone = "good" | "bad" | "neutral";

export function toneOf(key: string, change: number | null | undefined): Tone {
  if (change === null || change === undefined || change === 0 || NEUTRAL.has(key)) return "neutral";
  const up = change > 0;
  return LOWER_IS_BETTER.has(key) ? (up ? "bad" : "good") : up ? "good" : "bad";
}

/** "+12.5%" or "-3.0%"; a zero or N/A starting point has no percentage, so show the plain change instead. */
export function formatChange(change: number | null | undefined, changePct: number | null | undefined, unit: Unit): string | null {
  if (change === null || change === undefined || !Number.isFinite(change)) return null;
  if (change === 0) return "no change";
  if (changePct !== null && changePct !== undefined && Number.isFinite(changePct)) return `${changePct > 0 ? "+" : "-"}${Math.abs(changePct).toFixed(1)}%`;
  return `${change > 0 ? "+" : "-"}${formatValue(Math.abs(change), unit)}`;
}

export const PRESET_LABELS: Record<Preset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last_7_days: "Last 7 days",
  last_30_days: "Last 30 days",
  last_90_days: "Last 90 days",
  this_month: "This month",
  this_year: "This year",
  custom: "Custom range",
};

/** Query string for the three data endpoints. */
export function periodQuery(p: { preset: Preset; from: string; to: string; compare: boolean }): string {
  const q = new URLSearchParams({ preset: p.preset, compare: p.compare ? "1" : "0" });
  if (p.preset === "custom") {
    q.set("from", p.from);
    q.set("to", p.to);
  }
  return q.toString();
}

/** Short x-axis label for a chart bucket: "Oct 5" for a day, "Oct 5-11" for a week, "Oct" for a month. */
export function bucketLabel(from: string, to: string, granularity: "day" | "week" | "month"): string {
  const d = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
  const fmt = (ymd: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...o }).format(d(ymd));
  if (granularity === "day") return fmt(from, { month: "short", day: "numeric" });
  if (granularity === "month") return fmt(from, { month: "short" });
  return from === to ? fmt(from, { month: "short", day: "numeric" }) : `${fmt(from, { month: "short", day: "numeric" })}-${fmt(to, from.slice(0, 7) === to.slice(0, 7) ? { day: "numeric" } : { month: "short", day: "numeric" })}`;
}
