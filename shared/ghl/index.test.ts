import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../db", () => ({ query: (...args: unknown[]) => queryMock(...args) }));

import { getGhlConfig, getLocationBusinessProfile } from "./index";

const ENV_KEYS = ["GHL_API_KEY", "GHL_LOCATION_ID", "GHL_ATTRIBUTION_PIPELINE_NAME"] as const;
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

describe("getGhlConfig", () => {
  it("returns the DB row when one exists, taking priority over env vars", async () => {
    process.env.GHL_API_KEY = "env-key"; // should be ignored — DB wins
    queryMock.mockResolvedValueOnce([
      { api_key: "db-key", location_id: "loc_1", attribution_pipeline_name: "Sales Pipeline" },
    ]);

    const config = await getGhlConfig("eden");

    expect(config).toEqual({ apiKey: "db-key", locationId: "loc_1", attributionPipelineName: "Sales Pipeline" });
  });

  it("maps a null attribution_pipeline_name to undefined, not null", async () => {
    queryMock.mockResolvedValueOnce([{ api_key: "k", location_id: "loc_1", attribution_pipeline_name: null }]);

    const config = await getGhlConfig("eden");

    expect(config?.attributionPipelineName).toBeUndefined();
  });

  it("falls back to env vars when no DB row exists", async () => {
    queryMock.mockResolvedValueOnce([]);
    process.env.GHL_API_KEY = "env-key";
    process.env.GHL_LOCATION_ID = "env-loc";
    process.env.GHL_ATTRIBUTION_PIPELINE_NAME = "Sales";

    const config = await getGhlConfig("eden");

    expect(config).toEqual({ apiKey: "env-key", locationId: "env-loc", attributionPipelineName: "Sales" });
  });

  it("returns null when neither a DB row nor a complete set of env vars exists", async () => {
    queryMock.mockResolvedValueOnce([]);
    process.env.GHL_API_KEY = "env-key"; // incomplete — missing GHL_LOCATION_ID

    expect(await getGhlConfig("eden")).toBeNull();
  });
});

describe("getLocationBusinessProfile", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("joins the business address parts and returns the business name", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        location: {
          business: {
            name: "Eden Montreal Inc.",
            address: "42 Real St",
            city: "Montreal",
            state: "QC",
            postalCode: "H1A 1A1",
          },
        },
      }),
    })) as any;

    const profile = await getLocationBusinessProfile("loc1", "key1");

    expect(profile).toEqual({ name: "Eden Montreal Inc.", address: "42 Real St, Montreal, QC, H1A 1A1" });
  });

  it("returns null when the location has no business profile at all", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ location: {} }),
    })) as any;

    expect(await getLocationBusinessProfile("loc1", "key1")).toBeNull();
  });

  it("returns a null name/address rather than an empty string when the business profile is missing them", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ location: { business: { name: "", address: "" } } }),
    })) as any;

    expect(await getLocationBusinessProfile("loc1", "key1")).toEqual({ name: null, address: null });
  });
});
