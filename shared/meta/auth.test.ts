import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../db", () => ({ query: (...args: unknown[]) => queryMock(...args) }));

import { exchangeLongLivedToken, getValidAccessToken, TokenError } from "./auth";

const originalFetch = global.fetch;

function mockExchangeResponse(body: any, ok = true) {
  global.fetch = vi.fn(async () => ({
    ok,
    json: async () => body,
  })) as any;
}

beforeEach(() => {
  queryMock.mockClear();
  // A spy by default, even when a test expects zero calls — otherwise
  // `expect(global.fetch).not.toHaveBeenCalled()` fails with "not a spy"
  // rather than actually asserting no network call happened.
  global.fetch = vi.fn() as any;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("exchangeLongLivedToken", () => {
  it("returns the exchanged token and a computed expiry", async () => {
    mockExchangeResponse({ access_token: "long-lived-abc", expires_in: 5184000 }); // 60 days

    const before = Date.now();
    const { accessToken, expiresAt } = await exchangeLongLivedToken("app-id", "app-secret", "short-token");

    expect(accessToken).toBe("long-lived-abc");
    expect(expiresAt).not.toBeNull();
    // Within a few seconds of now + 60 days — avoids a flaky exact-ms match.
    expect(expiresAt!.getTime() - before).toBeGreaterThan(5184000 * 1000 - 5000);
    expect(expiresAt!.getTime() - before).toBeLessThan(5184000 * 1000 + 5000);
  });

  it("treats a missing/zero expires_in as no expiry (system user token)", async () => {
    mockExchangeResponse({ access_token: "system-user-token" });

    const { expiresAt } = await exchangeLongLivedToken("app-id", "app-secret", "seed");

    expect(expiresAt).toBeNull();
  });

  it("throws TokenError when Meta rejects the exchange", async () => {
    mockExchangeResponse({ error: { message: "Invalid OAuth access token" } }, false);

    await expect(exchangeLongLivedToken("app-id", "app-secret", "bad-token")).rejects.toThrow(TokenError);
  });

  it("throws TokenError when the response is 200 but has no access_token", async () => {
    mockExchangeResponse({ something: "unexpected" }, true);

    await expect(exchangeLongLivedToken("app-id", "app-secret", "seed")).rejects.toThrow(TokenError);
  });
});

describe("getValidAccessToken", () => {
  it("exchanges the seed token and persists it when nothing is stored yet", async () => {
    queryMock.mockResolvedValueOnce([]); // loadState: no row
    mockExchangeResponse({ access_token: "fresh-token", expires_in: 5184000 });
    queryMock.mockResolvedValueOnce([]); // saveState

    const token = await getValidAccessToken("app-id", "app-secret", "seed-token", "eden");

    expect(token).toBe("fresh-token");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    // saveState is the second query() call — the INSERT ... ON CONFLICT upsert.
    const [sql, params] = queryMock.mock.calls[1];
    expect(sql).toMatch(/INSERT INTO meta_tokens/);
    expect(params[0]).toBe("eden");
    expect(params[1]).toBe("fresh-token");
  });

  it("returns the stored token as-is when it has no expiry", async () => {
    queryMock.mockResolvedValueOnce([{ access_token: "system-token", expires_at: null }]);

    const token = await getValidAccessToken("app-id", "app-secret", "seed-token");

    expect(token).toBe("system-token");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns the stored token unchanged when it's comfortably within its window", async () => {
    const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days out
    queryMock.mockResolvedValueOnce([{ access_token: "still-good", expires_at: farFuture }]);

    const token = await getValidAccessToken("app-id", "app-secret", "seed-token");

    expect(token).toBe("still-good");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("proactively refreshes when inside the 7-day margin, and persists the new token", async () => {
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(); // 3 days out
    queryMock.mockResolvedValueOnce([{ access_token: "about-to-expire", expires_at: soon }]);
    mockExchangeResponse({ access_token: "refreshed-token", expires_in: 5184000 });
    queryMock.mockResolvedValueOnce([]); // saveState

    const token = await getValidAccessToken("app-id", "app-secret", "seed-token", "matama");

    expect(token).toBe("refreshed-token");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, params] = queryMock.mock.calls[1];
    expect(params[0]).toBe("matama");
    expect(params[1]).toBe("refreshed-token");
  });

  it("throws TokenError instead of silently guessing once the token has fully expired", async () => {
    // Real failure mode this guards against: a token that expired days ago
    // can't be refreshed via the same exchange call Meta uses for
    // not-yet-expired tokens — Meta's API rejects it. Silently attempting
    // the exchange would produce a confusing downstream error instead of
    // telling the operator what actually happened and what to do about it.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    queryMock.mockResolvedValueOnce([{ access_token: "dead-token", expires_at: yesterday }]);

    await expect(getValidAccessToken("app-id", "app-secret", "seed-token")).rejects.toThrow(TokenError);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
