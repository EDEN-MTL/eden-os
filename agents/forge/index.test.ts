import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/claude", () => ({
  chatWithTools: vi.fn(),
  attachmentToBlock: vi.fn((attachment: { data: Buffer; mediaType: string }) => ({
    type: "image",
    mediaType: attachment.mediaType,
    data: attachment.data.toString("base64"),
  })),
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

const searchGeoLocationsMock = vi.fn();
vi.mock("../../shared/meta", () => ({
  getMetaConfig: vi.fn(async () => ({
    appId: "app-id", appSecret: "app-secret", accessToken: "seed-token", adAccountId: "act_123", clientId: "eden",
  })),
  MetaClient: class {
    searchGeoLocations = searchGeoLocationsMock;
  },
}));
vi.mock("./ads/actions", () => ({ MetaActions: vi.fn() }));

const getGhlConfigMock = vi.fn();
const getCustomFieldDefsMock = vi.fn();
const getContactMock = vi.fn();
const listContactsPaginatedMock = vi.fn();
async function* asyncGenOf(items: any[]) {
  for (const item of items) yield item;
}
vi.mock("../../shared/ghl", () => ({
  getGhlConfig: (...args: unknown[]) => getGhlConfigMock(...args),
  getCustomFieldDefs: (...args: unknown[]) => getCustomFieldDefsMock(...args),
  getContact: (...args: unknown[]) => getContactMock(...args),
  listContactsPaginated: (...args: unknown[]) => listContactsPaginatedMock(...args),
}));

const executeManualMock = vi.fn();
vi.mock("./ads/executor", () => ({
  ActionExecutor: class {
    executeManual = executeManualMock;
  },
}));

import { chatWithTools } from "../../shared/claude";
import { forgeAgent } from "./index";

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

describe("Forge — search_ad_regions", () => {
  it("resolves a place name via MetaClient.searchGeoLocations, defaulting to region", async () => {
    searchGeoLocationsMock.mockResolvedValueOnce([{ key: "3847", name: "Texas", type: "region", country_code: "US" }]);
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({
        content: [toolUseBlock("call_1", "search_ad_regions", { clientId: "eden", queryText: "Texas" })],
        stop_reason: "tool_use",
      } as any)
      .mockResolvedValueOnce(endTurn("Texas resolves to region key 3847."));

    const reply = await forgeAgent.generateReply("key6", "what's the region key for Texas");

    expect(reply).toBe("Texas resolves to region key 3847.");
    expect(searchGeoLocationsMock).toHaveBeenCalledWith("Texas", ["region"]);
  });

  it("passes an explicit locationType through instead of the region default", async () => {
    searchGeoLocationsMock.mockResolvedValueOnce([{ key: "2418046", name: "Miami", type: "city" }]);
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({
        content: [toolUseBlock("call_1", "search_ad_regions", { clientId: "eden", queryText: "Miami", locationType: "city" })],
        stop_reason: "tool_use",
      } as any)
      .mockResolvedValueOnce(endTurn("Miami resolves to city key 2418046."));

    await forgeAgent.generateReply("key7", "what's the city key for Miami");

    expect(searchGeoLocationsMock).toHaveBeenCalledWith("Miami", ["city"]);
  });
});

describe("Forge — upload_ad_image", () => {
  it("uploads the turn's attachment, passing its bytes and filename through to executeManual", async () => {
    executeManualMock.mockResolvedValueOnce({ status: "executed", result: { after: { hash: "img_abc123" } } });
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({
        content: [toolUseBlock("call_1", "upload_ad_image", { clientId: "eden" })],
        stop_reason: "tool_use",
      } as any)
      .mockResolvedValueOnce(endTurn("Uploaded — hash img_abc123."));

    const attachment = { data: Buffer.from("fake-png-bytes"), mediaType: "image/png" as const, filename: "sunset-ad.png" };
    const reply = await forgeAgent.generateReply("key1", "upload this and make an ad from it", undefined, attachment);

    expect(reply).toBe("Uploaded — hash img_abc123.");
    expect(executeManualMock).toHaveBeenCalledWith(
      "upload_image",
      "image",
      "",
      "sunset-ad.png",
      { filename: "sunset-ad.png", file_bytes: attachment.data },
      "jacob-via-chat"
    );
  });

  it("fails clearly, without crashing, when no image is attached to the message", async () => {
    // The whole point of reading the attachment off the turn rather than a
    // tool_use argument: the model can't fabricate file bytes, so a call
    // with nothing attached has to fail in a way the model can relay back
    // ("attach the file"), not silently succeed on garbage.
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({
        content: [toolUseBlock("call_1", "upload_ad_image", { clientId: "eden" })],
        stop_reason: "tool_use",
      } as any)
      .mockResolvedValueOnce(endTurn("Nothing's attached — send the image and I'll upload it."));

    const reply = await forgeAgent.generateReply("key2", "upload the image and make an ad");

    expect(reply).toBe("Nothing's attached — send the image and I'll upload it.");
    expect(executeManualMock).not.toHaveBeenCalled();

    const secondCallMessages = vi.mocked(chatWithTools).mock.calls[1][1];
    const toolResultMessage = secondCallMessages[secondCallMessages.length - 1] as any;
    expect(toolResultMessage.content[0].content).toMatch(/No image is attached/);
  });

  it("derives a filename from the media type when the attachment has none", async () => {
    executeManualMock.mockResolvedValueOnce({ status: "executed", result: {} });
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({
        content: [toolUseBlock("call_1", "upload_ad_image", { clientId: "eden" })],
        stop_reason: "tool_use",
      } as any)
      .mockResolvedValueOnce(endTurn("Done."));

    const attachment = { data: Buffer.from("fake-jpeg-bytes"), mediaType: "image/jpeg" as const };
    await forgeAgent.generateReply("key3", "upload this", undefined, attachment);

    const [, , , , payload] = executeManualMock.mock.calls[0];
    expect(payload.filename).toBe("attachment.jpeg");
  });
});

