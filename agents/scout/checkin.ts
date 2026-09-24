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
import {
  findOpenOpportunitiesForContact,
  getGhlConfig,
  listCalendarEvents,
  listOpportunitiesPaginated,
  updateOpportunityMonetaryValue,
} from "../../shared/ghl";

const CHECKIN_WINDOW_DAYS = 60;
// Outer discovery bound for calendar events, added 2026-09-24: a deal can
// stay open well past 60 days (a slow buyer, a listing that hasn't sold),
// and calendar events need an explicit GHL fetch window — unlike
// opportunities, which we already iterate without a date bound. Anything
// found between 60 and 180 days old only survives if its contact still
// has an open opportunity (checked below); this is just how far back we
// bother looking in the first place.
const EXTENDED_LOOKBACK_DAYS = 180;

export const CHECKBOX_FIELDS = [
  "still_in_conversation",
  "showed_up",
  "deal_progressing",
  "deal_closed",
  "contract_signed",
] as const;
export type CheckboxField = (typeof CHECKBOX_FIELDS)[number];

// The one non-boolean editable field on the check-in page: an optional
// dollar estimate a team lead can fill in, added 2026-09-18 per Jacob.
// Kept separate from CHECKBOX_FIELDS (a numeric column needs different
// type validation than a boolean one) but saved through the same
// updateCheckinItem call.
export const NUMERIC_FIELDS = ["potential_commission"] as const;
export type NumericField = (typeof NUMERIC_FIELDS)[number];

export interface CheckinAppointment {
  ghlEventId: string;
  // Needed so a save can push potentialCommission into the matching GHL
  // opportunity's monetaryValue (see updateCheckinItem) — the client sends
  // this back on save since it already has it from this same response.
  contactId: string | null;
  prospectName: string;
  appointmentAt: string;
  status: string;
  checkboxes: Record<CheckboxField, boolean>;
  // null means "not entered" — distinct from "worth $0" — so the page only
  // shows a "Value: $X" line once a team lead has actually filled it in.
  potentialCommission: number | null;
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
  // node-postgres returns NUMERIC as a string (avoids silent float
  // precision loss on a dollar value) — parsed to a number when mapped
  // onto CheckinAppointment.
  potential_commission: string | null;
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

  const teamsConfig: { teamName: string; teamLead: string; members: { name: string; ghlUserId: string }[] }[] =
    config.teams || [];
  const memberIds = new Set(teamsConfig.flatMap((t) => t.members.map((m) => m.ghlUserId)));

  const now = Date.now();
  const start = now - CHECKIN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const extendedStart = now - EXTENDED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

  // Deliberately only buyer/seller — the third configured calendar
  // (scout.calendars.callback) is confirmed deleted in GHL live, 2026-09-09
  // (see config's _teamsNote); querying it would just 400.
  const calendarIds: string[] = [config.scout?.calendars?.buyer, config.scout?.calendars?.seller].filter(Boolean);

  // Fetched over the wider EXTENDED_LOOKBACK_DAYS window (not just the
  // "recent" 60 days) so a still-open deal isn't dropped just because its
  // original appointment was a while ago — anything older than 60 days
  // gets filtered back down below, unless its contact still has an open
  // opportunity.
  const rawEvents: any[] = [];
  for (const calendarId of calendarIds) {
    const events = await listCalendarEvents(ghlConfig.locationId, calendarId, extendedStart, now, ghlConfig.apiKey);
    rawEvents.push(...events);
  }

