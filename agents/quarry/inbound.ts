/**
 * Reads GHL's inbound-message webhook payload.
 *
 * UNVERIFIED against a live payload — this repo has never received a real
 * one. The field names checked below are GHL's documented conversation-
 * webhook shape, but CLAUDE.md's own rule applies here as much as anywhere
 * else: verify against live data before trusting it. The webhook route logs
 * the full raw body on every hit specifically so the first real reply gives
 * us ground truth immediately — if a field name below turns out wrong, fix it
 * here, not in the route, and nowhere else needs to change.
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
  const channel: InboundChannel = rawType.includes("EMAIL") ? "email" : rawType.includes("SMS") ? "sms" : "unknown";

  const rawDirection = String(body?.direction ?? body?.message?.direction ?? "").toLowerCase();
  // Defaults to false (skip) rather than true. Processing an OUTBOUND echo of
  // our own message as if it were a reply would classify a lead's sentiment
  // off the pitch we just sent them, not what they actually said back — the
  // unreadable case must be the safe one.
  const isInbound = rawDirection === "inbound";

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
