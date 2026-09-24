import { afterEach, describe, expect, it, vi } from "vitest";

const readFileSyncMock = vi.fn();
vi.mock("fs", () => ({ readFileSync: (...args: unknown[]) => readFileSyncMock(...args) }));

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../shared/db", () => db);

const ghl = vi.hoisted(() => ({
  getGhlConfig: vi.fn(),
  listCalendarEvents: vi.fn(),
  listOpportunitiesPaginated: vi.fn(),
  findOpenOpportunitiesForContact: vi.fn(),
  updateOpportunityMonetaryValue: vi.fn(),
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
    // No saved row for either event yet -> every checkbox defaults false,
    // and potentialCommission defaults to null (not 0 — "not entered").
    expect(data!.teams[0].members[0].appointments[0].checkboxes).toEqual({
      still_in_conversation: false,
      showed_up: false,
      deal_progressing: false,
      deal_closed: false,
      contract_signed: false,
    });
    expect(data!.teams[0].members[0].appointments[0].potentialCommission).toBeNull();
  });

  it("applies a saved checkbox row and a saved potential_commission onto its matching event", async () => {
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
          // node-postgres returns NUMERIC columns as strings.
          potential_commission: "8500.00",
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
    expect(data!.teams[0].members[0].appointments[0].potentialCommission).toBe(8500);
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
          status: "open",
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
          status: "open",
          lastStageChangeAt: "2026-09-04T19:40:06.000Z",
          followers: [],
          assignedTo: "ashley-id",
        },
      ])
    );

    const data = await getCheckinData("good-token");

    expect(data!.teams[0].members[0].appointments[0].ghlEventId).toBe("opp-2");
  });

  it("prefers assignedTo over followers[0] when assignedTo resolves to a real team member and followers doesn't (regression: verified live 2026-09-24, a properly-assigned lead was landing in Needs routing because followers[0] still held an unrelated dead user id)", async () => {
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast" }]).mockResolvedValueOnce([]);
    readFileSyncMock.mockReturnValueOnce(configJsonWithLiveTransfer());
    ghl.getGhlConfig.mockResolvedValueOnce({ apiKey: "key", locationId: "loc" });
    ghl.listCalendarEvents.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    ghl.listOpportunitiesPaginated.mockReturnValueOnce(
      asyncGeneratorOf([
        {
          id: "opp-real-assignment",
          name: "Coker Oluwafemi G",
          pipelineStageId: "live-transfer-stage",
          status: "open",
          lastStageChangeAt: "2026-09-20T03:37:53.000Z",
          assignedTo: "ashley-id",
          followers: ["some-dead-id-unrelated-to-the-roster"],
        },
      ])
    );

    const data = await getCheckinData("good-token");

    expect(data!.unassigned).toHaveLength(0);
    expect(data!.teams[0].members[0].appointments[0].ghlEventId).toBe("opp-real-assignment");
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
          status: "open",
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

  it("excludes opportunities outside the Live Transferred stage, and non-open ones regardless of age", async () => {
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
          status: "open",
          lastStageChangeAt: new Date().toISOString(),
          followers: ["ashley-id"],
        },
        {
          id: "opp-closed",
          name: "Deal Won Already",
          pipelineStageId: "live-transfer-stage",
          status: "won",
          lastStageChangeAt: new Date().toISOString(),
          followers: ["ashley-id"],
        },
      ])
    );

    const data = await getCheckinData("good-token");

    expect(data!.teams[0].members).toHaveLength(0);
    expect(data!.unassigned).toHaveLength(0);
  });

  it("keeps a Live Transferred opportunity that's still open, however old it is", async () => {
    db.query
      .mockResolvedValueOnce([{ client_id: "3-percent-east-coast" }]) // resolveClientId
      .mockResolvedValueOnce([]); // checkin rows
    readFileSyncMock.mockReturnValueOnce(configJsonWithLiveTransfer());
    ghl.getGhlConfig.mockResolvedValueOnce({ apiKey: "key", locationId: "loc" });
    ghl.listCalendarEvents.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    ghl.listOpportunitiesPaginated.mockReturnValueOnce(
      asyncGeneratorOf([
        {
          id: "opp-ancient-but-open",
          name: "Still Going Strong",
          pipelineStageId: "live-transfer-stage",
          status: "open",
          lastStageChangeAt: "2020-01-01T00:00:00.000Z",
        },
      ])
    );

    const data = await getCheckinData("good-token");

    expect(data!.unassigned).toHaveLength(1);
    expect(data!.unassigned[0].ghlEventId).toBe("opp-ancient-but-open");
  });

  it("keeps a calendar-based appointment older than 60 days when its contact still has an open opportunity", async () => {
    db.query
      .mockResolvedValueOnce([{ client_id: "3-percent-east-coast" }]) // resolveClientId
      .mockResolvedValueOnce([]); // checkin rows
    readFileSyncMock.mockReturnValueOnce(configJson());
    ghl.getGhlConfig.mockResolvedValueOnce({ apiKey: "key", locationId: "loc" });
    var oldDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    ghl.listCalendarEvents
      .mockResolvedValueOnce([
        {
          id: "evt-old-open",
          contactId: "contact-still-open",
          title: "Buyer Consultation with Slow Buyer",
          startTime: oldDate,
          appointmentStatus: "showed",
          assignedUserId: "ashley-id",
        },
      ])
      .mockResolvedValueOnce([]);
    ghl.findOpenOpportunitiesForContact.mockResolvedValueOnce([{ id: "opp-1" }]);

    const data = await getCheckinData("good-token");

    expect(ghl.findOpenOpportunitiesForContact).toHaveBeenCalledWith("contact-still-open", "loc", "key");
    expect(data!.teams[0].members[0].appointments[0].ghlEventId).toBe("evt-old-open");
  });

  it("drops a calendar-based appointment older than 60 days when its contact has no open opportunity", async () => {
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast" }]); // resolveClientId only — no items survive
    readFileSyncMock.mockReturnValueOnce(configJson());
    ghl.getGhlConfig.mockResolvedValueOnce({ apiKey: "key", locationId: "loc" });
    var oldDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    ghl.listCalendarEvents
      .mockResolvedValueOnce([
        {
          id: "evt-old-closed",
          contactId: "contact-resolved",
          title: "Buyer Consultation with Done Deal",
          startTime: oldDate,
          appointmentStatus: "showed",
          assignedUserId: "ashley-id",
        },
      ])
      .mockResolvedValueOnce([]);
    ghl.findOpenOpportunitiesForContact.mockResolvedValueOnce([]);

    const data = await getCheckinData("good-token");

    expect(data!.teams[0].members).toHaveLength(0);
    expect(data!.unassigned).toHaveLength(0);
  });

  it("keeps a stale appointment when the open-opportunity check itself fails (fail-open, never silently loses a lead)", async () => {
    db.query
      .mockResolvedValueOnce([{ client_id: "3-percent-east-coast" }])
      .mockResolvedValueOnce([]); // checkin rows
    readFileSyncMock.mockReturnValueOnce(configJson());
    ghl.getGhlConfig.mockResolvedValueOnce({ apiKey: "key", locationId: "loc" });
    var oldDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    ghl.listCalendarEvents
      .mockResolvedValueOnce([
        {
          id: "evt-old-error",
          contactId: "contact-error",
          title: "Buyer Consultation with Uncertain Fate",
          startTime: oldDate,
          appointmentStatus: "showed",
          assignedUserId: "ashley-id",
        },
      ])
      .mockResolvedValueOnce([]);
    ghl.findOpenOpportunitiesForContact.mockRejectedValueOnce(new Error("GHL is down"));

    const data = await getCheckinData("good-token");

    expect(data!.teams[0].members[0].appointments[0].ghlEventId).toBe("evt-old-error");
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

  it("no-ops without touching the database when given an empty fields object", async () => {
    const result = await updateCheckinItem("good-token", "evt-1", {});
    expect(result).toBe("ok");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("accepts a numeric potential_commission alongside checkboxes in one call", async () => {
    db.query
      .mockResolvedValueOnce([{ client_id: "3-percent-east-coast" }]) // resolveClientId
      .mockResolvedValueOnce([]); // the upsert itself

    const result = await updateCheckinItem("good-token", "evt-1", { showed_up: true, potential_commission: 8500 });

    expect(result).toBe("ok");
    expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining("potential_commission"), [
      "3-percent-east-coast",
      "evt-1",
      true,
      8500,
    ]);
  });

  it("accepts null for potential_commission (clearing a previously entered value)", async () => {
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast" }]).mockResolvedValueOnce([]);

    const result = await updateCheckinItem("good-token", "evt-1", { potential_commission: null });

    expect(result).toBe("ok");
    expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining("potential_commission"), [
      "3-percent-east-coast",
      "evt-1",
      null,
    ]);
  });

  it("rejects a non-number, non-null value for potential_commission, without writing anything", async () => {
    const result = await updateCheckinItem("good-token", "evt-1", { potential_commission: "8500" as any });
    expect(result).toBe("invalid-field");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("rejects a boolean value for potential_commission (wrong type for a numeric column)", async () => {
    const result = await updateCheckinItem("good-token", "evt-1", { potential_commission: true as any });
    expect(result).toBe("invalid-field");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("rejects a number value for a boolean checkbox column", async () => {
    const result = await updateCheckinItem("good-token", "evt-1", { showed_up: 1 as any });
    expect(result).toBe("invalid-field");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("pushes a numeric potential_commission to GHL's matching open opportunity when a contactId is given", async () => {
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast" }]).mockResolvedValueOnce([]);
    ghl.getGhlConfig.mockResolvedValueOnce({ apiKey: "key", locationId: "loc" });
    ghl.findOpenOpportunitiesForContact.mockResolvedValueOnce([{ id: "opp-1" }, { id: "opp-2" }]);

    const result = await updateCheckinItem(
      "good-token",
      "evt-1",
      { potential_commission: 8500 },
      "contact-judy"
    );

    expect(result).toBe("ok");
    expect(ghl.findOpenOpportunitiesForContact).toHaveBeenCalledWith("contact-judy", "loc", "key");
    // Uses the first (most-recently-updated) open opportunity, not any other match.
    expect(ghl.updateOpportunityMonetaryValue).toHaveBeenCalledWith("opp-1", 8500, "loc", "key");
  });

  it("does not push to GHL when potential_commission is cleared (null)", async () => {
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast" }]).mockResolvedValueOnce([]);

    const result = await updateCheckinItem(
      "good-token",
      "evt-1",
      { potential_commission: null },
      "contact-judy"
    );

    expect(result).toBe("ok");
    expect(ghl.getGhlConfig).not.toHaveBeenCalled();
    expect(ghl.updateOpportunityMonetaryValue).not.toHaveBeenCalled();
  });

  it("does not push to GHL when no contactId is given, even with a numeric commission", async () => {
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast" }]).mockResolvedValueOnce([]);

    const result = await updateCheckinItem("good-token", "evt-1", { potential_commission: 8500 });

    expect(result).toBe("ok");
    expect(ghl.getGhlConfig).not.toHaveBeenCalled();
    expect(ghl.updateOpportunityMonetaryValue).not.toHaveBeenCalled();
  });

  it("still returns ok when no open GHL opportunity is found for the contact", async () => {
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast" }]).mockResolvedValueOnce([]);
    ghl.getGhlConfig.mockResolvedValueOnce({ apiKey: "key", locationId: "loc" });
    ghl.findOpenOpportunitiesForContact.mockResolvedValueOnce([]);

    const result = await updateCheckinItem(
      "good-token",
      "evt-1",
      { potential_commission: 8500 },
      "contact-no-opp"
    );

    expect(result).toBe("ok");
    expect(ghl.updateOpportunityMonetaryValue).not.toHaveBeenCalled();
  });

  it("still returns ok when the GHL push itself throws", async () => {
    db.query.mockResolvedValueOnce([{ client_id: "3-percent-east-coast" }]).mockResolvedValueOnce([]);
    ghl.getGhlConfig.mockResolvedValueOnce({ apiKey: "key", locationId: "loc" });
    ghl.findOpenOpportunitiesForContact.mockRejectedValueOnce(new Error("GHL is down"));

    const result = await updateCheckinItem(
      "good-token",
      "evt-1",
      { potential_commission: 8500 },
      "contact-judy"
    );

    expect(result).toBe("ok");
  });
});
