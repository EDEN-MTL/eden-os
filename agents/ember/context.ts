/**
 * Gathers where a lead stands in the CRM before a cycle's first touch —
 * Mark, 2026-09-24: "check how they are in the CRM, pipeline, when was the
 * last conversation, call with the team, then start from there." History
 * (texts/emails/GHL calls) comes from history.ts; this adds everything
 * else: stage and how long it's sat there, tags, answers GHL already has,
 * the team's notes, and Iris's own calls (which run through Vapi, so GHL
 * has no record of them — see iris_call_log).
 *
 * Every part is best-effort: a failed notes read, say, just leaves that
 * part empty rather than blocking the touch — the history read in
 * outreach.ts is the part that must succeed.
 */
import { query } from "../../shared/db";
import { getContactNotes } from "../../shared/ghl";
import { refreshLead } from "../scout";
import { LeadContext } from "./history";
import { GhlOpportunityLite, NurtureLead } from "./types";

const DAY_MS = 86_400_000;
const NOTE_CHARS = 300;
const CALL_EXCERPT_CHARS = 200;

function trim(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export async function readLeadContext(
  lead: NurtureLead,
  opportunity: GhlOpportunityLite,
  stageNames: Record<string, string>,
  ghl: { locationId: string; apiKey: string },
  now: Date = new Date()
): Promise<LeadContext> {
  const stageChange = opportunity.lastStageChangeAt ?? opportunity.createdAt;

  const [fresh, notes, calls] = await Promise.all([
    refreshLead(lead.ghlContactId, lead.clientId).catch(() => null),
    getContactNotes(lead.ghlContactId, ghl.locationId, ghl.apiKey).catch(() => [] as any[]),
    query<{ created_at: Date; ended_reason: string | null; transcript: string | null }>(
      `SELECT created_at, ended_reason, transcript FROM iris_call_log
        WHERE client_id = $1 AND contact_id = $2 ORDER BY created_at DESC LIMIT 3`,
      [lead.clientId, lead.ghlContactId]
    ).catch(() => []),
  ]);

  const knownAnswers: string[] = [];
  if (fresh?.timeline) knownAnswers.push(`timeline: ${fresh.timeline}`);
  if (fresh?.budget) knownAnswers.push(`budget: ${fresh.budget}`);
  if (fresh?.propertyInterest) knownAnswers.push(`property type: ${fresh.propertyInterest}`);
  if (fresh?.bedrooms) knownAnswers.push(`bedrooms: ${fresh.bedrooms}`);
  if (fresh?.financing) knownAnswers.push(`financing: ${fresh.financing}`);
  if (fresh?.workingWithRealtor !== null && fresh?.workingWithRealtor !== undefined) {
    knownAnswers.push(`working with a realtor: ${fresh.workingWithRealtor ? "yes" : "no"}`);
  }

  return {
    stageName: stageNames[opportunity.pipelineStageId] ?? lead.enrolledStageName,
    daysInStage: stageChange ? (now.getTime() - new Date(stageChange).getTime()) / DAY_MS : null,
    tags: opportunity.contact?.tags ?? [],
    knownAnswers,
    notes: notes
      .map((n: any) => ({ at: typeof n?.dateAdded === "string" ? n.dateAdded : null, text: trim(String(n?.bodyText ?? n?.body ?? ""), NOTE_CHARS) }))
      .filter((n: { text: string }) => n.text)
      .sort((a: { at: string | null }, b: { at: string | null }) => (a.at ?? "").localeCompare(b.at ?? "")),
    irisCalls: calls
      .map((c) => ({
        at: c.created_at instanceof Date ? c.created_at.toISOString() : String(c.created_at),
        outcome: c.ended_reason,
        excerpt: c.transcript ? trim(c.transcript, CALL_EXCERPT_CHARS) : null,
      }))
      .reverse(),
  };
}
