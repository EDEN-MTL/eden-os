const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:3000";
const DASHBOARD_KEY = import.meta.env.VITE_DASHBOARD_API_KEY || "";

function authHeaders(extra: Record<string, string> = {}) {
  return {
    ...extra,
    ...(DASHBOARD_KEY ? { "x-dashboard-key": DASHBOARD_KEY } : {}),
  };
}

export async function sendChatMessage(
  agentId: string,
  message: string,
  sessionId: string
): Promise<string> {
  const res = await fetch(`${API_BASE}/api/chat/${agentId}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ message, sessionId }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }

  const data = await res.json();
  return data.reply as string;
}

/**
 * Fetch EDEN's spoken audio for a line of text. Returns null (rather than
 * throwing) if TTS isn't configured server-side, so callers can silently
 * skip voice playback instead of erroring the whole chat flow.
 */
export async function fetchSpeech(text: string): Promise<Blob | null> {
  const res = await fetch(`${API_BASE}/api/tts`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ text }),
  });

  if (res.status === 501) return null;           // TTS not configured
  if (res.status === 204) return null;           // nothing speakable in the reply
  if (!res.ok) throw new Error(`TTS request failed: ${res.status}`);
  return res.blob();
}

export interface IntegrationsStatus {
  meta: { configured: boolean };
  ghl: { configured: boolean };
}

export async function getIntegrationsStatus(clientId = "eden"): Promise<IntegrationsStatus> {
  const res = await fetch(`${API_BASE}/api/settings/integrations?clientId=${encodeURIComponent(clientId)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Failed to load integration status: ${res.status}`);
  return res.json();
}

async function postSettings(path: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${API_BASE}/api/settings/${path}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
}

export function saveMetaCredentials(
  fields: {
    appId: string;
    appSecret: string;
    accessToken: string;
    adAccountId: string;
    pageId?: string;
  },
  clientId = "eden"
): Promise<void> {
  return postSettings("meta", { ...fields, clientId });
}

export function saveGhlCredentials(
  fields: {
    apiKey: string;
    locationId: string;
    attributionPipelineName?: string;
  },
  clientId = "eden"
): Promise<void> {
  return postSettings("ghl", { ...fields, clientId });
}

export interface ClientSummary {
  clientId: string;
  clientName: string;
  configured: boolean;
  metaConfigured: boolean;
  ghlConfigured: boolean;
  spendLast30d: number;
  leadsLast30d: number;
}

export interface AdPerformanceRow {
  ad_id: string;
  ad_name: string | null;
  campaign_name: string | null;
  spend: number;
  lead_count: number;
  won_count: number;
  revenue: number;
  cpl: number | null;
  roas: number | null;
}

export interface RecentLead {
  id: number;
  meta_campaign_id: string | null;
  meta_adset_id: string | null;
  meta_ad_id: string | null;
  pipeline_stage: string | null;
  deal_value: number | null;
  won: boolean | null;
  created_at: string;
}

export interface PendingAction {
  id: number;
  rule_name: string;
  entity_type: string;
  entity_id: string;
  entity_name: string | null;
  action_type: string;
  reasoning: string;
  auto_execute_eligible: boolean;
  created_at: string;
}

export interface ClientDetail {
  clientId: string;
  clientName: string;
  metaConfigured: boolean;
  ghlConfigured: boolean;
  forgeRules: { cplThreshold: number; roasTarget: number; dailyBudgetCap: number; fatigueThreshold: number } | null;
  adPerformance: AdPerformanceRow[];
  /**
   * Whole-CRM totals, NOT ad-attributed. Kept separate from adPerformance
   * so ad spend never takes credit for organic deals.
   */
  crmPipeline: {
    revenue: number;
    wonCount: number;
    pipelineValue: number;
    activeCount: number;
    note: string;
  };
  recentLeads: RecentLead[];
  pendingActions: PendingAction[];
  appointments: { available: boolean; reason?: string };
}

export async function getClients(): Promise<ClientSummary[]> {
  const res = await fetch(`${API_BASE}/api/clients`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to load clients: ${res.status}`);
  const data = await res.json();
  return data.clients;
}

export async function getClientDetail(clientId: string): Promise<ClientDetail> {
  const res = await fetch(`${API_BASE}/api/clients/${clientId}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to load client: ${res.status}`);
  return res.json();
}

export async function decidePendingAction(
  clientId: string,
  pendingActionId: number,
  decision: "approve" | "reject"
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/clients/${clientId}/pending-actions/${pendingActionId}/${decision}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ decidedBy: "dashboard" }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to ${decision} action: ${res.status}`);
  }
}
