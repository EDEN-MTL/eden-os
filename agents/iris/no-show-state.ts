/**
 * Iris's no-show follow-up, the parts everything else shares: the queue
 * source tag, reading a lead's appointments, and the check "is this still a
 * no-show nobody has dealt with?". Kept free of the call and text code so the
 * dial queue, the SMS handler and the webhook can all import it without a
 * cycle. The scanner that starts a follow-up is in no-show.ts.
 *
 * Mark, 2026-10-20: leads who did not show for an appointment with a 3%
 * agent are dragged into the No-Show column by that agent; Iris follows up.
 */
import { getContactAppointments, getGhlConfig, listOpportunitiesForContact, listPipelines } from "../../shared/ghl";
import { zonedHourToUtc } from "./cadence";

/** Source tag on iris_pending_calls rows that belong to a no-show follow-up. */
export const NO_SHOW_SOURCE = "no-show";

export interface Appointment {
  id?: string;
  startTime?: string | null;
  appointmentStatus?: string | null;
  status?: string | null;
  assignedUserId?: string | null;
  title?: string | null;
}

/**
 * GHL reports startTime as local wall-clock "2026-10-16 10:00:00" with no
 * zone (a real ISO instant with Z/offset is also accepted). Returns the real
 * instant, or null when it can't be read.
 */
export function appointmentInstant(startTime: string | null | undefined, timeZone: string): Date | null {
  if (!startTime) return null;
  const raw = String(startTime).trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const instant = new Date(raw);
    return Number.isNaN(instant.getTime()) ? null : instant;
  }
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const base = zonedHourToUtc(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), timeZone);
  return new Date(base.getTime() + Number(m[5]) * 60_000);
}

function statusOf(a: Appointment): string {
  return String(a.appointmentStatus ?? a.status ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

/** An appointment that is gone for good (cancelled / invalid) — it is neither missed nor upcoming. */
function isVoid(a: Appointment): boolean {
  const s = statusOf(a);
  return s === "cancelled" || s === "canceled" || s === "invalid";
}

export interface AppointmentPicture {
  /** The one they missed: the newest marked no-show, else the newest that already started and was not attended. */
  missed: { appointment: Appointment; at: Date } | null;
  /** A live booking still ahead of now — someone already rebooked them. */
  upcoming: { appointment: Appointment; at: Date } | null;
}

export function readAppointments(appointments: Appointment[], now: Date, timeZone: string): AppointmentPicture {
  const dated = appointments
    .filter((a) => !isVoid(a))
    .map((appointment) => ({ appointment, at: appointmentInstant(appointment.startTime, timeZone) }))
    .filter((x): x is { appointment: Appointment; at: Date } => x.at !== null)
    .sort((a, b) => b.at.getTime() - a.at.getTime());

  const upcoming = dated.find((x) => x.at.getTime() > now.getTime() && statusOf(x.appointment) !== "noshow" && statusOf(x.appointment) !== "showed") ?? null;
  const marked = dated.find((x) => statusOf(x.appointment) === "noshow");
  const attendedStatuses = new Set(["showed", "completed"]);
  const missed = marked ?? dated.find((x) => x.at.getTime() <= now.getTime() && !attendedStatuses.has(statusOf(x.appointment))) ?? null;
  return { missed, upcoming };
}

/**
 * How to name the missed day out loud: "today", "yesterday", "Thursday" (inside
 * the last week) or "October 8". Days are compared on the client's calendar.
 */
export function describeMissedDay(missedAt: Date, now: Date, timeZone: string): string {
  const day = (d: Date) => {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    return Date.UTC(Number(parts.slice(0, 4)), Number(parts.slice(5, 7)) - 1, Number(parts.slice(8, 10)));
  };
  const daysAgo = Math.round((day(now) - day(missedAt)) / 86_400_000);
  if (daysAgo <= 0) return "today";
  if (daysAgo === 1) return "yesterday";
  if (daysAgo < 7) return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(missedAt);
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "long", day: "numeric" }).format(missedAt);
}

/** What Iris needs to know about the missed appointment, stored on the queue row's lead JSON so every later step reads the same thing. */
export interface NoShowContext {
  agentName: string | null;
  /** "yesterday", "Thursday", "October 8" — ready to drop into a sentence. */
  missedDay: string;
  /** "Thursday, October 15 at 11:00 AM" — for notes and Slack. */
  missedWhen: string;
}

export type NoShowCheck =
  | { applies: true }
  | { applies: false; reason: string }
  /** GHL could not be read — callers wait and try again rather than guess. */
  | { applies: "unknown" };

/**
 * Is this lead still a no-show nobody has dealt with? False when the card is
 * no longer in the No-Show column (an agent moved it on), or when they already
 * have a live appointment ahead (rebooked by Iris, by an agent, or by the lead).
 * Run before every call and before the first text.
 */
export async function noShowStillApplies(clientId: string, contactId: string, stageName: string, timeZone: string): Promise<NoShowCheck> {
  try {
    const ghl = await getGhlConfig(clientId);
    if (!ghl) return { applies: "unknown" };
    const pipelines = await listPipelines(ghl.locationId, ghl.apiKey);
    const stageIds = new Set<string>();
    for (const p of pipelines) for (const s of p.stages ?? []) if (String(s.name).trim().toLowerCase() === stageName.trim().toLowerCase()) stageIds.add(s.id);
    if (stageIds.size === 0) return { applies: "unknown" };

    const opportunities = await listOpportunitiesForContact(contactId, ghl.locationId, ghl.apiKey);
    if (!opportunities.some((o) => stageIds.has(o.pipelineStageId))) return { applies: false, reason: `no longer in ${stageName} — an agent moved it` };

    const picture = readAppointments(await getContactAppointments(contactId, ghl.locationId, ghl.apiKey), new Date(), timeZone);
    if (picture.upcoming) return { applies: false, reason: "already has an appointment booked ahead" };
    return { applies: true };
  } catch (error) {
    console.error(`[IRS-NOSHOW] Could not check ${contactId}:`, error instanceof Error ? error.message : error);
    return { applies: "unknown" };
  }
}

/**
 * The first text. Plain and short, from Iris by name, with the opt-out line
 * every proactive text carries. Never claims anything beyond "we missed each
 * other"; it does not blame them.
 */
export function buildNoShowText(firstName: string, brandName: string, context: NoShowContext): string {
  const who = context.agentName ? ` with ${context.agentName.split(" ")[0]}` : "";
  const name = firstName && firstName !== "there" ? firstName : "there";
  return `Hi ${name}, it's Iris from ${brandName}. Looks like we missed each other for your appointment${who} ${["today", "yesterday", "recently"].includes(context.missedDay) ? context.missedDay : `on ${context.missedDay}`}. No worries, it happens! Want me to find you another time? Reply STOP to opt out.`;
}
