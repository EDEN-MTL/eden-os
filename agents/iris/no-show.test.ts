import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn(async (..._a: unknown[]): Promise<any[]> => []) }));
vi.mock("../../shared/db", () => db);
const slack = vi.hoisted(() => ({ sendMessage: vi.fn(async () => {}) }));
vi.mock("../../shared/slack", () => slack);
const ghl = vi.hoisted(() => ({
  getContact: vi.fn(),
  getGhlConfig: vi.fn(),
  getLocationTimezone: vi.fn(),
  listLocationUsers: vi.fn(),
  listOpportunitiesInStage: vi.fn(),
  listPipelines: vi.fn(),
  getContactAppointments: vi.fn(),
  listOpportunitiesForContact: vi.fn(),
}));
vi.mock("../../shared/ghl", () => ghl);
const scout = vi.hoisted(() => ({ refreshLead: vi.fn() }));
vi.mock("../scout", () => scout);
const hook = vi.hoisted(() => ({ sendIrisText: vi.fn(async () => "delivered") }));
vi.mock("../../webhooks/vapi-webhook", () => hook);
const idx = vi.hoisted(() => ({ loadIrisConfig: vi.fn(), loadClientBranding: vi.fn() }));
vi.mock("./index", () => idx);
const touch = vi.hoisted(() => ({ checkHumanTouch: vi.fn(async () => ({ status: "none" })) }));
vi.mock("./human-touch", () => ({ ...touch, DEFAULT_HUMAN_HANDS_OFF_DAYS: 7 }));
vi.mock("./links", () => ({ linkLineFor: vi.fn(async () => "🔗 link") }));

import {
  appointmentInstant,
  buildNoShowText,
  describeMissedDay,
  noShowStillApplies,
  readAppointments,
} from "./no-show-state";
import { decideNoShow, firstCallTime, intentFromTitle, scanClient, type NoShowFacts } from "./no-show";
import { buildLeadQualificationPrompt, buildNoShowSmsPrompt } from "./scripts";

const TZ = "America/St_Johns";
const NOW = new Date("2026-10-20T15:00:00.000Z"); // 12:30 PM in St. John's

const facts = (over: Partial<NoShowFacts> = {}): NoShowFacts => ({
  hasPhone: true,
  hasName: true,
  doNotContact: false,
  hoursOk: true,
  recentlyFollowedUp: false,
  rebooked: false,
  missed: { appointmentTitle: "Buyer Consultation with Jesse", at: new Date("2026-10-19T13:30:00.000Z"), agentName: "Chantelle English" },
  ...over,
});

describe("reading appointments (real GHL shapes)", () => {
  it("reads GHL's wall-clock start time in the client's zone", () => {
    // 11:00 AM in St. John's (UTC-2:30 in October) is 13:30 UTC
    expect(appointmentInstant("2026-10-15 11:00:00", TZ)?.toISOString()).toBe("2026-10-15T13:30:00.000Z");
    expect(appointmentInstant("2026-10-15 11:15:00", TZ)?.toISOString()).toBe("2026-10-15T13:45:00.000Z");
    expect(appointmentInstant("2026-10-15T13:30:00.000Z", TZ)?.toISOString()).toBe("2026-10-15T13:30:00.000Z");
    expect(appointmentInstant(null, TZ)).toBeNull();
    expect(appointmentInstant("garbage", TZ)).toBeNull();
  });

  it("picks the appointment marked no-show as the missed one", () => {
    const picture = readAppointments(
      [
        { id: "old", startTime: "2026-09-01 10:00:00", appointmentStatus: "showed" },
        { id: "missed", startTime: "2026-10-16 10:00:00", appointmentStatus: "noshow", assignedUserId: "u1" },
      ],
      NOW,
      TZ
    );
    expect(picture.missed?.appointment.id).toBe("missed");
    expect(picture.upcoming).toBeNull();
  });

  it("sees a live booking ahead as 'already rebooked', and ignores cancelled ones", () => {
    const picture = readAppointments(
      [
        { id: "missed", startTime: "2026-10-16 10:00:00", appointmentStatus: "noshow" },
        { id: "cancelled", startTime: "2026-10-25 10:00:00", appointmentStatus: "cancelled" },
      ],
      NOW,
      TZ
    );
    expect(picture.upcoming).toBeNull();
    expect(readAppointments([{ id: "new", startTime: "2026-10-25 10:00:00", appointmentStatus: "confirmed" }], NOW, TZ).upcoming?.appointment.id).toBe("new");
  });

  it("falls back to the newest past appointment that was not attended when nothing is marked", () => {
    const picture = readAppointments([{ id: "a", startTime: "2026-10-10 10:00:00", appointmentStatus: "confirmed" }], NOW, TZ);
    expect(picture.missed?.appointment.id).toBe("a");
    expect(readAppointments([{ id: "a", startTime: "2026-10-10 10:00:00", appointmentStatus: "showed" }], NOW, TZ).missed).toBeNull();
  });
});

