/**
 * A lead who rings the number back and nobody picks up gets a text from Iris. Mark, 2026-11-05: "I want Iris to
 * text the lead who tried to call back in GHL" — Melanie Petten rang back 14 seconds after Iris's call was missed,
 * the call rang a teammate's line for 6 seconds, and nothing followed.
 *
 * GHL sends no webhook for a call, so this polls: every few minutes it reads the location's recent conversations,
 * keeps the leads Iris has worked, and looks in each thread for an inbound call that nobody answered and nothing
 * has followed. The text is the qualifying opener (qualify-text.ts), so the lead's reply carries on into Iris's
 * text qualification and a booked call with an agent. One text per call (callback_texts, claimed before sending).
 *
 * A call that was a real conversation (30s or more), one Iris herself answered through Vapi, or a lead a teammate is
 * working never gets a text. Overnight callbacks wait for the next legal calling hour: the lookback covers them.
 */
import { query } from "../../shared/db";
import { getContact, getContactAppointments, getConversationMessages, getGhlConfig, listRecentConversations } from "../../shared/ghl";
import { sendMessage } from "../../shared/slack";
import { refreshLead } from "../scout";
import { isWithinLegalCallingWindow } from "./cadence";
import { CALL_LOG_CHANNEL } from "./channels";
import { checkHumanTouch, DEFAULT_HUMAN_HANDS_OFF_DAYS } from "./human-touch";
import { loadClientBranding, loadIrisConfig } from "./index";
import { appendNoteToContact } from "./notes";
import { readAppointments } from "./no-show-state";
import { buildCallbackQualifyText } from "./qualify-text";
import { hasActiveSmsConversation } from "./sms";
import { openRowForReplies } from "./asap-watch";
import { sendIrisText } from "../../webhooks/vapi-webhook";

export interface CallbackWatchConfig {
  enabled: boolean;
  /** How far back an unanswered call is still answered (default 18h, so a 9 PM call is texted at 8 AM). */
  lookbackHours?: number;
}

const DEFAULT_LOOKBACK_HOURS = 18;
/** A call this long was a conversation with someone, not a ring or a voicemail. */
const REAL_CALL_SECONDS = 30;
/** How far apart an inbound call in GHL and Iris's own Vapi inbound log row can be and still be the same call. */
const SAME_CALL_MS = 5 * 60 * 1000;

export interface UnansweredCallback {
  messageId: string;
  at: number;
  durationSeconds: number;
}

/**
 * The newest inbound call in the thread that is still waiting for an answer: short, inside the lookback, and not
 * followed by a text from Iris or a teammate, a text from the lead, or a call a teammate placed. The intake
 * automation's texts (source "workflow") do not count as an answer.
 */
export function findUnansweredCallback(messages: any[], now: Date, lookbackMs: number): UnansweredCallback | null {
  const calls = messages
    .filter((m) => m?.messageType === "TYPE_CALL" && m?.direction === "inbound" && typeof m?.dateAdded === "string" && typeof m?.id === "string")
    .map((m) => ({ m, at: Date.parse(m.dateAdded), duration: Number(m?.meta?.call?.duration ?? 0) }))
    .filter((c) => Number.isFinite(c.at) && now.getTime() - c.at <= lookbackMs && now.getTime() >= c.at)
    .sort((a, b) => b.at - a.at);
  const call = calls[0];
  if (!call || call.duration >= REAL_CALL_SECONDS) return null;

  const answered = messages.some((m) => {
    const at = Date.parse(m?.dateAdded ?? "");
    if (!Number.isFinite(at) || at <= call.at) return false;
    if (m?.messageType === "TYPE_SMS") {
      if (m?.direction === "inbound") return true;
      return m?.source !== "workflow" && m?.status !== "failed";
    }
    if (m?.messageType === "TYPE_CALL") return m?.direction !== "inbound" && typeof m?.userId === "string" && m.userId !== "";
    return false;
  });
  return answered ? null : { messageId: call.m.id, at: call.at, durationSeconds: call.duration };
}

export interface CallbackEntry {
  contactId: string;
  name: string;
  call: UnansweredCallback;
  decision: { send: true } | { send: false; reason: string };
  text?: string;
  outcome?: "delivered" | "sent" | "failed" | "skipped" | "dry-run";
}

export interface CallbackWatchResult {
  checked: number;
  entries: CallbackEntry[];
}

