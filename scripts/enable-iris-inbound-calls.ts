/**
 * Points Iris's Vapi phone number at our own webhook so an INBOUND call
 * (someone calling that number back) gets answered by Iris instead of
 * failing outright. Confirmed live, 2026-09-29: this number had no
 * assistantId and no server.url at all — a callback just failed with
 * nothing logged anywhere. Vapi's own docs: with no assistantId, a phone
 * number POSTs "assistant-request" to its server.url and needs a real
 * JSON response within ~7.5s (agents/iris/inbound.ts, wired into
 * webhooks/vapi-webhook.ts's existing router — the same URL Vapi already
 * posts end-of-call-report to).
 *
 * This is a one-time (or re-run-after-changing-VAPI_SERVER_URL) config
 * change on VAPI'S side, not a code deploy — run by hand:
 *
 *   npx tsx scripts/enable-iris-inbound-calls.ts
 *
 * Requires VAPI_SERVER_URL to be set to this server's real public URL
 * (Render), not localhost — Vapi has to reach it.
 */
import "dotenv/config";
import { getVapiEnvConfig } from "../shared/vapi";

async function main() {
  const config = getVapiEnvConfig();
  if (!config.serverUrl) {
    throw new Error("VAPI_SERVER_URL is not set — Vapi needs a real public URL to reach for inbound calls.");
  }

  // VAPI_SERVER_URL is already the full webhook path (confirmed against
  // calling.ts's own use of it, unmodified, for both server.url and the
  // per-tool server URLs) — NOT a bare origin. Fixed 2026-09-29 after this
  // script's first run appended /webhooks/vapi on top of that and pointed
  // the live phone number at a doubled, wrong URL
  // (.../webhooks/vapi/webhooks/vapi).
  const url = config.serverUrl;
  const resp = await fetch(`https://api.vapi.ai/phone-number/${config.phoneNumberId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ server: { url, secret: config.webhookSecret } }),
  });

  if (!resp.ok) {
    throw new Error(`Vapi PATCH /phone-number/${config.phoneNumberId} failed: ${resp.status} ${await resp.text()}`);
  }

  console.log(`[IRIS] Phone number ${config.phoneNumberId} now sends inbound assistant-request calls to ${url}.`);
  process.exit(0);
}

main().catch((error) => {
  console.error("[IRIS] Failed to enable inbound calls:", error);
  process.exit(1);
});
