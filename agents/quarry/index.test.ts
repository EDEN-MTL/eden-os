import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/claude", () => ({
  chatWithTools: vi.fn(),
  attachmentToBlock: vi.fn(),
}));
vi.mock("../../shared/slack", () => ({ sendMessage: vi.fn(async () => ({})), getUserRealName: vi.fn(async () => null) }));
vi.mock("../../shared/conversation-memory", () => ({
  loadHistory: vi.fn(async () => []),
  appendHistory: vi.fn(async () => {}),
}));
vi.mock("../../shared/agent-notes", () => ({
  loadNotes: vi.fn(async () => []),
  saveNote: vi.fn(async () => {}),
}));

const storeMocks = vi.hoisted(() => ({
  getPipelineStats: vi.fn(),
  listLeads: vi.fn(),
  getLead: vi.fn(),
  updateLead: vi.fn(async () => {}),
}));
vi.mock("./store", () => storeMocks);

const sendMocks = vi.hoisted(() => ({
  sendPending: vi.fn(),
  QuarryDisabledError: class QuarryDisabledError extends Error {},
}));
vi.mock("./send", () => sendMocks);

const pipelineMocks = vi.hoisted(() => ({
  run: vi.fn(),
  QuarryDisabledError: class QuarryDisabledError extends Error {},
  MissingCredentialsError: class MissingCredentialsError extends Error {},
}));
vi.mock("./pipeline", () => pipelineMocks);

const configMocks = vi.hoisted(() => ({
  loadQuarryConfig: vi.fn(() => ({ categoryTemplates: [{ query: "shoe repair", category: "trade-service", maxResults: 20 }] })),
  buildLocationSearches: vi.fn((config: any, location: string) =>
    config.categoryTemplates.map((t: any) => ({ ...t, query: `${t.query} ${location}` }))
  ),
}));
vi.mock("./config", () => configMocks);

const screenshotMocks = vi.hoisted(() => ({ close: vi.fn(async () => {}) }));
vi.mock("./screenshot", () => ({
  PlaywrightCapturer: class {
    close = screenshotMocks.close;
  },
}));

import { chatWithTools } from "../../shared/claude";
import { sendMessage } from "../../shared/slack";
import { quarryAgent } from "./index";

function toolUseBlock(id: string, name: string, input: any) {
  return { type: "tool_use" as const, id, name, input };
}
function endTurn(text: string) {
  return { content: [{ type: "text" as const, text, citations: null }], stop_reason: "end_turn" } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Quarry — quarry_pipeline_stats", () => {
  it("returns the real stats object as the tool result, not an estimate", async () => {
    const stats = { byApproval: { pending: 3, approved: 1 }, byStage: {}, qualified: 4, hasMobile: 0, hasEmail: 4, emailOptedOut: 0, smsRepliesTotal: 0, emailRepliesTotal: 1, sentTodaySms: 0, sentTodayEmail: 2 };
    storeMocks.getPipelineStats.mockResolvedValue(stats);
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({ content: [toolUseBlock("c1", "quarry_pipeline_stats", {})], stop_reason: "tool_use" } as any)
      .mockResolvedValueOnce(endTurn("4 qualified, 2 emails out today."));

    const reply = await quarryAgent.generateReply("k1", "how are we doing today");

    expect(reply).toBe("4 qualified, 2 emails out today.");
    const secondCallMessages = vi.mocked(chatWithTools).mock.calls[1][1] as any;
    const toolResult = secondCallMessages[secondCallMessages.length - 1].content[0].content;
    expect(JSON.parse(toolResult)).toEqual(stats);
  });
});

describe("Quarry — quarry_approve_lead", () => {
  it("approves a lead by id", async () => {
    storeMocks.getLead.mockResolvedValue({ id: 12, name: "Chaussures Rivard" });
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({ content: [toolUseBlock("c1", "quarry_approve_lead", { leadId: 12, approve: true })], stop_reason: "tool_use" } as any)
      .mockResolvedValueOnce(endTurn("Approved #12."));

    await quarryAgent.generateReply("k2", "approve lead 12");

    expect(storeMocks.updateLead).toHaveBeenCalledWith(12, { approvalStatus: "approved" });
  });

  it("rejects without touching an approved lead's status when told to reject", async () => {
    storeMocks.getLead.mockResolvedValue({ id: 12, name: "Chaussures Rivard" });
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({ content: [toolUseBlock("c1", "quarry_approve_lead", { leadId: 12, approve: false })], stop_reason: "tool_use" } as any)
      .mockResolvedValueOnce(endTurn("Rejected #12."));

    await quarryAgent.generateReply("k3", "reject lead 12");

    expect(storeMocks.updateLead).toHaveBeenCalledWith(12, { approvalStatus: "rejected" });
  });

  it("fails clearly on an id that does not exist, rather than throwing", async () => {
    storeMocks.getLead.mockResolvedValue(null);
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({ content: [toolUseBlock("c1", "quarry_approve_lead", { leadId: 999, approve: true })], stop_reason: "tool_use" } as any)
      .mockResolvedValueOnce(endTurn("There's no lead #999."));

    const reply = await quarryAgent.generateReply("k4", "approve lead 999");

    expect(reply).toBe("There's no lead #999.");
    expect(storeMocks.updateLead).not.toHaveBeenCalled();
  });
});

