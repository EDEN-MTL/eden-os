/**
 * Read-only check of the Lens dashboard numbers against the real database:
 *   npx tsx scripts/lens-dashboard-check.ts <clientId> [last_7_days|last_30_days|this_month]
 * Prints every KPI for the period and the previous one, plus how well leads match real Meta campaigns.
 */
import "dotenv/config";
import { buildDashboardKpis } from "../agents/lens/dashboard/data";
import { clientTimezone, listLensClients } from "../agents/lens/dashboard/clients";
import { resolveRange, RangePreset } from "../agents/lens/dashboard/ranges";
import { METRIC_DEFINITIONS, MetricKey } from "../agents/lens/dashboard/definitions";

(async () => {
  const [clientId, preset = "last_30_days"] = process.argv.slice(2);
  if (!clientId) {
    console.log(JSON.stringify(await listLensClients(), null, 1));
    process.exit(0);
  }
  const tz = await clientTimezone(clientId);
  const r = resolveRange(preset as RangePreset, tz);
  if (!r.ok) throw new Error(r.error);
  const out = await buildDashboardKpis(clientId, r.range, { compare: true });
  if (!out) throw new Error(`unknown client ${clientId}`);
  console.log(`${out.client.name} | ${r.range.from} to ${r.range.to} (${tz}) vs ${out.previousRange?.from} to ${out.previousRange?.to}`);
  console.log("missing:", out.client.missing.join("; ") || "nothing");
  for (const key of Object.keys(out.current.kpis) as MetricKey[]) {
    const c = out.current.kpis[key], p = out.previous!.kpis[key];
    const f = (x: number | null) => (x === null ? "N/A" : Number.isInteger(x) ? String(x) : x.toFixed(2));
    console.log(`${METRIC_DEFINITIONS[key].label.padEnd(36)} ${f(c.value).padStart(10)}   prev ${f(p.value).padStart(10)}`);
  }
  console.log("attribution of leads created in period:", JSON.stringify(out.current.detail.leadsByAttribution));
  console.log("notes:", out.current.notes);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
