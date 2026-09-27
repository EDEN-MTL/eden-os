/**
 * GoHighLevel API Client
 *
 * Handles contacts, pipeline, calendar, and communications.
 * GHL is the source of truth for all lead data.
 */
import { query } from "../db";

const GHL_BASE_URL = "https://services.leadconnectorhq.com";

interface GHLRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: Record<string, any>;
  locationId?: string;
  apiKey?: string;
}

async function ghlRequest(
  endpoint: string,
  options: GHLRequestOptions = {}
): Promise<any> {
  const { method = "GET", body, locationId } = options;
  const apiKey = options.apiKey || process.env.GHL_API_KEY;

  if (!apiKey) throw new Error("GHL_API_KEY not set");

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Version: "2021-07-28",
  };

  if (locationId) {
    headers["Location"] = locationId;
  }

  const response = await fetch(`${GHL_BASE_URL}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GHL API Error ${response.status}: ${errorText}`);
  }

  return response.json();
}

// ─── Locations ───

/**
 * Mark's call, 2026-09-06: rather than hardcode a per-client timezone in
 * our own config and hope it stays in sync, follow whatever's actually
 * configured on the GHL location itself — the same place a real user
 * would go to correct it. Callers should fall back to IrisConfig.timezone
 * (or a hardcoded default) if this returns null, same fail-safe pattern as
 * everywhere else timezone-sensitive in this codebase.
 */
export async function getLocationTimezone(locationId: string, apiKey?: string): Promise<string | null> {
  const resp = await ghlRequest(`/locations/${locationId}`, { locationId, apiKey });
  return resp?.location?.timezone || null;
}

export interface GhlUser {
  id: string;
  firstName: string;
  lastName: string;
  name: string;
}

/**
 * Real staff users on this location — for matching a spoken name to a real
 * agent after a live transfer connects (see webhooks/vapi-tools.ts's
 * handleMatchTransferAgent). Confirmed live, 2026-09-12: GHL's real
 * /users/search endpoint needs a companyId, not just a locationId — despite
 * `/users` and `/users/?locationId=...` both existing as plausible-looking
 * paths, neither actually works (404 and a scope/timeout error
 * respectively, tested live). /locations/{id} is the only way to resolve
 * that companyId first; there is no shortcut.
 */
export async function listLocationUsers(locationId: string, apiKey?: string): Promise<GhlUser[]> {
  const location = await ghlRequest(`/locations/${locationId}`, { locationId, apiKey });
  const companyId = location?.location?.companyId;
  if (!companyId) return [];
  const result = await ghlRequest(`/users/search?companyId=${companyId}&locationId=${locationId}`, { locationId, apiKey });
  return result?.users || [];
}

// ─── Contacts ───

export async function getContact(
  contactId: string,
  locationId?: string,
  apiKey?: string
): Promise<any> {
  return ghlRequest(`/contacts/${contactId}`, { locationId, apiKey });
}

export async function searchContacts(
  query: string,
  locationId: string,
  apiKey?: string
): Promise<any> {
  return ghlRequest(
    `/contacts/search?query=${encodeURIComponent(query)}&locationId=${locationId}`,
    { apiKey }
  );
}

/**
 * Creates a contact. `locationId` goes in the BODY here, not just the header —
 * the create endpoint reads it from the payload and returns a 422 without it.
 */
export async function createContact(
  data: {
    name: string;
    phone?: string;
    email?: string;
    website?: string;
    tags?: string[];
    locationId: string;
    source?: string;
  },
  apiKey?: string
): Promise<any> {
  return ghlRequest(`/contacts/`, {
    method: "POST",
    body: data,
    apiKey,
    locationId: data.locationId,
  });
}

export async function updateContact(
  contactId: string,
  data: Record<string, any>,
  locationId?: string,
  apiKey?: string
): Promise<any> {
  return ghlRequest(`/contacts/${contactId}`, {
    method: "PUT",
    body: data,
    locationId,
    apiKey,
  });
}

export async function addContactTags(
  contactId: string,
  tags: string[],
  locationId?: string,
  apiKey?: string
): Promise<any> {
  return ghlRequest(`/contacts/${contactId}/tags`, {
    method: "POST",
    body: { tags },
    locationId,
    apiKey,
  });
}

// ─── Pipeline ───

export async function getPipelines(locationId: string): Promise<any> {
  return ghlRequest(`/opportunities/pipelines?locationId=${locationId}`);
}

