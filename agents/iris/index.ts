import { readFileSync } from "fs";
import { join } from "path";
import { BaseAgent } from "../base-agent";
import { Attachment, ToolDef } from "../../shared/claude";
import { eventBus } from "../../shared/events";
import { NormalisedLead } from "../scout/intake";
import { IrisConfig } from "./qualification";
import { query } from "../../shared/db";
import { isWithinLegalCallingWindow, nextFirstSlotTime, formatLocal, zonedHourToUtc } from "./cadence";
import { getContact, getGhlConfig, getLocationTimezone, listContactsPaginated } from "../../shared/ghl";

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
  {
    name: "iris_call_transcript",
    description:
      "The real transcript of a lead's most recent call — what was actually said, both sides. Use this whenever asked what happened on a call, to describe/summarize a conversation, or anything like \"can you pull out the conversation\" — NEVER guess or infer this from the outcome code, duration, or flags alone (e.g. do not reason \"is_explicit_callback is true, so something must have triggered a callback\" — read the actual transcript instead).",
    input_schema: {
      type: "object",
      properties: {
        nameOrPhone: { type: "string", description: "The lead's name or phone number, exactly as given." },
        clientId: { type: "string", description: `Defaults to "${DEFAULT_CLIENT_ID}" if not given.` },
      },
      required: ["nameOrPhone"],
    },
  },
  {
    name: "iris_newest_lead",
    description:
      "The single newest lead captured in the system — who, phone, buy/sell intent, when they were captured, plus the same real call-status detail iris_lookup_lead gives for a named lead. Use this for \"what about the new lead\" / \"the new lead that just came in\" / \"how's the newest lead doing\" — anything referring to the MOST RECENT lead without naming them. Never guess who that is from memory.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: `Which client to report on. Defaults to "${DEFAULT_CLIENT_ID}" if not given.` },
      },
    },
  },
  {
    name: "iris_calls_today",
    description:
      "Every call Iris placed or answered today (the client's own local calendar day, not UTC), in chronological order — who, what time, which direction (outbound/inbound), and the outcome. Use this for \"what calls did you make today\" / \"which leads did you call today\" / \"any calls today\" — never reconstruct this from memory or #iris-call-logs scrollback; call the tool.",
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

/**
 * The real call-status fields iris_lookup_lead reports, factored out so
 * iris_newest_lead (below) can report the exact same depth for a contact
 * resolved a different way (newest iris_pending_calls row instead of a
 * name/phone search) without duplicating this query pair.
 */
async function leadStatusForContact(clientId: string, contactId: string, timezone: string) {
  const [pending, callLog] = await Promise.all([
    query<PendingRow>(
      `SELECT status, resolution_reason, is_explicit_callback, call_after, attempts_made
       FROM iris_pending_calls WHERE client_id = $1 AND contact_id = $2`,
      [clientId, contactId]
    ),
    query<CallLogRow>(
      `SELECT status, ended_reason, created_at, ended_at FROM iris_call_log
       WHERE client_id = $1 AND contact_id = $2 ORDER BY created_at DESC LIMIT 5`,
      [clientId, contactId]
    ),
  ]);

  const lastCall = callLog[0];
  const row = pending[0];
  return {
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
  };
}

/** Same contact resolution iris_lookup_lead and iris_call_transcript both need — a single shared lookup rather than two copies. */
async function resolveContactByNameOrPhone(
  ghlConfig: { locationId: string; apiKey: string },
  nameOrPhone: string
): Promise<{ id: string; name: string } | null> {
  for await (const c of listContactsPaginated(ghlConfig.locationId, { limit: 5, query: nameOrPhone, apiKey: ghlConfig.apiKey })) {
    const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || c.contactName || nameOrPhone;
    return { id: c.id, name };
  }
  return null;
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

        const contact = await resolveContactByNameOrPhone(ghlConfig, nameOrPhone);
        if (!contact) return JSON.stringify({ found: false, searchedFor: nameOrPhone });

        const timezone = await resolveTimezone(clientId);
        return JSON.stringify({ found: true, name: contact.name, ...(await leadStatusForContact(clientId, contact.id, timezone)) });
      }

      case "iris_call_transcript": {
        const nameOrPhone = String(input?.nameOrPhone ?? "").trim();
        if (!nameOrPhone) return JSON.stringify({ error: "nameOrPhone is required" });
        const clientId = String(input?.clientId ?? DEFAULT_CLIENT_ID);

        const ghlConfig = await getGhlConfig(clientId);
        if (!ghlConfig) return JSON.stringify({ error: `No GHL config for client "${clientId}"` });

        const contact = await resolveContactByNameOrPhone(ghlConfig, nameOrPhone);
        if (!contact) return JSON.stringify({ found: false, searchedFor: nameOrPhone });

        // Real gap found live 2026-10-01 (#iris-call-logs): Mark asked "can
        // you tell what happened here?" and Iris guessed from the outcome
        // code, duration, and the is_explicit_callback flag ("it LOOKS
        // like something triggered a callback request") rather than
        // reading what was actually said — then admitted, when asked to
        // "pull out the conversation," that she has no tool for the real
        // transcript at all, even though it's sitting right in
        // iris_call_log.transcript the whole time (written by
        // webhooks/vapi-webhook.ts's handleEndOfCallReport on every call).
        const rows = await query<{ transcript: string | null; created_at: Date; ended_reason: string | null }>(
          `SELECT transcript, created_at, ended_reason FROM iris_call_log
           WHERE client_id = $1 AND contact_id = $2 ORDER BY created_at DESC LIMIT 1`,
          [clientId, contact.id]
        );
        const row = rows[0];
        if (!row) return JSON.stringify({ found: true, name: contact.name, hasCall: false });

        const timezone = await resolveTimezone(clientId);
        return JSON.stringify({
          found: true,
          name: contact.name,
          when: formatLocal(row.created_at.toISOString(), timezone),
          outcome: row.ended_reason,
          transcript: row.transcript ?? null,
          note: row.transcript ? undefined : "No transcript recorded for this call (e.g. it never connected).",
        });
      }

      case "iris_newest_lead": {
        const clientId = String(input?.clientId ?? DEFAULT_CLIENT_ID);

        // iris_pending_calls gets a row the moment Scout fires lead.enriched
        // (agents/iris/index.ts's own lead.enriched handler, below) — the
        // newest one by created_at IS the newest lead in the system, same
        // ground truth the automatic cadence itself dials from. Real gap
        // found live 2026-10-01: Mark asked "how about the new lead?" /
        // "the new lead that just came in" and Iris had no way to resolve
        // that without already being given a name or number — she said so
        // plainly rather than guessing, but couldn't actually answer.
        const newest = await query<{ contact_id: string; lead: NormalisedLead; created_at: Date }>(
          `SELECT contact_id, lead, created_at FROM iris_pending_calls WHERE client_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [clientId]
        );
        if (!newest[0]) return JSON.stringify({ found: false });

        const { contact_id, lead, created_at } = newest[0];
        const timezone = await resolveTimezone(clientId);
        return JSON.stringify({
          found: true,
          name: lead?.name || "(unknown name)",
          phone: lead?.phone ?? null,
          intent: lead?.intent ?? null,
          capturedAt: formatLocal(created_at.toISOString(), timezone),
          ...(await leadStatusForContact(clientId, contact_id, timezone)),
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

      case "iris_calls_today": {
        const clientId = String(input?.clientId ?? DEFAULT_CLIENT_ID);
        const timezone = await resolveTimezone(clientId);

        // "Today" in the CLIENT's own calendar day, not the server's/UTC's
        // — same zonedHourToUtc technique cadence.ts already uses for
        // business-hours math, just for a day boundary (hour 0) instead of
        // a specific calling-window hour. Real gap found live 2026-10-01:
        // Mark asked "can you specify those leads you called today?" and
        // Iris had no tool for this at all — only a single-lead lookup and
        // overall pipeline counts, neither of which lists a day's calls.
        const inZone = new Date(new Date().toLocaleString("en-US", { timeZone: timezone }));
        const startOfDay = zonedHourToUtc(inZone.getFullYear(), inZone.getMonth(), inZone.getDate(), 0, timezone);
        const startOfTomorrow = zonedHourToUtc(inZone.getFullYear(), inZone.getMonth(), inZone.getDate() + 1, 0, timezone);

        const rows = await query<{ contact_id: string | null; phone: string; status: string; ended_reason: string | null; created_at: Date; triggered_by: string }>(
          `SELECT contact_id, phone, status, ended_reason, created_at, triggered_by FROM iris_call_log
           WHERE client_id = $1 AND created_at >= $2 AND created_at < $3
           ORDER BY created_at ASC`,
          [clientId, startOfDay.toISOString(), startOfTomorrow.toISOString()]
        );

        const ghlConfig = rows.some((r) => r.contact_id) ? await getGhlConfig(clientId).catch(() => null) : null;
        const calls = await Promise.all(
          rows.map(async (r) => {
            let name: string | null = null;
            if (r.contact_id && ghlConfig) {
              try {
                const resp = await getContact(r.contact_id, ghlConfig.locationId, ghlConfig.apiKey);
                const contact = resp?.contact ?? resp;
                name = [contact?.firstName, contact?.lastName].filter(Boolean).join(" ").trim() || null;
              } catch {
                // Name is a nicety — fall back to the bare phone number below.
              }
            }
            return {
              name: name ?? "(unknown name)",
              phone: r.phone,
              when: formatLocal(r.created_at.toISOString(), timezone),
              direction: r.triggered_by === "inbound" ? "inbound" : "outbound",
              status: r.status,
              outcome: r.ended_reason,
            };
          })
        );

        return JSON.stringify({ clientId, date: formatLocal(startOfDay.toISOString(), timezone), count: calls.length, calls });
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
status), iris_call_transcript (the real transcript of a lead's most recent
call — use this for "what happened on the call" / "what did they say" /
"pull out the conversation," NEVER inferred from the outcome code or
duration alone), iris_newest_lead (whichever lead was captured most
recently, for "what about the new lead" with no name given),
iris_pipeline_stats (overall counts: pending, exhausted, opted-out, etc.),
and iris_calls_today (every call placed or answered today, in order — who,
when, direction, outcome). ALWAYS call the relevant tool for a factual
question like this rather than guessing or estimating from memory — the
data changes constantly, and a wrong guess is worse than admitting you'd
need to look it up. If a tool comes back with nothing found, say so
plainly rather than inventing a plausible-sounding answer.

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
      smsCallHandoff: raw.iris.sms?.callHandoff === true,
      smsFromNumber: raw.iris.sms?.fromNumber || undefined,
      serviceArea: raw.market?.serviceArea?.core ? raw.market.serviceArea : undefined,
      humanHandsOffDays: typeof raw.iris.humanHandsOff?.days === "number" ? raw.iris.humanHandsOff.days : undefined,
      humanTextBlocksCalls: raw.iris.humanHandsOff?.blocksCalls === true,
      liveTransferSlack: raw.iris.liveTransferSlack?.channel
        ? { channel: raw.iris.liveTransferSlack.channel, clientLabel: raw.iris.liveTransferSlack.clientLabel || raw.clientName }
        : undefined,
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
  // Scout flags an existing contact who resubmitted the form with no real agent
  // history (Jacob, 2026-10-10, Koren Pye). Such a lead may carry old ISA notes
  // or an old card that make firstTouch read "worked", so the gate is bypassed
  // for them — the queue row is explicit instead, gated on `qualified`.
  const resubmission = (event.data as Record<string, unknown>).resubmission === true;
  if (!lead.firstTouch && !resubmission) {
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
    if (resubmission) {
      // An earlier round's row (placed/skipped) must not block this fresh
      // submission, but a sequence still pending is left alone.
      await query(
        `INSERT INTO iris_pending_calls (client_id, contact_id, lead, call_after, is_explicit_callback, resolution_reason)
         VALUES ($1, $2, $3, $4, true, 'resubmitted the form')
         ON CONFLICT (client_id, contact_id) DO UPDATE
           SET lead = EXCLUDED.lead, call_after = EXCLUDED.call_after, status = 'pending', is_explicit_callback = true,
               source = NULL, attempts_made = 0, callback_misses = 0, resolution_reason = 'resubmitted the form', resolved_at = NULL
           WHERE iris_pending_calls.status <> 'pending'`,
        [event.clientId, lead.contactId, JSON.stringify(lead), callAfter]
      );
    } else {
      await query(
        `INSERT INTO iris_pending_calls (client_id, contact_id, lead, call_after)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (client_id, contact_id) DO NOTHING`,
        [event.clientId, lead.contactId, JSON.stringify(lead), callAfter]
      );
    }
    console.log(
      `[IRS] Queued a dial for ${lead.name || lead.contactId} (${lead.phone}) at ${callAfter.toISOString()} ` +
        `— waiting for the GHL SMS automation to send first, and for a legal calling hour.`
    );
  } catch (error) {
    console.error(`[IRS] Failed to queue dial for ${lead.contactId}:`, error instanceof Error ? error.message : error);
  }
});
