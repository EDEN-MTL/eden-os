/**
 * What happens to a lead who texts that they don't want to be contacted.
 *
 * Mark, 2026-11-11 (Beverley Bradbury): she answered Iris's call, hung up 74 seconds later, and 28 seconds after
 * that texted "Please do not reach out to me any more. I will NOT talk to AI". Nothing happened: the text handler
 * only answers a lead whose queue row is still 'pending', and a call that connects leaves the row 'placed'. She was
 * never tagged and her card stayed in Replied. The rule ("do not call" tag, card to Not Interested) is the same one
 * as before; this is the part that carries it out, now also for a lead whose row is already closed.
 *
 * Acted on only when text-signals.ts is certain (a clear opt_out with the lead's own words quoted). A maybe is
 * only reported to the team, never closed.
 */
import { query } from "../../shared/db";
import { addContactTags, createContactNote, listOpportunitiesForContact, listPipelines, updateOpportunityStage } from "../../shared/ghl";
import { loadScoutConfig } from "../scout";
import { loadIrisConfig } from "./index";

export const DO_NOT_CALL_TAG = "do not call";

/**
 * A cheap gate in front of the model for texts from leads whose row is already closed, so an old lead texting "thanks!"
 * costs nothing. Deliberately loose: it only decides whether the classifier reads the text, and the classifier is
 * what decides whether it is a stop.
 */
