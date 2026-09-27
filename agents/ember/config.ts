/**
 * Ember's per-client config, read from config/clients/{clientId}.json under
 * the `ember` key. Stage names, thresholds, templates and the kill switch
 * all live there — nothing client-specific is hardcoded in agent code.
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { OutcomeStageMap } from "../forge/ads/attribution";

export interface EmberEmailTemplate {
  subject: string;
  html: string;
}

export interface SmsScripts {
  buyer: string[];
  seller: string[];
  neutral: string[];
}

export interface EmberConfig {
  /**
   * The kill switch. Off by default, same pattern as Iris's
   * iris_calling_enabled. While false, NOTHING runs on its own — no
   * scheduled scan, no sends, no webhook handling, no Slack alerts. Mark,
   * 2026-09-23: "do not send replies yet, we need to check everything
   * first." The only thing that works while off is a manual dry-run
   * preview (ember_scan_preview / scripts/ember-dry-run.ts), which reads
   * GHL and writes nothing.
   */
  enabled: boolean;
  /** Pipeline to scan. Usually the same as scout.pipelineId. */
  pipelineId: string;
  /** An open card with no stage change for this many days is dormant. */
  dormancyThresholdDays: number;
  /**
   * Per-stage override of dormancyThresholdDays, by stage NAME. Mark,
   * 2026-09-25: "Replied" leads are picked up after 14 days quiet, not 45 —
   * they answered recently, and 18 of 3%'s 21 "Replied" cards were too
   * fresh for the 45-day default to ever touch.
   */
  stageDormancyDays?: Record<string, number>;
  /**
   * Stage NAMES never enrolled even if quiet — columns where a human is
   * already working the deal (an appointment set, a listing live), so an
   * automated "still thinking about buying?" text would be tone-deaf.
   * Won/lost/active stages from ghl.outcomeStages are excluded on top of
   * this without needing to be repeated here.
   */
  excludeStages: string[];
  /**
   * When non-empty, the ONLY stage names Ember enrolls from. Mark,
   * 2026-09-25: "Ember must focus on nurturing mainly in Not Yet Ready,
   * Long Term Nurturing, or Replied, for now." Everything else in the
   * pipeline is left alone, however long it's been quiet. Empty/absent =
   * every open stage not excluded above.
   */
  includeStages?: string[];
  /**
   * CASL: an inquiry gives implied consent for commercial messages for 6
   * months from the inquiry — not indefinitely. Measured from the LATEST
   * real inquiry: the original form, or the lead's own most recent message
   * that isn't a decline (history.ts consentStart). A lead past it is
   * parked as no_consent before any text goes out. Only raise this for a
   * client that genuinely collects express consent at capture.
   */
  consentWindowDays: number;
  /**
   * Mark, 2026-09-24: a lead who said "not interested", "we bought" or
   * "working with another agent" is tried again this many days after they
   * said it (180 = 6 months). Real unsubscribes are never retried.
   */
  reApproachAfterDays: number;
  /**
   * How a lead's buy/sell intent is read at enrollment, to pick a script:
   * contact tags first (they survive stage moves), then the NAME of the
   * stage the card was enrolled from. Case-insensitive.
   */
  intentTags: { buyer: string[]; seller: string[] };
  intentStages: Record<string, "buyer" | "seller" | "downsize" | "upgrading">;
  /** A tag added to the contact that counts as renewed interest. */
  renewedInterestTags: string[];
  /** Slack channel (name or id) for reactivation alerts. */
  alertChannel: string;
  /** IANA timezone the send window is evaluated in. */
  timezone: string;
  /**
   * Local hours during which a touch may go out, [startHour, endHour).
   * The send job runs every 30 minutes around the clock; without this a
   * text could land at 3am local time.
   */
  sendWindow: { startHour: number; endHour: number };
  outreach: {
    senderName: string;
    dailySendCap: number;
    minSendSpacingSeconds: number;
    jitterSeconds: number;
    /**
     * Days after enrollment for each touch — [0, 14, 35, 70] means one in
     * the first send window after enrollment, then 2, 5 and 10 weeks in. Its
     * length is the number of touches; after the last one the lead is
     * `completed`.
     *
     * The GAPS are enforced from the previous touch's actual send time, not
     * from enrollment: if sends are held back (kill switch off for a week,
     * daily cap hit), anchoring to enrollment would make every overdue touch
     * fire on consecutive days once sending resumes — four texts in four
     * days to someone who went quiet, which is the opposite of nurture.
     */
    touchScheduleDays: number[];
    positiveKeywords: string[];
    negativeKeywords: string[];
    /**
     * One script per touch index, per intent (Mark approved the buyer and
     * seller wording, 2026-09-24). Seller + downsize leads get the seller
     * script, buyer + upgrading the buyer one, anything unknown the neutral
     * one. A cadence longer than a list reuses its last entry. SMS is
     * preferred whenever the contact has a phone.
     */
    sms: { enabled: boolean; scripts: SmsScripts };
    email: {
      enabled: boolean;
      fromAddress: string;
      /** CASL requires a real mailing address in every commercial email. */
      physicalAddress: string;
      templates: EmberEmailTemplate[];
    };
  };
}

