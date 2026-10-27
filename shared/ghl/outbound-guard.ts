/**
 * A last look at every text before it leaves. Marcia Wiseman (2026-10-23) replied "I have purchase a home. Thanks"
 * and Ember texted back her own contact id, "oTCjDHG2AP4okGSGUsYs", because a reply function was handed the
 * wrong arguments. Nothing ever sends a message that is just an id, an unfilled template or "undefined", so
 * this refuses them outright instead of letting a person receive one.
 *
 * Deliberately narrow: it only blocks things no real text could be, because wrongly blocking a real message
 * to a lead is worse than letting an odd one through.
 */

/** Why this text must not be sent, or null when it looks like a real message. */
export function outboundTextProblem(body: unknown, contactId?: string): string | null {
  if (typeof body !== "string") return "the message is not text";
  const text = body.trim();
  if (text === "") return "the message is empty";
  // (Only a real-looking id: a short placeholder would match ordinary words.)
  if (contactId && contactId.length >= 10 && text.includes(contactId)) return "the message contains the contact's own id";
  // A single long token with no spaces: an id, a token, a hash. Real texts have words.
  // (A plain long word such as "Congratulations" is fine: an id has a digit or capitals inside it.)
  if (/^[A-Za-z0-9_-]{12,}$/.test(text) && (/\d/.test(text) || /[A-Z]/.test(text.slice(1)))) return "the message is one unbroken string, like an id or token";
  if (/\{\{|\}\}/.test(text)) return "the message has an unfilled template placeholder";
  if (/\[object Object\]|\bundefined\b|\bNaN\b/.test(text)) return 'the message contains "undefined", "NaN" or "[object Object]"';
  return null;
}

export class BlockedTextError extends Error {
  constructor(public readonly problem: string, public readonly contactId: string) {
    super(`Blocked an outbound text to ${contactId}: ${problem}`);
    this.name = "BlockedTextError";
  }
}

export interface BlockedTextInfo {
  contactId: string;
  body: string;
  problem: string;
}

let onBlocked: ((info: BlockedTextInfo) => void) | null = null;

/** Registered once at startup (agents/iris/watchdog.ts) so a blocked text is reported, not just thrown. */
export function setBlockedTextHandler(handler: ((info: BlockedTextInfo) => void) | null): void {
  onBlocked = handler;
}

/** Throws BlockedTextError (after telling the handler) when the text must not go out. */
export function assertSendableText(contactId: string, body: unknown): void {
  const problem = outboundTextProblem(body, contactId);
  if (!problem) return;
  try {
    onBlocked?.({ contactId, body: String(body ?? "").slice(0, 200), problem });
  } catch {
    /* reporting must never change the outcome */
  }
  throw new BlockedTextError(problem, contactId);
}
