/**
 * THROWAWAY test script — places a call using Iris's REAL lead-qualification
 * prompt (buildLeadQualificationPrompt), not the bare connectivity-test
 * prompt scripts/test-iris-call.ts uses. Built for live demo calls at
 * Mark's request; delete after use.
 *
 * Omits transferNumber by default so the transferCall tool isn't wired in —
 * this is a synthetic lead with no real GHL contact behind it, so a live
 * transfer must never ring a real agent's phone without explicit opt-in.
 * Pass --with-transfer to wire it in deliberately (resolved from the
 * client's own real config, same as a production call would). Also omits
 * contactId, which means schedule_callback won't be wired either (calling.ts
 * requires a real contactId for that tool) — there's no real contact for a
 * callback note to land on.
 *
 *   npx tsx scripts/test-iris-real-script.ts +15555551234 [clientId] [name] [--with-transfer]
 *
 * `name` defaults to "Jacob" — a real name, not the "there"/unknown
 * sentinel, so the opening greeting demos the actual known-name path
 * ("am I speaking with Jacob?") rather than the unknown-name fallback
 * ("who do I have the pleasure of speaking with?"). Jacob's live feedback,
 * 2026-09-04: a real lead's name is already known from GHL at intake, so
 * the unknown-name branch should be the rare exception, not what a test
 * call demos by default.
 */
import "dotenv/config";
import { loadIrisConfig, loadClientBranding } from "../agents/iris";
import { buildLeadQualificationPrompt } from "../agents/iris/scripts";
import { placeCall, CallingDisabledError } from "../agents/iris/calling";
import { transferNumberForIntent } from "../agents/iris/qualification";
import { NormalisedLead } from "../agents/scout/intake";

const SYNTHETIC_LEAD: NormalisedLead = {
  contactId: "synthetic-test-lead",
  name: "Jacob",
  email: null,
  phone: "",
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
  intent: "buyer",
  score: 0,
  scoreReasons: [],
};

async function main() {
  const phone = process.argv[2];
  const clientId = process.argv[3] || "3-percent-east-coast";
  const nameArg = process.argv[4] && !process.argv[4].startsWith("--") ? process.argv[4] : "Jacob";
  const withTransfer = process.argv.includes("--with-transfer");
  if (!phone) {
    console.error("Usage: npx tsx scripts/test-iris-real-script.ts <phone> [clientId] [name] [--with-transfer]");
    process.exit(1);
  }

  const lead: NormalisedLead = { ...SYNTHETIC_LEAD, name: nameArg };

  const config = loadIrisConfig(clientId);
  const branding = loadClientBranding(clientId);
  if (!config || !branding) {
    console.error(`No iris config or branding for "${clientId}"`);
    process.exit(1);
  }

  const transferNumber = withTransfer ? transferNumberForIntent(config, lead.intent) ?? undefined : undefined;
  if (withTransfer && !transferNumber) {
    console.error(`--with-transfer given but no real transfer number resolved for intent "${lead.intent}" on "${clientId}".`);
    process.exit(1);
  }

  const systemPrompt = buildLeadQualificationPrompt(
    config,
    lead,
    branding.brandName,
    branding.city,
    Boolean(process.env.VAPI_SERVER_URL),
    Boolean(transferNumber),
    false
  );

  console.log(
    `[IRIS] About to place a REAL, BILLABLE demo call to ${phone} as "${nameArg}" using the ACTUAL qualification script ` +
      `(synthetic buyer lead${transferNumber ? `, transferCall WIRED to ${transferNumber}` : ", no transfer wired"}).`
  );

  try {
    const result = await placeCall({
      clientId,
      brandName: branding.brandName,
      city: branding.city,
      phone,
      firstName: nameArg,
      intent: lead.intent,
      leadSource: null,
      systemPrompt,
      transferNumber,
      triggeredBy: "manual",
    });
    console.log(`[IRIS] Call placed. Vapi call id: ${result.id}`);
    process.exit(0);
  } catch (error) {
    if (error instanceof CallingDisabledError) {
      console.error(`[IRIS] ${error.message}`);
    } else {
      console.error("[IRIS] Failed to place call:", error);
    }
    process.exit(1);
  }
}

main();
