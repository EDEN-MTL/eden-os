/**
 * A lead who agreed to be connected to an agent but hung up while the transfer was still in progress.
 *
 * Mark, 2026-11-11, after Michelle Smith Funk (also Ritu Patel 11-05, Jalpesh Patel 09-24): three of five transfer
 * attempts ended "customer-ended-call-before-warm-transfer" and the only follow-up was a Slack line saying "needs a
 * manual callback". His rule: whenever that happens Iris calls the lead back and picks up where they left off, tells
 * them she is going to transfer them again; and if the lead doesn't answer, Iris texts to ask whether they hung up or
 * still want to be connected to one of our agents.
 *
 * Why a lead hangs up there (Vapi's log, see docs/agents/iris.md "A failed warm transfer"): the ring group didn't
 * answer in about 23 seconds, or the agent answered and the briefing kept the lead on hold for over a minute. Either
 * way the lead was qualified and had said yes, so this is a lost warm lead, not a missed call.
 *
 * State lives on the lead's queue row: source "transfer-resume" and `lead.transferResume` (below). Pure helpers here;
 * the webhook (vapi-webhook.ts) decides when to queue and when to text, dial-pending.ts places the call.
 */
import { query } from "../../shared/db";
import { extractFirstName } from "./scripts";

export const TRANSFER_RESUME_SOURCE = "transfer-resume";

/**
 * Mark, 2026-11-17 (Jerrick Mendoza): "try to call them back immediately". One minute is long enough for our own line
 * to be free and still the same moment for the lead (it was three).
 */
export const TRANSFER_RESUME_DELAY_MINUTES = 1;

/** A resume call is only worth placing while the dropped call is still fresh. */
export const TRANSFER_RESUME_EXPIRES_HOURS = 48;

/**
 * Calls Iris makes to re-connect a dropped transfer. If the lead hangs up on that second transfer as well, the next
 * step is a text, not a third phone call.
 */
export const MAX_TRANSFER_RESUME_CALLS = 1;

/** `lead.transferResume` on the iris_pending_calls row. */
export interface TransferResumeState {
  /** When the call dropped (ISO). */
  at: string;
  /** Vapi's id for the call that dropped, for the Slack/GHL notes. */
  callId: string | null;
  /** Iris's own one-line note from that call (save_isa_notes), so the retry call never re-asks. */
  collected: string | null;
  /** How many times a transfer has dropped for this lead, this one included. */
  count: number;
  /** The "did you hang up?" text went out (once per lead). */
  texted?: boolean;
}

export function isTransferResumeRow(row: { source?: string | null; lead?: any }): boolean {
  return row.source === TRANSFER_RESUME_SOURCE && Boolean(row.lead?.transferResume);
}

/** Iris's own note from the call that dropped: the last save_isa_notes she made. */
export function isaNotesFromCall(message: Record<string, any>): string | null {
  const msgs: any[] = message?.messages ?? message?.artifact?.messages ?? [];
  let notes: string | null = null;
  for (const m of msgs) {
    for (const call of m?.toolCalls ?? []) {
      if (call?.function?.name !== "save_isa_notes") continue;
      try {
        const args = typeof call.function.arguments === "string" ? JSON.parse(call.function.arguments) : call.function.arguments;
        if (typeof args?.notes === "string" && args.notes.trim()) notes = args.notes.trim();
      } catch {
        // unreadable arguments: keep whatever the earlier call saved
      }
    }
  }
  return notes;
}

/**
 * Vapi's own summary of the call, for a retry when Iris saved no note of her own (Jerrick Mendoza, 2026-11-16: she
 * never called save_isa_notes, so the retry call would have re-asked everything). Trailing full stop dropped because
 * the prompt adds its own.
 */
export function callSummaryFromCall(message: Record<string, any>): string | null {
  const summary = message?.summary ?? message?.analysis?.summary;
  if (typeof summary !== "string" || !summary.trim()) return null;
  return summary.trim().replace(/[.\s]+$/, "").slice(0, 700);
}

/** Iris asking to connect them, or saying she is doing it. */
const TRANSFER_ASK = /\b(connect you with|connecting you|transfer you|transferring you|put you through|get you connected)\b/i;

/** The lead spoke at least this many times, so this was a real qualifying call and not a wrong number. */
const MIN_LEAD_TURNS = 3;

/**
 * What Iris asks while qualifying. A call only counts as qualified when she had asked about at least this many different
 * things before the transfer ask. Daniel Eiriz, 2026-11-17: her opening line itself says "we can get you connected with
 * someone who can send over some listings"; he said hello three times and hung up, and the call was reported as
 * "qualified and hung up when Iris asked to connect them", which was false. A greeting is not a qualification.
 */
