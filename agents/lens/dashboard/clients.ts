/**
 * Which clients the Lens dashboard can show, and for each one what is connected and what is missing.
 * A client with no Meta account or no GHL credentials is listed with a plain "missing" note rather than
 * hidden or shown with empty numbers that look real.
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { query } from "../../../shared/db";
import { getGhlConfig, getLocationTimezone } from "../../../shared/ghl";
import { getMetaConfig } from "../../../shared/meta";
import type { AppointmentSource, PipelineAppointmentConfig } from "./metrics";

export const DEFAULT_TIMEZONE = "America/Toronto";

export interface DashboardConfig {
  /** Pipeline stage names that mean a deal CLOSED (the client's own outcome stages; GHL's won/lost status is not used). */
  closedStages: string[];
  /** Stages that mean the lead qualified (reached a person or an appointment). Empty = qualification metrics show N/A. */
  qualifiedStages: string[];
  /** Stages that mean the lead did not qualify. */
  unqualifiedStages: string[];
  timezone: string | null;
  /** "calendar" (default) counts GHL calendar events; "pipeline" counts from card stages and tags. */
  appointmentSource: AppointmentSource;
  pipeline?: PipelineAppointmentConfig;
}

function readClientConfig(clientId: string): any | null {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), "config", "clients", `${clientId}.json`), "utf-8"));
  } catch {
    return null;
  }
}

export function loadDashboardConfig(clientId: string): DashboardConfig {
  const raw = readClientConfig(clientId) ?? {};
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    closedStages: list(raw.lens?.dashboard?.closedStages).length ? list(raw.lens?.dashboard?.closedStages) : list(raw.ghl?.outcomeStages?.wonStages),
    qualifiedStages: list(raw.lens?.dashboard?.qualifiedStages),
    unqualifiedStages: list(raw.lens?.dashboard?.unqualifiedStages),
    appointmentSource: raw.lens?.dashboard?.appointmentSource === "pipeline" && raw.lens?.dashboard?.pipeline ? "pipeline" : "calendar",
    pipeline: raw.lens?.dashboard?.pipeline
      ? {
          bookedStages: list(raw.lens.dashboard.pipeline.bookedStages),
          attendedStages: list(raw.lens.dashboard.pipeline.attendedStages),
          noShowStages: list(raw.lens.dashboard.pipeline.noShowStages),
          bookedTags: list(raw.lens.dashboard.pipeline.bookedTags),
          attendedTags: list(raw.lens.dashboard.pipeline.attendedTags),
          noShowTags: list(raw.lens.dashboard.pipeline.noShowTags),
        }
      : undefined,
    timezone: typeof raw.lens?.dashboard?.timezone === "string" ? raw.lens.dashboard.timezone : typeof raw.iris?.timezone === "string" ? raw.iris.timezone : null,
  };
}

/** Every client config on disk. */
export function allClientIds(): string[] {
  try {
    return readdirSync(join(process.cwd(), "config", "clients")).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

/** Clients whose GHL appointments should be synced: any client with a GHL location configured. */
export function clientsWithLens(): string[] {
  return allClientIds().filter((id) => Boolean(readClientConfig(id)?.ghl?.locationId));
}

export interface LensClient {
  clientId: string;
  name: string;
  timezone: string;
  meta: { connected: boolean; adAccountId: string | null; lastDay: string | null };
  ghl: { connected: boolean; lastLeadSync: string | null; lastAppointmentSync: string | null; leads: number; appointments: number };
  /** Plain-language list of what is not connected or not synced yet. Empty when everything is in place. */
  missing: string[];
}

/** The account's timezone: Lens config, then Iris config, then GHL's own location setting, then Toronto. */
export async function clientTimezone(clientId: string): Promise<string> {
  const configured = loadDashboardConfig(clientId).timezone;
  if (configured) return configured;
  const ghl = await getGhlConfig(clientId).catch(() => null);
  const live = ghl ? await getLocationTimezone(ghl.locationId, ghl.apiKey).catch(() => null) : null;
  return live || DEFAULT_TIMEZONE;
}

export async function listLensClients(): Promise<LensClient[]> {
  const out: LensClient[] = [];
  for (const clientId of allClientIds()) {
    const raw = readClientConfig(clientId) ?? {};
    const missing: string[] = [];

    const meta = await getMetaConfig(clientId).catch(() => null);
    const lastDay = (await query<{ d: string | null }>(`SELECT max(date_start)::text AS d FROM meta_performance_snapshots WHERE client_id = $1`, [clientId]).catch(() => []))[0]?.d ?? null;
    if (!meta) missing.push("No Meta ad account connected");
    else if (!lastDay) missing.push("Meta is connected but no ad data has synced yet");

    const ghl = await getGhlConfig(clientId).catch(() => null);
    const leadStats = (await query<{ n: string; last: Date | null }>(`SELECT count(*) AS n, max(updated_at) AS last FROM ad_leads WHERE client_id = $1`, [clientId]).catch(() => []))[0];
    const apptStats = (await query<{ n: string; last: Date | null }>(`SELECT count(*) AS n, max(synced_at) AS last FROM ghl_appointments WHERE client_id = $1`, [clientId]).catch(() => []))[0];
    const leads = Number(leadStats?.n ?? 0);
    const appointments = Number(apptStats?.n ?? 0);
    if (!ghl) missing.push("No GoHighLevel connection");
    else {
      if (leads === 0) missing.push("No GHL leads synced yet");
      if (!apptStats?.last && loadDashboardConfig(clientId).appointmentSource === "calendar") missing.push("GHL appointments have not synced yet");
    }
    const dash = loadDashboardConfig(clientId);
    if (dash.closedStages.length === 0) missing.push("No closed-deal stage configured, so closed deals and revenue cannot be counted");

    out.push({
      clientId,
      name: raw.clientName ?? clientId,
      timezone: await clientTimezone(clientId),
      meta: { connected: Boolean(meta), adAccountId: meta?.adAccountId ?? null, lastDay },
      ghl: {
        connected: Boolean(ghl),
        lastLeadSync: leadStats?.last ? new Date(leadStats.last).toISOString() : null,
        lastAppointmentSync: apptStats?.last ? new Date(apptStats.last).toISOString() : null,
        leads,
        appointments,
      },
      missing,
    });
  }
  return out;
}
