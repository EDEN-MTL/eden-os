/**
 * Reads GHL's inbound-message webhook payload.
 *
 * CONFIRMED against a real live payload, 2026-09-25/26 (webhook_debug_log,
 * 3-percent-east-coast's actual "zReply Automation" workflow — see
 * shared/db/schema.sql's own comment on that table). Real shape is very
 * different from what was originally guessed here: a flat dump of the
 * contact's own custom fields (keyed by their GHL LABELS, e.g. "LF
 * Proprety", "What is your Budget for the New Home?") alongside a real
 * `message: { body, type }` (type is a NUMBER, not "SMS"/"Email"), a
 * `workflow: { id, name }`, and `contact_id` — but crucially NO `direction`
 * field anywhere. `contactId`/`text` parsing already worked against this
 * shape (message.body / contact_id both resolve); only `channel` (a string
 * type check) and `isInbound` (required an explicit "inbound" direction
 * that this shape never has) were silently failing, so every real reply
 * was being skipped.
 */

export type InboundChannel = "sms" | "email" | "unknown";

export interface ParsedInboundMessage {
  contactId: string | null;
  text: string | null;
  channel: InboundChannel;
  /** False for anything not confidently identified as inbound. */
  isInbound: boolean;
}

export function parseInboundMessage(body: any): ParsedInboundMessage {
  const contactId = body?.contactId ?? body?.contact_id ?? null;
  const text = body?.message?.body ?? body?.body ?? (typeof body?.message === "string" ? body.message : null) ?? null;

  const rawType = String(body?.message?.type ?? body?.type ?? "").toUpperCase();
  let channel: InboundChannel = rawType.includes("EMAIL") ? "email" : rawType.includes("SMS") ? "sms" : "unknown";

  // The real "Customer Replied" workflow payload sends message.type as a raw
  // NUMBER, never a string — confirmed against a real captured payload
  // (type: 2 on every genuine SMS reply seen) and GHL's own documented
  // messageType enum: 2 = SMS, 3 = Email.
  if (channel === "unknown" && typeof body?.message?.type === "number") {
    if (body.message.type === 2) channel = "sms";
    else if (body.message.type === 3) channel = "email";
  }

  const rawDirection = String(body?.direction ?? body?.message?.direction ?? "").toLowerCase();
  // This real workflow-triggered shape has no direction field at all — but
  // GHL's "Customer Replied SMS"/"Customer Replied EMAIL" trigger only ever
  // fires on a genuine inbound reply in the first place, so recognizing
  // this specific shape (workflow metadata + contact_id + a real message
  // body, all present together — never true for a hand-built test payload,
  // an outbound echo, or any other shape this function handles) makes it
  // inbound by construction, no direction field needed. Every OTHER shape
  // still requires an explicit "inbound" value — defaulting to false
  // (skip) stays the safe choice there: processing an OUTBOUND echo of our
  // own message as if it were a reply would classify a lead's sentiment
  // off the pitch we just sent them, not what they actually said back.
  const isWorkflowReplyShape = typeof body?.message?.body === "string" && !!body?.contact_id && !!body?.workflow;
  const isInbound = rawDirection === "inbound" || (rawDirection === "" && isWorkflowReplyShape);

  return { contactId, text: text ? String(text) : null, channel, isInbound };
}

/**
 * Reads GHL's inbound-appointment webhook payload — a human-built workflow
 * POSTing a booked appointment's contact id here. Same customData-wrapper
 * gotcha as the contact webhook (a workflow's Webhook action always nests
 * custom key/value fields under customData) — checked first, falling back
 * to a flat body for anything else that posts here directly.
 */
export function parseAppointmentContactId(body: any): string | null {
  const data = body?.customData ?? body;
  return data?.contactId ?? data?.contact_id ?? null;
}
