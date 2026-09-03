/**
 * Builds the live GHL calls outreach.ts needs — resolved once per call
 * against a client's actual credentials and pipeline, rather than every
 * caller re-deriving locationId/apiKey/stage-ids by hand.
 *
 * Pipeline resolution runs fresh on every call rather than being cached.
 * Reply volume here is a handful a day, not a hot path — caching would save
 * one GHL call per reply at the cost of serving a stale stage id if the
 * pipeline is ever edited. Revisit only if volume actually makes that cost
 * matter.
 */
import { getGhlConfig, sendEmail, sendMMS, sendSMS, updateOpportunityStage } from "../../shared/ghl";
import { loadQuarryConfig } from "./config";
import { resolvePipeline } from "./sync";
import { EmailDeps, OutreachDeps } from "./outreach";

export class GhlNotConfiguredError extends Error {
  constructor(clientId: string) {
    super(`No GHL credentials configured for client "${clientId}"`);
    this.name = "GhlNotConfiguredError";
  }
}

interface Context {
  locationId: string;
  apiKey: string;
  stageIds: Record<string, string>;
}

async function resolveContext(clientId: string): Promise<Context> {
  const ghlConfig = await getGhlConfig(clientId);
  if (!ghlConfig) throw new GhlNotConfiguredError(clientId);
  const quarryConfig = loadQuarryConfig(clientId);
  if (!quarryConfig) throw new Error(`No quarry config for client "${clientId}"`);

  const pipeline = await resolvePipeline(
    quarryConfig.ghlPipeline.name,
    quarryConfig.ghlPipeline.stages,
    ghlConfig.locationId,
    ghlConfig.apiKey
  );
  return { locationId: ghlConfig.locationId, apiKey: ghlConfig.apiKey, stageIds: pipeline.stageIds };
}

/**
 * updateOpportunityStage takes a stage ID, never a stage name (gotcha 5 in
 * CLAUDE.md) — this is the one place that translation happens for Quarry.
 * A stage name that fails to resolve is logged and skipped rather than
 * thrown: a reply that came in correctly should not be lost because the
 * pipeline card couldn't move.
 */
async function moveStageByName(ctx: Context, opportunityId: string, stageName: string): Promise<void> {
  const stageId = ctx.stageIds[stageName];
  if (!stageId) {
    console.warn(`[QRY] cannot move opportunity ${opportunityId} — stage "${stageName}" not resolved`);
    return;
  }
  await updateOpportunityStage(opportunityId, stageId, ctx.locationId);
}

export async function buildOutreachDeps(clientId = "eden"): Promise<OutreachDeps> {
  const ctx = await resolveContext(clientId);
  return {
    sendMMS: (contactId, message, attachments) =>
      sendMMS(contactId, message, attachments, ctx.locationId, ctx.apiKey),
    sendSMS: (contactId, message) => sendSMS(contactId, message, ctx.locationId, ctx.apiKey),
    moveStage: (opportunityId, stageName) => moveStageByName(ctx, opportunityId, stageName),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export async function buildEmailDeps(clientId = "eden"): Promise<EmailDeps> {
  const ctx = await resolveContext(clientId);
  return {
    sendEmail: (contactId, subject, html, fromEmail) =>
      sendEmail(contactId, { subject, html, fromEmail }, ctx.locationId, ctx.apiKey),
    moveStage: (opportunityId, stageName) => moveStageByName(ctx, opportunityId, stageName),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
