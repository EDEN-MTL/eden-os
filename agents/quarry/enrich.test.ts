import { afterEach, describe, expect, it, vi } from "vitest";

const triageMod = vi.hoisted(() => ({ fetchHomepage: vi.fn() }));
vi.mock("./triage", () => triageMod);

import {
  discoverContactLinks,
  domainOf,
  enrichContact,
  extractEmails,
  isPublishableBusinessEmail,
} from "./enrich";

afterEach(() => vi.clearAllMocks());

/**
 * These tests guard a legal boundary, not just a parsing rule. The module is
 * scoped to contact details a business published about itself; an identifiable
 * individual's personal address is a different category of data under PIPEDA
 * and must not be collected here.
 */
describe("isPublishableBusinessEmail", () => {
  it("accepts role-based addresses on any domain", () => {
    expect(isPublishableBusinessEmail("info@shop.ca", "shop.ca")).toBe(true);
    expect(isPublishableBusinessEmail("bonjour@fleuriste.qc.ca", null)).toBe(true);
  });

  it("accepts a personal-looking address on the business's OWN domain", () => {
    // A two-person shop publishing marie@shopname.com is the business
    // publishing its own contact point.
    expect(isPublishableBusinessEmail("marie@shopname.com", "shopname.com")).toBe(true);
  });

  it("rejects a personal address on a third-party domain", () => {
    // This is the shape the module exists to refuse.
    expect(isPublishableBusinessEmail("marie.tremblay@gmail.com", "shopname.com")).toBe(false);
    expect(isPublishableBusinessEmail("jsmith@someothersite.com", "shopname.com")).toBe(false);
  });

  it("rejects platform and vendor noise", () => {
    expect(isPublishableBusinessEmail("noreply@wixpress.com", "shop.ca")).toBe(false);
    expect(isPublishableBusinessEmail("x@sentry.io", "shop.ca")).toBe(false);
  });

  it("rejects asset filenames that lex as emails", () => {
    // "logo@2x.png" matches a naive email regex.
    expect(isPublishableBusinessEmail("logo@2x.png", "shop.ca")).toBe(false);
  });
});

describe("domainOf", () => {
  it("strips www and lowercases", () => {
    expect(domainOf("https://WWW.Shop.CA/contact")).toBe("shop.ca");
  });

  it("returns null for an unparseable URL", () => {
    expect(domainOf("not a url")).toBeNull();
  });
});

describe("extractEmails", () => {
  it("keeps only publishable addresses and dedupes", () => {
    const html = `
      <a href="mailto:info@shop.ca">info@shop.ca</a>
      <a href="mailto:INFO@shop.ca">again</a>
      <img src="logo@2x.png">
      owner personal: marie@gmail.com
      <script>Sentry.init("x@sentry.io")</script>`;
    expect(extractEmails(html, "shop.ca")).toEqual(["info@shop.ca"]);
  });

  it("finds an email embedded in JSON-LD structured data", () => {
    // Confirms existing behavior rather than adding new logic: the regex
    // scans raw HTML, so an email inside a <script type="application/ld+json">
    // block is already caught — many small-business sites publish their
    // contact email only in this schema.org markup, not visible page text.
    const html = `<script type="application/ld+json">
      {"@type":"LocalBusiness","name":"Shop","email":"info@shop.ca"}
      </script>`;
    expect(extractEmails(html, "shop.ca")).toEqual(["info@shop.ca"]);
  });
});

describe("discoverContactLinks", () => {
  it("finds a same-host link whose text names a contact page", () => {
    const html = `<nav><a href="/get-in-touch">Contact Us</a></nav>`;
    expect(discoverContactLinks(html, "https://shop.ca/")).toEqual(["https://shop.ca/get-in-touch"]);
  });

  it("finds a same-host link whose href (not text) suggests a contact page", () => {
    const html = `<a href="/our-team">Meet Everyone</a>`;
    expect(discoverContactLinks(html, "https://shop.ca/")).toEqual(["https://shop.ca/our-team"]);
  });

  it("ignores mailto, tel, javascript, and hash-only hrefs", () => {
    const html = `
      <a href="mailto:info@shop.ca">Contact</a>
      <a href="tel:+15551234567">Contact</a>
      <a href="javascript:void(0)">Contact</a>
      <a href="#contact">Contact</a>`;
    expect(discoverContactLinks(html, "https://shop.ca/")).toEqual([]);
  });

  it("ignores links to a different host — this maps the site, it doesn't crawl off it", () => {
    const html = `<a href="https://booking-vendor.com/contact">Book Now</a>`;
    expect(discoverContactLinks(html, "https://shop.ca/")).toEqual([]);
  });

  it("ignores a link back to the page itself", () => {
    const html = `<a href="https://shop.ca/">Contact</a>`;
    expect(discoverContactLinks(html, "https://shop.ca/")).toEqual([]);
  });

  it("dedupes and caps at MAX_DISCOVERED_LINKS", () => {
    const html = Array.from({ length: 10 }, (_, i) => `<a href="/contact-${i}">Contact</a>`).join("\n");
    expect(discoverContactLinks(html, "https://shop.ca/")).toHaveLength(6);
  });

  it("returns an empty array for an unparseable page URL", () => {
    expect(discoverContactLinks(`<a href="/contact">Contact</a>`, "not a url")).toEqual([]);
  });
});

