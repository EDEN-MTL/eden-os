/**
 * Creates (or re-prints) a client's stable bi-weekly check-in link. Safe
 * to re-run — upserts, so it won't mint a second token for a client that
 * already has one.
 *
 *   npx tsx scripts/create-checkin-link.ts [clientId]
 *
 * clientId defaults to "3-percent-east-coast".
 */
import "dotenv/config";
import { randomUUID } from "crypto";
import { query, pool } from "../shared/db";

async function main() {
  const clientId = process.argv[2] || "3-percent-east-coast";

  const existing = await query<{ token: string }>(
    "SELECT token FROM scout_checkin_links WHERE client_id = $1",
    [clientId]
  );
  const token = existing[0]?.token || randomUUID();

  if (!existing[0]) {
    await query("INSERT INTO scout_checkin_links (client_id, token) VALUES ($1, $2)", [clientId, token]);
  }

  const base = process.env.PUBLIC_BASE_URL || "";
  if (!base) {
    console.warn("[CHECKIN] PUBLIC_BASE_URL not set — printing the path only.");
  }
  console.log(`[CHECKIN] Link for "${clientId}":`);
  console.log(`${base}/checkin/${token}`);

  await pool.end();
}

main().catch((error) => {
  console.error("[CHECKIN] Failed to create link:", error);
  process.exit(1);
});
