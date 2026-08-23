/**
 * Meta (Facebook) Marketing API client.
 *
 * Ported from the Python prototype's app/meta/client.py — generic
 * low-level primitives (getObject/call/uploadImageFile/pagination/
 * rate-limit backoff) that agents/forge/ads/actions.ts builds write
 * actions on top of, plus typed convenience methods for reads.
 */
import { getValidAccessToken } from "./auth";

const GRAPH_HOST = "https://graph.facebook.com";
const API_VERSION = "v21.0";

export class MetaAPIError extends Error {
  payload: Record<string, unknown>;
  constructor(message: string, payload: Record<string, unknown> = {}) {
    super(message);
    this.payload = payload;
  }
}

export interface MetaConfig {
  appId: string;
  appSecret: string;
  accessToken: string; // seed token; getValidAccessToken exchanges/refreshes as needed
  adAccountId: string; // "act_..."
  pageId?: string;
  clientId: string;
}

/**
 * Eden-only for now — reads from env vars. Swapping this to a real
 * per-client lookup (config/clients/<id>.json) later is a one-function
 * change; every caller already takes a MetaConfig, not env vars directly.
 */
export function getMetaConfig(clientId = "eden"): MetaConfig | null {
  const { META_APP_ID, META_APP_SECRET, META_ACCESS_TOKEN, META_AD_ACCOUNT_ID, META_PAGE_ID } = process.env;
  if (!META_APP_ID || !META_APP_SECRET || !META_ACCESS_TOKEN || !META_AD_ACCOUNT_ID) return null;
  return {
    appId: META_APP_ID,
    appSecret: META_APP_SECRET,
    accessToken: META_ACCESS_TOKEN,
    adAccountId: META_AD_ACCOUNT_ID,
    pageId: META_PAGE_ID,
    clientId,
  };
}

const DEFAULT_ENTITY_FIELDS = {
  campaign: [
    "id", "name", "status", "effective_status", "objective",
    "special_ad_categories", "special_ad_category_country",
    "daily_budget", "lifetime_budget", "created_time", "updated_time",
  ],
  adset: [
    "id", "name", "status", "effective_status", "campaign_id",
    "daily_budget", "lifetime_budget", "targeting", "created_time", "updated_time",
  ],
  ad: [
    "id", "name", "status", "effective_status", "adset_id", "campaign_id",
    "creative", "created_time", "updated_time",
  ],
};

const DEFAULT_INSIGHTS_FIELDS = [
  "campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name",
  "spend", "impressions", "clicks", "ctr", "cpc", "reach", "frequency",
  "actions", "cost_per_action_type", "date_start", "date_stop",
];

