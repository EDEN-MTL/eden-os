import { describe, expect, it } from "vitest";
import { buildStructuredPrompt, DEFAULT_ASPECT_RATIO } from "./images";

const base = { imageBrief: "a refinished oak floor in a sunlit Montreal apartment", businessContext: "a hardwood floor refinishing company" };

describe("buildStructuredPrompt", () => {
  it("uses the given business context rather than hardcoding an industry", () => {
    const prompt = buildStructuredPrompt(base);
    expect(prompt).toContain("a hardwood floor refinishing company");
    expect(prompt).not.toContain("real estate");
  });

  it("includes the creative brief and photography-realism direction", () => {
    const prompt = buildStructuredPrompt(base);
    expect(prompt).toContain("a refinished oak floor in a sunlit Montreal apartment");
    expect(prompt).toContain("looks like a real photo taken on a phone");
  });

  it("blocks on-image text when no overlay is requested", () => {
    const prompt = buildStructuredPrompt(base);
    expect(prompt).toContain("No text, no words, no letters anywhere in the image");
  });

  it("renders the exact overlay text and drops the no-text constraint when requested", () => {
    const prompt = buildStructuredPrompt({ ...base, overlayText: "50% OFF" });
    expect(prompt).toContain('"50% OFF"');
    expect(prompt).toContain("Do not add any OTHER text");
    // The blanket no-text rule must NOT also be present, or the model gets contradictory instructions.
    expect(prompt).not.toContain("No text, no words, no letters anywhere in the image");
  });

  it("always constrains to a single image with no logos or watermarks", () => {
    for (const prompt of [buildStructuredPrompt(base), buildStructuredPrompt({ ...base, overlayText: "HI" })]) {
      expect(prompt).toContain("exactly one image");
      expect(prompt).toContain("No logos, no watermarks");
    }
  });

  it("trims whitespace from caller-supplied fields", () => {
    const prompt = buildStructuredPrompt({ imageBrief: "  a floor  ", businessContext: "  a shop  " });
    expect(prompt).toContain("for a shop.");
    expect(prompt).toContain("Composition: a floor.");
  });

  it("defaults to Meta's recommended 4:5 feed ratio", () => {
    expect(DEFAULT_ASPECT_RATIO).toBe("4:5");
  });
});
