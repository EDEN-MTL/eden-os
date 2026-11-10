/**
 * A week of follow-up on a hand-picked group of leads, with a decided ending.
 * Mark, 2026-10-22, about the leads sitting in the weekend follow-up stages: "we will try to follow up
 * on them this week, and then move them to Not Ready if they never pick up or answer any text or call.
 * If they opted out, just move them to Not Interested."
 *
 * A member is enrolled with a few extra call rounds and a deadline. Each hour this checks every member:
 *   - opted out (do not call tag, or GHL do-not-disturb)  -> card to the client's Not Interested stage
 *   - a teammate texted or called them since enrolment    -> dropped; Iris leaves them alone
 *   - they replied, answered a call, or have a new appointment, or someone moved the card -> done; nothing moved
 *   - the deadline passed with none of that                -> card to the client's Not Ready stage
 *   - a round is due and nothing is in flight              -> queue the next call (one at a time, with the
 *                                                             usual one-text-after-a-miss)
 * Nothing is ever moved for a lead who engaged in any way, and a card that is no longer where it was
 * enrolled (a person moved it) is never touched.
 */
import { query } from "../../shared/db";
import {
  createContactNote,
  getContact,
  getContactAppointments,
  getConversationMessages,
  getConversations,
  getGhlConfig,
  listOpportunitiesForContact,
  listPipelines,
  updateOpportunityStage,
} from "../../shared/ghl";
import { sendMessage } from "../../shared/slack";
import { loadIrisConfig } from "./index";
import { queueColdLeadSweep } from "./dial-pending";
import { checkHumanTouch, DEFAULT_HUMAN_HANDS_OFF_DAYS } from "./human-touch";
import { CALL_LOG_CHANNEL } from "./channels";
import { linkLineFor } from "./links";
import { clampToLegalCallingWindow, formatLocal } from "./cadence";
import { readAppointments } from "./no-show-state";

export type CohortAction =
  | { action: "not_interested"; reason: string }
  | { action: "dropped"; reason: string }
  | { action: "engaged"; reason: string }
  | { action: "not_ready"; reason: string }
  | { action: "next_round" }
  | { action: "wait" };

export interface CohortFacts {
  now: Date;
  deadline: Date;
  /** Call rounds still to come (timestamps); roundsDone says how many have already been queued. */
  rounds: Date[];
  roundsDone: number;
  optedOut: boolean;
  /** The card is still in the stage it was enrolled from (nobody moved it). */
  cardStillThere: boolean;
  teammateTouchedSince: boolean;
  replied: boolean;
  answeredCall: boolean;
  appointmentAhead: boolean;
  /** Iris has a call due, ringing or waiting on a text reply right now. */
  irisBusy: boolean;
}

/** The whole decision, pure. Order matters: an opt-out is honoured before anything else, engagement before the deadline. */
export function decideCohortMember(f: CohortFacts): CohortAction {
  if (!f.cardStillThere) return { action: "dropped", reason: "someone moved their card" };
  if (f.optedOut) return { action: "not_interested", reason: "opted out" };
  if (f.teammateTouchedSince) return { action: "dropped", reason: "a teammate has been in touch since the follow-up started" };
  if (f.appointmentAhead) return { action: "engaged", reason: "has an appointment booked" };
  if (f.replied) return { action: "engaged", reason: "replied by text" };
  if (f.answeredCall) return { action: "engaged", reason: "picked up a call" };
  if (f.now.getTime() >= f.deadline.getTime()) return { action: "not_ready", reason: "no answer to any call or text" };
  const nextAt = f.rounds[f.roundsDone];
  if (nextAt && f.now.getTime() >= nextAt.getTime() && !f.irisBusy) return { action: "next_round" };
  return { action: "wait" };
}

/** A call that really reached a person: it ended for a reason other than no-answer/voicemail AND the lead said something. */
export function callAnswered(call: { ended_reason: string | null; transcript: string | null }): boolean {
  const reason = String(call.ended_reason ?? "");
  if (/did-not-answer|voicemail|busy|failed|error|silence-timed-out/i.test(reason)) return false;
  return /^User:\s*\S+/im.test(call.transcript ?? "") && !/voice ?mail|leave a message|after the tone|not available/i.test(call.transcript ?? "");
}

interface CohortRow {
  id: string;
  client_id: string;
  contact_id: string;
  contact_name: string;
  opportunity_id: string;
  stage_id: string;
  started_at: Date;
  deadline_at: Date;
  rounds: Date[];
  rounds_done: number;
}

export interface EnrollMember {
  contactId: string;
  name: string;
  opportunityId: string;
  stageId: string;
}

