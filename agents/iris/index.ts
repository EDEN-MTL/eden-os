import { readFileSync } from "fs";
import { join } from "path";
import { BaseAgent } from "../base-agent";
import { Attachment, ToolDef } from "../../shared/claude";
import { eventBus } from "../../shared/events";
import { NormalisedLead } from "../scout/intake";
import { IrisConfig } from "./qualification";
import { query } from "../../shared/db";
import { isWithinLegalCallingWindow, nextFirstSlotTime, formatLocal } from "./cadence";
import { getGhlConfig, getLocationTimezone, listContactsPaginated } from "../../shared/ghl";

/**
 * The one client Iris actually runs against in production today — same
 * single-client gap already flagged for VAPI_PHONE_NUMBER_ID and
 * dial-pending.ts's CLIENT_TIMEZONE. Used as the default clientId for
 * these Slack tools so "look up [lead]" doesn't require Mark/Jacob to
 * specify a client every time; move to a real per-conversation resolution
 * once a second client goes live.
 */
const DEFAULT_CLIENT_ID = "3-percent-east-coast";

const IRIS_TOOLS: ToolDef[] = [
  {
    name: "iris_lookup_lead",
    description:
      "Looks up a specific lead's real call history — last attempt time (in the client's own local timezone), outcome, how many attempts so far, and current status (still pending, exhausted, opted out, etc.). Use this whenever asked about a NAMED lead, e.g. \"what time was the last call to Catherine\" or \"did we reach Bob yet\" — never guess or estimate from memory, the data changes constantly.",
    input_schema: {
      type: "object",
      properties: {
        nameOrPhone: { type: "string", description: "The lead's name or phone number, exactly as given." },
        clientId: { type: "string", description: `Which client's leads to search. Defaults to "${DEFAULT_CLIENT_ID}" (the only one live today) if not given.` },
      },
      required: ["nameOrPhone"],
    },
  },
  {
    name: "iris_pipeline_stats",
    description:
      "Real counts of where Iris's outreach queue stands right now: how many leads are still pending a call, how many are mid-cadence, how many have exhausted every attempt with no answer, how many opted out via text, how many live-transferred. Use this for any \"how's Iris doing\" / overall-numbers question — never estimate.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: `Which client to report on. Defaults to "${DEFAULT_CLIENT_ID}" if not given.` },
      },
    },
  },
];

interface PendingRow {
  status: string;
  resolution_reason: string | null;
  is_explicit_callback: boolean;
  call_after: Date;
  attempts_made: number;
}
interface CallLogRow {
  status: string;
  ended_reason: string | null;
  created_at: Date;
  ended_at: Date | null;
}

/** Live per-client timezone, same fallback chain dial-pending.ts's resolveOne already uses. */
async function resolveTimezone(clientId: string): Promise<string> {
  const config = loadIrisConfig(clientId);
  const ghlConfig = await getGhlConfig(clientId).catch(() => null);
  const live = ghlConfig ? await getLocationTimezone(ghlConfig.locationId, ghlConfig.apiKey).catch(() => null) : null;
  return live || config?.timezone || "America/St_Johns";
}

class IrisAgent extends BaseAgent {
  constructor() {
    super("iris", "Iris", "IRS");
  }

  protected getTools(): ToolDef[] {
    return IRIS_TOOLS;
  }

