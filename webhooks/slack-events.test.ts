import crypto from "crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("../shared/slack", () => ({ getSigningSecret: vi.fn() }));
vi.mock("../agents/eden-brain", () => ({ edenBrain: {} }));
vi.mock("../agents/scout", () => ({ scoutAgent: {} }));
vi.mock("../agents/iris", () => ({ irisAgent: {} }));
vi.mock("../agents/atlas", () => ({ atlasAgent: {} }));
vi.mock("../agents/ember", () => ({ emberAgent: {} }));
vi.mock("../agents/muse", () => ({ museAgent: {} }));
vi.mock("../agents/forge", () => ({ forgeAgent: {} }));
vi.mock("../agents/lens", () => ({ lensAgent: {} }));
vi.mock("../agents/nova", () => ({ novaAgent: {} }));

import { verifySlackSignature } from "./slack-events";

const SECRET = "test-signing-secret";

function fakeRequest(overrides: { timestamp?: string; signature?: string; rawBody?: Buffer }) {
  return {
    headers: {
      "x-slack-request-timestamp": overrides.timestamp,
      "x-slack-signature": overrides.signature,
    },
    rawBody: overrides.rawBody,
    body: {},
  } as any;
}

function realSignature(timestamp: string, rawBody: Buffer, secret = SECRET) {
  const sigBaseString = `v0:${timestamp}:${rawBody.toString("utf8")}`;
  return "v0=" + crypto.createHmac("sha256", secret).update(sigBaseString).digest("hex");
}

describe("verifySlackSignature", () => {
  it("returns true for a correctly computed signature", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = Buffer.from(JSON.stringify({ hello: "world" }));
    const signature = realSignature(timestamp, rawBody);

    expect(verifySlackSignature(SECRET, fakeRequest({ timestamp, signature, rawBody }))).toBe(true);
  });

  it("returns false, rather than throwing, when the signature header is a different length than expected", () => {
    // Real bug this guards against: crypto.timingSafeEqual throws a
    // RangeError on a byte-length mismatch instead of returning false.
    // x-slack-signature is fully attacker-controlled and needs no secret
    // to send an arbitrary short value — inside an async Express handler
    // that throw became an unhandled promise rejection, which crashes the
    // whole process on this Node version (no global handler catches it).
    // A pre-auth denial-of-service against every agent's webhook route.
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = Buffer.from(JSON.stringify({ hello: "world" }));

    expect(() =>
      verifySlackSignature(SECRET, fakeRequest({ timestamp, signature: "short", rawBody }))
    ).not.toThrow();
    expect(verifySlackSignature(SECRET, fakeRequest({ timestamp, signature: "short", rawBody }))).toBe(false);
  });

  it("returns false for a same-length but incorrect signature", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = Buffer.from(JSON.stringify({ hello: "world" }));
    const wrongSignature = realSignature(timestamp, rawBody, "a-completely-different-secret");

    expect(verifySlackSignature(SECRET, fakeRequest({ timestamp, signature: wrongSignature, rawBody }))).toBe(false);
  });

  it("returns false when the timestamp or signature header is missing", () => {
    expect(verifySlackSignature(SECRET, fakeRequest({ signature: "v0=abc" }))).toBe(false);
    expect(verifySlackSignature(SECRET, fakeRequest({ timestamp: String(Math.floor(Date.now() / 1000)) }))).toBe(
      false
    );
  });

  it("returns false for a timestamp older than 5 minutes (replay protection)", () => {
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600);
    const rawBody = Buffer.from(JSON.stringify({ hello: "world" }));
    const signature = realSignature(staleTimestamp, rawBody);

    expect(verifySlackSignature(SECRET, fakeRequest({ timestamp: staleTimestamp, signature, rawBody }))).toBe(false);
  });
});
