import "dotenv/config";
import { query } from "../shared/db";
import { getGhlConfig, listContactsPaginated, getConversations, getConversationMessages, listLocationUsers, listOpportunitiesForContact, listPipelines } from "../shared/ghl";
(async () => {
  const c = (await getGhlConfig("3-percent-east-coast"))!;
  const found: any[] = [];
  for await (const x of listContactsPaginated(c.locationId, { limit: 5, query: "Marcia Wiseman", apiKey: c.apiKey })) found.push(x);
  console.log(found.map((f) => `${f.firstName} ${f.lastName} ${f.id} ${f.phone} added=${f.dateAdded} tags=${(f.tags||[]).join("|")} dnd=${f.dnd}`));
  const m = found[0];
  const stages = new Map<string, string>();
  for (const p of await listPipelines(c.locationId, c.apiKey)) for (const s of p.stages ?? []) stages.set(s.id, s.name);
  for (const o of await listOpportunitiesForContact(m.id, c.locationId, c.apiKey)) console.log("OPP", o.id, stages.get(o.pipelineStageId), o.lastStageChangeAt, o.createdAt);
  const users = new Map((await listLocationUsers(c.locationId, c.apiKey)).map((u) => [u.id, u.name]));
  const conv = await getConversations(m.id, c.locationId, c.apiKey);
  for (const cv of conv.conversations ?? []) {
    const msgs = ((await getConversationMessages(cv.id, c.locationId, c.apiKey, 40))?.messages?.messages ?? []).sort((a: any, b: any) => Date.parse(a.dateAdded) - Date.parse(b.dateAdded));
    for (const x of msgs.slice(-14)) console.log(x.dateAdded, x.messageType, x.direction, "src=" + (x.source ?? ""), "user=" + (users.get(x.userId) ?? x.userId ?? ""), "app=" + (x.meta?.marketplace?.appId ?? ""), "from=" + (x.from ?? ""), "|", String(x.body ?? "").slice(0, 110).replace(/\n/g, " "));
  }
  const e = await query<any>(`SELECT id, status, status_reason, enrolled_stage_name, touch_count, last_touch_at, next_touch_at, unsubscribe_token, phone, created_at FROM ember_nurture_leads WHERE ghl_contact_id = $1 OR contact_name ILIKE '%wiseman%' OR phone LIKE '%7092903153%'`, [m.id]);
  console.log("EMBER LEADS", JSON.stringify(e));
  const sl = await query<any>(`SELECT * FROM ember_send_log WHERE created_at > now() - interval '3 days' AND (body ILIKE '%Marcia%' OR contact_id = $1) ORDER BY created_at DESC LIMIT 10`, [m.id]).catch((er) => { console.log("send_log err", String(er).slice(0, 150)); return []; });
  console.log("SEND LOG", JSON.stringify(sl).slice(0, 1500));
  process.exit(0);
})();
