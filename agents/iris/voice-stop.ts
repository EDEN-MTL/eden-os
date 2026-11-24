/**
 * A lead who tells Iris to stop on a CALL (audit, 2026-11-20).
 *
 * A stop in a text has always been caught (text-signals.ts classifies it, opt-out.ts tags the lead). A stop said out loud on
 * a call was caught by nothing: the call prompt had no rule for it, so Iris carried on qualifying, and after the call nothing
 * read what the lead had said. The lead stayed on the board with no tag, for the stuck-lead check, the follow-up cohort or a
 * sweep to ring again.
 *
 * Two parts. The call prompt now says to apologise and end the call (scripts.ts, "When they say stop, not interested, or
 * wrong number"). This is the other part: after any call, the lead's own words are read the same careful way a text is.
 * Cheap gate first (a stop-ish word, no model), then the same conservative classifier: it acts only when the model calls it
 * clear AND the words it quotes really are in what the lead said. A maybe is only reported, never closed.
 */
import { classifyInboundText } from "./text-signals";
import { mightBeStop, recordOptOut } from "./opt-out";
import { closeQueueAndNurture } from "./stop-lead";
import { markLeadNoCalls } from "./sms";
import { loadIrisConfig } from "./index";
import { CALL_LOG_CHANNEL } from "./channels";
import { sendMessage } from "../../shared/slack";
import { getGhlConfig } from "../../shared/ghl";
import { query } from "../../shared/db";

export type VoiceStopResult = "opt_out" | "no_calls" | "unsure_stop" | null;

/** The lead's own lines from a finished call, oldest first. */
export function leadLines(message: Record<string, any>): string[] {
  return ((message?.messages ?? message?.artifact?.messages ?? []) as any[])
    .filter((m) => m?.role === "user" && typeof m?.message === "string" && m.message.trim() !== "")
    .map((m) => String(m.message).trim());
}

export async function maybeHonorVoiceStop(
  clientId: string,
  contactId: string,
  leadName: string | null,
  message: Record<string, any>,
  linkSuffix = ""
): Promise<VoiceStopResult> {
  const text = leadLines(message).join("\n");
  if (!text || !mightBeStop(text)) return null;

  const ghl = await getGhlConfig(clientId).catch(() => null);
  if (!ghl) return null;
  const timezone = loadIrisConfig(clientId)?.timezone || "America/St_Johns";
  const signal = await classifyInboundText(text, new Date(), timezone);
  const named = leadName ?? (await query<{ name: string | null }>(`SELECT lead->>'name' AS name FROM iris_pending_calls WHERE client_id = $1 AND contact_id = $2`, [clientId, contactId]).catch(() => []))[0]?.name;
  const who = named ?? contactId;

  if (signal.type === "opt_out") {
    await closeQueueAndNurture(clientId, contactId, "lead asked on a call to stop — cadence stopped");
    const stageSummary = await recordOptOut(clientId, contactId, ghl, signal.quote);
    await sendMessage("iris", {
      channel: CALL_LOG_CHANNEL,
      text: `🚫 *${who}* asked to stop on the call — closed, tagged "do not call", ${stageSummary}. Their words: "${signal.quote}". If that was a misread, reopen them.${linkSuffix}`,
    }).catch(() => {});
    return "opt_out";
  }
  if (signal.type === "no_calls") {
    await markLeadNoCalls(clientId, contactId, ghl, "lead asked on a call not to be phoned — text only");
    await sendMessage("iris", {
      channel: CALL_LOG_CHANNEL,
      text: `📵 *${who}* said on the call they don't want phone calls. Tagged "no calls": no more calls will go out. They can still be texted.${linkSuffix}`,
    }).catch(() => {});
    return "no_calls";
  }
  if (signal.type === "unsure_stop") {
    await sendMessage("iris", {
      channel: CALL_LOG_CHANNEL,
      text: `❓ *${who}* said something on the call that might mean "stop". I did not close or tag them. A teammate should read the call and decide.${linkSuffix}`,
    }).catch(() => {});
    return "unsure_stop";
  }
  return null;
}
