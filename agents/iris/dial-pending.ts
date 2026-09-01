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
 */
import { query } from "../../shared/db";
import { recheckFirstTouch } from "../scout";
import { NormalisedLead } from "../scout/intake";
import { loadIrisConfig, loadClientBranding } from "./index";
import { buildLeadQualificationPrompt } from "./scripts";
import { placeCall, CallingDisabledError } from "./calling";

interface PendingCallRow {
  id: number;
  client_id: string;
  contact_id: string;
  lead: NormalisedLead;
}

async function markResolved(id: number, status: "placed" | "skipped" | "failed", reason: string): Promise<void> {
  await query(
    `UPDATE iris_pending_calls SET status = $2, resolution_reason = $3, resolved_at = now() WHERE id = $1`,
    [id, status, reason]
  );
}

async function resolveOne(row: PendingCallRow): Promise<void> {
  const lead = row.lead;

  const config = loadIrisConfig(row.client_id);
  const branding = loadClientBranding(row.client_id);
  if (!config || !branding) {
    await markResolved(row.id, "failed", "no iris config or client branding for this client");
    return;
  }

  // Fails closed by design (see recheckFirstTouch's own doc comment): both
  // "definitely already touched" and "couldn't verify" skip the call. The
  // cost of wrongly skipping is the lead waits for the next trigger; the
  // cost of wrongly calling is a real person phoned twice by a bot.
  const stillFirstTouch = await recheckFirstTouch(row.contact_id, row.client_id);
  if (stillFirstTouch !== true) {
    await markResolved(
      row.id,
      "skipped",
      stillFirstTouch === false ? "already touched since queued" : "could not verify contact state"
    );
    return;
  }

  if (!lead.phone) {
    await markResolved(row.id, "failed", "no phone on file");
    return;
  }

  try {
    const result = await placeCall({
      clientId: row.client_id,
      brandName: branding.brandName,
      city: branding.city,
      phone: lead.phone,
      firstName: lead.name?.split(" ")[0] || "there",
      intent: lead.intent,
      leadSource: lead.leadSource,
      systemPrompt: buildLeadQualificationPrompt(config, lead, branding.brandName, branding.city),
      contactId: row.contact_id,
      triggeredBy: "automatic",
    });
    await markResolved(row.id, "placed", result.id);
  } catch (error) {
    const reason = error instanceof CallingDisabledError ? error.message : error instanceof Error ? error.message : String(error);
    await markResolved(row.id, "failed", reason);
  }
}

/** Entry point called by the scheduler. Each row's failure is isolated — one bad row must not block the rest. */
export async function runDialPendingCalls(): Promise<void> {
  const due = await query<PendingCallRow>(
    `SELECT id, client_id, contact_id, lead FROM iris_pending_calls
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
