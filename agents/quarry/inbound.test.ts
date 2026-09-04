import { describe, expect, it } from "vitest";
import { parseAppointmentContactId, parseInboundMessage } from "./inbound";

describe("parseInboundMessage", () => {
  it("reads an inbound SMS reply", () => {
    const parsed = parseInboundMessage({
      contactId: "c1",
      direction: "inbound",
      message: { type: "SMS", body: "yes send it" },
    });
    expect(parsed).toEqual({ contactId: "c1", text: "yes send it", channel: "sms", isInbound: true });
  });

  it("reads an inbound email reply", () => {
    const parsed = parseInboundMessage({
      contactId: "c2",
      direction: "inbound",
      message: { type: "Email", body: "not interested, please remove me" },
    });
    expect(parsed.channel).toBe("email");
    expect(parsed.isInbound).toBe(true);
  });

  it("defaults to NOT inbound when direction is missing", () => {
    // The unreadable case must be the safe one — an outbound echo of our own
    // pitch must never be scored as if the lead said it.
    const parsed = parseInboundMessage({ contactId: "c1", message: { type: "SMS", body: "hi" } });
    expect(parsed.isInbound).toBe(false);
  });

  it("marks an outbound message as not inbound", () => {
    const parsed = parseInboundMessage({
      contactId: "c1",
      direction: "outbound",
      message: { type: "SMS", body: "Hi, this is Jacob..." },
    });
    expect(parsed.isInbound).toBe(false);
  });

  it("falls back through alternate field names GHL might use", () => {
    const parsed = parseInboundMessage({ contact_id: "c3", direction: "inbound", type: "SMS", body: "sure" });
    expect(parsed).toEqual({ contactId: "c3", text: "sure", channel: "sms", isInbound: true });
  });

  it("returns unknown channel rather than guessing", () => {
    const parsed = parseInboundMessage({ contactId: "c1", direction: "inbound", message: { type: "WhatsApp", body: "hi" } });
    expect(parsed.channel).toBe("unknown");
  });

  it("handles a missing or malformed body without throwing", () => {
    expect(parseInboundMessage({}).contactId).toBeNull();
    expect(parseInboundMessage(null).contactId).toBeNull();
    expect(parseInboundMessage(undefined).text).toBeNull();
  });
});

describe("parseAppointmentContactId", () => {
  it("reads contactId out of a workflow Webhook action's customData wrapper", () => {
    expect(parseAppointmentContactId({ customData: { contactId: "c1" } })).toBe("c1");
  });

  it("falls back to a flat body for anything that posts here directly", () => {
    expect(parseAppointmentContactId({ contactId: "c2" })).toBe("c2");
    expect(parseAppointmentContactId({ contact_id: "c3" })).toBe("c3");
  });

  it("prefers customData over a flat field when both are present", () => {
    expect(parseAppointmentContactId({ contactId: "wrong", customData: { contactId: "right" } })).toBe("right");
  });

  it("handles a missing or malformed body without throwing", () => {
    expect(parseAppointmentContactId({})).toBeNull();
    expect(parseAppointmentContactId(null)).toBeNull();
    expect(parseAppointmentContactId(undefined)).toBeNull();
  });
});
