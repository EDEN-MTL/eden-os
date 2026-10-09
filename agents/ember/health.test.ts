import { describe, expect, it, vi } from "vitest";

vi.mock("./store", () => ({ getHealth: vi.fn(), setHealth: vi.fn(), optOutsLastDay: vi.fn() }));

import { assessBatch, assessOptOuts, checkHealth, COOL_OFF_MINUTES, HealthStore, resumeHealth, tripHealth } from "./health";
import { HealthRow } from "./store";
import { NOW } from "./test-fixtures";

function memStore(initial?: Partial<HealthRow>): HealthStore & { row: HealthRow } {
  const s = {
    row: { state: "ok", reason: null, pausedUntil: null, cooldowns: 0, lastTripAt: null, ...initial } as HealthRow,
    get: async () => ({ ...s.row }),
    set: async (_id: string, h: HealthRow) => {
      s.row = { ...h };
    },
  };
  return s;
}
const batch = (over: any = {}) => ({ attempted: 0, sent: 0, skipped: [], failed: [], capReached: false, ...over });
const fail = (error: string) => ({ leadId: 1, sent: false, error });
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

describe("assessBatch — what a send run says about Ember's health", () => {
  it("a clean run is fine, and so is one stray failure", () => {
    expect(assessBatch(batch({ attempted: 5, sent: 5 }))).toBeNull();
    expect(assessBatch(batch({ attempted: 5, sent: 4, failed: [fail("timeout")] }))).toBeNull();
  });

  it("a run of failed sends is a hiccup — cool off", () => {
    const r = assessBatch(batch({ attempted: 4, sent: 1, failed: [fail("502"), fail("502"), fail("timeout")] }));
    expect(r?.severity).toBe("cool");
  });

  it("the number or account being refused needs a person — stop", () => {
    expect(assessBatch(batch({ attempted: 1, failed: [fail("Invalid from number")] }))?.severity).toBe("stop");
    expect(assessBatch(batch({ attempted: 1, failed: [fail("Request failed with status 401")] }))?.severity).toBe("stop");
  });

  it("the AI failing for several leads is a hiccup — cool off", () => {
    const skipped = [1, 2, 3].map(() => ({ leadId: 1, sent: false, skippedReason: "history review failed: overloaded" }));
    expect(assessBatch(batch({ attempted: 3, skipped }))?.severity).toBe("cool");
  });
});

describe("assessOptOuts", () => {
  it("stops when several leads asked to stop and they're a real share of the day's texts", async () => {
    expect((await assessOptOuts("c", async () => ({ stops: 3, sends: 10 })))?.severity).toBe("stop");
  });
  it("ignores a normal trickle", async () => {
    expect(await assessOptOuts("c", async () => ({ stops: 2, sends: 10 }))).toBeNull();
    expect(await assessOptOuts("c", async () => ({ stops: 3, sends: 40 }))).toBeNull();
  });
});

describe("pausing and fixing itself", () => {
  it("cools off, then resumes by itself once the pause has passed", async () => {
    const store = memStore();
    const alert = vi.fn(async () => {});
    await tripHealth("c", "cool", "GHL timing out", alert, NOW, store);
    expect(store.row.state).toBe("cooling");
    expect(alert).toHaveBeenCalledWith(expect.stringContaining("paused itself"));

    expect((await checkHealth("c", alert, minutes(COOL_OFF_MINUTES - 1), store)).ok).toBe(false);
    expect((await checkHealth("c", alert, minutes(COOL_OFF_MINUTES + 1), store)).ok).toBe(true);
    expect(store.row.state).toBe("ok");
    expect(alert).toHaveBeenLastCalledWith(expect.stringContaining("resumed by itself"));
  });

  it("a third cool-off in a day means waiting isn't fixing it — stops for a person", async () => {
    const store = memStore();
    const alert = vi.fn(async () => {});
    await tripHealth("c", "cool", "x", alert, NOW, store);
    await tripHealth("c", "cool", "x", alert, minutes(70), store);
    expect(store.row.state).toBe("cooling");
    await tripHealth("c", "cool", "x", alert, minutes(140), store);
    expect(store.row.state).toBe("stopped");
    expect(alert).toHaveBeenLastCalledWith(expect.stringContaining("stopped itself"));
  });

  it("cool-offs a day apart don't add up", async () => {
    const store = memStore({ state: "ok", cooldowns: 2, lastTripAt: new Date(NOW.getTime() - 2 * 86_400_000).toISOString() });
    await tripHealth("c", "cool", "x", vi.fn(async () => {}), NOW, store);
    expect(store.row).toEqual(expect.objectContaining({ state: "cooling", cooldowns: 1 }));
  });

  it("a stop stays stopped — never resumes on its own, never re-alerts", async () => {
    const store = memStore();
    const alert = vi.fn(async () => {});
    await tripHealth("c", "stop", "Invalid from number", alert, NOW, store);
    await tripHealth("c", "cool", "again", alert, minutes(5), store);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(await checkHealth("c", alert, minutes(60 * 24 * 7), store)).toEqual({ ok: false, state: "stopped", reason: "Invalid from number" });
  });

  it("a person resumes it from Slack", async () => {
    const store = memStore({ state: "stopped", reason: "x", cooldowns: 3 });
    await resumeHealth("c", store);
    expect(store.row).toEqual(expect.objectContaining({ state: "ok", reason: null, cooldowns: 0 }));
  });
});