  protected async executeTool(name: string, input: any, _attachment?: Attachment): Promise<string> {
    switch (name) {
      case "iris_lookup_lead": {
        const nameOrPhone = String(input?.nameOrPhone ?? "").trim();
        if (!nameOrPhone) return JSON.stringify({ error: "nameOrPhone is required" });
        const clientId = String(input?.clientId ?? DEFAULT_CLIENT_ID);

        const ghlConfig = await getGhlConfig(clientId);
        if (!ghlConfig) return JSON.stringify({ error: `No GHL config for client "${clientId}"` });

        let contact: { id: string; name: string } | null = null;
        for await (const c of listContactsPaginated(ghlConfig.locationId, { limit: 5, query: nameOrPhone, apiKey: ghlConfig.apiKey })) {
          const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || c.contactName || nameOrPhone;
          contact = { id: c.id, name };
          break;
        }
        if (!contact) return JSON.stringify({ found: false, searchedFor: nameOrPhone });

        const timezone = await resolveTimezone(clientId);
        const [pending, callLog] = await Promise.all([
          query<PendingRow>(
            `SELECT status, resolution_reason, is_explicit_callback, call_after, attempts_made
             FROM iris_pending_calls WHERE client_id = $1 AND contact_id = $2`,
            [clientId, contact.id]
          ),
          query<CallLogRow>(
            `SELECT status, ended_reason, created_at, ended_at FROM iris_call_log
             WHERE client_id = $1 AND contact_id = $2 ORDER BY created_at DESC LIMIT 5`,
            [clientId, contact.id]
          ),
        ]);

        const lastCall = callLog[0];
        const row = pending[0];
        return JSON.stringify({
          found: true,
          name: contact.name,
          lastCallAttempt: lastCall ? formatLocal(lastCall.created_at.toISOString(), timezone) : null,
          lastCallOutcome: lastCall?.ended_reason ?? null,
          attemptsMade: row?.attempts_made ?? callLog.length,
          currentStatus: row?.status ?? "no active sequence",
          currentStatusReason: row?.resolution_reason ?? null,
          nextAttempt: row && row.status === "pending" ? formatLocal(row.call_after.toISOString(), timezone) : null,
          isExplicitCallback: row?.is_explicit_callback ?? false,
          recentCallHistory: callLog.map((c) => ({
            when: formatLocal(c.created_at.toISOString(), timezone),
            outcome: c.ended_reason,
          })),
        });
      }

      case "iris_pipeline_stats": {
        const clientId = String(input?.clientId ?? DEFAULT_CLIENT_ID);
        const [statusRows, optedOutRows, exhaustedRows] = await Promise.all([
          query<{ status: string; count: string }>(
            `SELECT status, COUNT(*) as count FROM iris_pending_calls WHERE client_id = $1 GROUP BY status`,
            [clientId]
          ),
          query<{ count: string }>(
            `SELECT COUNT(*) as count FROM iris_pending_calls
             WHERE client_id = $1 AND resolution_reason = 'lead opted out via text — cadence stopped'`,
            [clientId]
          ),
          // "placed" alone doesn't distinguish a lead who was just recently
          // reached from one whose whole 8-attempt sequence quietly ran out
          // with no answer (reopenForNextAttempt leaves the row's status
          // exactly as markPlaced last set it — see that function's own
          // doc comment — there's no distinct terminal status for this).
          // attempts_made >= 8 is a real proxy tied to the CURRENT cadence
          // (attemptsPerDay 2 x days 4), not a universal constant — these
          // are also the leads tagged "iris no answer" in GHL (see
          // webhooks/vapi-webhook.ts's tagSequenceExhausted).
          query<{ count: string }>(
            `SELECT COUNT(*) as count FROM iris_pending_calls WHERE client_id = $1 AND status = 'placed' AND attempts_made >= 8`,
            [clientId]
          ),
        ]);

        const byStatus = Object.fromEntries(statusRows.map((r) => [r.status, Number(r.count)]));
        return JSON.stringify({
          clientId,
          byStatus,
          optedOutViaText: Number(optedOutRows[0]?.count ?? 0),
          likelyExhaustedNoAnswer: Number(exhaustedRows[0]?.count ?? 0),
          note: "likelyExhaustedNoAnswer is a heuristic (attempts_made >= 8, the current 2/day x 4-day cadence total) — there's no separate terminal status for a fully-exhausted sequence versus one that succeeded on its last try.",
        });
      }

      default:
        throw new Error(`Iris has no tool named "${name}"`);
    }
  }

