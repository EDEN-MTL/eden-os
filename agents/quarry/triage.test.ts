import { describe, expect, it } from "vitest";
import {
  applyVisionScore,
  isHighConfidenceCandidate,
  latestCopyrightYear,
  triage,
  triageHtml,
  triageMissingSite,
} from "./triage";

const OPTS = {
  outdatedSignals: ["Google+", "<marquee", "application/x-shockwave-flash"],
  copyrightYearBefore: 2018,
};

const page = (html: string, over: Partial<{ ok: boolean; status: number; finalUrl: string }> = {}) => ({
  ok: true,
  status: 200,
  finalUrl: "https://example.com",
  html,
  ...over,
});

const MODERN = `<html><head><meta name="viewport" content="width=device-width">
  </head><body>© 2026 Shop</body></html>`;

describe("latestCopyrightYear", () => {
  it("returns null when no copyright line exists", () => {
    expect(latestCopyrightYear("<p>no notice here</p>")).toBeNull();
  });

  it("takes the latest year, not the first", () => {
    // A founding date next to a current notice is the common shape. Taking the
    // first match would flag a maintained site as abandoned.
    const html = "<footer>Serving Montreal since &copy; 1972 — Copyright 2025</footer>";
    expect(latestCopyrightYear(html)).toBe(2025);
  });

  it("reads both the entity and symbol forms", () => {
    expect(latestCopyrightYear("&copy; 2011")).toBe(2011);
    expect(latestCopyrightYear("© 2011")).toBe(2011);
    expect(latestCopyrightYear("Copyright 2011")).toBe(2011);
  });
});

describe("triageHtml", () => {
  it("clears a modern, responsive, current site", () => {
    const result = triageHtml(page(MODERN), OPTS);
    expect(result.isCandidate).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it("flags a missing viewport tag", () => {
    const result = triageHtml(page("<html><body>hi</body></html>"), OPTS);
    expect(result.isCandidate).toBe(true);
    expect(result.reasons.join()).toMatch(/viewport/);
  });

  it("flags plain HTTP after redirects are followed", () => {
    // finalUrl, not the input URL — a site that redirects http→https is fine,
    // and one that redirects https→http is not.
    const result = triageHtml(page(MODERN, { finalUrl: "http://example.com" }), OPTS);
    expect(result.reasons).toContain("No HTTPS");
  });

  it("flags a stale copyright year", () => {
    const result = triageHtml(page(MODERN.replace("2026", "2009")), OPTS);
    expect(result.reasons.join()).toMatch(/2009/);
  });

  it("flags configured outdated markup signals case-insensitively", () => {
    const result = triageHtml(page(MODERN + "<MARQUEE>welcome</MARQUEE>"), OPTS);
    expect(result.reasons.join()).toMatch(/marquee/i);
  });

  it("flags a non-200 response", () => {
    const result = triageHtml(page(MODERN, { ok: false, status: 500 }), OPTS);
    expect(result.reasons.join()).toMatch(/500/);
  });
});

describe("triageMissingSite", () => {
  it("qualifies with no fetch at all", () => {
    expect(triageMissingSite().isCandidate).toBe(true);
  });
});

describe("applyVisionScore", () => {
  const clean = { isCandidate: false, reasons: [] as string[] };

  it("qualifies a technically-fine site that looks dated", () => {
    const result = applyVisionScore(clean, 8, "Frames and clip art", 6);
    expect(result.isCandidate).toBe(true);
    expect(result.outdatedScore).toBe(8);
  });

  it("leaves a technically-fine, good-looking site unqualified", () => {
    const result = applyVisionScore(clean, 3, "Clean and current", 6);
    expect(result.isCandidate).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it("never rescues a broken site just because it photographs well", () => {
    // "Looks fine" is irrelevant if it does not load on a phone.
    const broken = { isCandidate: true, reasons: ["No viewport meta tag — not mobile responsive"] };
    const result = applyVisionScore(broken, 1, "Looks great", 6);
    expect(result.isCandidate).toBe(true);
    expect(result.reasons).toContain("No viewport meta tag — not mobile responsive");
  });
});

describe("isHighConfidenceCandidate", () => {
  it("is high confidence for a hard technical fact — no site at all", () => {
    expect(isHighConfidenceCandidate(["No website listed on Google"])).toBe(true);
  });

  it("is high confidence for a broken-HTTPS/mobile finding", () => {
    expect(isHighConfidenceCandidate(["No viewport meta tag — not mobile responsive"])).toBe(true);
  });

  it("is NOT high confidence when the only reason is the vision pass's opinion", () => {
    // This is the exact case the vision path produces on its own — see
    // applyVisionScore, which only ever runs on a site the technical checks
    // already cleared.
    expect(isHighConfidenceCandidate(["Looks dated (8/10)"])).toBe(false);
  });

  it("is high confidence when a hard reason accompanies the vision opinion", () => {
    expect(isHighConfidenceCandidate(["No HTTPS", "Looks dated (7/10)"])).toBe(true);
  });

  it("is not high confidence for an empty reasons list", () => {
    expect(isHighConfidenceCandidate([])).toBe(false);
  });
});

describe("triage — qualifyMissingWebsite", () => {
  it("qualifies a no-website lead by default, same as triageMissingSite", async () => {
    const result = await triage(null, OPTS);
    expect(result).toEqual(triageMissingSite());
  });

  it("does not qualify a no-website lead when qualifyMissingWebsite is false", async () => {
    // Email is the only send channel, and enrichContact can only find a
    // contact email by reading a business's OWN website — a no-website lead
    // would otherwise qualify but never be reachable.
    const result = await triage(null, { ...OPTS, qualifyMissingWebsite: false });
    expect(result).toEqual({ isCandidate: false, reasons: [] });
  });
});
