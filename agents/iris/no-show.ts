/**
 * Iris follows up on no-shows. Mark, 2026-10-20: a lead who booked an
 * appointment with a 3% agent and did not show is dragged by that agent into
 * the No-Show column. Iris texts them within minutes to offer another time,
 * then calls at the next 10 AM / 2 PM slot if they have not replied, and books
 * the new appointment herself (by text or on the call).
 *
 * How she finds them: a scan every few minutes reads the client's No-Show
 * column (the same polling Ember uses, because GHL's stage-change workflow
 * would need building by hand in the GHL UI). A card counts as a fresh no-show
 * the first time its (id, lastStageChangeAt) is seen, so one moved out and
 * back later is followed up again, and one already sitting there when the
 * feature was switched on is recorded as 'baseline' and never touched.
 *
 * What she does NOT do: contact anyone a teammate has already texted, anyone
 * who opted out, anyone who already has a new appointment, or anyone outside
 * the 8 AM to 9 PM window. A card she cannot judge yet (GHL unreadable, wrong
 * hour) is left unrecorded so the next scan tries again.
 */
import { readdirSync } from "fs";
import { join } from "path";
import { query } from "../../shared/db";
import { sendMessage } from "../../shared/slack";
import { getContact, getGhlConfig, getLocationTimezone, listLocationUsers, listOpportunitiesInStage, listPipelines, getContactAppointments } from "../../shared/ghl";
import { refreshLead } from "../scout";
import { sendIrisText } from "../../webhooks/vapi-webhook";
import { loadClientBranding, loadIrisConfig } from "./index";
import { extractFirstName } from "./scripts";
import { clampToLegalCallingWindow, formatLocal, isWithinLegalCallingWindow, nextSlotAfter } from "./cadence";
import { CALL_LOG_CHANNEL } from "./channels";
import { linkLineFor } from "./links";
import { checkHumanTouch, DEFAULT_HUMAN_HANDS_OFF_DAYS } from "./human-touch";
import { NO_SHOW_SOURCE, NoShowContext, buildNoShowText, describeMissedDay, readAppointments } from "./no-show-state";
import { CallIntent } from "./qualification";

/** After the text, wait at least this long for a reply before the first call. */
const FIRST_CALL_MIN_HOURS = 3;
/** A contact followed up this recently is not texted again, however the card got there. */
const RECENT_FOLLOW_UP_DAYS = 14;
const BASELINE_MARKER = "__baseline__";

export type NoShowDecision =
  | { action: "start"; context: NoShowContext; intent: CallIntent }
  | { action: "skip"; reason: string }
  /** Cannot decide yet; leave it for the next scan. */
  | { action: "wait"; reason: string };

export interface NoShowFacts {
  hasPhone: boolean;
  hasName: boolean;
  doNotContact: boolean;
  hoursOk: boolean;
  recentlyFollowedUp: boolean;
  /** A live appointment already ahead of now. */
  rebooked: boolean;
  missed: { appointmentTitle: string | null; at: Date; agentName: string | null } | null;
}

/** The whole decision, pure. */
export function decideNoShow(facts: NoShowFacts, now: Date, timeZone: string, fallbackIntent: CallIntent): NoShowDecision {
  if (facts.doNotContact) return { action: "skip", reason: "opted out (do not call)" };
  if (!facts.hasPhone) return { action: "skip", reason: "no phone on file" };
  if (!facts.hasName) return { action: "skip", reason: "no confirmed name on file" };
  if (facts.rebooked) return { action: "skip", reason: "already has an appointment booked ahead" };
  if (facts.recentlyFollowedUp) return { action: "skip", reason: `already followed up in the last ${RECENT_FOLLOW_UP_DAYS} days` };
  if (!facts.hoursOk) return { action: "wait", reason: "outside texting hours" };
  // No appointment on record (the card was moved by hand): still follow up, just without naming one.
  const at = facts.missed?.at ?? null;
  const context: NoShowContext = {
    agentName: facts.missed?.agentName ?? null,
    missedDay: at ? describeMissedDay(at, now, timeZone) : "recently",
    missedWhen: at ? formatLocal(at.toISOString(), timeZone) : "recently",
  };
  return { action: "start", context, intent: intentFromTitle(facts.missed?.appointmentTitle) ?? fallbackIntent };
}

/** "Home Selling Consultation" -> seller, "Buyer Consultation" -> buyer. */
export function intentFromTitle(title: string | null | undefined): CallIntent | null {
  if (!title) return null;
  if (/sell/i.test(title)) return "seller";
  if (/buy/i.test(title)) return "buyer";
  return null;
}

/** The earliest moment for the first call: a real slot, no sooner than FIRST_CALL_MIN_HOURS after the text. */
export function firstCallTime(textedAt: Date, timeZone: string, cadence: Parameters<typeof nextSlotAfter>[0]): Date {
  return clampToLegalCallingWindow(nextSlotAfter(cadence, timeZone, new Date(textedAt.getTime() + FIRST_CALL_MIN_HOURS * 3_600_000)), timeZone);
}

