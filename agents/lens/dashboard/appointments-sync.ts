/**
 * Copies a client's GHL appointments into ghl_appointments so the Lens dashboard can report booked,
 * confirmed, attended and no-show appointments from our own database.
 *
 * GHL's per-contact appointment list misses some bookings (see getContactAppointments), so this reads each
 * calendar's events over a time window instead. It re-reads a rolling window every hour (statuses change
 * when an agent marks a show or no-show) and upserts, so running it twice never doubles anything.
 */
import { query } from "../../../shared/db";
import { getGhlConfig, listCalendarEvents, listCalendars } from "../../../shared/ghl";
import { clientsWithLens } from "./clients";

export type AppointmentStatus = "booked" | "confirmed" | "attended" | "no_show" | "cancelled" | "invalid" | "deleted";

/** GHL's appointmentStatus values: new, confirmed, cancelled, showed, noshow, invalid. */
export function normalizeAppointmentStatus(raw: string | null | undefined, deleted = false): AppointmentStatus {
  if (deleted) return "deleted";
  const s = String(raw ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (s === "confirmed") return "confirmed";
  if (s === "showed" || s === "show" || s === "attended" || s === "completed") return "attended";
  if (s === "noshow") return "no_show";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  if (s === "invalid") return "invalid";
  return "booked"; // "new" and anything unrecognised: booked, outcome not recorded
}

export interface AppointmentRowInput {
  appointmentId: string;
  contactId: string | null;
  calendarId: string | null;
  title: string | null;
  startTime: Date;
  endTime: Date | null;
  bookedAt: Date | null;
  status: AppointmentStatus;
  rawStatus: string | null;
  assignedUserId: string | null;
}

function instant(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** One GHL calendar event -> one row, or null when it has no usable id or start time. */
export function toAppointmentRow(event: any): AppointmentRowInput | null {
  const start = instant(event?.startTime);
  if (!event?.id || !start) return null;
  const rawStatus = event.appointmentStatus ?? event.appoinmentStatus ?? event.state ?? null;
  return {
    appointmentId: String(event.id),
    contactId: event.contactId ?? null,
    calendarId: event.calendarId ?? null,
    title: event.title ?? null,
    startTime: start,
    endTime: instant(event.endTime),
    bookedAt: instant(event.dateAdded),
    status: normalizeAppointmentStatus(rawStatus, event.deleted === true),
    rawStatus,
    assignedUserId: event.assignedUserId ?? null,
  };
}

const DAY_MS = 86_400_000;
/** GHL's events endpoint is read in month-sized windows. */
const WINDOW_DAYS = 30;

/**
 * Reads every calendar's events from `from` to `to` and upserts them. Rows already stored inside that window
 * that GHL no longer returns are marked deleted. Returns how many events were stored.
 */
export async function syncAppointments(clientId: string, from: Date, to: Date): Promise<number> {
  const ghl = await getGhlConfig(clientId);
  if (!ghl) return 0;
  const runStartedAt = new Date();
  const calendars = await listCalendars(ghl.locationId, ghl.apiKey);
  let stored = 0;

  for (const calendar of calendars) {
    for (let t = from.getTime(); t < to.getTime(); t += WINDOW_DAYS * DAY_MS) {
      const end = Math.min(t + WINDOW_DAYS * DAY_MS, to.getTime());
      const events = await listCalendarEvents(ghl.locationId, calendar.id, t, end, ghl.apiKey);
      for (const event of events) {
        const row = toAppointmentRow(event);
        if (!row) continue;
        await query(
          `INSERT INTO ghl_appointments
             (client_id, appointment_id, contact_id, calendar_id, title, start_time, end_time, booked_at, status, raw_status, assigned_user_id, synced_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
           ON CONFLICT (client_id, appointment_id) DO UPDATE SET
             contact_id = EXCLUDED.contact_id, calendar_id = EXCLUDED.calendar_id, title = EXCLUDED.title,
             start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time, booked_at = EXCLUDED.booked_at,
             status = EXCLUDED.status, raw_status = EXCLUDED.raw_status, assigned_user_id = EXCLUDED.assigned_user_id,
             synced_at = now()`,
          [clientId, row.appointmentId, row.contactId, row.calendarId, row.title, row.startTime, row.endTime, row.bookedAt, row.status, row.rawStatus, row.assignedUserId]
        );
        stored++;
      }
    }
  }

  // An event inside the window that this run did not see was removed from GHL.
  if (calendars.length > 0) {
    await query(
      `UPDATE ghl_appointments SET status = 'deleted', synced_at = now()
       WHERE client_id = $1 AND start_time >= $2 AND start_time < $3 AND synced_at < $4 AND status <> 'deleted'`,
      [clientId, from, to, runStartedAt]
    );
  }
  return stored;
}

/** Scheduler entry point: the rolling window, for every client Lens covers. One client failing never stops the next. */
export async function runAppointmentSync(now: Date = new Date()): Promise<void> {
  for (const clientId of clientsWithLens()) {
    try {
      const n = await syncAppointments(clientId, new Date(now.getTime() - 120 * DAY_MS), new Date(now.getTime() + 60 * DAY_MS));
      console.log(`[LENS] Synced ${n} appointments for ${clientId}.`);
    } catch (error) {
      console.error(`[LENS] Appointment sync failed for ${clientId}:`, error instanceof Error ? error.message : error);
    }
  }
}
