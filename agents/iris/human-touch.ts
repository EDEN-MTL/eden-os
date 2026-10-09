/**
 * Has a real person on the team texted this lead recently? Mark, 2026-10-10:
 * "I want IRIS to be able to analyze if the text came from me, Jacob or any
 * other agent of 3% Realty — if that is true then IRIS should not intervene,
 * and if one of our agents initiated a text to follow up a lead, Iris should
 * not take care of that conversation."
 *
 * The signal is in GHL's own data. A text a person typed in the app carries
 * that person's `userId` and no `meta`. Iris's and Ember's texts (sent through
 * our integration) carry `meta.marketplace.appId` — and, on a contact that has
 * an assigned user, GHL ALSO stamps that user's `userId` on them, so `userId`
 * alone is not enough: Iris's Oct 7 text to Tony Molloy carried Genna Hickey's
 * id. Confirmed against live messages (Mark's text to Colin Myers, a
 * teammate's text to Dawnie Kearney, and Iris's own texts to both). The
 * automations' texts have source "workflow" and no userId. A text that failed
 * to send doesn't count — nobody actually reached the lead.
 *
 * A person texting from their own phone, outside GHL, can't be seen here.
 */
import { getConversationMessages, getConversations } from "../../shared/ghl";

export const DEFAULT_HUMAN_HANDS_OFF_DAYS = 7;

export type HumanTouch =
  | { status: "human"; at: string; userId: string }
  | { status: "none" }
  /** The thread couldn't be read — callers fail closed (don't act), same as the rest of Iris. */
  | { status: "unknown" };

export async function checkHumanTouch(
  contactId: string,
  locationId: string,
  apiKey: string,
  withinDays: number = DEFAULT_HUMAN_HANDS_OFF_DAYS,
  now: Date = new Date()
): Promise<HumanTouch> {
  try {
    const convoResult = await getConversations(contactId, locationId, apiKey);
    const conversationId: string | undefined = convoResult?.conversations?.[0]?.id;
    if (!conversationId) return { status: "none" };

    const msgResult = await getConversationMessages(conversationId, locationId, apiKey);
    const messages: any[] = msgResult?.messages?.messages ?? [];
    const cutoff = now.getTime() - withinDays * 24 * 60 * 60 * 1000;

    // GHL returns newest first, so the first match is the most recent human text.
    const human = messages.find(
      (m) =>
        m?.messageType === "TYPE_SMS" &&
        m?.direction === "outbound" &&
        typeof m?.userId === "string" &&
        m.userId !== "" &&
        !m?.meta?.marketplace &&
        m?.status !== "failed" &&
        typeof m?.dateAdded === "string" &&
        Date.parse(m.dateAdded) >= cutoff
    );
    return human ? { status: "human", at: human.dateAdded, userId: human.userId } : { status: "none" };
  } catch (error) {
    console.error(`[IRS] checkHumanTouch failed for contact ${contactId}:`, error instanceof Error ? error.message : error);
    return { status: "unknown" };
  }
}
