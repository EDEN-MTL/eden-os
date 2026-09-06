/**
 * Module 6 — GHL sync.
 *
 * Pushes a finished prospect into GoHighLevel as a contact plus an
 * opportunity in the Website Offer Pipeline, and resolves stage names to
 * stage ids for everything downstream.
 *
 * This module never sends a message. Outreach is gated behind human approval
 * and lives in outreach.ts.
 *
 * ── Why the pipeline is not created here ──
 * GHL v2 exposes no create-pipeline endpoint. Pipelines and their stages have
 * to be built by hand in the GHL UI, the same way workflow triggers do (see
 * gotcha 4 in CLAUDE.md). So this module VERIFIES instead of provisioning:
 * it resolves the configured pipeline by name against the live location and
 * refuses to sync if it is missing or a stage name has drifted. A wrong stage
 * name in GHL never throws on its own — the opportunity would just land in
 * whatever stage id we last hardcoded — so the check has to be explicit.
 */
import {
  createContact,
  createOpportunity,
  listPipelines,
  searchContacts,
  updateContact,
} from "../../shared/ghl";
import { QuarryCategory } from "./types";

export interface ResolvedPipeline {
  pipelineId: string;
  /** Stage name → stage id. Names come from config; ids only exist live. */
  stageIds: Record<string, string>;
}

export class PipelineNotProvisionedError extends Error {
  constructor(
    readonly pipelineName: string,
    readonly missingStages: string[],
    readonly availablePipelines: string[]
  ) {
    const detail = missingStages.length
      ? `is missing stage(s): ${missingStages.join(", ")}`
      : `does not exist`;
    super(
      `GHL pipeline "${pipelineName}" ${detail}. ` +
        `GHL has no create-pipeline API — build it by hand in the GHL UI, then re-run. ` +
        `Pipelines currently on this location: ${availablePipelines.join(", ") || "none"}.`
    );
    this.name = "PipelineNotProvisionedError";
  }
}

/**
 * Resolves the configured pipeline + stages against the live location.
 *
 * Stage matching is exact and case-sensitive on purpose. GHL stage names
 * routinely carry trailing spaces and emoji (Eden's Main Pipeline has stages
 * called "Closed 💸" and "🤷‍♂️"), so a fuzzy match would happily bind to the
 * wrong stage and silently misfile every lead. Better to fail and be told.
 */
export async function resolvePipeline(
  pipelineName: string,
  requiredStages: string[],
  locationId: string,
  apiKey?: string
): Promise<ResolvedPipeline> {
  const pipelines = await listPipelines(locationId, apiKey);
  const match = pipelines.find((p: any) => p.name === pipelineName);

  if (!match) {
    throw new PipelineNotProvisionedError(
      pipelineName,
      [],
      pipelines.map((p: any) => p.name)
    );
  }

  const stageIds: Record<string, string> = {};
  for (const stage of match.stages || []) stageIds[stage.name] = stage.id;

  const missing = requiredStages.filter((s) => !(s in stageIds));
  if (missing.length > 0) {
    throw new PipelineNotProvisionedError(
      pipelineName,
      missing,
      pipelines.map((p: any) => p.name)
    );
  }

  return { pipelineId: match.id, stageIds };
}

/**
 * Finds an existing GHL contact for this prospect, or creates one.
 *
 * Matched on phone, because a business name is not unique and these contacts
 * have no email most of the time. A prospect that already exists in GHL from
 * an earlier campaign is updated rather than duplicated — GHL will happily
 * hold two contacts on the same number and then split the conversation
 * thread between them.
 */
export async function upsertProspectContact(
  input: {
    name: string;
    phone: string;
    email: string | null;
    website: string | null;
    category: QuarryCategory | null;
    previewUrl: string | null;
    previewImageUrl: string | null;
    outdatedScore: number | null;
  },
  locationId: string,
  apiKey?: string
): Promise<{ contactId: string; created: boolean }> {
  // apiKey was missing here before 2026-09-06 — this call has been failing
  // outright on every real run (this client resolves its key from the DB,
  // not the bare GHL_API_KEY env var ghlRequest falls back to), silently
  // swallowed by the catch below. In effect every contact was blind-created
  // rather than deduped, and a true repeat phone number only ever surfaced
  // as GHL's own "duplicated contacts" 400 on the create call, never as a
  // clean update — see the Remax Centre City Realty sync failure.
  const existing = await searchContacts(input.phone, locationId, apiKey).catch(() => null);
  const found = existing?.contacts?.[0];

  const tags = ["quarry", ...(input.category ? [input.category] : [])];

  if (found?.id) {
    // apiKey was missing here before 2026-09-06 — harmless while the bare
    // GHL_API_KEY env var still worked as an implicit fallback, but this
    // client resolves its key from the DB instead (see getGhlConfig), so an
    // existing contact (a repeat phone number) would fail this update with
    // "GHL_API_KEY not set" the moment that env var stopped being set.
    await updateContact(
      found.id,
      { tags, ...(input.website ? { website: input.website } : {}) },
      locationId,
      apiKey
    );
    return { contactId: found.id, created: false };
  }

  // Custom fields (previewUrl, previewImageUrl, outdatedScore) are NOT written
  // here. They must be addressed by internal field id and never by fieldKey
  // (gotcha 1), so they need a resolved id lookup the caller owns. `website`
  // is different — it's a native GHL contact field, not a custom one, so it
  // needs no id lookup at all.
  const created = await createContact(
    {
      name: input.name,
      phone: input.phone,
      ...(input.email ? { email: input.email } : {}),
      ...(input.website ? { website: input.website } : {}),
      tags,
      locationId,
      source: "quarry",
    },
    apiKey
  );
  return { contactId: created?.contact?.id ?? created?.id, created: true };
}

export async function openOpportunity(
  input: { contactId: string; businessName: string; pipeline: ResolvedPipeline; stage: string },
  locationId: string,
  apiKey?: string
): Promise<string> {
  const stageId = input.pipeline.stageIds[input.stage];
  if (!stageId) throw new Error(`Stage "${input.stage}" not resolved on this pipeline`);

  const result = await createOpportunity(
    {
      pipelineId: input.pipeline.pipelineId,
      pipelineStageId: stageId,
      contactId: input.contactId,
      name: input.businessName,
      locationId,
    },
    apiKey
  );
  return result?.opportunity?.id ?? result?.id;
}