describe("Quarry — quarry_send_now", () => {
  it("sends and returns the real report when the kill switch is on", async () => {
    const report = { smsNudge: { sent: 0 }, smsPitch: { sent: 0 }, emailNudge: { sent: 1 }, emailPitch: { sent: 3 } };
    sendMocks.sendPending.mockResolvedValue(report);
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({ content: [toolUseBlock("c1", "quarry_send_now", {})], stop_reason: "tool_use" } as any)
      .mockResolvedValueOnce(endTurn("Sent 3 pitches and 1 nudge."));

    const reply = await quarryAgent.generateReply("k5", "send the approved batch");

    expect(reply).toBe("Sent 3 pitches and 1 nudge.");
    expect(sendMocks.sendPending).toHaveBeenCalledWith("eden");
  });

  it("does not throw when the kill switch is off — reports the refusal as the tool result instead", async () => {
    // A raw thrown error here would be swallowed into a generic "Error: ..."
    // tool_result by BaseAgent's loop; catching QuarryDisabledError
    // specifically means the model gets the ACTUAL reason and can relay it,
    // rather than a stack trace framed as a failure.
    sendMocks.sendPending.mockRejectedValue(new sendMocks.QuarryDisabledError("quarry.enabled is false"));
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({ content: [toolUseBlock("c1", "quarry_send_now", {})], stop_reason: "tool_use" } as any)
      .mockResolvedValueOnce(endTurn("Can't send — quarry.enabled is off. Ask Jacob to flip it on."));

    const reply = await quarryAgent.generateReply("k6", "send the approved batch");

    expect(reply).toBe("Can't send — quarry.enabled is off. Ask Jacob to flip it on.");
    const secondCallMessages = vi.mocked(chatWithTools).mock.calls[1][1] as any;
    const toolResult = JSON.parse(secondCallMessages[secondCallMessages.length - 1].content[0].content);
    expect(toolResult.sent).toBe(false);
    expect(toolResult.reason).toMatch(/quarry.enabled/);
  });

  it("propagates a genuine unexpected error rather than misreporting it as a disabled kill switch", async () => {
    sendMocks.sendPending.mockRejectedValue(new Error("ECONNREFUSED"));
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({ content: [toolUseBlock("c1", "quarry_send_now", {})], stop_reason: "tool_use" } as any)
      .mockResolvedValueOnce(endTurn("Something went wrong sending — ECONNREFUSED."));

    const reply = await quarryAgent.generateReply("k7", "send the approved batch");
    expect(reply).toBe("Something went wrong sending — ECONNREFUSED.");
  });
});

