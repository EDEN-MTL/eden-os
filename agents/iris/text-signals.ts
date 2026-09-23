/**
 * Reads a lead's most recent inbound SMS reply and decides whether it
 * changes how Iris should call them — Mark's spec, 2026-09-22, from a real
 * example (Catherine texting to ask for a 6pm callback). Plugs into the
 * EXISTING pre-dial recheck (dial-pending.ts's resolveOne), not a new GHL
 * webhook: a new inbound-message workflow would need a human to build it
 * in GHL's UI first (workflow triggers can't be created over the API —
 * CLAUDE.md's gotcha 4), the exact dependency that caused the intake gap
 * found and fixed earlier this project. Riding the recheck that already
 * runs before every attempt needs nothing new on the GHL side.
 *
 * Regex/keyword matching can't reliably tell "call me at 6" from "I'm not
 * looking to sell, I want a CHIP program valuation" (a real reply seen
 * live, 2026-09-21 — a correction, not an opt-out or a time request) —
 * hence an LLM classification pass, kept deliberately conservative
 * (defaults to "none" whenever intent isn't clearly one of the other two).
 */
import { ask } from "../../shared/claude";
import { getConversationMessages, getConversations } from "../../shared/ghl";
import { clampToLegalCallingWindow } from "./cadence";

export type TextSignal = { type: "opt_out" } | { type: "schedule_for"; when: Date } | { type: "none" };

// Same bounds webhooks/vapi-tools.ts's handleScheduleCallback already
// enforces for a live-call-requested callback (MIN_CALLBACK_MINUTES_OUT /
// MAX_CALLBACK_DAYS_OUT there) — kept as a separate, local copy rather than
// importing across the webhooks -> agents boundary the wrong way, but the
// same real constraint: too soon to reliably staff, too far out to trust
// an LLM's date resolution blindly.
const MIN_MINUTES_OUT = 10;
const MAX_DAYS_OUT = 14;

function buildSystemPrompt(nowIso: string, timezone: string, precedingOutbound: string | null): string {
  const contextLine = precedingOutbound
    ? `\nFor context, this is the lead's reply to our own immediately preceding text: "${precedingOutbound}" — read the lead's message as an answer to that, not in isolation. A bare answer like "6 pm" replying to "what's a good time to speak?" is a clear schedule_for, not a "none".\n`
    : "";

  return `You are classifying a single inbound SMS reply from a real estate lead, to decide whether an automated calling assistant should change its behavior toward them. Respond with ONLY a single JSON object — no other text, no markdown code fence.

Current date/time: ${nowIso} (timezone: ${timezone}). Use this as the reference point for resolving any relative time the lead mentions.
${contextLine}
Classify the message into exactly ONE of these three shapes:

{"type": "opt_out"} — the lead is clearly asking not to be called, to stop contacting them, or is declining any further contact. Examples: "stop calling me", "please don't call", "not interested, remove me", "quit texting/calling this number".

{"type": "schedule_for", "when": "<ISO 8601 timestamp with timezone offset>"} — the lead is asking to be called back at a SPECIFIC time. Examples: "call me at 6pm", "can you call after 5 today", "call me tomorrow morning around 9". Resolve any relative/vague time against the current date/time above, in the ${timezone} timezone. A bare time of day with no date means the NEXT upcoming occurrence (today if it hasn't passed yet, otherwise tomorrow).

{"type": "none"} — anything else. This is the default for MOST messages: a correction ("I'm not selling, I want X instead"), a question, general info, an unclear or ambiguous message, or anything that doesn't clearly request an opt-out or a specific callback time.

Be conservative — only use opt_out or schedule_for when the lead's intent is unambiguous. When in doubt, use none.`;
}

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Never throws — any failure (API error, unparseable response, an
 * out-of-bounds or invalid date) degrades to {type: "none"}, same
 * fail-toward-no-change philosophy as wasAnswered's own design: the cost
 * of missing a real signal once is far smaller than the cost of acting on
 * a misread one (wrongly opting out a real lead, or scheduling a call for
 * a nonsense time).
 */