describe("enrichContact", () => {
  function page(html: string, opts: { ok?: boolean; finalUrl?: string } = {}) {
    return { ok: opts.ok ?? true, status: 200, finalUrl: opts.finalUrl ?? "https://shop.ca/", html };
  }

  it("returns an empty result without fetching anything when there is no website", async () => {
    const result = await enrichContact(null);
    expect(result).toEqual({ email: null, emailSource: null, hasPublicEmail: false });
    expect(triageMod.fetchHomepage).not.toHaveBeenCalled();
  });

  it("finds an email directly on the homepage and stops there", async () => {
    triageMod.fetchHomepage.mockResolvedValueOnce(page(`<a href="mailto:info@shop.ca">Email</a>`));

    const result = await enrichContact("https://shop.ca");

    expect(result).toEqual({ email: "info@shop.ca", emailSource: "own_website_homepage", hasPublicEmail: true });
    expect(triageMod.fetchHomepage).toHaveBeenCalledTimes(1);
  });

  it("follows a discovered link before trying static path guesses", async () => {
    triageMod.fetchHomepage
      .mockResolvedValueOnce(page(`<a href="/get-in-touch">Contact Us</a>`)) // homepage, no email
      .mockResolvedValueOnce(page(`<a href="mailto:hello@shop.ca">Email</a>`)); // discovered link

    const result = await enrichContact("https://shop.ca");

    expect(result).toEqual({ email: "hello@shop.ca", emailSource: "own_website_discovered_link", hasPublicEmail: true });
    expect(triageMod.fetchHomepage).toHaveBeenCalledTimes(2);
    expect(triageMod.fetchHomepage).toHaveBeenNthCalledWith(2, "https://shop.ca/get-in-touch", 10000);
  });

  it("falls back to a static path guess when no link was discovered", async () => {
    triageMod.fetchHomepage.mockImplementation(async (url: string) => {
      if (url === "https://shop.ca") return page(`<p>no links, no email here</p>`);
      if (url === "https://shop.ca/contact") return page(`<a href="mailto:info@shop.ca">Email</a>`);
      return page("");
    });

    const result = await enrichContact("https://shop.ca");

    expect(result).toEqual({ email: "info@shop.ca", emailSource: "own_website_contact_page", hasPublicEmail: true });
  });

  it("still tries static paths when the homepage fetch itself fails", async () => {
    triageMod.fetchHomepage.mockImplementation(async (url: string) => {
      if (url === "https://shop.ca") return { error: "timeout" };
      if (url === "https://shop.ca/contact") return page(`<a href="mailto:info@shop.ca">Email</a>`);
      return page("");
    });

    const result = await enrichContact("https://shop.ca");

    expect(result).toEqual({ email: "info@shop.ca", emailSource: "own_website_contact_page", hasPublicEmail: true });
  });

  it("gives up and returns empty when nothing is found anywhere", async () => {
    triageMod.fetchHomepage.mockResolvedValue(page(`<p>no email on this whole site</p>`));

    const result = await enrichContact("https://shop.ca");

    expect(result).toEqual({ email: null, emailSource: null, hasPublicEmail: false });
  });

  it("never fetches more than MAX_TOTAL_EXTRA_FETCHES candidate pages beyond the homepage", async () => {
    // 6 discovered links plus the full static path list — without a cap this
    // would fetch well over a dozen pages for one lead.
    const manyLinks = Array.from({ length: 6 }, (_, i) => `<a href="/link-${i}">Contact</a>`).join("\n");
    triageMod.fetchHomepage.mockResolvedValue(page(manyLinks));

    await enrichContact("https://shop.ca");

    // 1 homepage fetch + at most 8 extra candidate fetches.
    expect(triageMod.fetchHomepage.mock.calls.length).toBeLessThanOrEqual(9);
  });
});
