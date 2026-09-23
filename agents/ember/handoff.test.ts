import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ transitionStatus: vi.fn(async () => true), upsertIrisHandoff: vi.fn(async () => {}) }));
vi.mock("./store", () => store);
const iris = vi.hoisted(() => ({ loadIrisConfig: vi.fn(() => ({ timezone: "America/Toronto" })) }));
vi.mock("../iris", () => iris);
vi.mock("../iris/cadence", () => ({ clampToLegalCallingWindow: (d: Date) => d }));
vi.mock("../iris/sms", () => ({ irisHandleInboundSms: vi.fn() }));
vi.mock("../scout", () => ({ refreshLead: vi.fn() }));

import { handOffToIris, HandoffDeps } from "./handoff";
import { config, lead, NOW } from "./test-fixtures";

afterEach(() => vi.clearAllMocks());

function deps(over: Partial<HandoffDeps> = {}): HandoffDeps {
  return {
    refreshLead: vi.fn(async () => ({ contactId: "c1", phone: "+17095550100", intent: "unknown", name: "Jordan Smith" }) as any),
    irisHandleInboundSms: vi.fn(async () => true),
    ...over,
  };
}
const ctx = (d: HandoffDeps, alert = vi.fn(async () => {})) => ({ config: config(), clientName: "Mark's Realty", alert, now: NOW, deps: d });

describe("handOffToIris", () => {
  it("opens a one-shot ember row for Iris, alerts, and lets Iris answer the reply", async () => {
    const d = deps();
    const c = ctx(d);
    expect(await handOffToIris(lead({ intent: "seller" }), "yes still thinking about it", c)).toBe("handed_off");

    expect(store.transitionStatus).toHaveBeenCalledWith(1, expect.arrayContaining(["nurturing", "completed"]), expect.objectContaining({ status: "handed_off" }));
    const [clientId, contactId, leadForIris, callAfter] = store.upsertIrisHandoff.mock.calls[0] as any[];
    expect([clientId, contactId]).toEqual(["eden-sub-account-one", "c1"]);
    // Ember's intent fills in when GHL's fresh read has none.
    expect(leadForIris.intent).toBe("seller");
    // Cold fallback: one call a day later if they stop texting.
    expect(callAfter.getTime()).toBe(NOW.getTime() + 24 * 3_600_000);
    expect(c.alert).toHaveBeenCalledWith(expect.stringContaining("Iris is qualifying them by text"));
    expect(d.irisHandleInboundSms).toHaveBeenCalledWith("c1", "yes still thinking about it");
  });

  it("is not available when the client has no Iris config", async () => {
    iris.loadIrisConfig.mockReturnValueOnce(null as any);
    expect(await handOffToIris(lead(), "yes", ctx(deps()))).toBe("not_available");
    expect(store.upsertIrisHandoff).not.toHaveBeenCalled();
  });

  it("is not available when the contact can't be read or has no phone to call", async () => {
    expect(await handOffToIris(lead(), "yes", ctx(deps({ refreshLead: vi.fn(async () => null) })))).toBe("not_available");
    expect(await handOffToIris(lead(), "yes", ctx(deps({ refreshLead: vi.fn(async () => ({ phone: null }) as any) })))).toBe("not_available");
    expect(store.transitionStatus).not.toHaveBeenCalled();
  });

  it("does nothing twice when another path already handed this lead off", async () => {
    store.transitionStatus.mockResolvedValueOnce(false);
    const d = deps();
    expect(await handOffToIris(lead(), "yes", ctx(d))).toBe("handed_off");
    expect(store.upsertIrisHandoff).not.toHaveBeenCalled();
    expect(d.irisHandleInboundSms).not.toHaveBeenCalled();
  });
});
