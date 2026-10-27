/** Checks a custom start and end date before anything is requested, with a message a person can act on. */
export const MAX_DAYS = 366;

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const day = (ymd: string) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
const real = (ymd: string) => YMD.test(ymd) && new Date(day(ymd)).toISOString().slice(0, 10) === ymd;

export interface PeriodCheck {
  /** Stops the request. */
  error: string | null;
  /** Lets the request through but is worth saying. */
  warning: string | null;
}

export function checkCustomPeriod(from: string, to: string, today: string): PeriodCheck {
  if (!from || !to) return { error: "Pick a start date and an end date.", warning: null };
  if (!real(from) || !real(to)) return { error: "One of the dates is not a real date.", warning: null };
  if (from > to) return { error: "The start date is after the end date.", warning: null };
  const days = Math.round((day(to) - day(from)) / 86_400_000) + 1;
  if (days > MAX_DAYS) return { error: `Pick a period of ${MAX_DAYS} days or less (this one is ${days}).`, warning: null };
  if (from > today) return { error: null, warning: "This period has not started yet, so there is nothing to report." };
  if (to > today) return { error: null, warning: "The end date is in the future. Days that have not happened yet show no data." };
  return { error: null, warning: null };
}
