import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  getHealth: vi.fn(async () => ({ state: "ok", reason: null, pausedUntil: null, cooldowns: 0, lastTripAt: null })),
  setHealth: vi.fn(async () => {}),
  optOutsLastDay: vi.fn(async () => ({ stops: 0, sends: 0 })),
  failedSendsForTouch: vi.fn(async () => 0),
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
  return { resolveStageNames: vi.fn(async () => STAGES), buildMoveStage: () => vi.fn(async () => {}) };
});

const replyDeps = vi.hoisted(() => ({ buildReplyContext: vi.fn(async () => ({ marker: "ctx" })) }));
vi.mock("./reply-deps", () => replyDeps);
const outreachMod = vi.hoisted(() => ({ handleReply: vi.fn(async () => "positive") }));
vi.mock("./outreach", async (orig) => ({ ...(await orig<any>()), ...outreachMod }));

import { emberHandleInboundMessage, emberHandleStageUpdate, emberHandleTagUpdate, emberMarkInboundSeen } from "./webhooks";
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
    expect(outreachMod.handleReply).not.toHaveBeenCalled();
    await emberHandleTagUpdate("c1", ["renewed interest"]);
    await emberHandleStageUpdate("o1", "s_confirmed");
    expect(store.updateLead).not.toHaveBeenCalled();
    expect(store.transitionStatus).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });
});

describe("with ember.enabled on", () => {
  it("a reply from a tracked lead is answered by Ember (handleReply with Ember's live context)", async () => {
    enabled();
    store.listOpenLeadsByContactId.mockResolvedValueOnce([lead()]);
    expect(await emberHandleInboundMessage("c1", "yes still looking")).toBe(true);
    expect(replyDeps.buildReplyContext).toHaveBeenCalled();
    expect(outreachMod.handleReply).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), "yes still looking", { marker: "ctx" });
    expect(store.updateLead).toHaveBeenCalledWith(1, { lastInboundSeenAt: expect.any(String) });
  });

  it("while Ember has stopped itself, a reply goes to a person instead of being answered", async () => {
    enabled();
    store.getHealth.mockResolvedValueOnce({ state: "stopped", reason: "opt-out spike", pausedUntil: null, cooldowns: 0, lastTripAt: null });
    store.listOpenLeadsByContactId.mockResolvedValueOnce([lead()]);
    expect(await emberHandleInboundMessage("c1", "yes still looking")).toBe(true);
    expect(outreachMod.handleReply).not.toHaveBeenCalled();
    expect(store.updateLead).toHaveBeenCalledWith(1, expect.objectContaining({ status: "replied" }));
    expect(alert).toHaveBeenCalledWith(expect.stringContaining("replied while Ember is stopped"));
  });

  it("a lead whose Iris call is already queued is still answered by Ember", async () => {
    enabled();
    store.listOpenLeadsByContactId.mockResolvedValueOnce([lead({ status: "handed_off" })]);
    await emberHandleInboundMessage("c1", "5pm works better");
    expect(outreachMod.handleReply).toHaveBeenCalled();
  });

  it("marks a reply seen when Iris answered it via the webhook", async () => {
    store.listOpenLeadsByContactId.mockResolvedValueOnce([lead({ status: "handed_off" })]);
    await emberMarkInboundSeen("c1");
    expect(store.updateLead).toHaveBeenCalledWith(1, { lastInboundSeenAt: expect.any(String) });
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
