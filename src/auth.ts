import { homedir } from 'node:os';
import { join } from 'node:path';
import { McpToolError, expandPath, readEnvVar } from '@chrischall/mcp-utils';
import { SessionStore, TokenManager } from '@chrischall/mcp-utils/session';

const TOKEN_URL = 'https://api.freshbooks.com/auth/oauth/token';
const DEFAULT_REDIRECT_URI = 'https://localhost';
const STORE_KEY = 'freshbooks';

/**
 * Persisted OAuth state.
 *
 * `seededFromEnv` records the refresh token that was in the environment when this
 * store entry was created. FreshBooks rotates refresh tokens on every use, so the
 * stored token is normally *newer* than the one in `.env` and must win. The one
 * exception is a re-bootstrap: the human runs the authorize flow again and pastes a
 * fresh token into the environment. Comparing against `seededFromEnv` is what
 * distinguishes "env is stale, keep using the store" from "env changed, adopt it" —
 * without it, a re-bootstrap would be silently ignored and the account would stay
 * locked out behind a burned token.
 */
export interface FreshbooksSession extends Record<string, unknown> {
  key: string;
  refreshToken: string;
  seededFromEnv: string;
  /** Cached access token. Valid for 12h, so reusing it avoids spending a refresh per restart. */
  accessToken: string;
  expiresAt: number;
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  refreshToken: string;
}

/** Read OAuth config, or return the reason it is unusable (deferred-config-error pattern). */
export function readOAuthConfig(): { config: OAuthConfig } | { error: string } {
  const clientId = readEnvVar('FRESHBOOKS_CLIENT_ID');
  const clientSecret = readEnvVar('FRESHBOOKS_CLIENT_SECRET');
  const refreshToken = readEnvVar('FRESHBOOKS_REFRESH_TOKEN');
  const missing = [
    clientId ? null : 'FRESHBOOKS_CLIENT_ID',
    clientSecret ? null : 'FRESHBOOKS_CLIENT_SECRET',
    refreshToken ? null : 'FRESHBOOKS_REFRESH_TOKEN',
  ].filter((m): m is string => m !== null);

  if (missing.length > 0) {
    return {
      error:
        `FreshBooks is not configured: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} unset. ` +
        'Register an app at https://my.freshbooks.com/#/developer (redirect URI must be HTTPS with no ' +
        'query string, e.g. https://localhost), then run the one-time OAuth bootstrap to obtain ' +
        'a refresh token.',
    };
  }
  return {
    config: {
      clientId: clientId as string,
      clientSecret: clientSecret as string,
      refreshToken: refreshToken as string,
      redirectUri: readEnvVar('FRESHBOOKS_REDIRECT_URI') ?? DEFAULT_REDIRECT_URI,
    },
  };
}

export function defaultStorePath(): string {
  const configured = readEnvVar('FRESHBOOKS_TOKEN_STORE');
  return configured ? expandPath(configured) : join(homedir(), '.freshbooks-mcp', 'session.json');
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  created_at: number;
  expires_in: number;
}

/**
 * Exchange a refresh token for a new access token.
 *
 * FreshBooks requires `client_secret` AND `redirect_uri` on the refresh grant — not just
 * on the initial authorization-code exchange — and takes the payload form-encoded rather
 * than as JSON. A generic OAuth client that omits either field, or sends JSON, gets an
 * opaque `invalid_client`.
 */
export async function exchangeRefreshToken(
  config: OAuthConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'refresh_token',
    redirect_uri: config.redirectUri,
    refresh_token: refreshToken,
  });

  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });

  const raw = await res.text();
  let parsed: Partial<TokenResponse> & { error?: string; error_description?: string };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new McpToolError(`FreshBooks returned a non-JSON token response (HTTP ${res.status}).`, {
      hint: 'This usually means an outage or a proxy in front of the API. Retry shortly.',
    });
  }

  if (!res.ok || typeof parsed.access_token !== 'string') {
    // A rotated refresh token is single-use: once spent it can never be replayed, and
    // there is no way back without the human re-running the authorize flow. Say so
    // explicitly rather than surfacing a bare `invalid_grant`.
    const detail = parsed.error_description ?? parsed.error ?? `HTTP ${res.status}`;
    throw new McpToolError(`FreshBooks refused the refresh token: ${detail}`, {
      hint:
        'FreshBooks refresh tokens are single-use and rotate on every refresh. If this token was ' +
        'already spent (or the stored copy was lost), it cannot be recovered — re-run the OAuth ' +
        'bootstrap to obtain a new one and update FRESHBOOKS_REFRESH_TOKEN.',
    });
  }
  return parsed as TokenResponse;
}

/**
 * Build a TokenManager whose refresh persists the rotated token before returning.
 *
 * The persistence must happen inside the refresh function, not after it: `TokenManager`
 * updates its in-memory token and resolves, and if the process exits before the new token
 * reaches disk, the old one is already burned upstream and the account is locked out. A
 * failed write is therefore fatal rather than best-effort.
 */
export function createTokenManager(
  config: OAuthConfig,
  opts: { storePath?: string; fetchImpl?: typeof fetch } = {},
): TokenManager {
  const store = new SessionStore<FreshbooksSession>({
    filePath: opts.storePath ?? defaultStorePath(),
    keyOf: (s) => s.key,
    normalizeKey: (k) => k,
  });

  const stored = store.get(STORE_KEY);
  // Prefer the stored token: it has rotated past whatever is in the environment. Fall
  // back to the environment when there is no store yet, or when the human re-bootstrapped
  // (env differs from the value this entry was seeded with).
  const useStored = stored !== null && stored.seededFromEnv === config.refreshToken;
  const initialRefresh = useStored ? (stored as FreshbooksSession).refreshToken : config.refreshToken;
  const seededFromEnv = config.refreshToken;

  // Reuse a cached access token while it is still valid. Access tokens last 12 hours,
  // so discarding them on every process start would spend a single-use refresh token
  // per restart — pure churn, and every rotation is another chance to lose the chain.
  const cachedAccess = useStored ? ((stored as FreshbooksSession).accessToken ?? '') : '';
  const cachedExpiry = useStored ? ((stored as FreshbooksSession).expiresAt ?? 0) : 0;

  return new TokenManager({
    initial: { accessToken: cachedAccess, refreshToken: initialRefresh, expiresAt: cachedExpiry },
    refresh: async (refreshToken: string) => {
      const tok = await exchangeRefreshToken(config, refreshToken, opts.fetchImpl ?? fetch);
      const expiresAt = (tok.created_at + tok.expires_in) * 1000;
      try {
        store.add({
          key: STORE_KEY,
          refreshToken: tok.refresh_token,
          seededFromEnv,
          accessToken: tok.access_token,
          expiresAt,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new McpToolError(`Refreshed the FreshBooks token but could not persist it: ${detail}`, {
          hint:
            'The previous refresh token is now spent, so losing the new one locks the account out. ' +
            'Fix the token store path/permissions and re-run the OAuth bootstrap.',
        });
      }
      return { accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt };
    },
  });
}
