import { describe, expect, it } from "vitest";
import { parseAttachment } from "./chat-api";

const TINY_PNG_BASE64 = Buffer.from("not really a png, just needs to decode").toString("base64");

describe("parseAttachment", () => {
  it("accepts a supported media type and decodes the base64 payload", () => {
    const attachment = parseAttachment({ data: TINY_PNG_BASE64, mediaType: "image/png", filename: "shot.png" });

    expect(attachment).not.toBeNull();
    expect(attachment!.mediaType).toBe("image/png");
    expect(attachment!.filename).toBe("shot.png");
    expect(attachment!.data.toString()).toBe("not really a png, just needs to decode");
  });

  it("accepts a PDF and tolerates a missing filename", () => {
    const attachment = parseAttachment({ data: TINY_PNG_BASE64, mediaType: "application/pdf" });

    expect(attachment).not.toBeNull();
    expect(attachment!.filename).toBeUndefined();
  });

  it("rejects an unsupported media type", () => {
    expect(parseAttachment({ data: TINY_PNG_BASE64, mediaType: "application/zip" })).toBeNull();
  });

  it("rejects malformed input shapes", () => {
    expect(parseAttachment(null)).toBeNull();
    expect(parseAttachment("just a string")).toBeNull();
    expect(parseAttachment({ mediaType: "image/png" })).toBeNull(); // no data
    expect(parseAttachment({ data: 12345, mediaType: "image/png" })).toBeNull(); // data not a string
  });

  it("rejects an empty decoded payload", () => {
    expect(parseAttachment({ data: "", mediaType: "image/png" })).toBeNull();
  });

  it("rejects a payload over the 8MB decoded-size cap", () => {
    const oversized = Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64");
    expect(parseAttachment({ data: oversized, mediaType: "image/png" })).toBeNull();
  });
});
