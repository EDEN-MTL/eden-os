/**
 * Answers a real inbound call to Iris's own number — the other end of
 * Vapi's "assistant-request" webhook (webhooks/vapi-webhook.ts), fired
 * when a phone number has no assistantId directly attached. Vapi needs a
 * JSON response within ~7.5s, so everything here is a handful of fast
 * lookups — no LLM call of our own, no network round trip that isn't
 * already necessary.
 *
 * Mark's ask, 2026-09-29, was originally "notify us when someone tries to
 * call back." Investigation turned that into something else: 3% Realty's
 * GHL location has no separate tracked office line at all — the only
 * number on file is the SAME one Iris calls OUT from via Vapi (confirmed
 * live against both GHL's phone-system API and Vapi's own
 * GET /phone-number/{id}). So a GHL workflow trigger would never see these
 * calls, and the real fix is answering them directly: look the caller up,
 * verify who they are, and run the exact same qualification an outbound
 * call gets — via buildInboundAssistantConfig (calling.ts), reusing all of
 * its tool wiring rather than a second, parallel implementation.
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { query } from "../../shared/db";
import { getVapiEnvConfig, VapiAssistantConfig } from "../../shared/vapi";
import { getContact, getCustomFieldDefs, getGhlConfig, searchContacts } from "../../shared/ghl";
import { buildKeyToId, normaliseLead, NormalisedLead, ScoutConfig } from "../scout/intake";
import { loadScoutConfig } from "../scout";
import { isCallingEnabled } from "./calling-settings";
import { loadClientBranding, loadIrisConfig } from "./index";
import { buildInboundAssistantConfig, PlaceCallParams } from "./calling";
import { buildLeadQualificationPrompt, extractFirstName } from "./scripts";
import { callbackCalendarForIntent, transferNumberForIntent } from "./qualification";

export interface VapiAssistantRequestResponse {
  assistant?: VapiAssistantConfig;
  error?: string;
}

/**
 * Resolves which client owns an inbound Vapi phone number by scanning every
 * client config for iris.inboundPhoneNumberId — same file-scan pattern as
 * agents/scout/index.ts's own clientIdForLocation. Vapi/Iris is effectively
 * single-tenant today (one global VAPI_PHONE_NUMBER_ID), but this stays
 * config-driven rather than hardcoded so a second client's own number is a
 * config change, not a code change.
 */
