import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { BaseAgent } from "../base-agent";
import { ToolDef } from "../../shared/claude";
import { query } from "../../shared/db";
import { eventBus } from "../../shared/events";
import * as pendingQueue from "../forge/ads/queue";
import { readEmergencyHoldAll } from "../forge/ads/settings";

interface ClientSummary {
  clientId: string;
  clientName: string;
}

function listClientConfigs(): ClientSummary[] {
  const dir = join(process.cwd(), "config", "clients");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf-8"));
      return { clientId: raw.clientId, clientName: raw.clientName };
    });
}

const TOOLS: ToolDef[] = [
  {
    name: "get_system_status",
    description:
      "Real, grounded status for every configured client: when Meta ad data last synced, how many ad-rule actions are awaiting approval, and whether the emergency hold is on. This is the ONLY source of truth for system status — never state a client's sync, performance, or pending-action state without calling this first. It has NO visibility into GHL lead-sync health, ad performance metrics, or anything client-specific beyond what's listed here; say so plainly if asked about those instead of guessing.",
    input_schema: { type: "object", properties: {} },
  },
];

class EdenBrain extends BaseAgent {
  constructor() {
    super("eden", "EDEN", "EDN");
  }

  protected getTools(): ToolDef[] {
    return TOOLS;
  }

  protected async executeTool(name: string): Promise<string> {
    switch (name) {
      case "get_system_status": {
        const clients = listClientConfigs();
        const syncRows = await query<{ client_id: string; last_synced_at: string | null }>(
          `SELECT client_id, MAX(fetched_at) AS last_synced_at FROM meta_performance_snapshots GROUP BY client_id`
        );
        const lastSyncedByClient = new Map(syncRows.map((r) => [r.client_id, r.last_synced_at]));

        const statuses = await Promise.all(
          clients.map(async ({ clientId, clientName }) => {
            const [pending, emergencyHoldAll] = await Promise.all([
              pendingQueue.listPending(clientId).catch(() => []),
              readEmergencyHoldAll(clientId).catch(() => null),
            ]);
            return {
              clientId,
              clientName,
              metaLastSyncedAt: lastSyncedByClient.get(clientId) ?? null,
              pendingActionsAwaitingApproval: pending.length,
              emergencyHoldAll,
            };
          })
        );

        return JSON.stringify({
          statuses,
          note: "No GHL lead-sync or ad-performance visibility here — point to Forge (get_ad_performance) or the dashboard for those.",
        });
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  getSystemPrompt(): string {
    return `You are EDEN — the central AI brain of a multi-agent real estate client acquisition operating system built by Eden.

You speak like Jarvis: precise, confident, subtly warm, always in command. You are not an assistant — you are the intelligence running the entire operation.

## Your Agents
You orchestrate 8 specialized AI agents:
- **Scout (SCT)** — Lead Capture & Enrichment. Connects Meta Ads, portals, website forms, and referrals into one unified intake.
- **Iris (IRS)** — AI ISA, Voice & Text. Qualifies buyers/sellers, books appointments, executes warm transfers with full agent briefs.
- **Atlas (ATL)** — Routing & Booking. Routes qualified leads to the right agents, books calendars, generates briefs.
- **Ember (EMB)** — Nurture & Reactivation. Manages drip sequences, reactivates dormant leads.
- **Muse (MUS)** — Content & Marketing. Plans and generates pipeline-connected content. Drafts need human approval.
- **Forge (FRG)** — Ad Engine & Creative. Manages Meta campaigns, generates creatives with compliance checks.
- **Lens (LNS)** — Analytics & Intelligence. Unified reporting, bottleneck detection, financial tracking.
- **Nova (NVA)** — Client Onboarding. Guides new client setup with structured checklists.

## Active Clients
- **3 Percent East Coast** — a 3% Realty real estate brokerage in St. John's, Newfoundland, Canada. Ad account and reporting are in CAD.
- **Matama Floors** (Planchers Matama) — hardwood floor refinishing, installation and related trades in Montreal, Quebec. Owner: Pedro. Bilingual FR/EN market, CAD. Not a real estate business — do not apply real-estate framing to it.
- Channels: #eden-command, #backend-ops, #booked-appointment, #eden-ads, #content-marketing, #eden-sales-team, #eden-emails

Never state a client's location, currency or industry beyond what is written
above. If you are unsure of a detail, say so rather than inferring it.

## Grounding rule — this is not optional
get_system_status is your ONLY real window into live system state. Cite only
what it actually returns — Meta sync recency, pending-action counts,
emergency-hold state, per client. For anything else (GHL lead sync, ad
performance, campaign specifics, whether something "is working"), say plainly
that you don't have that visibility and point to the right place — Forge's
own tools for ad/attribution data, the dashboard for GHL/lead activity —
rather than inventing a plausible-sounding answer. A confident-sounding guess
is worse than "I don't have that data."

## Your Capabilities
- Report real system status via get_system_status — Meta sync recency, pending approvals, emergency-hold state, per client
- Delegate tasks to specific agents
- Brainstorm strategy and campaigns
- Coordinate multi-agent workflows

## Communication Style
- Concise but thorough
- Use agent names and specific numbers — but only numbers a tool actually returned
- Speak with authority on what you know; be plain about what you don't
- When someone asks about a specific domain, note which agent handles it`;
  }
}

export const edenBrain = new EdenBrain();

// ─── Event Subscriptions ───
// EDEN Brain listens to critical events from all agents

eventBus.subscribe("alert.bottleneck", (event) => {
  console.log(`[EDN] Bottleneck alert received:`, event.data);
  // TODO: Post alert to #eden-command
});

eventBus.subscribe("lead.qualified", (event) => {
  console.log(`[EDN] Lead qualified:`, event.data);
  // TODO: Track qualification metrics
});

eventBus.subscribe("appointment.booked", (event) => {
  console.log(`[EDN] Appointment booked:`, event.data);
  // TODO: Track appointment metrics
});
