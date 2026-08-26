import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { McpToolError, expandPath, readEnvVar } from '@chrischall/mcp-utils';
import {
  TokenManager,
  createFileStatePersistence,
  type BearerTokens,
  type StatePersistence,
} from '@chrischall/mcp-utils/session';

const TOKEN_URL = 'https://api.freshbooks.com/auth/oauth/token';
const DEFAULT_REDIRECT_URI = 'https://localhost';
const STORE_KEY = 'freshbooks';

/**
 * The LEGACY persisted shape, written by the `SessionStore` this server used
 * before `@chrischall/mcp-utils` 0.17. Retained only so {@link readLegacyStore}
 * can migrate an existing file — nothing writes it any more.
 *
 * `seededFromEnv` recorded the refresh token that was in the environment when
 * the entry was created. FreshBooks rotates refresh tokens on every use, so the
 * stored token is normally *newer* than the one in `.env` and must win; the one
 * exception is a re-bootstrap, where the human pastes a fresh token in and it
 * should be adopted. That comparison now lives in the shared helper as
 * `boundTo`, which binds a record to the credential that seeded it and stores
 * only a salted digest rather than the token itself.
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
 * Read the pre-0.17 on-disk shape: a `SessionStore` JSON ARRAY of records.
 *
 * Load-bearing on upgrade, not a nicety. FreshBooks rotates single-use refresh
 * tokens, so the stored token has rotated PAST the one in the environment and
 * the env copy is long spent. A build that could not read the old file would
 * fall back to that dead token, 400, and strand the account until the human
 * re-ran the OAuth bootstrap — an upgrade that costs access.
 *
 * Returns `null` when the file is absent, already migrated, corrupt, or seeded
 * from a DIFFERENT env token (the human re-bootstrapped, so the env value wins).
 * The next successful refresh rewrites the file in the current format.
 */
function readLegacyStore(filePath: string, envRefreshToken: string): BearerTokens | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!Array.isArray(raw)) return null; // already the current envelope
    const rec = raw.find(
      (r): r is FreshbooksSession =>
        r !== null && typeof r === 'object' && (r as FreshbooksSession).key === STORE_KEY,
    );
    if (rec === undefined || rec.seededFromEnv !== envRefreshToken) return null;
    if (typeof rec.refreshToken !== 'string' || rec.refreshToken === '') return null;
    return {
      accessToken: typeof rec.accessToken === 'string' ? rec.accessToken : '',
      refreshToken: rec.refreshToken,
      expiresAt: typeof rec.expiresAt === 'number' ? rec.expiresAt : 0,
    };
  } catch {
    return null;
  }
}

/** Narrow a stored record to a token pair. */
function isBearerTokens(raw: unknown): raw is BearerTokens {
  if (raw === null || typeof raw !== 'object') return false;
  const t = raw as Partial<BearerTokens>;
  return (
    typeof t.accessToken === 'string' &&
    typeof t.refreshToken === 'string' &&
    t.refreshToken !== '' &&
    typeof t.expiresAt === 'number'
  );
}

/**
 * Build a TokenManager over the shared persistence helpers.
 *
 * Three properties this has to keep, each of which used to be hand-rolled here:
 *
 *  - **The stored token wins over the environment**, because it has rotated past
 *    it — unless the human re-bootstrapped, which `boundTo` now detects (it was
 *    the `seededFromEnv` field) by binding the record to the env token that
 *    seeded it.
 *  - **A cached access token is reused** while valid. They last 12 hours, so
 *    discarding one per process start would spend a single-use refresh token
 *    per restart — pure churn, and every rotation is another chance to break
 *    the chain.
 *  - **A failed write is FATAL.** `TokenManager` persists the rotated token
 *    before its refresh resolves to any caller, so no request ever runs on a
 *    token that is not on disk; if the write fails, the old token is already
 *    burned upstream and silence would lock the account out. `onPersistError`
 *    throws, and the library wraps it so the failure can never be mistaken for
 *    a revoked credential and trigger a store-clearing recovery.
 */
export function createTokenManager(
  config: OAuthConfig,
  opts: { storePath?: string; fetchImpl?: typeof fetch } = {},
): TokenManager {
  const filePath = opts.storePath ?? defaultStorePath();
  const store = createFileStatePersistence<BearerTokens>({
    filePath,
    // Replaces `seededFromEnv`: the record is bound to the env token that seeded
    // it, so a re-bootstrap discards it. Only a salted digest is written.
    boundTo: config.refreshToken,
    validate: (raw) => (isBearerTokens(raw) ? raw : null),
  });
  // No cast needed since mcp-utils 0.17.1: the file-backed store advertises
  // SyncStatePersistence, so `load()` is already `BearerTokens | null`.
  const loadSync = (): BearerTokens | null =>
    store.load() ?? readLegacyStore(filePath, config.refreshToken);
  const persistence: StatePersistence<BearerTokens> = {
    load: loadSync,
    save: (tokens) => store.save(tokens),
    clear: () => store.clear(),
  };

  // Read here rather than handing TokenManager a bootstrap function: there is no
  // login to defer, and a function form would make the manager persist this
  // placeholder before the first refresh had produced anything worth storing.
  const restored = loadSync();

  return new TokenManager({
    initial: restored ?? { accessToken: '', refreshToken: config.refreshToken, expiresAt: 0 },
    refresh: async (refreshToken: string) => {
      const tok = await exchangeRefreshToken(config, refreshToken, opts.fetchImpl ?? fetch);
      return {
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token,
        expiresAt: (tok.created_at + tok.expires_in) * 1000,
      };
    },
    persistence,
    onPersistError: (err) => {
      const detail = err instanceof Error ? err.message : String(err);
      throw new McpToolError(`Refreshed the FreshBooks token but could not persist it: ${detail}`, {
        hint:
          'The previous refresh token is now spent, so losing the new one locks the account out. ' +
          'Fix the token store path/permissions and re-run the OAuth bootstrap.',
      });
    },
  });
}
