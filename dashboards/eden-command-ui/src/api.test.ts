import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDashboardKey, lensGet, setDashboardKey } from "./api";

function fakeStorage(initial: Record<string, string> = {}, broken = false) {
  const data = { ...initial };
  return {
    getItem: (k: string) => { if (broken) throw new Error("blocked"); return k in data ? data[k] : null; },
    setItem: (k: string, v: string) => { if (broken) throw new Error("blocked"); data[k] = v; },
    removeItem: (k: string) => { if (broken) throw new Error("blocked"); delete data[k]; },
  };
}

describe("the dashboard access key", () => {
  beforeEach(() => vi.stubGlobal("window", { localStorage: fakeStorage() }));
  afterEach(() => vi.unstubAllGlobals());

  it("is empty until someone types it in, then is kept in this browser and trimmed", () => {
    expect(getDashboardKey()).toBe("");
    expect(setDashboardKey("  abc123  ")).toBe(true);
    expect(getDashboardKey()).toBe("abc123");
  });

  it("can be cleared", () => {
    setDashboardKey("abc123");
    setDashboardKey("");
    expect(getDashboardKey()).toBe("");
  });

  it("does not throw when the browser blocks storage, and says it could not save", () => {
    vi.stubGlobal("window", { localStorage: fakeStorage({}, true) });
    expect(setDashboardKey("abc")).toBe(false);
    expect(getDashboardKey()).toBe("");
  });

  it("is sent with every Lens request once saved, and not before", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await lensGet("/clients");
    expect((fetchMock.mock.calls[0] as any)[1].headers["x-dashboard-key"]).toBeUndefined();
    setDashboardKey("secret-key");
    await lensGet("/clients");
    expect((fetchMock.mock.calls[1] as any)[1].headers["x-dashboard-key"]).toBe("secret-key");
  });
});
