import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  listOpenLeadsByContactId: vi.fn(async () => [] as any[]),
  getLeadByOpportunityId: vi.fn(async () => null as any),
  transitionStatus: vi.fn(async () => true),
  updateLead: vi.fn(async () => {}),
}));
vi.mock("./store", () => store);

const configMod = vi.hoisted(() => ({ loadEmberConfig: vi.fn(), loadEmberOutcomeStages: vi.fn() }));
vi.mock("./config", async (orig) => ({ ...(await orig<any>()), ...configMod }));

const alert = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./alerts", async (orig) => ({ ...(await orig<any>()), slackAlert: () => alert }));
vi.mock("./deps", async () => {
  const { STAGES } = await import("./test-fixtures");
  return { resolveStageNames: vi.fn(async () => STAGES) };
});

import { emberHandleInboundMessage, emberHandleStageUpdate, emberHandleTagUpdate } from "./webhooks";
import { config, lead, OUTCOME_STAGES } from "./test-fixtures";

afterEach(() => vi.clearAllMocks());

function enabled(on = true) {
  configMod.loadEmberConfig.mockReturnValue(config({ enabled: on }));
  configMod.loadEmberOutcomeStages.mockReturnValue(OUTCOME_STAGES);
}

describe("while ember.enabled is off", () => {
  it("ignores replies, tags and stage moves entirely", async () => {
    enabled(false);
    store.listOpenLeadsByContactId.mockResolvedValue([lead()]);
    store.getLeadByOpportunityId.mockResolvedValue(lead());
    expect(await emberHandleInboundMessage("c1", "yes!")).toBe(false);
    await emberHandleTagUpdate("c1", ["renewed interest"]);
    await emberHandleStageUpdate("o1", "s_confirmed");
    expect(store.updateLead).not.toHaveBeenCalled();
    expect(store.transitionStatus).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });
});

describe("with ember.enabled on", () => {
  it("a reply from a tracked lead stops the cadence and alerts", async () => {
    enabled();
    store.listOpenLeadsByContactId.mockResolvedValueOnce([lead()]);
    expect(await emberHandleInboundMessage("c1", "yes still looking")).toBe(true);
    expect(store.updateLead).toHaveBeenCalledWith(1, expect.objectContaining({ status: "replied" }));
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("a reply from an untracked contact is not Ember's", async () => {
    enabled();
    store.listOpenLeadsByContactId.mockResolvedValueOnce([]);
    expect(await emberHandleInboundMessage("stranger", "hello")).toBe(false);
  });

  it("reactivates on a renewed-interest tag, not on other tags", async () => {
    enabled();
    store.listOpenLeadsByContactId.mockResolvedValue([lead()]);
    await emberHandleTagUpdate("c1", ["buyer lead"]);
    expect(alert).not.toHaveBeenCalled();
    await emberHandleTagUpdate("c1", ["Renewed Interest"]);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("reactivates on a real stage move", async () => {
    enabled();
    store.getLeadByOpportunityId.mockResolvedValueOnce(lead());
    await emberHandleStageUpdate("o1", "s_confirmed");
    expect(alert).toHaveBeenCalledWith(expect.stringContaining("Buyer Confirmed"));
  });

  it("does not alert on a same-stage event (re-save or duplicate delivery)", async () => {
    enabled();
    store.getLeadByOpportunityId.mockResolvedValueOnce(lead());
    await emberHandleStageUpdate("o1", "s_nurture");
    expect(alert).not.toHaveBeenCalled();
    expect(store.transitionStatus).not.toHaveBeenCalled();
  });

  it("exits quietly when moved to a won stage", async () => {
    enabled();
    store.getLeadByOpportunityId.mockResolvedValueOnce(lead());
    await emberHandleStageUpdate("o1", "s_closed");
    expect(alert).not.toHaveBeenCalled();
    expect(store.transitionStatus).toHaveBeenCalledWith(1, expect.any(Array), expect.objectContaining({ status: "exited" }));
  });
});
