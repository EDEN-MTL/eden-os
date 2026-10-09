import { Attachment, ToolDef } from "../../shared/claude";
import { BaseAgent, ToolContext } from "../base-agent";
import { EmberConfigError, listEmberClientIds, loadEmberConfig } from "./config";
import { runEmberScanForClient } from "./scan";
import { EmberDisabledError, sendPendingForClient } from "./send";
import { getHealth, getLead, getStats, listLeads, updateLead } from "./store";
import { resumeHealth } from "./health";
import { NurtureStatus } from "./types";

const CLIENT_ID_PROP = {
  type: "string",
  description:
    "Client config id, e.g. \"eden-sub-account-one\". Optional when only one client has Ember configured.",
};

const TOOLS: ToolDef[] = [
  {
    name: "ember_pipeline_stats",
    description:
      "Real counts from Ember's database right now: leads by status (nurturing, paused, replied, reactivated, exited, opted_out, completed), how many touches are due, sends in the last 24h per channel, and reactivations in the last 30 days. Also reports whether sending is enabled for the client. Use this whenever asked for numbers — never estimate.",
    input_schema: { type: "object", properties: { clientId: CLIENT_ID_PROP } },
  },
  {
    name: "ember_list_active",
    description:
      "Lists nurture leads with their status, touches sent, next touch time and why they left the cadence if they did. Defaults to status \"nurturing\"; pass another status (e.g. \"reactivated\", \"replied\") to see those.",
    input_schema: {
      type: "object",
      properties: {
        clientId: CLIENT_ID_PROP,
        status: {
          type: "string",
          enum: ["nurturing", "paused", "replied", "handed_off", "reactivated", "exited", "opted_out", "not_interested", "no_consent", "completed"],
        },
        limit: { type: "number", description: "Max leads to return. Default 15." },
      },
    },
  },
  {
    name: "ember_scan_preview",
    description:
      "Dry-run of the dormancy scan against live GHL: which opportunities WOULD be enrolled into nurture right now, which tracked leads look reactivated, and a count of why everything else was skipped. Reads GHL only — enrolls nothing, sends nothing, alerts nobody. Use when asked who Ember would pick up, or to sanity-check the config.",
    input_schema: {
      type: "object",
      properties: {
        clientId: CLIENT_ID_PROP,
        thresholdDaysOverride: {
          type: "number",
          description: "Use this dormancy threshold instead of the configured one, for this preview only.",
        },
      },
    },
  },
  {
    name: "ember_send_now",
    description:
      "Sends every nurture touch that is due right now, under the daily cap, inside the client's local send window. Real texts/emails to real people — cannot be undone. Refuses outright while ember.enabled is false in the client config; that switch, not this tool, is the safety gate. Being asked to do this in this conversation is the approval.",
    input_schema: { type: "object", properties: { clientId: CLIENT_ID_PROP } },
  },
  {
    name: "ember_health",
    description:
      "Whether Ember has paused or stopped ITSELF for a client (agents/ember/health.ts) and why — separate from ember.enabled. Use when asked if Ember is running, why texts stopped, or before resuming.",
    input_schema: { type: "object", properties: { clientId: CLIENT_ID_PROP } },
  },
  {
    name: "ember_resume_sending",
    description:
      "Clears Ember's own pause/stop for a client after a teammate has checked the problem it reported in Slack. Sends and replies resume at the next scheduled run. Does nothing to ember.enabled. Only do this when a teammate says the issue is fixed or asks to resume.",
    input_schema: { type: "object", properties: { clientId: CLIENT_ID_PROP } },
  },
  {
    name: "ember_pause_lead",
    description:
      "Pauses one nurture lead by id — no more touches until resumed. Use when a teammate says they're handling someone personally. Reversible with ember_resume_lead.",
    input_schema: {
      type: "object",
      properties: {
        leadId: { type: "number" },
        reason: { type: "string", description: "Short note on why, shown in listings." },
      },
      required: ["leadId"],
    },
  },
  {
    name: "ember_resume_lead",
    description:
      "Resumes a paused nurture lead, or undoes a wrong Not Interested move (after the card has been moved back in GHL). Its next touch becomes due at the next send run. Replied, reactivated and opted-out (unsubscribed) leads stay stopped on purpose.",
    input_schema: { type: "object", properties: { leadId: { type: "number" } }, required: ["leadId"] },
  },
];

