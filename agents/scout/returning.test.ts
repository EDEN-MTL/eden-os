import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../shared/db", () => db);

const slack = vi.hoisted(() => ({ sendMessage: vi.fn(async () => ({})) }));
vi.mock("../../shared/slack", () => slack);

const ghl = vi.hoisted(() => ({
  addContactTags: vi.fn(async () => ({})),
  removeContactTags: vi.fn(async () => ({})),
  createContactNote: vi.fn(async () => ({})),
  createContactTask: vi.fn(async () => ({})),
  getContact: vi.fn(),
  getContactAppointments: vi.fn(async () => []),
  getCustomFieldDefs: vi.fn(async () => []),
  getGhlConfig: vi.fn(),
  listContactsPaginated: vi.fn(),
  listLocationUsers: vi.fn(async () => []),
  listOpportunitiesForContact: vi.fn(),
  listPipelines: vi.fn(async () => []),
  updateContact: vi.fn(async () => ({})),
}));
vi.mock("../../shared/ghl", () => ghl);

import { assessLeadHistory, describeReasons, historyConfigFor, notifyReturningLead } from "./returning";
import type { NormalisedLead, ScoutConfig } from "./intake";

const STEPHANIE = "FxhXD7440LRChvWfotmD";
const STAGE_LIVE = "d4cb572b-5fa5-48e5-bced-46c88715e2da";
const STAGE_BUYER = "f83b5ac8-e445-4a3e-b1e0-ac99a4747b56";

const CONFIG = {
  touchedTags: ["appt booked", "live transferred"],
  touchedStageIds: [STAGE_LIVE],
  historyStageIds: [STAGE_LIVE],
  returningLeadTag: "returning lead",
  returningLeadSlackChannel: "iris-call-logs",
  returningMinAgeMinutes: 60,
  fields: { isaNotes: "contact.isa_notes" },
} as unknown as ScoutConfig;

const LEAD = { contactId: "contact-glen", name: "Glen White", phone: "+17096890794" } as unknown as NormalisedLead;

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function asyncGen<T>(items: T[]) {
  return (async function* () {
    for (const i of items) yield i;
  })();
}

beforeEach(() => {
  ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
  ghl.listContactsPaginated.mockReturnValue(asyncGen([]));
  ghl.listLocationUsers.mockResolvedValue([{ id: STEPHANIE, name: "Stephanie McGrath" }]);
  ghl.listPipelines.mockResolvedValue([{ stages: [{ id: STAGE_LIVE, name: "Live Transferred" }] }]);
});

afterEach(() => vi.clearAllMocks());

describe("historyConfigFor", () => {
  it("uses historyStageIds when configured, falls back to touchedStageIds otherwise, and defaults the min age", () => {
    expect(historyConfigFor(CONFIG).historyStageIds).toEqual([STAGE_LIVE]);
    const bare = { touchedTags: [], touchedStageIds: ["x"] } as unknown as ScoutConfig;
    expect(historyConfigFor(bare)).toEqual({ touchedTags: [], historyStageIds: ["x"], returningMinAgeMinutes: 60 });
  });
});

