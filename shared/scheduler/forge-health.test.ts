import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../db", () => ({ query: (...args: unknown[]) => queryMock(...args) }));

const getMetaConfigMock = vi.fn();
vi.mock("../meta", () => ({ getMetaConfig: (...args: unknown[]) => getMetaConfigMock(...args), MetaClient: vi.fn() }));
vi.mock("../../agents/forge/ads/sync", () => ({ syncMetaPerformance: vi.fn() }));
vi.mock("../../agents/lens/report", () => ({ computeWeeklyTotals: vi.fn(), formatAllClientsReport: vi.fn() }));
vi.mock("../../agents/iris/dial-pending", () => ({ runDialPendingCalls: vi.fn() }));

const getCampaignHealthMock = vi.fn();
vi.mock("../../agents/forge/ads/health", () => ({ getCampaignHealth: (...args: unknown[]) => getCampaignHealthMock(...args) }));
const formatHealthDigestMock = vi.fn(() => "digest text");
vi.mock("../../agents/forge/ads/health-digest", () => ({ formatHealthDigest: (...args: unknown[]) => formatHealthDigestMock(...(args as [])) }));

const sendMessageMock = vi.fn();
vi.mock("../slack", () => ({ sendMessage: (...args: unknown[]) => sendMessageMock(...args) }));

// 3% has a forge.health playbook; eden doesn't, so it must be skipped.
const CONFIGS: Record<string, unknown> = {
  "3-percent-east-coast": { clientName: "3% Realty East Coast", forge: { cplThreshold: 110, health: { funnels: [] } } },
  eden: { clientName: "Eden", forge: { cplThreshold: 30 } },
};
vi.mock("fs", () => ({
  readFileSync: vi.fn((path: string) => {
    const id = Object.keys(CONFIGS).find((k) => path.endsWith(`${k}.json`));
    if (!id) throw new Error("ENOENT");
    return JSON.stringify(CONFIGS[id]);
  }),
}));

import { runDailyForgeHealthReport } from "./index";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LENS_OPS_CHANNEL = "C_OPS";
  queryMock.mockResolvedValue([{ client_id: "3-percent-east-coast" }, { client_id: "eden" }]);
  getMetaConfigMock.mockResolvedValue({ adAccountId: "act_1" });
});

afterEach(() => {
  delete process.env.LENS_OPS_CHANNEL;
});

describe("runDailyForgeHealthReport", () => {
  it("posts one report per client with a health playbook, as Forge, to the ops channel only", async () => {
    getCampaignHealthMock.mockResolvedValue({ entities: [{ id: "x" }] });

    await runDailyForgeHealthReport();

    expect(getCampaignHealthMock).toHaveBeenCalledTimes(1);
    expect(getCampaignHealthMock.mock.calls[0][0]).toBe("3-percent-east-coast");
    expect(formatHealthDigestMock).toHaveBeenCalledWith("3% Realty East Coast", { entities: [{ id: "x" }] });
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith("forge", { channel: "C_OPS", text: "digest text" });
  });

  it("sends nothing for a client with nothing delivering", async () => {
    getCampaignHealthMock.mockResolvedValue({ entities: [] });

    await runDailyForgeHealthReport();

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("skips entirely without an ops channel, rather than guessing where to post", async () => {
    delete process.env.LENS_OPS_CHANNEL;

    await runDailyForgeHealthReport();

    expect(getCampaignHealthMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("survives one client's report failing", async () => {
    CONFIGS.eden = { clientName: "Eden", forge: { health: {} } };
    getCampaignHealthMock.mockRejectedValueOnce(new Error("Meta down")).mockResolvedValueOnce({ entities: [{ id: "y" }] });

    await runDailyForgeHealthReport();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(formatHealthDigestMock).toHaveBeenCalledWith("Eden", { entities: [{ id: "y" }] });
    CONFIGS.eden = { clientName: "Eden", forge: { cplThreshold: 30 } };
  });
});
