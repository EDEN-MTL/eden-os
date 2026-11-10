/**
 * Runs the lead review (agents/iris/lead-review.ts) against live GHL and prints it. Read-only: it posts nothing.
 *   npx tsx scripts/lead-review.ts [clientId] [max]
 */
import "dotenv/config";
import { formatFindings, reviewClient } from "../agents/iris/lead-review";
(async () => {
  const [clientId = "3-percent-east-coast", max = "12"] = process.argv.slice(2);
  const t = Date.now();
  const { findings, scanned } = await reviewClient(clientId);
  console.log(formatFindings(findings, scanned, Number(max)));
  console.log(`\n(${((Date.now() - t) / 1000).toFixed(0)}s)`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
