/**
 * Don't ring a new lead before they have been told to expect the call (Mark, 2026-11-27 — Ellen Adams).
 *
 * The GHL intake automation texts a new lead "you'll receive a quick call from our AI assistant, IRIS". Iris used to wait a
 * fixed 5 minutes and dial, on the guess that the text had gone out by then. It usually has (about 40 seconds), but on
 * 11-27 the automation ran late (first text at +6.5 minutes, the IRIS text at +11.7) and Ellen was called at +5.7 with
 * nothing in her thread; she hung up after 50 seconds. GHL exposes no "delivered" event, so the check is to read the
 * thread: if our intro text is there, dial; if not, look again in a couple of minutes; after a cap, dial anyway (a late
 * automation must not mean a lead is never called) and tell Slack the text never went out.
 *
 * Pure so the decision can be tested without GHL or the clock. dial-pending.ts supplies the thread and stores waitStartedAt.
 */

export interface FirstCallConfig {
  /** Off unless a client has this automation and asks for it. */
  waitForIntroText: boolean;
  /** Longest to wait for the text, counted from the first time the lead was otherwise ready to be called. */
  maxWaitMinutes: number;
  /** How long to leave the row alone before looking at the thread again. */
  recheckMinutes: number;
  /** Case-insensitive regex source that identifies the intro text among the texts we sent. */
  introTextPattern: string;
}

export const DEFAULT_MAX_WAIT_MINUTES = 20;
export const DEFAULT_RECHECK_MINUTES = 2;

/** Normalises the raw config block; null when the client has not turned the wait on or gave no usable pattern. */
export function parseFirstCallConfig(raw: any): FirstCallConfig | null {
  if (!raw || raw.waitForIntroText !== true) return null;
  const pattern = typeof raw.introTextPattern === "string" ? raw.introTextPattern.trim() : "";
  if (!pattern) return null;
  try {
    new RegExp(pattern, "i");
  } catch {
    return null;
  }
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
  return {
    waitForIntroText: true,
    maxWaitMinutes: num(raw.maxWaitMinutes, DEFAULT_MAX_WAIT_MINUTES),
    recheckMinutes: num(raw.recheckMinutes, DEFAULT_RECHECK_MINUTES),
    introTextPattern: pattern,
  };
}

/** True when any text WE sent (the automation, a teammate or Iris) matches the intro pattern. */
export function introTextSent(texts: Array<{ from: string; text: string }>, pattern: string): boolean {
  const re = new RegExp(pattern, "i");
  return texts.some((t) => t.from === "us" && re.test(String(t.text ?? "")));
}

export type IntroWaitDecision =
  | { action: "dial" }
  | { action: "wait"; recheckAt: Date; startedAt: Date }
  | { action: "dial_anyway"; waitedMinutes: number };

/**
 * waitStartedAt is when this lead was first held for the text (null the first time). Counting from then, not from when the
 * lead arrived, keeps an overnight lead honest: the automation texts in the morning and the call is queued for 10 AM.
 */
export function decideIntroWait(args: { introSent: boolean; waitStartedAt: Date | null; now: Date; config: FirstCallConfig }): IntroWaitDecision {
  const { introSent, waitStartedAt, now, config } = args;
  if (introSent) return { action: "dial" };
  const startedAt = waitStartedAt ?? now;
  const waitedMinutes = Math.round((now.getTime() - startedAt.getTime()) / 60_000);
  if (waitedMinutes >= config.maxWaitMinutes) return { action: "dial_anyway", waitedMinutes };
  return { action: "wait", startedAt, recheckAt: new Date(now.getTime() + config.recheckMinutes * 60_000) };
}
