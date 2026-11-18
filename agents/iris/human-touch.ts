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
 * automations' texts have source "workflow" and no userId — except on a contact
 * with an assigned agent, where GHL stamps that agent's userId on them as well
 * (confirmed live on Angela Marie, 2026-10-13), so source "workflow" is excluded
 * outright. A text that failed
 * to send doesn't count — nobody actually reached the lead.
 *
 * A lead ASSIGNED to an agent also counts (Jacob, 2026-11-19, after Ember texted Sabrina Marie, who was assigned to
 * Justin Penney): "if they are assigned to an agent, the AI leaves them alone." Read from the contact and from any open
 * opportunity, so it holds however the assignment was made.
 *
 * A teammate who CALLED from GHL also counts (calls carry their userId); Iris's own calls never appear
 * in GHL. A person texting or calling from their own phone, outside GHL, can't be seen here.
 */
import { findOpenOpportunitiesForContact, getContact, getConversationMessages, getConversations } from "../../shared/ghl";

export const DEFAULT_HUMAN_HANDS_OFF_DAYS = 7;

/** An inbound call shorter than this was a ring or a voicemail, not a conversation with a teammate. */
const MIN_INBOUND_CALL_SECONDS = 30;

/**
 * GHL stamps a userId on a lead's own inbound call too (the user it rang), so a lead calling BACK — 6 seconds,
 * nobody picked up — looked like a teammate had called them and kept Iris from ever texting them (Melanie Petten,
 * 2026-11-05). A call the team placed always counts; one the lead placed counts only if it was a real conversation.
 */
function isConversation(call: any): boolean {
  if (call?.direction !== "inbound") return true;
  return Number(call?.meta?.call?.duration ?? 0) >= MIN_INBOUND_CALL_SECONDS;
}

export type HumanTouch =
  | { status: "human"; at: string; userId: string; kind: "text" | "call" | "assigned" }
  | { status: "none" }
  /** The thread couldn't be read — callers fail closed (don't act), same as the rest of Iris. */
  | { status: "unknown" };

export async function checkHumanTouch(
  contactId: string,
  locationId: string,
  apiKey: string,
  withinDays: number = DEFAULT_HUMAN_HANDS_OFF_DAYS,
  now: Date = new Date(),
  /**
   * A teammate's CALL counts too (Mark, 2026-10-21, after Iris called and moved Sabrina Marie a day
   * after Jacob had phoned and texted her). Off only for the Slack follow-up on leads a teammate
   * called and did not reach, where the call is the whole point.
   */
  options: { includeCalls?: boolean; includeAssignment?: boolean } = {}
): Promise<HumanTouch> {
  const includeCalls = options.includeCalls !== false;
  try {
    // Off only where an assigned agent is expected and the lead is still Iris's to message: a no-show rebook, and
    // the Slack commands where a teammate has explicitly asked (they are shown the assignment as a warning).
    if (options.includeAssignment !== false) {
      const assigned = await assignedAgentOf(contactId, locationId, apiKey);
      if (assigned) return { status: "human", at: now.toISOString(), userId: assigned, kind: "assigned" };
    }
    const convoResult = await getConversations(contactId, locationId, apiKey);
    const conversationId: string | undefined = convoResult?.conversations?.[0]?.id;
    if (!conversationId) return { status: "none" };

    const msgResult = await getConversationMessages(conversationId, locationId, apiKey);
    const messages: any[] = msgResult?.messages?.messages ?? [];
    const cutoff = now.getTime() - withinDays * 24 * 60 * 60 * 1000;

    // GHL returns newest first, so the first match is the most recent human contact.
    const inWindow = (m: any) => typeof m?.dateAdded === "string" && Date.parse(m.dateAdded) >= cutoff;
    const human = messages.find(
      (m) =>
        m?.messageType === "TYPE_SMS" &&
        m?.direction === "outbound" &&
        typeof m?.userId === "string" &&
        m.userId !== "" &&
        !m?.meta?.marketplace &&
        // The intake/follow-up automations. On a contact that has an assigned agent GHL
        // stamps that agent's userId on them too, which made Angela Marie's own
        // "you'll receive a call from IRIS" automation text look like her agent had
        // texted her (2026-10-13) — and would have kept Iris out of her text thread.
        m?.source !== "workflow" &&
        m?.status !== "failed" &&
        inWindow(m)
    );
    // A call a teammate placed or answered from GHL (Iris's own calls go through Vapi and never appear here).
    const call = includeCalls
      ? messages.find((m) => m?.messageType === "TYPE_CALL" && typeof m?.userId === "string" && m.userId !== "" && inWindow(m) && isConversation(m))
      : undefined;
    const newest = [human && { m: human, kind: "text" as const }, call && { m: call, kind: "call" as const }]
      .filter((x): x is { m: any; kind: "text" | "call" } => Boolean(x))
      .sort((a, b) => Date.parse(b.m.dateAdded) - Date.parse(a.m.dateAdded))[0];
    return newest ? { status: "human", at: newest.m.dateAdded, userId: newest.m.userId, kind: newest.kind } : { status: "none" };
  } catch (error) {
    console.error(`[IRS] checkHumanTouch failed for contact ${contactId}:`, error instanceof Error ? error.message : error);
    return { status: "unknown" };
  }
}

/**
 * The agent a lead is assigned to, from the contact or any open opportunity (GHL keeps both, and an account migration
 * once wiped one of them), or null. A read that fails throws, so checkHumanTouch answers "unknown" and callers fail
 * closed like everywhere else in Iris.
 */
export async function assignedAgentOf(contactId: string, locationId: string, apiKey: string): Promise<string | null> {
  const payload = await getContact(contactId, locationId, apiKey);
  const contact = payload?.contact ?? payload ?? {};
  if (typeof contact.assignedTo === "string" && contact.assignedTo) return contact.assignedTo;
  const opportunities = await findOpenOpportunitiesForContact(contactId, locationId, apiKey);
  const assignedOpp = (opportunities ?? []).find((o: any) => typeof o?.assignedTo === "string" && o.assignedTo);
  return assignedOpp ? (assignedOpp as any).assignedTo : null;
}

/** What the touch was, for a message to the team: "a teammate texted them on …", "…called…", "they are assigned to an agent". */
export function describeHumanTouch(touch: Extract<HumanTouch, { status: "human" }>): string {
  if (touch.kind === "assigned") return "they are assigned to an agent";
  return `a teammate ${touch.kind === "call" ? "called" : "texted"} them on ${touch.at}`;
}
