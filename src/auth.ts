import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { EdgeBlockedError, McpToolError, detectEdgeBlock, expandPath, readEnvVar } from '@chrischall/mcp-utils';
import {
  TokenManager,
  createFileStatePersistence,
  withFileLock,
  type BearerTokens,
} from '@chrischall/mcp-utils/session';

const TOKEN_URL = 'https://api.freshbooks.com/auth/oauth/token';
const AUTHORIZE_URL = 'https://auth.freshbooks.com/oauth/authorize/';
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

/**
 * Read the APP credentials only — client id, secret and redirect — without
 * requiring a refresh token.
 *
 * The bootstrap tools need only the app credentials. Normal request paths
 * also need a refresh token, supplied by the environment or a local store.
 *
 * `refreshToken` comes back as `''`. Nothing on this path sends it — the
 * authorization-code grant does not carry one — so an empty string is the
 * honest value rather than a placeholder pretending to be a credential.
 */
export function readBootstrapConfig(): { config: OAuthConfig } | { error: string } {
  const clientId = readEnvVar('FRESHBOOKS_CLIENT_ID');
  const clientSecret = readEnvVar('FRESHBOOKS_CLIENT_SECRET');
  const missing = [
    clientId ? null : 'FRESHBOOKS_CLIENT_ID',
    clientSecret ? null : 'FRESHBOOKS_CLIENT_SECRET',
  ].filter((m): m is string => m !== null);

  if (missing.length > 0) {
    return {
      error:
        `Cannot start the OAuth flow: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} unset. ` +
        'Register an app at https://my.freshbooks.com/#/developer (redirect URI must be HTTPS with no ' +
        'query string, e.g. https://localhost) and set those two. No refresh token is needed — ' +
        'these tools exist to mint one.',
    };
  }
  return {
    config: {
      clientId: clientId as string,
      clientSecret: clientSecret as string,
      refreshToken: '',
      redirectUri: readEnvVar('FRESHBOOKS_REDIRECT_URI') ?? DEFAULT_REDIRECT_URI,
    },
  };
}

/** Read OAuth config, or return the reason it is unusable (deferred-config-error pattern). */
export function readOAuthConfig(opts: { storePath?: string } = {}): { config: OAuthConfig } | { error: string; advice: string } {
  const clientId = readEnvVar('FRESHBOOKS_CLIENT_ID');
  const clientSecret = readEnvVar('FRESHBOOKS_CLIENT_SECRET');
  const refreshToken = readEnvVar('FRESHBOOKS_REFRESH_TOKEN');
  const config: OAuthConfig = {
    clientId: clientId ?? '',
    clientSecret: clientSecret ?? '',
    refreshToken: refreshToken ?? '',
    redirectUri: readEnvVar('FRESHBOOKS_REDIRECT_URI') ?? DEFAULT_REDIRECT_URI,
  };
  // Local authorization saves credentials directly. Hosted connections still
  // receive their seed from the host's secret store through the environment.
  const savedLocalToken = !refreshToken && clientId && clientSecret && !isHosted()
    ? tokenStore(config, opts.storePath ?? defaultStorePath()).load()?.refreshToken
    : undefined;
  const missing = [
    clientId ? null : 'FRESHBOOKS_CLIENT_ID',
    clientSecret ? null : 'FRESHBOOKS_CLIENT_SECRET',
    refreshToken || savedLocalToken ? null : 'FRESHBOOKS_REFRESH_TOKEN',
  ].filter((m): m is string => m !== null);

  if (missing.length > 0) {
    // WHICH credential is missing decides the advice, not just the
    // environment. `recoveryHint()` says "reconnect" when hosted, and
    // reconnecting mints a TOKEN — it cannot supply an app credential. So
    // routing every missing variable through it would answer a missing
    // client id with a connect flow that runs and changes nothing.
    //
    // App credential missing: the operator's to fix, in both environments.
    // Token missing (app credentials present): `recoveryHint()` already
    // branches correctly — reconnect when hosted, the auth tools locally.
    const advice =
      clientId && clientSecret
        ? recoveryHint()
        : readEnvVar('MCP_DATA_DIR')
          ? 'FRESHBOOKS_CLIENT_ID and FRESHBOOKS_CLIENT_SECRET identify the FreshBooks app ' +
            'itself. On a hosted registration they belong to whoever operates it, so this is ' +
            'theirs to fix — reconnecting cannot supply them.'
          : 'Register an app at https://my.freshbooks.com/#/developer (redirect URI must be ' +
            'HTTPS with no query string, e.g. https://localhost) and set its credentials.';
    return {
      error:
        `FreshBooks is not configured: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} unset. ` +
        advice,
      // Returned SEPARATELY so a caller can attach it as a hint WITHOUT
      // re-deriving which case this is. `requireConfig` used to decide that by
      // regex-matching the rendered message for FRESHBOOKS_REFRESH_TOKEN —
      // true whenever the token is merely NAMED among the missing vars — so
      // with an app credential missing too, the message said "reconnecting
      // cannot supply them" while the hint said "Reconnect this connector".
      // One decision, made here, cannot contradict itself.
      advice,
    };
  }
  return { config };
}