describe("Quarry — quarry_run_discovery", () => {
  it("builds location-specific searches and runs discovery synced to GHL", async () => {
    const report = {
      discovered: 40, qualified: 12, autoApproved: 9, heldForNoContact: 0, syncedToGhl: 12, withEmail: 10, errors: [],
    };
    pipelineMocks.run.mockResolvedValue(report);
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({
        content: [toolUseBlock("c1", "quarry_run_discovery", { location: "Ottawa, ON", maxLeads: 50 })],
        stop_reason: "tool_use",
      } as any)
      .mockResolvedValueOnce(endTurn("Found 40 in Ottawa, 12 qualified, 9 auto-approved."));

    const reply = await quarryAgent.generateReply("k8", "find 50 businesses in Ottawa");

    expect(reply).toBe("Found 40 in Ottawa, 12 qualified, 9 auto-approved.");
    expect(configMocks.buildLocationSearches).toHaveBeenCalledWith(expect.anything(), "Ottawa, ON");
    expect(pipelineMocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "eden",
        stopAfter: "enrich",
        maxLeads: 50,
        syncToGhl: true,
        searches: [{ query: "shoe repair Ottawa, ON", category: "trade-service", maxResults: 20 }],
      })
    );
    const secondCallMessages = vi.mocked(chatWithTools).mock.calls[1][1] as any;
    const toolResult = JSON.parse(secondCallMessages[secondCallMessages.length - 1].content[0].content);
    expect(toolResult).toMatchObject({ location: "Ottawa, ON", discovered: 40, syncedToGhl: 12 });
  });

  it("closes the Playwright browser after a successful run — a real orphaned-process leak, confirmed live", async () => {
    // Confirmed live 2026-09-06: this capturer's browser was never closed
    // here, so every Slack-triggered run leaked one headless Chromium
    // process. After a full day of runs, the shared 512MB Render instance
    // (every agent in one process) ran out of memory and crashed mid-batch,
    // twice, hours apart.
    pipelineMocks.run.mockResolvedValue({
      discovered: 1, qualified: 1, autoApproved: 1, heldForNoContact: 0, syncedToGhl: 1, withEmail: 1, errors: [],
    });
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({
        content: [toolUseBlock("c1", "quarry_run_discovery", { location: "Ottawa, ON" })],
        stop_reason: "tool_use",
      } as any)
      .mockResolvedValueOnce(endTurn("Done."));

    await quarryAgent.generateReply("k-close-1", "find businesses in Ottawa");

    expect(screenshotMocks.close).toHaveBeenCalledTimes(1);
  });

  it("still closes the Playwright browser when the run itself throws", async () => {
    pipelineMocks.run.mockRejectedValue(new Error("Places API 500"));
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({
        content: [toolUseBlock("c1", "quarry_run_discovery", { location: "Ottawa, ON" })],
        stop_reason: "tool_use",
      } as any)
      .mockResolvedValueOnce(endTurn("That failed."));

    await quarryAgent.generateReply("k-close-2", "find businesses in Ottawa");

    expect(screenshotMocks.close).toHaveBeenCalledTimes(1);
  });

  it("posts an immediate acknowledgment to the requesting channel/thread before the (slow) run finishes", async () => {
    // Confirmed live: a real batch can take 15-20+ minutes with nothing
    // posted until it's done — without this, silence reads as "didn't hear
    // the request" rather than "still working."
    pipelineMocks.run.mockResolvedValue({
      discovered: 5, qualified: 1, autoApproved: 1, heldForNoContact: 0, syncedToGhl: 1, withEmail: 1, errors: [],
    });
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({
        content: [toolUseBlock("c1", "quarry_run_discovery", { location: "Kingston, ON" })],
        stop_reason: "tool_use",
      } as any)
      .mockResolvedValueOnce(endTurn("Found 5 in Kingston."));

    await quarryAgent.generateReply("k9", "find businesses in Kingston", undefined, undefined, {
      channelId: "C0C0AKAK5S4",
      threadTs: "111.222",
    });

    expect(sendMessage).toHaveBeenCalledWith("quarry", expect.objectContaining({
      channel: "C0C0AKAK5S4",
      threadTs: "111.222",
      text: expect.stringContaining("Kingston, ON"),
    }));
    // The ack must go out before the slow run, not after.
    const ackCallOrder = vi.mocked(sendMessage).mock.invocationCallOrder[0];
    const runCallOrder = pipelineMocks.run.mock.invocationCallOrder[0];
    expect(ackCallOrder).toBeLessThan(runCallOrder);
  });

  it("does not attempt an acknowledgment when called with no channel context (e.g. the dashboard)", async () => {
    pipelineMocks.run.mockResolvedValue({
      discovered: 0, qualified: 0, autoApproved: 0, heldForNoContact: 0, syncedToGhl: 0, withEmail: 0, errors: [],
    });
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({
        content: [toolUseBlock("c1", "quarry_run_discovery", { location: "Ottawa, ON" })],
        stop_reason: "tool_use",
      } as any)
      .mockResolvedValueOnce(endTurn("Found 0."));

    await quarryAgent.generateReply("k10", "find businesses in Ottawa");

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("refuses to guess a location and never calls run", async () => {
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({
        content: [toolUseBlock("c1", "quarry_run_discovery", {})],
        stop_reason: "tool_use",
      } as any)
      .mockResolvedValueOnce(endTurn("I need a city or region to search."));

    await quarryAgent.generateReply("k9", "go find some businesses");

    expect(pipelineMocks.run).not.toHaveBeenCalled();
  });

  it("reports the kill switch refusal as the tool result instead of throwing", async () => {
    pipelineMocks.run.mockRejectedValue(new pipelineMocks.QuarryDisabledError("quarry.enabled is false"));
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({
        content: [toolUseBlock("c1", "quarry_run_discovery", { location: "Ottawa, ON" })],
        stop_reason: "tool_use",
      } as any)
      .mockResolvedValueOnce(endTurn("Can't run discovery — quarry.enabled is off."));

    const reply = await quarryAgent.generateReply("k10", "find businesses in Ottawa");

    expect(reply).toBe("Can't run discovery — quarry.enabled is off.");
    const secondCallMessages = vi.mocked(chatWithTools).mock.calls[1][1] as any;
    const toolResult = JSON.parse(secondCallMessages[secondCallMessages.length - 1].content[0].content);
    expect(toolResult).toEqual({ ran: false, reason: "quarry.enabled is false" });
  });
});

describe("Quarry — quarry_list_pending", () => {
  it("trims to the requested limit and reports the true total separately", async () => {
    const leads = Array.from({ length: 5 }, (_, i) => ({
      id: i, name: `Biz ${i}`, category: "trade-service", email: null, isMobile: null, reasons: ["No website listed on Google"],
    }));
    storeMocks.listLeads.mockResolvedValue(leads);
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({ content: [toolUseBlock("c1", "quarry_list_pending", { limit: 2 })], stop_reason: "tool_use" } as any)
      .mockResolvedValueOnce(endTurn("2 of 5 shown."));

    await quarryAgent.generateReply("k8", "what's pending, just show me a couple");

    const secondCallMessages = vi.mocked(chatWithTools).mock.calls[1][1] as any;
    const toolResult = JSON.parse(secondCallMessages[secondCallMessages.length - 1].content[0].content);
    expect(toolResult.totalPending).toBe(5);
    expect(toolResult.shown).toBe(2);
    expect(toolResult.leads).toHaveLength(2);
  });
});
