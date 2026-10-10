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
import { scheduleExplicitCallback } from "./dial-pending";
import { checkHumanTouch, DEFAULT_HUMAN_HANDS_OFF_DAYS } from "./human-touch";

const DEFAULT_TTL_MINUTES = 10;
const MAX_DAYS_OUT = 7;
const CALL_LOG_CHANNEL = process.env.IRIS_CALL_LOG_CHANNEL || "iris-call-logs";

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
  kind: "call" | "stop",
  contact: { id: string; name: string },
  summary: string,
  callAt: Date | null
): Promise<number> {
  // One live request per person per place: a newer one replaces the older.
  await query(
    `UPDATE iris_slack_commands SET status = 'cancelled', resolved_at = now()
     WHERE requested_by = $1 AND channel_id = $2 AND status = 'pending'`,
    [ctx.userId, ctx.channelId]
  );
  const rows = await query<{ id: string }>(
    `INSERT INTO iris_slack_commands (client_id, requested_by, channel_id, thread_ts, kind, contact_id, contact_name, call_at, summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [clientId, ctx.userId, ctx.channelId, ctx.threadTs ?? null, kind, contact.id, contact.name, callAt, summary]
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
    kind: "call" | "stop";
    contact_id: string;
    contact_name: string;
    call_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, kind, contact_id, contact_name, call_at, created_at FROM iris_slack_commands
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

  if (cmd.kind === "call") {
    const when = cmd.call_at ? new Date(cmd.call_at) : new Date(Date.now() + 60_000);
    // scheduleExplicitCallback refreshes the lead first; false = the lead couldn't be read, so nothing was queued.
    const ok = await scheduleExplicitCallback(clientId, cmd.contact_id, when);
    if (!ok) {
      await resolve("cancelled");
      return `I couldn't read ${cmd.contact_name}'s record just now, so I did NOT queue the call. Try again in a minute.`;
    }
    await resolve("executed");
    await audit(`📣 <@${message.userId}> asked me to call *${cmd.contact_name}* — queued for ${formatLocal(when.toISOString(), settings.timezone)}.`);
    return `Done — I've queued the call to ${cmd.contact_name} for ${formatLocal(when.toISOString(), settings.timezone)}. It'll show up in #iris-call-logs when it's placed.`;
  }

  await query(
    `UPDATE iris_pending_calls SET status = 'skipped', resolution_reason = $3, resolved_at = now()
     WHERE client_id = $1 AND contact_id = $2 AND status = 'pending'`,
    [clientId, cmd.contact_id, `stopped in Slack by ${message.userId}`]
  );
  await resolve("executed");
  await audit(`📣 <@${message.userId}> asked me to stop calling and texting *${cmd.contact_name}* — done.`);
  return `Done — I've stopped. Nothing further will go out to ${cmd.contact_name}.`;
}

async function audit(text: string): Promise<void> {
  await sendMessage("iris", { channel: CALL_LOG_CHANNEL, text }).catch((error) => {
    console.error("[IRS] Failed to post the Slack-command audit line:", error instanceof Error ? error.message : error);
  });
}
