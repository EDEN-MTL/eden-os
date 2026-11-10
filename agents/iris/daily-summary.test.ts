import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn(async (..._a: unknown[]): Promise<any[]> => []) }));
vi.mock("../../shared/db", () => db);
const slack = vi.hoisted(() => ({ sendMessage: vi.fn(async () => ({})) }));
vi.mock("../../shared/slack", () => slack);
const idx = vi.hoisted(() => ({ loadIrisConfig: vi.fn() }));
vi.mock("./index", () => idx);
const fsMock = vi.hoisted(() => ({ readdirSync: vi.fn(() => ["3pc.json"]) }));
vi.mock("fs", () => fsMock);
vi.mock("../../webhooks/vapi-webhook", () => ({ hitCallScreener: () => false, hitVoicemailGreeting: () => false }));

import { formatDailySummary, gatherSummary, runDailySummary, type SummaryData } from "./daily-summary";

const base = (over: Partial<SummaryData> = {}): SummaryData => ({
  dayLabel: "Tuesday, October 27",
  calls: [],
  appointments: [],
  liveTransfers: 0,
  newLeads: [],
  handedToAPerson: [],
  skippedForTeammate: 0,
  todayCalls: [],
  waitingOnText: 0,
  cohortActive: 0,
  watchdogAlerts: 0,
  review: null,
  ...over,
});
const call = (name: string, endedReason: string, transcript = "", flags: string[] = []) => ({ name, endedReason, transcript, durationSeconds: 20, flags });

describe("formatDailySummary", () => {
  it("counts calls by what really happened and names who was reached", () => {
    const text = formatDailySummary(
      base({
        calls: [call("Koren Pye", "customer-ended-call", "User: Hello?\nAI: Hi"), call("A", "customer-did-not-answer", "User: leave a message"), call("B", "customer-did-not-answer"), call("Soyemi", "customer-ended-call", "")],
        appointments: ["Jesse Noseworthy"],
        newLeads: ["Cody Kennie"],
        handedToAPerson: ["Samir Benslimane"],
        skippedForTeammate: 2,
        todayCalls: [{ name: "Sabrina Marie", at: "10:00 AM" }],
        waitingOnText: 3,
      })
    );
    expect(text).toContain("4 placed · 1 reached a person · 2 no answer or voicemail · 1 other");
    expect(text).toContain("Spoke with: Koren Pye");
    expect(text).toContain("Appointments booked: 1 (Jesse Noseworthy)");
    expect(text).toContain("*Needs a person:* Samir Benslimane");
    expect(text).toContain("a teammate is already talking to them: 2");
    expect(text).toContain("Calls lined up: 1 — Sabrina Marie 10:00 AM");
    expect(text).toContain("Waiting on a text reply: 3");
  });
  it("says all is well when nothing was flagged, and lists what was when something was", () => {
    expect(formatDailySummary(base())).toContain("Nothing flagged");
    const flagged = formatDailySummary(base({ calls: [call("Sabrina Marie", "customer-did-not-answer", "", ["Iris spoke into a screener/voicemail"])], watchdogAlerts: 2 }));
    expect(flagged).toContain("*Worth a look*");
    expect(flagged).toContain("Sabrina Marie: Iris spoke into a screener/voicemail");
    expect(flagged).toContain("watchdog raised 2 alerts");
    expect(flagged).not.toContain("Nothing flagged");
  });
  it("quotes the top of last night's lead review, and says nothing when there is none", () => {
    const text = formatDailySummary(base({ review: { total: 7, top: [{ name: "Sabrina Marie", stageName: "Replied", headline: "Was promised a call or follow-up 7d ago and nobody has tried since" }] } }));
    expect(text).toContain("*Worth checking in on* (7 from last night's review)");
    expect(text).toContain("*Sabrina Marie* (Replied): Was promised a call");
    expect(text).toContain("full list with the evidence");
    expect(formatDailySummary(base({ review: { total: 0, top: [] } }))).not.toContain("Worth checking in on");
    expect(formatDailySummary(base())).not.toContain("Worth checking in on");
  });

  it("handles a quiet day", () => {
    expect(formatDailySummary(base())).toContain("No calls were placed.");
    expect(formatDailySummary(base())).toContain("No calls lined up yet.");
  });
});

describe("gatherSummary and runDailySummary", () => {
  const NOW = new Date("2026-10-27T10:45:00.000Z"); // 8:15 AM in St. John's
  beforeEach(() => {
    idx.loadIrisConfig.mockReturnValue({ timezone: "America/St_Johns", dailySummary: { channel: "C-ops" } });
    db.query.mockImplementation(async (...a: unknown[]) => {
      const sql = String(a[0]);
      if (/INSERT INTO daily_summaries/.test(sql)) return [{ client_id: "x" }];
      if (/FROM iris_call_log l/.test(sql)) return [{ contact_id: "c1", ended_reason: "customer-did-not-answer", transcript: "User: voicemail", raw: { durationSeconds: 14, messages: [{ role: "user", message: "You have reached Sabrina" }, { role: "bot", message: "Hi, this is Iris with 3 Percent East Coast." }] }, name: "Sabrina Marie" }];
      if (/count\(\*\)/.test(sql)) return [{ n: 0 }];
      return [];
    });
  });
  afterEach(() => vi.clearAllMocks());

  it("re-runs the review over yesterday's calls and surfaces what it flags", async () => {
    const data = await gatherSummary("3pc", NOW, "America/St_Johns", () => true);
    expect(data.calls).toHaveLength(1);
    expect(data.calls[0].flags[0]).toMatch(/spoke into a screener\/voicemail/);
    expect(data.dayLabel).toBe("Tuesday, October 27");
  });

  it("posts once to the configured channel", async () => {
    await runDailySummary(NOW);
    expect(slack.sendMessage).toHaveBeenCalledTimes(1);
    expect((slack.sendMessage.mock.calls[0] as unknown as [string, { channel: string }])[1].channel).toBe("C-ops");
  });

  it("does not post a second time for the same day", async () => {
    db.query.mockImplementation(async () => []); // the insert returns nothing: already posted today
    await runDailySummary(NOW);
    expect(slack.sendMessage).not.toHaveBeenCalled();
  });
});
