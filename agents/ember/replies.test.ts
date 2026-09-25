import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ listReplyWatch: vi.fn(async () => [] as any[]), updateLead: vi.fn(async () => {}) }));
vi.mock("./store", () => store);
vi.mock("./webhooks", () => ({ emberHandleInboundMessage: vi.fn() }));
vi.mock("../iris/sms", () => ({ irisHandleInboundSms: vi.fn() }));
vi.mock("../iris/text-signals", () => ({ lastInboundText: vi.fn() }));
vi.mock("../../shared/ghl", () => ({ getGhlConfig: vi.fn() }));

import { pollRepliesForClient, ReplyPollDeps } from "./replies";
import { daysAgo, lead } from "./test-fixtures";

afterEach(() => vi.clearAllMocks());

function deps(inbound: { text: string; dateAdded: string | null } | null): ReplyPollDeps {
  return {
    lastInboundText: vi.fn(async () => inbound),
    irisHandleInboundSms: vi.fn(async () => true),
    emberHandleInboundMessage: vi.fn(async () => true),
  };
}

describe("pollRepliesForClient", () => {
  it("routes a new reply from a nurturing lead to Ember and marks it seen", async () => {
    store.listReplyWatch.mockResolvedValueOnce([lead({ lastTouchAt: daysAgo(2) })]);
    const d = deps({ text: "yes still looking", dateAdded: daysAgo(1) });
    const r = await pollRepliesForClient("c", d);
    expect(r.routedToEmber).toBe(1);
    expect(d.emberHandleInboundMessage).toHaveBeenCalledWith("c1", "yes still looking", new Date(daysAgo(1)));
    expect(store.updateLead).toHaveBeenCalledWith(1, { lastInboundSeenAt: daysAgo(1) });
  });

  it("routes a handed-off lead's reply to Iris", async () => {
    store.listReplyWatch.mockResolvedValueOnce([lead({ status: "handed_off", lastTouchAt: daysAgo(3), lastInboundSeenAt: daysAgo(2) })]);
    const d = deps({ text: "in 2 months", dateAdded: daysAgo(1) });
    const r = await pollRepliesForClient("c", d);
    expect(r.routedToIris).toBe(1);
    expect(d.irisHandleInboundSms).toHaveBeenCalledWith("c1", "in 2 months", { receivedAt: new Date(daysAgo(1)) });
  });

  it("never re-answers a reply already seen (e.g. the webhook got it first)", async () => {
    store.listReplyWatch.mockResolvedValueOnce([lead({ lastTouchAt: daysAgo(3), lastInboundSeenAt: daysAgo(1) })]);
    const d = deps({ text: "yes", dateAdded: daysAgo(1) });
    await pollRepliesForClient("c", d);
    expect(d.emberHandleInboundMessage).not.toHaveBeenCalled();
    expect(store.updateLead).not.toHaveBeenCalled();
  });

  it("ignores a text from before Ember's first touch — that's the original inquiry thread", async () => {
    store.listReplyWatch.mockResolvedValueOnce([lead({ lastTouchAt: daysAgo(1) })]);
    const d = deps({ text: "looking for a 3 bed", dateAdded: daysAgo(90) });
    await pollRepliesForClient("c", d);
    expect(d.emberHandleInboundMessage).not.toHaveBeenCalled();
  });
});