function readClientJson(clientId: string): any | null {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), "config", "clients", `${clientId}.json`), "utf-8"));
  } catch {
    return null;
  }
}

export function loadEmberConfig(clientId: string): EmberConfig | null {
  return readClientJson(clientId)?.ember ?? null;
}

/** Same source as loadOutcomeStages in forge/ads/client-config.ts. */
export function loadEmberOutcomeStages(clientId: string): OutcomeStageMap | undefined {
  return readClientJson(clientId)?.ghl?.outcomeStages ?? undefined;
}

export class EmberConfigError extends Error {
  constructor(problems: string[]) {
    super(`ember config is not safe to send with: ${problems.join("; ")}`);
    this.name = "EmberConfigError";
  }
}

/**
 * Checks the parts of the config whose absence would make a send
 * non-compliant rather than merely ugly. Run before every send batch —
 * refusing to send beats shipping a text with no opt-out.
 */
export function validateForSending(config: EmberConfig): string[] {
  const problems: string[] = [];
  const { sms, email, touchScheduleDays } = config.outreach;
  if (!touchScheduleDays?.length) problems.push("outreach.touchScheduleDays is empty");
  if (!sms.enabled && !email.enabled) problems.push("neither sms nor email is enabled");
  if (sms.enabled) {
    for (const kind of ["buyer", "seller", "neutral"] as const) {
      const list = sms.scripts?.[kind] ?? [];
      if (!list.length) problems.push(`sms.scripts.${kind} is empty`);
      // CASL requires an unsubscribe mechanism in every commercial message.
      // GHL honours STOP replies natively (it sets the contact's DND), but
      // only if the text tells people they can.
      list.forEach((t, i) => {
        if (!/\bstop\b/i.test(t)) problems.push(`sms.scripts.${kind}[${i}] has no STOP opt-out line`);
      });
    }
  }
  if (email.enabled) {
    if (!email.fromAddress) problems.push("email.fromAddress unset");
    if (!email.physicalAddress) problems.push("email.physicalAddress unset");
    if (!email.templates.length) problems.push("email.templates is empty");
    email.templates.forEach((t, i) => {
      if (!t.html.includes("{{unsubscribeUrl}}")) problems.push(`email.templates[${i}] has no {{unsubscribeUrl}}`);
      if (!t.html.includes("{{physicalAddress}}")) problems.push(`email.templates[${i}] has no {{physicalAddress}}`);
    });
  }
  return problems;
}

/**
 * Fills {{placeholders}}. An unknown key is left in place rather than
 * replaced with "undefined", matching quarry/config.ts's renderTemplate —
 * a config typo shows up as literal `{{firstNam}}` in the send log.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key) => (key in vars ? vars[key] : whole));
}

/** Every client config file that carries an `ember` block. */
export function listEmberClientIds(): string[] {
  try {
    return readdirSync(join(process.cwd(), "config", "clients"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .filter((id) => loadEmberConfig(id) !== null);
  } catch {
    return [];
  }
}

/** Which script list a lead's intent uses. */
export function scriptKindFor(intent: string): keyof SmsScripts {
  if (intent === "seller" || intent === "downsize") return "seller";
  if (intent === "buyer" || intent === "upgrading") return "buyer";
  return "neutral";
}
