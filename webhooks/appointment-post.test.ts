import { afterEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../shared/db", () => db);
const ghl = vi.hoisted(() => ({
  getGhlConfig: vi.fn(),
  getContact: vi.fn(),
  getContactAppointments: vi.fn(),
  getCustomFieldDefs: vi.fn(),
  listLocationUsers: vi.fn(),
}));
vi.mock("../shared/ghl", () => ghl);
const slack = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock("../shared/slack", () => slack);
const iris = vi.hoisted(() => ({ loadIrisConfig: vi.fn() }));
vi.mock("../agents/iris", () => iris);

import { formatAppointmentPost, formatAppointmentTime, isaNoteBullets, postAppointmentToSlack } from "./appointment-post";

afterEach(() => vi.clearAllMocks());

describe("formatAppointmentTime", () => {
  it("reads GHL's local wall-clock startTime as written", () => {
    expect(formatAppointmentTime("2026-10-09 16:00:00", "America/St_Johns")).toBe("Friday, October 9 at 4:00 PM");
    expect(formatAppointmentTime("2026-10-10 11:00:00", "America/St_Johns")).toBe("Saturday, October 10 at 11:00 AM");
    expect(formatAppointmentTime("2026-10-13 00:30:00", "America/St_Johns")).toBe("Tuesday, October 13 at 12:30 AM");
  });

  it("converts a real ISO instant to the client's timezone", () => {
    // 19:00Z is 4:30 PM in St. John's (NDT, UTC-02:30).
    expect(formatAppointmentTime("2026-10-09T19:00:00Z", "America/St_Johns")).toMatch(/4:30 PM/);
  });

  it("returns null for nothing or junk", () => {
    expect(formatAppointmentTime(undefined, "America/St_Johns")).toBeNull();
    expect(formatAppointmentTime("sometime", "America/St_Johns")).toBeNull();
  });
});

describe("formatAppointmentPost", () => {
  it("puts who it's with, the lead, when, who booked it and the ISA notes as bullets", () => {
    expect(
      formatAppointmentPost({
        intent: "seller",
        clientLabel: "3% Realty East Coast",
        agentName: "Genna Hickey",
        leadName: "Stephen W Burke",
        when: "Friday, October 9 at 4:00 PM",
        bookedBy: "Iris (live call)",
        notes: "Seller | ASAP | 24 Elm St | Iris call Sunday — No answer.",
      })
    ).toBe(
      [
        "Seller Appointment Booked for 3% Realty East Coast with Genna Hickey",
        "Name: Stephen W Burke",
        "When: Friday, October 9 at 4:00 PM",
        "Booked by: Iris (live call)",
        "",
        "ISA NOTES: - Seller\n- ASAP\n- 24 Elm St",
      ].join("\n")
    );
  });

  it("copes with no agent, no time, no notes", () => {
    const text = formatAppointmentPost({ intent: "buyer", clientLabel: "X", agentName: null, leadName: "A B", when: null, bookedBy: null, notes: null });
    expect(text).toBe("Buyer Appointment Booked for X with an agent (not assigned yet)\nName: A B");
  });
});

describe("isaNoteBullets", () => {
  it("drops Iris's own status lines", () => {
    expect(isaNoteBullets("Iris call Monday — No answer.\nBuyer | ASAP")).toEqual(["Buyer", "ASAP"]);
  });
});

describe("postAppointmentToSlack", () => {
  const setup = (claimRows: unknown[]) => {
    iris.loadIrisConfig.mockReturnValue({ timezone: "America/St_Johns", callbackNotesFieldKey: "isa_notes", liveTransferSlack: { channel: "C1", clientLabel: "3% Realty East Coast" } });
    ghl.getGhlConfig.mockResolvedValue({ locationId: "L", apiKey: "K" });
    ghl.getContactAppointments.mockResolvedValue([
      { id: "old", appointmentStatus: "confirmed", dateAdded: "2026-10-01 10:00:00", startTime: "2026-10-02 10:00:00", assignedUserId: "u1" },
      { id: "new", appointmentStatus: "confirmed", dateAdded: "2026-10-13 13:35:26", startTime: "2026-10-13 15:30:00", assignedUserId: "u1" },
      { id: "gone", appointmentStatus: "cancelled", dateAdded: "2026-10-14 09:00:00", startTime: "2026-10-15 15:30:00", assignedUserId: "u1" },
    ]);
    ghl.getContact.mockResolvedValue({ contact: { firstName: "Raymond", lastName: "Flaherty", tags: ["seller lead"], customFields: [] } });
    ghl.getCustomFieldDefs.mockResolvedValue([]);
    ghl.listLocationUsers.mockResolvedValue([{ id: "u1", name: "Ashley Fleming" }]);
    db.query.mockReset();
    db.query.mockResolvedValue([] as never);
    db.query.mockResolvedValueOnce(claimRows as never);
  };

  it("posts the contact's newest non-cancelled appointment once, as Iris, to the live-transfers channel", async () => {
    setup([{ id: "1" }]);
    await postAppointmentToSlack("3-percent-east-coast", "c1");
    expect(slack.sendMessage).toHaveBeenCalledTimes(1);
    const [agent, msg] = slack.sendMessage.mock.calls[0] as unknown as [string, { channel: string; text: string }];
    expect(agent).toBe("iris");
    expect(msg.channel).toBe("C1");
    expect(msg.text).toContain("Seller Appointment Booked for 3% Realty East Coast with Ashley Fleming");
    expect(msg.text).toContain("Name: Raymond Flaherty");
    expect(msg.text).toContain("When: Tuesday, October 13 at 3:30 PM");
    expect((db.query.mock.calls[0] as unknown as [string, unknown[]])[1]).toEqual(["3-percent-east-coast", "new", "c1"]);
  });

  it("stays quiet when the other path already posted this appointment", async () => {
    setup([]);
    await postAppointmentToSlack("3-percent-east-coast", "c1", { appointmentId: "new", bookedBy: "Iris (live call)" });
    expect(slack.sendMessage).not.toHaveBeenCalled();
  });

  it("gives the claim back if Slack fails, so the other path can still post", async () => {
    setup([{ id: "7" }]);
    slack.sendMessage.mockRejectedValueOnce(new Error("slack down"));
    await postAppointmentToSlack("3-percent-east-coast", "c1");
    expect(String(db.query.mock.calls[2][0])).toMatch(/DELETE FROM appointment_posts/);
  });

  it("does nothing when the client has no live-transfers channel configured", async () => {
    iris.loadIrisConfig.mockReturnValue({ timezone: "America/St_Johns" });
    await postAppointmentToSlack("x", "c1");
    expect(ghl.getContactAppointments).not.toHaveBeenCalled();
    expect(slack.sendMessage).not.toHaveBeenCalled();
  });
});
