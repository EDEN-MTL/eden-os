import { readFileSync } from "fs";
import { join } from "path";
import { BaseAgent } from "../base-agent";
import { eventBus } from "../../shared/events";
import { buildKeyToId, normaliseLead, NormalisedLead, ScoutConfig } from "./intake";
import { getContact, getCustomFieldDefs, getGhlConfig } from "../../shared/ghl";

class ScoutAgent extends BaseAgent {
  constructor() {
    super("scout", "Scout", "SCT");
  }

  getSystemPrompt(): string {
    return `You are Scout, EDEN's Lead Capture and Enrichment agent.

Active client: 3 Percent East Coast — a 3% Realty brokerage in St. John's, Newfoundland, Canada (CAD).

## How leads actually arrive here
Leads come in through the lead form (the "LF" fields) and sometimes a survey or
Facebook Lead Form. There is no single "new" stage — a lead lands directly in
Buyer Leads, Seller Leads, Downsize Leads or Upgrading Leads according to type.

Qualification is NOT a pipeline stage. The ISA qualifies and either books or
live-transfers on the same call, so a lead counts as qualified when it carries
the "appt booked" or "live transferred" tag.

## What you score on
Pre-approval is the signal the team genuinely uses — the ISA pre-screens on it.
GHL's built-in "Engagement Score" was configured but never switched on, and the
lead_score and urgency_flag fields are not connected to anything. Do not refer
to them as if they were live.

## Attribution
Nine attribution fields exist on the contact record (fbclid, utm_*,
meta_campaign/adset/ad_id). They are only populated once the landing page and
the Meta ad set URL parameters are passing them through. Until that is wired
up, most leads will have no ad attribution — say so plainly rather than
implying the ad data is there.

Be concise and specific. Cite real field names and stage names.`;
  }
}

export const scoutAgent = new ScoutAgent();

/** Per-client intake config, read from config/clients/{clientId}.json. */
function loadScoutConfig(clientId: string): ScoutConfig | null {
  try {
    const raw = JSON.parse(
      readFileSync(join(process.cwd(), "config", "clients", `${clientId}.json`), "utf-8")
    );
    return raw?.scout?.fields ? (raw.scout as ScoutConfig) : null;
  } catch {
    return null;
  }
}

/**
 * Resolves which client a GHL webhook belongs to by matching locationId,
 * rather than assuming a single client — this location is one of several.
 */
function clientIdForLocation(locationId: string): string | null {
  const dir = join(process.cwd(), "config", "clients");
  try {
    for (const file of require("fs").readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const raw = JSON.parse(readFileSync(join(dir, file), "utf-8"));
      if (raw?.ghl?.locationId === locationId) return raw.clientId;
    }
  } catch { /* fall through */ }
  return null;
}

export function processLead(payload: any, clientId: string): NormalisedLead | null {
  const config = loadScoutConfig(clientId);
  if (!config) {
    console.log(`[SCT] No scout config for ${clientId} — lead captured but not enriched.`);
    return null;
  }
  return normaliseLead(payload, config);
}

// ─── Event Subscriptions ───

/**
 * A new lead arrived.
 *
 * Fired by a GHL workflow when the form applies the "buyer lead" / "seller
 * lead" tag at creation. Emits lead.enriched carrying firstTouch, which is
 * the flag Iris opens contact on.
 */
eventBus.subscribe("lead.captured", async (event) => {
  const clientId = clientIdForLocation(event.clientId) || event.clientId;
  const data = { ...event.data };

  // Confirmed live, 2026-09-06: GHL's workflow "Webhook" action has no real
  // way to relay a contact's actual tags — its merge-tag picker offers only
  // a same-named CUSTOM FIELD ("Contact tag"), never the real tags array, no
  // matter what key/value pair a human adds to the action. So data.tags from
  // the webhook itself can never be trusted for intent detection (this is
  // exactly what silently sent "buyer lead"-tagged leads through as intent
  // "unknown"). Fetching the contact directly gets GHL's real, current tags
  // instead — best-effort: falls back to whatever the webhook sent rather
  // than blocking intake entirely on a GHL API hiccup.
  try {
    const ghlConfig = await getGhlConfig(clientId);
    if (ghlConfig && data.contactId) {
      const contactResp = await getContact(data.contactId, ghlConfig.locationId, ghlConfig.apiKey);
      const contact = contactResp?.contact ?? contactResp;
      if (Array.isArray(contact?.tags)) data.tags = contact.tags;
    }
  } catch (error) {
    console.warn(
      `[SCT] Could not fetch live tags for ${data.contactId}, using webhook tags as-is:`,
      error instanceof Error ? error.message : error
    );
  }

  const lead = processLead(data, clientId);
  if (!lead) return;
  logLead(lead, "intake");
  eventBus.publish("lead.enriched", "scout", clientId, lead as unknown as Record<string, any>);
});

