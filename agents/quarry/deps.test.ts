import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for a real, previously-invisible bug class: several
 * GHL calls built here forwarded locationId but silently dropped apiKey,
 * so they fell back to ghlRequest's bare GHL_API_KEY env var — which this
 * client (resolving its key from the DB via getGhlConfig instead) does not
 * set. Confirmed live 2026-09-06: moveStageByName's missing apiKey threw
 * "GHL_API_KEY not set" from INSIDE sendEmailOne's try block, AFTER the
 * email itself had already sent successfully, so a real, delivered pitch
 * (Kloepfer Custom Framing & Gallery) was reported to Jacob as a failure.
 */

const ghlMod = vi.hoisted(() => ({
  getGhlConfig: vi.fn(async () => ({ locationId: "loc1", apiKey: "key1" })),
  sendEmail: vi.fn(async () => ({ id: "msg1" })),
  sendMMS: vi.fn(async () => ({})),
  sendSMS: vi.fn(async () => ({})),
  updateContact: vi.fn(async () => ({})),
  updateOpportunityStage: vi.fn(async () => ({})),
}));
vi.mock("../../shared/ghl", () => ghlMod);

const configMod = vi.hoisted(() => ({
  loadQuarryConfig: vi.fn(() => ({ ghlPipeline: { name: "Website Offer Pipeline", stages: ["New Lead", "Initial Email Sent"] } })),
}));
vi.mock("./config", () => configMod);

const syncMod = vi.hoisted(() => ({
  resolvePipeline: vi.fn(async () => ({ pipelineId: "pl1", stageIds: { "New Lead": "st1", "Initial Email Sent": "st2" } })),
}));
vi.mock("./sync", () => syncMod);

import { buildEmailDeps, buildOutreachDeps, markEmailOptOutInGhl } from "./deps";

afterEach(() => vi.clearAllMocks());

describe("buildEmailDeps", () => {
  it("forwards apiKey on sendEmail", async () => {
    const deps = await buildEmailDeps("eden");
    await deps.sendEmail("c1", "subject", "<p>hi</p>", "jacob@test.com");
    expect(ghlMod.sendEmail).toHaveBeenCalledWith("c1", expect.anything(), "loc1", "key1");
  });

  it("forwards apiKey on moveStage — the call that was silently broken", async () => {
    const deps = await buildEmailDeps("eden");
    await deps.moveStage("op1", "Initial Email Sent");
    expect(ghlMod.updateOpportunityStage).toHaveBeenCalledWith("op1", "st2", "loc1", "key1");
  });
});

describe("buildOutreachDeps", () => {
  it("forwards apiKey on moveStage", async () => {
    const deps = await buildOutreachDeps("eden");
    await deps.moveStage("op1", "New Lead");
    expect(ghlMod.updateOpportunityStage).toHaveBeenCalledWith("op1", "st1", "loc1", "key1");
  });
});

describe("markEmailOptOutInGhl", () => {
  it("forwards apiKey on the DND-mirroring updateContact call", async () => {
    await markEmailOptOutInGhl({ clientId: "eden", ghlContactId: "c1" });
    expect(ghlMod.updateContact).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ inboundDndSettings: expect.anything() }),
      "loc1",
      "key1"
    );
  });

  it("does nothing when the lead has no GHL contact yet", async () => {
    await markEmailOptOutInGhl({ clientId: "eden", ghlContactId: null });
    expect(ghlMod.updateContact).not.toHaveBeenCalled();
  });

  it("swallows a GHL failure rather than throwing — the local opt-out flag is the source of truth", async () => {
    ghlMod.updateContact.mockRejectedValueOnce(new Error("GHL API Error 500"));
    await expect(markEmailOptOutInGhl({ clientId: "eden", ghlContactId: "c1" })).resolves.toBeUndefined();
  });
});
