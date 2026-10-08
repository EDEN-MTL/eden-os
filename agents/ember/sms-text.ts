/**
 * Plain-text SMS helpers, kept in their own module so history.ts and
 * outreach.ts can both use them without importing each other.
 */
/** One SMS segment of plain (GSM-7) text. Longer texts bill as 153-character parts. */
export const SMS_SEGMENT_CHARS = 160;

const GSM7_BASIC = new Set(
  Array.from("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà")
);
/** GSM-7 extension characters — allowed, but each one costs 2 of the 160. */
const GSM7_EXTENDED = new Set(Array.from("^{}\\[]~|€"));

/** Characters a text uses up, as the carrier counts them (extension chars count twice). */
export function smsLength(text: string): number {
  let n = 0;
  for (const ch of Array.from(text)) n += GSM7_EXTENDED.has(ch) ? 2 : 1;
  return n;
}

/**
 * Keeps a text in the plain GSM-7 character set. Mark, 2026-10-06: one
 * long dash or curly quote switches the WHOLE message to Unicode (UCS-2),
 * which cuts a segment from 160 characters to 70 — a one-line reply bills
 * as 2-3 texts instead of 1. Mark, 2026-10-09: "make sure Ember is not
 * texting in a very expensive way" — so on top of swapping the usual
 * culprits, emoji are dropped, accents GSM-7 lacks are folded (ç → c),
 * two-slot characters ([ ] { } ~ |) are swapped for one-slot ones, and
 * stray double spaces are collapsed. Nothing outside GSM-7 survives.
 */
export function smsSafe(text: string): string {
  const swapped = text
    .replace(/[\u2014\u2013\u2012\u2010\u2011\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201A\u2032\u0060\u00B4]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/[\u00A0\u2007\u202F\t]/g, " ")
    .replace(/[\[{]/g, "(")
    .replace(/[\]}]/g, ")")
    .replace(/[~|]/g, "-");
  let out = "";
  for (const ch of Array.from(swapped)) {
    if (GSM7_BASIC.has(ch) || GSM7_EXTENDED.has(ch)) {
      out += ch;
      continue;
    }
    // é stays (it's GSM-7); ê, ç, á etc. lose the accent rather than the text.
    const folded = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (folded.length === 1 && GSM7_BASIC.has(folded)) out += folded;
    // Anything else — emoji, symbols, zero-width joiners — is dropped.
  }
  return out.replace(/ {2,}/g, " ").replace(/ +([.,!?])/g, "$1").trim();
}

/**
 * Keeps an AI-written reply to one segment. The prompt already asks for
 * under 160 characters; when the model runs over anyway, earlier sentences
 * are dropped and the LAST one kept, since that's where the question
 * usually is ("Great to hear! ... What area are you looking in?"). A reply
 * that's one long sentence is sent as written — cutting it mid-thought
 * would cost more in confusion than the extra segment does.
 */
export function fitOneSegment(text: string, max = SMS_SEGMENT_CHARS): string {
  if (smsLength(text) <= max) return text;
  const sentences = text.split(/(?<=[.!?])\s+/);
  let kept = sentences[sentences.length - 1];
  if (smsLength(kept) > max) return text;
  for (let i = sentences.length - 2; i >= 0; i--) {
    const next = `${sentences[i]} ${kept}`;
    if (smsLength(next) > max) break;
    kept = next;
  }
  return kept;
}