export async function classifyInboundText(
  text: string,
  now: Date,
  timezone: string,
  precedingOutbound: string | null = null
): Promise<TextSignal> {
  if (!text || !text.trim()) return { type: "none" };

  let raw: string;
  try {
    raw = await ask(buildSystemPrompt(now.toISOString(), timezone, precedingOutbound), text, { maxTokens: 200, temperature: 0 });
  } catch (error) {
    console.error("[IRS] classifyInboundText: Claude call failed:", error instanceof Error ? error.message : error);
    return { type: "none" };
  }

  const parsed = extractJsonObject(raw) as { type?: string; when?: string } | null;
  if (!parsed || typeof parsed.type !== "string") return { type: "none" };

  if (parsed.type === "opt_out") return { type: "opt_out" };

  if (parsed.type === "schedule_for" && typeof parsed.when === "string") {
    const when = new Date(parsed.when);
    if (Number.isNaN(when.getTime())) return { type: "none" };
    const minutesOut = (when.getTime() - now.getTime()) / 60_000;
    if (minutesOut < MIN_MINUTES_OUT || minutesOut > MAX_DAYS_OUT * 24 * 60) return { type: "none" };
    return { type: "schedule_for", when: clampToLegalCallingWindow(when, timezone) };
  }

  return { type: "none" };
}

export interface InboundTextResult {
  text: string;
  /** The nearest outbound SMS before it, for classifyInboundText's context — see that function's own doc comment for why a bare "6 pm" needs this. */
  precedingOutbound: string | null;
  /**
   * GHL's own `dateAdded` on the inbound message, or null if it was missing
   * from a real payload (never trusted blindly — see the rest of this
   * codebase's "verify against live data" rule). Added for the two-way SMS
   * qualification pause-calling gate (dial-pending.ts): needs to know how
   * RECENT the lead's last text was, not just what it said.
   */
  dateAdded: string | null;
}

/**
 * The lead's own most recent inbound SMS, or null if there isn't one /
 * the fetch fails. Real bug fixed 2026-09-22: getConversations' SUMMARY
 * only exposes the single most recent message overall, whichever
 * direction — NOT the lead's most recent message. Confirmed live: Catherine
 * Nonsense (contact woXhOaQpB5i96Kpy6lyT) replied "6 pm" to our own "what's
 * a good time to speak?" text, but an automated follow-up went out 2
 * seconds later, making the conversation summary's lastMessageDirection
 * "outbound" again — the earlier version of this function (checking only
 * that summary field) found nothing and her real reply was never even
 * classified. Now fetches the full thread (getConversationMessages) and
 * walks it (GHL returns newest-first) to find the lead's actual most
 * recent inbound SMS, skipping non-SMS activity log entries (stage moves,
 * "Opportunity updated," etc.) on both sides.
 */
export async function lastInboundText(contactId: string, locationId: string, apiKey: string): Promise<InboundTextResult | null> {
  try {
    const convoResult = await getConversations(contactId, locationId, apiKey);
    const conversationId: string | undefined = convoResult?.conversations?.[0]?.id;
    if (!conversationId) return null;

    const msgResult = await getConversationMessages(conversationId, locationId, apiKey);
    const messages: any[] = msgResult?.messages?.messages ?? [];
    const sms = messages.filter((m) => m?.messageType === "TYPE_SMS" && typeof m?.body === "string" && m.body.trim() !== "");

    const inboundIndex = sms.findIndex((m) => m.direction === "inbound");
    if (inboundIndex === -1) return null;

    // sms is newest-first, so the preceding (chronologically earlier)
    // outbound message is the NEXT outbound one AFTER this index.
    const precedingOutbound = sms.slice(inboundIndex + 1).find((m) => m.direction === "outbound")?.body?.trim() ?? null;

    const dateAdded = typeof sms[inboundIndex].dateAdded === "string" ? sms[inboundIndex].dateAdded : null;
    return { text: sms[inboundIndex].body.trim(), precedingOutbound, dateAdded };
  } catch (error) {
    console.error(`[IRS] lastInboundText failed for contact ${contactId}:`, error instanceof Error ? error.message : error);
    return null;
  }
}
