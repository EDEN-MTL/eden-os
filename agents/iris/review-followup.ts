/**
 * Iris follows up, every day, on the leads the nightly lead review says were dropped.
 *
 * Mark's rule (2026-10-29): Iris goes through every stage, reads each lead's conversation and notes, and works out who
 * needs a follow-up "so we don't miss" them. The review (lead-review.ts) did the reading but only listed names; acting
 * on them waited for a person to ask Iris in Slack, and nobody ever did. Magar Bhuma was flagged "qualified, untouched"
 * every morning from 2026-11-05 and nothing happened for a week (2026-11-12, Mark: "I mean every day check").
 *
 * This is the acting half, once a day after the review. It uses the same vetting as the Slack "act on the flagged
 * leads" command (pickFollowUpLeads, below: do-not-call, no-calls, booked, a teammate in touch, a 6-month-old inquiry
 * all leave a lead out) and the same follow-up as that command: Iris calls one lead at a time and texts anyone who
 * doesn't pick up (queueColdLeadSweep). What it does NOT do on its own:
 *   - leads whose card sits with an agent (Live Transferred, Appointment Set, ...): the team has them;
 *   - leads parked on purpose (Not Ready, Long Term Nurturing): a person decides to pull them back;
 *   - a lead whose last message is theirs and unanswered (unanswered_reply): a person reads that one first, because
 *     the right answer might be none ("I'll get back to you when I'm ready", Ololade, 2026-11-07);
 *   - more than maxPerDay leads in a day: the rest wait for tomorrow and are named in the post.
 * Every lead followed up is snoozed from the review for a few days, so the same lead isn't dialled daily.
 *
 * Off per client unless iris.dailyFollowUp.enabled.
 */
import { query } from "../../shared/db";
import { getContact, getGhlConfig } from "../../shared/ghl";
import { sendMessage } from "../../shared/slack";
import { clampToLegalCallingWindow, formatLocal } from "./cadence";
import { CALL_LOG_CHANNEL } from "./channels";
import { queueColdLeadSweep } from "./dial-pending";
import { checkHumanTouch, DEFAULT_HUMAN_HANDS_OFF_DAYS } from "./human-touch";
import { Finding, FindingKind, isWithAgentStage, latestReview } from "./lead-review";
import { loadIrisConfig } from "./index";

/** A review is a day old at most when it is acted on; older than this and the facts may have moved on. */
export const REVIEW_MAX_AGE_MS = 36 * 3_600_000;
/** CASL: an inquiry older than this is outside implied consent, so Jacob decides (Mark, 2026-10-22). */
export const STALE_INQUIRY_MS = 180 * 86_400_000;

/**
 * Columns a lead was put in on purpose after a week of follow-up or by the team (Not Ready, Long Term Nurturing). The
 * review still reads them, but Iris does not pull a lead back out of one by herself: a person decides.
 */
export const PARKED_STAGES = ["Not Ready - [Endless Loop]", "Long Term Nurturing"];
const isParkedStage = (stageName: string): boolean => PARKED_STAGES.some((s) => s.toLowerCase() === String(stageName).trim().toLowerCase());

export interface DailyFollowUpConfig {
  enabled: boolean;
  maxPerDay: number;
  /** Which kinds of dropped ball Iris chases herself. */
  kinds: FindingKind[];
  /** Days a followed-up lead stays out of the review, so it isn't chased again straight away. */
  snoozeDays: number;
}

export const DEFAULT_DAILY_FOLLOW_UP: Omit<DailyFollowUpConfig, "enabled"> = {
  maxPerDay: 5,
  kinds: ["owed_contact", "qualified_untouched", "only_missed_attempts"],
  snoozeDays: 3,
};

export interface FollowUpCandidate {
  id: string;
  name: string;
  kind: FindingKind;
  headline: string;
}

/**
 * Re-reads every flagged lead LIVE (the review is up to a day old) and keeps only those still safe to contact.
 * `left` says why each of the others was left out, in words a person can read.
 */