  // This prompt drives Iris's Slack persona — a colleague reporting on her
  // own real, live calling work, not a script performed on whoever's
  // chatting with her. Rewritten 2026-09-23: the previous version was
  // written 2026-09-01, the very first day of the Vapi integration, and
  // still said "voice calling isn't wired up yet" — false for over a week
  // by the time this was caught (Mark asked a real question about a real
  // lead's call history and Iris had no way to answer it, surfacing both
  // this staleness AND that she had zero tools — see getTools() above).
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
Speak as a colleague reporting on your own work, the way you'd talk to
someone you work with every day — never run a qualification script on the
person you're chatting with, never ask them for their name, timeline,
budget, or financing status, and never treat them as a prospective buyer,
seller, or downsizer. If someone asks who you work with, Jacob and Mark are
on the Eden team you support.

The client you support is 3 Percent East Coast — a 3% Realty brokerage
serving St. John's, Newfoundland & Labrador, Canada (CAD). That's background
you know, not who you are in THIS conversation: the "I'm IRIS, the virtual
assistant for 3% Realty East Coast" introduction and brand voice belong to
an actual lead conversation (a live call, or a GHL text thread) — never to Slack.
Don't reintroduce yourself that way here.

## You are LIVE — this is not a demo
Voice calling runs on Vapi and has been fully live for 3-percent-east-coast
since 2026-09-16: real leads get real automatic calls, real live transfers
to the buyer/seller ring groups, the works. If asked whether you're live,
say yes plainly — don't hedge or undersell it.

## What you actually do on a real call
Gather whatever qualifying info a lead's own form/CRM record didn't already
answer — buy/sell/downsize intent, area, timeline, financing — then live-
transfer if they qualify, or offer a callback if a transfer can't happen
right now. Qualification is NOT a pipeline stage — a lead counts as
qualified when it carries the "appt booked" or "live transferred" tag, never
by stage. You write results back as structured GHL fields, never prose into
isa_notes; financing is cash / pre-approved / in-progress / not-approved,
not a yes/no (a cash buyer is the strongest lead on the board, not a failed
approval).

## The full automatic cadence you own
Scout fires lead.enriched once, at intake — you own everything after that.
2 attempts/day for 4 days (8 total), re-checking the lead fresh before EVERY
single attempt, not just at the start — both because the human ISA might
reach them first, and because you now also read the lead's own text replies
before calling: a clear "don't call me" permanently stops the sequence and
tags the contact "do not call"; a specific time request ("call me at 6")
reschedules the next attempt to exactly that time instead of guessing. If a
lead never answers any of the 8 attempts, the sequence ends, the contact
gets tagged "iris no answer" so a human knows to follow up manually, and the
opportunity moves through the client's own DAY-N/WEEKEND follow-up pipeline
stages the whole way so the board shows exactly how many times each lead's
been tried.

If a call goes to voicemail, you say NOTHING at all and just hang up — no
message is left anymore (changed 2026-09-23). Every finished call — real or
test, any outcome — posts to #iris-call-logs automatically.

## Guardrails, always
No legal, investment, mortgage, or financial advice. Never claim to be
human or a licensed agent. Never pressure a lead or undermine an existing
agent relationship. Never invent a location, calendar id, or field key that
isn't in this client's config — say you don't know rather than guessing.

## Answering questions about specific leads or overall numbers, here in Slack
You have real tools now — iris_lookup_lead (a specific lead's real call
history, last-attempt time in their own local timezone, outcome, current
status) and iris_pipeline_stats (overall counts: pending, exhausted,
opted-out, etc.). ALWAYS call the relevant tool for a factual question like
this rather than guessing or estimating from memory — the data changes
constantly, and a wrong guess is worse than admitting you'd need to look it
up. If a tool comes back with nothing found, say so plainly rather than
inventing a plausible-sounding answer.

## Recognize when someone is actually done talking to you
Real bug found live 2026-09-22: after correctly answering a real question
about a lead, Mark replied "ok great" — and you responded with the ENTIRE
breakdown again, plus an invented apology about "guessing instead of using
the tool" that wasn't even true (your prior answer was already correct).
He then said "thanks" and you did it a SECOND time, nearly verbatim.

A short closing message — "ok", "ok great", "thanks", "got it", "cool",
"sounds good," a 👍, or similar — means the conversation is OVER, not a
new question. Reply briefly ("you're welcome!" or similar, one short line)
and stop. Never re-explain, re-verify, or repeat something you already
said just because the thread continues. Never invent a self-critical
story about an earlier turn being wrong or a guess — if you already gave
a correct, tool-backed answer, trust it; don't retroactively doubt it
without an actual reason to.

Be concise and specific, the way a sharp ISA reports to their broker.`;
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
      liveTransferStageId: raw.iris.liveTransferStageId || undefined,
      followUpStageIds: raw.iris.followUpStageIds || undefined,
      callbackNotesFieldKey: raw.iris.callbacks.notesFieldKey,
      callbackCalendarIds: raw.iris.callbacks.calendarIds || undefined,
      timezone: raw.iris.timezone || undefined,
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
  // Mark's spec, 2026-09-12: never place a call without a confirmed lead
  // name — lead.name here already reflects Scout's own GHL-contact/form
  // lookup (agents/scout/intake.ts), so a null value means genuinely no
  // name was found anywhere, not just an unchecked field. Re-checked again
  // right before the actual dial in dial-pending.ts, same dual-check
  // pattern as lead.phone above (queue time here, dial time there).
  if (!lead.name) {
    console.log(`[IRS] ${lead.contactId} has no confirmed name on file — not calling until one exists.`);
    return;
  }
  if (!lead.firstTouch) {
    console.log(`[IRS] ${lead.name || lead.contactId} already worked — not opening a new sequence.`);
    return;
  }

  try {
    // Mark's instruction, 2026-09-11: real calling-hours compliance — the
    // 5-minute SMS-head-start delay alone has no time-of-day check at all,
    // so a lead who fills out a form at 2am would otherwise get called at
    // 2:05am. Computed in JS, in the CLIENT's own configured business
    // timezone, so a candidate outside legal hours can be rescheduled.
    //
    // Mark's follow-up, 2026-09-24: rescheduling used to land on the
    // literal earliest legal instant (8am sharp) — confirmed live on a
    // real overnight lead (Jalpesh Patel, form submitted ~10:40pm, called
    // at exactly 8:00am) — which felt like an aggressive edge case rather
    // than a normal business call. Now lands on the SAME slot the regular
    // cadence already uses (10am) instead, so an overnight lead's first
    // call feels like any other scheduled attempt. A lead who submits
    // during legal hours is unaffected — still called within minutes.
    const timeZone = config.timezone || "America/St_Johns";
    const candidate = new Date(Date.now() + CALL_DELAY_MINUTES * 60 * 1000);
    const callAfter = isWithinLegalCallingWindow(candidate, timeZone) ? candidate : nextFirstSlotTime(config.outreachCadence, timeZone);
    await query(
      `INSERT INTO iris_pending_calls (client_id, contact_id, lead, call_after)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (client_id, contact_id) DO NOTHING`,
      [event.clientId, lead.contactId, JSON.stringify(lead), callAfter]
    );
    console.log(
      `[IRS] Queued a dial for ${lead.name || lead.contactId} (${lead.phone}) at ${callAfter.toISOString()} ` +
        `— waiting for the GHL SMS automation to send first, and for a legal calling hour.`
    );
  } catch (error) {
    console.error(`[IRS] Failed to queue dial for ${lead.contactId}:`, error instanceof Error ? error.message : error);
  }
});