export async function getOpportunities(
  pipelineId: string,
  locationId: string,
  apiKey?: string
): Promise<any> {
  return ghlRequest(
    `/opportunities/search?pipelineId=${pipelineId}&locationId=${locationId}`,
    { apiKey }
  );
}

/**
 * Finds the contact's open opportunities, most-recently-updated first.
 * Used to move the right card after a live transfer completes — "open"
 * excludes won/lost/abandoned so a closed deal never gets reopened by this.
 */
export async function findOpenOpportunitiesForContact(
  contactId: string,
  locationId: string,
  apiKey?: string
): Promise<any[]> {
  const payload = await ghlRequest(
    `/opportunities/search?location_id=${locationId}&contact_id=${contactId}`,
    { apiKey }
  );
  return (payload.opportunities || [])
    .filter((o: any) => o.status === "open")
    .sort((a: any, b: any) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function toEpochMs(isoTimestamp?: string | null): number | undefined {
  if (!isoTimestamp) return undefined;
  const ms = new Date(isoTimestamp).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Backstop for GHL's cursor pagination, which was observed live to cycle
 * rather than terminate: paginating one real pipeline yielded 3,000
 * opportunities that were only 207 unique records, repeating forever.
 *
 * The original guard only compared the LAST item of a page against the
 * previous cursor, which a cycling page slips straight past. Tracking every
 * id seen and stopping when a whole page contributes nothing new is robust
 * regardless of how the server's cursor semantics misbehave.
 *
 * MAX_PAGES is a second, cruder stop so a pathological response can never
 * spin indefinitely — at limit=100 that's 100k records, far beyond any real
 * location, so it should never be the thing that fires.
 */
const MAX_PAGES = 1000;

function makeDedupeTracker() {
  const seen = new Set<string>();
  return {
    /**
     * Returns only the items not yielded before. An empty result means the
     * whole page was a repeat, which is the signal to stop paginating.
     */
    newItemsIn(items: any[]): any[] {
      const fresh: any[] = [];
      for (const item of items) {
        if (item?.id && !seen.has(item.id)) {
          seen.add(item.id);
          fresh.push(item);
        }
      }
      return fresh;
    },
  };
}

/**
 * Paginates the full contact list for a location. GHL's cursor pagination
 * wants `startAfter` as an epoch-millisecond timestamp (not the raw
 * `dateAdded` ISO string) alongside `startAfterId`.
 */
export async function* listContactsPaginated(
  locationId: string,
  options: { limit?: number; query?: string; apiKey?: string } = {}
): AsyncGenerator<any> {
  const { limit = 100, query, apiKey } = options;
  let startAfterId: string | undefined;
  let startAfterMs: number | undefined;
  const tracker = makeDedupeTracker();

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ locationId, limit: String(limit) });
    if (query) params.set("query", query);
    if (startAfterId) {
      params.set("startAfterId", startAfterId);
      if (startAfterMs !== undefined) params.set("startAfter", String(startAfterMs));
    }
    const payload = await ghlRequest(`/contacts/?${params.toString()}`, { apiKey });
    const contacts: any[] = payload.contacts || [];
    if (contacts.length === 0) return;

    // Yield only records not seen before; a fully-repeated page means the
    // server is cycling, so stop rather than loop forever.
    const fresh = tracker.newItemsIn(contacts);
    if (fresh.length === 0) return;
    for (const c of fresh) yield c;
    if (contacts.length < limit) return;

    const last = contacts[contacts.length - 1];
    if (!last.id || last.id === startAfterId) return;
    startAfterId = last.id;
    startAfterMs = toEpochMs(last.dateAdded);
  }
  console.warn(`[GHL] listContactsPaginated hit the ${MAX_PAGES}-page cap for location ${locationId} — stopping.`);
}

/**
 * /opportunities/search uses the same cursor pagination as contacts
 * (page-number params are rejected) — cursor off each page's last
 * opportunity by `updatedAt`, same approach as listContactsPaginated.
 */