const QUALIFYING_TOPICS: RegExp[] = [
  /budget|dollars|price range/i,
  /timeline|time ?frame|what month|how soon/i,
  /what area|which area|where are you|looking in|neighbou?rhood/i,
  /type of home|what kind of home|bedroom|bungalow|town ?house/i,
  /pre-?approv|mortgage/i,
  /working with (?:a |an )?(?:realtor|agent)|have an agent/i,
];
const MIN_QUALIFYING_TOPICS = 3;

/**
 * The lead hung up at the moment Iris asked to connect them to an agent, before any transfer started (Jerrick Mendoza,
 * 2026-11-16: qualified, Iris asked "Is that okay?", he hung up ten seconds later). Vapi reports that as a plain
 * "customer-ended-call", not one of the transfer reasons, so nothing followed. True only when Iris spoke last, what she
 * said was the transfer ask, and the lead never answered.
 */
export function hungUpAtTransferAsk(message: Record<string, any>, endedReason: string | null | undefined): boolean {
  if (endedReason !== "customer-ended-call") return false;
  const msgs: any[] = message?.messages ?? message?.artifact?.messages ?? [];
  const spoken = msgs.filter((m) => (m?.role === "user" || m?.role === "bot" || m?.role === "assistant") && typeof m?.message === "string" && m.message.trim());
  const last = spoken[spoken.length - 1];
  if (!last || last.role === "user" || !TRANSFER_ASK.test(last.message)) return false;
  if (spoken.filter((m) => m.role === "user").length < MIN_LEAD_TURNS) return false;
  // Her lines before the ask must have covered real qualifying questions, not just the greeting.
  const before = spoken.slice(0, -1).filter((m) => m.role !== "user").map((m) => m.message).join(" ");
  return QUALIFYING_TOPICS.filter((re) => re.test(before)).length >= MIN_QUALIFYING_TOPICS;
}

/**
 * The texts when the retry call goes unanswered (or a second transfer drops as well). Each asks the one question that
 * matters, in the lead's own terms: did they hang up, or do they still want to be connected. Mark, 2026-11-17: "you
 * provide variations of this", so they are picked per lead (the same lead always gets the same one) and never repeat
 * a line word for word across leads. No "Reply STOP" line, same as Iris's other texts (Jacob, 2026-10-29).
 */
export function buildTransferResumeText(leadName: string | null | undefined, brandName: string, seed: string = ""): string {
  const first = extractFirstName(leadName);
  const lines = [
    `Hi ${first}, it's Iris from ${brandName}. It looks like our call got cut off while I was connecting you with one of our agents. Did you hang up, or would you still like to be connected?`,
    `Hi ${first}, it's Iris from ${brandName}. Seems I lost you on the line while I was transferring you to one of our agents. Are you still good to be connected?`,
    `Hi ${first}, it's Iris from ${brandName}. Sorry, I think we got disconnected just as I was connecting you with one of our agents. Are you still good to talk with them?`,
    `Hi ${first}, it's Iris from ${brandName}. I lost you on the line during the transfer. Are you still okay to be connected with one of our agents?`,
  ];
  let hash = 0;
  for (const ch of seed) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0; // FNV-1a; low bits alone repeat for similar ids
  return lines[(hash >>> 8) % lines.length];
}

/**
 * How to refer to the dropped call on the retry: "a few minutes ago" for the normal quick retry, a plainer "earlier"
 * when the retry had to wait (calling hours), so Iris never says "a few minutes ago" about yesterday.
 */
export function whenPhrase(at: string | Date, now: Date = new Date()): string {
  const minutes = (now.getTime() - new Date(at).getTime()) / 60_000;
  if (minutes < 45) return "a few minutes ago";
  if (minutes < 24 * 60) return "earlier";
  return "the other day";
}

export function transferResumeExpired(at: string | Date, now: Date = new Date()): boolean {
  return now.getTime() - new Date(at).getTime() > TRANSFER_RESUME_EXPIRES_HOURS * 3_600_000;
}

/**
 * Queues the retry call: the lead's one queue row goes back to pending, due in a few minutes (pushed into calling
 * hours by the caller) and carries what Iris already knows. Returns false when there is no queue row to carry it.
 */
export async function queueTransferResume(clientId: string, contactId: string, state: TransferResumeState, callAfter: Date): Promise<boolean> {
  const rows = await query<{ id: number }>(
    `UPDATE iris_pending_calls
        SET lead = COALESCE(lead, '{}'::jsonb) || jsonb_build_object('transferResume', $3::jsonb),
            call_after = $4, status = 'pending', is_explicit_callback = true, source = $5, sms_scheduled = false,
            callback_misses = 0, human_requested = false,
            resolution_reason = 'call dropped while connecting to an agent — calling back to connect again', resolved_at = NULL
      WHERE client_id = $1 AND contact_id = $2
      RETURNING id`,
    [clientId, contactId, JSON.stringify(state), callAfter, TRANSFER_RESUME_SOURCE]
  );
  return rows.length > 0;
}
