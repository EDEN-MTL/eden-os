/**
 * Module 2 — contact enrichment.
 *
 * SCOPE LIMIT, deliberate and load-bearing: this module reads only contact
 * details a business has published about ITSELF — the phone Google lists, and
 * an email printed on the business's own contact page.
 *
 * Do NOT extend this with third-party personal-data enrichment: no owner
 * cellphone lookup, no LinkedIn scraping, no data brokers, no pattern-guessed
 * addresses. Under PIPEDA a business's published general contact details are
 * not personal information, but an identifiable individual's contact details
 * are — and collecting those without consent is a different legal position
 * entirely. The regex below enforces that line in code, not just in comments.
 */
import { ContactEnrichment } from "./types";
import { fetchHomepage } from "./triage";

const CONTACT_PATHS = ["/contact", "/contact-us", "/about", "/contactez-nous", "/nous-joindre"];

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** Role-based local parts: addresses that belong to the business, not a person. */
const ROLE_PREFIXES = [
  "info", "contact", "hello", "bonjour", "sales", "ventes", "admin",
  "office", "bureau", "support", "enquiries", "reception", "shop",
  "orders", "bookings", "rendezvous", "service", "mail", "general",
];

const JUNK_DOMAINS = [
  "example.com", "sentry.io", "wixpress.com", "godaddy.com",
  "squarespace.com", "shopify.com", "wordpress.com", "gravatar.com",
];

/**
 * Decides whether an email may be kept.
 *
 * Two ways to pass: a role-based local part (info@, contact@), or any address
 * on the business's OWN domain — because a two-person shop legitimately uses
 * marie@shopname.com as its published business address, and that is still the
 * business publishing its own contact point.
 *
 * A personal-looking address on a THIRD-party domain (gmail, hotmail, or some
 * unrelated site) is rejected. That is the shape of an individual's personal
 * address, and it is exactly what this module must not collect.
 */
export function isPublishableBusinessEmail(email: string, businessDomain: string | null): boolean {
  const lower = email.toLowerCase();
  const [local, domain] = lower.split("@");
  if (!local || !domain) return false;
  if (JUNK_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return false;
  // Asset filenames routinely lex as emails (e.g. "logo@2x.png").
  if (/\.(png|jpe?g|gif|svg|webp|css|js)$/.test(domain)) return false;

  if (ROLE_PREFIXES.includes(local)) return true;
  if (businessDomain && domain === businessDomain) return true;
  return false;
}

/** Bare registrable host for a site URL, used to test "own domain". */
export function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

export function extractEmails(html: string, businessDomain: string | null): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(EMAIL_RE)) {
    const email = match[0].toLowerCase();
    if (isPublishableBusinessEmail(email, businessDomain)) found.add(email);
  }
  return [...found];
}

/**
 * Looks for a published business email on the site's contact/about pages.
 * Stops at the first page that yields one — there is no value in a second
 * address and every extra fetch is another request at someone else's server.
 */
export async function enrichContact(website: string | null): Promise<ContactEnrichment> {
  const empty: ContactEnrichment = { email: null, emailSource: null, hasPublicEmail: false };
  if (!website) return empty;

  const businessDomain = domainOf(website);
  const base = website.replace(/\/+$/, "");

  for (const path of ["", ...CONTACT_PATHS]) {
    const page = await fetchHomepage(`${base}${path}`, 10000);
    if ("error" in page || !page.ok) continue;

    const emails = extractEmails(page.html, businessDomain);
    if (emails.length > 0) {
      return {
        email: emails[0],
        emailSource: path === "" ? "own_website_homepage" : "own_website_contact_page",
        hasPublicEmail: true,
      };
    }
  }
  return empty;
}
