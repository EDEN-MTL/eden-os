/**
 * Reads a lead's real GHL history before Ember texts them, and plans how —
 * or whether — to reach out. Mark, 2026-09-24:
 *
 *   - Ember should check on sitting leads who never opted out.
 *   - A lead with next to no conversation gets the standard script; one
 *     with real history gets a text that picks up where they left off.
 *   - "Not interested" / "already bought" / "working with another agent"
 *     is NOT forever — try again after 6 months, starting from where they
 *     are in the CRM: pipeline stage, last conversation, calls with the
 *     team, notes.
 *
 * So there are two kinds of "no":
 *   1. HARD opt-outs — "stop", "unsubscribe", "don't text/contact me",
 *      "remove me", "wrong number" (and GHL DND, checked in outreach.ts).
 *      Permanent. CASL requires an unsubscribe to be honoured, and this is
 *      matched by rules in code, never left to a model's judgment.
 *   2. SOFT declines — "not interested", "we bought", "working with an
 *      agent", "not right now". The lead is paused for reApproachAfterDays
 *      from that message, then worked again from scratch.
 *
 * Fails toward NOT sending: if the history or the review can't be read,
 * the touch waits for the next send run rather than going out blind.
 */
import { ask } from "../../shared/claude";
import { getConversationMessages, getConversations } from "../../shared/ghl";

export interface HistoryMessage {
  direction: "inbound" | "outbound";
  channel: "sms" | "email" | "call";
  body: string;
  at: string | null;
}

/** How many recent messages to read. One page — enough to see the story. */
const HISTORY_LIMIT = 50;
const MAX_BODY_CHARS = 500;

function plain(body: string): string {
  return body.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_BODY_CHARS);
}

function callSummary(m: any): string {
  const call = m?.meta?.call ?? {};
  const bits = [call.status, typeof call.duration === "number" ? `${call.duration}s` : null].filter(Boolean);
  return `(phone call${bits.length ? `: ${bits.join(", ")}` : ""})`;
}

/**
 * Texts, emails and team phone calls, oldest first. GHL mixes in activity
 * entries (TYPE_ACTIVITY_OPPORTUNITY for stage moves, confirmed live
 * 2026-09-23) that aren't anything anyone said. Iris's own calls go through
 * Vapi, not GHL, so they're not here — see LeadContext.irisCalls.
 */
export async function readConversationHistory(contactId: string, locationId: string, apiKey: string): Promise<HistoryMessage[]> {
  const convos = await getConversations(contactId, locationId, apiKey);
  const out: HistoryMessage[] = [];
  for (const convo of convos?.conversations ?? []) {
    const page = await getConversationMessages(convo.id, locationId, apiKey, HISTORY_LIMIT);
    for (const m of page?.messages?.messages ?? []) {
      if (m?.direction !== "inbound" && m?.direction !== "outbound") continue;
      const at = typeof m.dateAdded === "string" ? m.dateAdded : null;
      if (m.messageType === "TYPE_CALL") {
        out.push({ direction: m.direction, channel: "call", body: callSummary(m), at });
        continue;
      }
      const channel = m.messageType === "TYPE_SMS" ? "sms" : m.messageType === "TYPE_EMAIL" ? "email" : null;
      if (!channel || typeof m.body !== "string" || !m.body.trim()) continue;
      out.push({ direction: m.direction, channel, body: plain(m.body), at });
    }
  }
  return out.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
}

/**
 * Permanent. Deliberately broad — a false positive costs one lead a text
 * they might have welcomed; a false negative texts someone who asked us to
 * stop, which is a CASL problem, not just a bad look.
 */
const HARD_OPT_OUT = [
  /^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*[.!]*\s*$/i,
  /\b(unsubscribe|remove me|take me off|opt(ed)? out)\b/i,
  /\b(do not|don'?t|dont|never|stop|quit)\s+(contact|text|txt|call|message|email|bother)(ing)?\b/i,
  /\bleave me alone\b/i,
  /\bwrong (number|person)\b/i,
];

/** "Not now", not "never" — re-approached after the cool-off. */
const SOFT_DECLINE = [
  /\bnot interested\b/i,
  /\b(already|just|we|i)\s+(bought|purchased|sold)\b/i,
  /\b(bought|sold) (a|our|my|the) (house|home|place|condo)\b/i,
  /\b(working|going) with (another|an|a different|my own|our own|a) (agent|realtor|broker)\b/i,
  /\bhave an? (agent|realtor)\b/i,
  /\bnot (right now|now|ready|looking( anymore)?|at this time)\b/i,
  /\bno longer (looking|interested|selling|buying)\b/i,
];

function lastMatch(messages: HistoryMessage[], patterns: RegExp[]): HistoryMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.direction === "inbound" && m.channel !== "call" && patterns.some((p) => p.test(m.body))) return m;
  }
  return null;
}

