import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  getLead: vi.fn(),
  getStats: vi.fn(async () => ({ byStatus: { nurturing: 2 }, dueNow: 1 })),
  listLeads: vi.fn(async () => []),
  updateLead: vi.fn(async () => {}),
}));
vi.mock("./store", () => store);

const sendMod = vi.hoisted(() => {
  class EmberDisabledError extends Error {}
  return { EmberDisabledError, sendPendingForClient: vi.fn() };
});
vi.mock("./send", () => sendMod);
vi.mock("./scan", () => ({ runEmberScanForClient: vi.fn() }));

import { emberAgent } from "./index";
import { lead } from "./test-fixtures";

afterEach(() => vi.clearAllMocks());

const run = (name: string, input: any) => (emberAgent as any).executeTool(name, input).then(JSON.parse);

describe("EmberAgent tools", () => {
  it("defaults to the only client with an ember block", async () => {
    const out = await run("ember_pipeline_stats", {});
    expect(out).toEqual(expect.objectContaining({ clientId: "eden-sub-account-one", sendingEnabled: false, dueNow: 1 }));
  });

  it("reports the kill switch instead of throwing", async () => {
    sendMod.sendPendingForClient.mockRejectedValueOnce(new sendMod.EmberDisabledError("ember.enabled is false"));
    expect(await run("ember_send_now", {})).toEqual({ sent: false, reason: "ember.enabled is false" });
  });

  it("pauses only a nurturing lead", async () => {
    store.getLead.mockResolvedValueOnce(lead());
    expect((await run("ember_pause_lead", { leadId: 1, reason: "Jacob's calling her" })).status).toBe("paused");
    expect(store.updateLead).toHaveBeenCalledWith(1, { status: "paused", statusReason: "Jacob's calling her" });

    store.getLead.mockResolvedValueOnce(lead({ status: "replied" }));
    expect((await run("ember_pause_lead", { leadId: 1 })).error).toMatch(/replied/);
  });

  it("resumes only a paused lead — never an opted-out one", async () => {
    store.getLead.mockResolvedValueOnce(lead({ status: "opted_out" }));
    expect((await run("ember_resume_lead", { leadId: 1 })).error).toMatch(/only a paused lead/);
    expect(store.updateLead).not.toHaveBeenCalled();

    store.getLead.mockResolvedValueOnce(lead({ status: "paused" }));
    expect((await run("ember_resume_lead", { leadId: 1 })).status).toBe("nurturing");
  });
});
