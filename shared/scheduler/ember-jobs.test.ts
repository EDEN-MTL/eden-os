import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({ query: vi.fn() }));
vi.mock("../meta", () => ({ getMetaConfig: vi.fn(), MetaClient: vi.fn() }));
vi.mock("../../agents/forge/ads/sync", () => ({ syncMetaPerformance: vi.fn() }));
vi.mock("../../agents/lens/report", () => ({ computeWeeklyTotals: vi.fn(), formatAllClientsReport: vi.fn() }));
vi.mock("../../agents/iris/dial-pending", () => ({ runDialPendingCalls: vi.fn() }));
vi.mock("../slack", () => ({ sendMessage: vi.fn() }));

const emberConfig = vi.hoisted(() => ({ listEmberClientIds: vi.fn(), loadEmberConfig: vi.fn() }));
vi.mock("../../agents/ember/config", () => emberConfig);
const scan = vi.hoisted(() => ({ runEmberScanForClient: vi.fn(async () => ({ scanned: 0, enrolled: [], reactivated: [], exited: [] })) }));
vi.mock("../../agents/ember/scan", () => scan);
const send = vi.hoisted(() => ({ sendPendingForClient: vi.fn(async () => ({ ran: false, reason: "x" })) }));
vi.mock("../../agents/ember/send", () => send);
vi.mock("../../agents/ember/replies", () => ({ pollRepliesForClient: vi.fn(async () => ({ checked: 0, routedToEmber: 0, routedToIris: 0 })) }));

import { runEmberScan, runEmberSendPending } from "./index";

afterEach(() => vi.clearAllMocks());

describe("Ember scheduled jobs", () => {
  it("skip a client whose ember block is present but disabled — no scan, no sends", async () => {
    emberConfig.listEmberClientIds.mockReturnValue(["test", "live"]);
    emberConfig.loadEmberConfig.mockImplementation((id: string) => ({ enabled: id === "live" }));
    await runEmberScan();
    await runEmberSendPending();
    expect(scan.runEmberScanForClient).toHaveBeenCalledTimes(1);
    expect(scan.runEmberScanForClient).toHaveBeenCalledWith("live");
    expect(send.sendPendingForClient).toHaveBeenCalledTimes(1);
    expect(send.sendPendingForClient).toHaveBeenCalledWith("live");
  });

  it("one client's failure doesn't stop the next", async () => {
    emberConfig.listEmberClientIds.mockReturnValue(["a", "b"]);
    emberConfig.loadEmberConfig.mockReturnValue({ enabled: true });
    scan.runEmberScanForClient.mockRejectedValueOnce(new Error("GHL down"));
    await runEmberScan();
    expect(scan.runEmberScanForClient).toHaveBeenCalledTimes(2);
  });
});