describe("naming the missed day", () => {
  it("says today, yesterday, a weekday inside the week, and a date beyond it", () => {
    expect(describeMissedDay(new Date("2026-10-20T13:30:00.000Z"), NOW, TZ)).toBe("today");
    expect(describeMissedDay(new Date("2026-10-19T13:30:00.000Z"), NOW, TZ)).toBe("yesterday");
    expect(describeMissedDay(new Date("2026-10-16T13:30:00.000Z"), NOW, TZ)).toBe("Friday");
    expect(describeMissedDay(new Date("2026-10-08T13:30:00.000Z"), NOW, TZ)).toBe("October 8");
  });
});

describe("the first text", () => {
  it("is short, names the agent and day without blame, and has no STOP line", () => {
    const text = buildNoShowText("Jesse", "3% Realty", { agentName: "Chantelle English", missedDay: "Thursday", missedWhen: "Thursday, October 15 at 11:00 AM" });
    expect(text).toBe(
      "Hi Jesse, it's Iris from 3% Realty. Looks like we missed each other for your appointment with Chantelle on Thursday. No worries, it happens! Want me to find you another time?"
    );
    expect(text).not.toMatch(/stop|opt out/i);
    expect(buildNoShowText("Jesse", "3% Realty", { agentName: null, missedDay: "yesterday", missedWhen: "x" })).toContain("your appointment yesterday.");
    expect(buildNoShowText("Jesse", "3% Realty", { agentName: null, missedDay: "recently", missedWhen: "x" })).toContain("your appointment recently.");
  });
});

describe("deciding whether to follow up", () => {
  it("starts for a plain no-show and carries the agent, day and the intent from the appointment title", () => {
    const d = decideNoShow(facts(), NOW, TZ, "buyer");
    expect(d.action).toBe("start");
    if (d.action === "start") {
      expect(d.context.agentName).toBe("Chantelle English");
      expect(d.context.missedDay).toBe("yesterday");
      expect(d.intent).toBe("buyer");
    }
  });

  it("reads seller vs buyer from the appointment title", () => {
    expect(intentFromTitle("Home Selling Consultation with Samir")).toBe("seller");
    expect(intentFromTitle("Buyer Consultation with Jesse")).toBe("buyer");
    expect(intentFromTitle("Call")).toBeNull();
  });

  it.each([
    [{ doNotContact: true }, /opted out/],
    [{ hasPhone: false }, /no phone/],
    [{ hasName: false }, /no confirmed name/],
    [{ rebooked: true }, /already has an appointment/],
    [{ recentlyFollowedUp: true }, /already followed up/],
  ])("skips for good: %j", (over, reason) => {
    const d = decideNoShow(facts(over as Partial<NoShowFacts>), NOW, TZ, "buyer");
    expect(d.action).toBe("skip");
    if (d.action === "skip") expect(d.reason).toMatch(reason);
  });

  it("waits (does not give up) when it is outside texting hours", () => {
    expect(decideNoShow(facts({ hoursOk: false }), NOW, TZ, "buyer").action).toBe("wait");
  });

  it("still follows up when the card was moved by hand and no appointment is on record", () => {
    const d = decideNoShow(facts({ missed: null }), NOW, TZ, "seller");
    expect(d.action).toBe("start");
    if (d.action === "start") {
      expect(d.context.missedDay).toBe("recently");
      expect(d.intent).toBe("seller");
    }
  });
});

describe("the first call", () => {
  const cadence = { attemptsPerDay: 2, days: 4, recheckBeforeEachAttempt: true } as any;
  it("is the next real slot, at least three hours after the text", () => {
    // texted 12:30 PM NL -> earliest 3:30 PM -> next slot is 10 AM tomorrow
    expect(firstCallTime(NOW, TZ, cadence).toISOString()).toBe("2026-10-21T12:30:00.000Z"); // 10:00 AM NL
    // texted 8:30 AM NL (11:00 UTC) -> earliest 11:30 AM -> next slot 2 PM NL today
    expect(firstCallTime(new Date("2026-10-20T11:00:00.000Z"), TZ, cadence).toISOString()).toBe("2026-10-20T16:30:00.000Z");
  });
});

