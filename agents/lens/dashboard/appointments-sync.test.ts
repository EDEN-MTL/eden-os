import { describe, expect, it } from "vitest";
import { normalizeAppointmentStatus, toAppointmentRow } from "./appointments-sync";

describe("normalizeAppointmentStatus", () => {
  it("maps GHL's statuses", () => {
    expect(normalizeAppointmentStatus("new")).toBe("booked");
    expect(normalizeAppointmentStatus("confirmed")).toBe("confirmed");
    expect(normalizeAppointmentStatus("showed")).toBe("attended");
    expect(normalizeAppointmentStatus("noshow")).toBe("no_show");
    expect(normalizeAppointmentStatus("cancelled")).toBe("cancelled");
    expect(normalizeAppointmentStatus("canceled")).toBe("cancelled");
    expect(normalizeAppointmentStatus("invalid")).toBe("invalid");
  });
  it("treats an unknown or missing status as booked, and a deleted event as deleted whatever its status", () => {
    expect(normalizeAppointmentStatus(undefined)).toBe("booked");
    expect(normalizeAppointmentStatus("something-new")).toBe("booked");
    expect(normalizeAppointmentStatus("confirmed", true)).toBe("deleted");
  });
});

describe("toAppointmentRow (a real GHL event for 3% Realty)", () => {
  const event = {
    appointmentStatus: "noshow",
    assignedUserId: "VKibPDAtqMTwDRd5A7ql",
    calendarId: "4Eyz51DOI7TY78gRgBU3",
    contactId: "J2NNy2DlKsSvi4AZ4GqJ",
    dateAdded: "2026-10-14T22:30:35.000Z",
    endTime: "2026-10-15T11:15:00-02:30",
    id: "fMItI5tJMJtKmaop6MgT",
    startTime: "2026-10-15T11:00:00-02:30",
    title: "Buyer Consultation with Jesse Noseworthy",
    deleted: false,
  };
  it("reads the real instants from GHL's offsets and normalizes the status", () => {
    const row = toAppointmentRow(event)!;
    expect(row.startTime.toISOString()).toBe("2026-10-15T13:30:00.000Z");
    expect(row.bookedAt?.toISOString()).toBe("2026-10-14T22:30:35.000Z");
    expect(row.status).toBe("no_show");
    expect(row.rawStatus).toBe("noshow");
    expect(row.contactId).toBe("J2NNy2DlKsSvi4AZ4GqJ");
  });
  it("skips an event with no id or no readable start time", () => {
    expect(toAppointmentRow({ ...event, id: undefined })).toBeNull();
    expect(toAppointmentRow({ ...event, startTime: "nonsense" })).toBeNull();
  });
});
