import { Attachment, ToolDef } from "../../shared/claude";
import { BaseAgent, ToolContext } from "../base-agent";
import { buildLocationSearches, loadQuarryConfig } from "./config";
import { getLead, getPipelineStats, listLeads, updateLead } from "./store";
import { QuarryDisabledError, sendPending } from "./send";
import {
  MissingCredentialsError,
  QuarryDisabledError as DiscoveryDisabledError,
  run,
} from "./pipeline";
import { PlaywrightCapturer } from "./screenshot";
import { sendMessage } from "../../shared/slack";

const TOOLS: ToolDef[] = [
  {
    name: "quarry_pipeline_stats",
    description:
      "Real counts from the Quarry database right now: how many leads by approval status, by pipeline stage, how many are mobile/email-reachable, opted out, replied, and sent today per channel. Use this whenever asked for numbers — never estimate or recall a figure from earlier in the conversation, the database may have changed.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "quarry_list_pending",
    description:
      "Lists leads sitting at approval_status = pending — with autoApprove on, that now only ever means a qualified lead with no email and no verified mobile, held back because there is no channel to actually send it on (it was also never synced to GHL). Use this when asked what's stuck, or whether anything just needs a phone/email found by hand.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max leads to return. Default 15." },
      },
    },
  },
  {
    name: "quarry_approve_lead",
    description:
      "Approves or rejects one lead by id, clearing it for (or excluding it from) quarry_send_now. Reversible — call it again with the opposite value to undo.",
    input_schema: {
      type: "object",
      properties: {
        leadId: { type: "number" },
        approve: { type: "boolean", description: "true to approve, false to reject." },
      },
      required: ["leadId", "approve"],
    },
  },
  {
    name: "quarry_run_discovery",
    description:
      "Searches Google Places for real businesses in the given area, triages each one for a missing or dated website (technical checks first, then a vision read on anything that passes clean), enriches contact info, and pushes anything that qualifies straight into GHL as a contact + opportunity in the Website Offer Pipeline's \"New Lead\" stage — the actual prospecting step, not a preview of it. This spends real Google Places + Claude vision money and creates real GHL contacts. Refuses outright if quarry.enabled is off, matching quarry_send_now — being asked to run this IS the approval, no separate confirmation needed.",
    input_schema: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "City/region to search, e.g. \"Ottawa, ON\" or \"Kingston, Ontario\". Not limited to any fixed list.",
        },
        maxLeads: {
          type: "number",
          description:
            "Cap on RAW businesses to discover and triage this run — not the number of qualified, emailable leads that come out the other end. Most discovered businesses don't qualify, and most that qualify don't have a findable email, so this needs to be set well above whatever count was actually asked for. Default 50.",
        },
      },
      required: ["location"],
    },
  },
  {
    name: "quarry_send_now",
    description:
      "Sends real emails/texts to every approved lead currently due a pitch or nudge, under each channel's daily cap. This has a real, external effect — it puts a message in front of a real stranger and cannot be undone. Refuses outright if quarry.enabled is off in the client config; that switch, not this tool, is the actual safety gate, matching how Forge's own money-spending tools work in this codebase. Being asked to do this in this conversation is the approval — there is no separate confirmation step.",
    input_schema: { type: "object", properties: {} },
  },
];

export class QuarryAgent extends BaseAgent {
  constructor() {
    super("quarry", "Quarry", "QRY");
  }

