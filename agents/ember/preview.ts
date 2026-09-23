/**
 * Shows exactly what Ember's FIRST text to each would-be lead would say —
 * or why it would skip, pause or park them — without sending or writing
 * anything. Runs the same planTouch the send path uses (opt-outs, consent,
 * soft-decline cool-off, history + CRM review), so what a human approves
 * here is what actually goes out. Mark, 2026-09-23: "we need to check
 * everything first."
 *
 * Costs one small Claude call per lead that has real history to read.
 */
import { getContact, getGhlConfig, getOpportunity } from "../../shared/ghl";
import { EmberConfig } from "./config";
import { readLeadContext } from "./context";
import { readConversationHistory, reviewHistory } from "./history";
import { buildMessage, LiveContact, pickChannel, planTouch } from "./outreach";
import { ScanReport } from "./scan";
import { NurtureLead } from "./types";

export interface FirstTouchPreview {
  name: string | null;
  stage: string;
  intent: string;
  outcome: "send" | "opt_out" | "defer" | "no_consent" | "retry" | "unreachable";
  source?: "script" | "personalized";
  channel?: string;
  message?: string;
  deferUntil?: string;
  reason: string;
  inboundMessages: number;
}

export async function previewFirstTouches(
  clientId: string,
  config: EmberConfig,
  eligible: ScanReport["eligible"],
  stageNames: Record<string, string>,
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
      intent: e.intent, touchCount: 0, unsubscribeToken: "preview", inquiryAt: e.inquiryAt, enrolledStageName: e.stage,
    } as unknown as NurtureLead;

    const channel = pickChannel(contact, config);
    if (!channel) {
      out.push({ ...base, outcome: "unreachable", reason: "DND in GHL or no reachable channel", inboundMessages: 0 });
      continue;
    }
    const history = await readConversationHistory(e.contactId, ghl.locationId, ghl.apiKey);
    const opp = await getOpportunity(e.opportunityId, ghl.locationId, ghl.apiKey);
    const context = await readLeadContext(lead, { ...opp, contact: { tags: c.tags ?? [] } }, stageNames, ghl, now);
    const plan = await planTouch({ lead, contact, history, context, config, now, review: (m, ctx) => reviewHistory(m, ctx) });
    const inboundMessages = history.filter((m) => m.direction === "inbound").length;

    if (plan.kind !== "send") {
      out.push({ ...base, outcome: plan.kind, reason: plan.reason, inboundMessages, ...(plan.kind === "defer" ? { deferUntil: plan.until.toISOString().slice(0, 10) } : {}) });
      continue;
    }
    const personal = Boolean(plan.body) && channel === "sms";
    out.push({
      ...base,
      outcome: "send",
      source: personal ? "personalized" : "script",
      channel,
      message: personal ? plan.body : buildMessage(lead, contact, channel, 0, config).body,
      reason: plan.reason,
      inboundMessages,
    });
  }
  return out;
}
