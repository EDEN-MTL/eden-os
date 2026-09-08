/**
 * Scout's bi-weekly team check-in page: a public, no-login webpage
 * (server/checkin-api.ts serves it) showing a client's real GHL
 * appointments from the last 2 months, grouped by team, with a handful of
 * checkboxes a team lead can tick off per appointment. Appointment data
 * itself is always read live from GHL — only the checkbox state is ours
 * to store (scout_appointment_checkins).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { query } from "../../shared/db";
import { getGhlConfig, listCalendarEvents } from "../../shared/ghl";

const CHECKIN_WINDOW_DAYS = 60;

export const CHECKBOX_FIELDS = [
  "still_in_conversation",
  "showed_up",
  "deal_progressing",
  "deal_closed",
  "contract_signed",
] as const;
export type CheckboxField = (typeof CHECKBOX_FIELDS)[number];

export interface CheckinAppointment {
  ghlEventId: string;
  prospectName: string;
  appointmentAt: string;
  status: string;
  checkboxes: Record<CheckboxField, boolean>;
}

export interface CheckinTeam {
  teamName: string;
  teamLead: string;
  members: { name: string; appointments: CheckinAppointment[] }[];
}

export interface CheckinData {
  clientName: string;
  periodStart: string;
  periodEnd: string;
  teams: CheckinTeam[];
  unassigned: CheckinAppointment[];
}

// Same local-copy convention shared/scheduler/index.ts and
// agents/forge/ads/rule-seed.ts already use for reading a client config —
// returns `any` because these JSON files carry far more than ClientConfig
// types today (industry, market, scout, teams, ...).
function loadClientJson(clientId: string): any | null {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), "config", "clients", `${clientId}.json`), "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Strips the known GHL booking-page title prefixes to get the prospect's
 * name — e.g. "Buyer Consultation with Kingsley Amos" -> "Kingsley Amos".
 * Falls back to the raw title for anything that doesn't match (never
 * throws — a booking-page copy change shouldn't break this page).
 */
export function parseProspectName(title: string): string {
  const prefixes = ["Buyer Consultation with ", "Home Selling Consultation with "];
  for (const prefix of prefixes) {
    if (title.startsWith(prefix)) return title.slice(prefix.length).trim();
  }
  return title;
}

async function resolveClientId(token: string): Promise<string | null> {
  const rows = await query<{ client_id: string }>(
    "SELECT client_id FROM scout_checkin_links WHERE token = $1",
    [token]
  );
  return rows[0]?.client_id ?? null;
}

interface CheckinRow {
  ghl_event_id: string;
  still_in_conversation: boolean;
  showed_up: boolean;
  deal_progressing: boolean;
  deal_closed: boolean;
  contract_signed: boolean;
}

/**
 * Resolves a check-in link token all the way to shaped page data, reading
 * appointments live from GHL every time (never cached/stored) so the page
 * can never show stale appointment facts — only the checkbox state is
 * ours. Returns null for an unknown token; the caller (server/checkin-api)
 * turns that into a plain 404 without hinting at why, same non-committal
 * response Quarry's unsubscribe route already uses for its own token.
 */
