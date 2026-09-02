import { beforeEach, describe, expect, it, vi } from "vitest";

const readFileSyncMock = vi.fn();
vi.mock("fs", () => ({ readFileSync: (...args: unknown[]) => readFileSyncMock(...args) }));

import { loadOutcomeStages } from "./client-config";

function configWith(ghl: unknown) {
  return JSON.stringify({ clientId: "eden", ghl });
}

beforeEach(() => {
  readFileSyncMock.mockClear();
});

describe("loadOutcomeStages", () => {
  it("returns the outcomeStages object when wonStages is present", () => {
    readFileSyncMock.mockReturnValueOnce(configWith({ outcomeStages: { wonStages: ["closed_won"] } }));

    expect(loadOutcomeStages("eden")).toEqual({ wonStages: ["closed_won"] });
  });

  it("returns it when only lostStages is present (not wonStages)", () => {
    readFileSyncMock.mockReturnValueOnce(configWith({ outcomeStages: { lostStages: ["closed_lost"] } }));

    expect(loadOutcomeStages("eden")).toEqual({ lostStages: ["closed_lost"] });
  });

  it("returns it when only activeStages is present", () => {
    readFileSyncMock.mockReturnValueOnce(configWith({ outcomeStages: { activeStages: ["contacted"] } }));

    expect(loadOutcomeStages("eden")).toEqual({ activeStages: ["contacted"] });
  });

  it("returns undefined for an outcomeStages object with none of the three keys set", () => {
    // Distinguishes "the key exists but is empty/misconfigured" from a
    // genuinely absent key — both should leave deriveWon falling back to
    // GHL's own status field rather than reading as a hard false positive.
    readFileSyncMock.mockReturnValueOnce(configWith({ outcomeStages: {} }));

    expect(loadOutcomeStages("eden")).toBeUndefined();
  });

  it("returns undefined when the client config has no ghl.outcomeStages at all", () => {
    readFileSyncMock.mockReturnValueOnce(configWith(undefined));

    expect(loadOutcomeStages("eden")).toBeUndefined();
  });

  it("returns undefined rather than throwing when the client config file doesn't exist", () => {
    readFileSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    });

    expect(loadOutcomeStages("no-such-client")).toBeUndefined();
  });

  it("returns undefined rather than throwing on malformed JSON", () => {
    readFileSyncMock.mockReturnValueOnce("{ not valid json");

    expect(loadOutcomeStages("eden")).toBeUndefined();
  });
});
