import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn(async (..._a: unknown[]): Promise<any[]> => []) }));
vi.mock("../../shared/db", () => db);
vi.mock("../../shared/ghl", () => ({
  getContact: vi.fn(),
  getContactAppointments: vi.fn(),
  getConversationMessages: vi.fn(),
  getConversations: vi.fn(),
  getCustomFieldDefs: vi.fn(),
  getGhlConfig: vi.fn(),
  listOpportunitiesInStage: vi.fn(),
  listPipelines: vi.fn(),
}));
vi.mock("./index", () => ({ loadIrisConfig: vi.fn() }));
vi.mock("../scout/intake", () => ({ buildKeyToId: vi.fn(), readField: vi.fn() }));

import {
  analyzeLead,
  eventsFromIrisCalls,
  eventsFromMessages,
  formatFindings,
  isTestContact,
  latestReview,
  qualifiedSignals,
  reviewForLens,
  snoozeByName,
  type Finding,
  type LeadFacts,
  type ReviewEvent,
} from "./lead-review";

const NOW = new Date("2026-10-29T15:00:00.000Z");
const d = (daysAgo: number, hours = 0) => NOW.getTime() - daysAgo * 86_400_000 - hours * 3_600_000;
const ev = (over: Partial<ReviewEvent> & Pick<ReviewEvent, "at" | "actor" | "direction">): ReviewEvent => ({ kind: "sms", text: "", ...over });
const lead = (over: Partial<LeadFacts> = {}): LeadFacts => ({
  contactId: "c1",
  name: "Sabrina Marie",
  stageName: "Replied",
  tags: ["buyer lead"],
  dnd: false,
  hasPhone: true,
  notes: "",
  assignedTo: null,
  createdAt: d(20),
  events: [],
  irisQueue: null,
  ...over,
});

describe("eventsFromMessages", () => {
  it("labels who each message really came from", () => {
    const events = eventsFromMessages([
      { messageType: "TYPE_SMS", direction: "outbound", dateAdded: "2026-10-20T10:00:00Z", source: "workflow", userId: "agent", body: "automation" },
      { messageType: "TYPE_SMS", direction: "outbound", dateAdded: "2026-10-20T11:00:00Z", source: "app", meta: { marketplace: { appId: "x" } }, userId: "agent", body: "iris" },
      { messageType: "TYPE_SMS", direction: "outbound", dateAdded: "2026-10-20T12:00:00Z", source: "app", userId: "jacob", body: "person" },
      { messageType: "TYPE_SMS", direction: "inbound", dateAdded: "2026-10-20T13:00:00Z", body: "lead" },
      { messageType: "TYPE_CALL", direction: "outbound", dateAdded: "2026-10-20T14:00:00Z", userId: "jacob", status: "completed", meta: { call: { duration: 2 } } },
      { messageType: "TYPE_SMS", direction: "outbound", dateAdded: "2026-10-20T15:00:00Z", status: "failed", userId: "jacob", body: "never sent" },
      { messageType: "TYPE_ACTIVITY_OPPORTUNITY", direction: "outbound", dateAdded: "2026-10-20T16:00:00Z" },
    ]);
    expect(events.map((e) => e.actor)).toEqual(["automation", "app", "human", "lead", "human"]);
    expect(events[4]).toMatchObject({ kind: "call", reached: false });
  });
  it("turns Iris's own calls into events that say whether anyone was reached", () => {
    const e = eventsFromIrisCalls([
      { created_at: new Date(d(2)), ended_reason: "customer-did-not-answer", transcript: "User: voicemail" },
      { created_at: new Date(d(1)), ended_reason: "customer-ended-call", transcript: "User: Hello?\nAI: Hi" },
    ]);
    expect(e.map((x) => x.reached)).toEqual([false, true]);
  });
});

