/**
 * Live half of returning-lead detection (the rules are in history.ts): fetch
 * what GHL actually knows about a lead at intake, classify it, and — when
 * the lead already belongs to someone — tell their agent instead of letting
 * Iris line up a call. Mark's spec, 2026-10-04.
 *
 * Takes ScoutConfig as a parameter rather than importing loadScoutConfig:
 * agents/scout/index.ts owns that and imports this file, so importing back
 * would be circular.
 */
import { query } from "../../shared/db";
import { sendMessage } from "../../shared/slack";
import {
  addContactTags,
  createContactNote,
  createContactTask,
  getContact,
  getContactAppointments,
  getCustomFieldDefs,
  getGhlConfig,
  listContactsPaginated,
  listLocationUsers,
  listOpportunitiesForContact,
  listPipelines,
  removeContactTags,
  updateContact,
} from "../../shared/ghl";
import { buildKeyToId, NormalisedLead, readField, ScoutConfig } from "./intake";
import { classifyLeadHistory, HistoryConfig, HistoryContact, HistoryReason, HistorySubject, LeadHistory } from "./history";

const DEFAULT_RETURNING_TAG = "returning lead";
const DEFAULT_ALERT_CHANNEL = "iris-call-logs";
const DEFAULT_MIN_AGE_MINUTES = 60;
/** Same-person records to inspect when a client's GHL doesn't dedupe — more than a few means something else is going on. */
const MAX_DUPLICATES = 3;
const DEDUPE_WINDOW_HOURS = 24;

export function historyConfigFor(config: ScoutConfig): HistoryConfig {
  return {
    touchedTags: config.touchedTags || [],
    historyStageIds: config.historyStageIds && config.historyStageIds.length > 0 ? config.historyStageIds : config.touchedStageIds || [],
    returningMinAgeMinutes: config.returningMinAgeMinutes ?? DEFAULT_MIN_AGE_MINUTES,
  };
}

function digits(phone: unknown): string {
  return String(phone ?? "").replace(/\D/g, "").slice(-10);
}

function readFirst(customFields: unknown, ref: string | string[] | undefined, keyToId: Map<string, string>): string | null {
  if (!ref) return null;
  for (const key of Array.isArray(ref) ? ref : [ref]) {
    const value = readField(customFields, key, keyToId);
    if (value !== null) return value;
  }
  return null;
}

async function subjectFor(
  contact: any,
  locationId: string,
  apiKey: string,
  config: ScoutConfig,
  keyToId: Map<string, string>
): Promise<HistorySubject> {
  const [opportunities, appointments] = await Promise.all([
    listOpportunitiesForContact(contact.id, locationId, apiKey),
    // Supplementary — many real bookings never reach GHL's own calendar
    // (see listCalendarEvents), so a failed lookup shouldn't block the rest.
    getContactAppointments(contact.id, locationId, apiKey).catch((error) => {
      console.error(`[SCT] appointments lookup failed for ${contact.id}:`, error instanceof Error ? error.message : error);
      return [] as any[];
    }),
  ]);

  const historyContact: HistoryContact = {
    id: contact.id,
    dateAdded: contact.dateAdded ?? null,
    assignedTo: contact.assignedTo ?? null,
    tags: Array.isArray(contact.tags) ? contact.tags : [],
    isaNotes: readFirst(contact.customFields, config.fields?.isaNotes, keyToId),
  };
  return {
    contact: historyContact,
    opportunities: opportunities.map((o: any) => ({ id: o.id, createdAt: o.createdAt, pipelineStageId: o.pipelineStageId, assignedTo: o.assignedTo ?? null })),
    appointmentCount: appointments.length,
  };
}

export interface AssessedHistory {
  history: LeadHistory;
  /** Who the lead's OWN contact record is assigned to right now — what the GHL workflow's "Assigned User" will resolve to. */
  contactAssignedTo: string | null;
}

/**
 * Null on any failure fetching the lead itself — the caller must treat that
 * as "can't tell" and fail CLOSED (don't queue a call): a real person phoned
 * by a bot who already has an agent is worse than a new lead waiting for a
 * human to retrigger it.
 */