/** The inbound message that permanently rules this lead out, or null. */
export function findHardOptOut(messages: HistoryMessage[]): string | null {
  return lastMatch(messages, HARD_OPT_OUT)?.body ?? null;
}

/** Whether ONE reply is a permanent opt-out (used for replies to Ember). */
export function isHardOptOut(text: string): boolean {
  return HARD_OPT_OUT.some((p) => p.test(text));
}

/**
 * Asked for text instead of calls, in any wording seen live on 3%'s leads
 * (2026-09-25): Grace Penney — "I would appreciate to not be called so
 * many times"; Osose Oyakhire — "Please text me." Not an opt-out from
 * texting; it means no unrequested phone calls.
 */
const PREFERS_TEXT = [
  /\b(please\s+)?text me\b/i,
  /\bprefer (to )?(text|texting|messages?)\b/i,
  /\b(not|don'?t|dont|stop|quit|never)\s+(be\s+)?call(ed|ing)?\b/i,
  /\bno (more )?(phone )?calls\b/i,
  /\bnot available for (a )?(phone )?call\b/i,
  /\bcalled (me )?so many times\b/i,
];

export function prefersText(messages: HistoryMessage[]): string | null {
  return lastMatch(messages, PREFERS_TEXT)?.body ?? null;
}

/** The most recent soft decline, if any. */
export function findSoftDecline(messages: HistoryMessage[]): HistoryMessage | null {
  return lastMatch(messages, SOFT_DECLINE);
}

/**
 * Everything the CRM knows about where this lead stands — read fresh right
 * before the first touch of each cycle so the opener starts from there.
 */
export interface LeadContext {
  stageName: string | null;
  /** Days since the card last changed stage. */
  daysInStage: number | null;
  tags: string[];
  /** Form / qualification answers GHL already has (timeline, budget...). */
  knownAnswers: string[];
  notes: { at: string | null; text: string }[];
  irisCalls: { at: string | null; outcome: string | null; excerpt: string | null }[];
}

export const EMPTY_CONTEXT: LeadContext = { stageName: null, daysInStage: null, tags: [], knownAnswers: [], notes: [], irisCalls: [] };

export type HistoryDecision =
  | { action: "defer"; reason: string }
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
  lead: LeadContext;
  /** A soft decline older than the cool-off, if that's why we're back. */
  priorDecline: HistoryMessage | null;
}

export type AskFn = (system: string, user: string) => Promise<string>;

const MAX_PERSONAL_CHARS = 320;

function monthsAgo(iso: string | null, now: Date): string {
  if (!iso) return "at some point";
  const months = Math.round((now.getTime() - new Date(iso).getTime()) / (30 * 86_400_000));
  return months <= 0 ? "recently" : months === 1 ? "about a month ago" : `about ${months} months ago`;
}

function contextBlock(ctx: ReviewContext): string {
  const l = ctx.lead;
  const lines: string[] = [];
  if (l.stageName) lines.push(`Pipeline stage: ${l.stageName}${l.daysInStage !== null ? ` (untouched for ${Math.round(l.daysInStage)} days)` : ""}`);
  if (l.tags.length) lines.push(`Tags: ${l.tags.join(", ")}`);
  if (l.knownAnswers.length) lines.push(`On file: ${l.knownAnswers.join("; ")}`);
  for (const n of l.notes.slice(-5)) lines.push(`Team note (${n.at?.slice(0, 10) ?? "?"}): ${n.text}`);
  for (const c of l.irisCalls.slice(-3)) {
    lines.push(`Call with our assistant (${c.at?.slice(0, 10) ?? "?"}): ${c.outcome ?? "unknown outcome"}${c.excerpt ? ` — "${c.excerpt}"` : ""}`);
  }
  if (ctx.priorDecline) {
    lines.push(`They last declined ${monthsAgo(ctx.priorDecline.at, ctx.now)}, saying: "${ctx.priorDecline.body}". Enough time has passed to check in again, gently.`);
  }
  return lines.length ? lines.join("\n") : "Nothing else on file.";
}