export async function getCheckinData(token: string): Promise<CheckinData | null> {
  const clientId = await resolveClientId(token);
  if (!clientId) return null;

  const config = loadClientJson(clientId);
  const ghlConfig = await getGhlConfig(clientId);
  if (!config || !ghlConfig) return null;

  const now = Date.now();
  const start = now - CHECKIN_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  // Deliberately only buyer/seller — the third configured calendar
  // (scout.calendars.callback) is confirmed deleted in GHL live, 2026-09-09
  // (see config's _teamsNote); querying it would just 400.
  const calendarIds: string[] = [config.scout?.calendars?.buyer, config.scout?.calendars?.seller].filter(Boolean);

  const rawEvents: any[] = [];
  for (const calendarId of calendarIds) {
    const events = await listCalendarEvents(ghlConfig.locationId, calendarId, start, now, ghlConfig.apiKey);
    rawEvents.push(...events);
  }

  const eventIds = rawEvents.map((e) => e.id);
  const checkinRows = eventIds.length
    ? await query<CheckinRow>(
        `SELECT ghl_event_id, still_in_conversation, showed_up, deal_progressing, deal_closed, contract_signed
         FROM scout_appointment_checkins WHERE client_id = $1 AND ghl_event_id = ANY($2)`,
        [clientId, eventIds]
      )
    : [];
  const checkinByEventId = new Map(checkinRows.map((r) => [r.ghl_event_id, r]));

  function toAppointment(e: any): CheckinAppointment {
    const saved = checkinByEventId.get(e.id);
    return {
      ghlEventId: e.id,
      prospectName: parseProspectName(e.title || ""),
      appointmentAt: e.startTime,
      status: e.appointmentStatus || "unknown",
      checkboxes: {
        still_in_conversation: saved?.still_in_conversation ?? false,
        showed_up: saved?.showed_up ?? false,
        deal_progressing: saved?.deal_progressing ?? false,
        deal_closed: saved?.deal_closed ?? false,
        contract_signed: saved?.contract_signed ?? false,
      },
    };
  }

  const teamsConfig: { teamName: string; teamLead: string; members: { name: string; ghlUserId: string }[] }[] =
    config.teams || [];

  const appointmentsByMemberId = new Map<string, CheckinAppointment[]>();
  const memberIds = new Set(teamsConfig.flatMap((t) => t.members.map((m) => m.ghlUserId)));
  const unassigned: CheckinAppointment[] = [];

  for (const e of rawEvents) {
    const appt = toAppointment(e);
    const assignedId: string | undefined = e.assignedUserId;
    if (assignedId && memberIds.has(assignedId)) {
      const list = appointmentsByMemberId.get(assignedId) || [];
      list.push(appt);
      appointmentsByMemberId.set(assignedId, list);
    } else {
      unassigned.push(appt);
    }
  }

  const teams: CheckinTeam[] = teamsConfig.map((team) => ({
    teamName: team.teamName,
    teamLead: team.teamLead,
    // Only members who actually have a recent appointment are shown —
    // Jacob was explicit the page shouldn't list the whole roster.
    members: team.members
      .map((m) => ({ name: m.name, appointments: appointmentsByMemberId.get(m.ghlUserId) || [] }))
      .filter((m) => m.appointments.length > 0),
  }));

  return {
    clientName: config.clientName,
    periodStart: new Date(start).toISOString(),
    periodEnd: new Date(now).toISOString(),
    teams,
    unassigned,
  };
}

/**
 * Upserts one checkbox's state for one appointment. `field` is validated
 * against the fixed CHECKBOX_FIELDS allowlist before being interpolated
 * into the SQL column list — this is the one place a request body value
 * reaches a column name, so that check isn't optional.
 */
export async function updateCheckinItem(
  token: string,
  ghlEventId: string,
  field: string,
  value: boolean
): Promise<"ok" | "invalid-token" | "invalid-field"> {
  if (!(CHECKBOX_FIELDS as readonly string[]).includes(field)) {
    return "invalid-field";
  }
  const clientId = await resolveClientId(token);
  if (!clientId) return "invalid-token";

  await query(
    `INSERT INTO scout_appointment_checkins (client_id, ghl_event_id, ${field})
     VALUES ($1, $2, $3)
     ON CONFLICT (client_id, ghl_event_id)
     DO UPDATE SET ${field} = $3, updated_at = now()`,
    [clientId, ghlEventId, value]
  );
  return "ok";
}

/**
 * The whole check-in page: plain HTML/CSS/vanilla JS, no build step or
 * framework — the dashboard SPA (dashboards/eden-command-ui) has neither a
 * router nor a component library to borrow, and this is a separate public
 * surface anyway. Same shell regardless of token validity; the inline
 * script itself renders "link not found" on a 404 from the data API,
 * rather than the route confirming/denying validity.
 */
