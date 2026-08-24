/**
 * Ad image generation via Google's Gemini image model ("Nano Banana").
 *
 * Ported from the standalone Python prototype's app/creative/images.py.
 * Two things about that original are worth preserving verbatim, because
 * both were established empirically against the live API rather than read
 * off a docs page:
 *
 *   1. Google's own image-generation docs page showed a
 *      `client.interactions.create(...)` sample that did not exist in the
 *      shipped SDK. The working path is generateContent with
 *      responseModalities ["TEXT","IMAGE"] plus an imageConfig aspect
 *      ratio, pulling bytes out of `candidate.content.parts[i].inlineData`.
 *      The TS SDK returns inlineData.data as a BASE64 STRING (unlike the
 *      Python SDK, which hands back raw bytes) — decoded here.
 *   2. The model returns JPEG by default despite the "image" naming, so
 *      mimeType is read off the response rather than assumed. Meta accepts
 *      both JPEG and PNG (see shared/meta/image-spec.ts), so this is fine
 *      either way — but don't hardcode ".png" on the output.
 *
 * Also empirically established: Nano Banana renders SHORT, bold, explicitly
 * quoted text cleanly and legibly. The common assumption that AI image
 * models can't be trusted with on-image text does NOT hold here. So text is
 * opt-in per call via `overlayText` rather than blanket-blocked.
 *
 * Re-verify against a real call if generation starts failing — this is a
 * fast-moving API.
 */
import { GoogleGenAI } from "@google/genai";

/**
 * Real-looking photos consistently outperform slick studio shots in ad
 * creative — they read as more trustworthy and less obviously AI-generated.
 */
const PHOTOGRAPHY_DIRECTION =
  "Photography direction: looks like a real photo taken on a phone, handheld, casual " +
  "composition — like someone caught the moment, not a styled brand shoot. Natural, " +
  "slightly imperfect and grainy. No glare, no specular polish on any surface, no " +
  "studio-gloss lighting. Shadows are soft and a little noisy, not clean.";

const NO_TEXT_CONSTRAINT =
  " No text, no words, no letters anywhere in the image — ad copy is added " +
  "separately, so keep the frame clean rather than adding your own text.";

/** Meta's recommended ratio for single-image feed ads. */
export const DEFAULT_ASPECT_RATIO = "4:5";
export const DEFAULT_MODEL = "gemini-3-pro-image-preview";

export class ImageGenerationError extends Error {}

export interface GeneratedImage {
  data: Buffer;
  mimeType: string;
  /** File extension matching mimeType — "jpg" or "png", never assumed. */
  extension: string;
}

export interface ImageGenConfig {
  apiKey: string;
  model?: string;
}

export interface GenerateImageOptions {
  /** Short creative direction — what the image should show. */
  imageBrief: string;
  /**
   * What the business actually does, e.g. "a hardwood floor refinishing
   * company" or "a real estate brokerage". The original hardcoded real
   * estate; now that Eden runs ads across industries this is required, so
   * a floor-sanding ad doesn't inherit real-estate framing.
   */
  businessContext: string;
  aspectRatio?: string;
  /** Renders this exact short phrase in the image. Omit for a clean frame. */
  overlayText?: string;
}

/**
 * Wraps a short creative direction into a fuller structured prompt —
 * composition + photography realism + hard constraints — rather than
 * sending the bare brief. Consistently produces less obviously-AI output.
 * Exported for testing and so callers can preview the exact prompt.
 */
export function buildStructuredPrompt(options: GenerateImageOptions): string {
  const { imageBrief, businessContext, overlayText } = options;

  const textInstruction = overlayText
    ? `\n\nText overlay: render this exact text prominently and legibly, in a bold clean ` +
      `sans-serif font with strong contrast against its background, well-integrated into ` +
      `the composition (not just pasted on): "${overlayText}". Do not add any OTHER text, ` +
      `words, or letters anywhere else in the image.`
    : "";

  const constraints =
    "Constraints: exactly one image. No logos, no watermarks." + (overlayText ? "" : NO_TEXT_CONSTRAINT);

  return (
    `Create one advertising image for ${businessContext.trim()}.\n\n` +
    `Composition: ${imageBrief.trim()}. Leave calm, uncluttered space in the top or ` +
    `bottom third of the frame rather than filling it edge-to-edge.${textInstruction}\n\n` +
    `${PHOTOGRAPHY_DIRECTION}\n\n` +
    `${constraints}`
  );
}

export async function generateImage(
  config: ImageGenConfig,
  options: GenerateImageOptions
): Promise<GeneratedImage> {
  if (!config.apiKey) {
    throw new ImageGenerationError(
      "GEMINI_API_KEY is not set — add it on the Settings page to generate ad images."
    );
  }

  const client = new GoogleGenAI({ apiKey: config.apiKey });
  const prompt = buildStructuredPrompt(options);

  let response;
  try {
    response = await client.models.generateContent({
      model: config.model || DEFAULT_MODEL,
      contents: [prompt],
      config: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio: options.aspectRatio || DEFAULT_ASPECT_RATIO },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ImageGenerationError(`Nano Banana image generation failed: ${message}`);
  }

  for (const candidate of response.candidates || []) {
    for (const part of candidate.content?.parts || []) {
      const inline = part.inlineData;
      if (inline?.data) {
        // TS SDK hands back base64, not raw bytes (differs from the Python SDK).
        const data = Buffer.from(inline.data, "base64");
        const mimeType = inline.mimeType || "image/jpeg";
        return {
          data,
          mimeType,
          extension: mimeType.includes("png") ? "png" : "jpg",
        };
      }
    }
  }

  throw new ImageGenerationError(
    "Nano Banana didn't return an image for this prompt — try rephrasing the image brief."
  );
}
