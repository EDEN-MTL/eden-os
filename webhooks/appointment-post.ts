import { query } from "../shared/db";
import { getGhlConfig, getContact, getContactAppointments, getCustomFieldDefs, listLocationUsers } from "../shared/ghl";
import { sendMessage } from "../shared/slack";
import { loadIrisConfig } from "../agents/iris";
import { buildKeyToId, readField } from "../agents/scout/intake";
import { formatLocal } from "../agents/iris/cadence";

/**
 * Mark, 2026-10-14: Iris posts each newly booked appointment to the same
 * Slack channel as live transfers (config iris.liveTransferSlack), as herself —
 * the GHL booked-appointment automation's notification wasn't being seen.
 * Two ways in: Iris's own book_appointment tool, and the GHL appointment
 * automation's webhook step (covers every booking a person or another
 * automation makes). Whoever gets there first posts; the other stays quiet.
 */

/** ISA notes as bullet text — accepts the old multi-line and the new one-line "a | b | c" forms, drops Iris's own call-status lines. */
export function isaNoteBullets(notes: string | null | undefined): string[] {
  return (notes ?? "")
    .split(/\n| \| /)
    .map((line) => line.trim())
    .filter((line) => line && !/^Iris( call|:)/.test(line));
}

export interface AppointmentPost {
  intent: string | null | undefined;
  clientLabel: string;
  agentName: string | null;
  leadName: string;
  /** Already formatted for reading ("Friday, October 9 at 4:00 PM"). */
  when: string | null;
  bookedBy: string | null;
  notes: string | null;
}

export function formatAppointmentPost(post: AppointmentPost): string {
  const kind = post.intent === "seller" || post.intent === "downsize" || post.intent === "upgrading" ? "Seller" : "Buyer";
  const bullets = isaNoteBullets(post.notes);
  const lines = [`${kind} Appointment Booked for ${post.clientLabel} with ${post.agentName ?? "an agent (not assigned yet)"}`, `Name: ${post.leadName}`];
  if (post.when) lines.push(`When: ${post.when}`);
  if (post.bookedBy) lines.push(`Booked by: ${post.bookedBy}`);
  if (bullets.length > 0) lines.push("", `ISA NOTES: ${bullets.map((b) => `- ${b}`).join("\n")}`);
  return lines.join("\n");
}

/**
 * GHL appointments report startTime as local wall-clock "2026-10-09 16:00:00"
 * (no zone) — read it as written. A real ISO instant (Z or offset) is
 * converted to the client's timezone instead.
 */
export function formatAppointmentTime(startTime: string | null | undefined, timeZone: string): string | null {
  if (!startTime) return null;
  const raw = String(startTime).trim();
  let hour: number, minute: number, date: Date;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const instant = new Date(raw);
    if (Number.isNaN(instant.getTime())) return null;
    return formatLocal(instant.toISOString(), timeZone);
  }
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  hour = Number(m[4]);
  minute = Number(m[5]);
  const day = date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${day} at ${h12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

/**
 * Best-effort: the booking already happened, so any failure is logged and
 * never affects it. `appointmentId` pins which booking; without it, the
 * contact's newest non-cancelled appointment is used.
 */
export async function postAppointmentToSlack(
  clientId: string,
  contactId: string,
  options: { appointmentId?: string | null; bookedBy?: string | null } = {}
): Promise<void> {
  let claimId: string | null = null;
  try {
    const config = loadIrisConfig(clientId);
    const target = config?.liveTransferSlack;
    if (!config || !target) return;
    const ghlConfig = await getGhlConfig(clientId);
    if (!ghlConfig) return;

    const appointments = (await getContactAppointments(contactId, ghlConfig.locationId, ghlConfig.apiKey).catch(() => [])) as any[];
    const live = appointments.filter((a) => !/cancel/i.test(String(a?.appointmentStatus ?? "")));
    const appointment = options.appointmentId
      ? live.find((a) => a.id === options.appointmentId)
      : [...live].sort((a, b) => String(b.dateAdded ?? "").localeCompare(String(a.dateAdded ?? "")))[0];
    if (!appointment?.id) {
      console.warn(`[APPT-POST] No appointment found to post for ${clientId}/${contactId} (id=${options.appointmentId ?? "none"})`);
      return;
    }

    // One post per appointment, whichever path arrives first.
    const claim = await query<{ id: string }>(
      `INSERT INTO appointment_posts (client_id, appointment_id, contact_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (client_id, appointment_id) DO NOTHING
       RETURNING id`,
      [clientId, appointment.id, contactId]
    );
    if (claim.length === 0) return;
    claimId = claim[0].id;

    const contactResp = await getContact(contactId, ghlConfig.locationId, ghlConfig.apiKey);
    const contact = contactResp?.contact ?? contactResp;
    const leadName = [contact?.firstName, contact?.lastName].filter(Boolean).join(" ").trim() || contact?.name || contactId;
    const defs = await getCustomFieldDefs(ghlConfig.locationId, ghlConfig.apiKey);
    const notes = readField(contact?.customFields, config.callbackNotesFieldKey, buildKeyToId(defs)) ?? null;

    const agentId = appointment.assignedUserId || contact?.assignedTo;
    let agentName: string | null = null;
    if (agentId) {
      const users = await listLocationUsers(ghlConfig.locationId, ghlConfig.apiKey).catch(() => []);
      agentName = users.find((u) => u.id === agentId)?.name ?? null;
    }

    const pending = await query<{ lead: { intent?: string | null } | null }>(
      `SELECT lead FROM iris_pending_calls WHERE client_id = $1 AND contact_id = $2`,
      [clientId, contactId]
    );
    const intent = pending[0]?.lead?.intent ?? (((contact?.tags ?? []) as string[]).includes("seller lead") ? "seller" : "buyer");

    await sendMessage("iris", {
      channel: target.channel,
      text: formatAppointmentPost({
        intent,
        clientLabel: target.clientLabel,
        agentName,
        leadName,
        when: formatAppointmentTime(appointment.startTime, config.timezone || "America/St_Johns"),
        bookedBy: options.bookedBy ?? null,
        notes,
      }),
    });
  } catch (error) {
    console.error(`[APPT-POST] Failed to post the appointment for ${contactId} to Slack:`, error instanceof Error ? error.message : error);
    // Nothing was posted, so give the claim back — the other path may still manage to.
    if (claimId) await query(`DELETE FROM appointment_posts WHERE id = $1`, [claimId]).catch(() => {});
  }
}
