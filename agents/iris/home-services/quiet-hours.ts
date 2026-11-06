import { zonedHourToUtc } from "../cadence";

/** Local hour (0-23) of an instant in a zone. */
export function localHour(at: Date, timeZone: string): number {
  return new Date(at.toLocaleString("en-US", { timeZone })).getHours();
}

export function isWithinSendWindow(at: Date, timeZone: string, startHour: number, endHour: number): boolean {
  const hour = localHour(at, timeZone);
  return hour >= startHour && hour < endHour;
}

/**
 * Pushes an instant forward to the next moment texting is allowed: before the window opens today
 * lands on the opening hour today, at or after it closes lands on the opening hour tomorrow.
 * Same technique as agents/iris/cadence.ts's clampToLegalCallingWindow, but with the window the
 * client agreed to (the brief: nothing before 9:00 or after 20:00 Montreal time) rather than the
 * fixed 8-21 calling window.
 */
export function clampToSendWindow(candidate: Date, timeZone: string, startHour: number, endHour: number): Date {
  if (isWithinSendWindow(candidate, timeZone, startHour, endHour)) return candidate;
  const inZone = new Date(candidate.toLocaleString("en-US", { timeZone }));
  const dayOffset = inZone.getHours() < startHour ? 0 : 1;
  const target = new Date(inZone);
  target.setDate(target.getDate() + dayOffset);
  return zonedHourToUtc(target.getFullYear(), target.getMonth(), target.getDate(), startHour, timeZone);
}

/** True on Monday-Friday in the zone. */
export function isWeekday(at: Date, timeZone: string): boolean {
  const day = new Date(at.toLocaleString("en-US", { timeZone })).getDay();
  return day >= 1 && day <= 5;
}
