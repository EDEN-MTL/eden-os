/**
 * Backfills a client's Meta daily insights for a past date range (campaign, ad set and ad level), a month at a
 * time, so the Lens dashboard has spend for older campaigns. Read-only against Meta; writes only
 * meta_performance_snapshots, and replaces rows for exactly the days it fetches (safe to run twice).
 *
 *   npx tsx scripts/lens-backfill-meta.ts <clientId> <from YYYY-MM-DD> <to YYYY-MM-DD>
 */
import "dotenv/config";
import { MetaClient, getMetaConfig } from "../shared/meta";
import { syncMetaPerformance } from "../agents/forge/ads/sync";

const addMonth = (ymd: string) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
};

(async () => {
  const [clientId, from, to] = process.argv.slice(2);
  if (!clientId || !from || !to) throw new Error("usage: lens-backfill-meta.ts <clientId> <from> <to>");
  const cfg = await getMetaConfig(clientId);
  if (!cfg) throw new Error(`no Meta account connected for ${clientId}`);
  const client = new MetaClient(cfg);
  let total = 0;
  for (let start = from; start <= to; start = addMonth(start)) {
    const next = addMonth(start);
    const end = new Date(Math.min(Date.parse(`${next}T00:00:00Z`) - 86_400_000, Date.parse(`${to}T00:00:00Z`))).toISOString().slice(0, 10);
    const n = await syncMetaPerformance(client, "last_7d", clientId, { since: start, until: end });
    console.log(`${clientId} ${start} to ${end}: ${n} rows`);
    total += n;
  }
  console.log(`${clientId}: ${total} rows in all`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
