/**
 * Quarry's per-client config, read from config/clients/{clientId}.json under
 * the `quarry` key. Nothing here is hardcoded in agent code — search queries,
 * thresholds, message templates and the kill switch all live in the config,
 * matching how forge/ads reads its own block.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { QuarryCategory } from "./types";

export interface SearchSpec {
  query: string;
  category: QuarryCategory;
  maxResults: number;
}

export interface QuarryConfig {
  enabled: boolean;
  /**
   * When true, a lead qualified on a hard technical fact (no site, no
   * HTTPS, not mobile-responsive, stale markup) is approved automatically
   * — no human click required. A lead qualified ONLY by the vision pass's
   * "looks dated" judgment is left pending regardless, and posted to
   * reviewChannel instead. See isHighConfidenceCandidate in triage.ts,
   * which is what actually draws that line.
   */
  autoApprove: boolean;
  /** Slack channel auto-approve posts judgment-call leads to for review. */
  reviewChannel: string;
  /** The GHL pipeline built by hand — see sync.ts, which resolves it by name. */
  ghlPipeline: { name: string; stages: string[] };
  searches: SearchSpec[];
  discovery: { recheckAfterDays: number; maxLeadsPerRun: number };
  triage: {
    outdatedSignals: string[];
    copyrightYearBefore: number;
    visionScoring: boolean;
    visionScoreThreshold: number;
  };
  phone: {
    /** Off by default since 2026-08-27 — email is the primary channel and this
     *  was the only thing gating SMS. Twilio is not called at all while this
     *  is false; every lead's isMobile stays null. */
    enabled: boolean;
    provider: string;
    cacheDays: number;
    voipPolicy: "holdout" | "reject" | "allow";
  };
  generation: { generator: string; bookingUrl: string };
  outreach: {
    senderName: string;
    dailySendCap: number;
    minSendSpacingSeconds: number;
    jitterSeconds: number;
    nudgeAfterDays: number;
    positiveKeywords: string[];
    negativeKeywords: string[];
    templates: { screenshot: string; link: string; nudge: string };
    email: EmailConfig;
  };
}

export interface EmailConfig {
  fromDomain: string;
  fromAddress: string;
  /**
   * The real mailing address CASL requires in every commercial email. Left
   * unset means "not configured" — sendEmailBatch refuses to run rather than
   * fabricate one or send a message missing it.
   */
  physicalAddress: string;
  dailySendCap: number;
  minSendSpacingSeconds: number;
  jitterSeconds: number;
  /**
   * Days-since-pitch thresholds, one per touch — [4, 10] means a first nudge
   * once 4 days have passed with no reply, a second once 10 have. Length of
   * this array is the total number of nudges sent; emailNudgeCount on the
   * lead tracks how many have gone out so far.
   */
  nudgeScheduleDays: number[];
  templates: { subject: string; pitch: string; nudge: string; booking: string };
}

export function loadQuarryConfig(clientId = "eden"): QuarryConfig | null {
  try {
    const raw = JSON.parse(
      readFileSync(join(process.cwd(), "config", "clients", `${clientId}.json`), "utf-8")
    );
    return raw?.quarry ?? null;
  } catch {
    return null;
  }
}

/**
 * Fills {{placeholders}} in a configured message template. Deliberately dumb:
 * an unknown key is left in place rather than replaced with "undefined", so a
 * typo in the config shows up as literal `{{businessNam}}` in the review
 * queue instead of shipping a broken sentence to a stranger.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key) =>
    key in vars ? vars[key] : whole
  );
}
