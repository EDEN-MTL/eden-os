import { beforeEach, describe, expect, it, vi } from "vitest";

const ghl = vi.hoisted(() => ({
  addContactTags: vi.fn(async () => ({})),
  createContactNote: vi.fn(async () => ({})),
  listOpportunitiesForContact: vi.fn(),
  listPipelines: vi.fn(),
  updateOpportunityStage: vi.fn(async () => ({})),
}));
vi.mock("../../shared/ghl", () => ghl);
const scout = vi.hoisted(() => ({ loadScoutConfig: vi.fn() }));
vi.mock("../scout", () => scout);
const iris = vi.hoisted(() => ({ loadIrisConfig: vi.fn() }));
vi.mock("./index", () => iris);

import { describeStageMove, mightBeStop, moveToNotInterested, recordOptOut } from "./opt-out";

const GHL = { locationId: "loc-1", apiKey: "key-1" };

beforeEach(() => {
  vi.clearAllMocks();
  iris.loadIrisConfig.mockReturnValue({ followUpCohort: { notReadyStage: "Not Ready", notInterestedStage: "Not Qualified/Not Interested" } });
  scout.loadScoutConfig.mockReturnValue({ historyStageIds: ["stage-live"] });
  ghl.listPipelines.mockResolvedValue([{ stages: [{ id: "stage-ni", name: "Not Qualified/Not Interested" }, { id: "stage-replied", name: "Replied" }, { id: "stage-live", name: "Live Transferred" }] }]);
  ghl.listOpportunitiesForContact.mockResolvedValue([{ id: "opp-1", status: "open", pipelineStageId: "stage-replied" }]);
});

describe("mightBeStop", () => {
  it.each([
    "Please do not reach out to me any more.   I will NOT talk to AI",
    "stop texting me",
    "Please remove me from your list",
    "I'm not interested anymore",
  ])("lets the classifier read %j", (text) => expect(mightBeStop(text)).toBe(true));

  it.each(["Thanks, talk soon!", "Yes, 2 pm works", "I'm looking at 3 bedrooms in Paradise"])("does not spend a model call on %j", (text) => expect(mightBeStop(text)).toBe(false));
});

describe("moveToNotInterested", () => {
  it("moves the open card to the configured Not Interested stage, by name", async () => {
    expect(await moveToNotInterested("c", "contact-1", GHL)).toEqual({ moved: true, stageName: "Not Qualified/Not Interested" });
    expect(ghl.updateOpportunityStage).toHaveBeenCalledWith("opp-1", "stage-ni", "loc-1", "key-1");
  });

  it("leaves a card in a column a person works", async () => {
    ghl.listOpportunitiesForContact.mockResolvedValue([{ id: "opp-1", status: "open", pipelineStageId: "stage-live" }]);
    expect(await moveToNotInterested("c", "contact-1", GHL)).toEqual({ moved: false, reason: "person-works-it" });
    expect(ghl.updateOpportunityStage).not.toHaveBeenCalled();
  });

  it("does nothing when it is already there, has no open card, or the stage name is wrong", async () => {
    ghl.listOpportunitiesForContact.mockResolvedValue([{ id: "opp-1", status: "open", pipelineStageId: "stage-ni" }]);
    expect(await moveToNotInterested("c", "contact-1", GHL)).toEqual({ moved: false, reason: "already-there" });
    ghl.listOpportunitiesForContact.mockResolvedValue([{ id: "opp-2", status: "won", pipelineStageId: "stage-replied" }]);
    expect(await moveToNotInterested("c", "contact-1", GHL)).toEqual({ moved: false, reason: "no-open-card" });
    iris.loadIrisConfig.mockReturnValue({ followUpCohort: { notReadyStage: "x", notInterestedStage: "No Such Stage" } });
    expect(await moveToNotInterested("c", "contact-1", GHL)).toEqual({ moved: false, reason: "stage-not-found" });
    iris.loadIrisConfig.mockReturnValue({});
    expect(await moveToNotInterested("c", "contact-1", GHL)).toEqual({ moved: false, reason: "no-stage-configured" });
    expect(ghl.updateOpportunityStage).not.toHaveBeenCalled();
  });
});

describe("recordOptOut", () => {
  it("tags, moves, leaves a note with their words, and says what it did", async () => {
    const summary = await recordOptOut("c", "contact-1", GHL, "Please do not reach out to me any more");

    expect(ghl.addContactTags).toHaveBeenCalledWith("contact-1", ["do not call"], "loc-1", "key-1");
    expect(summary).toBe("moved their card to *Not Qualified/Not Interested*");
    expect(String(ghl.createContactNote.mock.calls[0][1])).toContain("Please do not reach out to me any more");
  });

  it("still tags when the card move throws, and says so", async () => {
    ghl.listPipelines.mockRejectedValue(new Error("GHL down"));

    const summary = await recordOptOut("c", "contact-1", GHL, "stop");

    expect(ghl.addContactTags).toHaveBeenCalled();
    expect(summary).toMatch(/could not move their card/);
  });
});

describe("describeStageMove", () => {
  it("names every outcome plainly", () => {
    expect(describeStageMove({ moved: false, reason: "person-works-it" })).toMatch(/column a person works/);
    expect(describeStageMove({ moved: false, reason: "stage-not-found" })).toMatch(/could not find the Not Interested column/);
  });
});