  // Live-transferred calls: opportunities sitting in the "Live Transferred"
  // pipeline stage — a different GHL object entirely from a booked
  // calendar appointment, but Jacob wants both on the same check-in page.
  // Kept purely by status (`open`), not by age: unlike calendar events,
  // this list was never date-bounded at the API level (listOpportunities
  // Paginated iterates the whole stage), so there's no separate "old but
  // still open" case to handle here the way there is for calendar events
  // below — an open one just stays, however long it's been in this stage.
  const pipelineId = config.scout?.pipelineId;
  const liveTransferStageId = config.iris?.liveTransferStageId;
  const rawLiveTransfers: any[] = [];
  if (pipelineId && liveTransferStageId) {
    for await (const opp of listOpportunitiesPaginated(ghlConfig.locationId, {
      pipelineId,
      apiKey: ghlConfig.apiKey,
    })) {
      if (opp.pipelineStageId !== liveTransferStageId) continue;
      if (opp.status !== "open") continue;
      rawLiveTransfers.push(opp);
    }
  }

  interface RawItem {
    id: string;
    contactId: string | null;
    prospectName: string;
    appointmentAt: string;
    status: string;
    // Candidate GHL user ids for "who owns this," in priority order —
    // resolved against the real roster below rather than trusted blindly,
    // because neither GHL field is reliable alone. Verified live twice
    // with contradictory results: 2026-09-09, some opportunities had
    // assignedTo null while followers[0] correctly held the real assignee.
    // 2026-09-24, two opportunities had assignedTo correctly set to a
    // real current team member (Stephanie McGrath) while followers[0]
    // still held an unrelated dead/former-user id — if followers were
    // checked first here, as it originally was, a properly-assigned lead
    // would have wrongly landed in "Needs routing". Resolved by trying
    // each candidate against the known roster (see memberIds below) and
    // taking the first one that actually matches, instead of assuming
    // either field's mere presence means it's correct.
    assignedCandidates: string[];
    assignedId: string | null;
    // Live-transfer items are already filtered to status==="open" at the
    // fetch stage above, however old — the stale/open-opportunity re-check
    // below is only meaningful for calendar events, so this flag lets that
    // step skip them rather than misreading a live-transfer's (often
    // absent) contactId as "nothing to keep it alive."
    isLiveTransfer: boolean;
  }

  let items: RawItem[] = [
    ...rawEvents.map((e) => ({
      id: e.id,
      contactId: e.contactId || null,
      prospectName: parseProspectName(e.title || ""),
      appointmentAt: e.startTime,
      status: e.appointmentStatus || "unknown",
      assignedCandidates: e.assignedUserId ? [e.assignedUserId] : [],
      assignedId: null,
      isLiveTransfer: false,
    })),
    ...rawLiveTransfers.map((o) => ({
      id: o.id,
      contactId: o.contactId || null,
      prospectName: o.name || "Unknown",
      appointmentAt: o.lastStageChangeAt || o.updatedAt,
      status: "live transferred",
      assignedCandidates: [o.assignedTo, o.followers && o.followers[0]].filter(
        (candidate: unknown): candidate is string => !!candidate
      ),
      assignedId: null,
      isLiveTransfer: true,
    })),
  ];

  // Manual per-client overrides for cases GHL's own assignedUserId/followers
  // can't resolve (a person Jacob knows the real owner of) or that should
  // simply not show up here at all (e.g. a duplicate/dead lead) — keyed by
  // GHL contactId, not by name, since names aren't guaranteed unique and a
  // contactId is stable. See config's `checkinOverrides`.
  const overrides = config.checkinOverrides || {};
  const manualAssignments: Record<string, string> = overrides.assignments || {};
  const hiddenContactIds: string[] = overrides.hidden || [];

  if (hiddenContactIds.length > 0) {
    items = items.filter((item) => !item.contactId || !hiddenContactIds.includes(item.contactId));
  }
  // A manual override always wins; otherwise take the first candidate that
  // actually matches a real, current roster member — not just whichever
  // GHL field happened to be populated first (see RawItem's comment above).
  items = items.map((item) => {
    const override = item.contactId ? manualAssignments[item.contactId] : undefined;
    const resolved = override ?? item.assignedCandidates.find((candidate) => memberIds.has(candidate)) ?? null;
    return { ...item, assignedId: resolved };
  });