export async function pickFollowUpLeads(
  clientId: string,
  findings: Finding[],
  opts: { humanHandsOffDays: number; now: Date; reviewRanAt: Date }
): Promise<{ eligible: FollowUpCandidate[]; left: string[] }> {
  const ghl = await getGhlConfig(clientId);
  const eligible: FollowUpCandidate[] = [];
  const left: string[] = [];
  if (!ghl) return { eligible, left: findings.map((f) => `${f.name} (couldn't reach the CRM)`) };
  for (const f of findings) {
    if (eligible.some((e) => e.id === f.contactId)) continue;
    const raw = await getContact(f.contactId, ghl.locationId, ghl.apiKey).catch(() => null);
    const contact = raw?.contact ?? raw;
    const tags: string[] = (contact?.tags ?? []).map((t: string) => String(t).toLowerCase());
    const added = contact?.dateAdded ? new Date(contact.dateAdded).getTime() : NaN;
    if (!contact) left.push(`${f.name} (couldn't read their record)`);
    else if (contact.dnd || tags.includes("do not call")) left.push(`${f.name} (do not call)`);
    else if (tags.includes("no calls")) left.push(`${f.name} (no calls)`);
    else if (!contact.phone) left.push(`${f.name} (no phone)`);
    else if (tags.includes("appt booked") || tags.includes("live transferred")) left.push(`${f.name} (already ${tags.includes("appt booked") ? "booked" : "live transferred"})`);
    // They wrote to us, so an old inquiry is not the issue; otherwise an inquiry over six months old needs Jacob's OK.
    else if (f.kind !== "unanswered_reply" && Number.isFinite(added) && opts.now.getTime() - added > STALE_INQUIRY_MS) left.push(`${f.name} (inquiry over 6 months old — needs Jacob's OK)`);
    else {
      // Calls count here: a teammate who has called or texted since the review ran is working this lead.
      const touch = await checkHumanTouch(f.contactId, ghl.locationId, ghl.apiKey, opts.humanHandsOffDays, opts.now);
      if (touch.status !== "none") left.push(`${f.name} (a teammate has been in touch)`);
      else {
        // Iris or Ember already dealt with them since the review ran. A row parked for a text reply (call_after
        // 'infinity') is not "in hand": that is what Magar's was for a week, which hid him from this very check.
        const recent = await query<{ n: string }>(
          `SELECT (SELECT count(*) FROM iris_pending_calls WHERE client_id = $1 AND contact_id = $2 AND status = 'pending' AND call_after < now() + interval '1 day')
                + (SELECT count(*) FROM iris_call_log WHERE client_id = $1 AND contact_id = $2 AND created_at > $3) AS n`,
          [clientId, f.contactId, opts.reviewRanAt]
        );
        if (Number(recent[0]?.n ?? 0) > 0) left.push(`${f.name} (Iris already has them in hand)`);
        else eligible.push({ id: f.contactId, name: f.name, kind: f.kind, headline: f.headline });
      }
    }
  }
  return { eligible, left };
}

export interface DailyFollowUpResult {
  /** Why nothing was done, when that is the case. */
  skipped?: string;
  queued: FollowUpCandidate[];
  /** Eligible, but over the daily cap: they go next. */
  waiting: FollowUpCandidate[];
  /** Left out by the live check (with the reason) or because a person should read their thread first. */
  left: string[];
  forAPerson: Finding[];
  startAt: Date | null;
  timeZone: string;
}

