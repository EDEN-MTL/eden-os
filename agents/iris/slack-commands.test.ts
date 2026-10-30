import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../shared/db", () => db);

const ghl = vi.hoisted(() => ({
  getContact: vi.fn(),
  getGhlConfig: vi.fn(),
  listContactsPaginated: vi.fn(),
  listLocationUsers: vi.fn(),
}));
vi.mock("../../shared/ghl", () => ghl);

const slack = vi.hoisted(() => ({ sendMessage: vi.fn(async () => ({})) }));
vi.mock("../../shared/slack", () => slack);

const dialPending = vi.hoisted(() => ({ scheduleExplicitCallback: vi.fn(async () => true), queueColdLeadSweep: vi.fn(async (_c: string, ids: string[]) => ids.map((id) => ({ contactId: id, name: `Lead ${id}`, callAfter: new Date() }))) }));
vi.mock("./dial-pending", () => dialPending);

const review = vi.hoisted(() => ({ latestReview: vi.fn() }));
vi.mock("./lead-review", () => review);

const humanTouch = vi.hoisted(() => ({ checkHumanTouch: vi.fn(async () => ({ status: "none" })), DEFAULT_HUMAN_HANDS_OFF_DAYS: 7 }));
vi.mock("./human-touch", () => humanTouch);

import { handleCommandReply, isNo, isYes, prepareCallCommand, prepareReviewActionCommand, prepareStopCommand, SettingsLoader } from "./slack-commands";

const MARK = "U07H26WUGP5";
const JACOB = "U06SA9782HW";
const SETTINGS = { allowedUserIds: [MARK, JACOB], confirmTtlMinutes: 10, timezone: "America/St_Johns", humanHandsOffDays: 7 };
const loader: SettingsLoader = () => SETTINGS;
const CTX = { channelId: "C-calls", userId: MARK };

// Wednesday 2026-10-14 at 11:30 NDT — inside calling hours, so "now" isn't pushed to the morning
const NOW = new Date("2026-10-14T14:00:00.000Z");

