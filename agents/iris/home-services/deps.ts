import { chatWithTools } from "../../../shared/claude";
import { appendHistory, loadHistory } from "../../../shared/conversation-memory";
import {
  addContactTags,
  createContactNote,
  createOpportunity,
  findOpenOpportunitiesForContact,
  getCustomFieldDefs,
  getGhlConfig,
  getOpportunity,
  listPipelines,
  updateContact,
  updateOpportunityStage,
} from "../../../shared/ghl";
import { sendMessage } from "../../../shared/slack";
import { CALL_LOG_CHANNEL } from "../channels";
import { checkHumanTouch, DEFAULT_HUMAN_HANDS_OFF_DAYS } from "../human-touch";
import { recentTexts } from "../text-signals";
import { HomeServicesConfig, loadHomeServicesConfig, resolveStageRefs } from "./config";
import { HsDeps } from "./engine";
import { HsLead, pgStore } from "./store";

const AGENT_ID = "iris";

export interface GhlAccess {
  locationId: string;
  apiKey: string;
}

export const historyKey = (clientId: string, contactId: string) => `hs:${clientId}:${contactId}`;

async function post(channel: string | null, text: string): Promise<void> {
  if (!channel) return;
  await sendMessage(AGENT_ID, { channel, text }).catch((error) => {
    console.error("[IRS-HS] Slack post failed:", error instanceof Error ? error.message : error);
  });
}

/** Dry-run output goes to Iris's internal log channel, never to the owner's channel. */
export const dryRunPost = (text: string) => post(CALL_LOG_CHANNEL, `🧪 DRY RUN — ${text}`);

async function resolveOpportunity(config: HomeServicesConfig, lead: HsLead, access: GhlAccess): Promise<string | null> {
  if (lead.opportunityId) return lead.opportunityId;
  const open = await findOpenOpportunitiesForContact(lead.contactId, access.locationId, access.apiKey);
  return open.find((o) => o.pipelineId === config.pipelineId)?.id ?? null;
}

const STAGE_CACHE_MS = 10 * 60_000;
const stageCache = new Map<string, { at: number; stages: { id: string; name: string }[] }>();
const warned = new Set<string>();

async function pipelineStages(clientId: string, config: HomeServicesConfig, access: GhlAccess): Promise<{ id: string; name: string }[]> {
  const cached = stageCache.get(clientId);
  if (cached && Date.now() - cached.at < STAGE_CACHE_MS) return cached.stages;
  const pipelines = await listPipelines(access.locationId, access.apiKey);
  const pipeline = pipelines.find((p: any) => p.id === config.pipelineId);
  if (!pipeline) throw new Error(`pipeline ${config.pipelineId} not found in the GHL location`);
  const stages = (pipeline.stages ?? []).map((s: any) => ({ id: s.id, name: s.name }));
  stageCache.set(clientId, { at: Date.now(), stages });
  return stages;
}

const fieldCache = new Map<string, { at: number; id: string }>();

/** The id of the contact custom field called `name`. A missing field is an error, never silently created in a client's account. */
async function customFieldId(clientId: string, name: string, access: GhlAccess): Promise<string> {
  const key = `${clientId}:${name.toLowerCase()}`;
  const cached = fieldCache.get(key);
  if (cached && Date.now() - cached.at < STAGE_CACHE_MS) return cached.id;
  const defs = await getCustomFieldDefs(access.locationId, access.apiKey);
  const match = defs.find((f: any) => String(f.name ?? "").trim().toLowerCase() === name.toLowerCase());
  if (!match?.id) throw new Error(`custom field "${name}" does not exist in the GHL location — create it (multi-line text) before going live`);
  fieldCache.set(key, { at: Date.now(), id: match.id });
  return match.id;
}

