// An access token FreshBooks invalidated before its expiresAt (revocation,
// reauthorisation, clock skew) must not fail every call for hours while a good
// refresh token sits unused — and a token response missing fields must not be
// persisted as a record the next start rejects. (chrischall/fleet-audit#459)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exchangeRefreshToken, type OAuthConfig } from '../src/auth.js';
import { FreshbooksClient } from '../src/client.js';

const CONFIG: OAuthConfig = {
  clientId: 'cid',
  clientSecret: 'csecret',
  redirectUri: 'https://localhost',
  refreshToken: 'rt',
};

let dir: string;
const saved = { ...process.env };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fb-401-'));
  process.env.FRESHBOOKS_CLIENT_ID = 'cid';
  process.env.FRESHBOOKS_CLIENT_SECRET = 'csecret';
  process.env.FRESHBOOKS_REFRESH_TOKEN = 'rt';
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...saved };
});

const tokenResponse = (body: Record<string, unknown>) =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe('401 on a not-yet-expired access token', () => {
  it('forces one refresh and retries the request', async () => {
    let refreshes = 0;
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      const u = String(url);
      if (u.includes('/auth/oauth/token')) {
        refreshes += 1;
        return new Response(
          JSON.stringify({
            access_token: `at-${refreshes}`,
            refresh_token: `rt-${refreshes}`,
            created_at: Math.floor(Date.now() / 1000),
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }
      const auth = new Headers(init.headers).get('Authorization') ?? '';
      seen.push(auth);
      if (auth === 'Bearer at-1') {
        return new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 });
      }
      return new Response(
        JSON.stringify({ response: { business_memberships: [{ business: { id: 7, account_id: 'acct' } }] } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new FreshbooksClient({ fetchImpl, storePath: join(dir, 'session.json') });

    const identity = await client.getIdentity();
    expect(identity.accountId).toBe('acct');
    expect(seen).toEqual(['Bearer at-1', 'Bearer at-2']);
    expect(refreshes).toBe(2);
  });
});

describe('exchangeRefreshToken validates the token response', () => {
  it('defaults a missing created_at to now so expiry stays a real number', async () => {
    const before = Math.floor(Date.now() / 1000);
    const tok = await exchangeRefreshToken(
      CONFIG,
      'rt',
      tokenResponse({ access_token: 'at', refresh_token: 'rt2', expires_in: 3600 }),
    );
    expect(tok.created_at).toBeGreaterThanOrEqual(before);
    expect(Number.isFinite((tok.created_at + tok.expires_in) * 1000)).toBe(true);
  });

  it('refuses a response with no refresh token', async () => {
    await expect(
      exchangeRefreshToken(CONFIG, 'rt', tokenResponse({ access_token: 'at', created_at: 1, expires_in: 3600 })),
    ).rejects.toThrow(/refresh token/i);
  });

  it('refuses a response whose expires_in is not a number', async () => {
    await expect(
      exchangeRefreshToken(
        CONFIG,
        'rt',
        tokenResponse({ access_token: 'at', refresh_token: 'rt2', created_at: 1, expires_in: 'soon' }),
      ),
    ).rejects.toThrow(/expir/i);
  });
});
