import { describe, expect, it } from "vitest";
import { timingSafeStringEqual } from "./index";

describe("timingSafeStringEqual", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeStringEqual("my-secret-key", "my-secret-key")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(timingSafeStringEqual("my-secret-key", "my-secret-kez")).toBe(false);
  });

  it("returns false, rather than throwing, for strings of different lengths", () => {
    // The whole point: crypto.timingSafeEqual throws RangeError on a
    // byte-length mismatch, so a naive wrapper would crash on the most
    // common attacker input (a short guess, or an empty header value).
    expect(() => timingSafeStringEqual("my-secret-key", "short")).not.toThrow();
    expect(timingSafeStringEqual("my-secret-key", "short")).toBe(false);
    expect(timingSafeStringEqual("short", "my-secret-key")).toBe(false);
    expect(timingSafeStringEqual("", "my-secret-key")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(timingSafeStringEqual("", "")).toBe(true);
  });
});
