import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn(async (..._a: unknown[]): Promise<any[]> => []) }));
vi.mock("../../../shared/db", () => db);
const queue = vi.hoisted(() => ({ get: vi.fn(), markExecuted: vi.fn(async () => {}), markFailed: vi.fn(async () => {}) }));
vi.mock("./queue", () => queue);
vi.mock("../../../shared/meta", () => ({ getMetaConfig: vi.fn(), MetaClient: class {} }));

import { canApproveFromSlack, flagBlocks, handleApprovalClick, KEEP_ACTION_ID, loadApprovers, NUDGE_AFTER_HOURS, PAUSE_ACTION_ID, runApprovalNudges } from "./approval";
import { handleForgeInteraction } from "../../../webhooks/slack-events";

const MARK = "U07H26WUGP5";
const JACOB = "U06SA9782HW";
const ROW = {
  id: 7,
  client_id: "3-percent-east-coast",
  entity_type: "adset",
  entity_id: "adset-1",
  entity_name: "AUG 2026 | Testing | Static Seller",
  reasoning: "[CPL above config threshold] cpl=118.6 gt 110.0 over last 7d",
  status: "pending",
  decided_by: null,
  slack_channel: "C0BPESKGTE1",
  slack_message_ts: "1700000000.000100",
};

const executor = { executeManual: vi.fn(async () => ({ status: "executed" })), reject: vi.fn(async () => {}) };
const deps = (live: string | null = "ACTIVE") => ({ executorFor: vi.fn(async () => executor as any), liveStatus: vi.fn(async () => live) });

beforeEach(() => {
  vi.clearAllMocks();
  queue.get.mockResolvedValue({ ...ROW });
  db.query.mockImplementation(async () => []);
});

describe("who may approve", () => {
  it("reads the approvers from the client's config; a client without a list gets no buttons", () => {
    expect(loadApprovers("3-percent-east-coast")).toEqual([MARK, JACOB]);
    expect(loadApprovers("matama-floors")).toEqual([]);
    expect(loadApprovers("no-such-client")).toEqual([]);
    expect(canApproveFromSlack("3-percent-east-coast", "adset")).toBe(true);
    expect(canApproveFromSlack("3-percent-east-coast", "creative")).toBe(false);
    expect(canApproveFromSlack("matama-floors", "adset")).toBe(false);
  });

  it("builds a Pause button (with a confirm step) and a Keep running button that both carry the flag id", () => {
    const blocks = flagBlocks("text", 7, "adset");
    const [pause, keep] = blocks[1].elements;
    expect(pause).toMatchObject({ action_id: PAUSE_ACTION_ID, value: "7", style: "danger" });
    expect(pause.text.text).toBe("Pause this ad set");
    expect(pause.confirm).toBeTruthy();
    expect(keep).toMatchObject({ action_id: KEEP_ACTION_ID, value: "7" });
  });
});

describe("pressing Pause", () => {
  it("pauses the ad set through the executor as that person, and closes the flag", async () => {
    db.query.mockImplementation(async (...a: unknown[]) => (/UPDATE ad_pending_actions SET status/.test(String(a[0])) ? [{ id: 7 }] : []));
    const d = deps();
    const out = await handleApprovalClick(PAUSE_ACTION_ID, 7, JACOB, d);
    expect(executor.executeManual).toHaveBeenCalledWith("pause", "adset", "adset-1", ROW.entity_name, {}, `slack:${JACOB}`, "Slack");
    expect(queue.markExecuted).toHaveBeenCalledWith(7);
    expect(out.replace).toBe(true);
    expect(out.text).toContain(`Paused by <@${JACOB}>`);
  });

  it("refuses anyone who is not an approver, and touches nothing", async () => {
    const out = await handleApprovalClick(PAUSE_ACTION_ID, 7, "Usomeoneelse", deps());
    expect(out.replace).toBe(false);
    expect(out.text).toContain("Only");
    expect(db.query).not.toHaveBeenCalled();
    expect(executor.executeManual).not.toHaveBeenCalled();
  });

  it("does nothing a second time: whoever clicked first wins", async () => {
    db.query.mockImplementation(async () => []); // the claim finds nothing pending
    queue.get.mockResolvedValue({ ...ROW, status: "approved", decided_by: `slack:${MARK}` });
    const out = await handleApprovalClick(PAUSE_ACTION_ID, 7, JACOB, deps());
    expect(executor.executeManual).not.toHaveBeenCalled();
    expect(out.text).toContain(`Already approved by <@${MARK}>`);
  });

  it("says so when it was already paused in Ads Manager, and pauses nothing", async () => {
    db.query.mockImplementation(async () => [{ id: 7 }]);
    const out = await handleApprovalClick(PAUSE_ACTION_ID, 7, MARK, deps("PAUSED"));
    expect(executor.executeManual).not.toHaveBeenCalled();
    expect(out.text).toContain("Already paused");
    expect(queue.markExecuted).toHaveBeenCalled();
  });

  it("reports a failed pause honestly and marks the flag failed", async () => {
    db.query.mockImplementation(async () => [{ id: 7 }]);
    executor.executeManual.mockRejectedValueOnce(new Error("token expired"));
    const out = await handleApprovalClick(PAUSE_ACTION_ID, 7, MARK, deps());
    expect(out.text).toContain("Couldn't pause it: token expired");
    expect(queue.markFailed).toHaveBeenCalledWith(7);
    expect(queue.markExecuted).not.toHaveBeenCalled();
  });
});

