// FreshBooks rotates refresh tokens on every use and the old one is immediately
// dead. These tests assert the OUTCOME that matters — that the token surviving on
// disk is the usable one — rather than that some particular call was made, because
// a mechanism assertion would pass while the account was still locked out.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTokenManager, exchangeRefreshToken, hasRotated, type OAuthConfig } from '../src/auth.js';

const CONFIG: OAuthConfig = {
  clientId: 'cid',
  clientSecret: 'csecret',
  redirectUri: 'https://localhost',
  refreshToken: 'env-token-1',
};

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fb-auth-'));
  storePath = join(dir, 'session.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A fake token endpoint that hands out a new refresh token each call and records requests. */
function fakeTokenServer(opts: { rejectAfter?: number } = {}) {
  const calls: Array<Record<string, string>> = [];
  let n = 0;
  const fetchImpl = (async (_url: string, init: { body?: URLSearchParams }) => {
    const body = Object.fromEntries((init.body as URLSearchParams).entries());
    calls.push(body);
    n += 1;
    if (opts.rejectAfter !== undefined && n > opts.rejectAfter) {
      return new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token is invalid' }),
        { status: 400 },
      );
    }
    return new Response(
      JSON.stringify({
        access_token: `access-${n}`,
        refresh_token: `rotated-${n}`,
        created_at: Math.floor(Date.now() / 1000),
        expires_in: 3600,
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/**
 * Push the stored access token's expiry into the past to force a refresh.
 * Reaches into the mcp-utils envelope (`{ v, boundTo?, state }`) — the salted
 * binding is left untouched so the record still verifies.
 */
function expireStoredAccessToken(): void {
  const raw = JSON.parse(readFileSync(storePath, 'utf8')) as { state: { expiresAt: number } };
  raw.state.expiresAt = Date.now() - 1000;
  writeFileSync(storePath, JSON.stringify(raw), { mode: 0o600 });
}

describe('exchangeRefreshToken', () => {
  it('sends client_secret and redirect_uri on the REFRESH grant, form-encoded', async () => {
    // FreshBooks requires both on refresh, unlike most OAuth2 servers; omitting
    // either yields an opaque invalid_client.
    const { fetchImpl, calls } = fakeTokenServer();
    await exchangeRefreshToken(CONFIG, 'rt', fetchImpl);
    expect(calls[0]).toEqual({
      client_id: 'cid',
      client_secret: 'csecret',
      grant_type: 'refresh_token',
      redirect_uri: 'https://localhost',
      refresh_token: 'rt',
    });
  });

  it('explains that a spent token is unrecoverable without re-running the bootstrap', async () => {
    const { fetchImpl } = fakeTokenServer({ rejectAfter: 0 });
    await expect(exchangeRefreshToken(CONFIG, 'spent', fetchImpl)).rejects.toThrow(
      /refused the refresh token/i,
    );
    await expect(exchangeRefreshToken(CONFIG, 'spent', fetchImpl)).rejects.toMatchObject({
      hint: expect.stringMatching(/single-use|re-run the OAuth bootstrap/i),
    });
  });
});

describe('token rotation persistence', () => {
  it('persists the rotated token so a later process does not replay a dead one', async () => {
    const { fetchImpl } = fakeTokenServer();
    const tm = createTokenManager(CONFIG, { storePath, fetchImpl });
    await tm.getAccessToken();

    // The outcome that matters: what is on disk is the NEW token, not the env one.
    expect(existsSync(storePath)).toBe(true);
    const onDisk = readFileSync(storePath, 'utf8');
    expect(onDisk).toContain('rotated-1');
    expect(onDisk).not.toContain('"refreshToken":"env-token-1"');
  });

  it('a fresh manager resumes from the stored token, not the stale env value', async () => {
    const first = fakeTokenServer();
    await createTokenManager(CONFIG, { storePath, fetchImpl: first.fetchImpl }).getAccessToken();

    // Expire the cached access token so a refresh is actually required; otherwise the
    // manager (correctly) reuses the cached token and never reaches the refresh path.
    expireStoredAccessToken();

    // Simulate a process restart: same env config, same store.
    const second = fakeTokenServer();
    await createTokenManager(CONFIG, { storePath, fetchImpl: second.fetchImpl }).getAccessToken();

    // It must spend the ROTATED token. Spending env-token-1 again would 400 in reality.
    expect(second.calls[0].refresh_token).toBe('rotated-1');
  });

  it('adopts a re-bootstrapped env token instead of the older stored one', async () => {
    const first = fakeTokenServer();
    await createTokenManager(CONFIG, { storePath, fetchImpl: first.fetchImpl }).getAccessToken();

    // The human re-ran the authorize flow and pasted a new token into the environment.
    const rebootstrapped = { ...CONFIG, refreshToken: 'env-token-2' };
    const second = fakeTokenServer();
    await createTokenManager(rebootstrapped, { storePath, fetchImpl: second.fetchImpl }).getAccessToken();

    expect(second.calls[0].refresh_token).toBe('env-token-2');
  });

  it('spends the token exactly once when concurrent callers race a refresh', async () => {
    // Two simultaneous tool calls must not each spend the same single-use token —
    // the loser would be permanently locked out.
    const { fetchImpl, calls } = fakeTokenServer();
    const tm = createTokenManager(CONFIG, { storePath, fetchImpl });
    await Promise.all([tm.getAccessToken(), tm.getAccessToken(), tm.getAccessToken()]);
    expect(calls).toHaveLength(1);
  });

  it('stores the token file with owner-only permissions', async () => {
    const { fetchImpl } = fakeTokenServer();
    await createTokenManager(CONFIG, { storePath, fetchImpl }).getAccessToken();
    const mode = (await import('node:fs')).statSync(storePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('access token caching', () => {
  // Access tokens live 12 hours (verified live). Discarding them on every process
  // start would spend a single-use refresh token per restart for no reason, and each
  // rotation is another chance to break the chain.
  it('reuses a still-valid stored access token instead of refreshing', async () => {
    const first = fakeTokenServer();
    await createTokenManager(CONFIG, { storePath, fetchImpl: first.fetchImpl }).getAccessToken();
    expect(first.calls).toHaveLength(1);

    const second = fakeTokenServer();
    const token = await createTokenManager(CONFIG, {
      storePath,
      fetchImpl: second.fetchImpl,
    }).getAccessToken();

    expect(second.calls).toHaveLength(0);
    expect(token).toBe('access-1');
  });

  it('still refreshes when the stored access token has expired', async () => {
    const first = fakeTokenServer();
    await createTokenManager(CONFIG, { storePath, fetchImpl: first.fetchImpl }).getAccessToken();

    expireStoredAccessToken();

    const second = fakeTokenServer();
    await createTokenManager(CONFIG, { storePath, fetchImpl: second.fetchImpl }).getAccessToken();
    expect(second.calls).toHaveLength(1);
  });
});

describe('migration off the pre-0.17 SessionStore file', () => {
  /** Write the legacy on-disk shape: a JSON ARRAY of session records. */
  function writeLegacy(rec: Record<string, unknown>): void {
    writeFileSync(storePath, JSON.stringify([rec], null, 2), { mode: 0o600 });
  }

  it('adopts a legacy stored token instead of replaying the dead env one', async () => {
    // THE upgrade hazard. The stored token has rotated past the env copy, so the
    // env copy is long spent. An upgrade that cannot read the legacy file would
    // send that dead token and strand the account until the human re-bootstraps.
    writeLegacy({
      key: 'freshbooks',
      refreshToken: 'rotated-9',
      seededFromEnv: 'env-token-1',
      accessToken: 'cached-access',
      expiresAt: Date.now() + 11 * 60 * 60 * 1000,
    });
    const { fetchImpl, calls } = fakeTokenServer();
    const tm = createTokenManager(CONFIG, { storePath, fetchImpl });

    // The cached access token is still valid, so no refresh should be spent.
    expect(await tm.getAccessToken()).toBe('cached-access');
    expect(calls).toHaveLength(0);
  });

  it('spends the legacy ROTATED token, never the env one, once the access token expires', async () => {
    writeLegacy({
      key: 'freshbooks',
      refreshToken: 'rotated-9',
      seededFromEnv: 'env-token-1',
      accessToken: 'stale',
      expiresAt: Date.now() - 1,
    });
    const { fetchImpl, calls } = fakeTokenServer();
    await createTokenManager(CONFIG, { storePath, fetchImpl }).getAccessToken();
    expect(calls[0].refresh_token).toBe('rotated-9');
  });

  it('ignores the legacy record when the human re-bootstrapped', async () => {
    writeLegacy({
      key: 'freshbooks',
      refreshToken: 'old-chain',
      seededFromEnv: 'a-previous-env-token',
      accessToken: 'old-access',
      expiresAt: Date.now() + 11 * 60 * 60 * 1000,
    });
    const { fetchImpl, calls } = fakeTokenServer();
    await createTokenManager(CONFIG, { storePath, fetchImpl }).getAccessToken();
    // env-token-1 was pasted on purpose; it must win over the older chain.
    expect(calls[0].refresh_token).toBe('env-token-1');
  });

  it('rewrites the file in the current format on the next refresh', async () => {
    writeLegacy({
      key: 'freshbooks',
      refreshToken: 'rotated-9',
      seededFromEnv: 'env-token-1',
      accessToken: 'stale',
      expiresAt: Date.now() - 1,
    });
    const { fetchImpl } = fakeTokenServer();
    await createTokenManager(CONFIG, { storePath, fetchImpl }).getAccessToken();
    const body = JSON.parse(readFileSync(storePath, 'utf8')) as Record<string, unknown>;
    expect(Array.isArray(body)).toBe(false);
    expect(readFileSync(storePath, 'utf8')).toContain('rotated-1');
  });
});

describe('a failed write stays fatal', () => {
  it('refuses rather than silently losing a rotated single-use token', async () => {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x'); // parent is a FILE, so every write fails
    const { fetchImpl } = fakeTokenServer();
    const tm = createTokenManager(CONFIG, { storePath: join(blocker, 'session.json'), fetchImpl });
    // The refresh SUCCEEDS and burns env-token-1 upstream. Silence here would
    // lock the account out on the next start.
    await expect(tm.getAccessToken()).rejects.toThrow(/persist/i);
  });
});

/**
 * `hasRotated` backs `freshbooks_healthcheck`'s one real diagnostic, so both
 * comparison branches matter. It lives here rather than in the healthcheck
 * tests because it reads the on-disk store, and the fixtures for that store
 * (`storePath`, `fakeTokenServer`, `expireStoredAccessToken`, the temp dir and
 * its cleanup) are all here.
 */
describe('hasRotated', () => {
  it('is null when nothing is persisted — unknown, not "not rotated"', () => {
    // The distinction is the point: a healthcheck must not report "your token
    // is the configured one" when it has simply never looked.
    expect(hasRotated(CONFIG, { storePath })).toBeNull();
  });

  it('is true once a refresh has replaced the configured token', async () => {
    const first = fakeTokenServer();
    await createTokenManager(CONFIG, { storePath, fetchImpl: first.fetchImpl }).getAccessToken();
    // The fake server rotates env-token-1 -> rotated-1, and TokenManager
    // persists the replacement before resolving.
    expect(hasRotated(CONFIG, { storePath })).toBe(true);
  });

  it('is false while the stored token still equals the configured one', () => {
    // Seed a store whose refresh token is the configured one, mutating a REAL
    // record so the salted `boundTo` binding still verifies.
    const seed = fakeTokenServer();
    return createTokenManager(CONFIG, { storePath, fetchImpl: seed.fetchImpl })
      .getAccessToken()
      .then(() => {
        const raw = JSON.parse(readFileSync(storePath, 'utf8')) as {
          state: { refreshToken: string };
        };
        raw.state.refreshToken = CONFIG.refreshToken;
        writeFileSync(storePath, JSON.stringify(raw), { mode: 0o600 });
        expect(hasRotated(CONFIG, { storePath })).toBe(false);
      });
  });

  it('never returns the token itself', async () => {
    const first = fakeTokenServer();
    await createTokenManager(CONFIG, { storePath, fetchImpl: first.fetchImpl }).getAccessToken();
    expect(typeof hasRotated(CONFIG, { storePath })).toBe('boolean');
  });
});
