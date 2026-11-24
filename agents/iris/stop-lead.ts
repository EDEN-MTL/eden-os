/**
 * A teammate says "stop calling and texting X" in Slack (Mark, 2026-10-10; made real by the self-audit, 2026-11-20).
 *
 * The first version only closed the lead's queue row, and only if it was still 'pending'. That left four holes:
 *   - a lead whose row was 'placed' (a call in flight, or just ended) got the "nothing queued" answer, and the
 *     end-of-call retry then reopened the row, so Iris called again;
 *   - a lead with no row at all (an Ember nurture lead, an old lead a sweep or the cohort could pick up) was told
 *     "nothing to stop", and then was contacted anyway;
 *   - nothing lasting was left on the lead, so a new form submission or the next sweep queued them again;
 *   - Ember's nurture texts were not touched.
 * A stop now leaves the same lasting record a text opt-out does: the "do not call" tag, which every Iris path and
 * Ember read before they act, plus the closed rows, Ember's nurture stopped, and a note on the contact. It does NOT
 * move the card: the team asked to be left alone, not for the lead to be written off.
 */
import { query } from "../../shared/db";
import { addContactTags, createContactNote, getContact, getGhlConfig } from "../../shared/ghl";
import { listOpenLeadsByContactId, updateLead } from "../ember/store";
import { DO_NOT_CALL_TAG } from "./opt-out";

export interface StopState {
  /** Iris queue rows still pending or placed (a call in flight counts: its retry would otherwise reopen the row). */
  openRows: number;
  /** Ember nurture leads still in play for this contact. */
  emberLeads: number;
  /** Already carrying the lasting tag. */
  tagged: boolean;
}

export async function readStopState(clientId: string, contactId: string): Promise<StopState> {
  const rows = await query<{ n: string | number }>(
    `SELECT count(*) AS n FROM iris_pending_calls WHERE client_id = $1 AND contact_id = $2 AND status IN ('pending', 'placed')`,
    [clientId, contactId]
  );
  const ember = await listOpenLeadsByContactId(contactId).catch(() => []);
  let tagged = false;
  const ghl = await getGhlConfig(clientId).catch(() => null);
  if (ghl) {
    const raw: any = await getContact(contactId, ghl.locationId, ghl.apiKey).catch(() => null);
    const tags: unknown[] = (raw?.contact ?? raw)?.tags ?? [];
    tagged = tags.some((t) => String(t).toLowerCase() === DO_NOT_CALL_TAG);
  }
  return { openRows: Number(rows[0]?.n ?? 0), emberLeads: ember.length, tagged };
}

export interface StopOutcome {
  closedRows: number;
  emberStopped: number;
  /** False when the GHL tag could not be written: the lead is closed in our queue but NOT protected from the next sweep. */
  tagged: boolean;
}

/**
 * Closes the lead's Iris queue rows (pending or placed) and exits their Ember nurture. Shared by a teammate's Slack stop and a
 * lead's own stop on a call (voice-stop.ts). Does not tag or note: each caller words those for its own case.
 */
export async function closeQueueAndNurture(clientId: string, contactId: string, reason: string): Promise<{ closedRows: number; emberStopped: number }> {
  const closed = await query<{ id: number }>(
    `UPDATE iris_pending_calls
     SET status = 'skipped', resolution_reason = $3, resolved_at = now(), dial_lease_until = NULL, dial_lease_token = NULL
     WHERE client_id = $1 AND contact_id = $2 AND status IN ('pending', 'placed')
     RETURNING id`,
    [clientId, contactId, reason]
  );

  let emberStopped = 0;
  for (const lead of await listOpenLeadsByContactId(contactId).catch(() => [])) {
    await updateLead(lead.id, { status: "exited", statusReason: reason, nextTouchAt: null }).then(() => emberStopped++).catch((error) => {
      console.error(`[IRS] Could not stop Ember lead ${lead.id} after a Slack stop:`, error instanceof Error ? error.message : error);
    });
  }

  return { closedRows: closed.length, emberStopped };
}

export async function carryOutStop(clientId: string, contactId: string, requestedBy: string): Promise<StopOutcome> {
  const { closedRows, emberStopped } = await closeQueueAndNurture(clientId, contactId, `stopped in Slack by ${requestedBy}`);

  let tagged = false;
  const ghl = await getGhlConfig(clientId).catch(() => null);
  if (ghl) {
    tagged = await addContactTags(contactId, [DO_NOT_CALL_TAG], ghl.locationId, ghl.apiKey).then(() => true).catch((error) => {
      console.error(`[IRS] Could not tag ${contactId} "${DO_NOT_CALL_TAG}" after a Slack stop:`, error instanceof Error ? error.message : error);
      return false;
    });
    await createContactNote(contactId, `Iris: a teammate (${requestedBy}) asked in Slack to stop all calls and texts to this lead. Tagged "${DO_NOT_CALL_TAG}", queue closed, nurture stopped.`, ghl.locationId, ghl.apiKey).catch(() => {});
  }
  return { closedRows, emberStopped, tagged };
}
