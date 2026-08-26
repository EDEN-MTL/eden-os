import { describe, expect, it } from "vitest";
import { speakable } from "./speakable";

describe("speakable", () => {
  it("drops the markdown that would otherwise be read as symbol names", () => {
    expect(speakable("**Scout** is _running_ and `idle`")).toBe("Scout is running and idle");
  });

  it("turns bullets into sentences instead of pauses", () => {
    const out = speakable("Status:\n- Scout is live\n- Iris is in build\n- Atlas is idle");
    expect(out).not.toMatch(/[-•*]/);
    expect(out).toContain("Scout is live");
    expect(out).toContain("Atlas is idle");
  });

  it("collapses blank lines, which are the main source of dead air", () => {
    // A paragraph break otherwise becomes a multi-second gap mid-answer.
    expect(speakable("First point.\n\n\nSecond point.")).toBe("First point. Second point.");
  });

  it("reads an em-dash as a comma rather than a long stop", () => {
    expect(speakable("Spend is up — leads are flat")).toBe("Spend is up, leads are flat");
  });

  it("keeps a link's label and never reads the address", () => {
    expect(speakable("See [the dashboard](https://eden-command-ui.onrender.com/)")).toBe("See the dashboard");
    expect(speakable("Go to https://edenmtl.com/get-started/ now")).toBe("Go to link now");
  });

  it("says a code block exists rather than reciting it", () => {
    const out = speakable("Run this:\n```bash\nnpm run dev\n```\nThen reload.");
    expect(out).toContain("Code block omitted");
    expect(out).not.toContain("npm run dev");
  });

  it("voices arrows", () => {
    expect(speakable("Scout → Iris")).toBe("Scout to Iris");
  });

  /**
   * Position decides the meaning. As a list marker the tick is redundant —
   * "✓ Verified" spoken as "yes Verified" is just wrong. Mid-sentence it IS
   * the verb, so dropping it would invert what was said.
   */
  it("drops a tick or cross used as a list marker", () => {
    expect(speakable("✓ Verified")).toBe("Verified");
    expect(speakable("✗ Budget unset")).toBe("Budget unset");
  });

  it("still voices a tick or cross used mid-sentence", () => {
    expect(speakable("Pixel ✓ but budget ✗")).toBe("Pixel yes but budget no");
  });

  it("does not leave a colon stranded before a generated full stop", () => {
    expect(speakable("Two things need you:\n- Fix the pixel")).toBe("Two things need you: Fix the pixel");
  });

  it("strips headings to plain sentences", () => {
    expect(speakable("## Where things stand\nAll good.")).toBe("Where things stand. All good.");
  });

  /**
   * Left deliberately untouched: ElevenLabs already reads these correctly and
   * rewriting them by hand makes the delivery worse.
   */
  it("leaves currency, percentages and decimals alone", () => {
    expect(speakable("Spend was $1,956.02 at a 2.61% CTR")).toBe("Spend was $1,956.02 at a 2.61% CTR");
  });

  it("removes emoji", () => {
    expect(speakable("Deployed 🚀 and verified ✅")).toBe("Deployed and verified");
  });

  it("survives empty and whitespace-only input", () => {
    expect(speakable("")).toBe("");
    expect(speakable("\n\n  \n")).toBe("");
  });

  it("handles a realistic reply end to end", () => {
    const reply = [
      "## Campaign status",
      "",
      "The campaign is **paused** at $50/day.",
      "",
      "- Pixel is in the form iframe — not the parent page",
      "- Budget is CBO, set at campaign level",
      "",
      "See [Ads Manager](https://adsmanager.facebook.com) → Ad sets.",
    ].join("\n");
    const out = speakable(reply);
    expect(out).not.toMatch(/[*#\[\]|`—→]/);
    expect(out).not.toContain("http");
    expect(out).toContain("$50/day");
    expect(out).toContain("Campaign status.");
  });
});
