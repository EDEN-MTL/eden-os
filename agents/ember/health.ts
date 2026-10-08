/**
 * Ember's self-pause. Mark, 2026-10-09: "if there is something wrong,
 * Ember should pause and fix itself."
 *
 * Ember can't rewrite its own code, so "fix itself" means: notice, stop
 * before it does more harm, retry what usually clears on its own, and get
 * a person for what doesn't. Two severities:
 *
 *   cool — a hiccup that normally passes (GHL or the AI erroring, a run of
 *          failed sends). Sending pauses COOL_OFF_MINUTES, then resumes by
 *          itself and says so in Slack. A third cool-off within a day means
 *          it isn't passing: escalates to stop.
 *   stop — something a person has to look at (the sending number or the
 *          GHL account rejecting sends, too many leads texting STOP).
 *          Stays paused — sends AND replies — until resumed from Slack.
 *
 * Separate from ember.enabled: that's the human's switch in config; this
 * is Ember's own, in the database, so it can flip it without a deploy.
 */
import { AlertFn } from "./alerts";
import type { BatchResult } from "./outreach";
import { getHealth, HealthRow, optOutsLastDay, setHealth } from "./store";

export const COOL_OFF_MINUTES = 60;
/** The cool-off that escalates to a full stop, counted within a day. */
export const MAX_COOLDOWNS_PER_DAY = 3;
/** STOP replies in a day that trip a stop — but only when they're also this share of the day's texts. */
export const OPT_OUT_MIN = 3;
export const OPT_OUT_SHARE = 0.25;

export interface HealthStore {
  get(clientId: string): Promise<HealthRow>;
  set(clientId: string, h: HealthRow): Promise<void>;
}
const dbStore: HealthStore = { get: getHealth, set: setHealth };

export type Severity = "cool" | "stop";
export type Gate = { ok: true } | { ok: false; state: "cooling" | "stopped"; reason: string };

/**
 * Errors that won't clear by waiting — the account or the number itself is
 * being refused. Matched loosely on purpose: GHL and Twilio word these
 * differently, and a false "stop" costs a Slack ping, a missed one costs a
 * day of failed sends.
 */
const NEEDS_A_PERSON = /invalid from number|from number|not a valid.*number for this account|unauthori[sz]ed|forbidden|\b40[13]\b|insufficient (funds|balance|credit)|wallet|suspended|deactivated|account (is )?(disabled|inactive)/i;
const AI_FAILED = /history review failed|status check failed|could not resolve authentication|credit balance/i;

/** What a finished send run says about Ember's health, or null if it looks fine. */
export function assessBatch(result: BatchResult): { severity: Severity; reason: string } | null {
  const errors = result.failed.map((f) => f.error ?? "");
  const fatal = errors.find((e) => NEEDS_A_PERSON.test(e));
  if (fatal) return { severity: "stop", reason: `GHL refused a send in a way waiting won't fix: "${fatal.slice(0, 160)}"` };
  if (result.failed.length >= 3 && result.failed.length >= result.sent) {
    return { severity: "cool", reason: `${result.failed.length} of ${result.attempted} sends failed (latest: "${errors[errors.length - 1].slice(0, 120)}")` };
  }
  const aiFailures = result.skipped.filter((s) => AI_FAILED.test(s.skippedReason ?? ""));
  if (aiFailures.length >= 3) {
    return { severity: "cool", reason: `the AI review failed for ${aiFailures.length} leads (latest: "${(aiFailures[aiFailures.length - 1].skippedReason ?? "").slice(0, 120)}")` };
  }
  return null;
}

/** Too many people asking to stop in a day means the texts themselves may be the problem. */
export async function assessOptOuts(clientId: string, read = optOutsLastDay): Promise<{ severity: Severity; reason: string } | null> {
  const { stops, sends } = await read(clientId);
  if (stops >= OPT_OUT_MIN && stops >= Math.max(1, sends) * OPT_OUT_SHARE) {
    return { severity: "stop", reason: `${stops} leads asked to stop in the last day, out of ${sends} texts — the messages may need a look before more go out` };
  }
  return null;
}

/**
 * Whether Ember may act for this client right now. A cool-off that has run
 * its course resumes here, so the next scheduled run is the retry.
 */
export async function checkHealth(clientId: string, alert: AlertFn, now: Date = new Date(), store: HealthStore = dbStore): Promise<Gate> {
  const h = await store.get(clientId);
  if (h.state === "ok") return { ok: true };
  if (h.state === "cooling" && h.pausedUntil && new Date(h.pausedUntil).getTime() <= now.getTime()) {
    await store.set(clientId, { ...h, state: "ok", reason: null, pausedUntil: null });
    await alert(`✅ *Ember resumed by itself* — ${clientId}. The pause for "${h.reason}" has passed; trying again now.`).catch(() => {});
    return { ok: true };
  }
  return { ok: false, state: h.state, reason: h.reason ?? "paused" };
}

/** Pauses Ember for this client and tells the team why and what happens next. */
export async function tripHealth(
  clientId: string,
  severity: Severity,
  reason: string,
  alert: AlertFn,
  now: Date = new Date(),
  store: HealthStore = dbStore
): Promise<HealthRow> {
  const h = await store.get(clientId);
  if (h.state === "stopped") return h; // already waiting on a person — don't re-alert
  const recent = h.lastTripAt && now.getTime() - new Date(h.lastTripAt).getTime() < 86_400_000;
  const cooldowns = (recent ? h.cooldowns : 0) + (severity === "cool" ? 1 : 0);
  const escalate = severity === "cool" && cooldowns >= MAX_COOLDOWNS_PER_DAY;

  if (severity === "cool" && !escalate) {
    const until = new Date(now.getTime() + COOL_OFF_MINUTES * 60_000);
    const next: HealthRow = { state: "cooling", reason, pausedUntil: until.toISOString(), cooldowns, lastTripAt: now.toISOString() };
    await store.set(clientId, next);
    await alert(
      `⏸️ *Ember paused itself* — ${clientId}\n${reason}.\nThis usually clears on its own, so it will try again in ${COOL_OFF_MINUTES} minutes. ` +
        `(Pause ${cooldowns} of ${MAX_COOLDOWNS_PER_DAY - 1} allowed today before it stops for good.)`
    ).catch(() => {});
    return next;
  }

  const why = escalate ? `${reason} — and this is the ${cooldowns}th pause today, so waiting isn't fixing it` : reason;
  const next: HealthRow = { state: "stopped", reason: why, pausedUntil: null, cooldowns, lastTripAt: now.toISOString() };
  await store.set(clientId, next);
  await alert(
    `🛑 *Ember stopped itself* — ${clientId}\n${why}.\nNo texts or replies go out until someone checks and resumes it ` +
      `(ask Ember "resume sending for ${clientId}"). Leads who reply in the meantime are flagged here for a person to answer.`
  ).catch(() => {});
  return next;
}

/** A person has looked and says go. */
export async function resumeHealth(clientId: string, store: HealthStore = dbStore): Promise<HealthRow> {
  const h = await store.get(clientId);
  const next: HealthRow = { ...h, state: "ok", reason: null, pausedUntil: null, cooldowns: 0 };
  await store.set(clientId, next);
  return next;
}
