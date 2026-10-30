/**
 * "Call Koren Pye now" / "stop calling Matthew Power", said to Iris in Slack
 * (Mark, 2026-10-10: build call and stop, confirm first).
 *
 * Two halves, deliberately separate:
 *   1. PREPARE — a model-driven tool (iris_request_call / iris_request_stop)
 *      checks the lead is safe to act on, stores a pending command and hands
 *      back a summary. It never does the thing itself.
 *   2. EXECUTE — plain code (handleCommandReply, wired into the agent's
 *      handleCustom hook, which runs BEFORE the model) acts only when the SAME
 *      person replies a bare "yes" in the SAME place within the time limit.
 *      The model can't confirm on anyone's behalf, because it never sees that
 *      reply — nothing it says or calls can execute a command.
 *
 * Only the Slack users in iris.slackCommands.allowedUserIds may ask at all.
 */
import { query } from "../../shared/db";
import { getContact, getGhlConfig, listContactsPaginated, listLocationUsers } from "../../shared/ghl";
import { sendMessage } from "../../shared/slack";
import { SlackIncomingMessage } from "../../shared/types";
import { ToolContext } from "../base-agent";
import { clampToLegalCallingWindow, formatLocal } from "./cadence";
import { queueColdLeadSweep, scheduleExplicitCallback } from "./dial-pending";
import { findTeammateCalls } from "./teammate-calls";
import { latestReview } from "./lead-review";
import { checkHumanTouch, DEFAULT_HUMAN_HANDS_OFF_DAYS } from "./human-touch";
import { linkLineFor } from "./links";

const DEFAULT_TTL_MINUTES = 10;
const MAX_DAYS_OUT = 7;
import { CALL_LOG_CHANNEL } from "./channels";

export interface CommandSettings {
  allowedUserIds: string[];
  confirmTtlMinutes: number;
  timezone: string;
  humanHandsOffDays: number;
}

/** Everything the module needs from Iris's config — passed in so this file doesn't import Iris's index (which imports it). */
export type SettingsLoader = (clientId: string) => CommandSettings | null;

const YES = /^(yes|y|yep|yeah|yup|confirm|confirmed|go ahead|do it|go)( please| do it)?$/;
const NO = /^(no|n|nope|cancel|cancelled|never ?mind|abort|don'?t|do not)$/;

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^\w' ]+/g, " ").replace(/\s+/g, " ").trim();
}

export function isYes(text: string): boolean {
  return YES.test(normalise(text));
}
export function isNo(text: string): boolean {
  return NO.test(normalise(text));
}

export interface PreparedCommand {
  status: "needs_confirmation" | "refused" | "ambiguous" | "not_found" | "nothing_to_do";
  commandId?: number;
  summary?: string;
  reason?: string;
  candidates?: string[];
  instruction: string;
}

function authorise(settings: CommandSettings | null, ctx: ToolContext | undefined): string | null {
  if (!ctx?.userId || !ctx.channelId) return "This only works in Slack, from a message I can tie to a person.";
  if (!settings || settings.allowedUserIds.length === 0) return "Slack commands aren't turned on for this client.";
  if (!settings.allowedUserIds.includes(ctx.userId)) return "I only take call/stop commands from Mark or Jacob.";
  return null;
}

const refused = (reason: string): PreparedCommand => ({ status: "refused", reason, instruction: `Tell them plainly: ${reason} Do not do anything else.` });

/** Up to five contacts matching a name or phone, one entry per contact id. */
async function findContacts(ghl: { locationId: string; apiKey: string }, nameOrPhone: string): Promise<{ id: string; name: string; phone: string | null }[]> {
  const found: { id: string; name: string; phone: string | null }[] = [];
  for await (const c of listContactsPaginated(ghl.locationId, { limit: 5, query: nameOrPhone, apiKey: ghl.apiKey })) {
    const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || c.contactName || nameOrPhone;
    if (!found.some((f) => f.id === c.id)) found.push({ id: c.id, name, phone: c.phone ?? null });
    if (found.length >= 5) break;
  }
  return found;
}