/** Puts leads in the cohort. Enrolling again restarts that lead's follow-up. */
export async function enrollCohort(clientId: string, members: EnrollMember[], rounds: Date[], deadline: Date, now: Date = new Date()): Promise<void> {
  for (const m of members) {
    await query(
      `INSERT INTO iris_followup_cohort (client_id, contact_id, contact_name, opportunity_id, stage_id, started_at, deadline_at, rounds, rounds_done, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 'active')
       ON CONFLICT (client_id, contact_id) DO UPDATE
         SET contact_name = EXCLUDED.contact_name, opportunity_id = EXCLUDED.opportunity_id, stage_id = EXCLUDED.stage_id,
             started_at = EXCLUDED.started_at, deadline_at = EXCLUDED.deadline_at, rounds = EXCLUDED.rounds,
             rounds_done = 0, status = 'active', outcome = NULL, resolved_at = NULL`,
      [clientId, m.contactId, m.name, m.opportunityId, m.stageId, now, deadline, rounds]
    );
  }
}

async function stageIdByName(locationId: string, apiKey: string, name: string): Promise<string | null> {
  const wanted = name.trim().toLowerCase();
  for (const p of await listPipelines(locationId, apiKey)) for (const s of p.stages ?? []) if (String(s.name).trim().toLowerCase() === wanted) return s.id;
  return null;
}

async function finishMember(row: CohortRow, status: string, outcome: string): Promise<void> {
  await query(`UPDATE iris_followup_cohort SET status = $2, outcome = $3, resolved_at = now() WHERE id = $1`, [row.id, status, outcome]);
}

/** Scheduler entry point (hourly). One member failing never stops the others. */
export async function runFollowUpCohortCheck(now: Date = new Date()): Promise<void> {
  const rows = await query<CohortRow>(`SELECT * FROM iris_followup_cohort WHERE status = 'active' ORDER BY id`);
  if (rows.length === 0) return;
  const byClient = new Map<string, CohortRow[]>();
  for (const r of rows) byClient.set(r.client_id, [...(byClient.get(r.client_id) ?? []), r]);
  for (const [clientId, members] of byClient) {
    try {
      await checkClient(clientId, members, now);
    } catch (error) {
      console.error(`[IRS-COHORT] ${clientId}:`, error instanceof Error ? error.message : error);
    }
  }
}

async function checkClient(clientId: string, members: CohortRow[], now: Date): Promise<void> {
  const config = loadIrisConfig(clientId);
  const settings = config?.followUpCohort;
  const ghl = await getGhlConfig(clientId);
  if (!config || !settings || !ghl) return;
  const timezone = config.timezone || "America/St_Johns";
  const notReadyId = await stageIdByName(ghl.locationId, ghl.apiKey, settings.notReadyStage);
  const notInterestedId = await stageIdByName(ghl.locationId, ghl.apiKey, settings.notInterestedStage);
  if (!notReadyId || !notInterestedId) {
    console.warn(`[IRS-COHORT] ${clientId}: a configured stage ("${settings.notReadyStage}" / "${settings.notInterestedStage}") was not found — leaving everyone where they are.`);
    return;
  }

  const toQueue: CohortRow[] = [];
  for (const row of members) {
    try {
      const outcome = await evaluate(clientId, row, ghl, config.humanHandsOffDays ?? DEFAULT_HUMAN_HANDS_OFF_DAYS, timezone, now);
      const link = await linkLineFor(clientId, row.contact_id).then((l) => (l ? `\n${l}` : "")).catch(() => "");
      const say = (text: string) => sendMessage("iris", { channel: CALL_LOG_CHANNEL, text: `${text}${link}` }).catch(() => {});
      switch (outcome.action) {
        case "not_interested":
          await updateOpportunityStage(row.opportunity_id, notInterestedId, ghl.locationId, ghl.apiKey);
          await createContactNote(row.contact_id, `Iris: moved to ${settings.notInterestedStage} — the lead opted out.`, ghl.locationId, ghl.apiKey).catch(() => {});
          await finishMember(row, "moved_not_interested", outcome.reason);
          await say(`🚫 *${row.contact_name}* opted out, so I moved them to *${settings.notInterestedStage}*.`);
          break;
        case "not_ready":
          await updateOpportunityStage(row.opportunity_id, notReadyId, ghl.locationId, ghl.apiKey);
          await createContactNote(row.contact_id, `Iris: moved to ${settings.notReadyStage} — followed up this week by calls and a text with no answer.`, ghl.locationId, ghl.apiKey).catch(() => {});
          await query(`UPDATE iris_pending_calls SET status = 'skipped', resolution_reason = 'follow-up week ended with no answer', resolved_at = now() WHERE client_id = $1 AND contact_id = $2 AND status = 'pending'`, [clientId, row.contact_id]);
          await finishMember(row, "moved_not_ready", outcome.reason);
          await say(`💤 *${row.contact_name}* never answered a call or text this week, so I moved them to *${settings.notReadyStage}*.`);
          break;
        case "engaged":
          await finishMember(row, "engaged", outcome.reason);
          await say(`✅ *${row.contact_name}* responded (${outcome.reason}), so I'm leaving their card where it is.`);
          break;
        case "dropped":
          await finishMember(row, "dropped", outcome.reason);
          await say(`🤝 Dropping *${row.contact_name}* from the weekend follow-up: ${outcome.reason}. I'm not touching their card.`);
          break;
        case "next_round":
          toQueue.push(row);
          break;
      }
    } catch (error) {
      console.error(`[IRS-COHORT] ${row.contact_name}:`, error instanceof Error ? error.message : error);
    }
  }

  // The next round for everyone due now goes out one after another (a sweep never rings two at once).
  if (toQueue.length > 0) {
    const startAt = clampToLegalCallingWindow(new Date(now.getTime() + 60_000), timezone);
    const queued = await queueColdLeadSweep(clientId, toQueue.map((r) => r.contact_id), startAt);
    for (const r of toQueue) await query(`UPDATE iris_followup_cohort SET rounds_done = rounds_done + 1 WHERE id = $1`, [r.id]);
    await sendMessage("iris", {
      channel: CALL_LOG_CHANNEL,
      text: `🔁 Weekend follow-up, next round: calling ${queued.map((q) => `*${q.name}*`).join(", ")} one at a time from ${formatLocal(startAt.toISOString(), timezone)}.`,
    }).catch(() => {});
  }
}