describe("noShowStillApplies", () => {
  beforeEach(() => {
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc", apiKey: "k" });
    ghl.listPipelines.mockResolvedValue([{ id: "p", stages: [{ id: "ns", name: "No-Show" }, { id: "other", name: "Appointment Set" }] }]);
  });

  it("applies while the card is in No-Show and nothing is booked ahead", async () => {
    ghl.listOpportunitiesForContact.mockResolvedValue([{ pipelineStageId: "ns" }]);
    ghl.getContactAppointments.mockResolvedValue([{ startTime: "2026-10-16 10:00:00", appointmentStatus: "noshow" }]);
    expect(await noShowStillApplies("c", "contact", "No-Show", TZ)).toEqual({ applies: true });
  });

  it("stops when an agent moved the card on", async () => {
    ghl.listOpportunitiesForContact.mockResolvedValue([{ pipelineStageId: "other" }]);
    const r = await noShowStillApplies("c", "contact", "No-Show", TZ);
    expect(r).toMatchObject({ applies: false });
  });

  it("stops when they already have a new appointment ahead", async () => {
    ghl.listOpportunitiesForContact.mockResolvedValue([{ pipelineStageId: "ns" }]);
    ghl.getContactAppointments.mockResolvedValue([{ startTime: "2099-01-01 10:00:00", appointmentStatus: "confirmed" }]);
    expect(await noShowStillApplies("c", "contact", "No-Show", TZ)).toMatchObject({ applies: false, reason: expect.stringMatching(/booked ahead/) });
  });

  it("says unknown (never 'applies') when GHL cannot be read", async () => {
    ghl.listOpportunitiesForContact.mockRejectedValue(new Error("boom"));
    expect(await noShowStillApplies("c", "contact", "No-Show", TZ)).toEqual({ applies: "unknown" });
  });
});

describe("scanClient", () => {
  const settings = { enabled: true, stageName: "No-Show", maxCalls: 3 };
  const cadence = { attemptsPerDay: 2, days: 4, recheckBeforeEachAttempt: true };
  const card = (id: string, changed: string) => ({ id, contactId: `c-${id}`, lastStageChangeAt: changed, assignedTo: "u1" });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    idx.loadIrisConfig.mockReturnValue({ noShowFollowUp: settings, outreachCadence: cadence, timezone: TZ });
    idx.loadClientBranding.mockReturnValue({ brandName: "3% Realty", city: "St. John's" });
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc", apiKey: "k" });
    ghl.getLocationTimezone.mockResolvedValue(TZ);
    ghl.listPipelines.mockResolvedValue([{ id: "p", stages: [{ id: "ns", name: "No-Show" }] }]);
    ghl.getContact.mockResolvedValue({ contact: { tags: [] } });
    ghl.listLocationUsers.mockResolvedValue([{ id: "u1", name: "Chantelle English" }]);
    ghl.getContactAppointments.mockResolvedValue([{ startTime: "2026-10-19 10:00:00", appointmentStatus: "noshow", title: "Buyer Consultation with X", assignedUserId: "u1" }]);
    scout.refreshLead.mockResolvedValue({ name: "Jesse Noseworthy", phone: "+17095550100", intent: "buyer" });
    db.query.mockImplementation(async () => []);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const inserts = () => db.query.mock.calls.filter((c) => /INSERT INTO iris_noshow_followups/.test(String(c[0])));

  it("the first scan only records what is already in the column, and contacts nobody", async () => {
    ghl.listOpportunitiesInStage.mockResolvedValue([card("a", "2026-10-15"), card("b", "2026-08-01")]);
    await scanClient("3-percent-east-coast");
    // two cards + the marker row, all baseline
    expect(inserts()).toHaveLength(3);
    expect(inserts().every((c) => /baseline/.test(String(c[0])) || (c[1] as unknown[])[4] === "baseline")).toBe(true);
    expect(hook.sendIrisText).not.toHaveBeenCalled();
  });

  it("an empty column on the first scan still leaves a marker, so a later card is not mistaken for baseline", async () => {
    ghl.listOpportunitiesInStage.mockResolvedValue([]);
    await scanClient("3-percent-east-coast");
    expect(inserts()).toHaveLength(1);
  });

  it("texts a card it has not seen, lines up the call, and tells the team", async () => {
    ghl.listOpportunitiesInStage.mockResolvedValue([card("new", "2026-10-20T14:00:00Z")]);
    db.query.mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0]);
      if (/SELECT opportunity_id, stage_changed_at/.test(sql)) return [{ opportunity_id: "old", stage_changed_at: "x" }];
      if (/INSERT INTO iris_noshow_followups/.test(sql)) return [{ id: "42" }];
      return [];
    });

    await scanClient("3-percent-east-coast");

    expect(hook.sendIrisText).toHaveBeenCalledTimes(1);
    const [, contactId, , text] = hook.sendIrisText.mock.calls[0] as unknown as [string, string, string, string];
    expect(contactId).toBe("c-new");
    expect(text).toMatch(/missed each other for your appointment with Chantelle yesterday/);
    const queued = db.query.mock.calls.find((c) => /INSERT INTO iris_pending_calls/.test(String(c[0])))!;
    expect((queued[1] as unknown[])[4]).toBe("no-show");
    expect(JSON.parse((queued[1] as unknown[])[2] as string).noShow).toMatchObject({ agentName: "Chantelle English", followupId: "42" });
    expect(slack.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("never texts the same move twice", async () => {
    ghl.listOpportunitiesInStage.mockResolvedValue([card("seen", "2026-10-20T14:00:00Z")]);
    db.query.mockImplementation(async (...args: unknown[]) =>
      /SELECT opportunity_id, stage_changed_at/.test(String(args[0])) ? [{ opportunity_id: "seen", stage_changed_at: "2026-10-20T14:00:00Z" }] : []
    );
    await scanClient("3-percent-east-coast");
    expect(hook.sendIrisText).not.toHaveBeenCalled();
  });

  it("a card moved out and back in (new move time) counts again", async () => {
    ghl.listOpportunitiesInStage.mockResolvedValue([card("seen", "2026-10-20T14:00:00Z")]);
    db.query.mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0]);
      if (/SELECT opportunity_id, stage_changed_at/.test(sql)) return [{ opportunity_id: "seen", stage_changed_at: "2026-10-01T00:00:00Z" }];
      if (/INSERT INTO iris_noshow_followups/.test(sql)) return [{ id: "7" }];
      return [];
    });
    await scanClient("3-percent-east-coast");
    expect(hook.sendIrisText).toHaveBeenCalledTimes(1);
  });

  it("leaves a lead alone when a teammate has already texted them, and records why", async () => {
    ghl.listOpportunitiesInStage.mockResolvedValue([card("new", "2026-10-20T14:00:00Z")]);
    touch.checkHumanTouch.mockResolvedValueOnce({ status: "human" } as any);
    db.query.mockImplementation(async (...args: unknown[]) => (/SELECT opportunity_id, stage_changed_at/.test(String(args[0])) ? [{ opportunity_id: "old", stage_changed_at: "x" }] : []));
    await scanClient("3-percent-east-coast");
    expect(hook.sendIrisText).not.toHaveBeenCalled();
    expect(inserts().some((c) => (c[1] as unknown[])[4] === "skipped")).toBe(true);
  });

  it("does nothing for a client that has not switched it on", async () => {
    idx.loadIrisConfig.mockReturnValue({ outreachCadence: cadence });
    await scanClient("someone-else");
    expect(ghl.listPipelines).not.toHaveBeenCalled();
  });
});

