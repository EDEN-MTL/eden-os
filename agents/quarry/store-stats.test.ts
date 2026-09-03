import { afterEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../shared/db", () => dbMocks);

import { getPipelineStats } from "./store";

afterEach(() => vi.clearAllMocks());

describe("getPipelineStats", () => {
  it("shapes each query result into the right bucket", async () => {
    dbMocks.query
      .mockResolvedValueOnce([{ approval_status: "pending", count: "3" }, { approval_status: "approved", count: "1" }])
      .mockResolvedValueOnce([{ pipeline_stage: "New Lead", count: "2" }, { pipeline_stage: null, count: "2" }])
      .mockResolvedValueOnce([{ qualified: "4", has_mobile: "1", has_email: "3", email_opted_out: "1" }])
      .mockResolvedValueOnce([{ sms_replies: "0", email_replies: "2" }])
      .mockResolvedValueOnce([{ step: "email_pitch", count: "3" }, { step: "screenshot", count: "1" }]);

    const stats = await getPipelineStats();

    expect(stats.byApproval).toEqual({ pending: 3, approved: 1 });
    // A null pipeline_stage must not collide with a real string key or get
    // dropped silently — it is a real, common state ("never synced yet").
    expect(stats.byStage).toEqual({ "New Lead": 2, "(none)": 2 });
    expect(stats.qualified).toBe(4);
    expect(stats.hasMobile).toBe(1);
    expect(stats.hasEmail).toBe(3);
    expect(stats.emailOptedOut).toBe(1);
    expect(stats.emailRepliesTotal).toBe(2);
    // screenshot/link/nudge are the SMS-path steps; anything else is email.
    expect(stats.sentTodaySms).toBe(1);
    expect(stats.sentTodayEmail).toBe(3);
  });

  it("returns zeros rather than throwing when a client has no leads at all", async () => {
    dbMocks.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ qualified: null, has_mobile: null, has_email: null, email_opted_out: null }])
      .mockResolvedValueOnce([{ sms_replies: null, email_replies: null }])
      .mockResolvedValueOnce([]);

    const stats = await getPipelineStats();
    expect(stats.qualified).toBe(0);
    expect(stats.sentTodaySms).toBe(0);
    expect(stats.sentTodayEmail).toBe(0);
  });
});
