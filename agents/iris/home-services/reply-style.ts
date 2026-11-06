/**
 * Deterministic clean-up for what Iris texts, so tone does not depend on the model remembering every
 * style rule: people texting from a phone do not use em dashes, two-paragraph replies or an emoji in
 * every message. The prompt asks for this; this module enforces it.
 */

const EMOJI = /\p{Extended_Pictographic}️?/gu;
const hasEmoji = (text: string) => /\p{Extended_Pictographic}/u.test(text);

/** Limits for one text. Longer replies get one "say it shorter" retry, then are tidied and sent as they are. */
export const MAX_REPLY_CHARS = 230;
export const MAX_REPLY_SENTENCES = 3;

export function sentenceCount(text: string): number {
  return (text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? []).filter((s) => s.trim()).length;
}

export function isTooLong(text: string): boolean {
  return text.length > MAX_REPLY_CHARS || sentenceCount(text) > MAX_REPLY_SENTENCES;
}

/** One paragraph, no dashes used as punctuation, and emoji only when the lead used one first (then at most one). */
export function tidyReply(text: string, leadText: string): string {
  let out = text
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/,\s*,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (hasEmoji(leadText)) {
    let kept = false;
    out = out.replace(EMOJI, (match) => (kept ? "" : ((kept = true), match)));
  } else {
    out = out.replace(EMOJI, "");
  }
  return out.replace(/\s+([.,!?])/g, "$1").replace(/\s{2,}/g, " ").trim();
}

export const SHORTEN_SYSTEM = `You edit text messages. Rewrite the message the user gives you so it is shorter and sounds like a real person texting from a phone.
Rules: same language as the message; at most 2 short sentences, about 25 words in total; keep the single question or next step it contains, and every concrete fact (names, times, addresses); drop thanks, apologies, restating what the other person said and filler closers; no dashes, no emoji. Reply with the rewritten message only.`;
