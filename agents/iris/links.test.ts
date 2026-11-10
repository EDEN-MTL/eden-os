import { afterEach, describe, expect, it, vi } from "vitest";

const ghl = vi.hoisted(() => ({ getGhlConfig: vi.fn() }));
vi.mock("../../shared/ghl", () => ghl);

import { formatLinkLine, ghlContactUrl, linkLineFor, vapiCallUrl } from "./links";

afterEach(() => vi.clearAllMocks());

describe("direct links in Iris's Slack updates", () => {
  it("builds the GHL contact page address", () => {
    expect(ghlContactUrl("t3ypFoQY6EC5lJfj2UYI", "Iws4ju6bAAZZsL9BoOao")).toBe(
      "https://app.gohighlevel.com/v2/location/t3ypFoQY6EC5lJfj2UYI/contacts/detail/Iws4ju6bAAZZsL9BoOao"
    );
  });

  it("builds the Vapi call address from the client's template, and leaves it out when there's no template or no call id", () => {
    expect(vapiCallUrl("01a13a71", "https://dashboard.vapi.ai/calls/{callId}")).toBe("https://dashboard.vapi.ai/calls/01a13a71");
    expect(vapiCallUrl("01a13a71", undefined)).toBeNull();
    expect(vapiCallUrl("01a13a71", "https://dashboard.vapi.ai/calls")).toBeNull(); // no {callId} slot
    expect(vapiCallUrl(null, "https://dashboard.vapi.ai/calls/{callId}")).toBeNull();
  });

  it("formats a Slack link line with only the links that exist", () => {
    expect(formatLinkLine({ vapiUrl: "https://v/1", ghlUrl: "https://g/2" })).toBe("🔗 <https://v/1|Vapi call> · <https://g/2|GHL contact>");
    expect(formatLinkLine({ ghlUrl: "https://g/2" })).toBe("🔗 <https://g/2|GHL contact>");
    expect(formatLinkLine({})).toBe("");
  });

  it("gives both links for a call update and the GHL contact alone for a text update", async () => {
    ghl.getGhlConfig.mockResolvedValue({ locationId: "L1", apiKey: "k" });
    const call = await linkLineFor("c", "contact-9", "call-7", "https://dashboard.vapi.ai/calls/{callId}");
    expect(call).toContain("<https://dashboard.vapi.ai/calls/call-7|Vapi call>");
    expect(call).toContain("<https://app.gohighlevel.com/v2/location/L1/contacts/detail/contact-9|GHL contact>");
    const text = await linkLineFor("c", "contact-9");
    expect(text).toBe("🔗 <https://app.gohighlevel.com/v2/location/L1/contacts/detail/contact-9|GHL contact>");
  });

  it("never throws: no GHL config just means no GHL link", async () => {
    ghl.getGhlConfig.mockRejectedValue(new Error("down"));
    expect(await linkLineFor("c", "contact-9", "call-7", "https://v/{callId}")).toBe("🔗 <https://v/call-7|Vapi call>");
    expect(await linkLineFor("c", null)).toBe("");
  });
});

describe("the real 3% config", () => {
  it("has the Vapi call address Mark copied from the dashboard, with a {callId} slot", async () => {
    const { readFileSync } = await import("fs");
    const cfg = JSON.parse(readFileSync("config/clients/3-percent-east-coast.json", "utf-8"));
    const template: string = cfg.iris.links.vapiCallUrl;
    expect(template).toContain("{callId}");
    expect(vapiCallUrl("01a13c57-fa25-722d-b654-af0bf6f6ae5c", template)).toBe(
      "https://dashboard.vapi.ai/logs?callId=01a13c57-fa25-722d-b654-af0bf6f6ae5c&datePreset=last7d"
    );
  });
});
