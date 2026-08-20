/**
 * Meta (Facebook) Ads API Client
 *
 * Handles campaign data, ad set management, and lead form retrieval.
 */

const META_BASE_URL = "https://graph.facebook.com/v21.0";

async function metaRequest(
  endpoint: string,
  options: {
    method?: "GET" | "POST";
    body?: Record<string, any>;
    accessToken?: string;
  } = {}
): Promise<any> {
  const { method = "GET", body } = options;
  const token = options.accessToken || process.env.META_ACCESS_TOKEN;

  if (!token) throw new Error("META_ACCESS_TOKEN not set");

  const separator = endpoint.includes("?") ? "&" : "?";
  const url = `${META_BASE_URL}${endpoint}${separator}access_token=${token}`;

  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Meta API Error ${response.status}: ${errorText}`);
  }

  return response.json();
}

// ─── Campaigns ───

export async function getCampaigns(adAccountId: string): Promise<any> {
  return metaRequest(
    `/${adAccountId}/campaigns?fields=id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time`
  );
}

export async function getCampaignInsights(
  campaignId: string,
  dateRange: { since: string; until: string }
): Promise<any> {
  return metaRequest(
    `/${campaignId}/insights?fields=spend,impressions,clicks,cpc,cpm,ctr,actions,cost_per_action_type&time_range={"since":"${dateRange.since}","until":"${dateRange.until}"}`
  );
}

// ─── Ad Sets ───

export async function getAdSets(adAccountId: string): Promise<any> {
  return metaRequest(
    `/${adAccountId}/adsets?fields=id,name,status,daily_budget,targeting,optimization_goal,bid_strategy`
  );
}

export async function getAdSetInsights(
  adSetId: string,
  dateRange: { since: string; until: string }
): Promise<any> {
  return metaRequest(
    `/${adSetId}/insights?fields=spend,impressions,clicks,cpc,ctr,actions,cost_per_action_type,frequency&time_range={"since":"${dateRange.since}","until":"${dateRange.until}"}`
  );
}

export async function updateAdSetStatus(
  adSetId: string,
  status: "ACTIVE" | "PAUSED"
): Promise<any> {
  return metaRequest(`/${adSetId}`, {
    method: "POST",
    body: { status },
  });
}

export async function updateAdSetBudget(
  adSetId: string,
  dailyBudget: number // in cents
): Promise<any> {
  return metaRequest(`/${adSetId}`, {
    method: "POST",
    body: { daily_budget: dailyBudget },
  });
}

// ─── Ads ───

export async function getAds(adSetId: string): Promise<any> {
  return metaRequest(
    `/${adSetId}/ads?fields=id,name,status,creative,created_time`
  );
}

// ─── Lead Forms ───

export async function getLeadFormData(leadFormId: string): Promise<any> {
  return metaRequest(
    `/${leadFormId}/leads?fields=id,created_time,field_data`
  );
}

// ─── Helpers ───

export function calculateCPL(spend: number, leads: number): number {
  if (leads === 0) return 0;
  return Math.round((spend / leads) * 100) / 100;
}

export function calculateROAS(revenue: number, spend: number): number {
  if (spend === 0) return 0;
  return Math.round((revenue / spend) * 10) / 10;
}
