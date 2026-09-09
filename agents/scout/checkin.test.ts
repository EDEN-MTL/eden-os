import { afterEach, describe, expect, it, vi } from "vitest";

const readFileSyncMock = vi.fn();
vi.mock("fs", () => ({ readFileSync: (...args: unknown[]) => readFileSyncMock(...args) }));

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../shared/db", () => db);

const ghl = vi.hoisted(() => ({
  getGhlConfig: vi.fn(),
  listCalendarEvents: vi.fn(),
  listOpportunitiesPaginated: vi.fn(),
}));
vi.mock("../../shared/ghl", () => ghl);

function asyncGeneratorOf<T>(items: T[]) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

import { getCheckinData, parseProspectName, updateCheckinItem } from "./checkin";

afterEach(() => vi.clearAllMocks());

describe("parseProspectName", () => {
  it("strips the buyer-consultation prefix", () => {
    expect(parseProspectName("Buyer Consultation with Kingsley Amos")).toBe("Kingsley Amos");
  });

  it("strips the seller-consultation prefix", () => {
    expect(parseProspectName("Home Selling Consultation with Judy Dunne")).toBe("Judy Dunne");
  });

  it("falls back to the raw title for an unrecognized format", () => {
    expect(parseProspectName("Some Other Event Type")).toBe("Some Other Event Type");
  });
});

function configJson() {
  return JSON.stringify({
    clientName: "3 Percent East Coast",
    scout: { calendars: { buyer: "buyer-cal", seller: "seller-cal" } },
    teams: [
      {
        teamName: "Ashley Fleming Team",
        teamLead: "Ashley Fleming",
        members: [
          { name: "Ashley Fleming", ghlUserId: "ashley-id" },
          { name: "Andrew Fleming", ghlUserId: "andrew-id" },
        ],
      },
    ],
  });
}

