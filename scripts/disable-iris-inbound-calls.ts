/**
 * Undoes scripts/enable-iris-inbound-calls.ts — clears the Vapi phone
 * number's server.url so an inbound call to that number stops reaching
 * Iris and goes back to just failing outright (the pre-feature state,
 * confirmed live 2026-09-29 before this was ever turned on). Doesn't touch
 * any code — this is a live Vapi config change, run by hand:
 *
 *   npx tsx scripts/disable-iris-inbound-calls.ts
 */
import "dotenv/config";
import { getVapiEnvConfig } from "../shared/vapi";

async function main() {
  const config = getVapiEnvConfig();

  // { server: null } — confirmed live, 2026-09-29: this clears the field
  // entirely (GET afterward shows no `server` key at all, the exact
  // pre-feature state). { server: { url: "" } } was NOT tried live against
  // this endpoint and risks the same "must be a valid URL" rejection
  // shared/vapi/index.ts's own serverUrl comment already documents for the
  // assistant-level field — null is the confirmed-working way to clear it.
  const resp = await fetch(`https://api.vapi.ai/phone-number/${config.phoneNumberId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ server: null }),
  });

  if (!resp.ok) {
    throw new Error(`Vapi PATCH /phone-number/${config.phoneNumberId} failed: ${resp.status} ${await resp.text()}`);
  }

  console.log(`[IRIS] Phone number ${config.phoneNumberId} no longer forwards inbound calls anywhere — back to failing outright.`);
  process.exit(0);
}

main().catch((error) => {
  console.error("[IRIS] Failed to disable inbound calls:", error);
  process.exit(1);
});
