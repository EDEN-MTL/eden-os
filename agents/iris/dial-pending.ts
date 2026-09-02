/**
 * Resolves Iris's delayed dial queue — the other half of the lead.enriched
 * handler in index.ts, which only inserts a row and waits. Called on a
 * schedule (shared/scheduler), not per-webhook: nothing in this system runs
 * on its own without the scheduler driving it, same reasoning as
 * runMetaSync/runWeeklyLensReport there.
 *
 * Every row gets a FRESH firstTouch re-check against live GHL data before
 * dialing — never trusts the firstTouch value captured when the row was
 * queued, since the human ISA may have reached the lead in the meantime.
 * That's the entire reason cadence.ts takes a fresh check as an input
 * rather than caching it. This same re-check is also what naturally stops
 * the multi-day sequence below once a real conversation actually qualifies
 * the lead — once that happens, tags/notes exist in GHL, the next fresh
 * check reads firstTouch: false, and decideNextAttempt reports
 * stop-already-contacted, no special-casing needed for "did they answer."
 */
import { query } from "../../shared/db";
import { recheckFirstTouch } from "../scout";
import { NormalisedLead } from "../scout/intake";
import { loadIrisConfig, loadClientBranding } from "./index";
import { buildLeadQualificationPrompt } from "./scripts";
import { placeCall, CallingDisabledError } from "./calling";
import { decideNextAttempt, nextAttemptTime } from "./cadence";
import { transferNumberForIntent } from "./qualification";

/**
 * Client timezone for cadence slot times (10am/2pm local — see
 * cadence.ts's slotHours). Hardcoded because there's exactly one client
 * using Iris today and no per-client timezone field in config yet — same
 * single-client gap already flagged for VAPI_PHONE_NUMBER_ID in
 * agents/iris/index.ts. Move this to config/clients/<id>.json alongside
 * that fix once a second client needs Iris.
 */
const CLIENT_TIMEZONE = "America/St_Johns";

interface PendingCallRow {
  id: number;
  client_id: string;
  contact_id: string;
  lead: NormalisedLead;
  attempts_made: number;
  created_at: Date;
}

/** Ends the sequence for this row — no further attempts will be scheduled. */
async function finish(id: number, status: "placed" | "skipped" | "failed", reason: string): Promise<void> {
  await query(
    `UPDATE iris_pending_calls SET status = $2, resolution_reason = $3, resolved_at = now() WHERE id = $1`,
    [id, status, reason]
  );
}

/** Keeps the sequence going — same row, updated for the next scheduled attempt. */
async function reschedule(id: number, attemptsMade: number, callAfter: Date, lastVapiCallId: string): Promise<void> {
  await query(
    `UPDATE iris_pending_calls
     SET attempts_made = $2, call_after = $3, status = 'pending', resolution_reason = $4, resolved_at = NULL
     WHERE id = $1`,
    [id, attemptsMade, callAfter, lastVapiCallId]
  );
}

async function resolveOne(row: PendingCallRow): Promise<void> {
  const lead = row.lead;

  const config = loadIrisConfig(row.client_id);
  const branding = loadClientBranding(row.client_id);
  if (!config || !branding) {
    await finish(row.id, "failed", "no iris config or client branding for this client");
    return;
  }

  // Fails closed by design (see recheckFirstTouch's own doc comment): both
  // "definitely already touched" and "couldn't verify" stop the sequence.
  // The cost of wrongly stopping is the lead doesn't get another attempt
  // this round; the cost of wrongly calling is a real person phoned twice
  // by a bot, or after they've already been qualified by someone else.
  const stillFirstTouch = await recheckFirstTouch(row.contact_id, row.client_id);
  if (stillFirstTouch !== true) {
    await finish(
      row.id,
      "skipped",
      stillFirstTouch === false ? "already touched since queued" : "could not verify contact state"
    );
    return;
  }

  if (!lead.phone) {
    await finish(row.id, "failed", "no phone on file");
    return;
  }

  const attemptNumber = row.attempts_made + 1;

  try {
    const result = await placeCall({
      clientId: row.client_id,
      brandName: branding.brandName,
      city: branding.city,
      phone: lead.phone,
      firstName: lead.name?.split(" ")[0] || "there",
      intent: lead.intent,
      leadSource: lead.leadSource,
      systemPrompt: buildLeadQualificationPrompt(
        config,
        lead,
        branding.brandName,
        branding.city,
        Boolean(process.env.VAPI_SERVER_URL)
      ),
      transferNumber: transferNumberForIntent(config, lead.intent) ?? undefined,
      callbackCalendarId: config.callbackCalendarId,
      contactId: row.contact_id,
      triggeredBy: "automatic",
    });

    // Decided purely on attempt count + a fresh touch check, not on
    // whether THIS call was answered — see the module comment above for
    // why that's sufficient rather than a gap.
    const decision = decideNextAttempt(config.outreachCadence, attemptNumber, { firstTouch: true });
    if (decision === "attempt") {
      let callAfter = nextAttemptTime(config.outreachCadence, attemptNumber + 1, row.created_at, CLIENT_TIMEZONE);
      // A lead that comes in outside the 10am-2pm window (e.g. evening intake)
      // can make the next slot's theoretical time already past by the time
      // it's computed here. Clamp forward rather than either firing
      // immediately (call_after in the past looks "due" to the cron right
      // away) or silently dropping the attempt.
      if (callAfter && callAfter.getTime() <= Date.now()) {
        callAfter = new Date(Date.now() + 5 * 60 * 1000);
      }
      if (callAfter) {
        await reschedule(row.id, attemptNumber, callAfter, result.id);
        return;
      }
    }
    // decision === "sequence-exhausted", or nextAttemptTime came back null
    // (shouldn't happen if decideNextAttempt said "attempt", but fail to a
    // terminal state rather than silently dropping the row either way).
    await finish(row.id, "placed", result.id);
  } catch (error) {
    const reason = error instanceof CallingDisabledError ? error.message : error instanceof Error ? error.message : String(error);
    await finish(row.id, "failed", reason);
  }
}

/** Entry point called by the scheduler. Each row's failure is isolated — one bad row must not block the rest. */
export async function runDialPendingCalls(): Promise<void> {
  const due = await query<PendingCallRow>(
    `SELECT id, client_id, contact_id, lead, attempts_made, created_at FROM iris_pending_calls
     WHERE status = 'pending' AND call_after <= now()
     ORDER BY call_after ASC
     LIMIT 25`
  );

  if (due.length === 0) return;
  console.log(`[IRS] Resolving ${due.length} due pending call(s).`);

  for (const row of due) {
    try {
      await resolveOne(row);
    } catch (error) {
      console.error(`[IRS] Unexpected error resolving pending call ${row.id}:`, error instanceof Error ? error.message : error);
    }
  }
}
