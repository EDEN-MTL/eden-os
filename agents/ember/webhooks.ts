/**
 * Ember's side of the GHL webhooks in webhooks/ghl-webhook.ts — the fast
 * path for reactivation. Each one only acts on a contact/opportunity Ember
 * is already tracking, and only for a client with ember.enabled on.
 *
 * These fire only if a human built the matching workflow in the GHL UI
 * (gotcha 4 in CLAUDE.md). The hourly scan catches stage moves and tags
 * either way; the one thing ONLY a webhook can catch is a reply, since the
 * scan never reads conversations.
 *
 * UNVERIFIED against live payloads — the tag and stage events have never
 * been received by this repo, and the fields read here are the ones the
 * existing handlers already log. The routes log raw bodies on every hit.
 */
import { loadEmberConfig, loadEmberOutcomeStages } from "./config";
import { markExited, markReactivated, REACTIVATABLE, slackAlert } from "./alerts";
import { resolveStageNames } from "./deps";
import { handleReply } from "./outreach";
import { detectChange } from "./scan";
import { getLeadByOpportunityId, listOpenLeadsByContactId } from "./store";
import { NurtureLead } from "./types";
import { readFileSync } from "fs";
import { join } from "path";

function clientName(clientId: string): string {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), "config", "clients", `${clientId}.json`), "utf-8"))?.clientName || clientId;
  } catch {
    return clientId;
  }
}

function enabledConfig(lead: NurtureLead) {
  const config = loadEmberConfig(lead.clientId);
  return config?.enabled ? config : null;
}

/** An inbound SMS/email from a contact. Returns true if Ember handled it. */
export async function emberHandleInboundMessage(contactId: string, text: string): Promise<boolean> {
  const leads = await listOpenLeadsByContactId(contactId);
  let handled = false;
  for (const lead of leads) {
    const config = enabledConfig(lead);
    if (!config) continue;
    const sentiment = await handleReply(lead, text, {
      config,
      clientName: clientName(lead.clientId),
      alert: slackAlert(config.alertChannel),
    });
    console.log(`[EMB] reply from ${lead.contactName ?? lead.ghlContactId}: ${sentiment}`);
    handled = true;
  }
  return handled;
}

/** A contact's tags changed. Reactivates on a configured renewed-interest tag. */
export async function emberHandleTagUpdate(contactId: string, tags: string[]): Promise<void> {
  const leads = await listOpenLeadsByContactId(contactId);
  for (const lead of leads) {
    if (!REACTIVATABLE.includes(lead.status)) continue;
    const config = enabledConfig(lead);
    if (!config) continue;
    const tag = tags.find((t) => config.renewedInterestTags.some((r) => r.trim().toLowerCase() === t.trim().toLowerCase()));
    if (!tag) continue;
    await markReactivated(lead, `tagged "${tag}"`, {
      clientName: clientName(lead.clientId),
      alert: slackAlert(config.alertChannel),
    });
  }
}

/** An opportunity changed stage. */
export async function emberHandleStageUpdate(opportunityId: string, stageId: string, status?: string): Promise<void> {
  const lead = await getLeadByOpportunityId(opportunityId);
  if (!lead || !REACTIVATABLE.includes(lead.status)) return;
  const config = enabledConfig(lead);
  if (!config) return;

  const stageNames = await resolveStageNames(lead.clientId, config.pipelineId);
  const change = detectChange(
    lead,
    {
      id: opportunityId,
      status: status ?? "open",
      pipelineId: config.pipelineId,
      pipelineStageId: stageId,
      contactId: lead.ghlContactId,
      // Deliberately null: GHL can fire this event for the SAME stage (a
      // re-save, a duplicate delivery), and a "now" timestamp would read as
      // "moved out and back" and alert on nothing. Only a real stage
      // difference counts here; the scan still catches out-and-back moves
      // from GHL's own lastStageChangeAt.
      lastStageChangeAt: null,
      createdAt: null,
      updatedAt: null,
      contact: null,
    },
    { config, outcomeStages: loadEmberOutcomeStages(lead.clientId), stageNames }
  );
  if (change.kind === "exited") await markExited(lead, change.reason);
  else if (change.kind === "reactivated") {
    await markReactivated(lead, change.reason, {
      clientName: clientName(lead.clientId),
      alert: slackAlert(config.alertChannel),
    });
  }
}
