/**
 * Enrolls leads in a week of Iris follow-up (agents/iris/followup-cohort.ts). Writes only the cohort table.
 *
 *   npx tsx scripts/enroll-followup-cohort.ts <clientId> <deadline ISO> <round ISO,round ISO,...> <contactId:opportunityId> ...
 *
 * Reads each opportunity's current stage and records it, so a card someone moves afterwards is left alone.
 * Rounds are the call rounds still to come AFTER whatever has already been queued by hand.
 */
import "dotenv/config";
import { getGhlConfig, getOpportunity, getContact } from "../shared/ghl";
import { enrollCohort } from "../agents/iris/followup-cohort";

(async () => {
  const [clientId, deadlineArg, roundsArg, ...pairs] = process.argv.slice(2);
  if (!clientId || !deadlineArg || !roundsArg || pairs.length === 0) throw new Error("usage: <clientId> <deadline ISO> <rounds ISO,ISO> <contactId:opportunityId>...");
  const ghl = await getGhlConfig(clientId);
  if (!ghl) throw new Error(`no GHL config for ${clientId}`);
  const members = [];
  for (const pair of pairs) {
    const [contactId, opportunityId] = pair.split(":");
    const opp = await getOpportunity(opportunityId, ghl.locationId, ghl.apiKey);
    const o = opp?.opportunity ?? opp;
    const raw = await getContact(contactId, ghl.locationId, ghl.apiKey);
    const c = raw?.contact ?? raw;
    const name = [c?.firstName, c?.lastName].filter(Boolean).join(" ") || contactId;
    if (!o?.pipelineStageId) throw new Error(`could not read the stage of ${name}'s card`);
    members.push({ contactId, name, opportunityId, stageId: o.pipelineStageId });
    console.log(`${name}: card in stage ${o.pipelineStageId}`);
  }
  await enrollCohort(clientId, members, roundsArg.split(",").map((d) => new Date(d)), new Date(deadlineArg));
  console.log(`enrolled ${members.length}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
