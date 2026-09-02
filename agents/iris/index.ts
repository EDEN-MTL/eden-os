import { readFileSync } from "fs";
import { join } from "path";
import { BaseAgent } from "../base-agent";
import { eventBus } from "../../shared/events";
import { NormalisedLead } from "../scout/intake";
import { IrisConfig } from "./qualification";
import { query } from "../../shared/db";

class IrisAgent extends BaseAgent {
  constructor() {
    super("iris", "Iris", "IRS");
  }

  // This prompt drives Iris's Slack persona. Slack is the only channel wired
  // up right now (Vapi voice and GHL SMS aren't connected to Iris yet), and
  // Slack is inherently internal — everyone reaching Iris here is a
  // teammate, never a lead. She should talk about her qualification work,
  // not perform it on whoever's chatting with her. If a lead-facing channel
  // (Vapi/SMS) gets wired up later, that call needs its own prompt — don't
  // reuse this one for it.
  //
  // context.senderName comes from BaseAgent.handleMessage resolving the
  // Slack userId via shared/slack's getUserRealName — it's null when that
  // lookup fails (no token, API error, no real_name set), so this always
  // falls back to the generic "a teammate" framing rather than asserting a
  // name it doesn't actually have.
  getSystemPrompt(context?: Record<string, any>): string {
    const senderName = context?.senderName as string | null | undefined;
    const senderLine = senderName
      ? `You are currently talking to ${senderName} — treat them as a known coworker by name, not a generic "teammate."`
      : `You don't have a confirmed name for whoever's messaging you right now — don't guess or invent one; ask if it matters, or just talk to them as a teammate without using a name.`;

    return `You are IRIS, EDEN's AI ISA (voice & text qualification) agent, part of the
EDEN operating system for real estate client acquisition.

You are talking to a member of the Eden team in Slack, not to a lead — most
often Jacob or Mark, your actual workmates, not prospects. ${senderLine}
Speak as a colleague reporting on your own work and expertise, the way you'd
talk to someone you work with every day — never run a qualification script
on the person you're chatting with, never ask them for their name,
timeline, budget, or financing status, and never treat them as a
prospective buyer, seller, or downsizer. If someone asks who you work with,
Jacob and Mark are on the Eden team you support.

The client you support is 3 Percent East Coast — a 3% Realty brokerage
serving St. John's, Newfoundland & Labrador, Canada (CAD). That's background
you know, not who you are in THIS conversation: the "I'm IRIS, the virtual
assistant for 3% Realty East Coast" introduction and brand voice belong to
an actual lead conversation — a live call once Vapi is wired up, or a GHL
text thread — never to Slack. Don't reintroduce yourself that way here, and
don't lead with the brand name when just answering a coworker's question.

## Your job, once you're actually on a call or texting a lead through GHL
Gather the missing qualifying info — buy/sell/downsize intent, area,
timeline, financing — decide fit, and get qualified leads connected to the
right agent. Live transfer is always the first priority; booking a phone
appointment is the fallback only when a transfer genuinely can't happen
right now. Qualification is NOT a pipeline stage — a lead counts as
qualified when it carries the "appt booked" or "live transferred" tag,
never by stage.

Voice calling runs on Vapi, which isn't wired up yet, so you aren't actually
placing or receiving qualification calls right now — say so plainly if asked
whether you're live.

## What you can report on here in Slack
- Cadence: morning + afternoon outreach attempts for the first 3-4 days (see
  iris.outreachCadence in client config), which you own — Scout only fires
  once, at intake. A contact must be re-checked before every attempt, not
  just at the start of the sequence, since the human ISA works leads too.
- How you write results to GHL: structured fields (timeline, budget,
  financing, intent), never prose into isa_notes. Financing is not yes/no —
  cash, pre-approved, in-progress, and not-approved are all different, and a
  cash buyer is the strongest lead on the board, not a failed approval.
- Your guardrails once actually qualifying a lead: no legal, investment,
  mortgage, or financial advice; never claim to be human or a licensed
  agent; never pressure a lead or undermine an existing agent relationship;
  follow up at most twice if a lead goes quiet, then stop.

Never invent a location, calendar id, or field key that isn't in this
client's config — say you don't know rather than guessing. Be concise and
specific, the way a sharp ISA reports to their broker.`;
  }
}

export const irisAgent = new IrisAgent();

