import { afterEach, describe, expect, it, vi } from "vitest";

const configMod = vi.hoisted(() => ({ loadEmberConfig: vi.fn(), loadEmberOutcomeStages: vi.fn() }));
vi.mock("./config", async (orig) => ({ ...(await orig<any>()), ...configMod }));

const store = vi.hoisted(() => ({ listDue: vi.fn(async () => []) }));
vi.mock("./store", () => store);

const outreachMod = vi.hoisted(() => ({
  sendBatch: vi.fn(async (leads: any[]) => ({ attempted: leads.length, sent: leads.length, skipped: [], failed: [], capReached: false })),
}));
vi.mock("./outreach", async (orig) => ({ ...(await orig<any>()), ...outreachMod }));

const depsMod = vi.hoisted(() => ({ buildOutreachDeps: vi.fn(async () => ({})), resolveStageNames: vi.fn(async () => ({})) }));
vi.mock("./deps", () => depsMod);

import { EmberConfigError } from "./config";
import { EmberDisabledError, sendPendingForClient } from "./send";
import { config, lead, NOW } from "./test-fixtures";

afterEach(() => vi.clearAllMocks());

describe("sendPendingForClient", () => {
  it("refuses outright while the kill switch is off", async () => {
    configMod.loadEmberConfig.mockReturnValue(config({ enabled: false }));
    await expect(sendPendingForClient("c", { now: NOW })).rejects.toBeInstanceOf(EmberDisabledError);
    expect(store.listDue).not.toHaveBeenCalled();
  });

  it("refuses an SMS template with no STOP opt-out", async () => {
    const c = config();
    c.outreach.sms.templates = ["Hi {{firstName}}, still looking?"];
    configMod.loadEmberConfig.mockReturnValue(c);
    await expect(sendPendingForClient("c", { now: NOW })).rejects.toBeInstanceOf(EmberConfigError);
  });

  it("does nothing outside the send window", async () => {
    configMod.loadEmberConfig.mockReturnValue(config());
    const result = await sendPendingForClient("c", { now: new Date("2026-09-23T07:00:00Z") });
    expect(result).toEqual({ ran: false, reason: expect.stringContaining("send window") });
    expect(store.listDue).not.toHaveBeenCalled();
  });

  it("sends whatever is due", async () => {
    configMod.loadEmberConfig.mockReturnValue(config());
    store.listDue.mockResolvedValueOnce([lead()] as any);
    const result = await sendPendingForClient("c", { now: NOW });
    expect(result).toEqual(expect.objectContaining({ ran: true, due: 1, sent: 1 }));
  });

  it("never runs two batches for the same client at once", async () => {
    configMod.loadEmberConfig.mockReturnValue(config());
    let release!: () => void;
    store.listDue.mockResolvedValueOnce([lead()] as any);
    outreachMod.sendBatch.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ attempted: 1, sent: 1, skipped: [], failed: [], capReached: false })))
    );
    const first = sendPendingForClient("c", { now: NOW });
    await vi.waitFor(() => expect(outreachMod.sendBatch).toHaveBeenCalled());
    const second = await sendPendingForClient("c", { now: NOW });
    expect(second).toEqual({ ran: false, reason: "a send run is already in progress" });
    release();
    await first;
  });
});
