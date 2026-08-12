// FreshBooks rotates refresh tokens on every use and the old one is immediately
// dead. These tests assert the OUTCOME that matters — that the token surviving on
// disk is the usable one — rather than that some particular call was made, because
// a mechanism assertion would pass while the account was still locked out.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTokenManager, exchangeRefreshToken, type OAuthConfig } from '../src/auth.js';

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

/** Push the stored access token's expiry into the past to force a refresh. */
function expireStoredAccessToken(): void {
  const raw = JSON.parse(readFileSync(storePath, 'utf8')) as Record<string, { expiresAt: number }>;
  for (const k of Object.keys(raw)) raw[k].expiresAt = Date.now() - 1000;
  writeFileSync(storePath, JSON.stringify(raw));
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
