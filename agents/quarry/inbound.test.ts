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

  /**
   * Real payload, captured live 2026-09-25/26 via webhook_debug_log against
   * 3-percent-east-coast's actual "zReply Automation" workflow (Kaitlyn
   * Sheppard replying "Yes!"). This is GHL's own default Webhook-action
   * payload when no Custom Data mapping is configured — a flat dump of the
   * contact's custom fields keyed by their real GHL LABELS, plus workflow
   * metadata and a message object with a NUMERIC type, no direction field
   * anywhere. Every real reply was silently skipped against this shape
   * until fixed. Trimmed to the fields that matter — the real payload also
   * carries dozens of blank custom-field labels irrelevant to parsing.
   */
  function realWorkflowReplyPayload(overrides: Partial<{ contactId: string; text: string; messageType: number }> = {}) {
    return {
      tags: "buyer lead,replied",
      contact_id: overrides.contactId ?? "vpgDkOtpBhFsPnWZcHkb",
      first_name: "Kaitlyn",
      last_name: "Sheppard",
      full_name: "Kaitlyn Sheppard",
      message: { body: overrides.text ?? "Yes!", type: overrides.messageType ?? 2 },
      workflow: { id: "d5987aac-0f98-4538-ae7b-5acbeb831446", name: "zReply Automation" },
      location: { id: "t3ypFoQY6EC5IJfj2UYl", name: "3% Realty East Coast" },
      customData: {},
      "LF Proprety": "",
      "What is your Budget for the New Home?": "",
    };
  }

  it("reads the REAL live GHL workflow-reply shape correctly — contactId, text, channel, and isInbound all resolve with no explicit direction field", () => {
    const parsed = parseInboundMessage(realWorkflowReplyPayload());
    expect(parsed).toEqual({ contactId: "vpgDkOtpBhFsPnWZcHkb", text: "Yes!", channel: "sms", isInbound: true });
  });

  it("reads message.type as a numeric code (2 = SMS), not a string", () => {
    expect(parseInboundMessage(realWorkflowReplyPayload({ messageType: 2 })).channel).toBe("sms");
    expect(parseInboundMessage(realWorkflowReplyPayload({ messageType: 3 })).channel).toBe("email");
  });

  it("does NOT treat an unrelated payload with a bare contact_id + message.body as inbound without the workflow marker", () => {
    // Guards the shape-detection itself from becoming too loose — must
    // stay narrow to this real, confirmed shape, not "any object with a
    // contact_id and a message.body".
    const parsed = parseInboundMessage({ contact_id: "c1", message: { body: "hi", type: 2 } });
    expect(parsed.isInbound).toBe(false);
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
