import { useCallback, useEffect, useRef, useState } from "react";
import { LensApiError, lensGet } from "../api";
import { periodQuery } from "./format";
import type { CampaignsResponse, KpiResponse, LensClient, PeriodChoice, SeriesResponse } from "./types";

export interface Report {
  kpis: KpiResponse;
  series: SeriesResponse;
  campaigns: CampaignsResponse;
}

export type ReportState =
  | { status: "idle" }
  | { status: "loading"; previous: Report | null }
  | { status: "ready"; report: Report }
  | { status: "error"; message: string; httpStatus: number | null; previous: Report | null };

export function describeError(error: unknown): { message: string; httpStatus: number | null } {
  if (error instanceof LensApiError) {
    if (error.status === 401) return { message: "The dashboard key is missing or wrong. Set VITE_DASHBOARD_API_KEY to the server's DASHBOARD_API_KEY.", httpStatus: 401 };
    if (error.status === 503) return { message: "The reporting service is not available yet: the server has no dashboard key configured.", httpStatus: 503 };
    return { message: error.message, httpStatus: error.status };
  }
  return { message: "Could not reach the reporting service. Check your connection and try again.", httpStatus: null };
}

/** Loads the client list once. */
export function useLensClients() {
  const [state, setState] = useState<{ status: "loading" } | { status: "ready"; clients: LensClient[] } | { status: "error"; message: string }>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    setState({ status: "loading" });
    lensGet<{ clients: LensClient[] }>("/clients", ctrl.signal)
      .then((r) => setState({ status: "ready", clients: r.clients }))
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        setState({ status: "error", message: describeError(e).message });
      });
    return () => ctrl.abort();
  }, [attempt]);
  return { state, retry: () => setAttempt((n) => n + 1) };
}

/**
 * Loads KPIs, trend series and the campaign table for one client and period together, so the page never shows
 * cards from one period beside charts from another. A newer request cancels the older one. Switching client
 * clears what is shown (so one client's numbers never sit under another's name); changing only the period keeps
 * the old numbers on screen, dimmed, until the new ones arrive.
 */
export function useLensReport(clientId: string | null, period: PeriodChoice) {
  const [state, setState] = useState<ReportState>({ status: "idle" });
  const [attempt, setAttempt] = useState(0);
  const shown = useRef<{ clientId: string | null; report: Report | null }>({ clientId: null, report: null });

  useEffect(() => {
    if (!clientId) {
      setState({ status: "idle" });
      return;
    }
    const ctrl = new AbortController();
    const keep = shown.current.clientId === clientId ? shown.current.report : null;
    setState({ status: "loading", previous: keep });
    const q = periodQuery(period);
    Promise.all([
      lensGet<KpiResponse>(`/${clientId}/kpis?${q}`, ctrl.signal),
      lensGet<SeriesResponse>(`/${clientId}/timeseries?${q}`, ctrl.signal),
      lensGet<CampaignsResponse>(`/${clientId}/campaigns?${q}`, ctrl.signal),
    ])
      .then(([kpis, series, campaigns]) => {
        const report = { kpis, series, campaigns };
        shown.current = { clientId, report };
        setState({ status: "ready", report });
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        setState({ status: "error", ...describeError(e), previous: keep });
      });
    return () => ctrl.abort();
  }, [clientId, period.preset, period.from, period.to, period.compare, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}
