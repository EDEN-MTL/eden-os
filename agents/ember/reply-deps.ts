/**
 * Builds the live context Ember needs to answer one reply — shared by the
 * GHL webhook and the 2-minute reply poll so both answer the same way.
 */
import { chatWithTools } from "../../shared/claude";
import { appendHistory, loadHistory } from "../../shared/conversation-memory";
import { getCustomFieldDefs, getGhlConfig, getLocationTimezone, sendSMS, updateContact } from "../../shared/ghl";
import { refreshLead } from "../scout";
import { buildKeyToId } from "../scout/intake";
import { loadClientBranding, loadIrisConfig } from "../iris";
import { humanReplyDelayMs } from "../iris/sms";
import { slackAlert } from "./alerts";
import { EmberConfig } from "./config";
import { ConversationContext, ConversationDeps, EMBER_AGENT_ID, emberConverse } from "./conversation";
import { buildMoveStage } from "./deps";
import { displayName } from "./outreach";
import { classifyLeadStatus } from "./status";
import { lastEmberTouchText, updateLead, upsertIrisHandoff } from "./store";
import { NurtureLead } from "./types";

const realWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function buildReplyContext(
  lead: NurtureLead,
  config: EmberConfig,
  options: { receivedAt?: Date; clientName: string; wait?: (ms: number) => Promise<void> }
) {
  const receivedAt = options.receivedAt ?? new Date();
  const wait = options.wait ?? realWait;
  const ghl = await getGhlConfig(lead.clientId);
  if (!ghl) throw new Error(`No GHL credentials configured for client "${lead.clientId}"`);
  const alert = slackAlert(config.alertChannel);
  const fresh = await refreshLead(lead.ghlContactId, lead.clientId).catch(() => null);
  const rawFirst = fresh?.name?.trim().split(/\s+/)[0] || lead.contactName?.trim().split(/\s+/)[0] || "";
  const firstName = rawFirst ? displayName(rawFirst) : "there";
  const humanPause = (reply: string) => wait(humanReplyDelayMs(receivedAt, reply));
  const send = (text: string) => sendSMS(lead.ghlContactId, text, ghl.locationId, ghl.apiKey, config.outreach.sms.fromNumber);

  const irisConfig = loadIrisConfig(lead.clientId);
  const branding = loadClientBranding(lead.clientId);
  let converse: ((l: NurtureLead, text: string) => Promise<string | null>) | undefined;
  if (irisConfig && branding) {
    const timezone =
      (await getLocationTimezone(ghl.locationId, ghl.apiKey).catch(() => null)) || irisConfig.timezone || config.timezone;
    const convCtx: ConversationContext = {
      config,
      irisConfig,
      brandName: branding.brandName,
      city: branding.city,
      timezone,
      firstName,
      opener: await lastEmberTouchText(lead.clientId, lead.ghlContactId).catch(() => null),
      known: {
        propertyInterest: fresh?.propertyInterest,
        bedrooms: fresh?.bedrooms,
        timeline: fresh?.timeline,
        budget: fresh?.budget,
        financing: fresh?.financing,
      },
    };
    const deps: ConversationDeps = {
      chat: chatWithTools,
      loadHistory: (key) => loadHistory(EMBER_AGENT_ID, key),
      appendHistory: (key, role, content) => appendHistory(EMBER_AGENT_ID, key, role, content),
      sendSMS: send,
      pauseLikeAHuman: humanPause,
      saveNotes: async (contactId, notes) => {
        try {
          const defs = await getCustomFieldDefs(ghl.locationId, ghl.apiKey);
          const fieldId = buildKeyToId(defs).get(irisConfig.callbackNotesFieldKey);
          if (!fieldId) return false;
          await updateContact(contactId, { customFields: [{ id: fieldId, value: notes }] }, ghl.locationId, ghl.apiKey);
          return true;
        } catch {
          return false;
        }
      },
      queueIrisCall: async (l, answers, when) => {
        const leadForIris = fresh
          ? { ...fresh, intent: answers.intent !== "unknown" ? answers.intent : fresh.intent }
          : { contactId: l.ghlContactId, name: l.contactName, phone: l.phone, intent: answers.intent };
        await upsertIrisHandoff(l.clientId, l.ghlContactId, leadForIris, when, true);
      },
      updateLead: (id, patch) => updateLead(id, patch as any),
      alert,
    };
    converse = (l, text) => emberConverse(l, text, convCtx, deps);
  }

  return {
    config,
    clientName: options.clientName,
    alert,
    firstName,
    classifyStatus: classifyLeadStatus,
    moveStage: buildMoveStage(lead.clientId, config.pipelineId),
    sendCourtesy: async (text: string) => {
      await humanPause(text);
      await send(text);
    },
    converse,
  };
}
