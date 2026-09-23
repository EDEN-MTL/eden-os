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

export interface EmberConfig {
  /**
   * The kill switch. Off by default, same pattern as Iris's
   * iris_calling_enabled: scanning still runs (it only reads GHL and writes
   * our own table, so it's how a dry run is validated), but nothing is ever
   * SENT while this is false.
   */
  enabled: boolean;
  /** Pipeline to scan. Usually the same as scout.pipelineId. */
  pipelineId: string;
  /** An open card with no stage change for this many days is dormant. */
  dormancyThresholdDays: number;
  /**
   * Stage NAMES never enrolled even if quiet — columns where a human is
   * already working the deal (an appointment set, a listing live), so an
   * automated "still thinking about buying?" text would be tone-deaf.
   * Won/lost/active stages from ghl.outcomeStages are excluded on top of
   * this without needing to be repeated here.
   */
  excludeStages: string[];
  /**
   * CASL: an inquiry gives implied consent for commercial messages for 6
   * months from the inquiry — not indefinitely. Leads whose opportunity was
   * created longer ago than this are never enrolled, and a lead that ages
   * past it mid-cadence is completed rather than sent to. Only raise this
   * for a client that genuinely collects express consent at capture.
   */
  consentWindowDays: number;
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
     * One template per touch index; a cadence longer than the list reuses
     * the last one. SMS is preferred whenever the contact has a phone.
     */
    sms: { enabled: boolean; templates: string[] };
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
    if (!sms.templates.length) problems.push("sms.templates is empty");
    // CASL requires an unsubscribe mechanism in every commercial message.
    // GHL honours STOP replies natively (it sets the contact's DND), but
    // only if the text tells people they can.
    sms.templates.forEach((t, i) => {
      if (!/\bstop\b/i.test(t)) problems.push(`sms.templates[${i}] has no STOP opt-out line`);
    });
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
