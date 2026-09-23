/**
 * Reads a lead's real GHL conversation history before Ember's first text,
 * and decides how — or whether — to reach out. Mark, 2026-09-24: Ember
 * should check on sitting leads who never opted out, never said not to
 * contact them and aren't on DND; a lead with next to no conversation gets
 * the standard script, and one with real history gets a text that picks up
 * where they left off.
 *
 * Two layers, on purpose:
 *   1. Hard rules in code. Any inbound message that reads as an opt-out
 *      ("stop", "don't text me", "remove me"...) skips the lead outright,
 *      with no model involved — this is the one decision that must never
 *      be a judgment call. No inbound message at all → standard script.
 *   2. A Claude read of the thread only when there's real conversation,
 *      to catch what regex can't ("we bought last month", "I'm working
 *      with my cousin, he's an agent") and to write the personal opener.
 *
 * Fails toward NOT sending: if the review can't run, the touch waits for
 * the next send run rather than going out blind.
 */
import { ask } from "../../shared/claude";
import { getConversationMessages, getConversations } from "../../shared/ghl";

export interface HistoryMessage {
  direction: "inbound" | "outbound";
  channel: "sms" | "email";
  body: string;
  at: string | null;
}

/** How many recent messages to read. One page — enough to see the story. */
const HISTORY_LIMIT = 50;
const MAX_BODY_CHARS = 500;

function plain(body: string): string {
  return body.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_BODY_CHARS);
}

/**
 * Texts and emails only, oldest first. GHL mixes in activity entries
 * (TYPE_ACTIVITY_OPPORTUNITY for stage moves, confirmed live 2026-09-23)
 * that aren't anything anyone said.
 */
export async function readConversationHistory(contactId: string, locationId: string, apiKey: string): Promise<HistoryMessage[]> {
  const convos = await getConversations(contactId, locationId, apiKey);
  const out: HistoryMessage[] = [];
  for (const convo of convos?.conversations ?? []) {
    const page = await getConversationMessages(convo.id, locationId, apiKey, HISTORY_LIMIT);
    for (const m of page?.messages?.messages ?? []) {
      const channel = m?.messageType === "TYPE_SMS" ? "sms" : m?.messageType === "TYPE_EMAIL" ? "email" : null;
      if (!channel || typeof m?.body !== "string" || !m.body.trim()) continue;
      if (m.direction !== "inbound" && m.direction !== "outbound") continue;
      out.push({ direction: m.direction, channel, body: plain(m.body), at: typeof m.dateAdded === "string" ? m.dateAdded : null });
    }
  }
  return out.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
}

/**
 * Deliberately broad — a false positive costs one lead a text they might
 * have welcomed; a false negative texts someone who asked us to stop.
 */
const OPT_OUT_PATTERNS = [
  /^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*[.!]*\s*$/i,
  /\b(unsubscribe|remove me|take me off|opt(ed)? out)\b/i,
  /\b(do not|don'?t|dont|never|stop|quit)\s+(contact|text|txt|call|message|email|bother)(ing)?\b/i,
  /\bleave me alone\b/i,
  /\bwrong (number|person)\b/i,
  /\bnot interested\b/i,
];

/** The inbound message that rules this lead out, or null. */
export function findOptOut(messages: HistoryMessage[]): string | null {
  for (const m of messages) {
    if (m.direction === "inbound" && OPT_OUT_PATTERNS.some((p) => p.test(m.body))) return m.body;
  }
  return null;
}

export type HistoryDecision =
  | { action: "skip"; reason: string; optOut: boolean }
  | { action: "script"; reason: string }
  | { action: "personalized"; reason: string; message: string }
  /** The review couldn't run — try again next send run, don't send blind. */
  | { action: "retry"; reason: string };

export interface ReviewContext {
  firstName: string;
  brandName: string;
  intent: string;
  /** Appended to a personal opener that doesn't already carry one. */
  stopLine: string;
  now: Date;
}

export type AskFn = (system: string, user: string) => Promise<string>;

const MAX_PERSONAL_CHARS = 320;

function systemPrompt(ctx: ReviewContext): string {
  return `You review a real estate lead's past text/email history for ${ctx.brandName} before an automated check-in text goes out. The lead inquired a while ago and has gone quiet. Today is ${ctx.now.toISOString().slice(0, 10)}. Their recorded intent: ${ctx.intent}.

Respond with ONLY one JSON object, no markdown:

{"action":"skip","reason":"..."} — the history shows we should NOT reach out: they declined or asked not to be contacted in any wording, already bought/sold, are working with another agent, said it's a wrong number, were hostile, or anything else where a check-in text would be unwelcome.

{"action":"script","reason":"..."} — there's no real conversation to build on (they barely replied, or only with a word or two). A standard check-in text will be used.

{"action":"personalized","reason":"...","message":"..."} — there IS real conversation to pick up from. Write the check-in text:
- Address them as ${ctx.firstName === "there" ? '"Hi there"' : ctx.firstName}, from ${ctx.brandName}.
- One or two short sentences, casual and warm, like a real person texting. Under 250 characters.
- Reference ONE specific thing they actually told us (area, home type, timing, a life event) — never invent anything not in the history.
- End with one easy question about whether their plans are still on.
- No links, no prices or market claims, no promises, no pressure.
- Do not add an opt-out line — it's added automatically.

When unsure between skip and anything else, choose skip.`;
}

function transcript(messages: HistoryMessage[]): string {
  return messages
    .map((m) => `[${m.at?.slice(0, 10) ?? "?"}] ${m.direction === "inbound" ? "LEAD" : "US"} (${m.channel}): ${m.body}`)
    .join("\n");
}

function extractJson(raw: string): any {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end < start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function reviewHistory(
  messages: HistoryMessage[],
  ctx: ReviewContext,
  askFn: AskFn = (system, user) => ask(system, user, { maxTokens: 300, temperature: 0 })
): Promise<HistoryDecision> {
  const optOut = findOptOut(messages);
  if (optOut) return { action: "skip", reason: `said "${optOut.slice(0, 80)}"`, optOut: true };

  if (!messages.some((m) => m.direction === "inbound")) {
    return { action: "script", reason: "no replies in their history" };
  }

  let raw: string;
  try {
    raw = await askFn(systemPrompt(ctx), transcript(messages));
  } catch (error) {
    return { action: "retry", reason: `history review failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = extractJson(raw);
  const reason = typeof parsed?.reason === "string" && parsed.reason.trim() ? parsed.reason.trim().slice(0, 200) : "no reason given";

  if (parsed?.action === "skip") return { action: "skip", reason, optOut: false };
  if (parsed?.action === "script") return { action: "script", reason };
  if (parsed?.action === "personalized" && typeof parsed.message === "string") {
    let message = parsed.message.trim().replace(/\s+/g, " ");
    // Guardrails the model can't talk its way past. A failed check falls
    // back to the approved script rather than sending the risky text.
    if (!message || message.length > MAX_PERSONAL_CHARS || /https?:|www\.|\$\s?\d/i.test(message)) {
      return { action: "script", reason: `personal opener rejected by guardrails (${reason})` };
    }
    // "Reply STOP", not a bare "stop" — "feel free to stop by" is not an opt-out line.
    if (!/reply\s+stop/i.test(message)) message = `${message} ${ctx.stopLine}`;
    return { action: "personalized", reason, message };
  }
  return { action: "retry", reason: "history review returned something unreadable" };
}
