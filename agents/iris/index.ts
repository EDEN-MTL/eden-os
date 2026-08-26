import { readFileSync } from "fs";
import { join } from "path";
import { BaseAgent } from "../base-agent";
import { eventBus } from "../../shared/events";
import { NormalisedLead } from "../scout/intake";
import { IrisConfig } from "./qualification";
import { totalAttempts } from "./cadence";

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
function loadIrisConfig(clientId: string): IrisConfig | null {
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

// ─── Event Subscriptions ───

/**
 * Scout emits lead.enriched once per lead, at intake, with clientId already
 * resolved (not a raw GHL locationId) and firstTouch: true only when nobody
 * has engaged the lead yet — see agents/scout/intake.ts's isFirstTouch.
 *
 * This only proves the subscription and config resolution end to end, and
 * logs the outreach sequence Iris would open. It does not place calls or
 * write to GHL: Vapi isn't wired up, and per the build brief, the specific
 * per-minute cost needs to be confirmed with Jacob before anything billable
 * runs — a "build Iris" go-ahead is not cost approval. Actually placing the
 * 2-per-day/3-4-day sequence (agents/iris/cadence.ts) needs somewhere to
 * persist attempts-made across days, which doesn't exist yet either — there
 * is nothing to schedule execution of until calling itself exists.
 */
eventBus.subscribe("lead.enriched", (event) => {
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

  const { attemptsPerDay, days } = config.outreachCadence;
  console.log(
    `[IRS] Would open a ${totalAttempts(config.outreachCadence)}-attempt outreach sequence ` +
      `(${attemptsPerDay}/day over ${days} days) for ${lead.name || lead.contactId} (${lead.phone}) ` +
      `— Vapi not wired yet.`
  );
});
