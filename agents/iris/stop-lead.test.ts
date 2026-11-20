import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../shared/db", () => db);
const ghl = vi.hoisted(() => ({ addContactTags: vi.fn(), createContactNote: vi.fn(), getContact: vi.fn(), getGhlConfig: vi.fn() }));
vi.mock("../../shared/ghl", () => ghl);
const ember = vi.hoisted(() => ({ listOpenLeadsByContactId: vi.fn(), updateLead: vi.fn() }));
vi.mock("../ember/store", () => ember);

import { carryOutStop, readStopState } from "./stop-lead";

beforeEach(() => {
  db.query.mockResolvedValue([]);
  ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
  ghl.addContactTags.mockResolvedValue({});
  ghl.createContactNote.mockResolvedValue({});
  ghl.getContact.mockResolvedValue({ contact: { tags: [] } });
  ember.listOpenLeadsByContactId.mockResolvedValue([]);
  ember.updateLead.mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe("carryOutStop (Slack stop audit, 2026-11-20)", () => {
  it("closes a row that is 'placed' as well as 'pending', so the end-of-call retry has nothing to reopen", async () => {
    db.query.mockResolvedValueOnce([{ id: 5 }]);
    const out = await carryOutStop("3pc", "contact-1", "U-mark");
    const [sql, params] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/status IN \('pending', 'placed'\)/);
    expect(sql).toMatch(/status = 'skipped'/);
    expect(params).toEqual(["3pc", "contact-1", "stopped in Slack by U-mark"]);
    expect(out.closedRows).toBe(1);
  });

  it('leaves the lasting "do not call" tag and a note, so a new form, a sweep or Ember cannot start them again', async () => {
    const out = await carryOutStop("3pc", "contact-1", "U-mark");
    expect(ghl.addContactTags).toHaveBeenCalledWith("contact-1", ["do not call"], "loc-1", "key-1");
    expect(ghl.createContactNote).toHaveBeenCalledWith("contact-1", expect.stringContaining("asked in Slack to stop"), "loc-1", "key-1");
    expect(out.tagged).toBe(true);
  });

  it("works for a lead with no queue row at all (an Ember lead, an old lead): the tag is still written", async () => {
    const out = await carryOutStop("3pc", "contact-1", "U-mark");
    expect(out.closedRows).toBe(0);
    expect(out.tagged).toBe(true);
  });

  it("stops Ember's nurture for the contact", async () => {
    ember.listOpenLeadsByContactId.mockResolvedValue([{ id: 11 }, { id: 12 }]);
    const out = await carryOutStop("3pc", "contact-1", "U-mark");
    expect(ember.updateLead).toHaveBeenCalledWith(11, { status: "exited", statusReason: "stopped in Slack by U-mark", nextTouchAt: null });
    expect(ember.updateLead).toHaveBeenCalledTimes(2);
    expect(out.emberStopped).toBe(2);
  });

  it("says so when the tag could not be written, instead of reporting the lead as protected", async () => {
    ghl.addContactTags.mockRejectedValue(new Error("GHL down"));
    const out = await carryOutStop("3pc", "contact-1", "U-mark");
    expect(out.tagged).toBe(false);
  });

  it("does not claim a tag when there is no GHL connection", async () => {
    ghl.getGhlConfig.mockResolvedValue(null);
    expect((await carryOutStop("3pc", "contact-1", "U-mark")).tagged).toBe(false);
  });
});

describe("readStopState", () => {
  it("counts open rows and Ember leads and reads the tag, case-insensitively", async () => {
    db.query.mockResolvedValue([{ n: "2" }]);
    ember.listOpenLeadsByContactId.mockResolvedValue([{ id: 1 }]);
    ghl.getContact.mockResolvedValue({ contact: { tags: ["Do Not Call"] } });
    expect(await readStopState("3pc", "contact-1")).toEqual({ openRows: 2, emberLeads: 1, tagged: true });
  });
});