describe("Forge — create_ad_creative and create_ad", () => {
  it("passes camelCase fields straight through for create_ad_creative", async () => {
    executeManualMock.mockResolvedValueOnce({ status: "executed", result: { after: { id: "creative_1" } } });
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({
        content: [
          toolUseBlock("call_1", "create_ad_creative", {
            clientId: "eden",
            name: "Sunset ad v1",
            imageHash: "img_abc123",
            headline: "I'll cover your first $2,000 in ads",
            primaryText: "For 4 real estate teams this September.",
            linkUrl: "https://edenmtl.com/get-started/",
          }),
        ],
        stop_reason: "tool_use",
      } as any)
      .mockResolvedValueOnce(endTurn("Creative created."));

    await forgeAgent.generateReply("key4", "create the creative");

    expect(executeManualMock).toHaveBeenCalledWith(
      "create_ad_creative",
      "creative",
      "",
      "Sunset ad v1",
      {
        name: "Sunset ad v1",
        imageHash: "img_abc123",
        headline: "I'll cover your first $2,000 in ads",
        primaryText: "For 4 real estate teams this September.",
        linkUrl: "https://edenmtl.com/get-started/",
        callToActionType: undefined,
        description: undefined,
      },
      "jacob-via-chat"
    );
  });

  it("passes urlTags through for create_ad_creative — the only place Meta honors ad-level attribution stamping", async () => {
    executeManualMock.mockResolvedValueOnce({ status: "executed", result: { after: { id: "creative_2" } } });
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({
        content: [
          toolUseBlock("call_1", "create_ad_creative", {
            clientId: "3-percent-east-coast",
            name: "Listing ad v2",
            imageHash: "img_xyz789",
            headline: "New listing",
            primaryText: "Book a showing today.",
            linkUrl: "https://example.com/listing",
            urlTags: "utm_campaign={{campaign.id}}&utm_content={{ad.id}}&utm_term={{adset.id}}&fbclid={{fbclid}}",
          }),
        ],
        stop_reason: "tool_use",
      } as any)
      .mockResolvedValueOnce(endTurn("Creative created with attribution tags."));

    await forgeAgent.generateReply("key4b", "create the creative with attribution tags");

    expect(executeManualMock).toHaveBeenCalledWith(
      "create_ad_creative",
      "creative",
      "",
      "Listing ad v2",
      expect.objectContaining({
        urlTags: "utm_campaign={{campaign.id}}&utm_content={{ad.id}}&utm_term={{adset.id}}&fbclid={{fbclid}}",
      }),
      "jacob-via-chat"
    );
  });

  it("snake_cases adsetId/creativeId for create_ad, matching what executor.dispatch expects", async () => {
    // Real correctness property, not stylistic: ActionExecutor.dispatch's
    // "create_ad" case reads payload.adset_id/payload.creative_id, not
    // camelCase — a mismatch here would silently pass undefined to Meta.
    executeManualMock.mockResolvedValueOnce({ status: "executed", result: { after: { id: "ad_1" } } });
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({
        content: [toolUseBlock("call_1", "create_ad", { clientId: "eden", adsetId: "adset_1", name: "Sunset ad", creativeId: "creative_1" })],
        stop_reason: "tool_use",
      } as any)
      .mockResolvedValueOnce(endTurn("Ad created, landed paused."));

    await forgeAgent.generateReply("key5", "create the ad");

    expect(executeManualMock).toHaveBeenCalledWith(
      "create_ad",
      "ad",
      "",
      "Sunset ad",
      { adset_id: "adset_1", name: "Sunset ad", creative_id: "creative_1" },
      "jacob-via-chat"
    );
  });

  it("update_ad_creative repoints an existing ad at a new creative, keyed by adId not name", async () => {
    // The whole point of this tool: change an ad's copy without a new ad ID
    // or losing its spend history — entityId must be the existing adId.
    executeManualMock.mockResolvedValueOnce({ status: "executed", result: { after: { id: "ad_1", creative: { id: "creative_2" } } } });
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({
        content: [toolUseBlock("call_1", "update_ad_creative", { clientId: "eden", adId: "ad_1", creativeId: "creative_2" })],
        stop_reason: "tool_use",
      } as any)
      .mockResolvedValueOnce(endTurn("Ad repointed to the new creative."));

    await forgeAgent.generateReply("key6", "swap ad_1 to the new creative");

    expect(executeManualMock).toHaveBeenCalledWith(
      "update_ad_creative",
      "ad",
      "ad_1",
      null,
      { creative_id: "creative_2" },
      "jacob-via-chat"
    );
  });
});