describe("getCheckinData", () => {
  it("returns null for an unknown token", async () => {
    db.query.mockResolvedValueOnce([]); // resolveClientId finds nothing

    expect(await getCheckinData("bad-token")).toBeNull();
    expect(ghl.getGhlConfig).not.toHaveBeenCalled();
  });

  it("excludes a team member with no recent appointment, groups an assigned event under their team, and puts an unassigned event under unassigned", async () => {
    db.query
      .mockResolvedValueOnce([{ client_id: "3-percent-east-coast" }]) // resolveClientId
      .mockResolvedValueOnce([]); // checkin rows (none saved yet)
    readFileSyncMock.mockReturnValueOnce(configJson());
    ghl.getGhlConfig.mockResolvedValueOnce({ apiKey: "key", locationId: "loc" });
    ghl.listCalendarEvents
      .mockResolvedValueOnce([
        {
          id: "evt-1",
          title: "Buyer Consultation with Kingsley Amos",
          startTime: "2026-08-27T18:00:00-02:30",
          appointmentStatus: "confirmed",
          assignedUserId: "ashley-id",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "evt-2",
          title: "Home Selling Consultation with Judy Dunne",
          startTime: "2026-09-06T13:00:00-02:30",
          appointmentStatus: "showed",
          // no assignedUserId
        },
      ]);

    const data = await getCheckinData("good-token");

    expect(data).not.toBeNull();
    expect(data!.teams).toHaveLength(1);
    // Andrew Fleming has no appointment and must not appear.
    expect(data!.teams[0].members.map((m) => m.name)).toEqual(["Ashley Fleming"]);
    expect(data!.teams[0].members[0].appointments[0].prospectName).toBe("Kingsley Amos");
    expect(data!.unassigned).toHaveLength(1);
    expect(data!.unassigned[0].prospectName).toBe("Judy Dunne");
    // No saved row for either event yet -> every checkbox defaults false.
    expect(data!.teams[0].members[0].appointments[0].checkboxes).toEqual({
      still_in_conversation: false,
      showed_up: false,
      deal_progressing: false,
      deal_closed: false,
      contract_signed: false,
    });
  });

  it("applies a saved checkbox row onto its matching event", async () => {
    db.query
      .mockResolvedValueOnce([{ client_id: "3-percent-east-coast" }])
      .mockResolvedValueOnce([
        {
          ghl_event_id: "evt-1",
          still_in_conversation: false,
          showed_up: true,
          deal_progressing: false,
          deal_closed: false,
          contract_signed: false,
        },
      ]);
    readFileSyncMock.mockReturnValueOnce(configJson());
    ghl.getGhlConfig.mockResolvedValueOnce({ apiKey: "key", locationId: "loc" });
    ghl.listCalendarEvents
      .mockResolvedValueOnce([
        {
          id: "evt-1",
          title: "Buyer Consultation with Kingsley Amos",
          startTime: "2026-08-27T18:00:00-02:30",
          appointmentStatus: "confirmed",
          assignedUserId: "ashley-id",
        },
      ])
      .mockResolvedValueOnce([]);

    const data = await getCheckinData("good-token");

    expect(data!.teams[0].members[0].appointments[0].checkboxes.showed_up).toBe(true);
  });

  function configJsonWithLiveTransfer() {
    return JSON.stringify({
      clientName: "3 Percent East Coast",
      scout: { calendars: { buyer: "buyer-cal", seller: "seller-cal" }, pipelineId: "pipeline-1" },
      iris: { liveTransferStageId: "live-transfer-stage" },
      teams: [
        {
          teamName: "Ashley Fleming Team",
          teamLead: "Ashley Fleming",
          members: [{ name: "Ashley Fleming", ghlUserId: "ashley-id" }],
        },
      ],
    });
  }

  it("includes a live-transferred opportunity, resolving assignment from followers[0] before assignedTo", async () => {
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast" }]).mockResolvedValueOnce([]);
    readFileSyncMock.mockReturnValueOnce(configJsonWithLiveTransfer());
    ghl.getGhlConfig.mockResolvedValueOnce({ apiKey: "key", locationId: "loc" });
    ghl.listCalendarEvents.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    ghl.listOpportunitiesPaginated.mockReturnValueOnce(
      asyncGeneratorOf([
        {
          id: "opp-1",
          name: "Megan Roberts",
          pipelineStageId: "live-transfer-stage",
          lastStageChangeAt: "2026-09-08T17:50:19.000Z",
          followers: ["ashley-id"],
          assignedTo: null, // real live shape: assignedTo can be null while followers carries the real assignee
        },
      ])
    );

    const data = await getCheckinData("good-token");

    expect(data!.teams[0].members[0].appointments).toHaveLength(1);
    expect(data!.teams[0].members[0].appointments[0]).toMatchObject({
      ghlEventId: "opp-1",
      prospectName: "Megan Roberts",
      status: "live transferred",
    });
  });

  it("falls back to assignedTo when followers is empty", async () => {
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast" }]).mockResolvedValueOnce([]);
    readFileSyncMock.mockReturnValueOnce(configJsonWithLiveTransfer());
    ghl.getGhlConfig.mockResolvedValueOnce({ apiKey: "key", locationId: "loc" });
    ghl.listCalendarEvents.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    ghl.listOpportunitiesPaginated.mockReturnValueOnce(
      asyncGeneratorOf([
        {
          id: "opp-2",
          name: "Roger Perry",
          pipelineStageId: "live-transfer-stage",
          lastStageChangeAt: "2026-09-04T19:40:06.000Z",
          followers: [],
          assignedTo: "ashley-id",
        },
      ])
    );

    const data = await getCheckinData("good-token");

    expect(data!.teams[0].members[0].appointments[0].ghlEventId).toBe("opp-2");
  });

  it("puts a live-transferred opportunity under unassigned when neither followers nor assignedTo resolve to a known team member (e.g. a deleted GHL user id)", async () => {
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast" }]).mockResolvedValueOnce([]);
    readFileSyncMock.mockReturnValueOnce(configJsonWithLiveTransfer());
    ghl.getGhlConfig.mockResolvedValueOnce({ apiKey: "key", locationId: "loc" });
    ghl.listCalendarEvents.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    ghl.listOpportunitiesPaginated.mockReturnValueOnce(
      asyncGeneratorOf([
        {
          id: "opp-3",
          name: "Indu Singh Matta",
          pipelineStageId: "live-transfer-stage",
          lastStageChangeAt: "2026-08-25T10:44:59.000Z",
          followers: [],
          assignedTo: "a-deleted-user-id",
        },
      ])
    );

    const data = await getCheckinData("good-token");

    expect(data!.teams[0].members).toHaveLength(0);
    expect(data!.unassigned).toHaveLength(1);
    expect(data!.unassigned[0].ghlEventId).toBe("opp-3");
  });

  it("excludes opportunities outside the Live Transferred stage and outside the 60-day window", async () => {
    // Only ONE db.query call happens here (resolveClientId) — with every
    // opportunity filtered out and no calendar events, itemIds is empty, so
    // getCheckinData skips the checkin-rows query entirely rather than
    // calling it with an empty array.
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast" }]);
    readFileSyncMock.mockReturnValueOnce(configJsonWithLiveTransfer());
    ghl.getGhlConfig.mockResolvedValueOnce({ apiKey: "key", locationId: "loc" });
    ghl.listCalendarEvents.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    ghl.listOpportunitiesPaginated.mockReturnValueOnce(
      asyncGeneratorOf([
        {
          id: "opp-wrong-stage",
          name: "Not Live Transferred",
          pipelineStageId: "some-other-stage",
          lastStageChangeAt: new Date().toISOString(),
          followers: ["ashley-id"],
        },
        {
          id: "opp-too-old",
          name: "Ancient Transfer",
          pipelineStageId: "live-transfer-stage",
          lastStageChangeAt: "2020-01-01T00:00:00.000Z",
          followers: ["ashley-id"],
        },
      ])
    );

    const data = await getCheckinData("good-token");

    expect(data!.teams[0].members).toHaveLength(0);
    expect(data!.unassigned).toHaveLength(0);
  });

  it("checkinOverrides.assignments reassigns an event GHL couldn't attribute, keyed by contactId", async () => {
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast" }]).mockResolvedValueOnce([]);
    readFileSyncMock.mockReturnValueOnce(
      JSON.stringify({
        clientName: "3 Percent East Coast",
        scout: { calendars: { buyer: "buyer-cal", seller: "seller-cal" } },
        teams: [
          {
            teamName: "Ashley Fleming Team",
            teamLead: "Ashley Fleming",
            members: [{ name: "Andrew Fleming", ghlUserId: "andrew-id" }],
          },
        ],
        checkinOverrides: { assignments: { "contact-kingsley": "andrew-id" } },
      })
    );
    ghl.getGhlConfig.mockResolvedValueOnce({ apiKey: "key", locationId: "loc" });
    ghl.listCalendarEvents
      .mockResolvedValueOnce([
        {
          id: "evt-kingsley",
          contactId: "contact-kingsley",
          title: "Buyer Consultation with Kingsley Amos",
          startTime: "2026-08-27T18:00:00-02:30",
          appointmentStatus: "confirmed",
          // no assignedUserId — GHL never attributed this one
        },
      ])
      .mockResolvedValueOnce([]);

    const data = await getCheckinData("good-token");

    expect(data!.unassigned).toHaveLength(0);
    expect(data!.teams[0].members[0].appointments[0].prospectName).toBe("Kingsley Amos");
  });

  it("checkinOverrides.hidden drops a contact entirely, even from unassigned", async () => {
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast" }]); // no checkin-rows query: itemIds ends up empty
    readFileSyncMock.mockReturnValueOnce(
      JSON.stringify({
        clientName: "3 Percent East Coast",
        scout: { calendars: { buyer: "buyer-cal", seller: "seller-cal" } },
        teams: [],
        checkinOverrides: { hidden: ["contact-hubert"] },
      })
    );
    ghl.getGhlConfig.mockResolvedValueOnce({ apiKey: "key", locationId: "loc" });
    ghl.listCalendarEvents
      .mockResolvedValueOnce([
        {
          id: "evt-hubert",
          contactId: "contact-hubert",
          title: "Buyer Consultation with Hubert Coombs",
          startTime: "2026-08-25T10:00:00-02:30",
          appointmentStatus: "confirmed",
        },
      ])
      .mockResolvedValueOnce([]);

    const data = await getCheckinData("good-token");

    expect(data!.unassigned).toHaveLength(0);
  });
});

