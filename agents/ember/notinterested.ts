/**
 * Carries out a Not Interested decision (status.ts): stops Ember for good,
 * moves the GHL card to the client's ember.notInterestedStage, and tells
 * #backend-ops why, quoting the lead — so a human can undo it in one click
 * if the call was wrong.
 */
import { AlertFn } from "./alerts";
import { EmberConfig } from "./config";
import { categoryLabel, NotInterestedCategory } from "./status";
import { transitionStatus } from "./store";
import { NurtureLead } from "./types";

export type MoveStageFn = (opportunityId: string, stageName: string) => Promise<void>;

/** Every status a lead can be in while Ember could still act on what they say. */
const MOVABLE = ["nurturing", "paused", "completed", "replied"];

export async function moveToNotInterested(
  lead: NurtureLead,
  decision: { category: NotInterestedCategory; evidence: string; by: "rule" | "ai" },
  ctx: { config: EmberConfig; clientName: string; alert: AlertFn; moveStage: MoveStageFn; now?: Date }
): Promise<boolean> {
  const quote = decision.evidence.trim().replace(/\s+/g, " ").slice(0, 160);
  const label = categoryLabel(decision.category);
  // A stop request is also an SMS opt-out (CASL), so it's recorded as such.
  const status = decision.category === "asked_to_stop" ? "opted_out" : "not_interested";
  const claimed = await transitionStatus(lead.id, MOVABLE, {
    status,
    statusReason: `Not Interested — ${label}: "${quote}"`,
    nextTouchAt: null,
  });
  if (!claimed) return false;

  const stage = ctx.config.notInterestedStage;
  let moved = false;
  let moveError: string | null = null;
  if (stage) {
    try {
      await ctx.moveStage(lead.ghlOpportunityId, stage);
      moved = true;
    } catch (error) {
      moveError = error instanceof Error ? error.message : String(error);
      console.error(`[EMB] could not move lead ${lead.id} to "${stage}":`, moveError);
    }
  }

  const who = lead.contactName || lead.phone || lead.ghlContactId;
  const lines = [
    `🧊 *Moved to Not Interested* — ${ctx.clientName}`,
    `*${who}* — ${label}. They said: "${quote}"`,
    moved
      ? `Card moved to "${stage}". Ember won't contact them again.`
      : `Ember has stopped contacting them, but the card is NOT moved${stage ? ` (couldn't move it to "${stage}": ${moveError})` : " (no ember.notInterestedStage configured)"} — please move it by hand.`,
    decision.by === "ai"
      ? `(Judged from their messages. If that's wrong: move the card back, and ask Ember in Slack to resume lead #${lead.id}.)`
      : "",
  ].filter(Boolean);
  try {
    await ctx.alert(lines.join("\n"));
  } catch (error) {
    console.error(`[EMB] Not Interested alert failed for lead ${lead.id}:`, error);
  }
  return true;
}
