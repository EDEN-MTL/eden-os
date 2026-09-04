import { Attachment, ToolDef } from "../../shared/claude";
import { BaseAgent } from "../base-agent";
import { loadQuarryConfig } from "./config";
import { getLead, getPipelineStats, listLeads, updateLead } from "./store";
import { QuarryDisabledError, sendPending } from "./send";

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
      "Lists leads awaiting approval (approval_status = pending), with the reason each one was flagged. Use this before approving anything, or when asked what's waiting for review.",
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

quarry_send_now has a real external effect — actual emails to actual
strangers, with no undo. It is gated by the quarry.enabled kill switch in
config, not by anything conversational: if that switch is off the tool
will refuse and say so, and if it's on, being asked here IS the approval,
the same way Forge's spend-money tools work in this system — there is no
separate "are you sure" step for you to add on top of the tool's own
answer. Don't invent one, and don't refuse to call it out of undue caution
once asked; the switch is what carries the actual authority.

Cite real numbers from your tool calls, not estimates. If a tool call
fails, say that plainly rather than inventing a plausible-sounding answer.
Respond concisely, like a teammate texting a quick update — not a report.`;
  }

  protected getTools(): ToolDef[] {
    return TOOLS;
  }

  protected async executeTool(name: string, input: any, _attachment?: Attachment): Promise<string> {
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