async function resolveOne(clientId: string, nameOrPhone: string): Promise<{ contact: { id: string; name: string }; ghl: { locationId: string; apiKey: string } } | PreparedCommand> {
  const ghl = await getGhlConfig(clientId);
  if (!ghl) return refused(`I couldn't reach the CRM for ${clientId}.`);
  const matches = await findContacts(ghl, nameOrPhone);
  if (matches.length === 0) return { status: "not_found", reason: `No lead matches "${nameOrPhone}".`, instruction: `Tell them you couldn't find a lead matching "${nameOrPhone}" and ask for the full name or the phone number.` };
  if (matches.length > 1) {
    const candidates = matches.map((m) => `${m.name}${m.phone ? ` (${m.phone})` : ""}`);
    return { status: "ambiguous", candidates, instruction: `More than one lead matches. List them and ask which one they mean — do not guess: ${candidates.join("; ")}` };
  }
  return { contact: { id: matches[0].id, name: matches[0].name }, ghl };
}

async function storePending(
  clientId: string,
  ctx: ToolContext,
  kind: "call" | "stop" | "followup" | "review",
  contact: { id: string; name: string },
  summary: string,
  callAt: Date | null,
  batch: { id: string; name: string }[] | null = null
): Promise<number> {
  // One live request per person per place: a newer one replaces the older.
  await query(
    `UPDATE iris_slack_commands SET status = 'cancelled', resolved_at = now()
     WHERE requested_by = $1 AND channel_id = $2 AND status = 'pending'`,
    [ctx.userId, ctx.channelId]
  );
  const rows = await query<{ id: string }>(
    `INSERT INTO iris_slack_commands (client_id, requested_by, channel_id, thread_ts, kind, contact_id, contact_name, call_at, summary, batch)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [clientId, ctx.userId, ctx.channelId, ctx.threadTs ?? null, kind, contact.id, contact.name, callAt, summary, batch ? JSON.stringify(batch) : null]
  );
  return Number(rows[0].id);
}

export async function prepareCallCommand(
  clientId: string,
  input: { nameOrPhone?: unknown; whenIso?: unknown },
  ctx: ToolContext | undefined,
  loadSettings: SettingsLoader,
  now: Date = new Date()
): Promise<PreparedCommand> {
  const settings = loadSettings(clientId);
  const denied = authorise(settings, ctx);
  if (denied || !settings || !ctx) return refused(denied ?? "Not allowed.");

  const nameOrPhone = String(input.nameOrPhone ?? "").trim();
  if (!nameOrPhone) return refused("I need the lead's name or phone number.");

  const resolved = await resolveOne(clientId, nameOrPhone);
  if ("status" in resolved) return resolved;
  const { contact, ghl } = resolved;

  const raw = await getContact(contact.id, ghl.locationId, ghl.apiKey);
  const c = raw?.contact ?? raw;
  const tags: string[] = (c?.tags ?? []).map((t: string) => String(t).toLowerCase());

  // Hard stops — never offer these.
  if (c?.dnd || tags.includes("do not call")) return refused(`${contact.name} is flagged do-not-disturb / "do not call" — I won't call them.`);
  if (!c?.phone) return refused(`${contact.name} has no phone number on file.`);
  if (![c?.firstName, c?.lastName].some(Boolean) && !c?.name) return refused(`${contact.name} has no confirmed name on file.`);

  // When: now (a minute out) unless a time was given; always inside calling hours.
  let wanted = new Date(now.getTime() + 60_000);
  if (typeof input.whenIso === "string" && input.whenIso.trim()) {
    const parsed = new Date(input.whenIso);
    if (Number.isNaN(parsed.getTime())) return refused(`I couldn't read "${input.whenIso}" as a time.`);
    if (parsed.getTime() < now.getTime() + 60_000) return refused("That time is already past — give me a time from a few minutes from now.");
    if (parsed.getTime() > now.getTime() + MAX_DAYS_OUT * 86_400_000) return refused(`I only schedule up to ${MAX_DAYS_OUT} days ahead.`);
    wanted = parsed;
  }
  const callAt = clampToLegalCallingWindow(wanted, settings.timezone);
  const moved = callAt.getTime() !== wanted.getTime();

  // Things worth knowing before saying yes — shown, not blocking.
  const warnings: string[] = [];
  const touch = await checkHumanTouch(contact.id, ghl.locationId, ghl.apiKey, settings.humanHandsOffDays);
  if (touch.status === "human") warnings.push(`a teammate texted them on ${formatLocal(touch.at, settings.timezone)}`);
  if (touch.status === "unknown") warnings.push("I couldn't check whether a teammate has texted them");
  if (tags.includes("live transferred") || tags.includes("appt booked")) warnings.push(`they're already tagged "${tags.includes("appt booked") ? "appt booked" : "live transferred"}"`);
  if (c?.assignedTo) {
    const users = await listLocationUsers(ghl.locationId, ghl.apiKey).catch(() => []);
    warnings.push(`assigned to ${users.find((u) => u.id === c.assignedTo)?.name ?? "an agent"}`);
  }
  const inFlight = await query<{ one: number }>(
    `SELECT 1 AS one FROM iris_call_log WHERE client_id = $1 AND contact_id = $2 AND status = 'initiated' AND created_at > now() - interval '20 minutes' LIMIT 1`,
    [clientId, contact.id]
  );
  if (inFlight.length > 0) warnings.push("a call to them is in progress right now");
  const row = await query<{ status: string; call_after: Date | null }>(`SELECT status, call_after FROM iris_pending_calls WHERE client_id = $1 AND contact_id = $2`, [clientId, contact.id]);
  // call_after is Postgres 'infinity' for a lead parked waiting on a text reply — not a real time.
  const queuedFor = row[0]?.call_after;
  if (row[0]?.status === "pending" && queuedFor instanceof Date && Number.isFinite(queuedFor.getTime())) {
    warnings.push(`a call is already queued for ${formatLocal(queuedFor.toISOString(), settings.timezone)} — this replaces it`);
  }

  const when = formatLocal(callAt.toISOString(), settings.timezone);
  const summary =
    `Call *${contact.name}* (${c.phone}) ${moved ? `— that's outside calling hours, so at ${when}` : `at ${when}`}.` +
    (warnings.length ? `\nHeads-up: ${warnings.join("; ")}.` : "");

  const commandId = await storePending(clientId, ctx, "call", contact, summary, callAt);
  return {
    status: "needs_confirmation",
    commandId,
    summary,
    instruction: `Show them this summary exactly, then ask them to reply "yes" to confirm or "no" to cancel. The call is NOT placed yet — never say it's done or scheduled; it only happens after their yes.`,
  };
}

export async function prepareStopCommand(
  clientId: string,
  input: { nameOrPhone?: unknown },
  ctx: ToolContext | undefined,
  loadSettings: SettingsLoader
): Promise<PreparedCommand> {
  const settings = loadSettings(clientId);
  const denied = authorise(settings, ctx);
  if (denied || !settings || !ctx) return refused(denied ?? "Not allowed.");

  const nameOrPhone = String(input.nameOrPhone ?? "").trim();
  if (!nameOrPhone) return refused("I need the lead's name or phone number.");

  const resolved = await resolveOne(clientId, nameOrPhone);
  if ("status" in resolved) return resolved;
  const { contact } = resolved;

  const row = await query<{ status: string; call_after: Date | null }>(`SELECT status, call_after FROM iris_pending_calls WHERE client_id = $1 AND contact_id = $2`, [clientId, contact.id]);
  if (!row[0] || row[0].status !== "pending") {
    return { status: "nothing_to_do", reason: `Iris has nothing queued for ${contact.name}.`, instruction: `Tell them Iris has nothing queued to stop for ${contact.name} (no pending call or text conversation).` };
  }
  const inFlight = await query<{ one: number }>(
    `SELECT 1 AS one FROM iris_call_log WHERE client_id = $1 AND contact_id = $2 AND status = 'initiated' AND created_at > now() - interval '20 minutes' LIMIT 1`,
    [clientId, contact.id]
  );
  const summary =
    `Stop Iris calling and texting *${contact.name}* — closes their queue row, so no further calls, retries or auto-replies go out.` +
    (inFlight.length > 0 ? `\nNote: a call to them is in progress right now — I can't hang it up, but nothing further will follow it.` : "");

  const commandId = await storePending(clientId, ctx, "stop", contact, summary, null);
  return {
    status: "needs_confirmation",
    commandId,
    summary,
    instruction: `Show them this summary exactly, then ask them to reply "yes" to confirm or "no" to cancel. Nothing is stopped yet — never say it's done; it only happens after their yes.`,
  };
}

/** Reads who a teammate called on a day and whether they reached each lead. Read-only: nothing is queued. */
export async function listTeammateCalls(
  clientId: string,
  input: { person?: unknown; daysAgo?: unknown },
  ctx: ToolContext | undefined,
  loadSettings: SettingsLoader
): Promise<unknown> {
  const settings = loadSettings(clientId);
  const denied = authorise(settings, ctx);
  if (denied || !settings) return { status: "refused", reason: denied ?? "Not allowed." };
  const person = String(input.person ?? "").trim();
  if (!person) return { status: "refused", reason: "I need the teammate's name." };
  const daysAgo = Math.min(Math.max(Number(input.daysAgo ?? 0) || 0, 0), 6);

  const result = await findTeammateCalls(clientId, person, daysAgo, settings.timezone);
  if (!result.ok) return { status: "not_found", reason: result.reason, candidates: result.candidates };
  return {
    status: "ok",
    person: result.person,
    day: result.day,
    reachedMeansCompletedAndAtLeast: "30 seconds",
    calls: result.calls.map((c) => ({ name: c.name, calls: c.calls, reached: c.reached, longestSeconds: c.longestSeconds, lastCallAt: formatLocal(c.lastCallAt, settings.timezone) })),
  };
}

/**
 * Prepares "follow up on the leads <teammate> called and didn't reach": works out who is safe to
 * contact and stores ONE pending command for the whole list. Nothing is queued until the same
 * person replies yes (handleCommandReply).
 */
export async function prepareFollowUpCommand(
  clientId: string,
  input: { person?: unknown; daysAgo?: unknown },
  ctx: ToolContext | undefined,
  loadSettings: SettingsLoader,
  now: Date = new Date()
): Promise<PreparedCommand> {
  const settings = loadSettings(clientId);
  const denied = authorise(settings, ctx);
  if (denied || !settings || !ctx) return refused(denied ?? "Not allowed.");
  const person = String(input.person ?? "").trim();
  if (!person) return refused("I need the teammate's name.");
  const daysAgo = Math.min(Math.max(Number(input.daysAgo ?? 0) || 0, 0), 6);

  const found = await findTeammateCalls(clientId, person, daysAgo, settings.timezone, now);
  if (!found.ok) return { status: "not_found", reason: found.reason, candidates: found.candidates, instruction: `Tell them: ${found.reason}` };
  const ghl = await getGhlConfig(clientId);
  if (!ghl) return refused(`I couldn't reach the CRM for ${clientId}.`);

  const unreached = found.calls.filter((c) => !c.reached);
  if (unreached.length === 0) {
    return { status: "nothing_to_do", reason: `${found.person} has no unanswered calls on ${found.day}.`, instruction: `Tell them ${found.person} made ${found.calls.length} call(s) on ${found.day} and reached every lead, so there is nobody to follow up.` };
  }

  const eligible: { id: string; name: string }[] = [];
  const left: string[] = [];
  for (const c of unreached) {
    const raw = await getContact(c.contactId, ghl.locationId, ghl.apiKey).catch(() => null);
    const contact = raw?.contact ?? raw;
    const tags: string[] = (contact?.tags ?? []).map((t: string) => String(t).toLowerCase());
    if (!contact) left.push(`${c.name} (couldn't read their record)`);
    else if (contact.dnd || tags.includes("do not call")) left.push(`${c.name} (do not call)`);
    else if (!contact.phone) left.push(`${c.name} (no phone)`);
    else if (tags.includes("appt booked") || tags.includes("live transferred")) left.push(`${c.name} (already ${tags.includes("appt booked") ? "booked" : "live transferred"})`);
    else {
      // Texts only: the teammate's own unanswered call is exactly why this lead is on the list.
      const touch = await checkHumanTouch(c.contactId, ghl.locationId, ghl.apiKey, settings.humanHandsOffDays, now, { includeCalls: false });
      if (touch.status !== "none") left.push(`${c.name} (a teammate has texted them)`);
      else eligible.push({ id: c.contactId, name: c.name });
    }
  }
  if (eligible.length === 0) {
    return { status: "nothing_to_do", reason: "Nobody safe to follow up.", instruction: `Tell them none of ${found.person}'s unanswered leads can be followed up, and why: ${left.join("; ")}.` };
  }

  const startAt = clampToLegalCallingWindow(new Date(now.getTime() + 2 * 60_000), settings.timezone);
  const summary =
    `Follow up on ${eligible.length} lead${eligible.length === 1 ? "" : "s"} ${found.person} called on ${found.day} and didn't reach: ${eligible.map((e) => `*${e.name}*`).join(", ")}.\n` +
    `Iris calls them one at a time starting ${formatLocal(startAt.toISOString(), settings.timezone)}; anyone who doesn't pick up gets one text.` +
    (left.length ? `\nLeaving out: ${left.join("; ")}.` : "");
  const commandId = await storePending(clientId, ctx, "followup", eligible[0], summary, startAt, eligible);
  return {
    status: "needs_confirmation",
    commandId,
    summary,
    instruction: `Show them this summary exactly, then ask them to reply "yes" to confirm or "no" to cancel. Nothing is queued yet. Never say anyone is lined up until after their yes.`,
  };
}

/** A review is a day old at most when someone says yes to it; older than this and the facts may have moved on. */
const REVIEW_MAX_AGE_MS = 36 * 3_600_000;
/** CASL: an inquiry older than this is outside implied consent, so Jacob decides (Mark, 2026-10-22). */
const STALE_INQUIRY_MS = 180 * 86_400_000;

/**
 * Prepares "act on the leads the review flagged": takes the nightly review's findings, re-reads every lead LIVE
 * (the review is up to a day old) and keeps only those still safe to contact, then stores ONE pending command for
 * the list. Nothing is queued until the same person replies yes (handleCommandReply). Names in `skip` are left out;
 * names in `only` narrow it to those leads.
 */
export async function prepareReviewActionCommand(
  clientId: string,
  input: { only?: unknown; skip?: unknown },
  ctx: ToolContext | undefined,
  loadSettings: SettingsLoader,
  now: Date = new Date()
): Promise<PreparedCommand> {
  const settings = loadSettings(clientId);
  const denied = authorise(settings, ctx);
  if (denied || !settings || !ctx) return refused(denied ?? "Not allowed.");
  const names = (v: unknown): string[] => (Array.isArray(v) ? v : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  const only = names(input.only);
  const skip = names(input.skip);

  const review = await latestReview(clientId);
  if (!review) return { status: "nothing_to_do", reason: "The review hasn't run yet.", instruction: "Tell them the nightly lead review hasn't run yet; it runs at 7:30 AM St. John's time." };
  if (now.getTime() - review.ranAt.getTime() > REVIEW_MAX_AGE_MS) {
    return { status: "nothing_to_do", reason: "The latest review is over a day and a half old.", instruction: "Tell them the latest review is too old to act on safely and the next one runs at 7:30 AM St. John's time." };
  }
  const ghl = await getGhlConfig(clientId);
  if (!ghl) return refused(`I couldn't reach the CRM for ${clientId}.`);

  const wanted = review.findings.filter((f) => {
    const n = f.name.toLowerCase();
    return (only.length === 0 || only.some((o) => n.includes(o))) && !skip.some((o) => n.includes(o));
  });
  if (wanted.length === 0) return { status: "nothing_to_do", reason: "No flagged leads to act on.", instruction: "Tell them there is nobody flagged in the latest review to follow up on." };

  const eligible: { id: string; name: string }[] = [];
  const left: string[] = [];
  for (const f of wanted) {
    if (eligible.some((e) => e.id === f.contactId)) continue;
    const raw = await getContact(f.contactId, ghl.locationId, ghl.apiKey).catch(() => null);
    const contact = raw?.contact ?? raw;
    const tags: string[] = (contact?.tags ?? []).map((t: string) => String(t).toLowerCase());
    const added = contact?.dateAdded ? new Date(contact.dateAdded).getTime() : NaN;
    if (!contact) left.push(`${f.name} (couldn't read their record)`);
    else if (contact.dnd || tags.includes("do not call")) left.push(`${f.name} (do not call)`);
    else if (!contact.phone) left.push(`${f.name} (no phone)`);
    else if (tags.includes("appt booked") || tags.includes("live transferred")) left.push(`${f.name} (already ${tags.includes("appt booked") ? "booked" : "live transferred"})`);
    // They wrote to us, so an old inquiry is not the issue; otherwise an inquiry over six months old needs Jacob's OK.
    else if (f.kind !== "unanswered_reply" && Number.isFinite(added) && now.getTime() - added > STALE_INQUIRY_MS) left.push(`${f.name} (inquiry over 6 months old — needs Jacob's OK)`);
    else {
      // Calls count here: a teammate who has called or texted since the review ran is working this lead.
      const touch = await checkHumanTouch(f.contactId, ghl.locationId, ghl.apiKey, settings.humanHandsOffDays, now);
      if (touch.status !== "none") left.push(`${f.name} (a teammate has been in touch)`);
      else {
        // Iris or Ember already dealt with them since the review ran.
        const recent = await query<{ n: string }>(
          `SELECT (SELECT count(*) FROM iris_pending_calls WHERE client_id = $1 AND contact_id = $2 AND status = 'pending')
                + (SELECT count(*) FROM iris_call_log WHERE client_id = $1 AND contact_id = $2 AND created_at > $3) AS n`,
          [clientId, f.contactId, review.ranAt]
        );
        if (Number(recent[0]?.n ?? 0) > 0) left.push(`${f.name} (Iris already has them in hand)`);
        else eligible.push({ id: f.contactId, name: f.name });
      }
    }
  }
  if (eligible.length === 0) {
    return { status: "nothing_to_do", reason: "Nobody safe to follow up.", instruction: `Tell them none of the flagged leads can be followed up right now, and why: ${left.join("; ")}.` };
  }

  const startAt = clampToLegalCallingWindow(new Date(now.getTime() + 2 * 60_000), settings.timezone);
  const summary =
    `Follow up on ${eligible.length} lead${eligible.length === 1 ? "" : "s"} from the lead review: ${eligible.map((e) => `*${e.name}*`).join(", ")}.\n` +
    `Iris calls them one at a time starting ${formatLocal(startAt.toISOString(), settings.timezone)}; anyone who doesn't pick up gets one text.` +
    (left.length ? `\nLeaving out: ${left.join("; ")}.` : "");
  const commandId = await storePending(clientId, ctx, "review", eligible[0], summary, startAt, eligible);
  return {
    status: "needs_confirmation",
    commandId,
    summary,
    instruction: `Show them this summary exactly, then ask them to reply "yes" to confirm or "no" to cancel. Nothing is queued yet. Never say anyone is lined up until after their yes.`,
  };
}

/**
 * Runs BEFORE the model (the agent's handleCustom hook). Returns the reply
 * text when this message was a yes/no to a pending command of the sender's —
 * otherwise null, and the message goes to the model as usual.
 */
export async function handleCommandReply(message: SlackIncomingMessage, loadSettings: SettingsLoader, clientId: string): Promise<string | null> {
  const yes = isYes(message.text);
  const no = isNo(message.text);
  if (!yes && !no) return null;

  const rows = await query<{
    id: string;
    kind: "call" | "stop" | "followup" | "review";
    contact_id: string;
    contact_name: string;
    call_at: Date | null;
    created_at: Date;
    batch: { id: string; name: string }[] | null;
  }>(
    `SELECT id, kind, contact_id, contact_name, call_at, created_at, batch FROM iris_slack_commands
     WHERE requested_by = $1 AND channel_id = $2 AND thread_ts IS NOT DISTINCT FROM $3 AND status = 'pending'
     ORDER BY created_at DESC LIMIT 1`,
    [message.userId, message.channelId, message.threadTs ?? null]
  );
  const cmd = rows[0];
  if (!cmd) return null;

  const settings = loadSettings(clientId);
  // Re-checked at the moment of acting, not just when asked.
  if (!settings || !settings.allowedUserIds.includes(message.userId)) return null;

  const resolve = (status: "executed" | "cancelled" | "expired") =>
    query(`UPDATE iris_slack_commands SET status = $2, resolved_at = now() WHERE id = $1`, [cmd.id, status]);

  if (Date.now() - new Date(cmd.created_at).getTime() > settings.confirmTtlMinutes * 60_000) {
    await resolve("expired");
    return `That request has expired (I only wait ${settings.confirmTtlMinutes} minutes for a yes) — ask me again if you still want it.`;
  }
  if (no) {
    await resolve("cancelled");
    return "Okay — cancelled, nothing was done.";
  }

  if (cmd.kind === "followup" || cmd.kind === "review") {
    const fromReview = cmd.kind === "review";
    const leads = cmd.batch ?? [];
    const startAt = cmd.call_at && new Date(cmd.call_at).getTime() > Date.now() ? new Date(cmd.call_at) : clampToLegalCallingWindow(new Date(Date.now() + 60_000), settings.timezone);
    const queued = await queueColdLeadSweep(clientId, leads.map((l) => l.id), startAt);
    await resolve("executed");
    const names = queued.map((q) => q.name);
    const missed = leads.filter((l) => !queued.some((q) => q.contactId === l.id)).map((l) => l.name);
    await audit(`📣 <@${message.userId}> asked me to follow up on ${queued.length} lead${queued.length === 1 ? "" : "s"} ${fromReview ? "flagged by the lead review" : "a teammate called and didn't reach"} — ${names.join(", ") || "none queued"}.`);
    return (
      `Done — lined up ${queued.length}: ${names.join(", ")}. I'll call them one at a time from ${formatLocal(startAt.toISOString(), settings.timezone)}, and text anyone who doesn't pick up.` +
      (missed.length ? `\nCouldn't queue (no readable record, phone or name): ${missed.join(", ")}.` : "")
    );
  }

  if (cmd.kind === "call") {
    const when = cmd.call_at ? new Date(cmd.call_at) : new Date(Date.now() + 60_000);
    // scheduleExplicitCallback refreshes the lead first; false = the lead couldn't be read, so nothing was queued.
    const ok = await scheduleExplicitCallback(clientId, cmd.contact_id, when, true);
    if (!ok) {
      await resolve("cancelled");
      return `I couldn't read ${cmd.contact_name}'s record just now, so I did NOT queue the call. Try again in a minute.`;
    }
    await resolve("executed");
    await audit(`📣 <@${message.userId}> asked me to call *${cmd.contact_name}* — queued for ${formatLocal(when.toISOString(), settings.timezone)}.${await linkSuffix(clientId, cmd.contact_id)}`);
    return `Done — I've queued the call to ${cmd.contact_name} for ${formatLocal(when.toISOString(), settings.timezone)}. It'll show up in #iris-calltext-logs when it's placed.`;
  }

  await query(
    `UPDATE iris_pending_calls SET status = 'skipped', resolution_reason = $3, resolved_at = now()
     WHERE client_id = $1 AND contact_id = $2 AND status = 'pending'`,
    [clientId, cmd.contact_id, `stopped in Slack by ${message.userId}`]
  );
  await resolve("executed");
  await audit(`📣 <@${message.userId}> asked me to stop calling and texting *${cmd.contact_name}* — done.${await linkSuffix(clientId, cmd.contact_id)}`);
  return `Done — I've stopped. Nothing further will go out to ${cmd.contact_name}.`;
}

async function audit(text: string): Promise<void> {
  await sendMessage("iris", { channel: CALL_LOG_CHANNEL, text }).catch((error) => {
    console.error("[IRS] Failed to post the Slack-command audit line:", error instanceof Error ? error.message : error);
  });
}

/** "\n🔗 …" — the GHL contact, so the thread is one click away — or "" when no link can be built. */
async function linkSuffix(clientId: string, contactId: string): Promise<string> {
  const line = await linkLineFor(clientId, contactId);
  return line ? `\n${line}` : "";
}