/** The existing mcp-host signal; local coding-agent sessions do not set it. */
export function isHosted(): boolean {
  return Boolean(readEnvVar('MCP_DATA_DIR'));
}

export function defaultStorePath(): string {
  const configured = readEnvVar('FRESHBOOKS_TOKEN_STORE');
  return configured ? expandPath(configured) : join(homedir(), '.freshbooks-mcp', 'session.json');
}

/** Reuse the protected, atomic token store for local sign-in and later refreshes. */
function tokenStore(config: OAuthConfig, filePath: string) {
  return createFileStatePersistence<BearerTokens>({
    filePath,
    // Retain the existing binding for env-seeded connections. Local sign-in
    // has no token in the environment, so bind to the app instead. The helper
    // stores only a salted digest of this value, never the app secret itself.
    boundTo: config.refreshToken || `local-oauth:${JSON.stringify([
      config.clientId, config.clientSecret, config.redirectUri,
    ])}`,
    validate: (raw) => (isBearerTokens(raw) ? raw : null),
  });
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  created_at: number;
  expires_in: number;
}

/** Exchange and save a local authorization under the same lock as refreshes. */
export async function authorizeLocally(config: OAuthConfig, code: string): Promise<void> {
  const filePath = defaultStorePath();
  // The same `<store>.lock` the refresh path takes (via the store's withLock).
  await withFileLock(`${filePath}.lock`, async () => {
    const tokens = await exchangeAuthorizationCode(config, code);
    saveLocalAuthorization(config, tokens, filePath);
  });
}

/** Only called while holding the token-store lock. Never returns tokens to MCP. */
function saveLocalAuthorization(config: OAuthConfig, tokens: TokenResponse, filePath: string): void {
  const expiresAt = (tokens.created_at + tokens.expires_in) * 1000;
  if (typeof tokens.created_at !== 'number' || typeof tokens.expires_in !== 'number'
    || !Number.isFinite(expiresAt) || tokens.expires_in <= 0) {
    throw new McpToolError('FreshBooks returned invalid token expiry information. Authorize again.');
  }
  try {
    // An existing env seed can remain configured during reauthorization. Bind
    // the new stored pair to it so the next startup uses the new saved token.
    tokenStore({ ...config, refreshToken: readEnvVar('FRESHBOOKS_REFRESH_TOKEN') ?? '' }, filePath).save({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt,
    });
  } catch {
    throw new McpToolError('FreshBooks authorization succeeded, but its credentials could not be saved.', {
      hint: 'Check the token-store path and permissions, then authorize again with a new code. No token was returned to chat.',
    });
  }
}

/**
 * Exchange a refresh token for a new access token.
 *
 * FreshBooks requires `client_secret` AND `redirect_uri` on the refresh grant — not just
 * on the initial authorization-code exchange — and takes the payload form-encoded rather
 * than as JSON. A generic OAuth client that omits either field, or sends JSON, gets an
 * opaque `invalid_client`.
 */
