import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../db", () => ({ query: (...args: unknown[]) => queryMock(...args) }));
vi.mock("./auth", () => ({ getValidAccessToken: vi.fn(async () => "test-access-token") }));

import { calculateCPL, calculateROAS, getMetaConfig, MetaAPIError, MetaClient } from "./index";

const ENV_KEYS = ["META_APP_ID", "META_APP_SECRET", "META_ACCESS_TOKEN", "META_AD_ACCOUNT_ID", "META_PAGE_ID"] as const;
const originalEnv: Record<string, string | undefined> = {};
const originalFetch = global.fetch;

beforeEach(() => {
  queryMock.mockClear();
  vi.useFakeTimers();
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.useRealTimers();
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("getMetaConfig", () => {
  it("returns the DB row when one exists, taking priority over env vars", async () => {
    process.env.META_APP_ID = "env-app-id"; // should be ignored — DB wins
    queryMock.mockResolvedValueOnce([
      { app_id: "db-app-id", app_secret: "db-secret", access_token: "db-token", ad_account_id: "act_123", page_id: "page_1" },
    ]);

    const config = await getMetaConfig("eden");

    expect(config).toEqual({
      appId: "db-app-id",
      appSecret: "db-secret",
      accessToken: "db-token",
      adAccountId: "act_123",
      pageId: "page_1",
      clientId: "eden",
    });
  });

  it("maps a null page_id to undefined, not null", async () => {
    queryMock.mockResolvedValueOnce([
      { app_id: "a", app_secret: "s", access_token: "t", ad_account_id: "act_1", page_id: null },
    ]);

    const config = await getMetaConfig("eden");

    expect(config?.pageId).toBeUndefined();
  });

  it("falls back to env vars when no DB row exists", async () => {
    queryMock.mockResolvedValueOnce([]);
    process.env.META_APP_ID = "env-app-id";
    process.env.META_APP_SECRET = "env-secret";
    process.env.META_ACCESS_TOKEN = "env-token";
    process.env.META_AD_ACCOUNT_ID = "act_env";

    const config = await getMetaConfig("eden");

    expect(config).toEqual({
      appId: "env-app-id",
      appSecret: "env-secret",
      accessToken: "env-token",
      adAccountId: "act_env",
      pageId: undefined,
      clientId: "eden",
    });
  });

  it("returns null when neither a DB row nor a complete set of env vars exists", async () => {
    queryMock.mockResolvedValueOnce([]);
    process.env.META_APP_ID = "env-app-id"; // incomplete — missing the rest

    expect(await getMetaConfig("eden")).toBeNull();
  });
});

describe("calculateCPL", () => {
  it("divides spend by leads, rounded to cents", () => {
    expect(calculateCPL(100, 3)).toBeCloseTo(33.33);
  });

  it("returns 0 for zero leads rather than dividing by zero", () => {
    expect(calculateCPL(100, 0)).toBe(0);
  });
});

describe("calculateROAS", () => {
  it("divides revenue by spend, rounded to one decimal", () => {
    expect(calculateROAS(350, 100)).toBe(3.5);
  });

  it("returns 0 for zero spend rather than dividing by zero", () => {
    expect(calculateROAS(500, 0)).toBe(0);
  });
});

const clientConfig = {
  appId: "app-id",
  appSecret: "app-secret",
  accessToken: "seed-token",
  adAccountId: "act_123",
  clientId: "eden",
};

function jsonResponse(status: number, body: any): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as any;
}

describe("MetaClient.getObject / call — the request() primitive", () => {
  it("sends a GET with the fields param and a fresh access token", async () => {
    global.fetch = vi.fn(async () => jsonResponse(200, { id: "123", name: "My Campaign" })) as any;
    const client = new MetaClient(clientConfig);

    const result = await client.getObject("123", ["id", "name"]);

    expect(result).toEqual({ id: "123", name: "My Campaign" });
    const [url, opts] = (global.fetch as any).mock.calls[0];
    expect(url).toContain("/123");
    expect(url).toContain("fields=id%2Cname");
    expect(url).toContain("access_token=test-access-token");
    expect(opts.method).toBe("GET");
  });

  it("sends a POST with data as a form-encoded body, not query params", async () => {
    global.fetch = vi.fn(async () => jsonResponse(200, { success: true })) as any;
    const client = new MetaClient(clientConfig);

    await client.call("POST", "123", { data: { status: "PAUSED" } });

    const [, opts] = (global.fetch as any).mock.calls[0];
    expect(opts.method).toBe("POST");
    expect(opts.body).toBeInstanceOf(URLSearchParams);
    expect(opts.body.get("status")).toBe("PAUSED");
  });

  it("throws MetaAPIError, carrying the payload, on a non-retryable API error", async () => {
    global.fetch = vi.fn(async () => jsonResponse(400, { error: { code: 100, message: "Invalid parameter" } })) as any;
    const client = new MetaClient(clientConfig);

    await expect(client.getObject("123", ["id"])).rejects.toThrow(MetaAPIError);
    expect(global.fetch).toHaveBeenCalledTimes(1); // non-retryable code — no retry attempted
  });

  it("retries a rate-limit error (a RETRYABLE_ERROR_CODES code) with backoff, then succeeds", async () => {
    let call = 0;
    global.fetch = vi.fn(async () => {
      call++;
      // code 17 = "user request limit reached" — one of the retryable codes.
      if (call === 1) return jsonResponse(400, { error: { code: 17, message: "Rate limited" } });
      return jsonResponse(200, { id: "123" });
    }) as any;
    const client = new MetaClient(clientConfig);

    const promise = client.getObject("123", ["id"]);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ id: "123" });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("gives up and throws once retries are exhausted on a persistent rate-limit error", async () => {
    global.fetch = vi.fn(async () => jsonResponse(400, { error: { code: 17, message: "Rate limited" } })) as any;
    const client = new MetaClient(clientConfig);

    const promise = client.getObject("123", ["id"]);
    // Attach the rejection assertion before advancing timers, so the
    // eventual rejection is never observed as unhandled mid-await.
    const assertion = expect(promise).rejects.toThrow(MetaAPIError);
    await vi.runAllTimersAsync();
    await assertion;

    expect(global.fetch).toHaveBeenCalledTimes(3); // default retries = 3, no 4th attempt
  });

  it("retries a network error (fetch itself throwing) with backoff, then succeeds", async () => {
    let call = 0;
    global.fetch = vi.fn(async () => {
      call++;
      if (call === 1) throw new Error("ECONNRESET");
      return jsonResponse(200, { id: "123" });
    }) as any;
    const client = new MetaClient(clientConfig);

    const promise = client.getObject("123", ["id"]);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ id: "123" });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("MetaClient.getInsights", () => {
  it("uses an explicit time_range only when BOTH since and until are given", async () => {
    global.fetch = vi.fn(async () => jsonResponse(200, { data: [] })) as any;
    const client = new MetaClient(clientConfig);

    await client.getInsights({ level: "campaign", since: "2026-08-01", until: "2026-08-07" });

    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain("time_range=");
    expect(url).not.toContain("date_preset=");
  });

  it("falls back to date_preset when only one of since/until is given", async () => {
    global.fetch = vi.fn(async () => jsonResponse(200, { data: [] })) as any;
    const client = new MetaClient(clientConfig);

    await client.getInsights({ level: "campaign", since: "2026-08-01", datePreset: "last_7d" });

    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain("date_preset=last_7d");
    expect(url).not.toContain("time_range=");
  });
});

describe("MetaClient pagination (collectPages, exercised via listCampaigns)", () => {
  it("follows paging.next across multiple pages and flattens the results", async () => {
    // Keyed by call count, not URL — the paging.next URL still contains
    // "act_123/campaigns" as a substring, so matching on that would answer
    // every call with the same page-1 response and loop forever.
    let call = 0;
    global.fetch = vi.fn(async () => {
      call++;
      if (call === 1) {
        return jsonResponse(200, {
          data: [{ id: "c1" }, { id: "c2" }],
          paging: { next: "https://graph.facebook.com/v21.0/act_123/campaigns?after=xyz" },
        });
      }
      return jsonResponse(200, { data: [{ id: "c3" }] }); // no paging.next — terminates
    }) as any;
    const client = new MetaClient(clientConfig);

    const campaigns = await client.listCampaigns();

    expect(campaigns.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(call).toBe(2);
  });
});
