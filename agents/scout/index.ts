import { readFileSync } from "fs";
import { join } from "path";
import { BaseAgent } from "../base-agent";
import { eventBus } from "../../shared/events";
import { normaliseLead, NormalisedLead, ScoutConfig } from "./intake";

class ScoutAgent extends BaseAgent {
  constructor() {
    super("scout", "Scout", "SCT");
  }

  getSystemPrompt(): string {
    return `You are Scout, EDEN's Lead Capture and Enrichment agent.

Active client: 3 Percent East Coast — a 3% Realty brokerage in St. John's, Newfoundland, Canada (CAD).

## How leads actually arrive here
Leads come in through the lead form (the "LF" fields) and sometimes a survey or
Facebook Lead Form. There is no single "new" stage — a lead lands directly in
Buyer Leads, Seller Leads, Downsize Leads or Upgrading Leads according to type.

Qualification is NOT a pipeline stage. The ISA qualifies and either books or
live-transfers on the same call, so a lead counts as qualified when it carries
the "appt booked" or "live transferred" tag.

## What you score on
Pre-approval is the signal the team genuinely uses — the ISA pre-screens on it.
GHL's built-in "Engagement Score" was configured but never switched on, and the
lead_score and urgency_flag fields are not connected to anything. Do not refer
to them as if they were live.

## Attribution
Nine attribution fields exist on the contact record (fbclid, utm_*,
meta_campaign/adset/ad_id). They are only populated once the landing page and
the Meta ad set URL parameters are passing them through. Until that is wired
up, most leads will have no ad attribution — say so plainly rather than
implying the ad data is there.

Be concise and specific. Cite real field names and stage names.`;
  }
}

export const scoutAgent = new ScoutAgent();

/** Per-client intake config, read from config/clients/{clientId}.json. */
function loadScoutConfig(clientId: string): ScoutConfig | null {
  try {
    const raw = JSON.parse(
      readFileSync(join(process.cwd(), "config", "clients", `${clientId}.json`), "utf-8")
    );
    return raw?.scout?.fields ? (raw.scout as ScoutConfig) : null;
  } catch {
    return null;
  }
}

/**
 * Resolves which client a GHL webhook belongs to by matching locationId,
 * rather than assuming a single client — this location is one of several.
 */
function clientIdForLocation(locationId: string): string | null {
  const dir = join(process.cwd(), "config", "clients");
  try {
    for (const file of require("fs").readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const raw = JSON.parse(readFileSync(join(dir, file), "utf-8"));
      if (raw?.ghl?.locationId === locationId) return raw.clientId;
    }
  } catch { /* fall through */ }
  return null;
}

export function processLead(payload: any, clientId: string): NormalisedLead | null {
  const config = loadScoutConfig(clientId);
  if (!config) {
    console.log(`[SCT] No scout config for ${clientId} — lead captured but not enriched.`);
    return null;
  }
  return normaliseLead(payload, config);
}

// ─── Event Subscriptions ───

eventBus.subscribe("lead.captured", (event) => {
  const clientId = clientIdForLocation(event.clientId) || event.clientId;
  const lead = processLead(event.data, clientId);
  if (!lead) return;

  console.log(
    `[SCT] ${lead.name || lead.contactId} · ${lead.intent} · score ${lead.score}` +
    ` · ${lead.qualified ? "QUALIFIED" : "unqualified"}` +
    ` · ${lead.attributed ? `ad ${lead.attribution.metaAdId}` : "no ad attribution"}`
  );
  console.log(`[SCT]   ${lead.scoreReasons.join(", ") || "no scoring signals present"}`);

  // Hot leads are worth interrupting for; the threshold lives in client config
  // under iris.hotScoreThreshold and is read by whoever acts on this event.
  eventBus.publish("lead.enriched", "scout", clientId, lead as unknown as Record<string, any>);
});
