/**
 * Sends a client's bi-weekly check-in link to their Slack channel, as
 * Scout. Run scripts/create-checkin-link.ts first if the client has no
 * link yet. Manual for now — a scheduler cron entry to automate this on a
 * real bi-weekly cadence is deliberately out of scope until the page
 * itself is proven out.
 *
 *   npx tsx scripts/send-checkin-link.ts [clientId]
 *
 * clientId defaults to "3-percent-east-coast".
 */
import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";
import { query, pool } from "../shared/db";
import { initSlackClients, sendMessage } from "../shared/slack";

async function main() {
  const clientId = process.argv[2] || "3-percent-east-coast";

  const config = JSON.parse(readFileSync(join(process.cwd(), "config", "clients", `${clientId}.json`), "utf-8"));
  const channel = config.slack?.clientChannel;
  if (!channel) {
    console.error(`[CHECKIN] "${clientId}" has no slack.clientChannel configured.`);
    process.exit(1);
  }

  const rows = await query<{ token: string }>("SELECT token FROM scout_checkin_links WHERE client_id = $1", [
    clientId,
  ]);
  if (!rows[0]) {
    console.error(`[CHECKIN] No check-in link for "${clientId}" yet — run scripts/create-checkin-link.ts first.`);
    process.exit(1);
  }

  const base = process.env.PUBLIC_BASE_URL || "";
  const url = `${base}/checkin/${rows[0].token}`;

  initSlackClients();
  const { ts } = await sendMessage("scout", {
    channel,
    text: `📋 Bi-weekly check-in: ${url}\nPlease check off what's happened on any recent appointments — takes a minute, no login needed.`,
  });

  console.log(`[CHECKIN] Sent to #${channel}, ts=${ts}`);
  await pool.end();
}

main().catch((error) => {
  console.error("[CHECKIN] Failed to send check-in link:", error);
  process.exit(1);
});