const STOP_HINTS = /\b(stop|unsubscribe|remove|do not|don'?t|dont|no more|any ?more|anymore|no longer|not interested|leave me|reach out|contact me|text me|call me|harass|spam|never)\b/i;

export function mightBeStop(text: string): boolean {
  return STOP_HINTS.test(text);
}

export type StageMove =
  | { moved: true; stageName: string }
  | { moved: false; reason: "no-stage-configured" | "stage-not-found" | "no-open-card" | "already-there" | "person-works-it" };

async function stageIdByName(locationId: string, apiKey: string, name: string): Promise<string | null> {
  const wanted = name.trim().toLowerCase();
  for (const p of await listPipelines(locationId, apiKey)) for (const s of p.stages ?? []) if (String(s.name).trim().toLowerCase() === wanted) return s.id;
  return null;
}

/**
 * Moves the lead's open card to the client's Not Interested stage (iris.followUpCohort.notInterestedStage, a stage
 * NAME resolved against the live pipeline). A card sitting in a column a person works (a live transfer, a booked
 * appointment) is left where it is: the tag still keeps Iris away, and the team is told.
 */
export async function moveToNotInterested(clientId: string, contactId: string, ghl: { locationId: string; apiKey: string }): Promise<StageMove> {
  return moveCardToStage(clientId, contactId, ghl, loadIrisConfig(clientId)?.followUpCohort?.notInterestedStage);
}

/** Same move for "not right now": the client's Not Ready stage, where Ember takes over (Mark, 2026-11-25). */
export async function moveToNotReady(clientId: string, contactId: string, ghl: { locationId: string; apiKey: string }): Promise<StageMove> {
  return moveCardToStage(clientId, contactId, ghl, loadIrisConfig(clientId)?.followUpCohort?.notReadyStage);
}

async function moveCardToStage(clientId: string, contactId: string, ghl: { locationId: string; apiKey: string }, stageName: string | undefined): Promise<StageMove> {
  if (!stageName) return { moved: false, reason: "no-stage-configured" };
  const stageId = await stageIdByName(ghl.locationId, ghl.apiKey, stageName);
  if (!stageId) return { moved: false, reason: "stage-not-found" };

  const open = (await listOpportunitiesForContact(contactId, ghl.locationId, ghl.apiKey)).filter((o: any) => !o.status || o.status === "open");
  if (open.length === 0) return { moved: false, reason: "no-open-card" };

  const scout = loadScoutConfig(clientId);
  const protectedStages: string[] = scout?.historyStageIds?.length ? scout.historyStageIds : scout?.touchedStageIds ?? [];
  let alreadyThere = false;
  let protectedCard = false;
  let moved = false;
  for (const opp of open) {
    if (opp.pipelineStageId === stageId) {
      alreadyThere = true;
      continue;
    }
    if (protectedStages.includes(opp.pipelineStageId)) {
      protectedCard = true;
      continue;
    }
    await updateOpportunityStage(opp.id, stageId, ghl.locationId, ghl.apiKey);
    moved = true;
  }
  if (moved) return { moved: true, stageName };
  return { moved: false, reason: alreadyThere ? "already-there" : protectedCard ? "person-works-it" : "no-open-card" };
}

/** What the Slack post and the GHL note say about the card. */
export function describeStageMove(move: StageMove, column = "Not Interested"): string {
  if (move.moved) return `moved their card to *${move.stageName}*`;
  switch (move.reason) {
    case "already-there":
      return `their card was already in ${column}`;
    case "person-works-it":
      return "I left their card where it is because it sits in a column a person works — someone should move it";
    case "no-open-card":
      return "they have no open card to move";
    default:
      return `I could not find the ${column} column to move their card (check the stage name in the config)`;
  }
}

/**
 * Tags the lead "do not call" (the stop-everything tag every watcher reads) and moves the card to Not Interested.
 * Best-effort on each step: one failing never skips the other, and the caller says what happened in Slack.
 */
export async function recordOptOut(clientId: string, contactId: string, ghl: { locationId: string; apiKey: string }, quote: string): Promise<string> {
  await addContactTags(contactId, [DO_NOT_CALL_TAG], ghl.locationId, ghl.apiKey).catch((error) => {
    console.error(`[IRS] Failed to tag contact ${contactId} as "${DO_NOT_CALL_TAG}":`, error instanceof Error ? error.message : error);
  });
  let summary: string;
  try {
    summary = describeStageMove(await moveToNotInterested(clientId, contactId, ghl));
  } catch (error) {
    console.error(`[IRS] Failed to move contact ${contactId} to Not Interested:`, error instanceof Error ? error.message : error);
    summary = "I could not move their card (it failed), so someone should move it to Not Interested";
  }
  await createContactNote(contactId, `Iris: the lead texted to stop being contacted ("${quote.slice(0, 200)}") — tagged "${DO_NOT_CALL_TAG}"; ${summary.replace(/\*/g, "")}.`, ghl.locationId, ghl.apiKey).catch(() => {});
  return summary;
}

/**
 * A lead who said "not right now" / "not at this time" / "I'll let you know when I'm ready" (Mark, 2026-11-25): not a stop,
 * so no "do not call" tag and no goodbye text. Iris closes her own queue row for them, moves the card to Not Ready, and
 * Ember (which works that column) follows up when they are due. Returns what was done, for the Slack post.
 */
export async function recordNotNow(clientId: string, contactId: string, ghl: { locationId: string; apiKey: string }, quote: string): Promise<string> {
  await query(
    `UPDATE iris_pending_calls SET status = 'skipped', resolution_reason = 'lead said not right now — moved to Not Ready, Ember follows up', resolved_at = now()
     WHERE client_id = $1 AND contact_id = $2 AND status IN ('pending', 'placed')`,
    [clientId, contactId]
  ).catch((error) => console.error(`[IRS] Failed to close the queue row for ${contactId}:`, error instanceof Error ? error.message : error));
  let summary: string;
  try {
    summary = describeStageMove(await moveToNotReady(clientId, contactId, ghl), "Not Ready");
  } catch (error) {
    console.error(`[IRS] Failed to move contact ${contactId} to Not Ready:`, error instanceof Error ? error.message : error);
    summary = "I could not move their card (it failed), so someone should move it to Not Ready";
  }
  await createContactNote(contactId, `Iris: the lead said not right now ("${quote.slice(0, 200)}") — no calls from Iris; ${summary.replace(/\*/g, "")}. Ember follows up when they are due.`, ghl.locationId, ghl.apiKey).catch(() => {});
  return summary;
}
