import { afterEach, describe, expect, it, vi } from "vitest";

const readFileSyncMock = vi.fn();
vi.mock("fs", () => ({ readFileSync: (...args: unknown[]) => readFileSyncMock(...args) }));

const ghl = vi.hoisted(() => ({
  getContact: vi.fn(),
  getCustomFieldDefs: vi.fn(),
  getGhlConfig: vi.fn(),
  findOpenOpportunitiesForContact: vi.fn(),
}));
vi.mock("../../shared/ghl", () => ghl);

import { refreshLead } from "./index";

afterEach(() => vi.clearAllMocks());

function clientJson(overrides: Record<string, any> = {}) {
  return JSON.stringify({
    scout: {
      pipelineId: "pipeline-1",
      intakeStages: { "Buyer Leads": "stage-buyer" },
      qualifiedTags: ["appt booked"],
      touchedTags: ["appt booked", "live transferred"],
      calendars: { buyer: "cal-buyer", seller: "cal-seller" },
      fields: {
        propertyInterest: "contact.lf_proprety",
        budget: "contact.lf_budget",
        timeline: "contact.lf_timeframe",
        preApproved: "contact.are_you_pre_approuved",
        leadSource: "contact.source",
      },
    },
    iris: {
      liveTransferStageId: "stage-live-transferred",
      appointmentSetStageIds: ["stage-appointment-set"],
    },
    ...overrides,
  });
}

/**
 * Real gap found live 2026-09-17: isFirstTouch's currentStageId check is
 * only meaningful if refreshLead actually fetches the live opportunity
 * stage and threads it through — these tests cover that wiring, not just
 * the pure isFirstTouch logic already covered in intake.test.ts.
 */
describe("refreshLead — live touched-stage check", () => {
  const contact = { id: "contact-1", firstName: "Robert", lastName: "Wayne", tags: ["buyer lead"] };

  it("skips the opportunity fetch entirely when the client has no touched-stage config", () => {
    readFileSyncMock.mockReturnValue(clientJson({ iris: {} }));
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
    ghl.getContact.mockResolvedValue({ contact });
    ghl.getCustomFieldDefs.mockResolvedValue([]);

    return refreshLead("contact-1", "3-percent-east-coast").then((lead) => {
      expect(ghl.findOpenOpportunitiesForContact).not.toHaveBeenCalled();
      expect(lead?.firstTouch).toBe(true);
    });
  });

  it("treats a lead as already touched when its live opportunity sits in the Live Transferred stage, even with no matching tag", async () => {
    readFileSyncMock.mockReturnValue(clientJson());
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
    ghl.getContact.mockResolvedValue({ contact });
    ghl.getCustomFieldDefs.mockResolvedValue([]);
    ghl.findOpenOpportunitiesForContact.mockResolvedValue([{ pipelineStageId: "stage-live-transferred" }]);

    const lead = await refreshLead("contact-1", "3-percent-east-coast");
    expect(ghl.findOpenOpportunitiesForContact).toHaveBeenCalledWith("contact-1", "loc-1", "key-1");
    expect(lead?.firstTouch).toBe(false);
  });

  it("treats a lead as already touched when sitting in Appointment Set", async () => {
    readFileSyncMock.mockReturnValue(clientJson());
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
    ghl.getContact.mockResolvedValue({ contact });
    ghl.getCustomFieldDefs.mockResolvedValue([]);
    ghl.findOpenOpportunitiesForContact.mockResolvedValue([{ pipelineStageId: "stage-appointment-set" }]);

    const lead = await refreshLead("contact-1", "3-percent-east-coast");
    expect(lead?.firstTouch).toBe(false);
  });

  /**
   * This account's real pipeline moves fresh leads through automated
   * "DAY 1/2/3 FOLLOW UP" stages on its own — confirmed live 2026-09-17 that
   * a lead sitting in one of these a week after creation had never actually
   * been called. Only the two specific configured stages should gate a call.
   */
  it("still calls a lead sitting in an unrelated live stage, like an automated follow-up column", async () => {
    readFileSyncMock.mockReturnValue(clientJson());
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
    ghl.getContact.mockResolvedValue({ contact });
    ghl.getCustomFieldDefs.mockResolvedValue([]);
    ghl.findOpenOpportunitiesForContact.mockResolvedValue([{ pipelineStageId: "stage-day-2-pm-followup" }]);

    const lead = await refreshLead("contact-1", "3-percent-east-coast");
    expect(lead?.firstTouch).toBe(true);
  });

  it("still gates correctly on the tag alone when no open opportunity exists", async () => {
    readFileSyncMock.mockReturnValue(clientJson());
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
    ghl.getContact.mockResolvedValue({ contact: { ...contact, tags: ["buyer lead", "appt booked"] } });
    ghl.getCustomFieldDefs.mockResolvedValue([]);
    ghl.findOpenOpportunitiesForContact.mockResolvedValue([]);

    const lead = await refreshLead("contact-1", "3-percent-east-coast");
    expect(lead?.firstTouch).toBe(false);
  });
});