describe("assessLeadHistory", () => {
  it("classifies Glen White — old, assigned to Stephanie, tagged appt booked — as returning", async () => {
    ghl.getContact.mockResolvedValue({
      contact: { id: "contact-glen", dateAdded: daysAgo(46), assignedTo: STEPHANIE, tags: ["buyer lead", "appt booked"], phone: "+17096890794", customFields: [] },
    });
    ghl.listOpportunitiesForContact.mockResolvedValue([
      { id: "old", createdAt: daysAgo(46), pipelineStageId: STAGE_LIVE, assignedTo: STEPHANIE },
      { id: "fresh", createdAt: minutesAgo(1), pipelineStageId: STAGE_BUYER, assignedTo: null },
    ]);

    const result = await assessLeadHistory("contact-glen", "3-percent-east-coast", CONFIG);

    expect(result?.history.returning).toBe(true);
    expect(result?.history.assignedUserId).toBe(STEPHANIE);
    expect(result?.contactAssignedTo).toBe(STEPHANIE);
  });

  it("does not flag a genuinely new lead", async () => {
    ghl.getContact.mockResolvedValue({ contact: { id: "c", dateAdded: minutesAgo(2), tags: ["buyer lead"], phone: "+17095550100", customFields: [] } });
    ghl.listOpportunitiesForContact.mockResolvedValue([{ id: "o", createdAt: minutesAgo(2), pipelineStageId: STAGE_BUYER }]);

    expect((await assessLeadHistory("c", "3-percent-east-coast", CONFIG))?.history.returning).toBe(false);
  });

  it("finds history on a duplicate contact record with the same phone, and ignores a different person", async () => {
    ghl.getContact.mockImplementation(async (id: string) => {
      if (id === "new") return { contact: { id: "new", dateAdded: minutesAgo(2), phone: "+1 (709) 689-0794", tags: [], customFields: [] } };
      if (id === "old") return { contact: { id: "old", dateAdded: daysAgo(40), phone: "+17096890794", assignedTo: STEPHANIE, tags: ["live transferred"], customFields: [] } };
      throw new Error("unexpected id " + id);
    });
    ghl.listOpportunitiesForContact.mockImplementation(async (id: string) =>
      id === "old" ? [{ id: "o1", createdAt: daysAgo(40), pipelineStageId: STAGE_LIVE, assignedTo: STEPHANIE }] : [{ id: "o2", createdAt: minutesAgo(2), pipelineStageId: STAGE_BUYER }]
    );
    ghl.listContactsPaginated.mockReturnValue(
      asyncGen([
        { id: "new", phone: "+17096890794" },
        { id: "old", phone: "+17096890794" },
        { id: "someone-else", phone: "+17095559999" },
      ])
    );

    const result = await assessLeadHistory("new", "3-percent-east-coast", CONFIG);

    expect(result?.history.returning).toBe(true);
    expect(result?.history.historyContactId).toBe("old");
    expect(ghl.getContact).not.toHaveBeenCalledWith("someone-else", expect.anything(), expect.anything());
  });

  it("returns null — so the caller fails closed — when the lead itself can't be fetched", async () => {
    ghl.getContact.mockRejectedValue(new Error("GHL down"));
    expect(await assessLeadHistory("c", "3-percent-east-coast", CONFIG)).toBeNull();

    ghl.getGhlConfig.mockResolvedValue(null);
    expect(await assessLeadHistory("c", "3-percent-east-coast", CONFIG)).toBeNull();
  });

  it("doesn't let a failed appointments lookup block the check", async () => {
    ghl.getContact.mockResolvedValue({ contact: { id: "c", dateAdded: daysAgo(20), assignedTo: STEPHANIE, tags: [], customFields: [] } });
    ghl.listOpportunitiesForContact.mockResolvedValue([]);
    ghl.getContactAppointments.mockRejectedValue(new Error("scope"));

    expect((await assessLeadHistory("c", "3-percent-east-coast", CONFIG))?.history.returning).toBe(true);
  });
});

describe("describeReasons", () => {
  it("turns ids into names, collapses repeats, and reads plainly", () => {
    const text = describeReasons(
      [
        { kind: "assigned", userId: STEPHANIE },
        { kind: "worked_stage", stageId: STAGE_LIVE },
        { kind: "worked_stage", stageId: STAGE_LIVE },
        { kind: "touch_tag", tag: "appt booked" },
        { kind: "human_notes" },
        { kind: "appointment", count: 1 },
      ],
      new Map([[STAGE_LIVE, "Live Transferred"]]),
      new Map([[STEPHANIE, "Stephanie McGrath"]])
    );
    expect(text).toEqual([
      "assigned to Stephanie McGrath",
      'an earlier card in "Live Transferred"',
      'tagged "appt booked"',
      "has ISA notes from an agent",
      "1 appointment on record",
    ]);
  });
});