export function renderCheckinPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Team Check-in</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f6f7f9; color: #1a1a1a; }
  header { padding: 24px 20px 12px; }
  header h1 { margin: 0 0 4px; font-size: 20px; }
  header p { margin: 0; color: #666; font-size: 14px; }
  main { max-width: 720px; margin: 0 auto; padding: 0 16px 60px; }
  .team { margin-top: 28px; }
  .team h2 { font-size: 16px; margin: 0 0 4px; }
  .team .lead { font-size: 13px; color: #666; margin: 0 0 12px; }
  .member { margin-bottom: 8px; }
  .member h3 { font-size: 14px; margin: 0 0 6px; }
  .appt { background: #fff; border: 1px solid #e3e3e6; border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; }
  .appt-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .appt-prospect { font-weight: 600; font-size: 14px; }
  .appt-meta { font-size: 12px; color: #777; }
  .checkboxes { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
  label.cb { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
  label.cb input { width: 16px; height: 16px; }
  .saved-flash { font-size: 11px; color: #2a8a4a; opacity: 0; transition: opacity 0.2s; margin-left: 6px; }
  .saved-flash.show { opacity: 1; }
  .empty { color: #888; font-size: 14px; padding: 20px 0; }
  .error { color: #b00020; padding: 20px 0; }
</style>
</head>
<body>
<header>
  <h1 id="client-name">Loading…</h1>
  <p id="period-range"></p>
</header>
<main id="main"><p class="empty">Loading appointments…</p></main>
<script>
(function () {
  var token = window.location.pathname.split("/").filter(Boolean).pop();
  var CHECKBOX_LABELS = [
    ["still_in_conversation", "Still in conversation"],
    ["showed_up", "Showed up to appointment"],
    ["deal_progressing", "Deal is moving forward"],
    ["deal_closed", "Deal closed / won"],
    ["contract_signed", "Signed contract"]
  ];

  function fmtDate(iso) {
    try { return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }); }
    catch (e) { return iso; }
  }

  function renderAppointment(a) {
    var div = document.createElement("div");
    div.className = "appt";
    div.innerHTML =
      '<div class="appt-top"><span class="appt-prospect"></span><span class="appt-meta"></span></div>' +
      '<div class="checkboxes"></div>';
    div.querySelector(".appt-prospect").textContent = a.prospectName;
    div.querySelector(".appt-meta").textContent = fmtDate(a.appointmentAt) + " · " + a.status;

    var box = div.querySelector(".checkboxes");
    CHECKBOX_LABELS.forEach(function (pair) {
      var field = pair[0], label = pair[1];
      var wrap = document.createElement("label");
      wrap.className = "cb";
      var input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!a.checkboxes[field];
      var flash = document.createElement("span");
      flash.className = "saved-flash";
      flash.textContent = "Saved";
      input.addEventListener("change", function () {
        fetch("/api/checkin/" + encodeURIComponent(token) + "/items/" + encodeURIComponent(a.ghlEventId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ field: field, value: input.checked })
        }).then(function (res) {
          if (res.ok) {
            flash.classList.add("show");
            setTimeout(function () { flash.classList.remove("show"); }, 1200);
          }
        });
      });
      wrap.appendChild(input);
      wrap.appendChild(document.createTextNode(label));
      wrap.appendChild(flash);
      box.appendChild(wrap);
    });
    return div;
  }

  function renderTeam(team) {
    var section = document.createElement("section");
    section.className = "team";
    var h2 = document.createElement("h2");
    h2.textContent = team.teamName;
    var lead = document.createElement("p");
    lead.className = "lead";
    lead.textContent = "Team lead: " + team.teamLead;
    section.appendChild(h2);
    section.appendChild(lead);
    team.members.forEach(function (member) {
      var memberDiv = document.createElement("div");
      memberDiv.className = "member";
      var h3 = document.createElement("h3");
      h3.textContent = member.name;
      memberDiv.appendChild(h3);
      member.appointments.forEach(function (appt) { memberDiv.appendChild(renderAppointment(appt)); });
      section.appendChild(memberDiv);
    });
    return section;
  }

  fetch("/api/checkin/" + encodeURIComponent(token))
    .then(function (res) {
      if (!res.ok) throw new Error("not-found");
      return res.json();
    })
    .then(function (data) {
      document.getElementById("client-name").textContent = data.clientName + " — Bi-Weekly Check-in";
      document.getElementById("period-range").textContent = fmtDate(data.periodStart) + " – " + fmtDate(data.periodEnd);

      var main = document.getElementById("main");
      main.innerHTML = "";

      var teamsWithAppointments = data.teams.filter(function (t) { return t.members.length > 0; });
      if (teamsWithAppointments.length === 0 && data.unassigned.length === 0) {
        main.innerHTML = '<p class="empty">No recent appointments in this period.</p>';
        return;
      }
      teamsWithAppointments.forEach(function (team) { main.appendChild(renderTeam(team)); });

      if (data.unassigned.length > 0) {
        var section = document.createElement("section");
        section.className = "team";
        var h2 = document.createElement("h2");
        h2.textContent = "Needs routing";
        var note = document.createElement("p");
        note.className = "lead";
        note.textContent = "Not yet assigned to a team member in GHL";
        section.appendChild(h2);
        section.appendChild(note);
        data.unassigned.forEach(function (appt) { section.appendChild(renderAppointment(appt)); });
        main.appendChild(section);
      }
    })
    .catch(function () {
      document.getElementById("client-name").textContent = "Link not found";
      document.getElementById("main").innerHTML = '<p class="error">This check-in link is invalid or has expired. Ask Scout to resend it.</p>';
    });
})();
</script>
</body>
</html>`;
}
