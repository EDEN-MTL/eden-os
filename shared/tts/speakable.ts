/**
 * Turns model output into something worth speaking aloud.
 *
 * EDEN's replies are written for a screen: bold runs, bullet lists, em-dashes,
 * arrows, code spans, tables, the occasional URL. Sent straight to a TTS
 * engine that comes out as either literal symbol names or long dead air, which
 * is what makes the voice sound like a document being read rather than a
 * person talking.
 *
 * The rules are ordered — several depend on earlier ones having run (fences
 * before inline code, links before bare URLs, lists before stray punctuation).
 *
 * Currency and numbers are left alone on purpose: ElevenLabs already reads
 * "$50" as "fifty dollars" and "2.6%" correctly, and rewriting them by hand
 * makes it worse.
 */

const DROP_CHARS = /[*_~`#>|]/g;

export function speakable(input: string): string {
  if (!input) return "";
  let t = input;

  // Code blocks and tables cannot be spoken. Say they exist rather than
  // reading them aloud or dropping content the listener may have asked about.
  t = t.replace(/```[\s\S]*?```/g, " Code block omitted. ");
  t = t.replace(/^\s*\|.*\|\s*$/gm, "");

  // Keep a link's label, drop the address — nobody wants a URL read out.
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  t = t.replace(/https?:\/\/\S+/g, " link ");

  // Headings become sentences so they land with a full stop.
  t = t.replace(/^\s{0,3}#{1,6}\s*(.+?)\s*#*\s*$/gm, (_m, h: string) => `${h.replace(/[.:]\s*$/, "")}. `);

  // List markers are otherwise read as "dash" / "asterisk", or become an
  // unexplained pause.
  t = t.replace(/^\s*[-•*+]\s+/gm, "");
  t = t.replace(/^\s*\d+[.)]\s+/gm, "");

  // Dashes used as parenthetical punctuation. An em-dash is voiced as a long
  // stop; a comma keeps the sentence moving.
  t = t.replace(/\s*[—–]\s*/g, ", ");
  t = t.replace(/(\w)\s-\s(\w)/g, "$1, $2");

  /*
   * Tick and cross are used two different ways, and the position tells you
   * which. At the start of a line they are list markers and the sentence
   * already carries the meaning ("✓ Verified" reads as "yes Verified"
   * otherwise, which is wrong). Mid-sentence they ARE the verb, so they have
   * to be voiced or the meaning inverts.
   */
  t = t.replace(/^\s*[✓✔✗✘]\s*/gm, "");

  // Symbols this codebase actually emits, which have no spoken form.
  t = t
    .replace(/[→⇄►▶]/g, " to ")
    .replace(/[✓✔]/g, " yes ")
    .replace(/[✗✘]/g, " no ")
    .replace(/[·•◆◈⬡▤▣◉⚙✎]/g, " ")
    .replace(/\.{3,}|…/g, ", ");

  t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "");
  t = t.replace(DROP_CHARS, "");

  // Blank lines are the main source of dead air — a paragraph break becomes a
  // multi-second gap. One sentence boundary is enough.
  t = t.replace(/\n{2,}/g, ". ").replace(/\n/g, ". ");

  // Tidy what the substitutions leave behind.
  t = t
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/([,.])\1+/g, "$1")
    .replace(/\.\s*,/g, ".")
    .replace(/,\s*\./g, ".")
    .replace(/:\s*\./g, ":")
    .replace(/;\s*\./g, ".")
    .replace(/^[\s,.]+/, "")
    .replace(/[\s,]+$/, "")
    .trim();

  return t;
}
