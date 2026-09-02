/**
 * Flips the iris_calling_enabled kill switch ON for a client. This is the
 * ONLY way that flag ever becomes true — there is no automatic path. Run by
 * hand:
 *
 *   npx tsx scripts/enable-iris-calling.ts [clientId]
 *
 * clientId defaults to "3-percent-east-coast". Placing a call costs real
 * per-minute money the moment Vapi answers — confirm the rate with Jacob
 * (see CLAUDE.md's Money section) before running this for anything other
 * than a number you personally control.
 */
import "dotenv/config";
import { setCallingEnabled } from "../agents/iris/calling-settings";

async function main() {
  const clientId = process.argv[2] || "3-percent-east-coast";
  await setCallingEnabled(true, clientId);
  console.log(`[IRIS] Calling ENABLED for client "${clientId}". Run scripts/disable-iris-calling.ts to turn it back off.`);
  process.exit(0);
}

main().catch((error) => {
  console.error("[IRIS] Failed to enable calling:", error);
  process.exit(1);
});
