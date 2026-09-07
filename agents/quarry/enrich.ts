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

const CONTACT_PATHS = [
  "/contact",
  "/contact-us",
  "/about",
  "/about-us",
  "/team",
  "/staff",
  "/locations",
  "/booking",
  "/contactez-nous",
  "/nous-joindre",
];

// Fixed paths are a guess at where a site keeps its contact info; a link the
// site itself put in its nav or footer is far more likely to hit. Followed
// BEFORE the static guesses below, and capped so a page with a huge nav menu
// can't turn one lead into dozens of fetches.
const LINK_TEXT_RE = /contact|about|team|staff|location|booking|contactez|joindre/i;
const MAX_DISCOVERED_LINKS = 6;
const MAX_TOTAL_EXTRA_FETCHES = 8;

/**
 * Finds same-site links worth following for a contact email, from the site's
 * own nav/footer — e.g. "Contact Us" pointing at /get-in-touch, a slug none
 * of the static guesses above would ever try.
 *
 * Restricted to the SAME host as the page being scanned: this is following a
 * business's own site map, not crawling out to an unrelated domain a footer
 * happens to link to (a payment processor, a review site, etc.).
 */
export function discoverContactLinks(html: string, pageUrl: string): string[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }
  const baseHost = base.hostname.replace(/^www\./, "").toLowerCase();

  const links = new Set<string>();
  const anchorRe = /<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorRe)) {
    const href = match[1];
    if (/^(mailto:|tel:|javascript:)/i.test(href)) continue;
    const text = match[2].replace(/<[^>]+>/g, " ");
    if (!LINK_TEXT_RE.test(href) && !LINK_TEXT_RE.test(text)) continue;

    let resolved: URL;
    try {
      resolved = new URL(href, base);
    } catch {
      continue;
    }
    if (resolved.hostname.replace(/^www\./, "").toLowerCase() !== baseHost) continue;
    resolved.hash = "";
    const url = resolved.toString();
    if (url === base.toString()) continue;
    links.add(url);
    if (links.size >= MAX_DISCOVERED_LINKS) break;
  }
  return [...links];
}

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
 * Looks for a published business email on the homepage, then the site's own
 * discovered contact/about links, then a fixed list of common path guesses.
 * Stops at the first page that yields one — there is no value in a second
 * address and every extra fetch is another request at someone else's server.
 */
export async function enrichContact(website: string | null): Promise<ContactEnrichment> {
  const empty: ContactEnrichment = { email: null, emailSource: null, hasPublicEmail: false };
  if (!website) return empty;

  const businessDomain = domainOf(website);
  const base = website.replace(/\/+$/, "");

  const homepage = await fetchHomepage(base, 10000);
  if (!("error" in homepage) && homepage.ok) {
    const emails = extractEmails(homepage.html, businessDomain);
    if (emails.length > 0) {
      return { email: emails[0], emailSource: "own_website_homepage", hasPublicEmail: true };
    }
  }

  const discovered =
    !("error" in homepage) && homepage.ok
      ? discoverContactLinks(homepage.html, homepage.finalUrl || base)
      : [];

  const candidates = [
    ...discovered.map((url) => ({ url, source: "own_website_discovered_link" })),
    ...CONTACT_PATHS.map((path) => ({ url: `${base}${path}`, source: "own_website_contact_page" })),
  ];

  const checked = new Set([base, ...(!("error" in homepage) ? [homepage.finalUrl] : [])]);
  let fetched = 0;
  for (const { url, source } of candidates) {
    if (checked.has(url)) continue;
    checked.add(url);
    if (fetched >= MAX_TOTAL_EXTRA_FETCHES) break;
    fetched += 1;

    const page = await fetchHomepage(url, 10000);
    if ("error" in page || !page.ok) continue;

    const emails = extractEmails(page.html, businessDomain);
    if (emails.length > 0) {
      return { email: emails[0], emailSource: source, hasPublicEmail: true };
    }
  }
  return empty;
}