/**
 * The consent URL a person opens to authorize this app.
 *
 * Carries the client ID and redirect only — never the secret. This URL goes
 * into a browser, so anything in it lands in history and in every proxy along
 * the way; a leaked client secret there would be as bad as leaking the token
 * it protects.
 */
export function authorizeUrl(config: OAuthConfig, state?: string): string {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set('client_id', config.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', config.redirectUri);
  if (state !== undefined) u.searchParams.set('state', state);
  return u.toString();
}

/**
 * OAuth `state` values `freshbooks_auth_url` has handed out, each with its
 * expiry.
 *
 * Binds a consent round-trip to the server that started it. Without one, a
 * socially engineered paste of SOMEONE ELSE's redirect URL would connect this
 * server to their FreshBooks account, and the user's later writes would put
 * customer data into it (fleet-audit#465).
 *
 * Persisted, not just held in memory: on mcp-host the person approves in a
 * browser between the two tool calls, and the per-user child can be evicted
 * and respawned meanwhile. A state that died with the process would refuse an
 * honest login. The file sits under `MCP_DATA_DIR` when hosted and beside the
 * token store locally, is written 0600, and holds only SHA-256 digests — a
 * reader learns nothing it could put in a redirect URL. Memory remains the
 * fallback, so an unwritable file degrades to the single-process behaviour
 * rather than failing the login.
 */
const AUTH_STATE_TTL_MS = 15 * 60_000;
const inMemoryAuthStates = new Map<string, number>();

function authStateFile(): string {
  const dataDir = readEnvVar('MCP_DATA_DIR');
  return dataDir
    ? join(expandPath(dataDir), 'freshbooks-oauth-state.json')
    : `${defaultStorePath()}.oauth-state.json`;
}

function stateDigest(state: string): string {
  return createHash('sha256').update(state).digest('base64url');
}

/** Every unexpired issued state digest, from the file and from memory. */
function loadAuthStates(now: number): Map<string, number> {
  const states = new Map(inMemoryAuthStates);
  try {
    const raw: unknown = JSON.parse(readFileSync(authStateFile(), 'utf8'));
    if (raw && typeof raw === 'object') {
      for (const [digest, expiresAt] of Object.entries(raw)) {
        if (typeof expiresAt === 'number') states.set(digest, expiresAt);
      }
    }
  } catch {
    // Missing or unreadable: memory alone still binds this process's logins.
  }
  for (const [digest, expiresAt] of states) {
    if (expiresAt <= now) states.delete(digest);
  }
  return states;
}

function saveAuthStates(states: Map<string, number>): void {
  inMemoryAuthStates.clear();
  for (const [digest, expiresAt] of states) inMemoryAuthStates.set(digest, expiresAt);
  const file = authStateFile();
  const temp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(temp, JSON.stringify(Object.fromEntries(states)), { mode: 0o600 });
    renameSync(temp, file);
  } catch {
    // Unwritable: fall back to memory (see above) and leave no stray temp file.
    rmSync(temp, { force: true });
  }
}

/** Mint and remember a fresh `state` for one consent URL. */
export function issueAuthState(now: number = Date.now()): string {
  const states = loadAuthStates(now);
  const state = randomBytes(24).toString('base64url');
  states.set(stateDigest(state), now + AUTH_STATE_TTL_MS);
  saveAuthStates(states);
  return state;
}

/** Spend an issued state. False when it was never issued, expired or already used. */
function consumeAuthState(state: string, now: number): boolean {
  const states = loadAuthStates(now);
  if (!states.delete(stateDigest(state))) return false;
  saveAuthStates(states);
  return true;
}

/** Test seam: forget every issued state, in memory and on disk. */
export function resetAuthStatesForTesting(): void {
  inMemoryAuthStates.clear();
  try {
    rmSync(authStateFile(), { force: true });
  } catch {
    // Not a removable file (a test may have planted a directory there).
  }
}

function sameRedirect(url: URL, redirectUri: string): boolean {
  let expected: URL;
  try {
    expected = new URL(redirectUri);
  } catch {
    return false;
  }
  return url.origin === expected.origin && url.pathname === expected.pathname;
}