/** Real dependencies for one client. In dry-run mode every write to GHL and every message is replaced by a Slack note. */
export async function buildDeps(clientId: string): Promise<{ deps: HsDeps; access: GhlAccess } | null> {
  const configured = loadHomeServicesConfig(clientId);
  const access = await getGhlConfig(clientId).catch(() => null);
  if (!configured || !access) return null;
  let config: HomeServicesConfig;
  try {
    config = resolveStageRefs(configured, await pipelineStages(clientId, configured, access));
  } catch (error) {
    // Reported once per distinct problem, not every minute; the jobs simply do nothing until someone fixes the column names.
    const message = error instanceof Error ? error.message : String(error);
    stageCache.delete(clientId);
    if (!warned.has(`${clientId}:${message}`)) {
      warned.add(`${clientId}:${message}`);
      console.error(`[IRS-HS] ${clientId}: cannot resolve pipeline columns — ${message}`);
    }
    return null;
  }
  const live = config.mode === "live";

  const ghl: HsDeps["ghl"] = {
    async moveToColumn(lead, stageId) {
      if (!live) return dryRunPost(`would move ${lead.info.fullName ?? lead.contactId} to stage ${stageId}`);
      const opportunityId = await resolveOpportunity(config, lead, access);
      if (opportunityId) await updateOpportunityStage(opportunityId, stageId, access.locationId, access.apiKey);
      else {
        const created = await createOpportunity({ pipelineId: config.pipelineId, pipelineStageId: stageId, contactId: lead.contactId, name: lead.info.fullName ?? lead.contactId, locationId: access.locationId }, access.apiKey);
        const id = created?.opportunity?.id ?? created?.id;
        if (id) await pgStore.updateLead(lead.clientId, lead.contactId, { opportunityId: id });
      }
    },
    async addTags(lead, tags) {
      if (!live) return dryRunPost(`would tag ${lead.info.fullName ?? lead.contactId}: ${tags.join(", ")}`);
      await addContactTags(lead.contactId, tags, access.locationId, access.apiKey);
    },
    async writeNote(lead, body) {
      if (!live) return dryRunPost(`would write this note on ${lead.info.fullName ?? lead.contactId}:\n${body}`);
      await createContactNote(lead.contactId, body, access.locationId, access.apiKey);
    },
    async writeIsaNotes(lead, text) {
      if (!live) return dryRunPost(`would set "${config.isaNotesField}" on ${lead.info.fullName ?? lead.contactId} (this is what the GHL workflow would text ${config.ownerName}):\n${text}`);
      const id = await customFieldId(clientId, config.isaNotesField, access);
      await updateContact(lead.contactId, { customFields: [{ id, value: text }] }, access.locationId, access.apiKey);
    },
    async currentStageId(lead) {
      const opportunityId = await resolveOpportunity(config, lead, access);
      if (!opportunityId) return null;
      const opp = await getOpportunity(opportunityId, access.locationId, access.apiKey).catch(() => null);
      return opp?.pipelineStageId ?? null;
    },
  };

  const deps: HsDeps = {
    config,
    store: pgStore,
    now: () => new Date(),
    chat: (system, messages, tools) => chatWithTools(system, messages, tools, { maxTokens: 512, temperature: 0.6 }),
    recentTexts: async (lead) => (await recentTexts(lead.contactId, access.locationId, access.apiKey)).map((t) => ({ from: t.from, text: t.text })),
    loadHistory: (lead) => loadHistory(AGENT_ID, historyKey(lead.clientId, lead.contactId)),
    appendHistory: (lead, role, content) => appendHistory(AGENT_ID, historyKey(lead.clientId, lead.contactId), role, content),
    ghl,
    async alertOwner(text) {
      if (!live) return dryRunPost(`owner alert (not sent):\n${text}`);
      // Slack is a team-visible mirror; the owner's own text comes from his GHL workflow (see isaNotesField).
      await post(config.notify.slackChannel, text);
    },
    async teammateIsTexting(lead) {
      const touch = await checkHumanTouch(lead.contactId, access.locationId, access.apiKey, DEFAULT_HUMAN_HANDS_OFF_DAYS);
      return touch.status !== "none";
    },
  };
  return { deps, access };
}
