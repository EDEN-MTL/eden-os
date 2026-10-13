import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../db", () => ({ query: (...args: unknown[]) => queryMock(...args) }));
vi.mock("../meta", () => ({ getMetaConfig: vi.fn(), MetaClient: vi.fn() }));

const getGhlConfigMock = vi.fn();
vi.mock("../ghl", () => ({ getGhlConfig: (...args: unknown[]) => getGhlConfigMock(...args) }));

const syncGhlMock = vi.fn();
vi.mock("../../agents/forge/ads/sync", () => ({
  syncMetaPerformance: vi.fn(),
  syncGhl: (...args: unknown[]) => syncGhlMock(...args),
}));
vi.mock("../../agents/lens/report", () => ({ computeWeeklyTotals: vi.fn(), formatAllClientsReport: vi.fn() }));
vi.mock("../../agents/iris/dial-pending", () => ({ runDialPendingCalls: vi.fn() }));
vi.mock("../slack", () => ({ sendMessage: vi.fn() }));

import { runLeadSync } from "./index";

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.mockResolvedValue([{ client_id: "3-percent-east-coast" }, { client_id: "eden" }, { client_id: "no-ghl" }]);
  getGhlConfigMock.mockImplementation(async (id: string) =>
    id === "no-ghl" ? null : { locationId: `loc-${id}`, apiKey: `key-${id}`, attributionPipelineName: id === "eden" ? "Leads" : undefined }
  );
});

describe("runLeadSync", () => {
  it("syncs GHL leads for every client with both Meta and GHL configured, with that client's own credentials", async () => {
    syncGhlMock.mockResolvedValue(10);

    await runLeadSync();

    expect(syncGhlMock).toHaveBeenCalledTimes(2);
    expect(syncGhlMock).toHaveBeenCalledWith("loc-3-percent-east-coast", "3-percent-east-coast", undefined, "key-3-percent-east-coast");
    expect(syncGhlMock).toHaveBeenCalledWith("loc-eden", "eden", "Leads", "key-eden");
  });

  it("keeps going when one client's sync fails", async () => {
    syncGhlMock.mockRejectedValueOnce(new Error("GHL down")).mockResolvedValueOnce(5);

    await runLeadSync();

    expect(syncGhlMock).toHaveBeenCalledTimes(2);
  });
});
