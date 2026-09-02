/**
 * Flips the iris_calling_enabled kill switch back OFF for a client — the
 * quick way to stop any further calls without touching code or env vars.
 *
 *   npx tsx scripts/disable-iris-calling.ts [clientId]
 *
 * clientId defaults to "3-percent-east-coast".
 */
import "dotenv/config";
import { setCallingEnabled } from "../agents/iris/calling-settings";

async function main() {
  const clientId = process.argv[2] || "3-percent-east-coast";
  await setCallingEnabled(false, clientId);
  console.log(`[IRIS] Calling DISABLED for client "${clientId}".`);
  process.exit(0);
}

main().catch((error) => {
  console.error("[IRIS] Failed to disable calling:", error);
  process.exit(1);
});
