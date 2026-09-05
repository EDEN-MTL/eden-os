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
 * rather than caching it.
 *
 * Whether there's a NEXT attempt is decided elsewhere, once the call has
 * actually ended — see markPlaced/reopenForNextAttempt below. Mark,
 * 2026-09-06: the earlier design decided this immediately after placing
 * the call, before there was any way to know if it would be answered —
 * meaning a lead who picked up and had a real conversation still got
 * called again the next day. Only a genuinely unanswered call (voicemail,
 * no pickup, busy) reopens this row now; a real conversation always ends
 * the sequence, whatever the outcome. webhooks/vapi-webhook.ts's
 * end-of-call handler is the only place that knows which happened.
 */
import { query } from "../../shared/db";
import { recheckFirstTouch, refreshLead } from "../scout";
import { NormalisedLead } from "../scout/intake";
import { loadIrisConfig, loadClientBranding } from "./index";
import { buildLeadQualificationPrompt } from "./scripts";
import { placeCall, CallingDisabledError } from "./calling";
import { decideNextAttempt, nextAttemptTime } from "./cadence";
import { transferNumberForIntent, callbackCalendarForIntent } from "./qualification";

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
  is_explicit_callback: boolean;
}

/** Ends the sequence for this row — no further attempts will be scheduled. */
async function finish(id: number, status: "placed" | "skipped" | "failed", reason: string): Promise<void> {
  await query(
    `UPDATE iris_pending_calls SET status = $2, resolution_reason = $3, resolved_at = now() WHERE id = $1`,
    [id, status, reason]
  );
}

/**
 * Records that a call was placed, WITHOUT yet deciding whether there'll be
 * another attempt — that decision moved to webhooks/vapi-webhook.ts's
 * end-of-call handler (see reopenForNextAttempt below), since only it
 * knows whether this call was actually answered. Mark, 2026-09-06: calling
 * a lead who already answered — even if the conversation didn't end in a
 * booking or transfer — is exactly the "called twice" complaint; the old
 * design decided the next attempt immediately after placing THIS one,
 * before there was any way to know if it would be answered at all.
 * attempts_made is bumped here (not later) so the webhook's cadence
 * decision, whenever it runs, sees the correct count.
 */
async function markPlaced(id: number, attemptsMade: number, vapiCallId: string): Promise<void> {
  await query(
    `UPDATE iris_pending_calls
     SET attempts_made = $2, status = 'placed', resolution_reason = $3, resolved_at = now()
     WHERE id = $1`,
    [id, attemptsMade, vapiCallId]
  );
}

/**
 * Reopens a row for its next scheduled attempt — called by
 * webhooks/vapi-webhook.ts's end-of-call handler once it knows the call
 * genuinely wasn't answered (voicemail, no pickup, busy, or a technical
 * failure before a real conversation). Exported rather than duplicated,
 * since this is the exact same cadence logic runDialPendingCalls used to
 * apply eagerly. Returns false (row left in its terminal "placed" state)
 * when the cadence says the sequence is exhausted.
 */
export async function reopenForNextAttempt(
  id: number,
  clientId: string,
  attemptsMade: number,
  createdAt: Date
): Promise<boolean> {
  const config = loadIrisConfig(clientId);
  if (!config) return false;

  const decision = decideNextAttempt(config.outreachCadence, attemptsMade, { firstTouch: true });
  if (decision !== "attempt") return false;

  let callAfter = nextAttemptTime(config.outreachCadence, attemptsMade + 1, createdAt, config.timezone || CLIENT_TIMEZONE);
  if (!callAfter) return false;
  // Same clamp as the old eager-reschedule path — a lead that comes in
  // outside the 10am-2pm window can make the next slot's theoretical time
  // already past by the time this runs.
  if (callAfter.getTime() <= Date.now()) {
    callAfter = new Date(Date.now() + 5 * 60 * 1000);
  }

  await query(
    `UPDATE iris_pending_calls
     SET call_after = $2, status = 'pending', resolution_reason = 'not answered — retrying', resolved_at = NULL
     WHERE id = $1`,
    [id, callAfter]
  );
  return true;
}