describe("the call and text prompts for a no-show", () => {
  const lead: any = { contactId: "c", name: "Jesse Noseworthy", phone: "+1", intent: "buyer", budget: "450k", timeline: "1-4 months", propertyInterest: "Townhouse", bedrooms: "3", financing: "pre-approved", workingWithRealtor: false, leadSource: null };
  const config: any = { questions: ["a", "b", "c", "d", "e"], timezone: TZ, serviceArea: undefined };
  const ctx = { agentName: "Chantelle English", missedDay: "Thursday", missedWhen: "Thursday, October 15 at 11:00 AM" };

  it("the call is about rebooking: it names the missed appointment and carries none of the qualification script", () => {
    const prompt = buildLeadQualificationPrompt(config, lead, "3% Realty", "St. John's", true, false, true, "form", ctx);
    expect(prompt).toContain("a missed appointment, not a new lead");
    expect(prompt).toContain("Thursday, October 15 at 11:00 AM");
    expect(prompt).toContain("your appointment with Chantelle on Thursday");
    expect(prompt).not.toContain("Verify what's already known");
    expect(prompt).not.toContain("## Still need to gather");
    expect(prompt).not.toContain("Ordering rule");
    // no figure the voice could mangle
    expect(prompt).not.toMatch(/450k|450000/);
  });

  it("an ordinary call prompt is unchanged by this feature", () => {
    const prompt = buildLeadQualificationPrompt(config, lead, "3% Realty", "St. John's", true, true, true, "form");
    expect(prompt).toContain("Verify what's already known");
    expect(prompt).not.toContain("missed appointment");
  });

  it("the text prompt is rebooking only, with the booking tools' rules", () => {
    const prompt = buildNoShowSmsPrompt(lead, "3% Realty", "St. John's", ctx, { nowLocal: "Tuesday, October 20, 2026 at 12:30 PM", timezoneName: TZ, recentTexts: [{ from: "us", text: "Hi Jesse" }, { from: "lead", text: "yes can we do tomorrow at 2" }] });
    expect(prompt).toContain("NEVER ask about buying, selling");
    expect(prompt).toContain("check_availability");
    expect(prompt).toContain("Lead: yes can we do tomorrow at 2");
    expect(prompt).toContain('pass intent "buyer"');
    expect(prompt).toContain("Yes, I'm an AI assistant with 3% Realty");
    expect(prompt).toContain("Never promise a specific agent");
  });
});