  // Same shape as Iris's Slack persona: Slack is internal, so whoever is
  // messaging here is a teammate operating the pipeline, never one of the
  // small businesses Quarry is prospecting. Quarry talks about its own
  // work, using its own tools for real numbers, rather than chatting in
  // the abstract about what it might be doing.
  getSystemPrompt(context?: Record<string, any>): string {
    const senderName = context?.senderName as string | null | undefined;
    const senderLine = senderName
      ? `You are currently talking to ${senderName} — treat them as a known coworker by name, not a generic "teammate."`
      : `You don't have a confirmed name for whoever's messaging you right now — don't guess or invent one; ask if it matters, or just talk to them as a teammate without using a name.`;

    return `You are QUARRY, part of EDEN's operating system. You find small businesses
with a missing or dated website, verify their contact info against public
listings, and run an email-first outreach sequence offering a free website
preview and a call — this is Eden's own prospecting, not a client's.

You are talking to a member of the Eden team in Slack, not to one of the
small businesses you prospect — most often Jacob. ${senderLine} Speak as a
colleague reporting on the pipeline, the way you'd talk to someone you work
with every day.

Always call quarry_pipeline_stats for real numbers rather than estimating —
the database changes underneath you between messages. If asked about
bookings or closed deals specifically: say plainly that pipeline_stage here
does not yet track GHL opportunity stage changes ("Call Booked", "Closed
Won") — those live inside GHL itself and nothing syncs them back onto a
lead's row here yet. Don't imply a number you don't actually have.

quarry_run_discovery and quarry_send_now both have real external effects —
the first spends real Places/Claude money and creates real GHL contacts,
the second puts a message in front of a real stranger, with no undo on
either. Both are gated by the quarry.enabled kill switch in config, not by
anything conversational: if that switch is off they refuse and say so, and
if it's on, being asked here IS the approval, the same way Forge's
spend-money tools work in this system — there is no separate "are you
sure" step for you to add on top of the tool's own answer. Don't invent
one, and don't refuse to call it out of undue caution once asked; the
switch is what carries the actual authority. A request like "find N
businesses in <city> and reach out to them" is asking for both steps —
call quarry_run_discovery, then quarry_send_now once it's done, in the
same turn, rather than stopping after discovery and waiting to be asked
again.

When Jacob asks for a specific number ("find 5 leads", "get me 5 qualified
ones"), N means qualified, email-reachable leads that actually land in GHL
— NOT quarry_run_discovery's maxLeads. maxLeads is a raw-discovery cap, and
most discovered businesses don't qualify, and most that qualify don't have
a findable email, so the real hit rate on a single pass is nowhere near
1:1. Confirmed live (2026-09-05, Cornwall, ON): maxLeads 5 produced 1
qualified lead and 0 synced to GHL. So: size maxLeads well above N up
front (a reasonable starting guess is 6-10x N for a first pass, adjusted
for what you already know about the area), and after the run, check
syncedToGhl against N yourself — do not just report a shortfall and stop.
If it's short, immediately run another discovery pass with a
meaningfully higher maxLeads (or, if you have reason to think the area is
just thin — a small/rural market, repeated vision timeouts, a string of
no-website results that can't qualify with that config flag off — say so
and suggest a nearby city instead of blindly escalating again). Cap
yourself at two escalating attempts on the same location before stopping
to report honestly that the market seems thin; don't loop indefinitely
spending real Places/Claude money chasing a count that may not exist
there.

The full loop this agent runs end to end: quarry_run_discovery finds
businesses and gets the reachable ones into GHL; auto-approve clears every
qualified lead automatically, hard-fact or vision-only opinion alike — no
review step, per Jacob's explicit call (2026-09-05) that this should run on
its own. The only lead that does NOT go to GHL at all is one with neither a
real email nor a verified mobile number: it stays pending in our own
database only, since a contact with no way to reach them is not worth
importing. quarry_send_now emails whatever's approved and due; a reply that
sounds interested gets the booking link automatically
(agents/quarry/outreach.ts's handleEmailReply) — nothing about booking a
call needs you to do anything extra.

Cite real numbers from your tool calls, not estimates. If a tool call
fails, say that plainly rather than inventing a plausible-sounding answer.
Respond concisely, like a teammate texting a quick update — not a report.`;
  }

  protected getTools(): ToolDef[] {
    return TOOLS;
  }