  // Anything within the "recent" 60-day window always shows, same as
  // before. Anything older (only discoverable at all because calendar
  // events were fetched over EXTENDED_LOOKBACK_DAYS) only survives if its
  // contact still has a real open opportunity — otherwise the appointment
  // is genuinely done and dropping it is correct, not a bug. A failure in
  // this check itself keeps the item rather than dropping it: this whole
  // mechanism exists to stop losing real leads, so a transient GHL error
  // must never be the thing that makes one disappear.
  const staleContactIds = Array.from(
    new Set(
      items
        .filter((item) => !item.isLiveTransfer && new Date(item.appointmentAt).getTime() < start)
        .map((item) => item.contactId)
        .filter((id): id is string => !!id)
    )
  );
  const openStaleContactIds = new Set<string>();
  for (const contactId of staleContactIds) {
    try {
      const openOpportunities = await findOpenOpportunitiesForContact(contactId, ghlConfig.locationId, ghlConfig.apiKey);
      if (openOpportunities.length > 0) openStaleContactIds.add(contactId);
    } catch (error) {
      console.error(`[CHECKIN] Failed to check open-opportunity status for stale contact ${contactId} — keeping it:`, error);
      openStaleContactIds.add(contactId);
    }
  }
  items = items.filter((item) => {
    if (item.isLiveTransfer) return true; // already guaranteed open at the fetch stage
    const isRecent = new Date(item.appointmentAt).getTime() >= start;
    if (isRecent) return true;
    return item.contactId ? openStaleContactIds.has(item.contactId) : false;
  });

  const itemIds = items.map((i) => i.id);
  const checkinRows = itemIds.length
    ? await query<CheckinRow>(
        `SELECT ghl_event_id, still_in_conversation, showed_up, deal_progressing, deal_closed, contract_signed, potential_commission
         FROM scout_appointment_checkins WHERE client_id = $1 AND ghl_event_id = ANY($2)`,
        [clientId, itemIds]
      )
    : [];
  const checkinByEventId = new Map(checkinRows.map((r) => [r.ghl_event_id, r]));

  function toAppointment(item: RawItem): CheckinAppointment {
    const saved = checkinByEventId.get(item.id);
    return {
      ghlEventId: item.id,
      contactId: item.contactId,
      prospectName: item.prospectName,
      appointmentAt: item.appointmentAt,
      status: item.status,
      checkboxes: {
        still_in_conversation: saved?.still_in_conversation ?? false,
        showed_up: saved?.showed_up ?? false,
        deal_progressing: saved?.deal_progressing ?? false,
        deal_closed: saved?.deal_closed ?? false,
        contract_signed: saved?.contract_signed ?? false,
      },
      potentialCommission:
        saved?.potential_commission != null && saved.potential_commission !== ""
          ? Number(saved.potential_commission)
          : null,
    };
  }

  const appointmentsByMemberId = new Map<string, CheckinAppointment[]>();
  const unassigned: CheckinAppointment[] = [];

  for (const item of items) {
    const appt = toAppointment(item);
    if (item.assignedId && memberIds.has(item.assignedId)) {
      const list = appointmentsByMemberId.get(item.assignedId) || [];
      list.push(appt);
      appointmentsByMemberId.set(item.assignedId, list);
    } else {
      unassigned.push(appt);
    }
  }

  const byMostRecent = (a: CheckinAppointment, b: CheckinAppointment) =>
    new Date(b.appointmentAt).getTime() - new Date(a.appointmentAt).getTime();
  unassigned.sort(byMostRecent);