async function evaluate(clientId: string, row: CohortRow, ghl: { locationId: string; apiKey: string }, handsOffDays: number, timezone: string, now: Date): Promise<CohortAction> {
  const raw = await getContact(row.contact_id, ghl.locationId, ghl.apiKey);
  const contact = raw?.contact ?? raw;
  const tags: string[] = (contact?.tags ?? []).map((t: string) => String(t).toLowerCase());
  const optedOut = tags.includes("do not call") || contact?.dnd === true;

  const opps = await listOpportunitiesForContact(row.contact_id, ghl.locationId, ghl.apiKey);
  const card = opps.find((o) => o.id === row.opportunity_id);
  const cardStillThere = Boolean(card && card.pipelineStageId === row.stage_id);

  const touch = await checkHumanTouch(row.contact_id, ghl.locationId, ghl.apiKey, 365, now);
  if (touch.status === "unknown") return { action: "wait" };
  const teammateTouchedSince = touch.status === "human" && Date.parse(touch.at) > new Date(row.started_at).getTime();

  const appointments = await getContactAppointments(row.contact_id, ghl.locationId, ghl.apiKey).catch(() => []);
  const appointmentAhead = readAppointments(appointments, now, timezone).upcoming !== null;

  let replied = false;
  try {
    const convo = await getConversations(row.contact_id, ghl.locationId, ghl.apiKey);
    const id = convo?.conversations?.[0]?.id;
    if (id) {
      const msgs: any[] = (await getConversationMessages(id, ghl.locationId, ghl.apiKey, 50))?.messages?.messages ?? [];
      replied = msgs.some((m) => m?.messageType === "TYPE_SMS" && m?.direction === "inbound" && Date.parse(m.dateAdded) > new Date(row.started_at).getTime());
    }
  } catch {
    return { action: "wait" };
  }

  const calls = await query<{ ended_reason: string | null; transcript: string | null }>(
    `SELECT ended_reason, transcript FROM iris_call_log WHERE client_id = $1 AND contact_id = $2 AND created_at > $3`,
    [clientId, row.contact_id, row.started_at]
  );
  const answeredCall = calls.some(callAnswered);

  const busy = await query<{ one: number }>(
    `SELECT 1 AS one FROM iris_pending_calls WHERE client_id = $1 AND contact_id = $2 AND (status = 'pending' AND call_after < now() + interval '1 day' OR status = 'placed' AND resolved_at > now() - interval '30 minutes') LIMIT 1`,
    [clientId, row.contact_id]
  );

  return decideCohortMember({
    now,
    deadline: new Date(row.deadline_at),
    rounds: (row.rounds ?? []).map((d) => new Date(d)),
    roundsDone: row.rounds_done,
    optedOut,
    cardStillThere,
    teammateTouchedSince,
    replied,
    answeredCall,
    appointmentAhead,
    irisBusy: busy.length > 0,
  });
}