function systemPrompt(ctx: ReviewContext): string {
  return `You review a real estate lead's CRM record and past texts/emails/calls for ${ctx.brandName} before an automated check-in text goes out. The lead inquired a while ago and has gone quiet. Today is ${ctx.now.toISOString().slice(0, 10)}. Their recorded intent: ${ctx.intent}.

## Where they stand in the CRM
${contextBlock(ctx)}

Respond with ONLY one JSON object, no markdown:

{"action":"defer","reason":"..."} — reaching out right NOW would be unwelcome or pointless (they very recently declined, are mid-transaction with someone else, were hostile, or the record shows something else that makes a text now a bad idea). This is NOT permanent — we'll look again in a few months. Never use this just because they declined long ago; the "last declined" line above means enough time has passed.

{"action":"script","reason":"..."} — there's no real conversation or CRM detail worth building on (they barely replied, only a word or two, nothing useful on file). A standard check-in text will be used.

{"action":"personalized","reason":"...","message":"..."} — there IS something real to pick up from. Write the check-in text:
- Address them as ${ctx.firstName === "there" ? '"Hi there"' : ctx.firstName}, from ${ctx.brandName}.
- One or two short sentences, casual and warm, like a real person texting. Under 250 characters.
- Start from where they left off: reference ONE specific real thing (what they were looking for, their timing, that they spoke with our team, or — if they declined before — acknowledge it lightly, e.g. that it's been a while). Never invent anything not in the record.
- End with one easy question about whether their plans have changed or are still on.
- No links, no prices or market claims, no promises, no pressure, no guilt.
- Do not add an opt-out line — it's added automatically.`;
}

function transcript(messages: HistoryMessage[]): string {
  if (!messages.length) return "(no texts, emails or calls on record)";
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

function hasContextWorthReading(messages: HistoryMessage[], ctx: ReviewContext): boolean {
  return (
    messages.some((m) => m.direction === "inbound" || m.channel === "call") ||
    ctx.lead.notes.length > 0 ||
    ctx.lead.irisCalls.length > 0 ||
    ctx.lead.knownAnswers.length > 0
  );
}

/**
 * The model's part of the plan. Hard opt-outs and the soft-decline cool-off
 * are decided in code BEFORE this runs (see planTouch in outreach.ts).
 */
export async function reviewHistory(
  messages: HistoryMessage[],
  ctx: ReviewContext,
  askFn: AskFn = (system, user) => ask(system, user, { maxTokens: 300, temperature: 0 })
): Promise<HistoryDecision> {
  if (!hasContextWorthReading(messages, ctx)) {
    return { action: "script", reason: "no replies, calls or notes on record" };
  }

  let raw: string;
  try {
    raw = await askFn(systemPrompt(ctx), transcript(messages));
  } catch (error) {
    return { action: "retry", reason: `history review failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = extractJson(raw);
  const reason = typeof parsed?.reason === "string" && parsed.reason.trim() ? parsed.reason.trim().slice(0, 200) : "no reason given";

  if (parsed?.action === "defer" || parsed?.action === "skip") return { action: "defer", reason };
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

/**
 * When CASL implied consent started: the later of the original inquiry and
 * the lead's own most recent message that ISN'T a decline or opt-out — a
 * lead writing to us about a move is a fresh inquiry. This reading of the
 * rules needs Jacob's confirmation (2026-09-24); see consentWindowDays.
 */
export function consentStart(inquiryAt: string | null, messages: HistoryMessage[]): string | null {
  let latest = inquiryAt;
  for (const m of messages) {
    if (m.direction !== "inbound" || m.channel === "call" || !m.at) continue;
    if (isHardOptOut(m.body) || SOFT_DECLINE.some((p) => p.test(m.body))) continue;
    if (!latest || m.at > latest) latest = m.at;
  }
  return latest;
}
