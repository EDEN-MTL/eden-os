import { describe, expect, it } from "vitest";
import { findUnansweredCallback } from "./callback-watch";

const NOW = new Date("2026-11-05T19:00:00.000Z");
const HOUR = 3_600_000;
const call = (over: Record<string, unknown> = {}) => ({ id: "call-1", messageType: "TYPE_CALL", direction: "inbound", dateAdded: "2026-11-05T16:55:52.584Z", userId: "u1", meta: { call: { duration: 6, status: "completed" } }, ...over });
const sms = (over: Record<string, unknown>) => ({ id: "s", messageType: "TYPE_SMS", direction: "outbound", status: "delivered", dateAdded: "2026-11-05T17:30:00.000Z", ...over });

describe("findUnansweredCallback", () => {
  it("finds Melanie Petten's 6-second call-back", () => {
    expect(findUnansweredCallback([call()], NOW, 18 * HOUR)).toEqual({ messageId: "call-1", at: Date.parse("2026-11-05T16:55:52.584Z"), durationSeconds: 6 });
  });

  it("is not fooled by the intake automation's texts, which came BEFORE the call or are workflow texts", () => {
    expect(findUnansweredCallback([call(), sms({ source: "workflow" })], NOW, 18 * HOUR)).not.toBeNull();
    expect(findUnansweredCallback([call(), sms({ dateAdded: "2026-11-05T16:50:00.000Z", source: "app" })], NOW, 18 * HOUR)).not.toBeNull();
  });

  it("is answered by a later text from Iris or a teammate, a text from the lead, or a teammate's call", () => {
    expect(findUnansweredCallback([call(), sms({ source: "app" })], NOW, 18 * HOUR)).toBeNull();
    expect(findUnansweredCallback([call(), sms({ userId: "u2" })], NOW, 18 * HOUR)).toBeNull();
    expect(findUnansweredCallback([call(), sms({ direction: "inbound" })], NOW, 18 * HOUR)).toBeNull();
    expect(findUnansweredCallback([call(), call({ id: "out", direction: "outbound", dateAdded: "2026-11-05T18:00:00.000Z" })], NOW, 18 * HOUR)).toBeNull();
  });

  it("ignores a failed text, a real conversation, an old call and a call from the future", () => {
    expect(findUnansweredCallback([call(), sms({ source: "app", status: "failed" })], NOW, 18 * HOUR)).not.toBeNull();
    expect(findUnansweredCallback([call({ meta: { call: { duration: 240 } } })], NOW, 18 * HOUR)).toBeNull();
    expect(findUnansweredCallback([call({ dateAdded: "2026-11-04T10:00:00.000Z" })], NOW, 18 * HOUR)).toBeNull();
    expect(findUnansweredCallback([call({ dateAdded: "2026-11-05T20:00:00.000Z" })], NOW, 18 * HOUR)).toBeNull();
  });

  it("uses the newest call when there are two", () => {
    const found = findUnansweredCallback([call({ id: "a", dateAdded: "2026-11-05T12:00:00.000Z" }), call({ id: "b" })], NOW, 18 * HOUR);
    expect(found?.messageId).toBe("b");
  });
});