export function clientIdForVapiPhoneNumber(phoneNumberId: string): string | null {
  const dir = join(process.cwd(), "config", "clients");
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const raw = JSON.parse(readFileSync(join(dir, file), "utf-8"));
      if (raw?.iris?.inboundPhoneNumberId === phoneNumberId) return raw.clientId;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** An all-null cold lead — the exact "cold first contact" branch buildLeadQualificationPrompt already has for a fresh outbound lead with no known data. */
function blankLeadFor(phone: string): NormalisedLead {
  return {
    contactId: "",
    name: null,
    email: null,
    phone,
    propertyInterest: null,
    bedrooms: null,
    workingWithRealtor: null,
    budget: null,
    timeline: null,
    preApproved: null,
    financing: null,
    sources: { financing: null, timeline: null, budget: null },
    leadSource: null,
    attribution: { fbclid: null, utmSource: null, utmCampaign: null, metaCampaignId: null, metaAdsetId: null, metaAdId: null },
    attributed: false,
    qualified: false,
    firstTouch: true,
    intent: "unknown",
    score: 0,
    scoreReasons: [],
  };
}

/**
 * Looks the caller up by phone number. contactId is returned separately
 * from the NormalisedLead (whose own contactId is always a non-null string
 * by type) so an unmatched caller's placeholder lead is never mistaken for
 * a real GHL contact to write back to — PlaceCallParams.contactId (and the
 * update_lead_name/save_isa_notes tools it wires) only gets set when this
 * is a real match.
 */
async function lookUpCallerAsLead(
  clientId: string,
  callerNumber: string,
  scoutConfig: ScoutConfig
): Promise<{ lead: NormalisedLead; contactId: string | null }> {
  try {
    const ghlConfig = await getGhlConfig(clientId);
    if (ghlConfig) {
      const searchResult = await searchContacts(callerNumber, ghlConfig.locationId, ghlConfig.apiKey);
      const found = searchResult?.contacts?.[0];
      if (found?.id) {
        const contactResp = await getContact(found.id, ghlConfig.locationId, ghlConfig.apiKey);
        const contact = contactResp?.contact ?? contactResp;
        const defs = await getCustomFieldDefs(ghlConfig.locationId, ghlConfig.apiKey);
        const keyToId = buildKeyToId(defs);
        return { lead: normaliseLead(contact, scoutConfig, keyToId), contactId: found.id };
      }
    }
  } catch (error) {
    console.error(`[IRIS] Inbound caller lookup failed for ${clientId}, answering as an unknown caller:`, error instanceof Error ? error.message : error);
  }
  return { lead: blankLeadFor(callerNumber), contactId: null };
}

export async function handleInboundCall(message: Record<string, any>): Promise<VapiAssistantRequestResponse> {
  const callerNumber: string | undefined = message?.call?.customer?.number;
  const phoneNumberId: string | undefined = message?.call?.phoneNumberId;
  const vapiCallId: string | undefined = message?.call?.id;

  if (!callerNumber || !phoneNumberId || !vapiCallId) {
    console.warn("[IRIS] assistant-request missing customer.number/phoneNumberId/call.id — cannot answer.");
    return { error: "Sorry, something went wrong on our end. Please try again shortly." };
  }

  try {
    const clientId = clientIdForVapiPhoneNumber(phoneNumberId);
    if (!clientId) {
      console.warn(`[IRIS] No client configured for inbound Vapi phoneNumberId ${phoneNumberId}.`);
      return { error: "Sorry, we're not able to take your call right now. Please try again shortly." };
    }

    const config = loadIrisConfig(clientId);
    const branding = loadClientBranding(clientId);
    const scoutConfig = loadScoutConfig(clientId);
    if (!config || !branding || !scoutConfig) {
      console.warn(`[IRIS] Missing iris/branding/scout config for ${clientId} — cannot answer inbound call.`);
      return { error: "Sorry, we're not able to take your call right now. Please try again shortly." };
    }

    if (!(await isCallingEnabled(clientId))) {
      return { error: `Thanks for calling ${branding.brandName} — we can't take your call right now. Please try again shortly.` };
    }

    const { lead, contactId } = await lookUpCallerAsLead(clientId, callerNumber, scoutConfig);

    const transferNumber = transferNumberForIntent(config, lead.intent) ?? undefined;
    const calendarId = callbackCalendarForIntent(config, lead.intent) ?? undefined;
    const vapiConfig = getVapiEnvConfig();

    const params: PlaceCallParams = {
      clientId,
      brandName: branding.brandName,
      city: branding.city,
      phone: callerNumber,
      firstName: extractFirstName(lead.name),
      intent: lead.intent,
      leadSource: lead.leadSource,
      budget: lead.budget,
      timeline: lead.timeline,
      propertyInterest: lead.propertyInterest,
      bedrooms: lead.bedrooms,
      financing: lead.financing,
      workingWithRealtor: lead.workingWithRealtor,
      contactId: contactId ?? undefined,
      transferNumber,
      calendarId,
      origin: "inbound",
      systemPrompt: buildLeadQualificationPrompt(
        config,
        lead,
        branding.brandName,
        branding.city,
        Boolean(vapiConfig.serverUrl),
        Boolean(transferNumber),
        Boolean(calendarId),
        "inbound"
      ),
    };

    const assistant = buildInboundAssistantConfig(params, vapiConfig);

    // Best-effort, and deliberately BEFORE responding: this is what makes
    // the existing end-of-call-report pipeline (Slack post, GHL status
    // note, recording attachment — webhooks/vapi-webhook.ts) pick this call
    // up with zero changes there — it's a generic UPDATE ... WHERE
    // vapi_call_id = $1 keyed off a row it expects to already exist, same
    // as placeCall() inserts for an outbound call. triggered_by 'inbound'
    // (neither 'manual' nor 'automatic') also already, correctly, keeps
    // this from touching any unrelated outbound cadence for the same
    // contact — that check only fires for 'automatic'.
    await query(
      `INSERT INTO iris_call_log (client_id, vapi_call_id, contact_id, phone, status, triggered_by)
       VALUES ($1, $2, $3, $4, 'initiated', 'inbound')`,
      [clientId, vapiCallId, contactId, callerNumber]
    ).catch((error) => {
      console.error("[IRIS] Failed to insert iris_call_log row for inbound call:", error instanceof Error ? error.message : error);
    });

    return { assistant };
  } catch (error) {
    console.error("[IRIS] Failed to handle inbound call:", error instanceof Error ? error.message : error);
    return { error: "Sorry, something went wrong on our end. Please try again shortly." };
  }
}