export async function runCallbackWatch(clientId: string, options: { now?: Date; dryRun?: boolean; only?: string[] } = {}): Promise<CallbackWatchResult> {
  const now = options.now ?? new Date();
  const irisConfig = loadIrisConfig(clientId);
  const cfg = irisConfig?.callbackWatch;
  const branding = loadClientBranding(clientId);
  const ghl = await getGhlConfig(clientId);
  if (!irisConfig || !cfg || !branding || !ghl) return { checked: 0, entries: [] };
  const timeZone = irisConfig.timezone || "America/St_Johns";
  const lookbackMs = (cfg.lookbackHours ?? DEFAULT_LOOKBACK_HOURS) * 60 * 60 * 1000;
  const cutoff = now.getTime() - lookbackMs;

  // Only leads Iris has worked: a queue row or a call in the last 30 days.
  const worked = new Set(
    (
      await query<{ contact_id: string }>(
        `SELECT contact_id FROM iris_pending_calls WHERE client_id = $1 AND created_at > now() - interval '30 days'
         UNION SELECT contact_id FROM iris_call_log WHERE client_id = $1 AND created_at > now() - interval '30 days' AND contact_id IS NOT NULL`,
        [clientId]
      )
    ).map((r) => r.contact_id)
  );
  if (worked.size === 0) return { checked: 0, entries: [] };

  // Conversations touched inside the lookback, newest first (the list is ordered by last message).
  const conversations: { contactId: string; id: string }[] = [];
  let startAfter: number | undefined;
  for (let page = 0; page < 6; page++) {
    const batch = await listRecentConversations(ghl.locationId, ghl.apiKey, { limit: 50, startAfterDate: startAfter });
    if (batch.length === 0) break;
    for (const c of batch) {
      const last = Number(c?.lastMessageDate ?? 0);
      if (last >= cutoff && c?.contactId && c?.id && worked.has(c.contactId)) conversations.push({ contactId: c.contactId, id: c.id });
    }
    const oldest = Number(batch[batch.length - 1]?.lastMessageDate ?? 0);
    if (oldest < cutoff || batch.length < 50) break;
    startAfter = oldest;
  }

  const entries: CallbackEntry[] = [];
  for (const { contactId, id } of conversations) {
    if (options.only && !options.only.includes(contactId)) continue;
    try {
      const messages: any[] = (await getConversationMessages(id, ghl.locationId, ghl.apiKey, 40))?.messages?.messages ?? [];
      const call = findUnansweredCallback(messages, now, lookbackMs);
      if (!call) continue;

      // The table is created at boot from schema.sql; until then (a dry run just ahead of a deploy) nothing has been sent.
      const already = await query<{ id: number }>(`SELECT id FROM callback_texts WHERE client_id = $1 AND call_message_id = $2`, [clientId, call.messageId]).catch((error) => {
        if ((error as { code?: string })?.code === "42P01") return [];
        throw error;
      });
      if (already.length > 0) continue;

      const rawContact = await getContact(contactId, ghl.locationId, ghl.apiKey);
      const contact = rawContact?.contact ?? rawContact;
      const name = [contact?.firstName, contact?.lastName].filter(Boolean).join(" ") || contact?.name || contactId;
      const skip = (reason: string): CallbackEntry => ({ contactId, name, call, decision: { send: false, reason } });
      if (!contact) {
        entries.push(skip("couldn't read the contact"));
        continue;
      }

      const tags: string[] = (contact.tags ?? []).map((t: string) => String(t).toLowerCase());
      if (contact.dnd === true || tags.includes("do not call")) {
        entries.push(skip("opted out"));
        continue;
      }
      if (!isWithinLegalCallingWindow(now, timeZone)) {
        entries.push(skip("outside texting hours — waits for the morning"));
        continue;
      }
      // Iris answered this call herself through Vapi, so the lead did talk to her.
      const answeredByIris = await query<{ id: string }>(
        `SELECT id FROM iris_call_log WHERE client_id = $1 AND contact_id = $2 AND triggered_by = 'inbound' AND created_at BETWEEN $3 AND $4`,
        [clientId, contactId, new Date(call.at - SAME_CALL_MS), new Date(call.at + SAME_CALL_MS)]
      );
      if (answeredByIris.length > 0) continue;

      const queueRows = await query<{ status: string; lead: Record<string, unknown> | null }>(`SELECT status, lead FROM iris_pending_calls WHERE client_id = $1 AND contact_id = $2`, [clientId, contactId]);
      if (queueRows[0]?.status === "placed") {
        entries.push(skip("a call to them is in progress"));
        continue;
      }
      const appointments = await getContactAppointments(contactId, ghl.locationId, ghl.apiKey).catch(() => []);
      if (readAppointments(appointments, now, timeZone).upcoming) {
        entries.push(skip("already has an appointment booked"));
        continue;
      }
      if (await hasActiveSmsConversation(clientId, contactId)) {
        entries.push(skip("already texting with Iris"));
        continue;
      }
      const touch = await checkHumanTouch(contactId, ghl.locationId, ghl.apiKey, irisConfig.humanHandsOffDays ?? DEFAULT_HUMAN_HANDS_OFF_DAYS, now);
      if (touch.status !== "none") {
        entries.push(skip(touch.status === "human" ? "a teammate has been in touch" : "couldn't verify no teammate is in touch"));
        continue;
      }

      const lead = (await refreshLead(contactId, clientId)) ?? (queueRows[0]?.lead as any) ?? { name };
      const text = buildCallbackQualifyText(lead.name ?? name, branding.brandName, lead);
      if (options.dryRun) {
        entries.push({ contactId, name, call, decision: { send: true }, text, outcome: "dry-run" });
        continue;
      }

      // Claim the call before texting so a slow pass overlapping the next one can never send twice.
      const claim = await query<{ id: number }>(
        `INSERT INTO callback_texts (client_id, contact_id, call_message_id, call_at) VALUES ($1, $2, $3, $4) ON CONFLICT (client_id, call_message_id) DO NOTHING RETURNING id`,
        [clientId, contactId, call.messageId, new Date(call.at)]
      );
      if (claim.length === 0) continue;

      const outcome = await sendIrisText(clientId, contactId, lead.name ?? name, text);
      await query(`UPDATE callback_texts SET text = $2, outcome = $3 WHERE id = $1`, [claim[0].id, text, outcome]);
      // A failed text leaves nothing behind, so the next pass tries again; a skipped one stays claimed (a teammate has them).
      if (outcome === "failed") await query(`DELETE FROM callback_texts WHERE id = $1`, [claim[0].id]);
      entries.push({ contactId, name, call, decision: { send: true }, text, outcome });
      if (outcome === "delivered" || outcome === "sent") {
        await openRowForReplies(clientId, contactId, lead, { source: "callback", reason: "lead called back — Iris texted, waiting for a reply" });
        await appendNoteToContact(clientId, contactId, `Iris: ${name} called back and nobody picked up, so she texted "${text}".`).catch(() => {});
      }
    } catch (error) {
      console.error(`[CALLBACK] ${contactId}:`, error instanceof Error ? error.message : error);
    }
  }
  return { checked: conversations.length, entries };
}