export async function* listOpportunitiesPaginated(
  locationId: string,
  options: { pipelineId?: string; limit?: number; apiKey?: string } = {}
): AsyncGenerator<any> {
  const { pipelineId, limit = 100, apiKey } = options;
  let startAfterId: string | undefined;
  let startAfterMs: number | undefined;
  const tracker = makeDedupeTracker();

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ location_id: locationId, limit: String(limit) });
    if (pipelineId) params.set("pipeline_id", pipelineId);
    if (startAfterId) {
      params.set("startAfterId", startAfterId);
      if (startAfterMs !== undefined) params.set("startAfter", String(startAfterMs));
    }
    const payload = await ghlRequest(`/opportunities/search?${params.toString()}`, { apiKey });
    const opps: any[] = payload.opportunities || [];
    if (opps.length === 0) return;

    // This endpoint was observed cycling on a real pipeline (3,000 yielded,
    // 207 unique) — the dedupe stop is what actually terminates it.
    const fresh = tracker.newItemsIn(opps);
    if (fresh.length === 0) return;
    for (const o of fresh) yield o;
    if (opps.length < limit) return;

    const last = opps[opps.length - 1];
    if (!last.id || last.id === startAfterId) return;
    startAfterId = last.id;
    startAfterMs = toEpochMs(last.updatedAt);
  }
  console.warn(`[GHL] listOpportunitiesPaginated hit the ${MAX_PAGES}-page cap for location ${locationId} — stopping.`);
}

/**
 * Every opportunity in ONE stage, paged with the cursor GHL itself returns
 * (meta.startAfter / meta.startAfterId). Found live 2026-09-25 on
 * 3-percent-east-coast: listOpportunitiesPaginated above yielded only 106
 * of "1. Real Estate Pipeline"'s 280 opportunities — it builds its own
 * cursor from the last record's updatedAt, which GHL doesn't page on — and
 * showed 3 of the 10 cards in "WEEKEDN - AM FOLLOW UP" that the stage
 * filter returns. Filtering per stage keeps each result set small, and
 * following GHL's own cursor is what the API actually expects.
 */
export async function listOpportunitiesInStage(
  locationId: string,
  pipelineId: string,
  stageId: string,
  apiKey?: string,
  limit = 100
): Promise<any[]> {
  const out: any[] = [];
  const seen = new Set<string>();
  let startAfter: string | undefined;
  let startAfterId: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ location_id: locationId, pipeline_id: pipelineId, pipeline_stage_id: stageId, limit: String(limit) });
    if (startAfterId) {
      params.set("startAfterId", startAfterId);
      if (startAfter) params.set("startAfter", startAfter);
    }
    const payload = await ghlRequest(`/opportunities/search?${params.toString()}`, { apiKey });
    const opps: any[] = payload.opportunities || [];
    let fresh = 0;
    for (const o of opps) {
      if (o?.id && !seen.has(o.id)) {
        seen.add(o.id);
        out.push(o);
        fresh++;
      }
    }
    const total = typeof payload?.meta?.total === "number" ? payload.meta.total : null;
    const nextId = payload?.meta?.startAfterId;
    if (fresh === 0 || opps.length < limit || (total !== null && out.length >= total) || !nextId || nextId === startAfterId) break;
    startAfterId = String(nextId);
    startAfter = payload?.meta?.startAfter !== undefined ? String(payload.meta.startAfter) : undefined;
  }
  return out;
}

export async function listPipelines(locationId: string, apiKey?: string): Promise<any[]> {
  const payload = await ghlRequest(`/opportunities/pipelines?locationId=${locationId}`, { apiKey });
  return payload.pipelines || [];
}

export async function getCustomFieldDefs(locationId: string, apiKey?: string): Promise<any[]> {
  const payload = await ghlRequest(`/locations/${locationId}/customFields`, { apiKey });
  return payload.customFields || [];
}

/**
 * Creates a custom field on a location.
 *
 * NOTE: GHL derives the field's `fieldKey` (e.g. "contact.fbclid") from
 * `name` server-side — there is no way to set it explicitly through this
 * endpoint. So the name has to be chosen such that GHL's own slugification
 * produces the key we want; see provisionAttributionFields for how that's
 * handled and verified.
 */
export async function createCustomField(
  locationId: string,
  name: string,
  dataType = "TEXT",
  apiKey?: string
): Promise<any> {
  return ghlRequest(`/locations/${locationId}/customFields`, {
    method: "POST",
    body: { name, dataType },
    apiKey,
  });
}

export interface GhlConfig {
  apiKey: string;
  locationId: string;
  attributionPipelineName?: string;
}

interface GhlCredentialsRow {
  api_key: string;
  location_id: string;
  attribution_pipeline_name: string | null;
}