describe("Forge — check_lead_attribution", () => {
  beforeEach(() => {
    getGhlConfigMock.mockReset();
    getCustomFieldDefsMock.mockReset();
    getContactMock.mockReset();
    listContactsPaginatedMock.mockReset();
  });

  it("reports real attribution status per recent contact, using config/ghl-field-map.3-percent-east-coast.json", async () => {
    // Real fixture, not a mock: this file actually exists in the repo and
    // is what the tool reads to resolve fieldKeys — exercising it here
    // catches a config/code mismatch, not just the happy path.
    getGhlConfigMock.mockResolvedValueOnce({ apiKey: "key", locationId: "loc_1" });
    getCustomFieldDefsMock.mockResolvedValueOnce([
      { id: "fld_fbclid", fieldKey: "contact.fbclid" },
      { id: "fld_ad_id", fieldKey: "contact.meta_ad_id" },
    ]);
    listContactsPaginatedMock.mockReturnValueOnce(asyncGenOf([{ id: "c1" }, { id: "c2" }]));
    getContactMock.mockImplementation(async (id: string) => {
      if (id === "c1") {
        return { contact: { id: "c1", contactName: "Attributed Lead", customFields: [{ id: "fld_ad_id", value: "120200000000001" }] } };
      }
      return { contact: { id: "c2", contactName: "Unattributed Lead", customFields: [] } };
    });

    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({
        content: [toolUseBlock("call_1", "check_lead_attribution", { clientId: "3-percent-east-coast" })],
        stop_reason: "tool_use",
      } as any)
      .mockResolvedValueOnce(endTurn("1 of 2 recent leads carries ad attribution."));

    await forgeAgent.generateReply("key7", "check attribution for 3-percent-east-coast");

    const secondCallMessages = vi.mocked(chatWithTools).mock.calls[1][1] as any;
    const toolResult = JSON.parse(secondCallMessages[secondCallMessages.length - 1].content[0].content);

    expect(toolResult.checked).toBe(2);
    expect(toolResult.attributedCount).toBe(1);
    expect(toolResult.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contactId: "c1", attributed: true }),
        expect.objectContaining({ contactId: "c2", attributed: false }),
      ])
    );
  });

  it("errors plainly when the client has no GHL account configured, rather than guessing", async () => {
    getGhlConfigMock.mockResolvedValueOnce(null);

    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({
        content: [toolUseBlock("call_1", "check_lead_attribution", { clientId: "no-ghl-client" })],
        stop_reason: "tool_use",
      } as any)
      .mockResolvedValueOnce(endTurn("No GHL account configured for that client."));

    await forgeAgent.generateReply("key8", "check attribution for no-ghl-client");

    const secondCallMessages = vi.mocked(chatWithTools).mock.calls[1][1] as any;
    const toolResultContent = secondCallMessages[secondCallMessages.length - 1].content[0].content;
    expect(toolResultContent).toMatch(/No GHL account configured/);
    expect(getCustomFieldDefsMock).not.toHaveBeenCalled();
  });

  it("includes the complete unfiltered first contact only when includeRawSample is set", async () => {
    getGhlConfigMock.mockResolvedValueOnce({ apiKey: "key", locationId: "loc_1" });
    getCustomFieldDefsMock.mockResolvedValueOnce([{ id: "fld_ad_id", fieldKey: "contact.meta_ad_id" }]);
    listContactsPaginatedMock.mockReturnValueOnce(asyncGenOf([{ id: "c1" }]));
    const rawContact = {
      id: "c1",
      customFields: [],
      // The whole point: a real field GHL actually returns that this
      // tool's own summary doesn't know to look for yet.
      attributionSource: { campaignId: "120200000000001", utmMedium: "paid social" },
    };
    getContactMock.mockResolvedValueOnce({ contact: rawContact });

    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({
        content: [toolUseBlock("call_1", "check_lead_attribution", { clientId: "3-percent-east-coast", includeRawSample: true })],
        stop_reason: "tool_use",
      } as any)
      .mockResolvedValueOnce(endTurn("Here's the raw shape."));

    await forgeAgent.generateReply("key9", "check attribution with raw sample");

    const secondCallMessages = vi.mocked(chatWithTools).mock.calls[1][1] as any;
    const toolResult = JSON.parse(secondCallMessages[secondCallMessages.length - 1].content[0].content);
    expect(toolResult.rawSample).toEqual({ contact: rawContact });
  });
});