/**
 * Check what was pasted is the redirect from a consent URL THIS server issued,
 * BEFORE the code is spent at FreshBooks.
 *
 * - It must be the whole redirect URL. A bare code carries no state, so it
 *   cannot be bound and is always refused.
 * - The URL must be this connection's redirect URI (origin and path).
 * - It must carry a state `freshbooks_auth_url` issued, unexpired and unused.
 *   A matched state is consumed (single-use).
 *
 * There is deliberately no "nothing was issued, so let it through" case: the
 * attack in fleet-audit#465 is run against a FRESH session, with a redirect
 * URL the attacker got by opening the public consent URL themselves.
 */
export function verifyAuthorizationResponse(
  input: string,
  config: OAuthConfig,
  now: number = Date.now(),
): void {
  const trimmed = (input ?? '').trim();
  let url: URL | null = null;
  if (trimmed.includes('://')) {
    try {
      url = new URL(trimmed);
    } catch {
      url = null;
    }
  }
  const restart = 'Run freshbooks_auth_url, open the URL it returns, approve, and paste the whole redirect URL you land on.';
  if (url === null) {
    throw new McpToolError(
      'Paste the whole redirect URL, not just the code: its state parameter is what proves the approval came from a consent URL this server issued. Nothing was exchanged.',
      { hint: restart },
    );
  }
  if (!sameRedirect(url, config.redirectUri)) {
    throw new McpToolError(
      `That URL is not this connection's redirect URI (${config.redirectUri}), so it is not a consent response for this server. Nothing was exchanged.`,
      { hint: restart },
    );
  }
  const state = url.searchParams.get('state');
  if (state === null) {
    throw new McpToolError(
      'That redirect URL carries no OAuth state, so it cannot be tied to a consent URL this server issued and may be someone else\'s authorization. Nothing was exchanged.',
      { hint: restart },
    );
  }
  if (!consumeAuthState(state, now)) {
    throw new McpToolError(
      'That redirect URL\'s OAuth state does not match a consent URL this server issued (or it expired, or was already used), so it may be someone else\'s authorization. Nothing was exchanged.',
      { hint: restart },
    );
  }
}

/**
 * Pull the authorization code out of whatever the person pasted.
 *
 * They paste the whole redirect URL far more often than the bare code, because
 * the bare code is the awkward thing to isolate — the browser hands them a URL.
 * A URL carrying no `?code=` is REFUSED rather than passed on as a code: doing
 * the latter spends the exchange and returns FreshBooks' opaque
 * `invalid_grant`, which reads as "your app is misconfigured" instead of "that
 * paste was the error page".
 */
export function extractAuthorizationCode(input: string): string {
  const trimmed = (input ?? '').trim();
  if (!trimmed) throw new McpToolError('No authorization code supplied.', {
    hint: 'Paste either the code itself or the whole redirect URL from the browser.',
  });
  if (!trimmed.includes('://')) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }
  const code = url.searchParams.get('code');
  if (!code) {
    const err = url.searchParams.get('error');
    throw new McpToolError(
      `That URL carries no ?code= parameter${err ? ` (it says error=${err})` : ''}.`,
      { hint: 'Authorize again and paste the URL you land on, which contains ?code=…' },
    );
  }
  return code;
}

/**
 * Exchange an authorization code for tokens — the ONE step that mints a
 * refresh token. Everything afterwards rotates it.
 *
 * Form-encoded, not JSON: that is what FreshBooks' own SDK posts and what the
 * endpoint accepts.
 */
