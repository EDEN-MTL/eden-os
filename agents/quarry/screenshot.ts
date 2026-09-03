/**
 * Module 5 — screenshots.
 *
 * Two callers, one module:
 *   1. The MMS preview of the site we built (the image the prospect sees).
 *   2. The prospect's EXISTING site, for the vision pass that catches a page
 *      whose markup is fine and whose design is from 2009.
 *
 * Both need a headless browser; only the first needs a public URL.
 */
import { query } from "../../shared/db";
import { askWithImage } from "../../shared/claude";

export interface CaptureOptions {
  width?: number;
  height?: number;
  /** Above-the-fold only. A full-page shot of a long site is unreadable as MMS. */
  fullPage?: boolean;
  timeoutMs?: number;
}

export interface ScreenshotCapturer {
  capture(url: string, options?: CaptureOptions): Promise<Buffer>;
  close(): Promise<void>;
}

export class BrowserUnavailableError extends Error {
  constructor(cause: string) {
    super(
      `Headless browser unavailable: ${cause}\n` +
        `Quarry needs Playwright's Chromium. Install it with:\n` +
        `  npm i -D playwright && npx playwright install --with-deps chromium\n` +
        `On Render this must run in the build command; on GitHub Actions it is already present.`
    );
    this.name = "BrowserUnavailableError";
  }
}

/**
 * Playwright capturer that reuses ONE browser across a batch.
 *
 * Launching Chromium costs roughly a second; doing it per lead would dominate
 * the runtime of a 50-lead batch for no reason. Each capture still gets its
 * own context so cookies and storage from one prospect's site can never leak
 * into the next one's screenshot.
 *
 * Playwright is imported dynamically and is an OPTIONAL dependency, so the
 * Express API — which never screenshots anything — does not carry a ~400MB
 * browser download for a code path it will not run.
 */
export class PlaywrightCapturer implements ScreenshotCapturer {
  private browser: any = null;

  private async ensureBrowser(): Promise<any> {
    if (this.browser) return this.browser;
    let chromium: any;
    try {
      // Specifier held in a variable so TypeScript cannot resolve it
      // statically. playwright is an OPTIONAL dependency — a literal import
      // makes `tsc` fail wherever it is not installed, which is exactly the
      // environment this code path is designed to degrade gracefully in.
      const specifier = "playwright";
      ({ chromium } = await import(specifier));
    } catch (error) {
      throw new BrowserUnavailableError((error as Error).message);
    }
    this.browser = await chromium.launch({ args: ["--no-sandbox"] });
    return this.browser;
  }

  async capture(url: string, options: CaptureOptions = {}): Promise<Buffer> {
    const { width = 1200, height = 800, fullPage = false, timeoutMs = 20000 } = options;
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 2, // Retina — the image is judged on a phone screen.
      userAgent: "EdenQuarryBot/1.0 (+https://edenmtl.com)",
    });
    const page = await context.newPage();
    try {
      // "networkidle" rather than "load": a prospect's site with a tracking
      // pixel that never settles would hang, and a site whose hero image
      // arrives late would be captured half-blank. This waits for quiet, then
      // gives fonts a beat to swap in — a screenshot caught mid-swap shows
      // fallback type and makes a fine site look broken.
      await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
      await page.waitForTimeout(600);
      return (await page.screenshot({ type: "png", fullPage })) as Buffer;
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

// ─── Storage ───

export interface ImageStore {
  /** Returns a PUBLIC url — GHL's MMS will not accept anything else. */
  put(input: {
    bytes: Buffer;
    leadId: number | null;
    kind: "preview" | "prospect_site";
    contentType?: string;
    clientId?: string;
  }): Promise<string>;
}

/**
 * Stores bytes in Postgres and returns a URL served by this API.
 *
 * See the note on quarry_images in schema.sql for why this rather than a blob
 * vendor, and the volume at which that stops being true.
 */
export class PostgresImageStore implements ImageStore {
  constructor(private readonly publicBaseUrl: string) {
    if (!publicBaseUrl) {
      throw new Error(
        "PUBLIC_BASE_URL is required — an MMS attachment must be a publicly " +
          "reachable absolute URL, and a relative path silently sends as a " +
          "text-only message with no image and no error."
      );
    }
  }

  async put(input: {
    bytes: Buffer;
    leadId: number | null;
    kind: "preview" | "prospect_site";
    contentType?: string;
    clientId?: string;
  }): Promise<string> {
    const rows = await query<{ id: string }>(
      `INSERT INTO quarry_images (client_id, lead_id, kind, content_type, bytes, byte_size)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [
        input.clientId ?? "eden",
        input.leadId,
        input.kind,
        input.contentType ?? "image/png",
        input.bytes,
        input.bytes.byteLength,
      ]
    );
    return `${this.publicBaseUrl.replace(/\/+$/, "")}/api/quarry/images/${rows[0].id}.png`;
  }
}

export async function readImage(
  id: number
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const rows = await query<{ bytes: Buffer; content_type: string }>(
    "SELECT bytes, content_type FROM quarry_images WHERE id = $1",
    [id]
  );
  return rows[0] ? { bytes: rows[0].bytes, contentType: rows[0].content_type } : null;
}

// ─── Vision scoring ───

const VISION_SYSTEM = `You judge how dated a small business's website looks to
a customer visiting it today. You are shown a screenshot of the homepage.

Score 1-10 where:
  1-3  current — could have been built this year
  4-5  slightly behind but perfectly serviceable
  6-7  visibly dated; a customer would notice
  8-10 looks abandoned or built over a decade ago

Judge only what is visible: layout, typography, image quality, colour, spacing,
density, and whether it reads as designed for a phone. A plain site that is
clean and legible is NOT dated — restraint is not age. Small businesses often
have simple sites on purpose, and scoring simplicity as neglect would flag the
wrong prospects.

Respond with JSON only: {"score": <int 1-10>, "reasoning": "<one sentence>"}`;

export interface VisionScore {
  score: number;
  reasoning: string;
}

/**
 * Scores a screenshot. Returns null rather than throwing when the model's
 * answer cannot be read as a score — a lead should be judged on its technical
 * triage alone rather than dropped because a parse failed.
 */
export async function scoreSiteAppearance(screenshot: Buffer): Promise<VisionScore | null> {
  const raw = await askWithImage(
    VISION_SYSTEM,
    "Score this homepage.",
    { data: screenshot, mediaType: "image/png" },
    { maxTokens: 300 }
  );

  // The model is asked for bare JSON but may wrap it in prose or a fence.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const score = Number(parsed.score);
    if (!Number.isFinite(score) || score < 1 || score > 10) return null;
    return { score: Math.round(score), reasoning: String(parsed.reasoning ?? "") };
  } catch {
    return null;
  }
}