/**
 * Checks the database first (the dashboard's Settings page writes here —
 * takes effect immediately, no redeploy), then falls back to env vars for
 * local dev convenience. Eden-only for now, same pattern as
 * shared/meta's getMetaConfig.
 */
export async function getGhlConfig(clientId = "eden"): Promise<GhlConfig | null> {
  const rows = await query<GhlCredentialsRow>(
    "SELECT api_key, location_id, attribution_pipeline_name FROM ghl_credentials WHERE client_id = $1",
    [clientId]
  );
  if (rows.length > 0) {
    const row = rows[0];
    return {
      apiKey: row.api_key,
      locationId: row.location_id,
      attributionPipelineName: row.attribution_pipeline_name || undefined,
    };
  }

  const { GHL_API_KEY, GHL_LOCATION_ID, GHL_ATTRIBUTION_PIPELINE_NAME } = process.env;
  if (!GHL_API_KEY || !GHL_LOCATION_ID) return null;
  return { apiKey: GHL_API_KEY, locationId: GHL_LOCATION_ID, attributionPipelineName: GHL_ATTRIBUTION_PIPELINE_NAME };
}

export interface LocationBusinessProfile {
  name: string | null;
  address: string | null;
}

/**
 * The business name and mailing address GHL shows under Settings > Business
 * Profile for a location — pulled so outreach copy has one authoritative
 * source for its own identity instead of a second, separately-maintained
 * copy sitting in client config.
 *
 * UNVERIFIED against a live location as of 2026-09-06 — the nested
 * `business` object's fields are inferred from HighLevel's public Locations
 * API reference, not exercised against a real account yet. If name/address
 * come back null here, check Settings > Business Profile is actually filled
 * in for this location before assuming this parsing is wrong.
 */
export async function getLocationBusinessProfile(
  locationId: string,
  apiKey?: string
): Promise<LocationBusinessProfile | null> {
  const data = await ghlRequest(`/locations/${locationId}`, { locationId, apiKey });
  const business = data?.location?.business;
  if (!business) return null;
  const addressLine = [business.address, business.city, business.state, business.postalCode]
    .filter(Boolean)
    .join(", ");
  return {
    name: business.name || null,
    address: addressLine || null,
  };
}

/**
 * Creates an opportunity. `pipelineStageId` is the STAGE id, not a stage name
 * — see gotcha 5 in CLAUDE.md. Resolve it via listPipelines first.
 */
export async function createOpportunity(
  data: {
    pipelineId: string;
    pipelineStageId: string;
    contactId: string;
    name: string;
    locationId: string;
    monetaryValue?: number;
    status?: "open" | "won" | "lost" | "abandoned";
  },
  apiKey?: string
): Promise<any> {
  return ghlRequest(`/opportunities/`, {
    method: "POST",
    body: { status: "open", ...data },
    apiKey,
    locationId: data.locationId,
  });
}

/**
 * A contact's CRM notes (what the team wrote after calls, etc). Verified
 * live 2026-09-24 against eden-sub-account-one: { notes: [{ id, body,
 * bodyText, userId, dateAdded, contactId, pinned, relations }] }.
 */
export async function getContactNotes(contactId: string, locationId?: string, apiKey?: string): Promise<any[]> {
  const payload = await ghlRequest(`/contacts/${contactId}/notes`, { locationId, apiKey });
  return payload?.notes ?? [];
}

/**
 * One opportunity by id. Ember re-reads the card right before each nurture
 * touch so a deal a human moved since the last scan never gets a "still
 * thinking about it?" text. Verified live 2026-09-23 against
 * eden-sub-account-one: the response wraps the record as { opportunity },
 * with the same pipelineStageId/lastStageChangeAt fields as a search result.
 */
export async function getOpportunity(
  opportunityId: string,
  locationId?: string,
  apiKey?: string
): Promise<any> {
  const payload = await ghlRequest(`/opportunities/${opportunityId}`, { locationId, apiKey });
  return payload?.opportunity ?? payload;
}

export async function updateOpportunityStage(
  opportunityId: string,
  stageId: string,
  locationId?: string,
  apiKey?: string
): Promise<any> {
  return ghlRequest(`/opportunities/${opportunityId}`, {
    method: "PUT",
    body: { pipelineStageId: stageId },
    locationId,
    apiKey,
  });
}