async function resolveOne(row: PendingCallRow): Promise<void> {
  const config = loadIrisConfig(row.client_id);
  const branding = loadClientBranding(row.client_id);
  if (!config || !branding) {
    await finish(row.id, "failed", "no iris config or client branding for this client");
    return;
  }

  let lead: NormalisedLead;

  if (row.is_explicit_callback) {
    // A lead-requested callback bypasses the firstTouch gate on purpose —
    // see is_explicit_callback's schema comment: the callback note Iris
    // already wrote into isa_notes flips firstTouch false, which would
    // otherwise cause the very callback we promised to be skipped as
    // "already touched". Gate on `qualified` instead, which isa_notes
    // doesn't affect, and refetch fresh rather than trust the snapshot
    // taken when the callback was scheduled (could be days old by now).
    const fresh = await refreshLead(row.contact_id, row.client_id);
    if (!fresh) {
      await finish(row.id, "skipped", "could not verify contact state before honoring callback");
      return;
    }
    if (fresh.qualified) {
      await finish(row.id, "skipped", "already qualified since the callback was requested");
      return;
    }
    // A plain contact fetch never carries pipelineStageId — stage lives on
    // the Opportunity, not the Contact (same gap noted on isFirstTouch's
    // stageId, but intent has no equivalent tag-based fallback) — so a
    // fresh refetch's intent degrades to "unknown" even for a contact
    // that's clearly buyer/seller. Confirmed live, 2026-09-04, against a
    // real contact with no custom fields: refreshLead came back with
    // intent "unknown" despite the "buyer lead" tag. Falling back to the
    // originally-captured intent (never "unknown" by construction — see
    // index.ts's lead.enriched handler) keeps transferNumberForIntent
    // working for the callback dial instead of silently losing the
    // transfer tool.
    lead = { ...fresh, intent: fresh.intent !== "unknown" ? fresh.intent : row.lead.intent };
  } else {
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
    lead = row.lead;
  }

  if (!lead.phone) {
    await finish(row.id, "failed", "no phone on file");
    return;
  }

  const attemptNumber = row.attempts_made + 1;
  const transferNumber = transferNumberForIntent(config, lead.intent) ?? undefined;
  const calendarId = callbackCalendarForIntent(config, lead.intent) ?? undefined;

  try {
    const result = await placeCall({
      clientId: row.client_id,
      brandName: branding.brandName,
      city: branding.city,
      phone: lead.phone,
      firstName: lead.name?.split(" ")[0] || "there",
      intent: lead.intent,
      leadSource: lead.leadSource,
      budget: lead.budget,
      timeline: lead.timeline,
      propertyInterest: lead.propertyInterest,
      financing: lead.financing,
      systemPrompt: buildLeadQualificationPrompt(
        config,
        lead,
        branding.brandName,
        branding.city,
        Boolean(process.env.VAPI_SERVER_URL),
        Boolean(transferNumber),
        Boolean(calendarId)
      ),
      transferNumber,
      calendarId,
      contactId: row.contact_id,
      triggeredBy: "automatic",
    });

    // Whether there's a next attempt is decided later, once the call
    // actually ends — see markPlaced's own doc comment. is_explicit_callback
    // rows never get reopened regardless (reopenForNextAttempt isn't called
    // for them), same one-shot behavior as before.
    await markPlaced(row.id, attemptNumber, result.id);
  } catch (error) {
    const reason = error instanceof CallingDisabledError ? error.message : error instanceof Error ? error.message : String(error);
    await finish(row.id, "failed", reason);
  }
}

/**
 * Called by webhooks/vapi-tools.ts's schedule_callback tool handler, mid
 * live call, when a lead agrees to a specific callback time. Upserts the
 * SAME iris_pending_calls row this contact already has — UNIQUE(client_id,
 * contact_id) means every contact ever queued has exactly one, and it's
 * never deleted, only updated in place — so runDialPendingCalls picks this
 * up at the requested time via the normal cron, same as any other row.
 *
 * Returns false without writing anything when the lead can't be refreshed
 * right now — the caller (webhooks/vapi-tools.ts) must not tell the lead a
 * callback is scheduled when it isn't.
 */
export async function scheduleExplicitCallback(clientId: string, contactId: string, callbackTime: Date): Promise<boolean> {
  const lead = await refreshLead(contactId, clientId);
  if (!lead) return false;

  await query(
    `INSERT INTO iris_pending_calls (client_id, contact_id, lead, call_after, status, is_explicit_callback)
     VALUES ($1, $2, $3, $4, 'pending', true)
     ON CONFLICT (client_id, contact_id) DO UPDATE
     SET lead = EXCLUDED.lead, call_after = EXCLUDED.call_after, status = 'pending',
         is_explicit_callback = true, resolution_reason = 'lead requested callback', resolved_at = NULL`,
    [clientId, contactId, JSON.stringify(lead), callbackTime]
  );
  return true;
}

/** Entry point called by the scheduler. Each row's failure is isolated — one bad row must not block the rest. */
export async function runDialPendingCalls(): Promise<void> {
  const due = await query<PendingCallRow>(
    `SELECT id, client_id, contact_id, lead, attempts_made, created_at, is_explicit_callback FROM iris_pending_calls
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
