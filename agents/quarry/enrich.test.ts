import { describe, expect, it } from "vitest";
import { domainOf, extractEmails, isPublishableBusinessEmail } from "./enrich";

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
});