function clientIdsWithNoShowFollowUp(): string[] {
  let files: string[] = [];
  try {
    files = readdirSync(join(process.cwd(), "config", "clients"));
  } catch {
    return [];
  }
  return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).filter((id) => loadIrisConfig(id)?.noShowFollowUp);
}

/** Entry point called by the scheduler. One client failing never stops the next. */
export async function runNoShowScan(): Promise<void> {
  for (const clientId of clientIdsWithNoShowFollowUp()) {
    try {
      await scanClient(clientId);
    } catch (error) {
      console.error(`[IRS-NOSHOW] Scan failed for ${clientId}:`, error instanceof Error ? error.message : error);
    }
  }
}

interface Card {
  id: string;
  contactId: string;
  changedAt: string;
  assignedTo: string | null;
}

async function readNoShowCards(clientId: string, stageName: string): Promise<Card[] | null> {
  const ghl = await getGhlConfig(clientId);
  if (!ghl) return null;
  const pipelines = await listPipelines(ghl.locationId, ghl.apiKey);
  const cards: Card[] = [];
  let found = false;
  for (const p of pipelines) {
    for (const s of p.stages ?? []) {
      if (String(s.name).trim().toLowerCase() !== stageName.trim().toLowerCase()) continue;
      found = true;
      for (const o of await listOpportunitiesInStage(ghl.locationId, p.id, s.id, ghl.apiKey)) {
        const contactId = o.contactId ?? o.contact?.id;
        if (!o.id || !contactId) continue;
        cards.push({ id: o.id, contactId, changedAt: String(o.lastStageChangeAt ?? o.updatedAt ?? o.createdAt ?? ""), assignedTo: o.assignedTo ?? null });
      }
    }
  }
  return found ? cards : null;
}

/** Records the card; resolves to the new row's id, or null when this exact (card, move) was already recorded. */
async function record(clientId: string, card: Card, outcome: "baseline" | "started" | "skipped", reason: string | null): Promise<string | null> {
  const rows = await query<{ id: string }>(
    `INSERT INTO iris_noshow_followups (client_id, opportunity_id, contact_id, stage_changed_at, outcome, reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (client_id, opportunity_id, stage_changed_at) DO NOTHING
     RETURNING id`,
    [clientId, card.id, card.contactId, card.changedAt, outcome, reason]
  );
  return rows[0]?.id ?? null;
}

export async function scanClient(clientId: string): Promise<void> {
  const config = loadIrisConfig(clientId);
  const settings = config?.noShowFollowUp;
  if (!config || !settings) return;

  const cards = await readNoShowCards(clientId, settings.stageName);
  if (cards === null) {
    console.warn(`[IRS-NOSHOW] ${clientId}: no "${settings.stageName}" stage found (or no GHL credentials), skipping.`);
    return;
  }

  const seen = await query<{ opportunity_id: string; stage_changed_at: string }>(`SELECT opportunity_id, stage_changed_at FROM iris_noshow_followups WHERE client_id = $1`, [clientId]);
  if (seen.length === 0) {
    // First scan ever for this client: whatever is in the column now is history, not a request.
    for (const card of cards) await record(clientId, card, "baseline", "already in the column when follow-up was switched on");
    await query(
      `INSERT INTO iris_noshow_followups (client_id, opportunity_id, contact_id, stage_changed_at, outcome, reason)
       VALUES ($1, $2, '', 'start', 'baseline', 'scan started') ON CONFLICT DO NOTHING`,
      [clientId, BASELINE_MARKER]
    );
    console.log(`[IRS-NOSHOW] ${clientId}: first scan, recorded ${cards.length} card(s) already in "${settings.stageName}" as baseline.`);
    return;
  }

  const known = new Set(seen.map((r) => `${r.opportunity_id}|${r.stage_changed_at}`));
  for (const card of cards) {
    if (known.has(`${card.id}|${card.changedAt}`)) continue;
    try {
      await handleNewNoShow(clientId, card);
    } catch (error) {
      console.error(`[IRS-NOSHOW] Failed on contact ${card.contactId}:`, error instanceof Error ? error.message : error);
    }
  }
}

