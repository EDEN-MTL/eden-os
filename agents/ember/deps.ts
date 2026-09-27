/**
 * Builds the live GHL calls Ember's send path needs, resolved once per run
 * against a client's actual credentials — same role as agents/quarry/deps.ts.
 */
import { getContact, getGhlConfig, getOpportunity, listPipelines, sendEmail, sendSMS } from "../../shared/ghl";
import { EmberConfig } from "./config";
import { slackAlert } from "./alerts";
import { OutreachDeps } from "./outreach";
import { readConversationHistory, reviewHistory } from "./history";
import { readLeadContext } from "./context";

export class GhlNotConfiguredError extends Error {
  constructor(clientId: string) {
    super(`No GHL credentials configured for client "${clientId}"`);
    this.name = "GhlNotConfiguredError";
  }
}

export async function buildOutreachDeps(clientId: string, config: EmberConfig): Promise<OutreachDeps> {
  const ghl = await getGhlConfig(clientId);
  if (!ghl) throw new GhlNotConfiguredError(clientId);
  const { locationId, apiKey } = ghl;

  return {
    loadLive: async (lead) => {
      let opp: any;
      try {
        opp = await getOpportunity(lead.ghlOpportunityId, locationId, apiKey);
      } catch (error) {
        // A deleted card is a 404 — that's "gone", not a transient failure
        // worth retrying every half hour forever. Anything else rethrows so
        // the touch is logged as failed and retried next run.
        if (error instanceof Error && /GHL API Error (400|404)/.test(error.message)) return null;
        throw error;
      }
      if (!opp?.id) return null;
      const payload = await getContact(lead.ghlContactId, locationId, apiKey);
      const c = payload?.contact ?? payload ?? {};
      return {
        contact: {
          firstName: c.firstName ?? null,
          phone: c.phone ?? null,
          email: c.email ?? null,
          dnd: c.dnd,
          dndSettings: c.dndSettings,
        },
        opportunity: {
          id: opp.id,
          status: opp.status,
          pipelineId: opp.pipelineId,
          pipelineStageId: opp.pipelineStageId,
          contactId: opp.contactId,
          lastStageChangeAt: opp.lastStageChangeAt ?? null,
          createdAt: opp.createdAt ?? null,
          updatedAt: opp.updatedAt ?? null,
          // Tags come from the full contact read, so a renewed-interest tag
          // added since the last scan is caught at send time too.
          contact: { name: c.contactName ?? null, phone: c.phone, email: c.email, tags: c.tags ?? [] },
        },
      };
    },
    sendSMS: (contactId, message) => sendSMS(contactId, message, locationId, apiKey),
    sendEmail: (contactId, subject, html, fromEmail) =>
      sendEmail(contactId, { subject, html, fromEmail }, locationId, apiKey),
    alert: slackAlert(config.alertChannel),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    readHistory: (lead) => readConversationHistory(lead.ghlContactId, locationId, apiKey),
    reviewHistory: (messages, ctx) => reviewHistory(messages, ctx),
    readContext: async (lead, opportunity) =>
      readLeadContext(lead, opportunity, await resolveStageNames(lead.clientId, config.pipelineId), { locationId, apiKey }),
  };
}

/** Stage id → name for the configured pipeline (gotcha 5: cards carry ids). */
export async function resolveStageNames(clientId: string, pipelineId: string): Promise<Record<string, string>> {
  const ghl = await getGhlConfig(clientId);
  if (!ghl) throw new GhlNotConfiguredError(clientId);
  const names: Record<string, string> = {};
  for (const p of await listPipelines(ghl.locationId, ghl.apiKey)) {
    if (p.id !== pipelineId) continue;
    for (const s of p.stages || []) names[s.id] = s.name;
  }
  return names;
}
