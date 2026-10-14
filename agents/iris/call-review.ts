/**
 * An automatic second look at every finished call, so nobody has to read each
 * transcript to find out whether Iris did her job. Mark, 2026-10-14: "I don't
 * want to check Jesse's call when it finishes or other leads from time to time.
 * I want Iris to automatically do it."
 *
 * Pure and free — no AI model. Each check is a failure that really happened on
 * a live call (Koren Pye Oct 12/13, Amanda Marie Oct 13, Angela Marie Oct 14),
 * so a repeat shows up in #iris-call-logs the moment the call ends.
 */

export interface TranscriptLine {
  role: string;
  message: string;
}

export interface CallReviewInput {
  lines: TranscriptLine[];
  endedReason: string | null;
  durationSeconds: number | null;
  /** True when a screener, voicemail greeting or recording was on the line and no real person joined. */
  machineOnly: boolean;
  /** The opening line Iris is supposed to say to a real person, if known. */
  expectedOpener?: string | null;
  /** For a call that should have been retried: whether a retry is actually lined up. */
  retryExpected?: boolean;
  retryLinedUp?: boolean;
}

export interface CallReview {
  verdict: "ok" | "attention";
  flags: string[];
  summary: string;
}

const norm = (text: string): string =>
  text
    .toLowerCase()
    .replace(/%/g, " percent")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const AI_QUESTION = /\b(?:are|is|am)\b.{0,25}\b(?:ai|a\.i\.|artificial|robot|bot|automated|computer|real person|human|machine)\b|\b(?:ai|robot|bot)\b\?/i;
const AI_ANSWER = /\b(?:ai|a\.i\.|artificial|virtual assistant|automated)\b/i;
const NARRATION = /(?:stay(?:ing)?|remain(?:ing)?|keep(?:ing)?) (?:silent|quiet)|wait(?:ing)? for (?:a|the) (?:real|live|actual) (?:person|human)|\[silent\]/i;
const IRIS_ONLY = /^\s*iris[.,!]?\s*$/i;

const quote = (text: string): string => `“${text.trim().slice(0, 80)}”`;

export function reviewCall(input: CallReviewInput): CallReview {
  const lines = input.lines.filter((l) => typeof l.message === "string" && l.message.trim() !== "");
  const bot = lines.filter((l) => l.role === "bot" || l.role === "assistant");
  const flags: string[] = [];

  // 1. Her own instructions, read aloud.
  const narration = bot.find((l) => NARRATION.test(l.message));
  if (narration) flags.push(`Iris spoke her own instruction out loud: ${quote(narration.message)}`);

  // 2. Anything beyond "Iris." said into a machine.
  if (input.machineOnly) {
    const extra = bot.filter((l) => !IRIS_ONLY.test(l.message) && !NARRATION.test(l.message));
    if (extra.length > 0) flags.push(`Iris spoke into a screener/voicemail (should be silent or just “Iris.”): ${quote(extra[0].message)}`);
  }

  // 3. The opener must be word for word, once, when a real person spoke.
  if (!input.machineOnly && input.expectedOpener) {
    // "Iris." is her answer to a screener, not the opener — the opener is the first thing she says after that.
    const first = bot.find((l) => !IRIS_ONLY.test(l.message));
    if (first && norm(first.message) !== norm(input.expectedOpener) && !norm(first.message).startsWith(norm(input.expectedOpener))) {
      flags.push(`Opening line wasn’t word for word — said ${quote(first.message)}`);
    }
    const intros = bot.filter((l) => /this is iris with/i.test(l.message)).length;
    if (intros > 1) flags.push(`Iris introduced herself ${intros} times`);
  }

  // 4. Straight answer to "are you an AI?".
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i].role === "user") && AI_QUESTION.test(lines[i].message) && lines[i].message.length < 80) {
      const reply = lines.slice(i + 1).find((l) => l.role === "bot" || l.role === "assistant");
      if (reply && !AI_ANSWER.test(reply.message)) {
        flags.push(`Lead asked if she’s an AI (${quote(lines[i].message)}) and she didn’t answer it: ${quote(reply.message)}`);
        break;
      }
    }
  }

  // 5. A real person spoke and Iris never said a word.
  if (!input.machineOnly && bot.length === 0) {
    const heard = lines.find((l) => l.role === "user");
    if (heard) flags.push(`Someone spoke (${quote(heard.message)}) and Iris never said a word`);
  }

  // 6. A call that should be retried but isn’t.
  if (input.retryExpected && input.retryLinedUp === false) flags.push("No retry is lined up for this lead");

  // Notes (not failures).
  const notes: string[] = [];
  const duration = input.durationSeconds ?? 0;
  const spoke = lines.some((l) => l.role === "user");
  if (!input.machineOnly && input.endedReason === "customer-ended-call" && duration > 0 && duration < 25) {
    notes.push(`The lead hung up after ${Math.round(duration)}s`);
  }

  const verdict: CallReview["verdict"] = flags.length > 0 ? "attention" : "ok";
  const summary =
    verdict === "attention"
      ? `⚠️ *Needs a look:*\n${flags.map((f) => `• ${f}`).join("\n")}${notes.length ? `\n_${notes.join("; ")}_` : ""}`
      : `✅ *Reviewed — nothing off.* ${
          input.machineOnly
            ? "Hit a machine; Iris stayed quiet and left no message."
            : spoke
              ? "Real conversation; opener, silence and AI-question handling all fine."
              : "No one spoke; Iris said nothing out of line."
        }${notes.length ? ` _${notes.join("; ")}_` : ""}`;

  return { verdict, flags, summary };
}