  protected async executeTool(name: string, input: any, _attachment?: Attachment, ctx?: ToolContext): Promise<string> {
    switch (name) {
      case "quarry_pipeline_stats": {
        const stats = await getPipelineStats();
        return JSON.stringify(stats);
      }

      case "quarry_list_pending": {
        const limit = typeof input.limit === "number" ? input.limit : 15;
        const pending = await listLeads({ approvalStatus: "pending" });
        const trimmed = pending.slice(0, limit).map((l) => ({
          id: l.id,
          name: l.name,
          category: l.category,
          email: l.email,
          isMobile: l.isMobile,
          reasons: l.reasons,
          placeTypes: l.placeTypes,
          googleMapsUri: l.googleMapsUri,
        }));
        return JSON.stringify({ totalPending: pending.length, shown: trimmed.length, leads: trimmed });
      }

      case "quarry_approve_lead": {
        const lead = await getLead(Number(input.leadId));
        if (!lead) return JSON.stringify({ error: `No lead #${input.leadId}` });
        const approvalStatus = input.approve ? "approved" : "rejected";
        await updateLead(lead.id, { approvalStatus });
        return JSON.stringify({ id: lead.id, name: lead.name, approvalStatus });
      }

      case "quarry_run_discovery": {
        const location = String(input.location ?? "").trim();
        if (!location) return JSON.stringify({ error: "location is required" });
        const config = loadQuarryConfig("eden");
        if (!config) return JSON.stringify({ error: "No quarry config for eden" });
        const searches = buildLocationSearches(config, location);
        const maxLeads = typeof input.maxLeads === "number" ? input.maxLeads : 50;
        // Confirmed live: a real batch checks every business one at a time
        // (site fetch, vision screenshot, enrichment) and can take 15-20+
        // minutes for 50 leads, with nothing posted until the whole thing
        // finishes — from Jacob's side that reads as "did this even receive
        // the request?" An immediate ack here doesn't fix the wait, but it
        // means silence is never mistaken for "didn't hear you."
        if (ctx) {
          try {
            await sendMessage("quarry", {
              channel: ctx.channelId,
              threadTs: ctx.threadTs,
              text: `On it — checking up to ${maxLeads} businesses in ${location}. A batch this size can take several minutes; I'll post the full rundown here once it's done.`,
            });
          } catch (error) {
            console.warn("[QRY] failed to post discovery acknowledgment:", error);
          }
        }
        // Held in its own variable so it can always be closed below — a
        // discovery run launches a real headless Chromium child process for
        // vision scoring, and nothing was ever closing it here. Confirmed
        // live 2026-09-06: after a full day of Slack-triggered runs each
        // leaking one orphaned browser process, this shared 512MB Render
        // instance (every agent in one process) ran out of memory and
        // crashed mid-batch — twice, hours apart, same pattern both times.
        const capturer = new PlaywrightCapturer();
        try {
          const report = await run({
            clientId: "eden",
            stopAfter: "enrich",
            triggeredBy: `slack:quarry_run_discovery(${location})`,
            searches,
            maxLeads,
            syncToGhl: true,
            capturer,
          });
          return JSON.stringify({
            location,
            discovered: report.discovered,
            qualified: report.qualified,
            autoApproved: report.autoApproved,
            heldForNoContact: report.heldForNoContact,
            syncedToGhl: report.syncedToGhl,
            withEmail: report.withEmail,
            errors: report.errors.slice(0, 5),
          });
        } catch (error) {
          if (error instanceof DiscoveryDisabledError) {
            return JSON.stringify({ ran: false, reason: error.message });
          }
          if (error instanceof MissingCredentialsError) {
            return JSON.stringify({ ran: false, reason: error.message });
          }
          throw error;
        } finally {
          await capturer.close().catch((closeError) => {
            console.warn("[QRY] failed to close Playwright browser after discovery run:", closeError);
          });
        }
      }

      case "quarry_send_now": {
        try {
          const report = await sendPending("eden");
          return JSON.stringify(report);
        } catch (error) {
          if (error instanceof QuarryDisabledError) {
            return JSON.stringify({ sent: false, reason: error.message });
          }
          throw error;
        }
      }

      default:
        throw new Error(`Quarry has no tool named "${name}"`);
    }
  }
}

export const quarryAgent = new QuarryAgent();
