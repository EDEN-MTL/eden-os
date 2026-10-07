import { afterEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn(async () => []) }));
vi.mock("../../shared/db", () => db);
const scout = vi.hoisted(() => ({ recheckFirstTouch: vi.fn(), refreshLead: vi.fn() }));
vi.mock("../scout", () => scout);
vi.mock("./index", () => ({ loadIrisConfig: vi.fn(), loadClientBranding: vi.fn() }));
vi.mock("./scripts", () => ({ buildLeadQualificationPrompt: vi.fn(), extractFirstName: vi.fn() }));
vi.mock("./calling", () => ({ placeCall: vi.fn(), CallingDisabledError: class extends Error {} }));
vi.mock("./qualification", () => ({ transferNumberForIntent: vi.fn(), callbackCalendarForIntent: vi.fn() }));
vi.mock("./text-signals", () => ({ classifyInboundText: vi.fn(), lastInboundText: vi.fn() }));
vi.mock("./sms", () => ({ hasActiveSmsConversation: vi.fn() }));
vi.mock("../../shared/ghl", () => ({ getGhlConfig: vi.fn(), getLocationTimezone: vi.fn(), addContactTags: vi.fn() }));

import { queueColdLeadSweep, holdForTextReply, SWEEP_SOURCE } from "./dial-pending";

afterEach(() => vi.clearAllMocks());

const lead = (name: string | null, phone: string | null) => ({ name, phone, intent: "buyer" });

describe("queueColdLeadSweep", () => {
  it("queues each lead as a one-shot 'sweep' row, spaced apart", async () => {
    scout.refreshLead.mockImplementation(async (id: string) => lead(`Lead ${id}`, "+17095550100"));
    const start = new Date("2026-10-07T17:30:00.000Z");

    const queued = await queueColdLeadSweep("3-percent-east-coast", ["a", "b", "c"], start, 5);

    expect(queued.map((q) => q.callAfter.toISOString())).toEqual(["2026-10-07T17:30:00.000Z", "2026-10-07T17:35:00.000Z", "2026-10-07T17:40:00.000Z"]);
    expect(db.query).toHaveBeenCalledTimes(3);
    const [sql, params] = db.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/is_explicit_callback/);
    expect(params[4]).toBe(SWEEP_SOURCE);
  });

  it("leaves out a lead it can't refresh, or that has no phone or no confirmed name, without leaving a gap in the schedule", async () => {
    scout.refreshLead.mockImplementation(async (id: string) =>
      id === "gone" ? null : id === "nophone" ? lead("No Phone", null) : id === "noname" ? lead(null, "+17095550100") : lead("Good Lead", "+17095550100")
    );

    const queued = await queueColdLeadSweep("3-percent-east-coast", ["gone", "nophone", "noname", "ok"], new Date("2026-10-07T17:30:00.000Z"), 5);

    expect(queued).toHaveLength(1);
    expect(queued[0].name).toBe("Good Lead");
    expect(queued[0].callAfter.toISOString()).toBe("2026-10-07T17:30:00.000Z");
  });
});

describe("holdForTextReply", () => {
  it("keeps the row pending but never due, so a reply to the text is still answered", async () => {
    await holdForTextReply(77);

    const [sql, params] = db.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/'infinity'/);
    expect(sql).toMatch(/status = 'pending'/);
    expect(params).toEqual([77]);
  });
});
