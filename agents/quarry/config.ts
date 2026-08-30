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
  searches: SearchSpec[];
  discovery: { recheckAfterDays: number; maxLeadsPerRun: number };
  triage: {
    outdatedSignals: string[];
    copyrightYearBefore: number;
    visionScoring: boolean;
    visionScoreThreshold: number;
  };
  phone: {
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
  };
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