/** Per-client qualification config: iris.* merged with scout's calendars. */
export function loadIrisConfig(clientId: string): IrisConfig | null {
  try {
    const raw = JSON.parse(
      readFileSync(join(process.cwd(), "config", "clients", `${clientId}.json`), "utf-8")
    );
    if (
      !raw?.iris?.qualificationQuestions ||
      !raw?.iris?.writeFields ||
      !raw?.iris?.outreachCadence ||
      !raw?.iris?.transferNumbers ||
      !raw?.iris?.callbacks?.notesFieldKey ||
      !raw?.scout?.calendars
    ) {
      return null;
    }
    return {
      questions: raw.iris.qualificationQuestions,
      hotScoreThreshold: raw.iris.hotScoreThreshold,
      warmScoreThreshold: raw.iris.warmScoreThreshold,
      calendars: raw.scout.calendars,
      transferNumbers: raw.iris.transferNumbers,
      callbackNotesFieldKey: raw.iris.callbacks.notesFieldKey,
      writeFields: raw.iris.writeFields,
      outreachCadence: raw.iris.outreachCadence,
    };
  } catch {
    return null;
  }
}

/** Brand name + service city, for the opener line and out-of-area responses. */
export function loadClientBranding(clientId: string): { brandName: string; city: string } | null {
  try {
    const raw = JSON.parse(
      readFileSync(join(process.cwd(), "config", "clients", `${clientId}.json`), "utf-8")
    );
    if (!raw?.clientName || !raw?.market?.city) return null;
    return { brandName: raw.clientName, city: raw.market.city };
  } catch {
    return null;
  }
}

/**
 * How long to wait after a lead comes in before Iris actually dials —
 * Mark's requirement: the GHL SMS automation needs time to actually send
 * before Iris calls on top of it, or the lead gets a call before the text
 * that was supposed to precede it. 5 minutes is a fixed wait, not a delivery
 * confirmation — GHL doesn't expose an SMS-delivered webhook this system
 * currently listens for, so this is the practical proxy for "the text has
 * almost certainly gone out by now."
 */
const CALL_DELAY_MINUTES = 5;

// ─── Event Subscriptions ───

/**
 * Scout emits lead.enriched once per lead, at intake, with clientId already
 * resolved (not a raw GHL locationId) and firstTouch: true only when nobody
 * has engaged the lead yet — see agents/scout/intake.ts's isFirstTouch.
 *
 * Does NOT dial here — only queues attempt 1, CALL_DELAY_MINUTES out, so the
 * GHL SMS automation gets a head start before Iris calls on top of it.
 * Whether that dial (and each one after it) actually happens is decided at
 * resolution time (agents/iris/dial-pending.ts) by a FRESH re-check, not
 * the firstTouch value captured here, which can go stale in those 5
 * minutes if the human ISA reaches the lead first. dial-pending.ts owns
 * the rest of the 2-per-day/3-4-day cadence itself from there — it
 * reschedules this same row for the next attempt after each one, using
 * cadence.ts's decideNextAttempt/nextAttemptTime, until the lead is
 * touched or the sequence runs out. ON CONFLICT DO NOTHING because a
 * second lead.enriched for a contact that already has a pending dial
 * should not queue a duplicate sequence.
 */
eventBus.subscribe("lead.enriched", async (event) => {
  const config = loadIrisConfig(event.clientId);
  const lead = event.data as unknown as NormalisedLead;

  if (!config) {
    console.log(`[IRS] No iris config for ${event.clientId} — skipping.`);
    return;
  }
  if (!lead.phone) {
    console.log(`[IRS] ${lead.name || lead.contactId} has no phone on file — cannot qualify by voice.`);
    return;
  }
  if (!lead.firstTouch) {
    console.log(`[IRS] ${lead.name || lead.contactId} already worked — not opening a new sequence.`);
    return;
  }

  try {
    await query(
      `INSERT INTO iris_pending_calls (client_id, contact_id, lead, call_after)
       VALUES ($1, $2, $3, now() + interval '${CALL_DELAY_MINUTES} minutes')
       ON CONFLICT (client_id, contact_id) DO NOTHING`,
      [event.clientId, lead.contactId, JSON.stringify(lead)]
    );
    console.log(
      `[IRS] Queued a dial for ${lead.name || lead.contactId} (${lead.phone}) in ${CALL_DELAY_MINUTES} minutes ` +
        `— waiting for the GHL SMS automation to send first.`
    );
  } catch (error) {
    console.error(`[IRS] Failed to queue dial for ${lead.contactId}:`, error instanceof Error ? error.message : error);
  }
});
