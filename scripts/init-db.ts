/**
 * Applies shared/db/schema.sql against DATABASE_URL directly — the same
 * thing initDb() does at server startup, exposed standalone so the Vapi
 * test scripts don't require the full server (Slack clients, scheduler,
 * etc.) to be running just to get ad_settings / iris_call_log created.
 * Safe to run repeatedly: every statement in schema.sql is CREATE TABLE/
 * INDEX IF NOT EXISTS.
 *
 *   npx tsx scripts/init-db.ts
 */
import "dotenv/config";
import { initDb, pool } from "../shared/db";

async function main() {
  await initDb();
  await pool.end();
}

main().catch((error) => {
  console.error("[DB] Failed to apply schema:", error);
  process.exit(1);
});
