/**
 * Meta access token lifecycle.
 *
 * Meta user/system tokens come in two flavors that matter here:
 *   - Short-lived tokens (from Graph API Explorer, ~1-2 hours) — only
 *     useful as the seed for the exchange below.
 *   - Long-lived tokens (~60 days) — what this app actually runs on. Meta
 *     lets you re-exchange a long-lived token for a fresh 60-day one
 *     *before* it expires, which is how we implement "refresh". Once a
 *     token is fully expired, Meta requires a brand new one obtained
 *     through the OAuth/Explorer flow — there is no way to refresh an
 *     expired token programmatically, so we fail loudly and tell the
 *     operator what to do rather than guessing.
 *
 * State (current token + expiry) is persisted in Postgres (meta_tokens
 * table) so we don't re-exchange on every process start, and so every
 * entrypoint (webhooks, scheduler, dashboard API) shares one token.
 */
import { query } from "../db";

const GRAPH_HOST = "https://graph.facebook.com";
const API_VERSION = "v21.0";

// Refresh proactively once fewer than this many days remain, so a
// scheduled job never gets caught out by an expiring token mid-run.
const REFRESH_MARGIN_DAYS = 7;

export class TokenError extends Error {}

interface TokenState {
  access_token: string;
  expires_at: string | null;
}

export async function exchangeLongLivedToken(
  appId: string,
  appSecret: string,
  shortOrCurrentToken: string
): Promise<{ accessToken: string; expiresAt: Date | null }> {
  const url = new URL(`${GRAPH_HOST}/${API_VERSION}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("fb_exchange_token", shortOrCurrentToken);

  const res = await fetch(url.toString());
  const data: any = await res.json();
  if (!res.ok || !data.access_token) {
    throw new TokenError(`Meta token exchange failed: ${JSON.stringify(data)}`);
  }
  // expires_in is seconds; absent/0 means no expiry (e.g. a system user token)
  const expiresAt = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null;
  return { accessToken: data.access_token, expiresAt };
}

async function loadState(clientId: string): Promise<TokenState | null> {
  const rows = await query<TokenState>(
    "SELECT access_token, expires_at FROM meta_tokens WHERE client_id = $1",
    [clientId]
  );
  return rows[0] ?? null;
}

async function saveState(clientId: string, accessToken: string, expiresAt: Date | null): Promise<void> {
  await query(
    `INSERT INTO meta_tokens (client_id, access_token, token_type, expires_at, refreshed_at)
     VALUES ($1, $2, 'long_lived', $3, now())
     ON CONFLICT (client_id) DO UPDATE SET
       access_token = excluded.access_token,
       expires_at = excluded.expires_at,
       refreshed_at = excluded.refreshed_at`,
    [clientId, accessToken, expiresAt]
  );
}

/**
 * Returns a token guaranteed to be valid for at least REFRESH_MARGIN_DAYS,
 * transparently exchanging/refreshing as needed. This is the only
 * function other modules should call — never read META_ACCESS_TOKEN
 * directly after startup, since it goes stale.
 */
export async function getValidAccessToken(
  appId: string,
  appSecret: string,
  seedAccessToken: string,
  clientId = "eden"
): Promise<string> {
  const state = await loadState(clientId);

  if (!state) {
    console.log("[META AUTH] No persisted token yet — exchanging seed token from env for a long-lived one.");
    const { accessToken, expiresAt } = await exchangeLongLivedToken(appId, appSecret, seedAccessToken);
    await saveState(clientId, accessToken, expiresAt);
    return accessToken;
  }

  if (!state.expires_at) {
    // No expiry (system user token) — nothing to refresh.
    return state.access_token;
  }

  const expiresAt = new Date(state.expires_at);
  const now = new Date();

  if (expiresAt.getTime() <= now.getTime()) {
    throw new TokenError(
      "Meta access token has fully expired and cannot be refreshed programmatically. " +
        "Generate a new token (Graph API Explorer or your OAuth flow), set META_ACCESS_TOKEN, " +
        "then clear the meta_tokens row for this client and retry."
    );
  }

  const marginMs = REFRESH_MARGIN_DAYS * 24 * 60 * 60 * 1000;
  if (expiresAt.getTime() - now.getTime() < marginMs) {
    console.log(`[META AUTH] Token expires ${expiresAt.toISOString()} — refreshing now.`);
    const { accessToken, expiresAt: newExpiresAt } = await exchangeLongLivedToken(appId, appSecret, state.access_token);
    await saveState(clientId, accessToken, newExpiresAt);
    return accessToken;
  }

  return state.access_token;
}