const RETRYABLE_ERROR_CODES = new Set([4, 17, 32, 613]); // rate-limit codes -> backoff & retry

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class MetaClient {
  constructor(private config: MetaConfig) {}

  get adAccountId(): string {
    return this.config.adAccountId;
  }

  get pageId(): string | undefined {
    return this.config.pageId;
  }

  private async token(): Promise<string> {
    return getValidAccessToken(this.config.appId, this.config.appSecret, this.config.accessToken, this.config.clientId);
  }

  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    options: { params?: Record<string, string>; data?: Record<string, string>; retries?: number } = {}
  ): Promise<any> {
    const { params = {}, data, retries = 3 } = options;
    const url = new URL(`${GRAPH_HOST}/${API_VERSION}/${path.replace(/^\//, "")}`);

    for (let attempt = 1; attempt <= retries; attempt++) {
      const allParams = { ...params, access_token: await this.token() };
      let requestUrl = url;
      let body: URLSearchParams | undefined;

      if (method === "GET" || method === "DELETE") {
        requestUrl = new URL(url.toString());
        for (const [k, v] of Object.entries(allParams)) requestUrl.searchParams.set(k, v);
      } else {
        for (const [k, v] of Object.entries(allParams)) url.searchParams.set(k, v);
        body = new URLSearchParams(data || {});
      }

      let res: Response;
      try {
        res = await fetch(requestUrl.toString(), { method, body });
      } catch (error) {
        if (attempt < retries) {
          await sleep(2 ** attempt * 1000);
          continue;
        }
        throw new MetaAPIError(`Network error calling Meta API ${method} ${path}: ${error}`);
      }

      const payload: any = res.status !== 204 ? await res.json().catch(() => ({})) : {};
      if (!res.ok || payload.error) {
        const err = payload.error || {};
        if (RETRYABLE_ERROR_CODES.has(err.code) && attempt < retries) {
          const wait = 2 ** attempt;
          console.warn(`[META] Rate limited (code ${err.code}), retrying in ${wait}s`);
          await sleep(wait * 1000);
          continue;
        }
        throw new MetaAPIError(`Meta API error on ${method} ${path}: ${err.message || JSON.stringify(payload)}`, payload);
      }
      return payload;
    }
    throw new MetaAPIError(`Exhausted retries calling Meta API ${method} ${path}`);
  }

  private async *paginate(path: string, params: Record<string, string>): AsyncGenerator<any> {
    let payload = await this.request("GET", path, { params });
    while (true) {
      for (const item of payload.data || []) yield item;
      const nextUrl = payload.paging?.next;
      if (!nextUrl) return;
      const res = await fetch(nextUrl);
      payload = await res.json();
    }
  }

  private async collectPages(path: string, params: Record<string, string>): Promise<any[]> {
    const out: any[] = [];
    for await (const item of this.paginate(path, params)) out.push(item);
    return out;
  }

  // ─── Entity reads ───

  async listCampaigns(fields?: string[], statusFilter?: string[]): Promise<any[]> {
    const params: Record<string, string> = { fields: (fields || DEFAULT_ENTITY_FIELDS.campaign).join(","), limit: "200" };
    if (statusFilter) {
      params.filtering = JSON.stringify([{ field: "effective_status", operator: "IN", value: statusFilter }]);
    }
    return this.collectPages(`${this.adAccountId}/campaigns`, params);
  }

  async listAdsets(campaignId?: string, fields?: string[]): Promise<any[]> {
    const params = { fields: (fields || DEFAULT_ENTITY_FIELDS.adset).join(","), limit: "200" };
    const path = campaignId ? `${campaignId}/adsets` : `${this.adAccountId}/adsets`;
    return this.collectPages(path, params);
  }

  async listAds(adsetId?: string, fields?: string[]): Promise<any[]> {
    const params = { fields: (fields || DEFAULT_ENTITY_FIELDS.ad).join(","), limit: "200" };
    const path = adsetId ? `${adsetId}/ads` : `${this.adAccountId}/ads`;
    return this.collectPages(path, params);
  }

  /** Generic entity fetch by id — the primitive write actions verify state with. */
  async getObject(objectId: string, fields: string[]): Promise<any> {
    return this.request("GET", objectId, { params: { fields: fields.join(",") } });
  }

  /** Escape hatch for write actions that need arbitrary POST/DELETE calls. */
  async call(method: "POST" | "DELETE", path: string, options: { params?: Record<string, string>; data?: Record<string, string> } = {}): Promise<any> {
    return this.request(method, path, options);
  }

  /**
   * POST /adimages wants multipart form data (a real file upload), not the
   * form-encoded body `request` sends. Meta's image-hash response keys by
   * whatever field name you upload under, so we use the filename for that.
   */
  async uploadImageFile(filename: string, fileBytes: Buffer, contentType = "image/png"): Promise<any> {
    const form = new FormData();
    form.append(filename, new Blob([fileBytes], { type: contentType }), filename);
    const url = new URL(`${GRAPH_HOST}/${API_VERSION}/${this.adAccountId}/adimages`);
    url.searchParams.set("access_token", await this.token());

    const res = await fetch(url.toString(), { method: "POST", body: form });
    const payload: any = await res.json().catch(() => ({}));
    if (!res.ok || payload.error) {
      throw new MetaAPIError(`Meta image upload failed: ${JSON.stringify(payload.error || payload)}`, payload);
    }
    return payload;
  }

  /** Resolves a free-text interest name into the {id, name} pairs detailed targeting requires. */
  async searchInterests(queryText: string, limit = 5): Promise<any[]> {
    const payload = await this.request("GET", "search", { params: { type: "adinterest", q: queryText, limit: String(limit) } });
    return payload.data || [];
  }

  /**
   * level: campaign | adset | ad. Either pass datePreset or an explicit
   * since/until (YYYY-MM-DD) window — since/until wins. timeIncrement="1"
   * (the default) asks for one row per entity PER DAY, not aggregated
   * across the window — required for spend-over-time, and what makes
   * syncing idempotent (same-day rows get replaced, not appended).
   */
  async getInsights(options: {
    level: "campaign" | "adset" | "ad";
    datePreset?: string;
    since?: string;
    until?: string;
    fields?: string[];
    filtering?: Record<string, unknown>[];
    timeIncrement?: string | null;
  }): Promise<any[]> {
    const { level, datePreset = "last_3d", since, until, fields, filtering, timeIncrement = "1" } = options;
    const params: Record<string, string> = {
      level,
      fields: (fields || DEFAULT_INSIGHTS_FIELDS).join(","),
      limit: "500",
    };
    if (timeIncrement !== null) params.time_increment = String(timeIncrement);
    if (since && until) {
      params.time_range = JSON.stringify({ since, until });
    } else {
      params.date_preset = datePreset;
    }
    if (filtering) params.filtering = JSON.stringify(filtering);
    return this.collectPages(`${this.adAccountId}/insights`, params);
  }
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
