import { LensApiError } from "../api";
import type { AttributionResponse, CampaignsResponse, KpiResponse, SeriesResponse } from "./types";

export interface Failure {
  message: string;
  httpStatus: number | null;
}

/** Marks which of the four requests failed, so the message can say what could not be loaded. */
export function within<T>(part: string, request: Promise<T>): Promise<T> {
  return request.catch((error) => {
    if (error && typeof error === "object") (error as { part?: string }).part ??= part;
    throw error;
  });
}

/** Plain-language message for whatever went wrong loading the report. Never shows a stack or an internal detail. */
export function describeError(error: unknown): Failure {
  const part = error && typeof error === "object" ? (error as { part?: string }).part : undefined;
  const where = part ? ` (while loading ${part})` : "";
  if (error instanceof LensApiError) {
    switch (error.status) {
      case 401:
        return { message: "The dashboard key is missing or wrong. Set VITE_DASHBOARD_API_KEY to the server's DASHBOARD_API_KEY.", httpStatus: 401 };
      case 408:
        return { message: `The reporting service took too long to answer${where}. Try again, or pick a shorter period.`, httpStatus: 408 };
      case 429:
        return { message: "Too many requests just now. Wait a few seconds and try again.", httpStatus: 429 };
      case 502:
      case 504:
        return { message: `The reporting service is not reachable right now${where}. Try again in a moment.`, httpStatus: error.status };
      case 503:
        return { message: "The reporting service is not available yet: the server has no dashboard key configured.", httpStatus: 503 };
      default:
        // 400 and 404 carry a sentence the server wrote for people ("The start date is after the end date.").
        return { message: `${error.message}${error.status >= 500 ? where : ""}`, httpStatus: error.status };
    }
  }
  if (error instanceof Error && error.name === "AbortError") return { message: "The request was cancelled.", httpStatus: null };
  return { message: `Could not reach the reporting service${where}. Check your connection and try again.`, httpStatus: null };
}

const isArray = Array.isArray;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !isArray(v);

/**
 * A report the page can draw has the pieces it reads. If the server and the page ever disagree about the shape
 * (an old page against a new server, or a half-deployed release), say so instead of throwing while rendering.
 * Returns what is wrong, or null.
 */
export function reportProblem(r: { kpis: KpiResponse; series: SeriesResponse; campaigns: CampaignsResponse; attribution: AttributionResponse }): string | null {
  const checks: [string, boolean][] = [
    ["the numbers", isObject(r.kpis) && isArray(r.kpis.sections) && isObject(r.kpis.period) && isObject(r.kpis.client) && isArray(r.kpis.notes)],
    ["the trend charts", isObject(r.series) && isArray(r.series.points)],
    ["the campaign table", isObject(r.campaigns) && isArray(r.campaigns.rows) && isObject(r.campaigns.totals)],
    ["the attribution", isObject(r.attribution) && isArray(r.attribution.chain) && isArray(r.attribution.deals) && isArray(r.attribution.sources) && isArray(r.attribution.methodology) && isObject(r.attribution.quality)],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return bad.length ? `The reporting service sent ${bad.join(" and ")} in a form this page does not understand. Refresh the page; if it keeps happening, tell the Eden team.` : null;
}
