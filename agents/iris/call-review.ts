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
  /** True when Vapi reports the live transfer actually connected. */
  transferSucceeded?: boolean;
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
/** Digits a voice reads one by one, a $ on a figure, or a currency that isn't ours. */
const SPOKEN_FIGURE_PROBLEM = /\d{5,}|(?:\d ){3,}\d|\$\s?\d|\b(?:euros?|pounds|pesos)\b|[€£]/i;
/** After a declined transfer, a booked time or a callback is a proper ending — not a dropped lead. */
const BOOKED_OR_CALLBACK = /you(?:'re| are) all set|(?:i(?:'ve| have)|we(?:'ve| have)) (?:booked|scheduled|noted)|booked for|scheduled (?:a|for|your)|callback (?:for|is|scheduled|booked)|call you back|a teammate will follow up/i;

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

  // 6. She said she'd connect the lead with an agent and then nothing happened. Angela
  // Marie, 2026-10-14: a fully qualified seller heard the transfer line, stayed quiet and
  // hung up — no transfer, no booking, and nobody was told.
  const promisedAt = bot.findIndex((l) => /connect you with/i.test(l.message));
  if (promisedAt !== -1 && !input.transferSucceeded) {
    const after = bot.slice(promisedAt + 1);
    const bookedOrCalledBack = after.some((l) => BOOKED_OR_CALLBACK.test(l.message));
    if (!bookedOrCalledBack) {
      flags.push(
        `Iris told the lead she’d connect them with an agent, but no transfer happened (call ended: ${input.endedReason ?? "unknown"}). A person should follow up with this lead today.`
      );
    }
  }

  // 7. An amount said as digits, or in the wrong currency. The voice reads a long number one digit
  // at a time and Iris has said "euro" — Noeleen Gray's budget came out as "2 9 9 2 5 euro dollars"
  // (2026-10-18). Looks for what actually reached the call: a run of five or more digits, digits
  // already split with spaces, a dollar sign on a figure, or another currency.
  const odd = bot.find((l) => SPOKEN_FIGURE_PROBLEM.test(l.message));
  if (odd) flags.push(`Iris said a figure the wrong way (digits or another currency): ${quote(odd.message)}`);

  // 8. A call that should be retried but isn’t.
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


/**
 * Which finished calls are worth a direct message. Mark, 2026-10-14: "I don't
 * want to check Koren and Jesse's calls when they finish — this should be
 * automatic." So Iris tells him herself: whenever a real person was reached,
 * whenever the review found something off, and for every call to a lead a person
 * asked her to call (a callback the lead requested, or one lined up by hand) —
 * but not for the routine voicemails of the normal sequence.
 */
export function shouldAlertTeam(input: { reachedPerson: boolean; flagged: boolean; watched: boolean }): boolean {
  return input.reachedPerson || input.flagged || input.watched;
}

export interface CallAlertInput {
  who: string;
  /** Client-local time the call ended, already formatted. */
  whenLocal: string;
  /** describeOutcome's one-liner, e.g. "📵 Voicemail greeting, no message left — will retry". */
  outcome: string;
  duration: string;
  review: CallReview;
  /** What happens next for this lead, already worded ("calls again Friday, October 16 at 10:00 AM"). */
  nextStep: string;
  /** "🔗 Vapi call · GHL contact", already built; "" or missing when there are no links. */
  links?: string;
}

export function formatCallAlert(a: CallAlertInput): string {
  const lines = [`📞 *${a.who}* — ${a.whenLocal} (${a.duration})`, a.outcome, `Next: ${a.nextStep}`];
  if (a.review.verdict === "attention") lines.push("", a.review.summary);
  if (a.links) lines.push(a.links);
  return lines.join("\n");
}
