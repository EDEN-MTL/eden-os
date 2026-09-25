import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/quarry/deps", () => ({ buildEmailDeps: vi.fn(), buildOutreachDeps: vi.fn() }));
vi.mock("../agents/quarry/outreach", () => ({ handleEmailReply: vi.fn(), handleReply: vi.fn() }));
vi.mock("../agents/quarry/config", () => ({ loadQuarryConfig: vi.fn() }));

const quarryStore = vi.hoisted(() => ({ getLeadByGhlContactId: vi.fn(), updateLead: vi.fn() }));
vi.mock("../agents/quarry/store", () => quarryStore);

const iris = vi.hoisted(() => ({ irisHandleInboundSms: vi.fn(async () => true) }));
vi.mock("../agents/iris/sms", () => iris);

const db = vi.hoisted(() => ({ query: vi.fn(async () => []) }));
vi.mock("../shared/db", () => db);

import { createGHLRouter } from "./ghl-webhook";

/**
 * This router has no existing test coverage at all, and its handlers are
 * inline closures inside createGHLRouter() rather than exported functions
 * (unlike webhooks/vapi-webhook.ts) — extracting just the one new routing
 * branch (Iris-before-Ember on /message, see this file's own comment on
 * that route) via Express's own router stack, rather than pulling in a new
 * HTTP-testing dependency or refactoring the whole file, for one small
 * addition.
 */
function getRouteHandler(path: string, method: "post"): (req: any, res: any) => Promise<void> {
  const router = createGHLRouter();
  const layer = (router as any).stack.find((l: any) => l.route?.path === path && l.route?.methods?.[method]);
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${path} route registered`);
  return layer.route.stack[0].handle;
}

function fakeRes() {
  return { status: vi.fn().mockReturnThis(), send: vi.fn() } as any;
}

beforeEach(() => vi.clearAllMocks());

describe("POST /message — routes a non-Quarry contact to Iris before Ember", () => {
  it("tries irisHandleInboundSms for an inbound SMS from a contact Quarry doesn't know", async () => {
    quarryStore.getLeadByGhlContactId.mockResolvedValue(null);
    const handler = getRouteHandler("/message", "post");

    await handler({ body: { contactId: "contact-1", body: "Looking to buy", type: "SMS", direction: "inbound" } }, fakeRes());

    expect(iris.irisHandleInboundSms).toHaveBeenCalledWith("contact-1", "Looking to buy");
  });

  it("never calls Iris for an email reply — Iris is SMS-only", async () => {
    quarryStore.getLeadByGhlContactId.mockResolvedValue(null);
    const handler = getRouteHandler("/message", "post");

    await handler({ body: { contactId: "contact-1", body: "Looking to buy", type: "EMAIL", direction: "inbound" } }, fakeRes());

    expect(iris.irisHandleInboundSms).not.toHaveBeenCalled();
  });

  it("never calls Iris when the contact IS a real Quarry prospect", async () => {
    quarryStore.getLeadByGhlContactId.mockResolvedValue({ id: "lead-1", clientId: "some-client", name: "Test Lead" });
    const handler = getRouteHandler("/message", "post");

    await handler({ body: { contactId: "contact-1", body: "yes", type: "SMS", direction: "inbound" } }, fakeRes());

    expect(iris.irisHandleInboundSms).not.toHaveBeenCalled();
  });
});
