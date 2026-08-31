/**
 * Places ONE real Vapi call to a number you provide, to verify the pipeline
 * end to end (Vapi answers, the webhook fires, iris_call_log gets updated)
 * BEFORE any lead ever gets called. This is the only place in the codebase
 * that dials a number — run it against your own phone first.
 *
 *   npx tsx scripts/test-iris-call.ts +15555551234 [clientId]
 *
 * Requires:
 *   - scripts/enable-iris-calling.ts already run for this clientId (calling
 *     is disabled by default — see agents/iris/calling-settings.ts).
 *   - VAPI_API_KEY, VAPI_PHONE_NUMBER_ID, VAPI_MODEL_*, VAPI_VOICE_* set in
 *     .env — see .env.example for what each one means.
 *   - Jacob's cost sign-off for Vapi's per-minute rate (CLAUDE.md's Money
 *     section) — this places a real, billable call the moment it runs.
 *
 * Uses a deliberately minimal test prompt, NOT Iris's real lead-qualification
 * script — this verifies the Vapi plumbing works, not that Iris's actual
 * call behavior is good. That's separate follow-up work.
 */
import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";
import { placeCall, CallingDisabledError } from "../agents/iris/calling";

const TEST_SYSTEM_PROMPT = `You are running a short connectivity test for the EDEN OS / Vapi phone
integration, not a real lead qualification call. Say hello, confirm the person can hear you clearly,
explain in one sentence that this is just a test of the calling pipeline, then ask if they have any
questions before ending the call politely. Keep the whole call under a minute.`;

function loadClientConfig(clientId: string): { clientName: string; city: string } {
  const raw = JSON.parse(readFileSync(join(process.cwd(), "config", "clients", `${clientId}.json`), "utf-8"));
  return {
    clientName: raw.clientName,
    city: raw.market?.city,
  };
}

async function main() {
  const phone = process.argv[2];
  const clientId = process.argv[3] || "3-percent-east-coast";

  if (!phone) {
    console.error("Usage: npx tsx scripts/test-iris-call.ts <phone-number-e.g.+15555551234> [clientId]");
    process.exit(1);
  }

  const { clientName, city } = loadClientConfig(clientId);

  console.log(`[IRIS] About to place a REAL, BILLABLE test call to ${phone} as "${clientName}" (${clientId}).`);
  console.log(`[IRIS] Confirm Jacob has signed off on Vapi's per-minute cost before this runs in anything but a one-off manual test.`);

  try {
    const result = await placeCall({
      clientId,
      brandName: clientName,
      city,
      phone,
      firstName: "there",
      intent: "unknown",
      leadSource: null,
      systemPrompt: TEST_SYSTEM_PROMPT,
      triggeredBy: "manual",
    });
    console.log(`[IRIS] Call placed. Vapi call id: ${result.id}. Watch iris_call_log for the end-of-call-report update.`);
    process.exit(0);
  } catch (error) {
    if (error instanceof CallingDisabledError) {
      console.error(`[IRIS] ${error.message}`);
    } else {
      console.error("[IRIS] Failed to place test call:", error);
    }
    process.exit(1);
  }
}

main();