function resolveClientId(input: any): string {
  if (typeof input?.clientId === "string" && input.clientId.trim()) return input.clientId.trim();
  const ids = listEmberClientIds();
  if (ids.length === 1) return ids[0];
  throw new Error(
    ids.length === 0
      ? "No client has an ember config block yet."
      : `More than one client has Ember configured (${ids.join(", ")}) — say which one.`
  );
}

export class EmberAgent extends BaseAgent {
  constructor() {
    super("ember", "Ember", "EMB");
  }

  // Slack is internal: whoever is messaging here is a teammate operating
  // Ember, never one of the leads being nurtured. Same shape as Quarry's
  // and Iris's Slack personas.
  getSystemPrompt(context?: Record<string, any>): string {
    const senderName = context?.senderName as string | null | undefined;
    const senderLine = senderName
      ? `You are currently talking to ${senderName} — treat them as a known coworker by name.`
      : `You don't have a confirmed name for whoever's messaging you — don't guess one.`;
    const clients = listEmberClientIds()
      .map((id) => `${id} (sending ${loadEmberConfig(id)?.enabled ? "ON" : "OFF"})`)
      .join(", ") || "none yet";

    return `You are EMBER, EDEN's nurture and reactivation agent. You watch each
client's GHL pipeline for leads that went quiet — an open deal with no
stage change for weeks, not won, not lost, not in a column a human is
actively working — and work them through a slow SMS cadence with buyer or
seller reactivation scripts. The goal for an old lead is the same as for a
new one: qualify them and get them live-transferred to an agent. When one
replies, YOU text them back (Mark, 2026-10-06) — about 30 seconds later,
like a person — and qualify them over text with the client's own
qualification questions: plans, area, home, timeline, budget/financing.
If they qualify and say now (or a time) works, you queue Iris to call them
for a live transfer; Iris only makes the call, you keep the texting. "Not
ready yet" and clear "no"s get one short, polite reply. A card moved to a
new stage or a renewed-interest tag means a human's already on it: you
stop and post a reactivation alert to #backend-ops.

${senderLine}

Clients with Ember configured: ${clients}.

How it runs on its own: an hourly scan enrolls newly dormant leads and
catches reactivations; a send run every 30 minutes sends due touches inside
the client's local send window, under a daily cap. Sending is gated by
ember.enabled in the client config, which stays off until a teammate turns
it on after confirming the messaging cost with Jacob. While it's off
NOTHING runs automatically — no scan, no sends, no alerts — so if someone
asks why nothing is happening, that switch is usually the answer.

Before the first text of each cycle you read the lead's whole record —
texts, emails, team calls, Iris's calls, notes, pipeline stage — and either
use the approved script, write a short opener that picks up where they
left off, or wait. Lead status management (Mark's rule, 2026-10-01): on CLEAR evidence a lead
is no longer a prospect — they asked to stop, already bought, already sold,
are working with another agent, are no longer looking, or their plans
changed for good — you move their card to Not Interested and never contact
them again, and post why in #backend-ops quoting their words. Never on
assumptions: no reply, busy, unsure, "not ready yet", "next year", "still
thinking" all keep nurturing (a "not right now" pauses them 180 days).

Compliance you should be able to explain: texts only go out within the
CASL consent window, counted from their latest real inquiry (the original
form, or their own most recent message about a move); anyone past it is
parked as no_consent rather than texted. Every text carries a STOP line,
and GHL DND is re-checked right before every send.

Cite real numbers from your tools, not estimates. If a tool fails, say so
plainly. Respond concisely, like a teammate texting a quick update.`;
  }

