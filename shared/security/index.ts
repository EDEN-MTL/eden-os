import crypto from "crypto";

/**
 * Constant-time comparison for secrets (API keys, tokens) against an
 * incoming header value. Plain `===`/`!==` leaks timing information
 * proportional to how many leading characters match, which is exactly
 * the kind of thing an API-key check shouldn't do. Every dashboard route
 * that gates on DASHBOARD_API_KEY should use this instead of `!==`.
 *
 * crypto.timingSafeEqual itself throws on a byte-length mismatch rather
 * than returning false, so callers can't just hand it two arbitrary
 * strings — the length check here is what makes this safe to call with
 * fully attacker-controlled input.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
