import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFileSyncMock = vi.fn();
vi.mock("fs", () => ({ readFileSync: (...args: unknown[]) => readFileSyncMock(...args) }));

const ghl = vi.hoisted(() => ({
  getContact: vi.fn(),
  getCustomFieldDefs: vi.fn(),
  getGhlConfig: vi.fn(),
  findOpenOpportunitiesForContact: vi.fn(),
}));
vi.mock("../../shared/ghl", () => ghl);

const returning = vi.hoisted(() => ({
  assessLeadHistory: vi.fn(),
  notifyReturningLead: vi.fn(async () => undefined),
  warnHistoryUnverified: vi.fn(async () => undefined),
}));
vi.mock("./returning", () => returning);

import { eventBus } from "../../shared/events";
import "./index";

/**
 * Mark's spec, 2026-10-04: a lead who already belongs to an agent must not
 * be lined up for an Iris call. Scout is the ONLY producer of lead.enriched
 * (the event Iris acts on), so holding it back here is what actually stops
 * the call — these cover that gate, not the history rules themselves
 * (history.test.ts / returning.test.ts).
 */
const CLIENT_JSON = JSON.stringify({
  scout: {
    pipelineId: "p1",
    intakeStages: { "Buyer Leads": "stage-buyer" },
    qualifiedTags: ["appt booked"],
    touchedTags: ["appt booked"],
    calendars: { buyer: "b", seller: "s" },
    fields: { propertyInterest: "contact.lf_proprety", budget: "contact.lf_budget", timeline: "contact.lf_timeframe", preApproved: "contact.are_you_pre_approuved", leadSource: "contact.source" },
  },
  iris: {},
});

const enriched = vi.fn();
const returningEvents = vi.fn();
eventBus.on("lead.enriched", enriched);
eventBus.on("lead.returning", returningEvents);

/** The registered intake handler — async, so the bus's own emit (which doesn't await) can't be used to know it finished. */
async function capture(contactId = "contact-glen") {
  const handler = eventBus.listeners("lead.captured")[0] as (e: unknown) => Promise<void>;
  await handler({ type: "lead.captured", agentId: "scout", clientId: "3-percent-east-coast", timestamp: "", data: { contactId } });
}

beforeEach(() => {
  readFileSyncMock.mockReturnValue(CLIENT_JSON);
  ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
  ghl.getContact.mockResolvedValue({ contact: { id: "contact-glen", firstName: "Glen", lastName: "White", phone: "+17096890794", tags: ["buyer lead"], customFields: [] } });
  ghl.getCustomFieldDefs.mockResolvedValue([]);
  ghl.findOpenOpportunitiesForContact.mockResolvedValue([]);
});

afterEach(() => vi.clearAllMocks());

describe("Scout intake — returning-lead gate", () => {
  it("emits lead.enriched for a genuinely new lead, exactly as before", async () => {
    returning.assessLeadHistory.mockResolvedValue({ history: { returning: false, reasons: [], assignedUserId: null, firstSeen: null, historyContactId: null }, contactAssignedTo: null });

    await capture();

    expect(enriched).toHaveBeenCalledTimes(1);
    expect(returningEvents).not.toHaveBeenCalled();
    expect(returning.notifyReturningLead).not.toHaveBeenCalled();
  });

  it("for a RETURNING lead: emits lead.returning, alerts, and does NOT emit lead.enriched — so Iris never hears about it", async () => {
    const assessed = {
      history: { returning: true, reasons: [{ kind: "assigned", userId: "stephanie" }], assignedUserId: "stephanie", firstSeen: "2026-08-19T00:00:00Z", historyContactId: "contact-glen" },
      contactAssignedTo: "stephanie",
    };
    returning.assessLeadHistory.mockResolvedValue(assessed);

    await capture();

    expect(enriched).not.toHaveBeenCalled();
    expect(returningEvents).toHaveBeenCalledTimes(1);
    expect(returning.notifyReturningLead).toHaveBeenCalledTimes(1);
    expect(returning.notifyReturningLead.mock.calls[0][2]).toBe(assessed);
  });

  it("FAILS CLOSED when history can't be verified: no lead.enriched, and a Slack warning instead", async () => {
    returning.assessLeadHistory.mockResolvedValue(null);

    await capture();

    expect(enriched).not.toHaveBeenCalled();
    expect(returning.warnHistoryUnverified).toHaveBeenCalledTimes(1);
  });
});
