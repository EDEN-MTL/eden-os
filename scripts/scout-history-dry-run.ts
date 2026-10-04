/**
 * Read-only dry run of Scout's returning-lead check against REAL contacts —
 * writes nothing, tags nothing, texts nobody. Run before trusting
 * agents/scout/history.ts's rules (this repo's standing rule: verify
 * against live data, not just fixtures):
 *
 *   npx tsx scripts/scout-history-dry-run.ts [clientId] [contactId ...]
 *
 * With no contact ids it checks a known mix for 3-percent-east-coast: Glen
 * White (old lead, assigned, appt booked — expect RETURNING), Justin Denney
 * and Chioma Okoye (live-transferred — expect RETURNING), and Saife Sarwar
 * (replied to the text automation, never worked by an agent — an old
 * contact with no agent history is treated as new, so expect NEW).
 */
import "dotenv/config";
import { loadScoutConfig } from "../agents/scout";
import { assessLeadHistory, describeReasons } from "../agents/scout/returning";
import { getContact, getGhlConfig, listLocationUsers, listPipelines } from "../shared/ghl";

const DEFAULTS: Record<string, string> = {
  "Glen White": "l0s8oGXEeGUMOMph6th8",
  "Justin Denney": "3FyjdzWqF4nL0brg3hRQ",
  "Chioma Okoye": "MP9ZnSf9tVSybL2D2I7j",
  "Saife Sarwar": "grh8b9zNOX1h9VKZncmF",
};

async function main() {
  const [clientId = "3-percent-east-coast", ...ids] = process.argv.slice(2);
  const config = loadScoutConfig(clientId);
  const ghlConfig = await getGhlConfig(clientId);
  if (!config || !ghlConfig) throw new Error(`No scout/GHL config for ${clientId}`);

  const userNames = new Map((await listLocationUsers(ghlConfig.locationId, ghlConfig.apiKey)).map((u) => [u.id, u.name]));
  const stageNames = new Map<string, string>();
  for (const p of await listPipelines(ghlConfig.locationId, ghlConfig.apiKey)) for (const s of p.stages ?? []) stageNames.set(s.id, s.name);

  const targets = ids.length > 0 ? ids.map((id) => [id, id] as const) : Object.entries(DEFAULTS);
  for (const [label, contactId] of targets) {
    const resp = await getContact(contactId, ghlConfig.locationId, ghlConfig.apiKey);
    const name = [(resp?.contact ?? resp)?.firstName, (resp?.contact ?? resp)?.lastName].filter(Boolean).join(" ") || label;
    const assessed = await assessLeadHistory(contactId, clientId, config);
    if (!assessed) {
      console.log(`${name}: COULD NOT VERIFY (this is the fail-closed path)`);
      continue;
    }
    const { history } = assessed;
    console.log(
      `${name}: ${history.returning ? "RETURNING" : "NEW"}` +
        (history.returning
          ? ` | owner: ${history.assignedUserId ? userNames.get(history.assignedUserId) ?? history.assignedUserId : "none"} | ${describeReasons(history.reasons, stageNames, userNames).join("; ")}`
          : "")
    );
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
