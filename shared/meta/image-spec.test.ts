import { describe, expect, it } from "vitest";
import { ImageSpecError, MAX_FILE_SIZE_BYTES, validateImageBytes } from "./image-spec";

function makePng(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = Buffer.alloc(25);
  header.writeUInt32BE(13, 0); // IHDR chunk length
  header.write("IHDR", 4, "ascii");
  header.writeUInt32BE(width, 8);
  header.writeUInt32BE(height, 12);
  header[16] = 8; // bit depth
  header[17] = 2; // color type
  return Buffer.concat([signature, header]);
}

function makeJpeg(width: number, height: number): Buffer {
  // SOI, then a minimal SOF0 segment carrying height/width, nothing else —
  // enough for the dimension reader, not a real decodable image.
  const sof0 = Buffer.alloc(9);
  sof0[0] = 0xff;
  sof0[1] = 0xc0;
  sof0.writeUInt16BE(8, 2); // segment length (excludes marker, includes itself)
  sof0[4] = 8; // precision
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof0]);
}

describe("validateImageBytes", () => {
  it("accepts a valid PNG at/above the minimum size", () => {
    const result = validateImageBytes(makePng(1200, 628), "test.png");
    expect(result).toMatchObject({ width: 1200, height: 628, format: "PNG" });
    expect(result.warnings).toHaveLength(0);
  });

  it("accepts a valid JPEG", () => {
    const result = validateImageBytes(makeJpeg(1200, 628), "test.jpg");
    expect(result).toMatchObject({ width: 1200, height: 628, format: "JPEG" });
  });

  it("rejects a file over the size limit", () => {
    const oversized = Buffer.concat([makePng(1200, 628), Buffer.alloc(MAX_FILE_SIZE_BYTES)]);
    expect(() => validateImageBytes(oversized, "huge.png")).toThrow(ImageSpecError);
  });

  it("rejects an image below the minimum dimensions", () => {
    expect(() => validateImageBytes(makePng(400, 400), "small.png")).toThrow(ImageSpecError);
  });

  it("rejects garbage/non-image bytes without hanging", () => {
    expect(() => validateImageBytes(Buffer.from("not an image"), "fake.png")).toThrow(ImageSpecError);
  });

  it("rejects a truncated/malformed JPEG rather than looping", () => {
    // Starts like a JPEG but the segment length is corrupt (zero) — must
    // fail fast, not spin forever advancing by zero bytes each iteration.
    const malformed = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]);
    expect(() => validateImageBytes(malformed, "bad.jpg")).toThrow(ImageSpecError);
  });

  it("warns (but doesn't reject) an off-spec aspect ratio", () => {
    const result = validateImageBytes(makePng(1000, 1000), "square.png");
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