/**
 * Verified live, 2026-09-18: PUT /opportunities/{id} with a monetaryValue
 * body updates the opportunity's real deal value — set to 12345 then back
 * to 0 against a live opportunity, confirmed via the response each time.
 * Same endpoint/shape as updateOpportunityStage, just a different field.
 */
export async function updateOpportunityMonetaryValue(
  opportunityId: string,
  monetaryValue: number,
  locationId?: string,
  apiKey?: string
): Promise<any> {
  return ghlRequest(`/opportunities/${opportunityId}`, {
    method: "PUT",
    body: { monetaryValue },
    locationId,
    apiKey,
  });
}

// ─── Calendar ───

/**
 * Creates a calendar. UNVERIFIED against a live POST — built from HighLevel's
 * published Calendars API reference, not exercised against a real account
 * yet (marketplace.gohighlevel.com/docs/ghl/calendars/create-calendar).
 * `allowBookingAfter`/`allowBookingAfterUnit` is the minimum-scheduling-notice
 * setting — e.g. {allowBookingAfter: 5, allowBookingAfterUnit: "days"} stops
 * someone booking a slot sooner than 5 days out, which is the whole point
 * when the person taking the call still has to build the site by hand in
 * that gap.
 */
export async function createCalendar(
  data: {
    locationId: string;
    name: string;
    teamMembers: { userId: string }[];
    slotDuration?: number;
    slotDurationUnit?: "mins" | "hours";
    allowBookingAfter?: number;
    allowBookingAfterUnit?: "mins" | "hours" | "days" | "weeks" | "months";
    eventTitle?: string;
    description?: string;
  },
  apiKey?: string
): Promise<any> {
  return ghlRequest(`/calendars/`, {
    method: "POST",
    body: data,
    apiKey,
    locationId: data.locationId,
  });
}

export async function getCalendarSlots(
  calendarId: string,
  startDate: string,
  endDate: string,
  locationId?: string,
  apiKey?: string
): Promise<any> {
  return ghlRequest(
    `/calendars/${calendarId}/free-slots?startDate=${startDate}&endDate=${endDate}`,
    { locationId, apiKey }
  );
}

/**
 * Lists booked calendar events (appointments) in a time range — verified
 * live, 2026-09-09, against 3% Realty's account. `calendarId` is required:
 * the endpoint 422s with "Either of userId, calendarId or groupId is
 * required" without it. `locationId` must be a QUERY param here (unlike
 * getCalendarSlots' free-slots endpoint, which needs no locationId query
 * param at all) — confirmed by the same live check. Each event may or may
 * not carry `assignedUserId`: it's only set once a human manually claims
 * the booking in GHL's CRM, so plenty of real events have none.
 */
export async function listCalendarEvents(
  locationId: string,
  calendarId: string,
  startTimeMs: number,
  endTimeMs: number,
  apiKey?: string
): Promise<any[]> {
  const result = await ghlRequest(
    `/calendars/events?locationId=${locationId}&calendarId=${calendarId}&startTime=${startTimeMs}&endTime=${endTimeMs}`,
    { locationId, apiKey }
  );
  return result.events || [];
}

/**
 * `locationId` goes in the BODY here, not just the header — confirmed
 * live, 2026-09-06: without it the create endpoint returns 400 "Location
 * ID is required" even with the Location header set, same gotcha
 * createContact's own doc comment already documents for that endpoint.
 */
export async function createAppointment(
  calendarId: string,
  data: {
    contactId: string;
    startTime: string;
    endTime: string;
    title?: string;
    notes?: string;
  },
  locationId?: string,
  apiKey?: string
): Promise<any> {
  return ghlRequest(`/calendars/events/appointments`, {
    method: "POST",
    body: { calendarId, locationId, ...data },
    locationId,
    apiKey,
  });
}

/**
 * Updates (reschedules) an EXISTING appointment event in place — confirmed
 * live, 2026-09-12, against a real test booking (PUT
 * /calendars/events/appointments/{id} with a new startTime/endTime returned
 * 200 and a fresh dateUpdated, same appointment id, same dateAdded). This is
 * what makes Iris's reschedule_appointment tool (webhooks/vapi-tools.ts's
 * handleRescheduleAppointment) a true update rather than a cancel-then-
 * recreate — there is never a window where both an old and a new
 * appointment exist for the same booking.
 */