describe("updateCheckinItem", () => {
  it("rejects a checkboxes object containing a field outside the fixed allowlist, without writing anything", async () => {
    const result = await updateCheckinItem("token", "evt-1", { not_a_real_column: true });
    expect(result).toBe("invalid-field");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("returns invalid-token for an unresolvable token without writing anything", async () => {
    db.query.mockResolvedValueOnce([]); // resolveClientId finds nothing

    const result = await updateCheckinItem("bad-token", "evt-1", { showed_up: true });
    expect(result).toBe("invalid-token");
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("upserts every checkbox column for a valid token in one call", async () => {
    db.query
      .mockResolvedValueOnce([{ client_id: "3-percent-east-coast" }]) // resolveClientId
      .mockResolvedValueOnce([]); // the upsert itself

    const result = await updateCheckinItem("good-token", "evt-1", { deal_closed: true, showed_up: false });

    expect(result).toBe("ok");
    expect(db.query).toHaveBeenLastCalledWith(
      expect.stringMatching(/deal_closed.*showed_up|showed_up.*deal_closed/s),
      ["3-percent-east-coast", "evt-1", true, false]
    );
  });

  it("no-ops without touching the database when given an empty checkboxes object", async () => {
    const result = await updateCheckinItem("good-token", "evt-1", {});
    expect(result).toBe("ok");
    expect(db.query).not.toHaveBeenCalled();
  });
});
