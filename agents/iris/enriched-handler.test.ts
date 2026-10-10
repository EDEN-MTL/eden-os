import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/claude", () => ({ chatWithTools: vi.fn(), attachmentToBlock: vi.fn() }));
vi.mock("../../shared/slack", () => ({ sendMessage: vi.fn(async () => ({})), getUserRealName: vi.fn(async () => null) }));
vi.mock("../../shared/conversation-memory", () => ({ loadHistory: vi.fn(async () => []), appendHistory: vi.fn(async () => {}) }));
vi.mock("../../shared/agent-notes", () => ({ loadNotes: vi.fn(async () => []), saveNote: vi.fn(async () => {}) }));

const db = vi.hoisted(() => ({ query: vi.fn(async () => []) }));
vi.mock("../../shared/db", () => db);

vi.mock("../../shared/ghl", () => ({ getGhlConfig: vi.fn(), getLocationTimezone: vi.fn(), listContactsPaginated: vi.fn(), getContact: vi.fn() }));

import { eventBus } from "../../shared/events";
import "./index";

const LEAD = {
  contactId: "contact-1",
  name: "Koren Pye",
  email: null,
  phone: "+17097308996",
  propertyInterest: null,
  bedrooms: null,
  workingWithRealtor: null,
  budget: null,
  timeline: null,
  preApproved: null,
  financing: null,
  sources: { financing: null, timeline: null, budget: null },
  leadSource: "Facebook",
  intent: "buyer",
};

function publish(data: Record<string, unknown>) {
  eventBus.publish("lead.enriched", "scout", "3-percent-east-coast", data);
  return new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(() => db.query.mockClear());

/**
 * Jacob, 2026-10-10 (Koren Pye): an existing contact who resubmits the form
 * with no real agent history has old ISA notes that make firstTouch read
 * "worked" — Scout flags the resubmission so Iris still calls.
 */
describe("lead.enriched handler — resubmissions", () => {
  it("skips a lead that's already worked, as always", async () => {
    await publish({ ...LEAD, firstTouch: false });

    expect(db.query).not.toHaveBeenCalled();
  });

  it("queues a call for a flagged resubmission even though firstTouch is false, as an explicit row that replaces an earlier finished one", async () => {
    await publish({ ...LEAD, firstTouch: false, resubmission: true });

    expect(db.query).toHaveBeenCalledTimes(1);
    const sql = String(db.query.mock.calls[0][0]);
    expect(sql).toMatch(/is_explicit_callback/);
    expect(sql).toMatch(/DO UPDATE/);
    expect(sql).toMatch(/WHERE iris_pending_calls\.status <> 'pending'/);
  });

  it("queues an ordinary new lead the ordinary way, never replacing an existing row", async () => {
    await publish({ ...LEAD, firstTouch: true });

    expect(String(db.query.mock.calls[0][0])).toMatch(/DO NOTHING/);
  });
});