describe("analyzeLead", () => {
  it("finds a promise nobody has kept (Sabrina Marie: 'I'll have Justin reach out', then nothing)", () => {
    const f = analyzeLead(lead({ events: [ev({ at: d(7), actor: "human", direction: "out", text: "No worries! I'll have Justin reach out to you and help send over some options" })] }), NOW);
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe("owed_contact");
    expect(f[0].headline).toMatch(/promised a call or follow-up 7d ago and nobody has tried since/);
    expect(f[0].evidence[0]).toContain("Justin reach out");
  });

  it("finds a lead who asked to be called and never was", () => {
    const f = analyzeLead(lead({ events: [ev({ at: d(5), actor: "lead", direction: "in", text: "Can you call me after 4 tomorrow?" })] }), NOW);
    expect(f[0].kind).toBe("owed_contact");
    expect(f[0].evidence[0]).toContain("They asked");
  });

  it("is satisfied by any attempt after the promise, and not by the promise itself", () => {
    const promise = ev({ at: d(7), actor: "app", direction: "out", text: "Iris will give you a call then!" });
    expect(analyzeLead(lead({ events: [promise, ev({ at: d(6), actor: "iris_call", direction: "out", kind: "call", reached: false })] }), NOW).some((x) => x.kind === "owed_contact")).toBe(false);
  });

  it("says 'only missed attempts' when every try since the promise went unanswered and nobody has tried lately", () => {
    const f = analyzeLead(
      lead({
        events: [
          ev({ at: d(12), actor: "app", direction: "out", text: "Iris will give you a call on a weekday late afternoon" }),
          ev({ at: d(10), actor: "human", direction: "out", kind: "call", reached: false }),
          ev({ at: d(9), actor: "human", direction: "out", kind: "call", reached: false }),
        ],
      }),
      NOW
    );
    expect(f[0].kind).toBe("only_missed_attempts");
    expect(f[0].headline).toContain("only unanswered tries (2)");
  });

  it("leaves a lead alone while a teammate has been in touch in the last 3 days", () => {
    const f = analyzeLead(
      lead({ events: [ev({ at: d(12), actor: "app", direction: "out", text: "Iris will give you a call" }), ev({ at: d(1), actor: "human", direction: "out", kind: "call", reached: false })] }),
      NOW
    );
    expect(f).toEqual([]);
  });

  it("does not count a promise that is too fresh, too old, or one Iris has a call lined up for", () => {
    expect(analyzeLead(lead({ events: [ev({ at: d(0, 2), actor: "human", direction: "out", text: "I'll call you tomorrow" })] }), NOW)).toEqual([]);
    expect(analyzeLead(lead({ events: [ev({ at: d(60), actor: "human", direction: "out", text: "I'll call you tomorrow" })] }), NOW).some((x) => x.kind === "owed_contact")).toBe(false);
    expect(
      analyzeLead(lead({ events: [ev({ at: d(2), actor: "app", direction: "out", text: "Iris will give you a call then" })], irisQueue: { status: "pending", callAfter: NOW.getTime() + 3_600_000 } }), NOW)
    ).toEqual([]);
  });

  it("treats the intake automation's 'you'll receive a call from IRIS' as a promise only for the first few days", () => {
    const text = "you'll receive a quick call from our AI assistant, IRIS";
    expect(analyzeLead(lead({ events: [ev({ at: d(3), actor: "automation", direction: "out", text })] }), NOW)[0]?.kind).toBe("owed_contact");
    expect(analyzeLead(lead({ events: [ev({ at: d(12), actor: "automation", direction: "out", text })] }), NOW)).toEqual([]);
  });

  it("finds a text nobody answered (Marcia-style: the last word in the thread is the lead's)", () => {
    const f = analyzeLead(lead({ events: [ev({ at: d(1), actor: "lead", direction: "in", text: "I have purchase a home. Thanks" })] }), NOW);
    expect(f[0].kind).toBe("unanswered_reply");
  });
  it("does not flag a STOP, a reply answered since, or one that is only minutes old", () => {
    expect(analyzeLead(lead({ events: [ev({ at: d(1), actor: "lead", direction: "in", text: "Stop" })] }), NOW)).toEqual([]);
    expect(analyzeLead(lead({ events: [ev({ at: d(1), actor: "lead", direction: "in", text: "yes" }), ev({ at: d(0, 20), actor: "human", direction: "out", text: "great" })] }), NOW)).toEqual([]);
    expect(analyzeLead(lead({ events: [ev({ at: d(0, 1), actor: "lead", direction: "in", text: "yes" })] }), NOW)).toEqual([]);
  });

  it("finds a lead who is qualified in the notes and untouched for days", () => {
    const notes = "Intent: buyer Timeline: ASAP Area: CBS Budget: $350K pre-approved 3 bed";
    const f = analyzeLead(lead({ notes, events: [ev({ at: d(14), actor: "human", direction: "out", text: "hi" })] }), NOW);
    expect(f[0].kind).toBe("qualified_untouched");
    expect(f[0].evidence[0]).toContain("Notes:");
    // tried recently: not flagged
    expect(analyzeLead(lead({ notes, events: [ev({ at: d(1), actor: "app", direction: "out", text: "hi" })] }), NOW)).toEqual([]);
  });

  it("never flags someone who opted out, has no phone, or has nothing at all", () => {
    const events = [ev({ at: d(7), actor: "human", direction: "out", text: "I'll call you tomorrow" })];
    expect(analyzeLead(lead({ events, dnd: true }), NOW)).toEqual([]);
    expect(analyzeLead(lead({ events, tags: ["do not call"] }), NOW)).toEqual([]);
    expect(analyzeLead(lead({ events, hasPhone: false }), NOW)).toEqual([]);
    expect(analyzeLead(lead(), NOW)).toEqual([]);
  });
});