export async function exchangeAuthorizationCode(
  config: OAuthConfig,
  codeOrRedirectUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const code = extractAuthorizationCode(codeOrRedirectUrl);
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'authorization_code',
    redirect_uri: config.redirectUri,
    code,
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
    // A CDN/WAF refusal never reached FreshBooks, so the code was not spent —
    // say so rather than sending the person round the consent flow again.
    throwIfEdgeBlocked(res, raw, 'POST', '/auth/oauth/token');
    throw new McpToolError(`FreshBooks returned a non-JSON token response (HTTP ${res.status}).`, {
      hint: 'Usually an outage or a proxy in front of the API. Authorize again for a new code.',
    });
  }

  if (!res.ok || typeof parsed.access_token !== 'string' || !parsed.access_token) {
    // Never echo token-endpoint bodies or free-form descriptions into MCP
    // results: even a malformed/error response may contain credentials.
    const knownErrors = ['invalid_request', 'invalid_client', 'invalid_grant',
      'unauthorized_client', 'unsupported_grant_type', 'invalid_scope'];
    const detail = typeof parsed.error === 'string' && knownErrors.includes(parsed.error)
      ? parsed.error : `HTTP ${res.status}`;
    // An authorization code is SINGLE-USE. Saying so is the difference between
    // a person authorizing again and a person retrying a spent code forever.
    throw new McpToolError(`FreshBooks refused the authorization code: ${detail}`, {
      hint:
        'An authorization code is single-use and short-lived — this one is now spent, ' +
        'whether or not it was valid. Open the consent URL again and exchange the NEW code.',
    });
  }

  if (typeof parsed.refresh_token !== 'string' || !parsed.refresh_token) {
    throw new McpToolError('FreshBooks returned no refresh token for that code.', {
      hint: 'Without a refresh token the connection cannot outlive the access token. Authorize again.',
    });
  }

  return parsed as TokenResponse;
}

/**
 * What to do when the refresh token is spent — and it differs by where this is
 * running, which the old single message got wrong.
 *
 * A hosted registration has no shell to export into and no server to restart,
 * and the value the child receives comes from a principal secret the person
 * cannot edit from a chat. Telling them to "update FRESHBOOKS_REFRESH_TOKEN"
 * there costs a manual bootstrap whose result has nowhere to go — which is
 * exactly the detour it caused before this existed.
 *
 * `MCP_DATA_DIR` is the signal: mcp-host sets it (alongside HOME) for a
 * registration with `dataDir`, and nothing local does.
 */
export function recoveryHint(): string {
  const shared =
    'FreshBooks refresh tokens are single-use and rotate on every refresh, so a spent ' +
    'or lost token cannot be recovered — a new one has to be minted. ';
  if (isHosted()) {
    return (
      shared +
      'Reconnect this connector: the connect flow opens the FreshBooks consent page, takes the ' +
      'URL you land on, and stores the new token for you. Do not try to set ' +
      'FRESHBOOKS_REFRESH_TOKEN yourself — the connector supplies it.'
    );
  }
  return (
    shared +
    'Call freshbooks_auth_url, approve in the browser, then pass the URL you land on to ' +
    'freshbooks_auth_exchange. It saves the credentials privately; restart the local MCP server ' +
    'after it reports success. No FRESHBOOKS_REFRESH_TOKEN needs to be copied into chat or configuration.'
  );
}

/**
 * Advice for a variable the connector's OWNER sets on the registration, as
 * distinct from a credential the caller can recover.
 *
 * It lives here beside `recoveryHint()` for the same reason that one does:
 * this file is the single place that knows whether it is running hosted, and a
 * second copy of that test is how the advice drifts. But it is deliberately
 * NOT `recoveryHint()` — reconnecting mints a credential and cannot conjure a
 * business membership, so sending someone round the connect flow over this
 * would be a loop.
 */
export function ownerSetHint(name: string): string {
  if (readEnvVar('MCP_DATA_DIR')) {
    return (
      `${name} is set on the registration by whoever owns this connector — not from a chat, ` +
      'and not by you. Ask them to add it.'
    );
  }
  return `Set ${name} explicitly if you know it.`;
}

/**
 * Throw {@link EdgeBlockedError} when a non-JSON response is a CDN/WAF refusal
 * page rather than FreshBooks' own answer (chrischall/mcp-host#1015), so the
 * healthcheck reports `edge_blocked` instead of an unexplained failure.
 */
