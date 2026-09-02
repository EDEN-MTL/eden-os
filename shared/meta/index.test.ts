import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../db", () => ({ query: (...args: unknown[]) => queryMock(...args) }));

import { calculateCPL, calculateROAS, getMetaConfig } from "./index";

const ENV_KEYS = ["META_APP_ID", "META_APP_SECRET", "META_ACCESS_TOKEN", "META_AD_ACCOUNT_ID", "META_PAGE_ID"] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  queryMock.mockClear();
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
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