function asyncGen<T>(items: T[]) {
  return (async function* () {
    for (const i of items) yield i;
  })();
}
const KOREN = { id: "contact-koren", firstName: "Koren", lastName: "Pye", phone: "+17097308996" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  db.query.mockResolvedValue([]);
  ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
  ghl.listContactsPaginated.mockImplementation(() => asyncGen([KOREN]));
  ghl.getContact.mockResolvedValue({ contact: { ...KOREN, tags: ["buyer lead"], dnd: false } });
  ghl.listLocationUsers.mockResolvedValue([]);
  humanTouch.checkHumanTouch.mockResolvedValue({ status: "none" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("yes / no recognition", () => {
  it.each(["yes", "Yes!", "y", "yep", "confirm", "go ahead", "do it", "yes please"])("reads %s as a yes", (t) => expect(isYes(t)).toBe(true));
  it.each(["no", "cancel", "never mind", "nope"])("reads %s as a no", (t) => expect(isNo(t)).toBe(true));
  it.each(["yes but call her tomorrow instead", "call koren", "maybe", "stop calling matthew", ""])("reads %j as neither — it goes to the model", (t) => {
    expect(isYes(t)).toBe(false);
    expect(isNo(t)).toBe(false);
  });
});

describe("prepareCallCommand", () => {
  it("only prepares: stores a pending command and places NO call", async () => {
    // in-flight check, queue-row check, cancel-older update, then the insert
    db.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "7" }]);

    const out = await prepareCallCommand("3pc", { nameOrPhone: "Koren Pye" }, CTX, loader, NOW);

    expect(out.status).toBe("needs_confirmation");
    expect(out.commandId).toBe(7);
    expect(out.summary).toContain("Koren Pye");
    expect(out.summary).toContain("+17097308996");
    expect(dialPending.scheduleExplicitCallback).not.toHaveBeenCalled();
    expect(out.instruction).toMatch(/NOT placed yet/);
  });

  it("refuses anyone who isn't on the allowed list", async () => {
    const out = await prepareCallCommand("3pc", { nameOrPhone: "Koren Pye" }, { channelId: "C", userId: "U-someone-else" }, loader, NOW);

    expect(out.status).toBe("refused");
    expect(out.reason).toMatch(/only take call\/stop commands from Mark or Jacob/);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("refuses when there's no way to tell who is asking (the dashboard, not Slack)", async () => {
    const out = await prepareCallCommand("3pc", { nameOrPhone: "Koren Pye" }, undefined, loader, NOW);
    expect(out.status).toBe("refused");
  });

  it("refuses when Slack commands aren't turned on for the client", async () => {
    const out = await prepareCallCommand("3pc", { nameOrPhone: "Koren Pye" }, CTX, () => null, NOW);
    expect(out.reason).toMatch(/aren't turned on/);
  });

  it("refuses a lead flagged do-not-disturb or tagged 'do not call' — never offered", async () => {
    ghl.getContact.mockResolvedValue({ contact: { ...KOREN, tags: ["do not call"], dnd: false } });
    expect((await prepareCallCommand("3pc", { nameOrPhone: "Koren" }, CTX, loader, NOW)).status).toBe("refused");

    ghl.getContact.mockResolvedValue({ contact: { ...KOREN, tags: [], dnd: true } });
    expect((await prepareCallCommand("3pc", { nameOrPhone: "Koren" }, CTX, loader, NOW)).status).toBe("refused");
  });

  it("refuses a lead with no phone number", async () => {
    ghl.getContact.mockResolvedValue({ contact: { ...KOREN, phone: null, tags: [] } });
    const out = await prepareCallCommand("3pc", { nameOrPhone: "Koren" }, CTX, loader, NOW);
    expect(out.reason).toMatch(/no phone number/);
  });

  it("asks which lead when more than one matches — never guesses", async () => {
    ghl.listContactsPaginated.mockImplementation(() => asyncGen([KOREN, { id: "c2", firstName: "Koren", lastName: "Pike", phone: "+17095550000" }]));

    const out = await prepareCallCommand("3pc", { nameOrPhone: "Koren" }, CTX, loader, NOW);

    expect(out.status).toBe("ambiguous");
    expect(out.candidates).toHaveLength(2);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("says so when no lead matches", async () => {
    ghl.listContactsPaginated.mockImplementation(() => asyncGen([]));
    expect((await prepareCallCommand("3pc", { nameOrPhone: "Nobody" }, CTX, loader, NOW)).status).toBe("not_found");
  });

  it("shows heads-ups (a teammate texted them, an agent owns them) without blocking", async () => {
    humanTouch.checkHumanTouch.mockResolvedValue({ status: "human", at: "2026-10-12T15:00:00.000Z", userId: "u" });
    ghl.getContact.mockResolvedValue({ contact: { ...KOREN, tags: ["appt booked"], assignedTo: "agent-1" } });
    ghl.listLocationUsers.mockResolvedValue([{ id: "agent-1", name: "Genna Hickey" }]);
    db.query.mockResolvedValue([{ id: "9" }]);

    const out = await prepareCallCommand("3pc", { nameOrPhone: "Koren" }, CTX, loader, NOW);

    expect(out.status).toBe("needs_confirmation");
    expect(out.summary).toContain("a teammate texted them");
    expect(out.summary).toContain("appt booked");
    expect(out.summary).toContain("Genna Hickey");
  });

  it("moves a call asked for outside calling hours into the next window, and says so", async () => {
    db.query.mockResolvedValue([{ id: "3" }]);
    const lateNight = new Date("2026-10-15T01:30:00.000Z"); // 23:00 NDT

    const out = await prepareCallCommand("3pc", { nameOrPhone: "Koren" }, CTX, loader, lateNight);

    expect(out.summary).toMatch(/outside calling hours/);
  });

  it("rejects a time in the past, one it can't read, and one too far out", async () => {
    expect((await prepareCallCommand("3pc", { nameOrPhone: "Koren", whenIso: "2026-10-14T10:00:00-02:30" }, CTX, loader, NOW)).reason).toMatch(/already past/);
    expect((await prepareCallCommand("3pc", { nameOrPhone: "Koren", whenIso: "tomorrow-ish" }, CTX, loader, NOW)).reason).toMatch(/couldn't read/);
    expect((await prepareCallCommand("3pc", { nameOrPhone: "Koren", whenIso: "2026-12-25T10:00:00-03:30" }, CTX, loader, NOW)).reason).toMatch(/7 days/);
  });
});

describe("prepareStopCommand", () => {
  it("prepares a stop for a lead with a pending queue row, without stopping anything yet", async () => {
    db.query.mockResolvedValueOnce([{ status: "pending", call_after: new Date("2026-10-15T14:00:00Z") }]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "5" }]);

    const out = await prepareStopCommand("3pc", { nameOrPhone: "Koren" }, CTX, loader);

    expect(out.status).toBe("needs_confirmation");
    expect(out.summary).toMatch(/Stop Iris calling and texting \*Koren Pye\*/);
    expect(db.query.mock.calls.some((c) => String(c[0]).includes("UPDATE iris_pending_calls"))).toBe(false);
  });

  it("says there's nothing to stop when Iris has nothing queued", async () => {
    db.query.mockResolvedValue([]);
    expect((await prepareStopCommand("3pc", { nameOrPhone: "Koren" }, CTX, loader)).status).toBe("nothing_to_do");
  });

  it("refuses a stranger", async () => {
    expect((await prepareStopCommand("3pc", { nameOrPhone: "Koren" }, { channelId: "C", userId: "U-x" }, loader)).status).toBe("refused");
  });
});

describe("handleCommandReply — the only thing that ever acts", () => {
  const msg = (text: string, over: Record<string, unknown> = {}) => ({ agentId: "iris", userId: MARK, channelId: "C-calls", text, isDM: false, timestamp: "1", ...over }) as never;
  const PENDING_CALL = { id: "7", kind: "call", contact_id: "contact-koren", contact_name: "Koren Pye", call_at: new Date("2026-10-14T14:01:00Z"), created_at: new Date(NOW.getTime() - 60_000) };

  it("ignores a message that isn't a yes or a no — it goes on to the model", async () => {
    expect(await handleCommandReply(msg("what's the weather"), loader, "3pc")).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  it("does nothing when the person has no pending request", async () => {
    db.query.mockResolvedValue([]);
    expect(await handleCommandReply(msg("yes"), loader, "3pc")).toBeNull();
    expect(dialPending.scheduleExplicitCallback).not.toHaveBeenCalled();
  });

  it("a yes from the same person in the same place queues the call and logs who asked", async () => {
    db.query.mockResolvedValueOnce([PENDING_CALL]).mockResolvedValue([]);

    const reply = await handleCommandReply(msg("yes"), loader, "3pc");

    expect(dialPending.scheduleExplicitCallback).toHaveBeenCalledWith("3pc", "contact-koren", PENDING_CALL.call_at, true);
    expect(reply).toMatch(/queued the call to Koren Pye/);
    expect(db.query.mock.calls.some((c) => String(c[0]).includes("SET status = $2") && (c[1] as unknown[])[1] === "executed")).toBe(true);
    expect(slack.sendMessage).toHaveBeenCalledWith("iris", expect.objectContaining({ text: expect.stringContaining(`<@${MARK}> asked me to call *Koren Pye*`) }));
  });

  it("only looks for a pending command belonging to THIS person, in THIS channel and thread", async () => {
    db.query.mockResolvedValue([]);

    await handleCommandReply(msg("yes", { userId: JACOB, threadTs: "111.222" }), loader, "3pc");

    const [sql, params] = db.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/requested_by = \$1 AND channel_id = \$2 AND thread_ts IS NOT DISTINCT FROM \$3 AND status = 'pending'/);
    expect(params).toEqual([JACOB, "C-calls", "111.222"]);
  });

  it("a no cancels it and nothing happens", async () => {
    db.query.mockResolvedValueOnce([PENDING_CALL]).mockResolvedValue([]);

    const reply = await handleCommandReply(msg("no"), loader, "3pc");

    expect(reply).toMatch(/cancelled/);
    expect(dialPending.scheduleExplicitCallback).not.toHaveBeenCalled();
  });

  it("a yes after the time limit does nothing and says it expired", async () => {
    db.query.mockResolvedValueOnce([{ ...PENDING_CALL, created_at: new Date(NOW.getTime() - 11 * 60_000) }]).mockResolvedValue([]);

    const reply = await handleCommandReply(msg("yes"), loader, "3pc");

    expect(reply).toMatch(/expired/);
    expect(dialPending.scheduleExplicitCallback).not.toHaveBeenCalled();
  });

  it("a yes from someone no longer on the allowed list does nothing", async () => {
    db.query.mockResolvedValueOnce([PENDING_CALL]);

    expect(await handleCommandReply(msg("yes"), () => ({ ...SETTINGS, allowedUserIds: [JACOB] }), "3pc")).toBeNull();
    expect(dialPending.scheduleExplicitCallback).not.toHaveBeenCalled();
  });

  it("does NOT claim the call was queued when the lead couldn't be read", async () => {
    db.query.mockResolvedValueOnce([PENDING_CALL]).mockResolvedValue([]);
    dialPending.scheduleExplicitCallback.mockResolvedValueOnce(false);

    const reply = await handleCommandReply(msg("yes"), loader, "3pc");

    expect(reply).toMatch(/did NOT queue the call/);
    expect(slack.sendMessage).not.toHaveBeenCalled();
  });

  it("a yes to a stop closes the lead's queue row", async () => {
    db.query.mockResolvedValueOnce([{ ...PENDING_CALL, kind: "stop", call_at: null }]).mockResolvedValue([]);

    const reply = await handleCommandReply(msg("yes"), loader, "3pc");

    const close = db.query.mock.calls.find((c) => String(c[0]).includes("UPDATE iris_pending_calls"));
    expect(String(close?.[0])).toMatch(/status = 'skipped'/);
    expect((close?.[1] as unknown[])[2]).toBe(`stopped in Slack by ${MARK}`);
    expect(reply).toMatch(/I've stopped/);
    expect(dialPending.scheduleExplicitCallback).not.toHaveBeenCalled();
  });
});

describe("prepareReviewActionCommand", () => {
  const finding = (id: string, name: string, kind = "owed_contact") => ({ kind, contactId: id, name, stageName: "Day 2", score: 90, headline: "", evidence: [], lastContact: "", suggested: "", assignedTo: null });
  const ranAt = new Date(NOW.getTime() - 4 * 3_600_000);
  const reviewOf = (...findings: any[]) => review.latestReview.mockResolvedValue({ ranAt, scanned: 100, findings });
  const contact = (over: any = {}) => ({ contact: { phone: "+17095550101", tags: [], dnd: false, dateAdded: new Date(NOW.getTime() - 20 * 86_400_000).toISOString(), ...over } });

  it("re-checks each flagged lead live and stores ONE pending review command; queues nothing", async () => {
    reviewOf(finding("a", "Ann Lee"), finding("b", "Bo Chan"));
    // per lead: the recent-activity count; then cancel-older update and the insert
    db.query.mockResolvedValueOnce([{ n: "0" }]).mockResolvedValueOnce([{ n: "0" }]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "9" }]);
    ghl.getContact.mockResolvedValue(contact());
    const out = await prepareReviewActionCommand("3pc", {}, CTX, loader, NOW);
    expect(out.status).toBe("needs_confirmation");
    expect(out.summary).toContain("*Ann Lee*");
    expect(out.summary).toContain("*Bo Chan*");
    expect(dialPending.queueColdLeadSweep).not.toHaveBeenCalled();
    const insert = db.query.mock.calls.find((c) => String(c[0]).includes("INSERT INTO iris_slack_commands"))!;
    expect(insert[1][4]).toBe("review");
    expect(JSON.parse(insert[1][9])).toEqual([{ id: "a", name: "Ann Lee" }, { id: "b", name: "Bo Chan" }]);
  });

  it("leaves out do-not-call, booked, no-phone, teammate-touched, already-in-hand and old-inquiry leads, with the reason", async () => {
    reviewOf(finding("dnd", "D"), finding("bk", "B"), finding("np", "N"), finding("tm", "T"), finding("ih", "I"), finding("old", "O"), finding("ok", "Fine"));
    ghl.getContact.mockImplementation(async (id: string) => {
      if (id === "dnd") return contact({ dnd: true });
      if (id === "bk") return contact({ tags: ["appt booked"] });
      if (id === "np") return contact({ phone: "" });
      if (id === "old") return contact({ dateAdded: new Date(NOW.getTime() - 200 * 86_400_000).toISOString() });
      return contact();
    });
    humanTouch.checkHumanTouch.mockImplementation(async (id: string) => ({ status: id === "tm" ? "human" : "none" }));
    // ih -> 1 recent row, ok -> 0, then cancel-older and insert
    db.query.mockResolvedValueOnce([{ n: "1" }]).mockResolvedValueOnce([{ n: "0" }]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "3" }]);
    const out = await prepareReviewActionCommand("3pc", {}, CTX, loader, NOW);
    expect(out.status).toBe("needs_confirmation");
    expect(out.summary).toContain("*Fine*");
    expect(out.summary).not.toContain("*D*");
    for (const why of ["do not call", "already booked", "no phone", "a teammate has been in touch", "Iris already has them in hand", "over 6 months old"]) expect(out.summary).toContain(why);
  });

  it("an old inquiry is fine when the lead is the one who wrote last", async () => {
    reviewOf(finding("r", "Rae", "unanswered_reply"));
    ghl.getContact.mockResolvedValue(contact({ dateAdded: new Date(NOW.getTime() - 300 * 86_400_000).toISOString() }));
    db.query.mockResolvedValueOnce([{ n: "0" }]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "4" }]);
    expect((await prepareReviewActionCommand("3pc", {}, CTX, loader, NOW)).status).toBe("needs_confirmation");
  });

  it("honours skip and only", async () => {
    reviewOf(finding("a", "Ann Lee"), finding("b", "Bo Chan"));
    db.query.mockResolvedValueOnce([{ n: "0" }]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "5" }]);
    const out = await prepareReviewActionCommand("3pc", { skip: ["bo"] }, CTX, loader, NOW);
    expect(out.summary).toContain("*Ann Lee*");
    expect(out.summary).not.toContain("Bo Chan");
    const none = await prepareReviewActionCommand("3pc", { only: ["zed"] }, CTX, loader, NOW);
    expect(none.status).toBe("nothing_to_do");
  });

  it("refuses a stranger, and won't act on a review more than a day and a half old", async () => {
    expect((await prepareReviewActionCommand("3pc", {}, { channelId: "C", userId: "U-stranger" }, loader, NOW)).status).toBe("refused");
    review.latestReview.mockResolvedValue({ ranAt: new Date(NOW.getTime() - 40 * 3_600_000), scanned: 1, findings: [finding("a", "Ann Lee")] });
    expect((await prepareReviewActionCommand("3pc", {}, CTX, loader, NOW)).status).toBe("nothing_to_do");
  });

  it("only a yes queues the call-and-text sweep, and the audit line says it came from the review", async () => {
    db.query
      .mockResolvedValueOnce([{ id: "9", kind: "review", contact_id: "a", contact_name: "Ann Lee", call_at: null, created_at: new Date(NOW.getTime() - 60_000), batch: [{ id: "a", name: "Ann Lee" }] }])
      .mockResolvedValue([]);
    const reply = await handleCommandReply({ text: "yes", userId: MARK, channelId: "C-calls" } as any, loader, "3pc");
    expect(dialPending.queueColdLeadSweep).toHaveBeenCalledWith("3pc", ["a"], expect.any(Date));
    expect(reply).toContain("lined up 1");
    expect(slack.sendMessage).toHaveBeenCalledWith("iris", expect.objectContaining({ text: expect.stringContaining("flagged by the lead review") }));
  });
});
