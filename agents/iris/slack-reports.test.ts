import { afterEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../shared/db", () => db);
const ghl = vi.hoisted(() => ({ getContact: vi.fn(), getContactAppointments: vi.fn(), listLocationUsers: vi.fn() }));
vi.mock("../../shared/ghl", () => ghl);
const human = vi.hoisted(() => ({ checkHumanTouch: vi.fn(), DEFAULT_HUMAN_HANDS_OFF_DAYS: 7 }));
vi.mock("./human-touch", () => human);
const texts = vi.hoisted(() => ({ recentTexts: vi.fn() }));
vi.mock("./text-signals", () => texts);

import { upcomingCalls, recentLeads, leadOverview } from "./slack-reports";

afterEach(() => vi.clearAllMocks());

const TZ = "America/St_Johns";
const row = (over: Record<string, unknown> = {}) => ({
  contact_id: "c1",
  name: "Koren Pye",
  call_after: new Date(Date.now() + 2 * 3_600_000),
  status: "pending",
  attempts_made: 4,
  callback_misses: 3,
  is_explicit_callback: true,
  source: null,
  resolution_reason: "callback not answered — retrying",
  ...over,
});

describe("upcomingCalls", () => {
  it("lists scheduled leads by name with their time and kind, and separates those waiting on a text reply", async () => {
    db.query.mockResolvedValueOnce([
      row(),
      row({ contact_id: "c2", name: "Angela Marie", callback_misses: 0 }),
      row({ contact_id: "c3", name: "Tony Molloy", call_after: new Date(Number.POSITIVE_INFINITY), source: "sweep" }),
      row({ contact_id: "c4", name: "Far Away", call_after: new Date(Date.now() + 10 * 24 * 3_600_000) }),
    ] as never);

    const out = await upcomingCalls("3-percent-east-coast", TZ);

    expect(out.scheduled.map((s) => s.name)).toEqual(["Koren Pye", "Angela Marie"]);
    expect(out.scheduled[0].kind).toBe("callback (retry after a miss)");
    expect(out.scheduled[1].kind).toBe("callback requested");
    expect(out.waitingOnTextReply).toEqual(["Tony Molloy"]);
    expect(out.scheduledCount).toBe(2);
  });

  it("treats Postgres's 'infinity' string as waiting on a text reply, not a time", async () => {
    db.query.mockResolvedValueOnce([row({ name: "Tony Molloy", call_after: "infinity" })] as never);
    const out = await upcomingCalls("x", TZ);
    expect(out.scheduled).toEqual([]);
    expect(out.waitingOnTextReply).toEqual(["Tony Molloy"]);
  });

  it("flags a call already overdue", async () => {
    db.query.mockResolvedValueOnce([row({ call_after: new Date(Date.now() - 60_000) })] as never);
    expect((await upcomingCalls("x", TZ)).scheduled[0].overdue).toBe(true);
  });
});

describe("recentLeads", () => {
  it("returns the newest leads with where each stands, and caps the limit", async () => {
    db.query.mockResolvedValueOnce([
      { name: "Amanda Marie", intent: "buyer", created_at: new Date("2026-10-11T00:36:52Z"), status: "placed", resolution_reason: null, attempts_made: 2 },
    ] as never);
    const out = await recentLeads("x", TZ, 500);
    expect((db.query.mock.calls[0] as unknown as [string, unknown[]])[1]).toEqual(["x", 25]);
    expect(out.leads[0]).toMatchObject({ name: "Amanda Marie", intent: "buyer", status: "placed", attemptsSoFar: 2 });
  });
});

describe("leadOverview", () => {
  it("pulls the queue, calls, teammate text, appointments and texts together", async () => {
    ghl.getContact.mockResolvedValue({ contact: { firstName: "Angela", lastName: "Marie", phone: "+17097700724", tags: ["buyer lead", "returning lead"], assignedTo: "u1" } });
    ghl.listLocationUsers.mockResolvedValue([{ id: "u1", name: "Charlene Harnum" }, { id: "u2", name: "Genna Hickey" }]);
    ghl.getContactAppointments.mockResolvedValue([{ startTime: "2026-10-15 14:00:00", appointmentStatus: "confirmed", assignedUserId: "u2" }]);
    human.checkHumanTouch.mockResolvedValue({ status: "human", at: "2026-10-13T18:14:44.124Z", userId: "u2" });
    texts.recentTexts.mockResolvedValue([
      { from: "us", text: "Hey Angela. Saw you submitted the form", at: "2026-10-13T18:14:24.154Z", source: "workflow" },
      { from: "lead", text: "yes this is the right number", at: "2026-10-13T18:20:00.000Z", source: null },
    ]);
    db.query
      .mockResolvedValueOnce([row({ name: "Angela Marie" })] as never)
      .mockResolvedValueOnce([{ created_at: new Date("2026-10-12T12:30:00Z"), ended_reason: "customer-did-not-answer" }] as never);

    const out = await leadOverview("3-percent-east-coast", "c1", TZ, { locationId: "L", apiKey: "K" });

    expect(out.name).toBe("Angela Marie");
    expect(out.assignedAgent).toBe("Charlene Harnum");
    expect(out.tags).toContain("returning lead");
    expect(out.teammateText).toMatchObject({ by: "Genna Hickey" });
    expect(out.appointments).toEqual([{ when: "2026-10-15 14:00:00", status: "confirmed", with: "Genna Hickey" }]);
    expect(out.recentTexts.map((t) => t.from)).toEqual(["automation", "lead"]);
    expect(out.recentCalls).toHaveLength(1);
    expect(out.queue).toMatchObject({ status: "pending", kind: "callback (retry after a miss)" });
  });

  it("says plainly when the lead isn't in the queue or no teammate has texted", async () => {
    ghl.getContact.mockResolvedValue({ contact: { firstName: "A", lastName: "B", tags: [] } });
    ghl.listLocationUsers.mockResolvedValue([]);
    ghl.getContactAppointments.mockResolvedValue([]);
    human.checkHumanTouch.mockResolvedValue({ status: "none" });
    texts.recentTexts.mockResolvedValue([]);
    db.query.mockResolvedValueOnce([] as never).mockResolvedValueOnce([] as never);

    const out = await leadOverview("x", "c9", TZ, { locationId: "L", apiKey: "K" });

    expect(out.queue).toBe("not in Iris's queue");
    expect(out.teammateText).toBe("none in the last 7 days");
  });
});
