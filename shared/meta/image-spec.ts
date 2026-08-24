/**
 * Meta ad image validation — checked BEFORE upload so a bad file fails
 * fast with a clear message instead of after a wasted API round-trip.
 *
 * Figures below are Meta's own current published specs (Meta Business
 * Help Center + Ads Guide, checked August 2026): JPEG or PNG, single-image
 * feed ads recommended at 1200x628 (1.91:1) with a 500x500 minimum,
 * general image ad file size ceiling ~30MB. Re-verify at
 * facebook.com/business/ads-guide if it's been a while — Meta revises
 * these periodically.
 *
 * Only decodes PNG/JPEG headers directly (no third-party library) — the
 * obvious candidate (`image-size`) has an unpatched high-severity DoS
 * (infinite loop parsing malformed ICNS/JXL/HEIF), and we only need the
 * two formats Meta actually accepts anyway. Both parsers below are
 * bounded (fixed max segment count for JPEG) so a malformed file fails
 * fast rather than looping.
 */

export const ALLOWED_FORMATS = new Set(["PNG", "JPEG"]);
export const MAX_FILE_SIZE_BYTES = 30 * 1024 * 1024;
export const MIN_WIDTH = 500;
export const MIN_HEIGHT = 500;
export const RECOMMENDED_ASPECT_RATIO = 1200 / 628; // 1.91:1, single-image feed ads

export class ImageSpecError extends Error {}

export interface ImageSpecResult {
  width: number;
  height: number;
  format: "PNG" | "JPEG";
  warnings: string[];
}

function readPng(buf: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(signature)) return null;
  // IHDR chunk: length(4) + "IHDR"(4) always immediately follows the signature
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function readJpeg(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;

  let offset = 2;
  const maxSegments = 500; // bounded walk — a malformed file fails fast, never loops
  for (let i = 0; i < maxSegments && offset + 4 <= buf.length; i++) {
    if (buf[offset] !== 0xff) return null;
    const marker = buf[offset + 1];

    // Standalone markers with no length/payload (padding, RST, SOI/EOI)
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    const segmentLength = buf.readUInt16BE(offset + 2);
    if (segmentLength < 2) return null; // malformed — never trust a non-advancing length

    const isSofMarker = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSofMarker) {
      const dataStart = offset + 4;
      if (dataStart + 5 > buf.length) return null;
      return { height: buf.readUInt16BE(dataStart + 1), width: buf.readUInt16BE(dataStart + 3) };
    }

    offset += 2 + segmentLength;
  }
  return null;
}

/**
 * Raises ImageSpecError on anything Meta would reject outright. Returns
 * {width, height, format} plus a `warnings` list for things that are
 * allowed but off Meta's recommended spec (e.g. an unusual aspect ratio)
 * — those don't block upload, just surface to the caller so they can decide.
 */
export function validateImageBytes(fileBytes: Buffer, filename: string): ImageSpecResult {
  if (fileBytes.length > MAX_FILE_SIZE_BYTES) {
    throw new ImageSpecError(
      `${filename} is ${(fileBytes.length / 1024 / 1024).toFixed(1)}MB, over Meta's ` +
        `~${(MAX_FILE_SIZE_BYTES / 1024 / 1024).toFixed(0)}MB limit for ad images.`
    );
  }

  const png = readPng(fileBytes);
  const parsed = png ? { ...png, format: "PNG" as const } : (() => {
    const jpeg = readJpeg(fileBytes);
    return jpeg ? { ...jpeg, format: "JPEG" as const } : null;
  })();

  if (!parsed) {
    throw new ImageSpecError(`${filename} doesn't look like a valid PNG or JPEG file.`);
  }
  if (!ALLOWED_FORMATS.has(parsed.format)) {
    throw new ImageSpecError(`${filename} is ${parsed.format}, but Meta ad images must be PNG or JPEG.`);
  }
  if (parsed.width < MIN_WIDTH || parsed.height < MIN_HEIGHT) {
    throw new ImageSpecError(
      `${filename} is ${parsed.width}x${parsed.height}, below Meta's ${MIN_WIDTH}x${MIN_HEIGHT} minimum for ad images.`
    );
  }

  const warnings: string[] = [];
  const actualRatio = parsed.width / parsed.height;
  // Meta recommends different ratios per placement, so a single "correct"
  // ratio doesn't exist: 1.91:1 for link ads, 1:1 and 4:5 for mobile feed,
  // 9:16 for Stories/Reels. Only warn when the image matches NONE of them —
  // warning on 4:5 (which our own generator produces by default, and which
  // Meta explicitly recommends for feed) was misleading.
  const isNearRatio = (target: number) => Math.abs(actualRatio - target) <= 0.15;
  const matchesAKnownPlacement =
    isNearRatio(RECOMMENDED_ASPECT_RATIO) || // 1.91:1 link ads
    isNearRatio(1) ||                        // 1:1 feed
    isNearRatio(4 / 5) ||                    // 4:5 mobile feed
    isNearRatio(9 / 16);                     // 9:16 Stories/Reels
  if (!matchesAKnownPlacement) {
    warnings.push(
      `${parsed.width}x${parsed.height} (ratio ${actualRatio.toFixed(2)}) doesn't match any ratio Meta ` +
        "recommends (1.91:1 link, 1:1 or 4:5 feed, 9:16 Stories/Reels) — it'll still upload, but may get " +
        "cropped unpredictably across placements."
    );
  }

  return { width: parsed.width, height: parsed.height, format: parsed.format, warnings };
}