  protected getTools(): ToolDef[] {
    return TOOLS;
  }

  protected async executeTool(name: string, input: any, _attachment?: Attachment, _ctx?: ToolContext): Promise<string> {
    switch (name) {
      case "ember_pipeline_stats": {
        const clientId = resolveClientId(input);
        const stats = await getStats(clientId);
        return JSON.stringify({ clientId, sendingEnabled: !!loadEmberConfig(clientId)?.enabled, ...stats });
      }

      case "ember_list_active": {
        const clientId = resolveClientId(input);
        const status = (input.status ?? "nurturing") as NurtureStatus;
        const limit = typeof input.limit === "number" ? input.limit : 15;
        const leads = await listLeads({ clientId, status, limit });
        return JSON.stringify({
          clientId,
          status,
          shown: leads.length,
          leads: leads.map((l) => ({
            id: l.id,
            name: l.contactName,
            enrolledFrom: l.enrolledStageName,
            touchesSent: l.touchCount,
            nextTouchAt: l.nextTouchAt,
            lastTouchAt: l.lastTouchAt,
            inquiryAt: l.inquiryAt,
            statusReason: l.statusReason,
          })),
        });
      }

      case "ember_scan_preview": {
        const clientId = resolveClientId(input);
        const report = await runEmberScanForClient(clientId, {
          dryRun: true,
          thresholdDaysOverride: typeof input.thresholdDaysOverride === "number" ? input.thresholdDaysOverride : undefined,
        });
        return JSON.stringify({ ...report, eligible: report.eligible.slice(0, 25) });
      }

      case "ember_send_now": {
        const clientId = resolveClientId(input);
        try {
          return JSON.stringify(await sendPendingForClient(clientId));
        } catch (error) {
          if (error instanceof EmberDisabledError || error instanceof EmberConfigError) {
            return JSON.stringify({ sent: false, reason: error.message });
          }
          throw error;
        }
      }

      case "ember_health": {
        const clientId = resolveClientId(input);
        return JSON.stringify({ clientId, ...(await getHealth(clientId)) });
      }

      case "ember_resume_sending": {
        const clientId = resolveClientId(input);
        const before = await getHealth(clientId);
        const after = await resumeHealth(clientId);
        return JSON.stringify({ clientId, was: before.state, wasReason: before.reason, now: after.state });
      }

      case "ember_pause_lead": {
        const lead = await getLead(Number(input.leadId));
        if (!lead) return JSON.stringify({ error: `No nurture lead #${input.leadId}` });
        if (lead.status !== "nurturing") {
          return JSON.stringify({ error: `Lead #${lead.id} is ${lead.status}, not nurturing — nothing to pause.` });
        }
        const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : "paused from Slack";
        await updateLead(lead.id, { status: "paused", statusReason: reason });
        return JSON.stringify({ id: lead.id, name: lead.contactName, status: "paused", reason });
      }

      case "ember_resume_lead": {
        const lead = await getLead(Number(input.leadId));
        if (!lead) return JSON.stringify({ error: `No nurture lead #${input.leadId}` });
        // not_interested can be resumed too: it's the undo for a wrong
        // Not Interested call (the alert tells the team to do exactly this,
        // after moving the card back in GHL). opted_out never can — that's
        // a real unsubscribe.
        if (lead.status !== "paused" && lead.status !== "not_interested") {
          return JSON.stringify({ error: `Lead #${lead.id} is ${lead.status} — only a paused or Not Interested lead can be resumed.` });
        }
        // Due immediately rather than at its old next_touch_at, which may be
        // long past — the send run's gap logic spaces anything after this one.
        await updateLead(lead.id, { status: "nurturing", statusReason: null, nextTouchAt: new Date().toISOString() });
        return JSON.stringify({ id: lead.id, name: lead.contactName, status: "nurturing" });
      }

      default:
        throw new Error(`Ember has no tool named "${name}"`);
    }
  }
}

export const emberAgent = new EmberAgent();