export async function updateAppointment(
  appointmentId: string,
  data: {
    calendarId: string;
    startTime: string;
    endTime: string;
  },
  locationId?: string,
  apiKey?: string
): Promise<any> {
  return ghlRequest(`/calendars/events/appointments/${appointmentId}`, {
    method: "PUT",
    body: data,
    locationId,
    apiKey,
  });
}

// ─── Conversations / SMS ───

export async function sendSMS(
  contactId: string,
  message: string,
  locationId?: string,
  apiKey?: string
): Promise<any> {
  return ghlRequest(`/conversations/messages`, {
    method: "POST",
    body: {
      type: "SMS",
      contactId,
      message,
    },
    locationId,
    apiKey,
  });
}

/**
 * Sends an SMS carrying an image (MMS).
 *
 * GHL has no separate "MMS" message type — the type stays "SMS" and the image
 * rides along in `attachments`, which must be an array of PUBLIC URLs. A
 * local file path or a signed URL that expires will send as a plain text
 * message with no image and no error, which looks identical to success in
 * the API response. That is why the screenshot step uploads to a public
 * bucket before this is ever called.
 */
export async function sendMMS(
  contactId: string,
  message: string,
  attachmentUrls: string[],
  locationId?: string,
  apiKey?: string
): Promise<any> {
  if (attachmentUrls.length === 0) {
    throw new Error("sendMMS called with no attachments — use sendSMS instead");
  }
  return ghlRequest(`/conversations/messages`, {
    method: "POST",
    body: {
      type: "SMS",
      contactId,
      message,
      attachments: attachmentUrls,
    },
    locationId,
    apiKey,
  });
}

/**
 * Sends a commercial email. `html` must already carry a real unsubscribe link
 * and sender identification — CASL requires both on every commercial
 * electronic message, and GHL does not inject either for a raw conversations
 * send the way its own email-marketing product would.
 *
 * UNVERIFIED against the live API — sending a real email needs a domain
 * connected under GHL's Email Services first, which has not happened yet.
 * Smoke-test this against one real send before trusting it for anything else,
 * per the "verify against live data" rule in CLAUDE.md.
 */
export async function sendEmail(
  contactId: string,
  data: { subject: string; html: string; fromEmail: string },
  locationId?: string,
  apiKey?: string
): Promise<any> {
  return ghlRequest(`/conversations/messages`, {
    method: "POST",
    body: {
      type: "Email",
      contactId,
      subject: data.subject,
      html: data.html,
      emailFrom: data.fromEmail,
    },
    locationId,
    apiKey,
  });
}

/**
 * Real bug found live 2026-09-22: this never accepted an apiKey, unlike
 * every other function in this file — ghlRequest's apiKey defaults to
 * process.env.GHL_API_KEY, which this multi-tenant setup never sets (real
 * client credentials live in the ghl_credentials DB table instead, per
 * getGhlConfig). Calling this for any real client threw "GHL_API_KEY not
 * set" outright; it had never actually been exercised before.
 */
export async function getConversations(
  contactId: string,
  locationId?: string,
  apiKey?: string
): Promise<any> {
  return ghlRequest(`/conversations/search?contactId=${contactId}`, {
    locationId,
    apiKey,
  });
}

/**
 * The full message list for one conversation, newest first per GHL's own
 * ordering — added 2026-09-22 alongside the fix above, for the SAME class
 * of bug one level up: getConversations' summary only ever exposes the
 * single most recent message (whichever direction), which is NOT the same
 * as the lead's most recent message. Confirmed live against a real case
 * (Catherine Nonsense, contact woXhOaQpB5i96Kpy6lyT): she replied "6 pm"
 * to our automated "what's a good time to speak?" text, but an automated
 * follow-up ("why are you looking to sell?") went out 2 seconds later,
 * making the conversation SUMMARY's lastMessageDirection "outbound" again
 * — her real reply was invisible to anything that only checked the
 * summary. See agents/iris/text-signals.ts's lastInboundText for the
 * actual fix built on this.
 */
export async function getConversationMessages(
  conversationId: string,
  locationId?: string,
  apiKey?: string,
  /** Page size. GHL's default is 20; Ember reads more to see a lead's whole story. */
  limit?: number
): Promise<any> {
  const query = limit ? `?limit=${limit}` : "";
  return ghlRequest(`/conversations/${conversationId}/messages${query}`, {
    locationId,
    apiKey,
  });
}