export async function assessLeadHistory(contactId: string, clientId: string, config: ScoutConfig, now: Date = new Date()): Promise<AssessedHistory | null> {
  try {
    const ghlConfig = await getGhlConfig(clientId);
    if (!ghlConfig) return null;
    const { locationId, apiKey } = ghlConfig;

    const contactResp = await getContact(contactId, locationId, apiKey);
    const contact = contactResp?.contact ?? contactResp;
    const defs = await getCustomFieldDefs(locationId, apiKey);
    const keyToId = buildKeyToId(defs);

    const self = await subjectFor({ ...contact, id: contactId }, locationId, apiKey, config, keyToId);

    // Same person under a DIFFERENT contact id — only matters when a
    // client's GHL doesn't dedupe on phone/email. listContactsPaginated is
    // the lookup that works (shared/ghl's searchContacts 400s).
    const duplicates: HistorySubject[] = [];
    const phone = digits(contact.phone);
    const email = String(contact.email || "").trim().toLowerCase();
    const needle = phone.length >= 10 ? phone : email;
    if (needle) {
      for await (const other of listContactsPaginated(locationId, { limit: 10, query: needle, apiKey })) {
        if (other.id === contactId) continue;
        const samePhone = phone.length >= 10 && digits(other.phone) === phone;
        const sameEmail = !!email && String(other.email || "").trim().toLowerCase() === email;
        if (!samePhone && !sameEmail) continue;
        // The list endpoint never returns customFields (CLAUDE.md gotcha 2).
        const full = await getContact(other.id, locationId, apiKey);
        duplicates.push(await subjectFor({ ...(full?.contact ?? full), id: other.id }, locationId, apiKey, config, keyToId));
        if (duplicates.length >= MAX_DUPLICATES) break;
      }
    }

    return {
      history: classifyLeadHistory({ self, duplicates, now }, historyConfigFor(config)),
      contactAssignedTo: contact.assignedTo ?? null,
    };
  } catch (error) {
    console.error(`[SCT] assessLeadHistory failed for ${contactId}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

export function describeReasons(reasons: HistoryReason[], stageNames: Map<string, string>, userNames: Map<string, string>): string[] {
  const out: string[] = [];
  for (const r of reasons) {
    if (r.kind === "assigned") out.push(`assigned to ${userNames.get(r.userId) ?? "an agent"}`);
    else if (r.kind === "worked_stage") out.push(`an earlier card in "${stageNames.get(r.stageId) ?? "a worked stage"}"`);
    else if (r.kind === "touch_tag") out.push(`tagged "${r.tag}"`);
    else if (r.kind === "human_notes") out.push("has ISA notes from an agent");
    else if (r.kind === "appointment") out.push(`${r.count} appointment${r.count === 1 ? "" : "s"} on record`);
  }
  return [...new Set(out)];
}

/**
 * Posts as Scout; if Scout's bot isn't in the channel, falls back to Iris
 * (which is) rather than losing the alert — a returning lead's agent
 * follow-up is time-sensitive, and Scout's token has chat:write but not
 * chat:write.public, so it can only post where it's been invited. Confirmed
 * live 2026-10-05: Scout got not_in_channel on #iris-call-logs.
 */
async function postAlert(config: ScoutConfig, text: string): Promise<void> {
  const channel = config.returningLeadSlackChannel || DEFAULT_ALERT_CHANNEL;
  try {
    await sendMessage("scout", { channel, text });
  } catch (error) {
    console.warn(`[SCT] Scout couldn't post to #${channel} (${error instanceof Error ? error.message : error}) — falling back to Iris. Invite Scout to that channel.`);
    await sendMessage("iris", { channel, text: `${text}\n_(posted via Iris — Scout isn't in this channel yet)_` });
  }
}

/** Fail-closed notice — see assessLeadHistory. A human can retrigger the lead once the cause (usually a GHL API blip) is gone. */
export async function warnHistoryUnverified(lead: NormalisedLead, config: ScoutConfig): Promise<void> {
  await postAlert(
    config,
    `⚠️ Couldn't check ${lead.name || lead.contactId}'s history at intake (GHL didn't respond cleanly), so I did NOT queue an Iris call. ` +
      `Check whether they already belong to an agent before retriggering.`
  ).catch((error) => console.error("[SCT] Failed to post history-unverified warning:", error instanceof Error ? error.message : error));
}

/**
 * Tells the lead's agent they came back, and records why Iris isn't
 * calling. Never throws — every step is best-effort and independent, so one
 * failing (say Slack) doesn't skip the agent's text.
 *
 * The agent text itself is sent by the client's own GHL workflow
 * (trigger: tag `returningLeadTag` added -> Internal Notification SMS to the
 * assigned user): GHL's API can only text a contact, never a staff user, and
 * workflows can't be created over the API (CLAUDE.md gotcha 4).
 */
export async function notifyReturningLead(
  clientId: string,
  lead: NormalisedLead,
  assessed: AssessedHistory,
  config: ScoutConfig
): Promise<void> {
  const { history, contactAssignedTo } = assessed;

  // A replayed or doubled GHL webhook must not text the agent twice.
  try {
    const inserted = await query<{ id: string }>(
      `INSERT INTO returning_lead_alerts (client_id, contact_id, assigned_user_id, reasons)
       SELECT $1, $2, $3, $4
       WHERE NOT EXISTS (
         SELECT 1 FROM returning_lead_alerts
         WHERE client_id = $1 AND contact_id = $2 AND created_at > now() - ($5 || ' hours')::interval
       )
       RETURNING id`,
      [clientId, lead.contactId, history.assignedUserId, JSON.stringify(history.reasons), String(DEDUPE_WINDOW_HOURS)]
    );
    if (inserted.length === 0) {
      console.log(`[SCT] Returning-lead alert for ${lead.contactId} already sent in the last ${DEDUPE_WINDOW_HOURS}h — skipping.`);
      return;
    }
  } catch (error) {
    console.error("[SCT] Could not record/de-duplicate the returning-lead alert:", error instanceof Error ? error.message : error);
    return;
  }

  const ghlConfig = await getGhlConfig(clientId).catch(() => null);
  const userNames = new Map<string, string>();
  const stageNames = new Map<string, string>();
  if (ghlConfig) {
    try {
      for (const u of await listLocationUsers(ghlConfig.locationId, ghlConfig.apiKey)) userNames.set(u.id, u.name);
      for (const p of await listPipelines(ghlConfig.locationId, ghlConfig.apiKey)) for (const s of p.stages ?? []) stageNames.set(s.id, s.name);
    } catch (error) {
      console.error("[SCT] Could not resolve agent/stage names for the returning-lead alert:", error instanceof Error ? error.message : error);
    }
  }

  const reasonText = describeReasons(history.reasons, stageNames, userNames);
  const agentName = history.assignedUserId ? userNames.get(history.assignedUserId) ?? "their assigned agent" : null;
  const tag = config.returningLeadTag || DEFAULT_RETURNING_TAG;
  const firstSeen = history.firstSeen ? new Date(history.firstSeen).toISOString().slice(0, 10) : null;

  if (ghlConfig && history.assignedUserId) {
    const { locationId, apiKey } = ghlConfig;

    // The workflow texts the contact's ASSIGNED user — make sure the lead's
    // own record carries the owner (it won't when the history sat on a
    // duplicate contact, or only on an opportunity).
    if (contactAssignedTo !== history.assignedUserId) {
      await updateContact(lead.contactId, { assignedTo: history.assignedUserId }, locationId, apiKey).catch((error) =>
        console.error(`[SCT] Could not assign ${lead.contactId} to ${history.assignedUserId}:`, error instanceof Error ? error.message : error)
      );
    }

    // Remove-then-add: a "tag added" trigger never fires for a tag the
    // contact already carries, and a lead can return more than once.
    await removeContactTags(lead.contactId, [tag], locationId, apiKey).catch(() => undefined);
    await addContactTags(lead.contactId, [tag], locationId, apiKey).catch((error) =>
      console.error(`[SCT] Could not tag ${lead.contactId} "${tag}":`, error instanceof Error ? error.message : error)
    );

    await createContactTask(
      lead.contactId,
      {
        title: `Returning lead — reach out: ${lead.name || "lead"}`,
        body: `${lead.name || "This lead"} just came back in through the funnel and is already yours. ${reasonText.length ? `History: ${reasonText.join("; ")}.` : ""}`,
        dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        assignedTo: history.assignedUserId,
      },
      locationId,
      apiKey
    ).catch((error) => console.error(`[SCT] Could not create the returning-lead task for ${lead.contactId}:`, error instanceof Error ? error.message : error));
  }

  // A plain Note, deliberately NOT the isa_notes custom field — 3% has that
  // field wired to automations (Justin Denney's Oct 2 edit coincided with
  // the live-transfer workflow re-firing on him).
  if (ghlConfig) {
    await createContactNote(
      lead.contactId,
      `Scout: returning lead — came back through the funnel${firstSeen ? ` (first in the system ${firstSeen})` : ""}. ${reasonText.length ? `History: ${reasonText.join("; ")}. ` : ""}Iris was NOT queued to call.`,
      ghlConfig.locationId,
      ghlConfig.apiKey
    ).catch((error) => console.error(`[SCT] Could not write the returning-lead note for ${lead.contactId}:`, error instanceof Error ? error.message : error));
  }

  await postAlert(
    config,
    `🔁 *Returning lead:* ${lead.name || lead.contactId}${lead.phone ? ` (${lead.phone})` : ""}${firstSeen ? ` — first came in ${firstSeen}` : ""}\n` +
      `History: ${reasonText.join("; ") || "on record"}\n` +
      (agentName
        ? `Assigned to *${agentName}* — tagged \`${tag}\` so their GHL text goes out. Iris will NOT call.`
        : `⚠️ No assigned agent on record — a human needs to decide who follows up. Iris will NOT call.`)
  ).catch((error) => console.error("[SCT] Failed to post the returning-lead alert to Slack:", error instanceof Error ? error.message : error));
}