describe("notifyReturningLead", () => {
  const assessed = (assigned: string | null, contactAssignedTo: string | null = assigned) => ({
    history: {
      returning: true,
      reasons: [{ kind: "assigned" as const, userId: STEPHANIE }, { kind: "touch_tag" as const, tag: "appt booked" }],
      assignedUserId: assigned,
      firstSeen: "2026-08-19T22:36:26.770Z",
      historyContactId: "contact-glen",
    },
    contactAssignedTo,
  });

  it("with an assigned agent: tags (remove then add), creates their task, writes a Note, and alerts Slack that Iris won't call", async () => {
    db.query.mockResolvedValue([{ id: "1" }]);

    await notifyReturningLead("3-percent-east-coast", LEAD, assessed(STEPHANIE), CONFIG);

    expect(ghl.removeContactTags).toHaveBeenCalledWith("contact-glen", ["returning lead"], "loc-1", "key-1");
    expect(ghl.addContactTags).toHaveBeenCalledWith("contact-glen", ["returning lead"], "loc-1", "key-1");
    expect(ghl.removeContactTags.mock.invocationCallOrder[0]).toBeLessThan(ghl.addContactTags.mock.invocationCallOrder[0]);
    expect(ghl.createContactTask).toHaveBeenCalledWith(
      "contact-glen",
      expect.objectContaining({ assignedTo: STEPHANIE, title: expect.stringContaining("Glen White") }),
      "loc-1",
      "key-1"
    );
    expect(ghl.createContactNote).toHaveBeenCalledWith("contact-glen", expect.stringContaining("Iris was NOT queued to call"), "loc-1", "key-1");
    const [agent, message] = slack.sendMessage.mock.calls[0] as unknown as [string, { channel: string; text: string }];
    expect(agent).toBe("scout");
    expect(message.channel).toBe("iris-call-logs");
    expect(message.text).toContain("Stephanie McGrath");
    expect(message.text).toContain("Iris will NOT call");
  });

  it("assigns the lead's own record to the owning agent when it isn't already (history sat on a duplicate or only an opportunity)", async () => {
    db.query.mockResolvedValue([{ id: "1" }]);

    await notifyReturningLead("3-percent-east-coast", LEAD, assessed(STEPHANIE, null), CONFIG);

    expect(ghl.updateContact).toHaveBeenCalledWith("contact-glen", { assignedTo: STEPHANIE }, "loc-1", "key-1");
  });

  it("does not touch the assignment when the record already carries the right agent", async () => {
    db.query.mockResolvedValue([{ id: "1" }]);

    await notifyReturningLead("3-percent-east-coast", LEAD, assessed(STEPHANIE, STEPHANIE), CONFIG);

    expect(ghl.updateContact).not.toHaveBeenCalled();
  });

  it("with NO assigned agent: no tag or task (nobody to text), but still a Note and a Slack alert saying a human must decide", async () => {
    db.query.mockResolvedValue([{ id: "1" }]);

    await notifyReturningLead("3-percent-east-coast", LEAD, assessed(null), CONFIG);

    expect(ghl.addContactTags).not.toHaveBeenCalled();
    expect(ghl.createContactTask).not.toHaveBeenCalled();
    expect(ghl.createContactNote).toHaveBeenCalledTimes(1);
    const text = (slack.sendMessage.mock.calls[0] as unknown as [string, { text: string }])[1].text;
    expect(text).toContain("No assigned agent");
    expect(text).toContain("Iris will NOT call");
  });

  it("is de-duplicated: a repeat within the window sends nothing at all", async () => {
    db.query.mockResolvedValue([]); // the INSERT ... WHERE NOT EXISTS matched nothing

    await notifyReturningLead("3-percent-east-coast", LEAD, assessed(STEPHANIE), CONFIG);

    expect(ghl.addContactTags).not.toHaveBeenCalled();
    expect(ghl.createContactTask).not.toHaveBeenCalled();
    expect(slack.sendMessage).not.toHaveBeenCalled();
  });

  it("never writes the isa_notes custom field — that field is wired to automations at 3%", async () => {
    db.query.mockResolvedValue([{ id: "1" }]);

    await notifyReturningLead("3-percent-east-coast", LEAD, assessed(STEPHANIE), CONFIG);

    for (const call of ghl.updateContact.mock.calls as unknown[][]) {
      expect(JSON.stringify(call[1])).not.toContain("customFields");
    }
  });

  it("one step failing doesn't skip the rest — a failed task still leaves the Note and the Slack alert", async () => {
    db.query.mockResolvedValue([{ id: "1" }]);
    ghl.createContactTask.mockRejectedValueOnce(new Error("scope"));

    await expect(notifyReturningLead("3-percent-east-coast", LEAD, assessed(STEPHANIE), CONFIG)).resolves.toBeUndefined();

    expect(ghl.createContactNote).toHaveBeenCalled();
    expect(slack.sendMessage).toHaveBeenCalled();
  });

  it("falls back to posting as Iris when Scout's bot isn't in the Slack channel, so the alert isn't lost", async () => {
    db.query.mockResolvedValue([{ id: "1" }]);
    slack.sendMessage.mockRejectedValueOnce(new Error("not_in_channel"));

    await notifyReturningLead("3-percent-east-coast", LEAD, assessed(STEPHANIE), CONFIG);

    expect(slack.sendMessage).toHaveBeenCalledTimes(2);
    const [agent, message] = slack.sendMessage.mock.calls[1] as unknown as [string, { text: string }];
    expect(agent).toBe("iris");
    expect(message.text).toContain("Returning lead");
    expect(message.text).toContain("Scout isn't in this channel yet");
  });

  it("never throws, even if the de-dupe insert itself fails", async () => {
    db.query.mockRejectedValue(new Error("db down"));

    await expect(notifyReturningLead("3-percent-east-coast", LEAD, assessed(STEPHANIE), CONFIG)).resolves.toBeUndefined();
    expect(slack.sendMessage).not.toHaveBeenCalled();
  });
});
