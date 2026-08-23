/**
 * Pulls fresh data from both source systems and persists it locally:
 *   - Meta: campaign/adset/ad performance insights -> meta_performance_snapshots
 *   - GHL: contacts + opportunities, resolved into attribution -> ad_leads
 *
 * Everything downstream (rules engine, reporting, dashboard) reads from
 * the local DB, not live from either API — keeps rule evaluation and page
 * loads fast and immune to transient API hiccups.
 */
import { readFileSync } from "fs";
import { join } from "path";
// Resolved from process.cwd() (the repo root — how both `npm run dev` and
// the production `node dist/server/index.js` start) rather than __dirname,
// since config/ isn't compiled into dist/ alongside the TypeScript output.
import { query } from "../../../shared/db";
import { getMetaConfig, MetaClient } from "../../../shared/meta";
import { getGhlConfig } from "../../../shared/ghl";
import { FieldMap, syncLeads } from "./attribution";

/**
 * Each call fetches one row PER DAY per entity (MetaClient.getInsights'
 * timeIncrement default) and, for every (level, day) it fetches, DELETES
 * whatever was already stored for that exact level+day before inserting
 * the fresh rows.
 *
 * This matters because sync runs on a schedule with an OVERLAPPING window
 * each time (e.g. "last 7 days" re-fetched from scratch every run) —
 * without deleting the previous rows for those same days first, every
 * re-sync would just append another full copy on top, and spend/CPL/ROAS
 * would silently multiply by however many times sync has run.
 */
export async function syncMetaPerformance(client: MetaClient, datePreset = "last_7d", clientId = "eden"): Promise<number> {
  const now = new Date();
  let count = 0;

  for (const level of ["campaign", "adset", "ad"] as const) {
    const rows = await client.getInsights({ level, datePreset });
    const days = [...new Set(rows.map((r: any) => r.date_start).filter(Boolean))];

    if (days.length > 0) {
      await query(
        `DELETE FROM meta_performance_snapshots WHERE client_id = $1 AND level = $2 AND date_start = ANY($3::date[])`,
        [clientId, level, days]
      );
    }

    for (const row of rows) {
      await query(
        `INSERT INTO meta_performance_snapshots (
           client_id, fetched_at, date_start, date_stop, level,
           campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name,
           spend, impressions, clicks, ctr, cpc, reach, frequency, raw
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [
          clientId, now, row.date_start, row.date_stop, level,
          row.campaign_id, row.campaign_name, row.adset_id, row.adset_name, row.ad_id, row.ad_name,
          Number(row.spend) || 0,
          Number(row.impressions) || 0,
          Number(row.clicks) || 0,
          row.ctr ? Number(row.ctr) / 100 : null, // Meta returns ctr as a percent
          row.cpc ? Number(row.cpc) : null,
          row.reach ? Number(row.reach) : null,
          row.frequency ? Number(row.frequency) : null,
          JSON.stringify(row),
        ]
      );
      count++;
    }
  }
  console.log(`[FORGE] Synced ${count} Meta insight rows (campaign+adset+ad, ${datePreset}).`);
  return count;
}

function loadFieldMap(clientId: string): FieldMap {
  const path = join(process.cwd(), "config", `ghl-field-map.${clientId}.json`);
  return JSON.parse(readFileSync(path, "utf-8"));
}

export async function syncGhl(locationId: string, clientId = "eden", pipelineName?: string, apiKey?: string): Promise<number> {
  const fieldMap = loadFieldMap(clientId);
  return syncLeads(locationId, fieldMap, { pipelineName, clientId, apiKey });
}

export interface SyncStats {
  metaRows: number | null;
  ghlLeads: number | null;
}

/**
 * Syncs whichever of Meta/GHL is actually configured — deliberately not
 * all-or-nothing, so each can be wired up independently and show data as
 * soon as it's connected, instead of neither working until both are.
 */
export async function runFullSync(clientId = "eden", datePreset = "last_7d"): Promise<SyncStats> {
  const stats: SyncStats = { metaRows: null, ghlLeads: null };

  const metaConfig = await getMetaConfig(clientId);
  if (metaConfig) {
    const client = new MetaClient(metaConfig);
    stats.metaRows = await syncMetaPerformance(client, datePreset, clientId);
  } else {
    console.log("[FORGE] Skipping Meta sync — not configured (see the dashboard's Settings page).");
  }

  const ghlConfig = await getGhlConfig(clientId);
  if (ghlConfig) {
    stats.ghlLeads = await syncGhl(ghlConfig.locationId, clientId, ghlConfig.attributionPipelineName, ghlConfig.apiKey);
  } else {
    console.log("[FORGE] Skipping GHL sync — not configured (see the dashboard's Settings page).");
  }

  return stats;
}