export function throwIfEdgeBlocked(res: Response, body: string, method: string, path: string): void {
  const edge = detectEdgeBlock({ body, headers: res.headers, status: res.status });
  if (edge) throw new EdgeBlockedError(res.status, edge.vendor, { service: 'FreshBooks', method, path });
}

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
    throwIfEdgeBlocked(res, raw, 'POST', '/auth/oauth/token');
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
      hint: recoveryHint(),
    });
  }
  // The old refresh token is spent the moment FreshBooks answers, so a reply
  // missing its successor or a usable expiry must fail loudly here: persisting
  // it would write a record the next start rejects, falling back to the spent
  // env token and locking the account out.
  if (typeof parsed.refresh_token !== 'string' || !parsed.refresh_token) {
    throw new McpToolError('FreshBooks returned no refresh token on refresh.', { hint: recoveryHint() });
  }
  if (typeof parsed.expires_in !== 'number' || !Number.isFinite(parsed.expires_in) || parsed.expires_in <= 0) {
    throw new McpToolError('FreshBooks returned invalid token expiry information on refresh.', {
      hint: recoveryHint(),
    });
  }
  const createdAt =
    typeof parsed.created_at === 'number' && Number.isFinite(parsed.created_at)
      ? parsed.created_at
      : Math.floor(Date.now() / 1000);
  return {
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token,
    expires_in: parsed.expires_in,
    created_at: createdAt,
  };
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
 *    burned upstream and silence would lock the account out. A persistence
 *    failure is wrapped so it cannot be mistaken for a revoked credential or
 *    ignored in favor of a cached access token.
 */
/**
 * Whether the persisted refresh token differs from the CONFIGURED one — i.e.
 * whether a rotation has actually happened, for `freshbooks_healthcheck`.
 *
 * Reads the same store `createTokenManager` does, so it reports the token that
 * would really be used. Returns `null` when nothing is persisted yet: that is
 * "not known", which is a different answer from "not rotated" and the
 * healthcheck must not conflate them.
 *
 * Deliberately returns a BOOLEAN, never a token. An earlier version inferred
 * this from whether the private `tokenManager` field had been lazily
 * constructed, which only tracked "some authenticated request happened in this
 * process" — always false on a fresh process's first call and true forever
 * after, regardless of any rotation.
 */
export function hasRotated(
  config: OAuthConfig,
  opts: { storePath?: string } = {},
): boolean | null {
  const filePath = opts.storePath ?? defaultStorePath();
  const store = tokenStore(config, filePath);
  const stored = store.load() ?? readLegacyStore(filePath, config.refreshToken);
  if (!stored || !stored.refreshToken) return null;
  return stored.refreshToken !== config.refreshToken;
}

export function createTokenManager(
  config: OAuthConfig,
  opts: { storePath?: string; fetchImpl?: typeof fetch } = {},
): TokenManager {
  const filePath = opts.storePath ?? defaultStorePath();
  const store = tokenStore(config, filePath);
  // No cast needed since mcp-utils 0.17.1: the file-backed store advertises
  // SyncStatePersistence, so `load()` is already `BearerTokens | null`.
  const loadSync = (): BearerTokens | null =>
    store.load() ?? readLegacyStore(filePath, config.refreshToken);
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
    // Several processes share this store (Claude Desktop plus any Claude Code
    // sessions). `reloadBeforeRefresh` takes the store's cross-process lock,
    // re-reads it, and adopts a rotation a sibling already wrote — its access
    // token if still good, otherwise its refresh token is the one spent — then
    // writes the result before releasing the lock (fleet-audit#1008). Without
    // it, a process would spend a refresh token another had already rotated
    // past: an invalid_grant, and "re-mint" advice while a valid successor sat
    // on disk. The legacy-shape fallback rides along on `load`.
    persistence: {
      load: loadSync,
      save: (t: BearerTokens) => store.save(t),
      clear: () => store.clear(),
      withLock: <R>(fn: () => Promise<R>) =>
        store.withLock ? store.withLock(fn) : fn(),
    },
    reloadBeforeRefresh: true,
    // A failed write is FATAL: the previous refresh token is already spent
    // upstream, so silence would lock the account out on the next start.
    onPersistError: () => {
      throw new McpToolError('Refreshed the FreshBooks token but could not persist it.', {
        hint: 'The previous refresh token is now spent. Fix the token store path/permissions first. ' + recoveryHint(),
      });
    },
  });
}
