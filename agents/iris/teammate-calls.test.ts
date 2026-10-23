import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn(async (..._a: unknown[]): Promise<any[]> => []) }));
vi.mock("../../shared/db", () => db);
const ghl = vi.hoisted(() => ({
  getContact: vi.fn(),
  getGhlConfig: vi.fn(),
  listContactsPaginated: vi.fn(),
  listLocationUsers: vi.fn(),
  getConversationMessages: vi.fn(),
  listRecentConversations: vi.fn(),
}));
vi.mock("../../shared/ghl", () => ghl);
const slack = vi.hoisted(() => ({ sendMessage: vi.fn(async () => ({})) }));
vi.mock("../../shared/slack", () => slack);
const dial = vi.hoisted(() => ({ scheduleExplicitCallback: vi.fn(async () => true), queueColdLeadSweep: vi.fn() }));
vi.mock("./dial-pending", () => dial);
const touch = vi.hoisted(() => ({ checkHumanTouch: vi.fn(async () => ({ status: "none" })), DEFAULT_HUMAN_HANDS_OFF_DAYS: 7 }));
vi.mock("./human-touch", () => touch);

import { callReached, findTeammateCalls, localDayBounds, summariseCalls } from "./teammate-calls";
import { handleCommandReply, listTeammateCalls, prepareFollowUpCommand, type SettingsLoader } from "./slack-commands";

const TZ = "America/St_Johns";
const NOW = new Date("2026-10-19T20:00:00.000Z"); // Monday 5:30 PM NL
const JACOB_ID = "u-jacob";
const MARK = "U07H26WUGP5";
const SETTINGS = { allowedUserIds: [MARK], confirmTtlMinutes: 10, timezone: TZ, humanHandsOffDays: 7 };
const loader: SettingsLoader = () => SETTINGS;
const CTX = { channelId: "C1", userId: MARK };

const call = (over: Record<string, unknown> = {}) => ({
  messageType: "TYPE_CALL",
  direction: "outbound",
  status: "completed",
  userId: JACOB_ID,
  dateAdded: "2026-10-19T19:00:00.000Z",
  meta: { call: { duration: 3, status: "completed" } },
  ...over,
});

describe("reading calls", () => {
  it("counts a call as reaching the lead only when completed and long enough to be a conversation", () => {
    expect(callReached(call({ meta: { call: { duration: 45 } } }))).toBe(true);
    expect(callReached(call({ meta: { call: { duration: 3 } } }))).toBe(false);
    expect(callReached(call({ status: "no-answer", meta: { call: { duration: 0 } } }))).toBe(false);
  });

  it("gets the client's own calendar day, not UTC", () => {
    const { start, end } = localDayBounds(NOW, 0, TZ);
    expect(start.toISOString()).toBe("2026-10-19T02:30:00.000Z"); // midnight NL
    expect(end.toISOString()).toBe("2026-10-20T02:30:00.000Z");
    expect(localDayBounds(NOW, 1, TZ).start.toISOString()).toBe("2026-10-18T02:30:00.000Z");
  });

  it("groups one person's outbound calls by lead and keeps a lead reached on any call as reached", () => {
    const { start, end } = localDayBounds(NOW, 0, TZ);
    const result = summariseCalls(
      [
        { contactId: "a", name: "Amanda", messages: [call(), call({ dateAdded: "2026-10-19T19:10:00.000Z" }), call({ dateAdded: "2026-10-19T19:20:00.000Z" })] },
        { contactId: "n", name: "Noeleen", messages: [call({ meta: { call: { duration: 3 } } }), call({ dateAdded: "2026-10-19T19:30:00.000Z", meta: { call: { duration: 60 } } })] },
        // not Jacob's, inbound, yesterday: all ignored
        { contactId: "x", name: "Other", messages: [call({ userId: "someone" }), call({ direction: "inbound" }), call({ dateAdded: "2026-10-17T19:00:00.000Z" }), { messageType: "TYPE_SMS" } as any] },
      ],
      JACOB_ID,
      start,
      end
    );
    expect(result.map((r) => [r.name, r.calls, r.reached])).toEqual([["Amanda", 3, false], ["Noeleen", 2, true]]);
  });
});

describe("findTeammateCalls", () => {
  beforeEach(() => {
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc", apiKey: "k" });
    ghl.listLocationUsers.mockResolvedValue([{ id: JACOB_ID, name: "Jacob Murphy" }, { id: "u2", name: "Chantelle English" }]);
  });

  it("finds the person by first name and reads only conversations active that day", async () => {
    ghl.listRecentConversations.mockResolvedValue([
      { id: "c1", contactId: "a", contactName: "Amanda Marie", lastMessageDate: NOW.getTime() - 3_600_000 },
      { id: "c2", contactId: "old", contactName: "Old", lastMessageDate: NOW.getTime() - 5 * 86_400_000 },
    ]);
    ghl.getConversationMessages.mockResolvedValue({ messages: { messages: [call()] } });
    const r = await findTeammateCalls("c", "jacob", 0, TZ, NOW);
    expect(r).toMatchObject({ ok: true, person: "Jacob Murphy" });
    expect(ghl.getConversationMessages).toHaveBeenCalledTimes(1);
    if (r.ok) expect(r.calls.map((c) => c.name)).toEqual(["Amanda Marie"]);
  });

  it("says so when nobody matches", async () => {
    expect(await findTeammateCalls("c", "zed", 0, TZ, NOW)).toMatchObject({ ok: false });
  });
});

