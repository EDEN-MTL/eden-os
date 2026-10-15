import { getGhlConfig } from "../../shared/ghl";

/**
 * Direct links in Iris's Slack updates. Mark, 2026-10-14: when Iris reports
 * something, "send us a direct link to Vapi if it's call related, and if it's text
 * related the GHL contact link, so we can check the exact call and text
 * conversation that happened."
 */

/** The GHL contact page — call history, texts and notes in one timeline. */
export function ghlContactUrl(locationId: string, contactId: string): string {
  return `https://app.gohighlevel.com/v2/location/${locationId}/contacts/detail/${contactId}`;
}

/**
 * The Vapi page for one call. The dashboard's address format isn't documented, so
 * it is a per-client setting (iris.links.vapiCallUrl, with {callId}) copied from a
 * real call's link; with no setting the Vapi link is simply left out.
 */
export function vapiCallUrl(callId: string | null | undefined, template: string | null | undefined): string | null {
  if (!callId || !template || !template.includes("{callId}")) return null;
  return template.replace("{callId}", callId);
}

const slackLink = (url: string, label: string): string => `<${url}|${label}>`;

export interface LinkParts {
  vapiUrl?: string | null;
  ghlUrl?: string | null;
}

/** "🔗 Vapi call · GHL contact" — only the parts that exist; "" when neither does. */
export function formatLinkLine(parts: LinkParts): string {
  const links = [parts.vapiUrl ? slackLink(parts.vapiUrl, "Vapi call") : null, parts.ghlUrl ? slackLink(parts.ghlUrl, "GHL contact") : null].filter(Boolean);
  return links.length > 0 ? `🔗 ${links.join(" · ")}` : "";
}

/**
 * The link line for one lead: the GHL contact always (when it can be built), plus
 * the Vapi call when a callId and the client's Vapi link template are given. Takes
 * the template as an argument (callers that have a client's iris config pass
 * config.vapiCallUrlTemplate) so this file stays free of the agent module and its
 * import cycle. Never throws — a missing link must not stop the update posting.
 */
export async function linkLineFor(
  clientId: string,
  contactId: string | null | undefined,
  callId?: string | null,
  vapiTemplate?: string | null
): Promise<string> {
  try {
    const ghl = contactId ? await getGhlConfig(clientId).catch(() => null) : null;
    return formatLinkLine({
      vapiUrl: vapiCallUrl(callId, vapiTemplate),
      ghlUrl: ghl && contactId ? ghlContactUrl(ghl.locationId, contactId) : null,
    });
  } catch {
    return "";
  }
}
