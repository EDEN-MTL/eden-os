import { describe, expect, it } from "vitest";
import { isValidClientId } from "./clients-api";

describe("isValidClientId", () => {
  it.each(["eden", "matama-floors", "3-percent-east-coast", "a", "9"])("accepts %j", (id) => {
    expect(isValidClientId(id)).toBe(true);
  });

  it.each([
    "../../etc/passwd",
    "..%2f..%2fetc%2fpasswd",
    "-leading-hyphen",
    "Has-Uppercase",
    "has space",
    "has/slash",
    "has.dot",
    "",
    "has_underscore",
  ])("rejects %j", (id) => {
    // Real failure mode this guards against: clientId becomes a filename
    // in POST /clients, and path.join normalizes ".." rather than
    // rejecting it — this regex is the only thing standing between an
    // arbitrary clientId and writing outside config/clients/ entirely.
    expect(isValidClientId(id)).toBe(false);
  });
});