describe("qualifiedSignals and isTestContact", () => {
  it("counts the usual qualifying facts", () => {
    expect(qualifiedSignals("Budget: $350K Timeline: ASAP Area: Torbay pre-approved 3 bed", [])).toBe(5);
    expect(qualifiedSignals("called, no answer", [])).toBe(0);
    expect(qualifiedSignals("", ["iris sms qualified"])).toBe(2);
  });
  it("recognises Eden's own test contacts", () => {
    expect(isTestContact({ email: "mark@edenmtl.com" }, ["edenmtl.com"])).toBe(true);
    expect(isTestContact({ email: "someone@gmail.com" }, ["edenmtl.com"])).toBe(false);
    expect(isTestContact({ tags: ["test"] })).toBe(true);
  });
});

describe("formatFindings and reviewForLens", () => {
  const finding = (name: string, stageName: string, score = 80): Finding => ({ kind: "owed_contact", contactId: name, name, stageName, score, headline: "Was promised a call 7d ago", evidence: ["They were told (10-21): “call you”"], lastContact: "a teammate 7d ago", suggested: "Call them today.", assignedTo: null });
  it("lists each lead with its evidence, and says so when nobody looks dropped", () => {
    const text = formatFindings([finding("Sabrina Marie", "Replied")], 180);
    expect(text).toContain("1 lead worth checking in on");
    expect(text).toContain("*Sabrina Marie* — Replied");
    expect(text).toContain("Last tried: a teammate 7d ago");
    expect(formatFindings([], 180)).toContain("nobody who looks dropped");
  });
  it("gives Ember only her stages", () => {
    const review = { ranAt: new Date(), scanned: 10, findings: [finding("A", "Replied"), finding("B", "Live Transferred")] };
    expect(reviewForLens(review, "ember", ["Replied", "Long Term Nurturing"]).findings.map((f) => f.name)).toEqual(["A"]);
    expect(reviewForLens(review, "iris").findings).toHaveLength(2);
  });
});

describe("stored runs and snoozes", () => {
  beforeEach(() => db.query.mockReset());
  afterEach(() => vi.clearAllMocks());
  const f = (name: string, id: string): Finding => ({ kind: "owed_contact", contactId: id, name, stageName: "Replied", score: 1, headline: "h", evidence: [], lastContact: "", suggested: "", assignedTo: null });

  it("hides a snoozed lead from the latest review", async () => {
    db.query.mockImplementation(async (...a: unknown[]) => {
      const sql = String(a[0]);
      if (/FROM lead_review_runs/.test(sql)) return [{ ran_at: new Date(), scanned: 5, findings: [f("Samir Benslimane", "s"), f("Sabrina Marie", "m")] }];
      if (/FROM lead_review_snoozes/.test(sql)) return [{ contact_id: "s" }];
      return [];
    });
    const r = await latestReview("c");
    expect(r?.findings.map((x) => x.name)).toEqual(["Sabrina Marie"]);
  });

  it("snoozes the one lead a name matches, and refuses an ambiguous or unknown name", async () => {
    db.query.mockImplementation(async (...a: unknown[]) => {
      const sql = String(a[0]);
      if (/FROM lead_review_runs/.test(sql)) return [{ ran_at: new Date(), scanned: 5, findings: [f("Samir Benslimane", "s"), f("Sabrina Marie", "m"), f("Sabrina Legg", "l")] }];
      return [];
    });
    expect(await snoozeByName("c", "samir", 14, "Jacob has him", "U1")).toMatchObject({ status: "snoozed", name: "Samir Benslimane" });
    expect(db.query.mock.calls.some((c) => /INSERT INTO lead_review_snoozes/.test(String(c[0])))).toBe(true);
    expect(await snoozeByName("c", "sabrina", 14, "", "U1")).toMatchObject({ status: "ambiguous" });
    expect(await snoozeByName("c", "nobody", 14, "", "U1")).toEqual({ status: "not_found" });
  });
});
