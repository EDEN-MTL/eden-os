import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn(async () => []) }));
vi.mock("../../shared/db", () => db);

const ghl = vi.hoisted(() => ({
  getGhlConfig: vi.fn(),
  getContact: vi.fn(),
  getCustomFieldDefs: vi.fn(),
  searchContacts: vi.fn(),
}));
vi.mock("../../shared/ghl", () => ghl);

const vapi = vi.hoisted(() => ({ getVapiEnvConfig: vi.fn(() => ({ serverUrl: "https://eden.example/webhooks/vapi" })) }));
vi.mock("../../shared/vapi", () => vapi);

const callingSettings = vi.hoisted(() => ({ isCallingEnabled: vi.fn(async () => true) }));
vi.mock("./calling-settings", () => callingSettings);

const irisIndex = vi.hoisted(() => ({ loadClientBranding: vi.fn(), loadIrisConfig: vi.fn() }));
vi.mock("./index", () => irisIndex);

const calling = vi.hoisted(() => ({ buildInboundAssistantConfig: vi.fn(() => ({ firstMessage: "fake assistant" })) }));
vi.mock("./calling", () => calling);

const scripts = vi.hoisted(() => ({
  buildLeadQualificationPrompt: vi.fn(() => "PROMPT"),
  extractFirstName: vi.fn((n: string | null) => (n ? n.split(" ")[0] : "there")),
}));
vi.mock("./scripts", () => scripts);

const qualification = vi.hoisted(() => ({ transferNumberForIntent: vi.fn(() => null), callbackCalendarForIntent: vi.fn(() => null) }));
vi.mock("./qualification", () => qualification);

const scout = vi.hoisted(() => ({ loadScoutConfig: vi.fn() }));
vi.mock("../scout", () => scout);

const scoutIntake = vi.hoisted(() => ({ buildKeyToId: vi.fn(() => new Map()), normaliseLead: vi.fn() }));
vi.mock("../scout/intake", () => scoutIntake);

const readdirSyncMock = vi.hoisted(() => vi.fn());
const readFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, readdirSync: readdirSyncMock, readFileSync: readFileSyncMock };
});

import { clientIdForVapiPhoneNumber, handleInboundCall } from "./inbound";

const PHONE_NUMBER_ID = "9e60ef71-73b4-4124-b59b-b7f7c829e8bc";
const CLIENT_CONFIG = JSON.stringify({ clientId: "3-percent-east-coast", iris: { inboundPhoneNumberId: PHONE_NUMBER_ID } });

function baseMessage(overrides: Record<string, any> = {}) {
  return {
    type: "assistant-request",
    call: { id: "call-1", phoneNumberId: PHONE_NUMBER_ID, customer: { number: "+17095550100" } },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  readdirSyncMock.mockReturnValue(["3-percent-east-coast.json"]);
  readFileSyncMock.mockReturnValue(CLIENT_CONFIG);
  callingSettings.isCallingEnabled.mockResolvedValue(true);
  irisIndex.loadIrisConfig.mockReturnValue({ transferNumbers: {}, questions: [] });
  irisIndex.loadClientBranding.mockReturnValue({ brandName: "3 Percent East Coast", city: "St. John's" });
  scout.loadScoutConfig.mockReturnValue({ fields: {} });
  ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
});

describe("clientIdForVapiPhoneNumber", () => {
  it("matches a client whose iris.inboundPhoneNumberId equals the given phoneNumberId", () => {
    expect(clientIdForVapiPhoneNumber(PHONE_NUMBER_ID)).toBe("3-percent-east-coast");
  });

  it("returns null when no client config has a matching inboundPhoneNumberId", () => {
    expect(clientIdForVapiPhoneNumber("some-other-vapi-number-id")).toBeNull();
  });
});

describe("handleInboundCall", () => {
  it("returns a generic error and does nothing else when the payload is missing caller/phoneNumberId/call id", async () => {
    const result = await handleInboundCall({ type: "assistant-request", call: {} });
    expect(result.error).toBeTruthy();
    expect(result.assistant).toBeUndefined();
    expect(ghl.getGhlConfig).not.toHaveBeenCalled();
  });

  it("returns an error without any GHL lookups when the phoneNumberId matches no configured client", async () => {
    const result = await handleInboundCall(baseMessage({ call: { id: "call-1", phoneNumberId: "unknown-number", customer: { number: "+17095550100" } } }));
    expect(result.error).toBeTruthy();
    expect(ghl.getGhlConfig).not.toHaveBeenCalled();
  });

  it("returns an error without any GHL lookups when Iris calling is disabled for this client", async () => {
    callingSettings.isCallingEnabled.mockResolvedValue(false);
    const result = await handleInboundCall(baseMessage());
    expect(result.error).toContain("3 Percent East Coast");
    expect(result.assistant).toBeUndefined();
    expect(ghl.searchContacts).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it("looks the caller up, builds the assistant with their real lead data, and logs the call as inbound", async () => {
    ghl.searchContacts.mockResolvedValue({ contacts: [{ id: "contact-1" }] });
    ghl.getContact.mockResolvedValue({ contact: { customFields: [], tags: [] } });
    ghl.getCustomFieldDefs.mockResolvedValue([]);
    const realLead = { name: "Kaitlyn Sheppard", intent: "buyer", phone: "+17095550100" };
    scoutIntake.normaliseLead.mockReturnValue(realLead);

    const result = await handleInboundCall(baseMessage());

    expect(scoutIntake.normaliseLead).toHaveBeenCalledWith({ customFields: [], tags: [] }, { fields: {} }, expect.any(Map));
    expect(scripts.buildLeadQualificationPrompt).toHaveBeenCalledWith(
      expect.anything(),
      realLead,
      "3 Percent East Coast",
      "St. John's",
      true,
      false,
      false,
      "inbound"
    );
    expect(calling.buildInboundAssistantConfig).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: "contact-1", origin: "inbound", phone: "+17095550100" }),
      expect.anything()
    );
    expect(result.assistant).toEqual({ firstMessage: "fake assistant" });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO iris_call_log"), [
      "3-percent-east-coast",
      "call-1",
      "contact-1",
      "+17095550100",
    ]);
  });

  it("still answers, with a cold blank lead, when the caller matches no GHL contact", async () => {
    ghl.searchContacts.mockResolvedValue({ contacts: [] });

    const result = await handleInboundCall(baseMessage());

    expect(scoutIntake.normaliseLead).not.toHaveBeenCalled();
    expect(ghl.getContact).not.toHaveBeenCalled();
    expect(scripts.buildLeadQualificationPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: null, intent: "unknown" }),
      "3 Percent East Coast",
      "St. John's",
      true,
      false,
      false,
      "inbound"
    );
    expect(calling.buildInboundAssistantConfig).toHaveBeenCalledWith(expect.objectContaining({ contactId: undefined }), expect.anything());
    expect(result.assistant).toEqual({ firstMessage: "fake assistant" });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO iris_call_log"), [
      "3-percent-east-coast",
      "call-1",
      null,
      "+17095550100",
    ]);
  });

  it("still returns the assistant even when the iris_call_log insert fails — logging is best-effort", async () => {
    ghl.searchContacts.mockResolvedValue({ contacts: [] });
    db.query.mockRejectedValueOnce(new Error("db down"));

    const result = await handleInboundCall(baseMessage());

    expect(result.assistant).toEqual({ firstMessage: "fake assistant" });
  });
});
