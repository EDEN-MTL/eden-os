import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../db", () => ({ query: (...args: unknown[]) => queryMock(...args) }));
vi.mock("../meta", () => ({ getMetaConfig: vi.fn(), MetaClient: vi.fn() }));
vi.mock("../../agents/forge/ads/sync", () => ({ syncMetaPerformance: vi.fn() }));
vi.mock("../../agents/lens/report", () => ({
  computeWeeklyTotals: vi.fn(),
  formatAllClientsReport: vi.fn(),
}));
vi.mock("../../agents/iris/dial-pending", () => ({ runDialPendingCalls: vi.fn() }));

const evaluateMock = vi.fn();
const markTriggeredMock = vi.fn();
vi.mock("../../agents/forge/ads/engine", () => ({
  evaluate: (...args: unknown[]) => evaluateMock(...args),
  markTriggered: (...args: unknown[]) => markTriggeredMock(...args),
}));

const enqueueMock = vi.fn();
const recordSlackMessageMock = vi.fn();
vi.mock("../../agents/forge/ads/queue", () => ({
  enqueue: (...args: unknown[]) => enqueueMock(...args),
  recordSlackMessage: (...args: unknown[]) => recordSlackMessageMock(...args),
}));

const sendMessageMock = vi.fn();
vi.mock("../slack", () => ({ sendMessage: (...args: unknown[]) => sendMessageMock(...args) }));

vi.mock("fs", () => ({ readFileSync: vi.fn(() => JSON.stringify({ clientName: "Eden" })) }));

import { runRuleEvaluation } from "./index";

const proposedAction = {
  rule: { id: "auto-cpl-high", name: "CPL above config threshold" } as any,
  entityType: "adset" as const,
  entityId: "adset_1",
  entityName: "Eden RE Partner Offer - AdSet Leads",
  actionType: "notify_only",
  actionPayload: { type: "notify_only" },
  reasoning: "[CPL above config threshold] cpl=150.0 gt 120.0 over last 7d (spend=$300.00, leads=2).",
  metricsSnapshot: {} as any,
  autoExecuteEligible: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LENS_OPS_CHANNEL = "C_OPS";
});

afterEach(() => {
  delete process.env.LENS_OPS_CHANNEL;
});

describe("runRuleEvaluation", () => {
  it("does nothing when a client has no proposed actions", async () => {
    queryMock.mockResolvedValueOnce([{ client_id: "eden" }]);
    evaluateMock.mockResolvedValueOnce([]);

    await runRuleEvaluation();

    expect(enqueueMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("enqueues, marks cooldown, and Slack-notifies for a proposed action", async () => {
    queryMock.mockResolvedValueOnce([{ client_id: "eden" }]);
    evaluateMock.mockResolvedValueOnce([proposedAction]);
    enqueueMock.mockResolvedValueOnce(42);
    sendMessageMock.mockResolvedValueOnce({ ts: "1234.5678" });

    await runRuleEvaluation();

    expect(evaluateMock).toHaveBeenCalledWith("eden");
    expect(enqueueMock).toHaveBeenCalledWith(proposedAction, "eden");
    expect(markTriggeredMock).toHaveBeenCalledWith(proposedAction.rule, "adset_1");

    expect(sendMessageMock).toHaveBeenCalledWith(
      "forge",
      expect.objectContaining({
        channel: "C_OPS",
        text: expect.stringContaining("Eden RE Partner Offer - AdSet Leads"),
      })
    );
    const text = sendMessageMock.mock.calls[0][1].text;
    expect(text).toContain(proposedAction.reasoning);
    expect(text).toContain("Eden"); // client name

    expect(recordSlackMessageMock).toHaveBeenCalledWith(42, "C_OPS", "1234.5678");
  });

  it("still enqueues and marks cooldown when LENS_OPS_CHANNEL is unset, but skips Slack entirely", async () => {
    delete process.env.LENS_OPS_CHANNEL;
    queryMock.mockResolvedValueOnce([{ client_id: "eden" }]);
    evaluateMock.mockResolvedValueOnce([proposedAction]);
    enqueueMock.mockResolvedValueOnce(43);

    await runRuleEvaluation();

    expect(enqueueMock).toHaveBeenCalled();
    expect(markTriggeredMock).toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(recordSlackMessageMock).not.toHaveBeenCalled();
  });

  it("keeps going for other clients when one client's evaluation throws", async () => {
    queryMock.mockResolvedValueOnce([{ client_id: "broken-client" }, { client_id: "eden" }]);
    evaluateMock.mockRejectedValueOnce(new Error("Meta API down"));
    evaluateMock.mockResolvedValueOnce([proposedAction]);
    enqueueMock.mockResolvedValueOnce(44);
    sendMessageMock.mockResolvedValueOnce({ ts: "999" });

    await expect(runRuleEvaluation()).resolves.toBeUndefined();

    expect(evaluateMock).toHaveBeenCalledTimes(2);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });
});
