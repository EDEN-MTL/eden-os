import "dotenv/config";
import { query } from "../shared/db";
import { getMetaConfig, MetaClient } from "../shared/meta";
(async () => {
  const flag = (await query<any>(`SELECT entity_id, entity_name, metrics_snapshot, created_at FROM ad_pending_actions WHERE id=5`))[0];
  console.log("flagged adset:", flag.entity_id, flag.entity_name, flag.created_at.toISOString());
  const ads = await query<any>(`SELECT ad_id, ad_name, SUM(spend)::float AS spend, MIN(date_start) AS from_d, MAX(date_stop) AS to_d FROM meta_performance_snapshots WHERE client_id='3-percent-east-coast' AND level='ad' AND adset_id=$1 AND date_start >= CURRENT_DATE - 7 GROUP BY ad_id, ad_name ORDER BY spend DESC`, [flag.entity_id]).catch((e) => { console.log("ERR", e.message); return []; });
  const c = new MetaClient((await getMetaConfig("3-percent-east-coast"))!);
  for (const a of ads) {
    const o: any = await c.getObject(a.ad_id, ["effective_status", "status", "updated_time"]).catch(() => ({}));
    const leads = await query<any>(`SELECT COUNT(*)::int AS n FROM ad_leads WHERE client_id='3-percent-east-coast' AND meta_ad_id=$1 AND created_at >= CURRENT_DATE - 7`, [a.ad_id]);
    console.log(`${String(a.ad_name).padEnd(44)} spend7d=$${a.spend.toFixed(2).padStart(7)} leads=${leads[0].n} live=${o.effective_status} updated=${o.updated_time}`);
  }
  const adset: any = await c.getObject(flag.entity_id, ["effective_status", "name"]);
  console.log("adset live:", adset.effective_status);
  process.exit(0);
})();
