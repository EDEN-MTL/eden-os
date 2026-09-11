/**
 * Iris's outreach cadence — deciding whether to attempt contact right now,
 * for a lead that hasn't been reached yet.
 *
 * Jacob's design (config/clients/3-percent-east-coast.json ->
 * iris.outreachCadence): Iris calls a new lead morning and afternoon for the
 * first 3-4 days. Scout fires lead.enriched ONCE per lead, on intake — it
 * does not re-fire per attempt. Iris owns this cadence itself.
 *
 * The human ISA is still working leads until month end, so the SAME lead can
 * be worked by both. That means firstTouch has to be re-checked from the CRM
 * before EVERY attempt, not just once at sequence start — a lead the ISA
 * reaches on day 2 must stop being called on days 3 and 4. This module takes
 * that fresh check as an input rather than caching it, so it can't go stale.
 *
 * Kept free of I/O, same as qualification.ts: no scheduler, no timers, no
 * GHL calls — nextAttemptTime takes the sequence start as a plain Date
 * rather than computing "now" itself, and decideNextAttempt takes the fresh
 * touch check as a parameter rather than fetching it. The actual scheduling
 * (inserting/updating rows, running on a cron) lives in
 * agents/iris/dial-pending.ts, which calls into this module for the
 * decisions rather than duplicating them.
 */
import { OutreachCadenceConfig } from "./qualification";

export type AttemptDecision =
  /** Place the call. */
  | "attempt"
  /** Someone else (the human ISA) reached this lead since the last check — stop the sequence. */
  | "stop-already-contacted"
  /** Every scheduled attempt has been used and nobody ever answered. */
  | "sequence-exhausted";

export interface ScheduledAttempt {
  /** 1-indexed day of the sequence. */
  day: number;
  /** 1-indexed attempt within that day (1 = morning, 2 = afternoon, for the current attemptsPerDay: 2). */
  slotOfDay: number;
}

export function totalAttempts(cadence: OutreachCadenceConfig): number {
  return cadence.attemptsPerDay * cadence.days;
}

/**
 * Which day/slot a given 1-indexed attempt number falls on. Returns null for
 * an attempt number outside the sequence (< 1 or beyond totalAttempts).
 */
export function describeAttempt(cadence: OutreachCadenceConfig, attemptNumber: number): ScheduledAttempt | null {
  if (attemptNumber < 1 || attemptNumber > totalAttempts(cadence)) return null;
  const day = Math.ceil(attemptNumber / cadence.attemptsPerDay);
  const slotOfDay = attemptNumber - (day - 1) * cadence.attemptsPerDay;
  return { day, slotOfDay };
}

/**
 * The next attempt Iris should make, or null once the sequence is exhausted.
 * `attemptsMade` is the count of attempts already placed for this lead.
 */
export function nextAttempt(cadence: OutreachCadenceConfig, attemptsMade: number): ScheduledAttempt | null {
  return describeAttempt(cadence, attemptsMade + 1);
}

/**
 * The decision for right now, given how many attempts have already been
 * placed and a freshly re-checked read of the lead (firstTouch: true means
 * still nobody has spoken to them).
 *
 * recheckBeforeEachAttempt exists specifically because of the human-ISA
 * overlap during the transition period — if it's ever false in config, the
 * re-check is skipped and only the attempt count gates the decision.
 */
export function decideNextAttempt(
  cadence: OutreachCadenceConfig,
  attemptsMade: number,
  freshLead: { firstTouch: boolean }
): AttemptDecision {
  if (attemptsMade >= totalAttempts(cadence)) return "sequence-exhausted";
  if (cadence.recheckBeforeEachAttempt && !freshLead.firstTouch) return "stop-already-contacted";
  return "attempt";
}

/**
 * Clock-hour slots within a day, 24h format, used for attempt 2 onward.
 * Sized to attemptsPerDay: the current config (2/day) maps directly to
 * "morning and afternoon" per the SOP; a different attemptsPerDay spreads
 * evenly across the same 9am-5pm window rather than guessing new fixed
 * hours out of nowhere.
 */
function slotHours(attemptsPerDay: number): number[] {
  if (attemptsPerDay === 2) return [10, 14];
  if (attemptsPerDay === 1) return [10];
  const start = 9;
  const end = 17;
  const step = (end - start) / (attemptsPerDay - 1);
  return Array.from({ length: attemptsPerDay }, (_, i) => Math.round(start + i * step));
}

/**
 * Converts a wall-clock hour on a given date, in a given IANA timezone, to
 * the correct UTC instant — DST-safe and half-hour-offset-safe. No library:
 * compares how the same UTC instant renders in the target zone vs UTC
 * itself, and corrects by the difference. This exists because
 * config/clients/3-percent-east-coast.json's own comments flag
 * America/St_Johns (UTC-02:30, a half-hour offset) as "a classic source of
 * scheduling bugs" — getting this wrong would silently call at the wrong
 * time, not throw.
 */
