import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkAttributionReadiness, provisionAttributionFields } from "./provision";
import * as ghl from "../../../shared/ghl";

vi.mock("../../../shared/ghl", () => ({
  getCustomFieldDefs: vi.fn(),
  createCustomField: vi.fn(),
}));

const fieldMap = {
  _comment: "ignored",
  fbclid: "contact.fbclid",
  utm_source: "contact.utm_source",
};

describe("provisionAttributionFields", () => {
  beforeEach(() => vi.resetAllMocks());

  it("creates only the fields that don't already exist", async () => {
    vi.mocked(ghl.getCustomFieldDefs).mockResolvedValue([{ fieldKey: "contact.fbclid" }]);
    vi.mocked(ghl.createCustomField).mockResolvedValue({ customField: { fieldKey: "contact.utm_source" } });

    const result = await provisionAttributionFields("loc1", fieldMap, "key");

    expect(result.alreadyPresent).toEqual(["contact.fbclid"]);
    expect(result.created).toEqual(["contact.utm_source"]);
    expect(ghl.createCustomField).toHaveBeenCalledTimes(1);
    // Name must be the un-prefixed key, since GHL slugifies name -> fieldKey.
    expect(ghl.createCustomField).toHaveBeenCalledWith("loc1", "utm_source", "TEXT", "key");
  });

  it("ignores _comment keys in the field map", async () => {
    vi.mocked(ghl.getCustomFieldDefs).mockResolvedValue([]);
    vi.mocked(ghl.createCustomField).mockImplementation(async (_l, name) => ({ customField: { fieldKey: `contact.${name}` } }));

    const result = await provisionAttributionFields("loc1", fieldMap);

    expect(result.created).toEqual(["contact.fbclid", "contact.utm_source"]);
    expect(result.created).not.toContain("ignored");
  });

  it("flags a mismatch when GHL slugifies the name into a different key", async () => {
    // This is the real failure mode: the field gets created but under a key
    // the attribution join will never look at, so leads stay unattributed.
    vi.mocked(ghl.getCustomFieldDefs).mockResolvedValue([]);
    vi.mocked(ghl.createCustomField).mockResolvedValue({ customField: { fieldKey: "contact.utm_source_2" } });

    const result = await provisionAttributionFields("loc1", { utm_source: "contact.utm_source" });

    expect(result.mismatched).toEqual([{ expected: "contact.utm_source", got: "contact.utm_source_2" }]);
  });

  it("is idempotent — a second run creates nothing", async () => {
    vi.mocked(ghl.getCustomFieldDefs).mockResolvedValue([
      { fieldKey: "contact.fbclid" },
      { fieldKey: "contact.utm_source" },
    ]);

    const result = await provisionAttributionFields("loc1", fieldMap);

    expect(result.created).toEqual([]);
    expect(ghl.createCustomField).not.toHaveBeenCalled();
  });
});

describe("checkAttributionReadiness", () => {
  beforeEach(() => vi.resetAllMocks());

  it("reports not-ready and lists what's missing", async () => {
    vi.mocked(ghl.getCustomFieldDefs).mockResolvedValue([{ fieldKey: "contact.fbclid" }]);

    const r = await checkAttributionReadiness("loc1", fieldMap);

    expect(r.ready).toBe(false);
    expect(r.missingFields).toEqual(["contact.utm_source"]);
    expect(r.note).toContain("null attribution");
  });

  it("reports ready but does NOT claim attribution works end to end", async () => {
    vi.mocked(ghl.getCustomFieldDefs).mockResolvedValue([
      { fieldKey: "contact.fbclid" },
      { fieldKey: "contact.utm_source" },
    ]);

    const r = await checkAttributionReadiness("loc1", fieldMap);

    expect(r.ready).toBe(true);
    // The fields existing is necessary but not sufficient — the note must
    // still call out the landing page and Meta URL parameter requirements.
    expect(r.note).toContain("landing page");
    expect(r.note).toContain("URL parameters");
  });
});
