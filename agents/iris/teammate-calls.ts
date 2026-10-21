/**
 * Who a teammate called on a given day, from GHL's own call log, and which of
 * those they did not reach. Mark, 2026-10-20: "check who Jacob called today so
 * Iris can follow up on them". Iris's own calls go through Vapi and never appear
 * here; these are calls a person made from GHL.
 */
import { getConversationMessages, getGhlConfig, listLocationUsers, listRecentConversations } from "../../shared/ghl";
import { zonedHourToUtc } from "./cadence";

/** A completed call shorter than this was almost certainly a ring-out or a voicemail, not a conversation. */
export const REACHED_MIN_SECONDS = 30;

export interface CallMessage {
  messageType?: string;
  direction?: string;
  status?: string;
  userId?: string;
  dateAdded?: string;
  meta?: { call?: { duration?: number; status?: string } };
}

export function callSeconds(m: CallMessage): number {
  return Number(m.meta?.call?.duration ?? 0) || 0;
}

/** Whether this one call reached the person: completed, and long enough to be a conversation. */
export function callReached(m: CallMessage): boolean {
  const status = String(m.status ?? m.meta?.call?.status ?? "").toLowerCase();
  return status === "completed" && callSeconds(m) >= REACHED_MIN_SECONDS;
}

export interface TeammateCallSummary {
  contactId: string;
  name: string;
  calls: number;
  reached: boolean;
  longestSeconds: number;
  lastCallAt: string;
}

/** UTC bounds of one local calendar day in the client's zone; daysAgo 0 = today. */
export function localDayBounds(now: Date, daysAgo: number, timeZone: string): { start: Date; end: Date } {
  const local = new Date(now.toLocaleString("en-US", { timeZone }));
  local.setDate(local.getDate() - daysAgo);
  const y = local.getFullYear(), m = local.getMonth(), d = local.getDate();
  return { start: zonedHourToUtc(y, m, d, 0, timeZone), end: zonedHourToUtc(y, m, d + 1, 0, timeZone) };
}

/** Groups one person's outbound calls by lead. A lead reached on ANY call that day counts as reached. */
export function summariseCalls(
  conversations: { contactId: string; name: string; messages: CallMessage[] }[],
  userId: string,
  start: Date,
  end: Date
): TeammateCallSummary[] {
  const out: TeammateCallSummary[] = [];
  for (const c of conversations) {
    const mine = c.messages.filter((m) => {
      if (m.messageType !== "TYPE_CALL" || m.userId !== userId || String(m.direction).toLowerCase() !== "outbound") return false;
      const at = Date.parse(m.dateAdded ?? "");
      return at >= start.getTime() && at < end.getTime();
    });
    if (mine.length === 0) continue;
    out.push({
      contactId: c.contactId,
      name: c.name,
      calls: mine.length,
      reached: mine.some(callReached),
      longestSeconds: Math.max(...mine.map(callSeconds)),
      lastCallAt: mine.map((m) => m.dateAdded!).sort().at(-1)!,
    });
  }
  return out.sort((a, b) => a.lastCallAt.localeCompare(b.lastCallAt));
}

export type TeammateCallsResult =
  | { ok: true; person: string; day: string; calls: TeammateCallSummary[] }
  | { ok: false; reason: string; candidates?: string[] };

/** Reads the person's outbound calls for one local day straight from GHL. Read-only. */
export async function findTeammateCalls(clientId: string, personName: string, daysAgo: number, timeZone: string, now: Date = new Date()): Promise<TeammateCallsResult> {
  const ghl = await getGhlConfig(clientId);
  if (!ghl) return { ok: false, reason: `No CRM access for ${clientId}.` };
  const wanted = personName.trim().toLowerCase();
  const users = await listLocationUsers(ghl.locationId, ghl.apiKey);
  const matches = users.filter((u) => u.name.toLowerCase().includes(wanted) || u.name.toLowerCase().split(" ")[0] === wanted);
  if (matches.length === 0) return { ok: false, reason: `No teammate named "${personName}" in the CRM.` };
  if (matches.length > 1) return { ok: false, reason: `More than one teammate matches "${personName}".`, candidates: matches.map((u) => u.name) };
  const user = matches[0];

  const { start, end } = localDayBounds(now, daysAgo, timeZone);
  const active: any[] = [];
  let startAfterDate: number | undefined;
  for (let page = 0; page < 8; page++) {
    const batch = await listRecentConversations(ghl.locationId, ghl.apiKey, { limit: 50, startAfterDate });
    if (batch.length === 0) break;
    for (const c of batch) if (Number(c.lastMessageDate) >= start.getTime()) active.push(c);
    const last = Number(batch[batch.length - 1].lastMessageDate);
    if (!Number.isFinite(last) || last < start.getTime() || batch.length < 50) break;
    startAfterDate = last;
  }

  const conversations: { contactId: string; name: string; messages: CallMessage[] }[] = [];
  for (let i = 0; i < active.length; i += 5) {
    await Promise.all(
      active.slice(i, i + 5).map(async (c) => {
        const payload = await getConversationMessages(c.id, ghl.locationId, ghl.apiKey, 40).catch(() => null);
        const messages: CallMessage[] = payload?.messages?.messages ?? [];
        conversations.push({ contactId: c.contactId, name: c.contactName || c.fullName || c.contactId, messages });
      })
    );
  }
  const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" }).format(new Date(start.getTime() + 12 * 3_600_000));
  return { ok: true, person: user.name, day, calls: summariseCalls(conversations, user.id, start, end) };
}
