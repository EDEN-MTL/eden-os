/**
 * Did this lead already get Iris's "I tried to call you but missed you" text recently?
 *
 * Mark, 2026-10-08: a second round of sweep calls to the same lead texts nobody again, because they already got the one
 * text after the first round. That was enforced by counting the row's call attempts (>= 2), which also counted calls
 * that never produced a sweep text. Magar Bhuma (2026-11-12): two calls on Nov 5 came from the normal cadence, which
 * texts differently, so the Nov 12 sweep call was attempt 3, was treated as "a second round", and he got no text at
 * all — his thread still ended on the Nov 5 message. The rule is about the text, so this reads the text: the lead's own
 * GHL thread, which also covers the sweep texts sent before anything was recorded in the database.
 */
import { getConversationMessages, getConversations } from "../../shared/ghl";

/** Back-to-back rounds (the daily follow-up chases a lead every few days) stay quiet; a lead untouched for a week hears from Iris again. */
export const SWEEP_TEXT_REPEAT_DAYS = 7;

/** The wording of buildSweepMissedCallText (webhooks/vapi-webhook.ts); sweep-text.test.ts pins the two together. */
const SWEEP_TEXT = /\bI tried to call you about .+ but missed you\. Are you still interested, or is there a better time to chat\?/;

export function isSweepMissedCallText(body: unknown): boolean {
  return typeof body === "string" && SWEEP_TEXT.test(body);
}

export type RecentSweepText = { status: "sent"; at: string } | { status: "none" } | { status: "unknown" };

/**
 * "unknown" when the thread can't be read: callers don't text (fail closed, like the rest of Iris), since a second text
 * to someone who already got one is worse than a missed first text that the next round can send.
 */
export async function recentSweepText(
  contactId: string,
  locationId: string,
  apiKey: string,
  withinDays: number = SWEEP_TEXT_REPEAT_DAYS,
  now: Date = new Date()
): Promise<RecentSweepText> {
  try {
    const conversations = await getConversations(contactId, locationId, apiKey);
    const conversationId: string | undefined = conversations?.conversations?.[0]?.id;
    if (!conversationId) return { status: "none" };
    const result = await getConversationMessages(conversationId, locationId, apiKey);
    const messages: any[] = result?.messages?.messages ?? [];
    const cutoff = now.getTime() - withinDays * 24 * 60 * 60 * 1000;
    const sent = messages.find(
      (m) => m?.direction === "outbound" && m?.status !== "failed" && m?.status !== "undelivered" && isSweepMissedCallText(m?.body) && typeof m?.dateAdded === "string" && Date.parse(m.dateAdded) >= cutoff
    );
    return sent ? { status: "sent", at: sent.dateAdded } : { status: "none" };
  } catch (error) {
    console.error(`[IRS] recentSweepText failed for contact ${contactId}:`, error instanceof Error ? error.message : error);
    return { status: "unknown" };
  }
}
