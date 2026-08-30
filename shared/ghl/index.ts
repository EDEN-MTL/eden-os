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

// ─── Contacts ───

export async function getContact(
  contactId: string,
  locationId?: string
): Promise<any> {
  return ghlRequest(`/contacts/${contactId}`, { locationId });
}

export async function searchContacts(
  query: string,
  locationId: string
): Promise<any> {
  return ghlRequest(
    `/contacts/search?query=${encodeURIComponent(query)}&locationId=${locationId}`
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
  locationId?: string
): Promise<any> {
  return ghlRequest(`/contacts/${contactId}`, {
    method: "PUT",
    body: data,
    locationId,
  });
}

export async function addContactTags(
  contactId: string,
  tags: string[],
  locationId?: string
): Promise<any> {
  return ghlRequest(`/contacts/${contactId}/tags`, {
    method: "POST",
    body: { tags },
    locationId,
  });
}

// ─── Pipeline ───

export async function getPipelines(locationId: string): Promise<any> {
  return ghlRequest(`/opportunities/pipelines?locationId=${locationId}`);
}

export async function getOpportunities(
  pipelineId: string,
  locationId: string
): Promise<any> {
  return ghlRequest(
    `/opportunities/search?pipelineId=${pipelineId}&locationId=${locationId}`
  );
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

export async function updateOpportunityStage(
  opportunityId: string,
  stageId: string,
  locationId?: string
): Promise<any> {
  return ghlRequest(`/opportunities/${opportunityId}`, {
    method: "PUT",
    body: { pipelineStageId: stageId },
    locationId,
  });
}

// ─── Calendar ───

export async function getCalendarSlots(
  calendarId: string,
  startDate: string,
  endDate: string,
  locationId?: string
): Promise<any> {
  return ghlRequest(
    `/calendars/${calendarId}/free-slots?startDate=${startDate}&endDate=${endDate}`,
    { locationId }
  );
}

export async function createAppointment(
  calendarId: string,
  data: {
    contactId: string;
    startTime: string;
    endTime: string;
    title?: string;
    notes?: string;
  },
  locationId?: string
): Promise<any> {
  return ghlRequest(`/calendars/events/appointments`, {
    method: "POST",
    body: { calendarId, ...data },
    locationId,
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

export async function getConversations(
  contactId: string,
  locationId?: string
): Promise<any> {
  return ghlRequest(`/conversations/search?contactId=${contactId}`, {
    locationId,
  });
}