export function formatCallbackPost(result: CallbackWatchResult, timeZone: string): string | null {
  const sent = result.entries.filter((e) => e.outcome === "delivered" || e.outcome === "sent");
  if (sent.length === 0) return null;
  const lines = sent.map((e) => {
    const when = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(e.call.at));
    return `📲 *${e.name}* called back at ${when} and nobody picked up. Iris texted them: “${e.text}”`;
  });
  return lines.join("\n");
}

/** Scheduler entry point. One client failing never stops the next. */
export async function runCallbackWatchAll(): Promise<void> {
  let files: string[] = [];
  try {
    files = (await import("fs")).readdirSync((await import("path")).join(process.cwd(), "config", "clients"));
  } catch {
    return;
  }
  for (const f of files.filter((x) => x.endsWith(".json"))) {
    const clientId = f.replace(/\.json$/, "");
    const config = loadIrisConfig(clientId);
    if (!config?.callbackWatch?.enabled) continue;
    try {
      const result = await runCallbackWatch(clientId);
      const post = formatCallbackPost(result, config.timezone || "America/St_Johns");
      if (post) {
        console.log(`[CALLBACK] ${clientId}: ${result.entries.filter((e) => e.outcome === "delivered" || e.outcome === "sent").length} texted.`);
        await sendMessage("iris", { channel: CALL_LOG_CHANNEL, text: post }).catch((error) => console.error("[CALLBACK] Slack post failed:", error instanceof Error ? error.message : error));
      }
    } catch (error) {
      console.error(`[CALLBACK] ${clientId}:`, error instanceof Error ? error.message : error);
    }
  }
}
