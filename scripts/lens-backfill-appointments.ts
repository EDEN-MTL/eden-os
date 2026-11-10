/**
 * One-time backfill of GHL appointments for the Lens dashboard (the hourly job only re-reads the last 120 days).
 *
 *   npx tsx scripts/lens-backfill-appointments.ts <clientId> [fromDate YYYY-MM-DD]
 *
 * Read-only against GHL; writes only the ghl_appointments table. Safe to run twice.
 */
import "dotenv/config";
import { syncAppointments } from "../agents/lens/dashboard/appointments-sync";

(async () => {
  const [clientId, from = "2026-01-01"] = process.argv.slice(2);
  if (!clientId) throw new Error("usage: lens-backfill-appointments.ts <clientId> [fromDate]");
  const n = await syncAppointments(clientId, new Date(`${from}T00:00:00Z`), new Date(Date.now() + 60 * 86_400_000));
  console.log(`${clientId}: stored ${n} appointments since ${from}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
