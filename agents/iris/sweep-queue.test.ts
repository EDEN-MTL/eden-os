import { afterEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn(async () => []) }));
vi.mock("../../shared/db", () => db);
const scout = vi.hoisted(() => ({ recheckFirstTouch: vi.fn(), refreshLead: vi.fn() }));
vi.mock("../scout", () => scout);
const idx = vi.hoisted(() => ({ loadIrisConfig: vi.fn(), loadClientBranding: vi.fn() }));
vi.mock("./index", () => idx);
vi.mock("./scripts", () => ({ buildLeadQualificationPrompt: vi.fn(), extractFirstName: vi.fn() }));
const calling = vi.hoisted(() => ({ placeCall: vi.fn() }));
vi.mock("./calling", () => ({ ...calling, CallingDisabledError: class extends Error {} }));
vi.mock("./qualification", () => ({ transferNumberForIntent: vi.fn(), callbackCalendarForIntent: vi.fn() }));
vi.mock("./text-signals", () => ({ classifyInboundText: vi.fn(), lastInboundText: vi.fn() }));
vi.mock("./sms", () => ({ hasActiveSmsConversation: vi.fn() }));
vi.mock("../../shared/ghl", () => ({ getGhlConfig: vi.fn(), getLocationTimezone: vi.fn(), addContactTags: vi.fn() }));

import { queueColdLeadSweep, holdForTextReply, runDialPendingCalls, SWEEP_SOURCE } from "./dial-pending";

afterEach(() => vi.clearAllMocks());

const lead = (name: string | null, phone: string | null) => ({ name, phone, intent: "buyer" });

describe("queueColdLeadSweep", () => {
  it("queues each lead as a one-shot 'sweep' row, one second apart so their order is kept", async () => {
    scout.refreshLead.mockImplementation(async (id: string) => lead(`Lead ${id}`, "+17095550100"));
    const start = new Date("2026-10-07T17:30:00.000Z");

    const queued = await queueColdLeadSweep("3-percent-east-coast", ["a", "b", "c"], start);

    expect(queued.map((q) => q.callAfter.toISOString())).toEqual(["2026-10-07T17:30:00.000Z", "2026-10-07T17:30:01.000Z", "2026-10-07T17:30:02.000Z"]);
    expect(db.query).toHaveBeenCalledTimes(3);
    const [sql, params] = db.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/is_explicit_callback/);
    expect(params[4]).toBe(SWEEP_SOURCE);
  });

  it("leaves out a lead it can't refresh, or that has no phone or no confirmed name, without leaving a gap in the schedule", async () => {
    scout.refreshLead.mockImplementation(async (id: string) =>
      id === "gone" ? null : id === "nophone" ? lead("No Phone", null) : id === "noname" ? lead(null, "+17095550100") : lead("Good Lead", "+17095550100")
    );

    const queued = await queueColdLeadSweep("3-percent-east-coast", ["gone", "nophone", "noname", "ok"], new Date("2026-10-07T17:30:00.000Z"));

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

describe("runDialPendingCalls — sweep rows go out one at a time", () => {
  const SWEEP_ROW = {
    id: 1,
    client_id: "3-percent-east-coast",
    contact_id: "contact-1",
    lead: {},
    attempts_made: 0,
    created_at: new Date("2026-10-07T17:00:00.000Z"),
    is_explicit_callback: true,
    source: "sweep",
    sms_scheduled: false,
  };

  it("leaves a due sweep row untouched while another call is still in flight", async () => {
    db.query
      .mockResolvedValueOnce([SWEEP_ROW] as never) // due rows
      .mockResolvedValueOnce([{ one: 1 }] as never); // a call is in flight

    await runDialPendingCalls();

    expect(db.query).toHaveBeenCalledTimes(2); // nothing else — no UPDATE, no refresh
    expect(scout.refreshLead).not.toHaveBeenCalled();
    expect(String(db.query.mock.calls[1][0])).toMatch(/status = 'initiated'/);
  });
});

describe("runDialPendingCalls — no-call days", () => {
  afterEach(() => vi.useRealTimers());

  it("moves a due call to the next open day at 10am instead of dialing, without using up an attempt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T15:10:00.000Z")); // Mon Oct 12, 12:40 NL
    idx.loadIrisConfig.mockReturnValue({ timezone: "America/St_Johns", noCallDates: ["2026-10-12"] });
    idx.loadClientBranding.mockReturnValue({ brandName: "3% Realty", city: "St. John's" });
    db.query.mockResolvedValueOnce([
      { id: 5, client_id: "3-percent-east-coast", contact_id: "c1", lead: {}, attempts_made: 1, created_at: new Date(), is_explicit_callback: false, source: null, sms_scheduled: false },
    ] as never);

    await runDialPendingCalls();

    expect(calling.placeCall).not.toHaveBeenCalled();
    expect(scout.refreshLead).not.toHaveBeenCalled();
    const [sql, params] = db.query.mock.calls[1] as unknown as [string, unknown[]];
    expect(sql).toMatch(/UPDATE iris_pending_calls SET call_after/);
    expect(sql).not.toMatch(/attempts_made/);
    expect(params).toEqual([5, new Date("2026-10-13T12:30:00.000Z")]);
  });
});