describe("the Slack commands", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    db.query.mockImplementation(async (...args: unknown[]) => (/INSERT INTO iris_slack_commands/.test(String(args[0])) ? [{ id: "9" }] : []));
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc", apiKey: "k" });
    ghl.listLocationUsers.mockResolvedValue([{ id: JACOB_ID, name: "Jacob Murphy" }]);
    ghl.listRecentConversations.mockResolvedValue([
      { id: "c1", contactId: "amanda", contactName: "Amanda Marie", lastMessageDate: NOW.getTime() },
      { id: "c2", contactId: "noeleen", contactName: "Noeleen Gray", lastMessageDate: NOW.getTime() },
      { id: "c3", contactId: "dnc", contactName: "Do Not", lastMessageDate: NOW.getTime() },
    ]);
    ghl.getConversationMessages.mockImplementation(async (id: string) => ({
      messages: { messages: [id === "c2" ? call({ meta: { call: { duration: 90 } } }) : call()] },
    }));
    ghl.getContact.mockImplementation(async (id: string) => ({ contact: { id, phone: "+17095550100", firstName: "X", tags: id === "dnc" ? ["do not call"] : [] } }));
    touch.checkHumanTouch.mockResolvedValue({ status: "none" } as any);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("lists who the teammate called and whether they were reached", async () => {
    const r: any = await listTeammateCalls("c", { person: "Jacob" }, CTX, loader);
    expect(r.status).toBe("ok");
    expect(r.calls.map((c: any) => [c.name, c.reached])).toEqual([["Amanda Marie", false], ["Noeleen Gray", true], ["Do Not", false]]);
  });

  it("only Mark and Jacob may ask", async () => {
    const r: any = await listTeammateCalls("c", { person: "Jacob" }, { channelId: "C1", userId: "Uother" }, loader);
    expect(r.status).toBe("refused");
    expect((await prepareFollowUpCommand("c", { person: "Jacob" }, { channelId: "C1", userId: "Uother" }, loader, NOW)).status).toBe("refused");
  });

  it("prepares ONE summary for the unreached leads who are safe, leaves out do-not-call, and queues nothing yet", async () => {
    const p = await prepareFollowUpCommand("c", { person: "Jacob" }, CTX, loader, NOW);
    expect(p.status).toBe("needs_confirmation");
    expect(p.summary).toContain("*Amanda Marie*");
    expect(p.summary).not.toContain("*Noeleen Gray*"); // reached
    expect(p.summary).toMatch(/Leaving out: Do Not \(do not call\)/);
    expect(dial.queueColdLeadSweep).not.toHaveBeenCalled();
    const insert = db.query.mock.calls.find((c) => /INSERT INTO iris_slack_commands/.test(String(c[0])))!;
    expect(JSON.parse((insert[1] as unknown[])[9] as string)).toEqual([{ id: "amanda", name: "Amanda Marie" }]);
  });

  it("asks the teammate check about texts only, so Jacob's own unanswered call doesn't exclude the lead", async () => {
    await prepareFollowUpCommand("c", { person: "Jacob" }, CTX, loader, NOW);
    expect(touch.checkHumanTouch).toHaveBeenCalled();
    for (const call of touch.checkHumanTouch.mock.calls as unknown as unknown[][]) expect(call[5]).toEqual({ includeCalls: false });
  });

  it("leaves out a lead a teammate has since texted", async () => {
    touch.checkHumanTouch.mockResolvedValue({ status: "human", at: "x" } as any);
    const p = await prepareFollowUpCommand("c", { person: "Jacob" }, CTX, loader, NOW);
    expect(p.status).toBe("nothing_to_do");
  });

  it("says there is nobody to follow up when every lead was reached", async () => {
    ghl.getConversationMessages.mockResolvedValue({ messages: { messages: [call({ meta: { call: { duration: 90 } } })] } });
    expect((await prepareFollowUpCommand("c", { person: "Jacob" }, CTX, loader, NOW)).status).toBe("nothing_to_do");
  });

  it("queues the whole list only after the same person says yes", async () => {
    dial.queueColdLeadSweep.mockResolvedValue([{ contactId: "amanda", name: "Amanda Marie", callAfter: NOW }]);
    db.query.mockImplementation(async (...args: unknown[]) =>
      /SELECT id, kind, contact_id/.test(String(args[0]))
        ? [{ id: "5", kind: "followup", contact_id: "amanda", contact_name: "Amanda Marie", call_at: new Date(NOW.getTime() + 120_000), created_at: new Date(), batch: [{ id: "amanda", name: "Amanda Marie" }] }]
        : []
    );
    const reply = await handleCommandReply({ text: "yes", userId: MARK, channelId: "C1", threadTs: undefined } as any, loader, "c");
    expect(dial.queueColdLeadSweep).toHaveBeenCalledWith("c", ["amanda"], expect.any(Date));
    expect(reply).toMatch(/lined up 1: Amanda Marie/);
  });

  it("a no cancels without queuing anyone", async () => {
    db.query.mockImplementation(async (...args: unknown[]) =>
      /SELECT id, kind, contact_id/.test(String(args[0]))
        ? [{ id: "5", kind: "followup", contact_id: "amanda", contact_name: "Amanda Marie", call_at: null, created_at: new Date(), batch: [{ id: "amanda", name: "Amanda Marie" }] }]
        : []
    );
    await handleCommandReply({ text: "no", userId: MARK, channelId: "C1" } as any, loader, "c");
    expect(dial.queueColdLeadSweep).not.toHaveBeenCalled();
  });
});