async function handleNewNoShow(clientId: string, card: Card): Promise<void> {
  const config = loadIrisConfig(clientId);
  const branding = loadClientBranding(clientId);
  const ghl = await getGhlConfig(clientId);
  if (!config?.noShowFollowUp || !branding || !ghl) return;
  const timezone = (await getLocationTimezone(ghl.locationId, ghl.apiKey).catch(() => null)) || config.timezone || "America/St_Johns";
  const now = new Date();

  const lead = await refreshLead(card.contactId, clientId);
  if (!lead) return; // could not read the contact: try again next scan

  const contactResp = await getContact(card.contactId, ghl.locationId, ghl.apiKey).catch(() => null);
  const contact = contactResp?.contact ?? contactResp;
  const tags: string[] = (contact?.tags ?? []).map((t: string) => String(t).toLowerCase());
  const optedOut = tags.includes("do not call") || contact?.dnd === true;

  const appointments = await getContactAppointments(card.contactId, ghl.locationId, ghl.apiKey).catch(() => null);
  if (appointments === null) return;
  const picture = readAppointments(appointments, now, timezone);

  const users = await listLocationUsers(ghl.locationId, ghl.apiKey).catch(() => []);
  const agentId = picture.missed?.appointment.assignedUserId ?? card.assignedTo;
  const agentName = agentId ? users.find((u) => u.id === agentId)?.name ?? null : null;

  const recent = await query<{ one: number }>(
    `SELECT 1 AS one FROM iris_noshow_followups
     WHERE client_id = $1 AND contact_id = $2 AND outcome = 'started' AND created_at > now() - ($3 || ' days')::interval LIMIT 1`,
    [clientId, card.contactId, String(RECENT_FOLLOW_UP_DAYS)]
  );

  const decision = decideNoShow(
    {
      hasPhone: Boolean(lead.phone),
      hasName: Boolean(lead.name),
      doNotContact: optedOut,
      hoursOk: isWithinLegalCallingWindow(now, timezone),
      recentlyFollowedUp: recent.length > 0,
      rebooked: picture.upcoming !== null,
      missed: picture.missed ? { appointmentTitle: picture.missed.appointment.title ?? null, at: picture.missed.at, agentName } : null,
    },
    now,
    timezone,
    lead.intent === "unknown" ? "buyer" : lead.intent
  );

  if (decision.action === "wait") return;
  if (decision.action === "skip") {
    await record(clientId, card, "skipped", decision.reason);
    console.log(`[IRS-NOSHOW] ${lead.name ?? card.contactId}: not following up — ${decision.reason}.`);
    return;
  }

  // A teammate already texting them means the person is handling it.
  const humanTouch = await checkHumanTouch(card.contactId, ghl.locationId, ghl.apiKey, config.humanHandsOffDays ?? DEFAULT_HUMAN_HANDS_OFF_DAYS);
  if (humanTouch.status === "unknown") return;
  if (humanTouch.status === "human") {
    await record(clientId, card, "skipped", "a teammate has texted them");
    return;
  }

  // Claim the card first, so a slow scan overlapping this one cannot text twice.
  const followupId = await record(clientId, card, "started", null);
  if (followupId === null) return;

  const callAfter = firstCallTime(now, timezone, config.outreachCadence);
  const queuedLead = { ...lead, intent: decision.intent, noShow: { ...decision.context, followupId, textedAt: now.toISOString() } };
  await query(
    `INSERT INTO iris_pending_calls
       (client_id, contact_id, lead, call_after, status, is_explicit_callback, source, sms_scheduled, resolution_reason, attempts_made, callback_misses)
     VALUES ($1, $2, $3, $4, 'pending', true, $5, false, 'no-show follow-up', 0, 0)
     ON CONFLICT (client_id, contact_id) DO UPDATE
       SET lead = EXCLUDED.lead, call_after = EXCLUDED.call_after, status = 'pending',
           is_explicit_callback = true, source = $5, sms_scheduled = false, attempts_made = 0, callback_misses = 0,
           resolution_reason = 'no-show follow-up', resolved_at = NULL`,
    [clientId, card.contactId, JSON.stringify(queuedLead), callAfter, NO_SHOW_SOURCE]
  );

  const text = buildNoShowText(extractFirstName(lead.name), branding.brandName, decision.context);
  const outcome = await sendIrisText(clientId, card.contactId, lead.name, text);
  if (outcome === "skipped") {
    // sendIrisText found a teammate thread after all: stand down completely.
    await query(`UPDATE iris_pending_calls SET status = 'skipped', resolution_reason = 'a teammate is texting this lead', resolved_at = now() WHERE client_id = $1 AND contact_id = $2`, [clientId, card.contactId]);
    await query(`UPDATE iris_noshow_followups SET outcome = 'skipped', reason = 'a teammate is texting this lead' WHERE id = $1`, [followupId]);
    return;
  }

  const agentBit = decision.context.agentName ? ` with ${decision.context.agentName}` : "";
  await sendMessage("iris", {
    channel: CALL_LOG_CHANNEL,
    text:
      `🔁 *${lead.name}* was moved to No-Show (missed ${decision.context.missedWhen}${agentBit}). ` +
      `Iris texted them to rebook${outcome === "failed" ? " (the text could NOT be delivered)" : ""} and will call ${formatLocal(callAfter.toISOString(), timezone)} if there is no reply, up to ${config.noShowFollowUp.maxCalls} calls.` +
      (await linkLineFor(clientId, card.contactId).then((l) => (l ? `\n${l}` : "")).catch(() => "")),
  }).catch((error) => console.error("[IRS-NOSHOW] Failed to post to Slack:", error instanceof Error ? error.message : error));
  console.log(`[IRS-NOSHOW] ${lead.name}: texted, first call ${callAfter.toISOString()}.`);
}
