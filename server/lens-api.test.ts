import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";

const clients = vi.hoisted(() => ({ listLensClients: vi.fn(), clientTimezone: vi.fn(async () => "America/St_Johns") }));
vi.mock("../agents/lens/dashboard/clients", () => clients);
const data = vi.hoisted(() => ({ buildDashboardKpis: vi.fn(), loadDashboardInputs: vi.fn() }));
vi.mock("../agents/lens/dashboard/data", () => data);

import { computeMetrics, compareMetrics } from "../agents/lens/dashboard/metrics";
import { createLensRouter, isValidClientId, parsePeriod } from "./lens-api";

const CLIENT = {
  clientId: "3-percent-east-coast",
  name: "3 Percent East Coast",
  timezone: "America/St_Johns",
  meta: { connected: true, adAccountId: "act_1", lastDay: "2026-10-25" },
  ghl: { connected: true, lastLeadSync: null, lastAppointmentSync: null, leads: 5, appointments: 0 },
  missing: [],
};
const NOW = new Date("2026-10-27T15:00:00Z");
const baseInput = () => ({
  timeZone: "America/St_Johns",
  now: NOW,
  meta: [{ date: "2026-10-05", campaignId: "111111111111", campaignName: "Buyers", spend: 100, impressions: 1000, clicks: 20, reach: 900, leads: 2 }],
  knownCampaignIds: new Set(["111111111111"]),
  leads: [{ contactId: "a", createdAt: new Date("2026-10-05T15:00:00Z"), campaignId: "111111111111", stage: "Replied", dealValue: null, closedAt: null, tags: [] }],
  appointments: [],
  otherCosts: [],
  config: { closedStages: ["Deal Closed"], qualifiedStages: [], unqualifiedStages: [] },
  sources: { meta: true, appointments: false },
});

