/**
 * Module 1b — website quality triage.
 *
 * Decides whether a business is worth pitching. Two independent paths:
 *
 *  1. Technical checks on the fetched homepage — cheap, deterministic, and
 *     catch the obvious cases (no site, dead site, no HTTPS, not responsive).
 *  2. An optional Claude vision pass for the harder case: a site that passes
 *     every technical check and still looks like 2009. Those are the leads
 *     worth the most, because the owner usually knows and has been putting it
 *     off — but no regex finds them.
 *
 * A business with NO website is the strongest signal and is qualified without
 * any fetch at all.
 */
import { TriageResult } from "./types";

export interface TriageOptions {
  outdatedSignals: string[];
  copyrightYearBefore: number;
  /** Wall-clock budget for the homepage fetch. */
  timeoutMs?: number;
  /**
   * A business with no website is normally qualified outright (see
   * triageMissingSite). Set false to skip that path entirely: with email as
   * the only send channel, enrichContact has no page to scrape a contact
   * email from on exactly these leads, so under an email-only setup they
   * qualify but can never be sent to (see the contactability gate in
   * pipeline.ts). Defaults true — nothing changes unless a client config
   * explicitly opts out.
   */
  qualifyMissingWebsite?: boolean;
}

export interface FetchedPage {
  ok: boolean;
  status: number;
  finalUrl: string;
  html: string;
}

/**
 * Fetches a homepage defensively. A prospect's site is by definition likely to
 * be broken, so every failure mode here is expected traffic, not an exception:
 * timeouts, bad certs, and 500s are all *signals*, and each returns a result
 * rather than throwing.
 */
export async function fetchHomepage(
  url: string,
  timeoutMs = 12000
): Promise<FetchedPage | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        // Identifying rather than impersonating a browser. Some hosts serve a
        // different page to unknown agents, but pretending to be Chrome to a
        // stranger's server is not a thing to do quietly.
        "User-Agent": "EdenQuarryBot/1.0 (+https://edenmtl.com)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    const html = await res.text();
    return { ok: res.ok, status: res.status, finalUrl: res.url || url, html };
  } catch (error) {
    return { error: (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

const VIEWPORT_RE = /<meta[^>]+name=["']?viewport["']?/i;
const COPYRIGHT_RE = /(?:©|&copy;|copyright)[^0-9]{0,20}(19|20)\d{2}/gi;

/** Latest copyright year on the page, or null if none is stated. */
export function latestCopyrightYear(html: string): number | null {
  const years: number[] = [];
  for (const match of html.matchAll(COPYRIGHT_RE)) {
    const year = Number(match[0].match(/(19|20)\d{2}/)?.[0]);
    if (year) years.push(year);
  }
  // The LATEST year, not the first. Plenty of sites carry an old founding date
  // next to a current copyright line, and taking the first match would flag a
  // perfectly maintained site as abandoned.
  return years.length ? Math.max(...years) : null;
}

/** Technical triage of a site we managed to fetch. */
export function triageHtml(
  page: FetchedPage,
  options: TriageOptions
): TriageResult {
  const reasons: string[] = [];
  const html = page.html;

  if (!page.ok) reasons.push(`Homepage returned HTTP ${page.status}`);
  if (page.finalUrl.startsWith("http://")) reasons.push("No HTTPS");
  if (!VIEWPORT_RE.test(html)) reasons.push("No viewport meta tag — not mobile responsive");

  const year = latestCopyrightYear(html);
  if (year !== null && year < options.copyrightYearBefore) {
    reasons.push(`Copyright reads ${year}`);
  }

  const lower = html.toLowerCase();
  for (const signal of options.outdatedSignals) {
    if (lower.includes(signal.toLowerCase())) reasons.push(`Outdated markup: ${signal}`);
  }

  return { isCandidate: reasons.length > 0, reasons };
}

/**
 * True when a lead's qualification rests on at least one hard, checkable
 * fact (no site, no HTTPS, not mobile-responsive, stale copyright/markup) —
 * not solely on the vision pass's subjective "this looks dated" judgment.
 *
 * Why this distinction and not just "isCandidate": the vision path only ever
 * runs on a site the technical checks already cleared (see pipeline.ts), so
 * a lead qualified purely by looks carries exactly one reason and it always
 * starts with "Looks dated" — a judgment call, not a fact a business owner
 * could independently verify. That is the one case worth a second pair of
 * eyes before auto-approving; a missing HTTPS certificate is not.
 */
export function isHighConfidenceCandidate(reasons: string[]): boolean {
  return reasons.some((r) => !r.startsWith("Looks dated"));
}

/** A business with no website at all — qualified without spending a request. */
export function triageMissingSite(): TriageResult {
  return { isCandidate: true, reasons: ["No website listed on Google"] };
}

/** A site we could not load at all. Unreachable is as good as absent. */
export function triageUnreachable(error: string): TriageResult {
  return { isCandidate: true, reasons: [`Site unreachable: ${error}`] };
}

/**
 * Full triage for one business.
 *
 * Note the branch that matters: a site passing every technical check returns
 * isCandidate=false here, but is NOT finished — the caller may still send it
 * to the vision pass, which is the only thing that catches a technically
 * sound site that looks dated. See applyVisionScore.
 */
export async function triage(
  website: string | null,
  options: TriageOptions
): Promise<TriageResult> {
  if (!website) {
    if (options.qualifyMissingWebsite === false) return { isCandidate: false, reasons: [] };
    return triageMissingSite();
  }

  const page = await fetchHomepage(website, options.timeoutMs);
  if ("error" in page) return triageUnreachable(page.error);
  return triageHtml(page, options);
}

/**
 * Folds a vision score into a technical result.
 *
 * Scores at or above the threshold qualify a lead the technical checks
 * cleared. The reverse never happens: a low visual score does NOT rescue a
 * site that is broken or non-responsive, because "looks fine" is irrelevant
 * if it does not load on a phone.
 */
export function applyVisionScore(
  technical: TriageResult,
  score: number,
  reasoning: string,
  threshold: number
): TriageResult {
  const qualifiesOnLooks = score >= threshold;
  return {
    isCandidate: technical.isCandidate || qualifiesOnLooks,
    reasons: qualifiesOnLooks
      ? [...technical.reasons, `Looks dated (${score}/10)`]
      : technical.reasons,
    outdatedScore: score,
    outdatedReasoning: reasoning,
  };
}
