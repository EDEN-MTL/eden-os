/**
 * Reply polling — how Ember (and Iris, for leads Ember handed her) sees an
 * inbound text without a GHL workflow. The /webhooks/ghl/message route only
 * fires if a human built a workflow in the GHL UI that POSTs replies to it
 * (gotcha 4 in CLAUDE.md), and as of 2026-09-24 that's unconfirmed for both
 * accounts — 3% has a "zReply Automation" workflow whose steps can't be
 * read over the API. Polling needs nothing on the GHL side.
 *
 * Reads the same way Iris's pre-dial recheck does (lastInboundText: full
 * thread, newest inbound SMS). Only the LATEST inbound is routed per pass —
 * two texts in a row between polls are answered as one, with the newest
 * winning, same known limitation as text-signals.ts.
 *
 * Every routed reply sets last_inbound_seen_at, and the webhook path sets
 * it too, so the same message is never answered twice when both are live.
 */
import { getGhlConfig } from "../../shared/ghl";
import { lastInboundText } from "../iris/text-signals";
import { irisHandleInboundSms } from "../iris/sms";
import { listReplyWatch, updateLead } from "./store";
import { emberHandleInboundMessage } from "./webhooks";
import { NurtureLead } from "./types";

export interface ReplyPollDeps {
  lastInboundText(contactId: string): Promise<{ text: string; dateAdded: string | null } | null>;
  irisHandleInboundSms(contactId: string, text: string, options?: { receivedAt?: Date }): Promise<boolean>;
  emberHandleInboundMessage(contactId: string, text: string, receivedAt?: Date): Promise<boolean>;
}

export interface ReplyPollReport {
  checked: number;
  routedToEmber: number;
  routedToIris: number;
}

const inFlight = new Set<string>();

/** Newest time a reply must be later than to count as new. */
function baseline(lead: NurtureLead): number {
  const seen = lead.lastInboundSeenAt ? new Date(lead.lastInboundSeenAt).getTime() : 0;
  const touched = lead.lastTouchAt ? new Date(lead.lastTouchAt).getTime() : 0;
  // A reply from BEFORE Ember's first text is an old conversation from the
  // lead's original inquiry, not an answer to Ember — never route it.
  return Math.max(seen, touched);
}

export async function pollRepliesForClient(clientId: string, deps?: ReplyPollDeps): Promise<ReplyPollReport> {
  const report: ReplyPollReport = { checked: 0, routedToEmber: 0, routedToIris: 0 };
  if (inFlight.has(clientId)) return report;
  inFlight.add(clientId);
  try {
    let d = deps;
    if (!d) {
      const ghl = await getGhlConfig(clientId);
      if (!ghl) throw new Error(`No GHL credentials configured for client "${clientId}"`);
      d = {
        lastInboundText: (contactId) => lastInboundText(contactId, ghl.locationId, ghl.apiKey),
        irisHandleInboundSms,
        emberHandleInboundMessage,
      };
    }

    for (const lead of await listReplyWatch(clientId)) {
      report.checked++;
      const inbound = await d.lastInboundText(lead.ghlContactId);
      if (!inbound?.dateAdded) continue;
      const at = new Date(inbound.dateAdded);
      if (Number.isNaN(at.getTime()) || at.getTime() <= baseline(lead)) continue;

      // Mark first: if routing throws halfway, a re-answer next pass would
      // be worse than one reply left for a human to see in GHL.
      await updateLead(lead.id, { lastInboundSeenAt: at.toISOString() });
      if (lead.status === "handed_off") {
        await d.irisHandleInboundSms(lead.ghlContactId, inbound.text, { receivedAt: at });
        report.routedToIris++;
      } else {
        await d.emberHandleInboundMessage(lead.ghlContactId, inbound.text, at);
        report.routedToEmber++;
      }
    }
    return report;
  } finally {
    inFlight.delete(clientId);
  }
}