/**
 * Re-score a lead after it has been worked.
 *
 * Called directly by Iris once it has written its notes and moved the card —
 * NOT wired to a GHL webhook. Iris is our own code, so it can say when it is
 * finished rather than us guessing at a delay and racing its writes. The
 * equivalent for calls we do not control (the human ISA) still needs a
 * delayed GHL trigger, since nothing tells us when that person is done.
 *
 * The resulting lead.enriched carries firstTouch: false, because the tags Iris
 * just applied mark the lead as touched. That is what stops a re-score from
 * being read as "call this person".
 */
export function rescoreAfterContact(payload: any, clientId: string): NormalisedLead | null {
  const lead = processLead(payload, clientId);
  if (!lead) return null;
  logLead(lead, "re-score");

  if (lead.firstTouch) {
    // Iris has just spoken to them, so a touch tag should exist. If it does
    // not, the tags were not written — surface it rather than emitting an
    // event that would read as "nobody has contacted this lead".
    console.warn(
      `[SCT] ${lead.contactId} re-scored after contact but carries no touch tag. ` +
      `Iris may not have written its tags yet; not emitting, to avoid a duplicate call.`
    );
    return lead;
  }

  eventBus.publish("lead.enriched", "scout", clientId, lead as unknown as Record<string, any>);
  return lead;
}

/**
 * Fresh, live re-derivation of a lead — NOT from the webhook payload Scout
 * saw at intake (which goes stale the moment the human ISA touches the
 * lead, or Iris herself does), but from a real-time GET against GHL. This
 * exists for Iris's delayed-dial path: cadence.ts's whole reason for taking
 * a fresh check as an input rather than caching it is that the human ISA
 * might reach a lead in the minutes between lead.enriched firing and Iris
 * actually dialing — and dial-pending.ts's explicit-callback path needs the
 * same freshness for `qualified`, since scheduling that dial only checked
 * firstTouch which the callback note itself will have since flipped false.
 *
 * Returns null (never throws) when the client isn't configured for this or
 * the GHL call fails — callers should treat null the same as "already
 * touched"/"already qualified": isFirstTouch's own doc comment is explicit
 * that failing closed is correct here ("the cost of wrongly calling one is
 * a real person phoned twice by a bot").
 *
 * contact.pipelineStageId is not populated by a plain contact GET (stage
 * lives on the Opportunity, not the Contact) — isFirstTouch degrades
 * correctly when stageId is absent, falling back to tags + ISA notes, which
 * its own comment already documents as sufficient on their own.
 */
export async function refreshLead(contactId: string, clientId: string): Promise<NormalisedLead | null> {
  try {
    const config = loadScoutConfig(clientId);
    const ghlConfig = await getGhlConfig(clientId);
    if (!config || !ghlConfig) return null;

    const contactResp = await getContact(contactId, ghlConfig.locationId, ghlConfig.apiKey);
    const contact = contactResp?.contact ?? contactResp;
    const defs = await getCustomFieldDefs(ghlConfig.locationId, ghlConfig.apiKey);
    const keyToId = buildKeyToId(defs);

    return normaliseLead(contact, config, keyToId);
  } catch (error) {
    console.error(`[SCT] refreshLead failed for ${contactId}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/** Thin wrapper over refreshLead for callers that only care about firstTouch — see refreshLead's doc comment. */
export async function recheckFirstTouch(contactId: string, clientId: string): Promise<boolean | null> {
  const lead = await refreshLead(contactId, clientId);
  return lead ? lead.firstTouch : null;
}

function logLead(lead: NormalisedLead, phase: string) {
  console.log(
    `[SCT] ${phase} · ${lead.name || lead.contactId} · ${lead.intent} · score ${lead.score}` +
    ` · ${lead.firstTouch ? "FIRST TOUCH" : "already worked"}` +
    ` · ${lead.qualified ? "qualified" : "unqualified"}` +
    ` · ${lead.attributed ? `ad ${lead.attribution.metaAdId}` : "no ad attribution"}`
  );
  console.log(`[SCT]   ${lead.scoreReasons.join(", ") || "no scoring signals present"}`);
}
