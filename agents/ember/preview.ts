/**
 * Shows exactly what Ember's FIRST text to each would-be lead would say —
 * or why it would skip them — without sending or writing anything. Same
 * decision path as sendTouch (DND, opt-out in history, history review,
 * script vs personal opener), so what a human approves here is what
 * actually goes out. Mark, 2026-09-23: "we need to check everything first."
 *
 * Costs one small Claude call per lead that has real conversation history.
 */
import { getContact, getGhlConfig } from "../../shared/ghl";
import { EmberConfig } from "./config";
import { findOptOut, readConversationHistory, reviewHistory } from "./history";
import { buildMessage, pickChannel, STOP_LINE, LiveContact } from "./outreach";
import { ScanReport } from "./scan";
import { NurtureLead } from "./types";

export interface FirstTouchPreview {
  name: string | null;
  stage: string;
  intent: string;
  outcome: "send" | "skip" | "retry";
  source?: "script" | "personalized";
  channel?: string;
  message?: string;
  reason: string;
  inboundMessages: number;
}

export async function previewFirstTouches(
  clientId: string,
  config: EmberConfig,
  eligible: ScanReport["eligible"],
  now: Date = new Date()
): Promise<FirstTouchPreview[]> {
  const ghl = await getGhlConfig(clientId);
  if (!ghl) throw new Error(`No GHL credentials configured for client "${clientId}"`);
  const out: FirstTouchPreview[] = [];

  for (const e of eligible) {
    const base = { name: e.name, stage: e.stage, intent: e.intent };
    const payload = await getContact(e.contactId, ghl.locationId, ghl.apiKey);
    const c = payload?.contact ?? payload ?? {};
    const contact: LiveContact = { firstName: c.firstName ?? null, phone: c.phone ?? null, email: c.email ?? null, dnd: c.dnd, dndSettings: c.dndSettings };
    const lead = {
      id: 0, clientId, ghlContactId: e.contactId, ghlOpportunityId: e.opportunityId, contactName: e.name,
      intent: e.intent, touchCount: 0, unsubscribeToken: "preview", inquiryAt: e.inquiryAt,
    } as unknown as NurtureLead;

    const channel = pickChannel(contact, config);
    if (!channel) {
      out.push({ ...base, outcome: "skip", reason: "DND in GHL or no reachable channel", inboundMessages: 0 });
      continue;
    }
    const history = await readConversationHistory(e.contactId, ghl.locationId, ghl.apiKey);
    const inboundMessages = history.filter((m) => m.direction === "inbound").length;
    const optOut = findOptOut(history);
    if (optOut) {
      out.push({ ...base, outcome: "skip", reason: `opted out in history: "${optOut.slice(0, 80)}"`, inboundMessages });
      continue;
    }
    const decision = await reviewHistory(history, {
      firstName: contact.firstName?.trim() || e.name?.split(/\s+/)[0] || "there",
      brandName: config.outreach.senderName,
      intent: e.intent,
      stopLine: STOP_LINE,
      now,
    });
    if (decision.action === "skip" || decision.action === "retry") {
      out.push({ ...base, outcome: decision.action, reason: decision.reason, inboundMessages });
      continue;
    }
    const message =
      decision.action === "personalized" && channel === "sms"
        ? decision.message
        : buildMessage(lead, contact, channel, 0, config).body;
    out.push({ ...base, outcome: "send", source: decision.action === "personalized" && channel === "sms" ? "personalized" : "script", channel, message, reason: decision.reason, inboundMessages });
  }
  return out;
}
