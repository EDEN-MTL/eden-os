import { Attachment, ToolDef } from "../../shared/claude";
import { BaseAgent, ToolContext } from "../base-agent";
import { EmberConfigError, listEmberClientIds, loadEmberConfig } from "./config";
import { runEmberScanForClient } from "./scan";
import { EmberDisabledError, sendPendingForClient } from "./send";
import { getLead, getStats, listLeads, updateLead } from "./store";
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
          enum: ["nurturing", "paused", "replied", "reactivated", "exited", "opted_out", "completed"],
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
      "Resumes a paused nurture lead. Its next touch becomes due at the next send run. Only works on a paused lead — replied, reactivated and opted-out leads stay stopped on purpose.",
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
replies (anything but a clear "no"), you hand them to Iris, who qualifies
them by text — plans, area, property, timeline, budget — and, if they
qualify, calls them for a live transfer. A card moved to a new stage or a
renewed-interest tag means a human's already on it: you stop and post a
reactivation alert to #backend-ops. You never write replies to leads
yourself.

${senderLine}

Clients with Ember configured: ${clients}.

How it runs on its own: an hourly scan enrolls newly dormant leads and
catches reactivations; a send run every 30 minutes sends due touches inside
the client's local send window, under a daily cap. Sending is gated by
ember.enabled in the client config, which stays off until a teammate turns
it on after confirming the messaging cost with Jacob. While it's off
NOTHING runs automatically — no scan, no sends, no alerts — so if someone
asks why nothing is happening, that switch is usually the answer.

Compliance you should be able to explain: leads are only nurtured within
180 days of their original inquiry (CASL implied consent), every text
carries a STOP line, and GHL DND is re-checked right before every send.

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
        if (lead.status !== "paused") {
          return JSON.stringify({ error: `Lead #${lead.id} is ${lead.status} — only a paused lead can be resumed.` });
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