  const teams: CheckinTeam[] = teamsConfig.map((team) => ({
    teamName: team.teamName,
    teamLead: team.teamLead,
    // Only members who actually have a recent appointment are shown —
    // Jacob was explicit the page shouldn't list the whole roster.
    members: team.members
      .map((m) => ({
        name: m.name,
        appointments: (appointmentsByMemberId.get(m.ghlUserId) || []).sort(byMostRecent),
      }))
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
 * Upserts one appointment's whole editable-field set (the 5 checkboxes
 * plus the optional potential-commission number) in a single write — the
 * page has one "Save all my updates" button rather than saving on every
 * click, so a save submits everything for an appointment at once. Every
 * key in `fields` is validated against the fixed CHECKBOX_FIELDS/
 * NUMERIC_FIELDS allowlists, AND type-checked against which kind of column
 * it is, before being interpolated into the SQL column list — this is the
 * one place a request body value reaches a column name, so that check
 * isn't optional.
 */
export async function updateCheckinItem(
  token: string,
  ghlEventId: string,
  fields: Record<string, boolean | number | null>,
  contactId?: string | null
): Promise<"ok" | "invalid-token" | "invalid-field"> {
  const entries = Object.entries(fields);
  for (const [field, value] of entries) {
    if ((CHECKBOX_FIELDS as readonly string[]).includes(field)) {
      if (typeof value !== "boolean") return "invalid-field";
    } else if ((NUMERIC_FIELDS as readonly string[]).includes(field)) {
      if (value !== null && typeof value !== "number") return "invalid-field";
    } else {
      return "invalid-field";
    }
  }
  if (entries.length === 0) return "ok";

  const clientId = await resolveClientId(token);
  if (!clientId) return "invalid-token";

  const columns = entries.map(([field]) => field);
  const values = entries.map(([, value]) => value);
  const insertColumns = ["client_id", "ghl_event_id", ...columns].join(", ");
  const insertPlaceholders = ["$1", "$2", ...columns.map((_, i) => `$${i + 3}`)].join(", ");
  const updateSet = columns
    .map((col, i) => `${col} = $${i + 3}`)
    .concat("updated_at = now()")
    .join(", ");

  await query(
    `INSERT INTO scout_appointment_checkins (${insertColumns})
     VALUES (${insertPlaceholders})
     ON CONFLICT (client_id, ghl_event_id)
     DO UPDATE SET ${updateSet}`,
    [clientId, ghlEventId, ...values]
  );

  // Best-effort push into GHL's own opportunity value — the local save
  // above is already committed and is this page's source of truth, so a
  // GHL-side failure here is logged, never thrown back to the caller.
  // Clearing the field (null) intentionally does NOT push anything: we
  // never want a blank check-in field to zero out a real GHL value.
  const commission = fields.potential_commission;
  if (typeof commission === "number" && contactId) {
    try {
      const ghlConfig = await getGhlConfig(clientId);
      if (ghlConfig) {
        const openOpportunities = await findOpenOpportunitiesForContact(
          contactId,
          ghlConfig.locationId,
          ghlConfig.apiKey
        );
        if (openOpportunities[0]) {
          await updateOpportunityMonetaryValue(
            openOpportunities[0].id,
            commission,
            ghlConfig.locationId,
            ghlConfig.apiKey
          );
        } else {
          console.warn(`[CHECKIN] No open GHL opportunity found for contact ${contactId} — commission not pushed.`);
        }
      }
    } catch (error) {
      console.error(`[CHECKIN] Failed to push potential_commission to GHL for contact ${contactId}:`, error);
    }
  }

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
  .team {
    --team-color: #6b7280;
    margin-top: 20px;
    background: #fff;
    border: 1px solid #e3e3e6;
    border-left: 5px solid var(--team-color);
    border-radius: 10px;
    padding: 16px 18px 18px;
  }
  .team h2 {
    font-size: 16px; margin: 0 0 4px; display: flex; align-items: center; gap: 8px;
  }
  .team h2::before {
    content: ""; width: 10px; height: 10px; border-radius: 50%;
    background: var(--team-color); flex: none;
  }
  .team .lead { font-size: 13px; color: #666; margin: 0 0 14px; }
  .team.needs-routing { --team-color: #b45309; }
  .member { margin-bottom: 14px; }
  .member h3 {
    display: inline-block; font-size: 12px; font-weight: 700; margin: 0 0 8px;
    padding: 3px 10px; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.02em;
    background: #f0f0f0; color: var(--team-color);
  }
  @supports (background: color-mix(in srgb, red 10%, white)) {
    .member h3 { background: color-mix(in srgb, var(--team-color) 14%, #fff); }
  }
  .appt { background: #fff; border: 1px solid #e3e3e6; border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; }
  .appt-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .appt-prospect { font-weight: 600; font-size: 14px; }
  .appt-meta { font-size: 12px; color: #777; }
  .checkboxes { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
  label.cb { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
  label.cb input { width: 16px; height: 16px; }
  .appt-value { font-size: 13px; font-weight: 600; color: #1a7a3a; margin-top: 4px; }
  .commission-row { margin-top: 12px; display: flex; align-items: center; gap: 8px; }
  .commission-row label { font-size: 13px; color: #444; }
  .commission-row input {
    width: 130px; padding: 5px 8px; border: 1px solid #ccc; border-radius: 6px;
    font-size: 13px; font-family: inherit;
  }
  .appt.failed { border-color: #b00020; }
  .appt-fail-note { font-size: 11px; color: #b00020; margin-top: 6px; }
  .empty { color: #888; font-size: 14px; padding: 20px 0; }
  .error { color: #b00020; padding: 20px 0; }
  .tab-bar { display: flex; gap: 8px; margin: 20px 0 4px; }
  .tab-btn {
    background: #eee; border: none; border-radius: 8px; padding: 8px 14px;
    font-size: 13px; font-weight: 600; cursor: pointer; color: #444;
  }
  .tab-btn.active { background: #1a1a1a; color: #fff; }
  .save-bar {
    position: sticky; bottom: 0; left: 0; right: 0; margin-top: 24px;
    background: #fff; border-top: 1px solid #e3e3e6; padding: 12px 16px;
    display: flex; align-items: center; gap: 12px; justify-content: space-between;
  }
  .save-bar button {
    background: #1a1a1a; color: #fff; border: none; border-radius: 8px;
    padding: 10px 18px; font-size: 14px; font-weight: 600; cursor: pointer;
  }
  .save-bar button:disabled { background: #999; cursor: default; }
  .save-status { font-size: 13px; color: #555; }
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

  function fmtCurrency(n) {
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  // "New" vs "Continuing" tabs, per Jacob 2026-09-23: team leads should
  // land on the fresh batch first, without losing the ability to keep
  // updating older leads still moving through the pipeline. 14 days
  // matches the bi-weekly cadence itself — deliberately a fixed window,
  // not tied to exactly when a link was last sent (sends are manual and
  // can drift), so the split stays predictable either way.
  var NEW_WINDOW_DAYS = 14;

  function isNew(appointmentAt) {
    var ageMs = Date.now() - new Date(appointmentAt).getTime();
    return ageMs <= NEW_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  }

  function filterAppointments(list, wantNew) {
    return list.filter(function (a) { return isNew(a.appointmentAt) === wantNew; });
  }

  // Splits the full team/member tree into a "new" or "old" copy, applying
  // the same "hide a member/team with nothing to show" rule as before —
  // now per bucket, since one member can have appointments in both.
  function bucketData(data, wantNew) {
    var teams = data.teams
      .map(function (team) {
        return {
          teamName: team.teamName,
          teamLead: team.teamLead,
          members: team.members
            .map(function (m) { return { name: m.name, appointments: filterAppointments(m.appointments, wantNew) }; })
            .filter(function (m) { return m.appointments.length > 0; })
        };
      })
      .filter(function (t) { return t.members.length > 0; });
    return { teams: teams, unassigned: filterAppointments(data.unassigned, wantNew) };
  }

  function countAppointments(bucket) {
    var n = bucket.unassigned.length;
    bucket.teams.forEach(function (t) { t.members.forEach(function (m) { n += m.appointments.length; }); });
    return n;
  }

  function renderAppointment(a) {
    var div = document.createElement("div");
    div.className = "appt";
    div.dataset.ghlEventId = a.ghlEventId;
    div.dataset.contactId = a.contactId || "";
    div.innerHTML =
      '<div class="appt-top"><span class="appt-prospect"></span><span class="appt-meta"></span></div>' +
      '<div class="appt-value" hidden></div>' +
      '<div class="checkboxes"></div>' +
      '<div class="commission-row"><label>Potential commission ($, optional)</label>' +
      '<input type="number" min="0" step="0.01" class="commission-input" placeholder="e.g. 8500" /></div>';
    div.querySelector(".appt-prospect").textContent = a.prospectName;
    div.querySelector(".appt-meta").textContent = fmtDate(a.appointmentAt) + " · " + a.status;

    var valueEl = div.querySelector(".appt-value");
    var commissionInput = div.querySelector(".commission-input");
    commissionInput.dataset.field = "potential_commission";

    function refreshValueDisplay() {
      var num = commissionInput.value === "" ? null : parseFloat(commissionInput.value);
      if (num === null || isNaN(num)) {
        valueEl.hidden = true;
        valueEl.textContent = "";
      } else {
        valueEl.hidden = false;
        valueEl.textContent = "Value: " + fmtCurrency(num);
      }
    }

    if (typeof a.potentialCommission === "number") {
      commissionInput.value = a.potentialCommission;
    }
    refreshValueDisplay();
    // Live feedback as they type — reflected under "Value" immediately,
    // before the Save button ever sends anything to the server.
    commissionInput.addEventListener("input", refreshValueDisplay);

    var box = div.querySelector(".checkboxes");
    CHECKBOX_LABELS.forEach(function (pair) {
      var field = pair[0], label = pair[1];
      var wrap = document.createElement("label");
      wrap.className = "cb";
      var input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!a.checkboxes[field];
      input.dataset.field = field;
      wrap.appendChild(input);
      wrap.appendChild(document.createTextNode(label));
      box.appendChild(wrap);
    });
    return div;
  }

  // Collects the current checkbox state of every rendered appointment card
  // and saves them all in one action (one request per card, run in
  // parallel) — nothing is sent until this fires, so checking boxes alone
  // never touches the server.
  function saveAll() {
    var saveButton = document.getElementById("save-all-btn");
    var status = document.getElementById("save-status");
    var cards = document.querySelectorAll(".appt");
    cards.forEach(function (card) { card.classList.remove("failed"); });
    var oldNotes = document.querySelectorAll(".appt-fail-note");
    oldNotes.forEach(function (n) { n.remove(); });

    saveButton.disabled = true;
    status.textContent = "Saving…";

    var requests = Array.prototype.map.call(cards, function (card) {
      var fields = {};
      card.querySelectorAll("input[type=checkbox]").forEach(function (input) {
        fields[input.dataset.field] = input.checked;
      });
      var commissionInput = card.querySelector(".commission-input");
      if (commissionInput) {
        fields.potential_commission = commissionInput.value === "" ? null : parseFloat(commissionInput.value);
      }
      return fetch("/api/checkin/" + encodeURIComponent(token) + "/items/" + encodeURIComponent(card.dataset.ghlEventId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: fields, contactId: card.dataset.contactId || null })
      })
        .then(function (res) { return { card: card, ok: res.ok }; })
        .catch(function () { return { card: card, ok: false }; });
    });

    Promise.all(requests).then(function (results) {
      saveButton.disabled = false;
      var failed = results.filter(function (r) { return !r.ok; });
      if (failed.length === 0) {
        status.textContent = "✓ All changes saved";
        return;
      }
      status.textContent = failed.length + " item(s) failed to save — check your connection and try again.";
      failed.forEach(function (r) {
        r.card.classList.add("failed");
        var note = document.createElement("p");
        note.className = "appt-fail-note";
        note.textContent = "Couldn't save this one — try again.";
        r.card.appendChild(note);
      });
    });
  }

  // A small fixed palette, picked by a stable hash of the team's name so
  // the same team always gets the same color on every load and in both
  // tabs — not by list position, which shifts depending on which teams
  // have anything in a given bucket.
  var TEAM_COLORS = ["#4F46E5", "#0891B2", "#7C3AED", "#DB2777", "#059669", "#2563EB"];
  function colorForTeam(teamName) {
    var hash = 0;
    for (var i = 0; i < teamName.length; i++) {
      hash = (hash * 31 + teamName.charCodeAt(i)) | 0;
    }
    return TEAM_COLORS[Math.abs(hash) % TEAM_COLORS.length];
  }

  function renderTeam(team) {
    var section = document.createElement("section");
    section.className = "team";
    section.style.setProperty("--team-color", colorForTeam(team.teamName));
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

  function renderPanel(bucket, emptyMessage) {
    var panel = document.createElement("div");
    panel.className = "tab-panel";
    if (bucket.teams.length === 0 && bucket.unassigned.length === 0) {
      var empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = emptyMessage;
      panel.appendChild(empty);
      return panel;
    }
    bucket.teams.forEach(function (team) { panel.appendChild(renderTeam(team)); });
    if (bucket.unassigned.length > 0) {
      var section = document.createElement("section");
      section.className = "team needs-routing";
      var h2 = document.createElement("h2");
      h2.textContent = "Needs routing";
      var note = document.createElement("p");
      note.className = "lead";
      note.textContent = "Not yet assigned to a team member in GHL";
      section.appendChild(h2);
      section.appendChild(note);
      bucket.unassigned.forEach(function (appt) { section.appendChild(renderAppointment(appt)); });
      panel.appendChild(section);
    }
    return panel;
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

      var newBucket = bucketData(data, true);
      var oldBucket = bucketData(data, false);
      var newCount = countAppointments(newBucket);
      var oldCount = countAppointments(oldBucket);

      if (newCount === 0 && oldCount === 0) {
        main.innerHTML = '<p class="empty">No recent appointments in this period.</p>';
        return;
      }

      var tabBar = document.createElement("div");
      tabBar.className = "tab-bar";
      tabBar.innerHTML =
        '<button class="tab-btn active" data-tab="new" type="button">New (' + newCount + ')</button>' +
        '<button class="tab-btn" data-tab="old" type="button">Continuing (' + oldCount + ')</button>';
      main.appendChild(tabBar);

      var panelNew = renderPanel(newBucket, "No new appointments or transfers in the last " + NEW_WINDOW_DAYS + " days.");
      var panelOld = renderPanel(oldBucket, "Nothing older still in progress.");
      panelOld.hidden = true;
      main.appendChild(panelNew);
      main.appendChild(panelOld);

      Array.prototype.forEach.call(tabBar.querySelectorAll(".tab-btn"), function (btn) {
        btn.addEventListener("click", function () {
          Array.prototype.forEach.call(tabBar.querySelectorAll(".tab-btn"), function (b) {
            b.classList.remove("active");
          });
          btn.classList.add("active");
          panelNew.hidden = btn.dataset.tab !== "new";
          panelOld.hidden = btn.dataset.tab !== "old";
        });
      });

      // Shared across both tabs — saving always submits every appointment
      // on the page (both panels stay in the DOM, just one hidden), not
      // only whichever tab happens to be showing.
      var saveBar = document.createElement("div");
      saveBar.className = "save-bar";
      saveBar.innerHTML =
        '<span id="save-status" class="save-status">Check off what applies, then save.</span>' +
        '<button id="save-all-btn" type="button">Save all my updates</button>';
      main.appendChild(saveBar);
      document.getElementById("save-all-btn").addEventListener("click", saveAll);
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
