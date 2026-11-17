/**
 * Prints this week's Iris patterns digest (agents/iris/pattern-digest.ts) without sending it. Read-only.
 *   npx tsx --env-file=.env scripts/pattern-digest.ts [clientId]
 */
import { runPatternDigest } from "../agents/iris/pattern-digest";

async function main() {
  const r = await runPatternDigest(process.argv[2] ?? "3-percent-east-coast", { send: false });
  console.log(r.text ?? "(patternDigest is off for this client)");
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
