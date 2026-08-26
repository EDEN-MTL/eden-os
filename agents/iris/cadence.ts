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
 * GHL calls. There is nothing to schedule execution of yet, since calling
 * itself isn't wired up — this is the decision Iris's caller makes at each
 * attempt, once Vapi exists to act on it.
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
