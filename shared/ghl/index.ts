/**
 * GoHighLevel API Client
 *
 * Handles contacts, pipeline, calendar, and communications.
 * GHL is the source of truth for all lead data.
 */

const GHL_BASE_URL = "https://services.leadconnectorhq.com";

interface GHLRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: Record<string, any>;
  locationId?: string;
}

async function ghlRequest(
  endpoint: string,
  options: GHLRequestOptions = {}
): Promise<any> {
  const { method = "GET", body, locationId } = options;
  const apiKey = process.env.GHL_API_KEY;

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
  return new Date(isoTimestamp).getTime();
}

/**
 * Paginates the full contact list for a location. GHL's cursor pagination
 * wants `startAfter` as an epoch-millisecond timestamp (not the raw
 * `dateAdded` ISO string) alongside `startAfterId`.
 */
export async function* listContactsPaginated(
  locationId: string,
  options: { limit?: number; query?: string } = {}
): AsyncGenerator<any> {
  const { limit = 100, query } = options;
  let startAfterId: string | undefined;
  let startAfterMs: number | undefined;

  while (true) {
    const params = new URLSearchParams({ locationId, limit: String(limit) });
    if (query) params.set("query", query);
    if (startAfterId) {
      params.set("startAfterId", startAfterId);
      params.set("startAfter", String(startAfterMs));
    }
    const payload = await ghlRequest(`/contacts/?${params.toString()}`);
    const contacts: any[] = payload.contacts || [];
    if (contacts.length === 0) return;
    for (const c of contacts) yield c;
    if (contacts.length < limit) return;

    const last = contacts[contacts.length - 1];
    if (!last.id || last.id === startAfterId) return; // cursor didn't advance — stop rather than loop forever
    startAfterId = last.id;
    startAfterMs = toEpochMs(last.dateAdded);
  }
}

/**
 * /opportunities/search uses the same cursor pagination as contacts
 * (page-number params are rejected) — cursor off each page's last
 * opportunity by `updatedAt`, same approach as listContactsPaginated.
 */
export async function* listOpportunitiesPaginated(
  locationId: string,
  options: { pipelineId?: string; limit?: number } = {}
): AsyncGenerator<any> {
  const { pipelineId, limit = 100 } = options;
  let startAfterId: string | undefined;
  let startAfterMs: number | undefined;

  while (true) {
    const params = new URLSearchParams({ location_id: locationId, limit: String(limit) });
    if (pipelineId) params.set("pipeline_id", pipelineId);
    if (startAfterId) {
      params.set("startAfterId", startAfterId);
      params.set("startAfter", String(startAfterMs));
    }
    const payload = await ghlRequest(`/opportunities/search?${params.toString()}`);
    const opps: any[] = payload.opportunities || [];
    if (opps.length === 0) return;
    for (const o of opps) yield o;
    if (opps.length < limit) return;

    const last = opps[opps.length - 1];
    if (!last.id || last.id === startAfterId) return;
    startAfterId = last.id;
    startAfterMs = toEpochMs(last.updatedAt);
  }
}

export async function listPipelines(locationId: string): Promise<any[]> {
  const payload = await ghlRequest(`/opportunities/pipelines?locationId=${locationId}`);
  return payload.pipelines || [];
}

export async function getCustomFieldDefs(locationId: string): Promise<any[]> {
  const payload = await ghlRequest(`/locations/${locationId}/customFields`);
  return payload.customFields || [];
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
  locationId?: string
): Promise<any> {
  return ghlRequest(`/conversations/messages`, {
    method: "POST",
    body: {
      type: "SMS",
      contactId,
      message,
    },
    locationId,
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