function zonedHourToUtc(year: number, monthIndex: number, day: number, hour: number, timeZone: string): Date {
  const asIfUtc = Date.UTC(year, monthIndex, day, hour, 0, 0);
  const probe = new Date(asIfUtc);
  const renderedInZone = new Date(probe.toLocaleString("en-US", { timeZone }));
  const renderedInUtc = new Date(probe.toLocaleString("en-US", { timeZone: "UTC" }));
  const offsetMs = renderedInUtc.getTime() - renderedInZone.getTime();
  return new Date(asIfUtc + offsetMs);
}

/** 8am–9pm, Mark's explicit instruction, 2026-09-11 — see clampToLegalCallingWindow. */
const LEGAL_CALLING_START_HOUR = 8;
const LEGAL_CALLING_END_HOUR = 21;

/**
 * Pushes a candidate instant forward to the next legal calling window
 * (8am-9pm, in the CLIENT's own configured business timezone — never the
 * lead's, which this system doesn't reliably know) if it falls outside
 * that window. Real compliance requirement, not a UX nicety: contacting a
 * consumer outside a defined daily window is restricted regardless of how
 * the timing was arrived at. Three real gaps this closes, all confirmed
 * live, 2026-09-11: the immediate ~5-minute post-intake dial
 * (agents/iris/index.ts) had no time-of-day check at all — a lead who
 * fills out a form at 2am got called at 2:05am; dial-pending.ts's
 * already-past-the-slot retry fallback ("try again in 5 minutes") had the
 * same gap; and a lead's own stated callback preference during a live call
 * was never checked against business hours before being scheduled.
 *
 * Same "render in zone via toLocaleString, read back with local getters"
 * technique as nextAttemptTime below — the server's own getHours()/getDate()
 * etc. read as if they were in `timeZone`, not the server's real one, once
 * the Date has been round-tripped through toLocaleString(..., {timeZone}).
 */
export function clampToLegalCallingWindow(candidate: Date, timeZone: string): Date {
  const inZone = new Date(candidate.toLocaleString("en-US", { timeZone }));
  const hour = inZone.getHours();
  if (hour >= LEGAL_CALLING_START_HOUR && hour < LEGAL_CALLING_END_HOUR) return candidate;

  // Before the window opens today → push to 8am today. At/after it closes
  // → push to 8am tomorrow. Either way, land on 8am exactly.
  const dayOffset = hour < LEGAL_CALLING_START_HOUR ? 0 : 1;
  const target = new Date(inZone);
  target.setDate(target.getDate() + dayOffset);
  return zonedHourToUtc(target.getFullYear(), target.getMonth(), target.getDate(), LEGAL_CALLING_START_HOUR, timeZone);
}

/**
 * Whether a candidate instant already falls within the legal calling
 * window, without shifting it — for callers that need to reject/ask again
 * rather than silently reschedule (a lead's own explicitly stated callback
 * time shouldn't be silently moved without telling them; see
 * webhooks/vapi-tools.ts's handleScheduleCallback).
 */
export function isWithinLegalCallingWindow(candidate: Date, timeZone: string): boolean {
  const hour = new Date(candidate.toLocaleString("en-US", { timeZone })).getHours();
  return hour >= LEGAL_CALLING_START_HOUR && hour < LEGAL_CALLING_END_HOUR;
}

/**
 * Wall-clock time for a given attempt, in the client's timezone. Attempt 1
 * always returns null — it's the immediate ~5-minute-after-intake dial
 * (agents/iris/index.ts's CALL_DELAY_MINUTES), not a fixed clock slot, so
 * its timing is decided elsewhere. Attempt 2 onward lands on slotHours()
 * for that attempt's day, counting the day sequenceStart falls on (in
 * timeZone) as day 1.
 */
export function nextAttemptTime(
  cadence: OutreachCadenceConfig,
  attemptNumber: number,
  sequenceStart: Date,
  timeZone: string
): Date | null {
  if (attemptNumber <= 1) return null;
  const attempt = describeAttempt(cadence, attemptNumber);
  if (!attempt) return null;

  const startInZone = new Date(sequenceStart.toLocaleString("en-US", { timeZone }));
  const target = new Date(startInZone);
  target.setDate(target.getDate() + (attempt.day - 1));

  const hours = slotHours(cadence.attemptsPerDay);
  const hour = hours[attempt.slotOfDay - 1] ?? hours[hours.length - 1];

  return zonedHourToUtc(target.getFullYear(), target.getMonth(), target.getDate(), hour, timeZone);
}
