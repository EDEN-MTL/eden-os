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
