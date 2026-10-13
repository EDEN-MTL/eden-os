import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../../../shared/db", () => ({ query: (...args: unknown[]) => queryMock(...args) }));

const getContactMock = vi.fn();
let listedContacts: any[] = [];
let opportunities: any[] = [];
vi.mock("../../../shared/ghl", () => ({
  getContact: (...args: unknown[]) => getContactMock(...args),
  getCustomFieldDefs: vi.fn(async () => []),
  listPipelines: vi.fn(async () => [{ id: "p1", name: "Leads", stages: [{ id: "s1", name: "Buyer Leads" }] }]),
  listContactsPaginated: async function* () {
    for (const c of listedContacts) yield c;
  },
  listOpportunitiesPaginated: async function* () {
    for (const o of opportunities) yield o;
  },
}));

import { resolveFullContact, syncLeads } from "./attribution";

// What GHL's Facebook Lead Ads sync puts on a full contact record (shape
// copied from a real 3-percent-east-coast lead, 2026-10-14).
const fullRecord = (id: string, dateUpdated: string) => ({
  id,
  dateUpdated,
  dateAdded: "2026-10-11T12:00:00Z",
  source: "Facebook",
  attributionSource: {
    sessionSource: "Paid Social",
    campaignId: "120247476389410259",
    adSetId: "120248327399560259",
    adId: "120248329090480259",
    utmSource: "facebook",
    utmCampaign: "Aug 2026 | Buyer Campaign | EDEN",
  },
  customFields: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  listedContacts = [];
  opportunities = [];
});

describe("resolveFullContact", () => {
  it("reuses the stored full record when the contact hasn't changed", async () => {
    const stored = new Map([["c1", fullRecord("c1", "2026-10-11T12:05:00Z")]]);
    const r = await resolveFullContact({ id: "c1", dateUpdated: "2026-10-11T12:05:00Z" }, stored, "loc");
    expect(r).toMatchObject({ full: true, refetched: false });
    expect(r.contact.attributionSource.adId).toBe("120248329090480259");
    expect(getContactMock).not.toHaveBeenCalled();
  });

  it("re-reads in full when the contact changed since last sync", async () => {
    const stored = new Map([["c1", fullRecord("c1", "2026-10-11T12:05:00Z")]]);
    getContactMock.mockResolvedValueOnce({ contact: fullRecord("c1", "2026-10-12T09:00:00Z") });
    const r = await resolveFullContact({ id: "c1", dateUpdated: "2026-10-12T09:00:00Z" }, stored, "loc", "key");
    expect(getContactMock).toHaveBeenCalledWith("c1", "loc", "key");
    expect(r).toMatchObject({ full: true, refetched: true });
    expect(r.contact.dateUpdated).toBe("2026-10-12T09:00:00Z");
  });

  it("falls back to the list data on a failed read, and marks it for a retry", async () => {
    getContactMock.mockRejectedValueOnce(new Error("429"));
    const r = await resolveFullContact({ id: "c2", dateUpdated: "x" }, new Map(), "loc");
    expect(r).toEqual({ contact: { id: "c2", dateUpdated: "x" }, full: false, refetched: false });
  });
});

describe("syncLeads", () => {
  it("attaches the Meta campaign/ad set/ad from the full record even though the list omits it", async () => {
    // The list endpoint's version of a lead: no attributionSource at all.
    listedContacts = [{ id: "c1", dateUpdated: "2026-10-11T12:05:00Z", dateAdded: "2026-10-11T12:00:00Z" }];
    opportunities = [{ id: "o1", contactId: "c1", pipelineStageId: "s1", status: "open", updatedAt: "2026-10-11" }];
    getContactMock.mockResolvedValueOnce({ contact: fullRecord("c1", "2026-10-11T12:05:00Z") });
    queryMock.mockResolvedValue([]); // no stored rows; inserts return nothing

    const n = await syncLeads("loc", {}, { clientId: "3-percent-east-coast", apiKey: "key" });

    expect(n).toBe(1);
    const insert = queryMock.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO ad_leads"))!;
    const params = insert[1] as unknown[];
    // meta_campaign_id, meta_adset_id, meta_ad_id
    expect(params.slice(8, 11)).toEqual(["120247476389410259", "120248327399560259", "120248329090480259"]);
    expect(params[11]).toBe("Buyer Leads");
    expect(JSON.parse(params[15] as string).fullRecord).toBe(true);
  });

  it("only re-reads the contacts that changed", async () => {
    listedContacts = [
      { id: "same", dateUpdated: "t1" },
      { id: "changed", dateUpdated: "t2-new" },
    ];
    queryMock.mockImplementation(async (sql: string) =>
      sql.includes("SELECT ghl_contact_id")
        ? [
            { ghl_contact_id: "same", contact: fullRecord("same", "t1") },
            { ghl_contact_id: "changed", contact: fullRecord("changed", "t2-old") },
          ]
        : []
    );
    getContactMock.mockResolvedValueOnce({ contact: fullRecord("changed", "t2-new") });

    await syncLeads("loc", {}, { clientId: "3-percent-east-coast" });

    expect(getContactMock).toHaveBeenCalledTimes(1);
    expect(getContactMock.mock.calls[0][0]).toBe("changed");
  });
});