let server: Server;
let base: string;
async function start() {
  const app = express();
  app.use("/api/lens", createLensRouter());
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/lens`;
}

beforeEach(async () => {
  delete process.env.DASHBOARD_API_KEY;
  delete process.env.NODE_ENV;
  vi.spyOn(console, "error").mockImplementation(() => {});
  await start();
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("parsePeriod", () => {
  it("defaults to the last 30 days compared with the period before", () => {
    const p = parsePeriod({}, "America/St_Johns", NOW);
    expect(p).toMatchObject({ ok: true, preset: "last_30_days", compare: true, range: { from: "2026-09-27", to: "2026-10-26" } });
  });
  it("reads a custom range and compare=0", () => {
    expect(parsePeriod({ preset: "custom", from: "2026-10-01", to: "2026-10-07", compare: "0" }, "America/St_Johns", NOW)).toMatchObject({ ok: true, compare: false, range: { from: "2026-10-01", to: "2026-10-07" } });
  });
  it("rejects an unknown preset and a bad custom range with a plain message", () => {
    expect(parsePeriod({ preset: "forever" }, "America/St_Johns", NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/Unknown period/) });
    expect(parsePeriod({ preset: "custom", from: "2026-10-09", to: "2026-10-01" }, "America/St_Johns", NOW)).toMatchObject({ ok: false });
  });
});

describe("access", () => {
  it("refuses a missing or wrong key when one is configured, and accepts the right one", async () => {
    process.env.DASHBOARD_API_KEY = "secret";
    clients.listLensClients.mockResolvedValue([CLIENT]);
    expect((await fetch(`${base}/clients`)).status).toBe(401);
    expect((await fetch(`${base}/clients`, { headers: { "x-dashboard-key": "wrong" } })).status).toBe(401);
    expect((await fetch(`${base}/clients`, { headers: { "x-dashboard-key": "secret" } })).status).toBe(200);
  });
  it("refuses everything in production when no key is configured (client revenue must not be open)", async () => {
    process.env.NODE_ENV = "production";
    expect((await fetch(`${base}/clients`)).status).toBe(503);
  });
});

describe("GET /clients", () => {
  it("lists clients with what is connected and what is missing", async () => {
    clients.listLensClients.mockResolvedValue([CLIENT, { ...CLIENT, clientId: "eden-sub-account-one", missing: ["No Meta ad account connected"] }]);
    const body: any = await (await fetch(`${base}/clients`)).json();
    expect(body.clients).toHaveLength(2);
    expect(body.clients[1].missing).toEqual(["No Meta ad account connected"]);
  });
});

describe("GET /:clientId/kpis", () => {
  const stub = () => {
    const range = { from: "2026-09-26", to: "2026-10-25" };
    const prev = { from: "2026-08-27", to: "2026-09-25" };
    const current = computeMetrics({ ...baseInput(), range } as any);
    const previous = computeMetrics({ ...baseInput(), range: prev } as any);
    data.buildDashboardKpis.mockResolvedValue({ client: CLIENT, timezone: "America/St_Johns", range, current, previousRange: prev, previous, changes: compareMetrics(current, previous) });
  };

  it("returns the period, grouped metrics with definitions, the comparison, and the attribution method", async () => {
    stub();
    const res = await fetch(`${base}/3-percent-east-coast/kpis`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.client.name).toBe("3 Percent East Coast");
    expect(body.period).toMatchObject({ from: "2026-09-26", to: "2026-10-25", timezone: "America/St_Johns" });
    expect(body.previousPeriod.from).toBe("2026-08-27");
    expect(body.sections.map((s: any) => s.id)).toEqual(["meta", "appointments", "conversion", "revenue", "attribution"]);
    const spend = body.sections[0].metrics.find((m: any) => m.key === "spend");
    expect(spend).toMatchObject({ label: "Ad spend", value: 100, unit: "currency", source: "Meta", previous: 0 });
    expect(spend.definition).toMatch(/Total amount Meta spent/);
    expect(body.attribution.note).toMatch(/real Meta campaign ID/);
    expect(body.appointmentBasis).toBe("calendar");
  });

  it("a metric with a zero denominator comes back as null (N/A), never NaN or Infinity", async () => {
    stub();
    const body: any = await (await fetch(`${base}/3-percent-east-coast/kpis`)).json();
    const roas = body.sections[3].metrics.find((m: any) => m.key === "roas");
    expect(roas.value === 0 || roas.value === null).toBe(true);
    const ctr = body.sections[0].metrics.find((m: any) => m.key === "ctr");
    expect(Number.isFinite(ctr.value)).toBe(true);
    const showUp = body.sections[1].metrics.find((m: any) => m.key === "showUpRate");
    expect(showUp.value).toBeNull();
  });

  it("returns a clear 400 for a bad period, 404 for an unknown client, 400 for a bad id", async () => {
    expect((await fetch(`${base}/3-percent-east-coast/kpis?preset=forever`)).status).toBe(400);
    expect((await fetch(`${base}/..%2Fetc/kpis`)).status).toBe(400);
    data.buildDashboardKpis.mockResolvedValue(null);
    const res = await fetch(`${base}/no-such-client/kpis`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toMatch(/No client/);
  });

  it("does not leak internals on an unexpected failure", async () => {
    data.buildDashboardKpis.mockRejectedValue(new Error("password=hunter2 at db.internal:5432"));
    const res = await fetch(`${base}/3-percent-east-coast/kpis`);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/hunter2|5432/);
  });
});

describe("GET /:clientId/timeseries and /campaigns", () => {
  it("returns daily points for the period", async () => {
    data.loadDashboardInputs.mockResolvedValue({ client: CLIENT, timezone: "America/St_Johns", range: { from: "2026-10-01", to: "2026-10-07" }, previousRange: null, base: baseInput() });
    const body: any = await (await fetch(`${base}/3-percent-east-coast/timeseries?preset=custom&from=2026-10-01&to=2026-10-07&compare=0`)).json();
    expect(body.granularity).toBe("day");
    expect(body.points).toHaveLength(7);
    expect(body.points.find((p: any) => p.from === "2026-10-05").spend).toBe(100);
  });

  it("returns campaign rows that add up to the totals", async () => {
    data.loadDashboardInputs.mockResolvedValue({ client: CLIENT, timezone: "America/St_Johns", range: { from: "2026-10-01", to: "2026-10-31" }, previousRange: null, base: baseInput() });
    const body: any = await (await fetch(`${base}/3-percent-east-coast/campaigns?preset=custom&from=2026-10-01&to=2026-10-31`)).json();
    expect(body.rows[0]).toMatchObject({ campaignId: "111111111111", name: "Buyers", spend: 100, leads: 1 });
    expect(body.rows.reduce((s: number, r: any) => s + r.leads, 0)).toBe(body.totals.leads);
  });
});

describe("isValidClientId", () => {
  it("only allows lower-case ids with digits and hyphens", () => {
    expect(isValidClientId("matama-floors")).toBe(true);
    expect(isValidClientId("../x")).toBe(false);
  });
});
