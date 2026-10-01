/**
 * Reads a finished VOICE call's full transcript to decide whether the lead
 * asked to be called back and the call ended before Iris actually
 * scheduled it — Mark's spec, 2026-10-01, from a real example (Saife
 * Sarwar: "Ma'am, right now is busy. Can I call you later?" then hung up
 * mid-way through Iris's reply, before `schedule_callback`
 * (webhooks/vapi-tools.ts) ever got a turn to run). Because that call's
 * endedReason was a genuine pickup, the existing rule — "a real
 * conversation, however it went, stops the automatic sequence for good"
 * (Mark, 2026-09-06) — closed her row out for good with nothing scheduled.
 *
 * Same LLM-classification shape as text-signals.ts's classifyInboundText
 * (strict JSON-only response, fail-toward-"none" on any error), but over a
 * full multi-turn call transcript instead of one SMS reply — different
 * enough an input shape that sharing classifyInboundText directly would
 * mean overloading its single-message prompt rather than genuinely reusing
 * it.
 */
import { ask } from "../../shared/claude";
import { clampToLegalCallingWindow } from "./cadence";

export type CallCallbackSignal = { type: "schedule_for"; when: Date } | { type: "call_later" } | { type: "none" };

// Same bounds as text-signals.ts's classifyInboundText — too soon to
// reliably staff, too far out to trust an LLM's date resolution blindly.
const MIN_MINUTES_OUT = 10;
const MAX_DAYS_OUT = 14;

function buildSystemPrompt(nowIso: string, timezone: string): string {
  return `You are reading the full transcript of a real estate AI voice assistant's phone call with a lead, to decide whether the lead asked to be called back and the call ended before that request was actually confirmed or scheduled. Respond with ONLY a single JSON object — no other text, no markdown code fence.

Current date/time: ${nowIso} (timezone: ${timezone}). Use this as the reference point for resolving any relative time the lead mentions.

Classify into exactly ONE of these shapes:

{"type": "schedule_for", "when": "<ISO 8601 timestamp with timezone offset>"} — the lead gave a SPECIFIC day/time to be called back (e.g. "call me at 6pm", "can you try tomorrow morning"), and the transcript does NOT show the assistant actually confirming a scheduled callback before the call ended — it cuts off mid-reply, the call ends right after the request, or there's no "callback scheduled for..." confirmation read back to the lead. Resolve any relative/vague time against the current date/time above, in the ${timezone} timezone.

{"type": "call_later"} — the lead clearly asked to be called back (e.g. "I'm busy right now, call me later", "can you try another time"), gave NO specific day/time, and the call ended before the assistant got a chance to ask for one or confirm anything.

{"type": "none"} — anything else. This is the default for MOST calls: the call completed normally (qualified, booked, transferred, or wrapped up with a plain goodbye), the lead declined or wasn't interested, no callback was ever mentioned, or the transcript already shows the assistant confirming a scheduled callback before the call ended (nothing was actually missed).

Be conservative — only use schedule_for or call_later when the lead clearly asked to be called back AND the transcript shows nothing already confirmed that for them. When in doubt, use none.`;
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
 * fail-toward-no-change philosophy as classifyInboundText: the cost of
 * missing a real signal once is far smaller than the cost of acting on a
 * misread one (scheduling a call for a nonsense time, or double-booking a
 * callback that was already confirmed).
 */
export async function classifyMissedCallback(transcript: string, now: Date, timezone: string): Promise<CallCallbackSignal> {
  if (!transcript || !transcript.trim()) return { type: "none" };

  let raw: string;
  try {
    raw = await ask(buildSystemPrompt(now.toISOString(), timezone), transcript, { maxTokens: 200, temperature: 0 });
  } catch (error) {
    console.error("[IRS] classifyMissedCallback: Claude call failed:", error instanceof Error ? error.message : error);
    return { type: "none" };
  }

  const parsed = extractJsonObject(raw) as { type?: string; when?: string } | null;
  if (!parsed || typeof parsed.type !== "string") return { type: "none" };

  if (parsed.type === "call_later") return { type: "call_later" };

  if (parsed.type === "schedule_for" && typeof parsed.when === "string") {
    const when = new Date(parsed.when);
    if (Number.isNaN(when.getTime())) return { type: "none" };
    const minutesOut = (when.getTime() - now.getTime()) / 60_000;
    if (minutesOut < MIN_MINUTES_OUT || minutesOut > MAX_DAYS_OUT * 24 * 60) return { type: "none" };
    return { type: "schedule_for", when: clampToLegalCallingWindow(when, timezone) };
  }

  return { type: "none" };
}
