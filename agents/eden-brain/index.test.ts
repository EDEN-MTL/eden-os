import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/claude", () => ({
  chatWithTools: vi.fn(),
  attachmentToBlock: vi.fn(),
}));
vi.mock("../../shared/slack", () => ({ sendMessage: vi.fn() }));
vi.mock("../../shared/conversation-memory", () => ({
  loadHistory: vi.fn(async () => []),
  appendHistory: vi.fn(async () => {}),
}));
vi.mock("../../shared/agent-notes", () => ({
  loadNotes: vi.fn(async () => []),
  saveNote: vi.fn(async () => {}),
}));

const queryMock = vi.fn();
vi.mock("../../shared/db", () => ({ query: (...args: unknown[]) => queryMock(...args) }));

const listPendingMock = vi.fn();
vi.mock("../forge/ads/queue", () => ({ listPending: (...args: unknown[]) => listPendingMock(...args) }));

const readEmergencyHoldAllMock = vi.fn();
vi.mock("../forge/ads/settings", () => ({ readEmergencyHoldAll: (...args: unknown[]) => readEmergencyHoldAllMock(...args) }));

vi.mock("fs", () => ({
  readdirSync: vi.fn(() => ["eden.json", "3-percent-east-coast.json"]),
  readFileSync: vi.fn((path: string) => {
    if (String(path).includes("3-percent-east-coast")) {
      return JSON.stringify({ clientId: "3-percent-east-coast", clientName: "3 Percent East Coast" });
    }
    return JSON.stringify({ clientId: "eden", clientName: "Eden" });
  }),
}));

import { chatWithTools } from "../../shared/claude";
import { edenBrain } from "./index";

function textBlock(text: string) {
  return { type: "text" as const, text, citations: null };
}
function toolUseBlock(id: string, name: string, input: any) {
  return { type: "tool_use" as const, id, name, input };
}
function endTurn(text: string) {
  return { content: [textBlock(text)], stop_reason: "end_turn" } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("EDEN — get_system_status", () => {
  it("reports real per-client sync recency, pending-action counts, and hold state — nothing invented", async () => {
    queryMock.mockResolvedValueOnce([
      { client_id: "eden", last_synced_at: "2026-09-10T12:00:00.000Z" },
    ]);
    listPendingMock.mockImplementation(async (clientId: string) =>
      clientId === "eden" ? [{ id: 1 }, { id: 2 }] : []
    );
    readEmergencyHoldAllMock.mockImplementation(async (clientId: string) => clientId !== "eden");

    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({
        content: [toolUseBlock("call_1", "get_system_status", {})],
        stop_reason: "tool_use",
      } as any)
      .mockResolvedValueOnce(endTurn("Eden: synced 12:00 UTC, 2 pending. 3 Percent East Coast: no sync recorded, hold on."));

    const reply = await edenBrain.generateReply("key1", "status update");

    expect(reply).toContain("Eden");
    const toolResultMessage = vi.mocked(chatWithTools).mock.calls[1][1].slice(-1)[0] as any;
    const status = JSON.parse(toolResultMessage.content[0].content);

    expect(status.statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          clientId: "eden",
          metaLastSyncedAt: "2026-09-10T12:00:00.000Z",
          pendingActionsAwaitingApproval: 2,
          emergencyHoldAll: false,
        }),
        expect.objectContaining({
          clientId: "3-percent-east-coast",
          metaLastSyncedAt: null,
          pendingActionsAwaitingApproval: 0,
          emergencyHoldAll: true,
        }),
      ])
    );
    expect(status.note).toMatch(/no ghl lead-sync/i);
  });

  it("degrades a single client's failure to null/empty rather than failing the whole status call", async () => {
    queryMock.mockResolvedValueOnce([]);
    listPendingMock.mockRejectedValue(new Error("db down"));
    readEmergencyHoldAllMock.mockRejectedValue(new Error("db down"));

    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({
        content: [toolUseBlock("call_1", "get_system_status", {})],
        stop_reason: "tool_use",
      } as any)
      .mockResolvedValueOnce(endTurn("Status unavailable for some clients."));

    await edenBrain.generateReply("key2", "status update");

    const toolResultMessage = vi.mocked(chatWithTools).mock.calls[1][1].slice(-1)[0] as any;
    const status = JSON.parse(toolResultMessage.content[0].content);
    expect(status.statuses[0]).toMatchObject({ pendingActionsAwaitingApproval: 0, emergencyHoldAll: null });
  });
});