export async function runDailyLeadFollowUp(clientId: string, options: { now?: Date; dryRun?: boolean } = {}): Promise<DailyFollowUpResult> {
  const now = options.now ?? new Date();
  const config = loadIrisConfig(clientId);
  const timeZone = config?.timezone || "America/St_Johns";
  const empty: DailyFollowUpResult = { queued: [], waiting: [], left: [], forAPerson: [], startAt: null, timeZone };
  const settings = { ...DEFAULT_DAILY_FOLLOW_UP, ...(config?.dailyFollowUp ?? {}) };
  if (!config) return { ...empty, skipped: "no Iris config" };
  if (!config.dailyFollowUp?.enabled && !options.dryRun) return { ...empty, skipped: "daily follow-up is off" };

  const review = await latestReview(clientId);
  if (!review) return { ...empty, skipped: "the lead review hasn't run yet" };
  if (now.getTime() - review.ranAt.getTime() > REVIEW_MAX_AGE_MS) return { ...empty, skipped: "the latest lead review is too old to act on" };

  const open = review.findings.filter((f) => !f.withAgent && !isWithAgentStage(f.stageName));
  const mine = open.filter((f) => settings.kinds.includes(f.kind) && !isParkedStage(f.stageName));
  const forAPerson = open.filter((f) => !settings.kinds.includes(f.kind) || isParkedStage(f.stageName));

  const { eligible, left } = await pickFollowUpLeads(clientId, mine, {
    humanHandsOffDays: config.humanHandsOffDays ?? DEFAULT_HUMAN_HANDS_OFF_DAYS,
    now,
    reviewRanAt: review.ranAt,
  });
  const queued = eligible.slice(0, settings.maxPerDay);
  const waiting = eligible.slice(settings.maxPerDay);
  // Not before ten minutes from now, and inside calling hours (the call job then holds the rest to its own slots).
  const startAt = queued.length > 0 ? clampToLegalCallingWindow(new Date(now.getTime() + 10 * 60_000), timeZone) : null;

  if (!options.dryRun && startAt) {
    const placed = await queueColdLeadSweep(clientId, queued.map((q) => q.id), startAt);
    const ok = new Set(placed.map((p) => p.contactId));
    for (const q of queued) {
      if (!ok.has(q.id)) {
        left.push(`${q.name} (no readable record, phone or name)`);
        continue;
      }
      await query(
        `INSERT INTO lead_review_snoozes (client_id, contact_id, contact_name, until, reason, requested_by)
         VALUES ($1, $2, $3, now() + ($4 || ' days')::interval, 'followed up by the daily review', 'iris')
         ON CONFLICT (client_id, contact_id) DO UPDATE SET until = EXCLUDED.until, reason = EXCLUDED.reason, requested_by = EXCLUDED.requested_by`,
        [clientId, q.id, q.name, String(settings.snoozeDays)]
      );
    }
    return { queued: queued.filter((q) => ok.has(q.id)), waiting, left, forAPerson, startAt, timeZone };
  }
  return { queued, waiting, left, forAPerson, startAt, timeZone };
}

export function formatDailyFollowUpPost(r: DailyFollowUpResult): string | null {
  if (r.skipped) return null;
  if (r.queued.length === 0 && r.forAPerson.length === 0 && r.waiting.length === 0) return null;
  const lines: string[] = [];
  if (r.queued.length > 0 && r.startAt) {
    lines.push(`🔎 *Daily lead follow-up:* I lined up ${r.queued.length} lead${r.queued.length === 1 ? "" : "s"} the review says were dropped. I call them one at a time from ${formatLocal(r.startAt.toISOString(), r.timeZone)} and text anyone who doesn't pick up.`);
    for (const q of r.queued) lines.push(`• *${q.name}*: ${q.headline}`);
  } else {
    lines.push("🔎 *Daily lead follow-up:* nobody to line up today.");
  }
  if (r.waiting.length > 0) lines.push(``, `Next in line (over today's limit): ${r.waiting.map((w) => `*${w.name}*`).join(", ")}.`);
  if (r.forAPerson.length > 0) {
    lines.push("", "*Needs a person to read their thread first:*");
    for (const f of r.forAPerson) lines.push(`• *${f.name}* (${f.stageName}): ${f.headline}`);
  }
  if (r.left.length > 0) lines.push("", `Left out: ${r.left.join("; ")}.`);
  return lines.join("\n");
}

export async function runDailyLeadFollowUpAll(): Promise<void> {
  let files: string[] = [];
  try {
    files = (await import("fs")).readdirSync((await import("path")).join(process.cwd(), "config", "clients"));
  } catch {
    return;
  }
  for (const f of files.filter((x) => x.endsWith(".json"))) {
    const clientId = f.replace(/\.json$/, "");
    if (!loadIrisConfig(clientId)?.dailyFollowUp?.enabled) continue;
    try {
      const result = await runDailyLeadFollowUp(clientId);
      console.log(`[DAILY-FOLLOWUP] ${clientId}: ${result.skipped ?? `${result.queued.length} lined up, ${result.forAPerson.length} for a person`}.`);
      const post = formatDailyFollowUpPost(result);
      if (post) await sendMessage("iris", { channel: CALL_LOG_CHANNEL, text: post }).catch((error) => console.error("[DAILY-FOLLOWUP] Slack post failed:", error instanceof Error ? error.message : error));
    } catch (error) {
      console.error(`[DAILY-FOLLOWUP] ${clientId}:`, error instanceof Error ? error.message : error);
    }
  }
}
