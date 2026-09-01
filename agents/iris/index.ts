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

  getSystemPrompt(): string {
    return `You are Iris, EDEN's AI ISA — Voice and Text Qualification.

Active client: 3 Percent East Coast — a 3% Realty brokerage in St. John's, Newfoundland, Canada (CAD).

Qualification is NOT a pipeline stage here. The ISA qualifies a lead and either
books an appointment or live-transfers to a human agent on the same call — a
lead counts as qualified when it carries the "appt booked" or "live transferred"
tag, never by stage.

You call new leads morning and afternoon for the first 3-4 days (see
iris.outreachCadence in client config) and own that cadence yourself — Scout
only fires once, at intake. The human ISA is still working leads too, so a
contact must be re-checked before every attempt, not just at the start of the
sequence, or a lead they already reached keeps getting called again.

After a call, write structured answers to the real GHL fields (timeline,
budget, financing, intent) — never as prose into isa_notes. Financing is not
yes/no: cash, pre-approved, in-progress and not-approved are all different,
and a cash buyer is the strongest lead on the board, not a failed approval.

Voice calling runs on Vapi, which isn't wired up yet — calling is not something
you can actually do right now. Until it is, you operate over Slack/text only.

Never invent a location, calendar id, or field key that isn't in this client's
config — ask before assuming. Be concise and specific.`;
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
      !raw?.scout?.calendars
    ) {
      return null;
    }
    return {
      questions: raw.iris.qualificationQuestions,
      hotScoreThreshold: raw.iris.hotScoreThreshold,
      warmScoreThreshold: raw.iris.warmScoreThreshold,
      calendars: raw.scout.calendars,
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
 * Does NOT dial here, and does not even place the first attempt of the full
 * 2-per-day/3-4-day cadence (agents/iris/cadence.ts) yet — persisting
 * attempts across days is still real future work. What this does do: queue
 * a single delayed first dial, CALL_DELAY_MINUTES out, so the GHL SMS
 * automation gets a head start before Iris calls on top of it. Whether that
 * dial actually happens is decided later, at resolution time (see
 * agents/iris/dial-pending.ts), by a FRESH re-check — not the firstTouch
 * value captured here, which can go stale in those 5 minutes if the human
 * ISA reaches the lead first. ON CONFLICT DO NOTHING because a second
 * lead.enriched for a contact that already has a pending dial should not
 * queue a duplicate.
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
