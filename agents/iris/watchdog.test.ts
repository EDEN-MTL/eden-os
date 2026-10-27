import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn(async (..._a: unknown[]): Promise<any[]> => []) }));
vi.mock("../../shared/db", () => db);
const slack = vi.hoisted(() => ({ sendMessage: vi.fn(async () => ({})) }));
vi.mock("../../shared/slack", () => slack);
const idx = vi.hoisted(() => ({ loadIrisConfig: vi.fn() }));
vi.mock("./index", () => idx);

import { assertSendableText, BlockedTextError } from "../../shared/ghl/outbound-guard";
import { alertOnce, announceStartup, findProblems, runWatchdog, type WatchdogSnapshot } from "./watchdog";

const healthy = (over: Partial<WatchdogSnapshot> = {}): WatchdogSnapshot => ({ heartbeatAgeMinutes: 1, uptimeMinutes: 600, lateCalls: [], silentCalls: [], ...over });

describe("findProblems", () => {
  it("is quiet when everything is fine", () => {
    expect(findProblems(healthy())).toEqual([]);
  });
  it("flags a stalled scheduler, but not a freshly started server or one that has never run", () => {
    expect(findProblems(healthy({ heartbeatAgeMinutes: 25 }))[0]).toMatchObject({ key: "scheduler-stalled" });
    expect(findProblems(healthy({ heartbeatAgeMinutes: 25, uptimeMinutes: 2 }))).toEqual([]);
    expect(findProblems(healthy({ heartbeatAgeMinutes: null }))).toEqual([]);
  });
  it("names the overdue calls and the calls that never reported back", () => {
    const p = findProblems(healthy({ lateCalls: [{ name: "Sabrina Marie", minutesLate: 44 }], silentCalls: [{ name: "Soyemi Damilola", minutesAgo: 31 }] }));
    expect(p.map((x) => x.key)).toEqual(["calls-overdue", "calls-no-report"]);
    expect(p[0].text).toContain("Sabrina Marie (44 min late)");
    expect(p[1].text).toContain("Soyemi Damilola (31 min ago)");
  });
});

describe("alertOnce", () => {
  beforeEach(() => {
    idx.loadIrisConfig.mockReturnValue({ callAlerts: { userIds: ["U-mark"] } });
  });
  afterEach(() => vi.clearAllMocks());

  it("DMs the alert people when the problem is new", async () => {
    db.query.mockImplementation(async (...a: unknown[]) => (/INSERT INTO watchdog_alerts/.test(String(a[0])) ? [{ key: "k" }] : []));
    expect(await alertOnce("k", "trouble", 3)).toBe(true);
    expect(slack.sendMessage).toHaveBeenCalledWith("iris", { channel: "U-mark", text: "trouble" });
  });
  it("stays quiet inside the cooldown", async () => {
    db.query.mockImplementation(async () => []);
    expect(await alertOnce("k", "trouble", 3)).toBe(false);
    expect(slack.sendMessage).not.toHaveBeenCalled();
  });
});

describe("runWatchdog", () => {
  it("never throws, even when the database is down", async () => {
    db.query.mockRejectedValue(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runWatchdog()).resolves.toBeUndefined();
    err.mockRestore();
    db.query.mockImplementation(async () => []);
  });
});

describe("the outbound guard is reported through the watchdog", () => {
  afterEach(() => vi.clearAllMocks());
  it("alerts when a text is refused, and still refuses it", async () => {
    idx.loadIrisConfig.mockReturnValue({ callAlerts: { userIds: ["U-mark"] } });
    db.query.mockImplementation(async (...a: unknown[]) => (/INSERT INTO watchdog_alerts/.test(String(a[0])) ? [{ key: "k" }] : []));
    expect(() => assertSendableText("oTCjDHG2AP4okGSGUsYs", "oTCjDHG2AP4okGSGUsYs")).toThrow(BlockedTextError);
    await new Promise((r) => setTimeout(r, 10));
    expect(slack.sendMessage).toHaveBeenCalledTimes(1);
    expect((slack.sendMessage.mock.calls[0] as unknown as [string, { text: string }])[1].text).toMatch(/Blocked a text/);
  });
});

describe("announceStartup", () => {
  afterEach(() => {
    delete process.env.RENDER_GIT_COMMIT;
    vi.clearAllMocks();
  });
  it("posts the commit to #backend-ops on Render", async () => {
    process.env.RENDER_GIT_COMMIT = "1234567890abcdef";
    await announceStartup();
    expect(slack.sendMessage).toHaveBeenCalledWith("iris", expect.objectContaining({ channel: "C0BLPMHNXL1", text: expect.stringContaining("1234567") }));
  });
  it("says nothing on a laptop", async () => {
    await announceStartup();
    expect(slack.sendMessage).not.toHaveBeenCalled();
  });
});