describe("pressing Keep running", () => {
  it("dismisses the flag, audits it, and pauses nothing", async () => {
    db.query.mockImplementation(async () => [{ id: 7 }]);
    const out = await handleApprovalClick(KEEP_ACTION_ID, 7, MARK, deps());
    expect(executor.reject).toHaveBeenCalledWith(7, `slack:${MARK}`, "Kept running (Slack)");
    expect(executor.executeManual).not.toHaveBeenCalled();
    expect(out.text).toContain("keeping it running");
  });
});

describe("the 2-hour nudge", () => {
  const post = vi.fn(async (..._a: unknown[]) => {});
  it("asks for rows pending 2h to 24h, and nudges once in the flag's own thread, naming both approvers", async () => {
    db.query.mockImplementation(async (...a: unknown[]) => {
      const sql = String(a[0]);
      if (/SELECT \* FROM ad_pending_actions/.test(sql)) {
        expect((a[1] as string[])[0]).toBe(String(NUDGE_AFTER_HOURS));
        return [{ ...ROW }];
      }
      if (/SET nudged_at/.test(sql)) return [{ id: 7 }];
      return [];
    });
    const sent = await runApprovalNudges(deps("ACTIVE"), post);
    expect(sent).toBe(1);
    const [channel, text, blocks, threadTs] = post.mock.calls[0] as unknown as [string, string, any[], string];
    expect(channel).toBe("C0BPESKGTE1");
    expect(threadTs).toBe("1700000000.000100");
    expect(text).toContain(`<@${MARK}>`);
    expect(text).toContain(`<@${JACOB}>`);
    expect(blocks[1].elements[0].action_id).toBe(PAUSE_ACTION_ID);
  });

  it("closes the flag quietly, with no nudge, when the ad was paused some other way", async () => {
    db.query.mockImplementation(async (...a: unknown[]) => (/SELECT \* FROM ad_pending_actions/.test(String(a[0])) ? [{ ...ROW }] : []));
    expect(await runApprovalNudges(deps("PAUSED"), post)).toBe(0);
    expect(post).not.toHaveBeenCalled();
    expect(db.query.mock.calls.some((c) => /status = 'expired'/.test(String(c[0])))).toBe(true);
  });

  it("waits and tries again when Meta can't be read, rather than nag about something that may be off", async () => {
    db.query.mockImplementation(async (...a: unknown[]) => (/SELECT \* FROM ad_pending_actions/.test(String(a[0])) ? [{ ...ROW }] : []));
    expect(await runApprovalNudges(deps(null), post)).toBe(0);
    expect(db.query.mock.calls.some((c) => /SET nudged_at/.test(String(c[0])))).toBe(false);
  });

  it("never nudges twice: a lost claim sends nothing", async () => {
    db.query.mockImplementation(async (...a: unknown[]) => (/SELECT \* FROM ad_pending_actions/.test(String(a[0])) ? [{ ...ROW }] : []));
    expect(await runApprovalNudges(deps("ACTIVE"), post)).toBe(0);
  });

  it("skips a client with no approvers", async () => {
    db.query.mockImplementation(async (...a: unknown[]) => (/SELECT \* FROM ad_pending_actions/.test(String(a[0])) ? [{ ...ROW, client_id: "matama-floors" }] : []));
    expect(await runApprovalNudges(deps("ACTIVE"), post)).toBe(0);
  });
});

describe("the Slack button route", () => {
  const payload = (actionId: string, extra: Record<string, unknown> = {}) => ({
    type: "block_actions",
    user: { id: JACOB },
    response_url: "https://hooks.slack.com/actions/abc",
    actions: [{ action_id: actionId, value: "7" }],
    ...extra,
  });

  it("replaces the flag with the outcome after a press", async () => {
    const click = vi.fn(async () => ({ text: "paused", replace: true }));
    const respond = vi.fn(async () => {});
    await handleForgeInteraction(payload(PAUSE_ACTION_ID), { click, respond });
    expect(click).toHaveBeenCalledWith(PAUSE_ACTION_ID, 7, JACOB);
    expect(respond).toHaveBeenCalledWith("https://hooks.slack.com/actions/abc", expect.objectContaining({ replace_original: true, text: "paused" }));
  });

  it("answers a refusal only to the person who pressed it, leaving the flag as it was", async () => {
    const respond = vi.fn(async () => {});
    await handleForgeInteraction(payload(PAUSE_ACTION_ID), { click: async () => ({ text: "Only approvers", replace: false }), respond });
    expect(respond).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ response_type: "ephemeral", replace_original: false }));
  });

  it("ignores other buttons, other payload types and malformed values", async () => {
    const click = vi.fn();
    await handleForgeInteraction(payload("some_other_button"), { click, respond: vi.fn() });
    await handleForgeInteraction({ type: "view_submission" }, { click, respond: vi.fn() });
    await handleForgeInteraction({ ...payload(PAUSE_ACTION_ID), actions: [{ action_id: PAUSE_ACTION_ID, value: "abc" }] }, { click, respond: vi.fn() });
    expect(click).not.toHaveBeenCalled();
  });
});
