import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { authorizeUrl, extractAuthorizationCode, exchangeAuthorizationCode } from '../src/auth.js';
import type { OAuthConfig } from '../src/auth.js';

const CONFIG: OAuthConfig = {
  clientId: 'cid',
  clientSecret: 'csecret',
  redirectUri: 'https://localhost',
  refreshToken: '',
};

describe('authorizeUrl', () => {
  it('builds the consent URL FreshBooks expects', () => {
    const u = new URL(authorizeUrl(CONFIG));
    expect(u.origin + u.pathname).toBe('https://auth.freshbooks.com/oauth/authorize/');
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('redirect_uri')).toBe('https://localhost');
  });

  // The secret must never end up in a URL a person is asked to open in a
  // browser — it would land in history, and in any proxy along the way.
  it('never puts the client secret in the URL', () => {
    expect(authorizeUrl(CONFIG)).not.toContain('csecret');
  });
});

describe('extractAuthorizationCode', () => {
  // People paste the whole redirect URL far more often than the bare code,
  // because the bare code is the awkward thing to find.
  it('takes the code out of a pasted redirect URL', () => {
    expect(extractAuthorizationCode('https://localhost/?code=abc123&state=x')).toBe('abc123');
  });

  it('accepts a bare code unchanged, trimming stray whitespace', () => {
    expect(extractAuthorizationCode('  abc123 ')).toBe('abc123');
  });

  it('refuses a URL with no code rather than passing the URL on as one', () => {
    expect(() => extractAuthorizationCode('https://localhost/?error=access_denied')).toThrow(/code/i);
  });

  it('refuses empty input', () => {
    expect(() => extractAuthorizationCode('   ')).toThrow();
  });
});

describe('exchangeAuthorizationCode', () => {
  function fakeToken(status: number, body: unknown) {
    const calls: Record<string, string>[] = [];
    const fetchImpl = (async (_url: string, init: { body: URLSearchParams }) => {
      calls.push(Object.fromEntries(init.body as unknown as URLSearchParams));
      return { ok: status < 400, status, text: async () => JSON.stringify(body) };
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it('posts grant_type=authorization_code, form-encoded, with the code', async () => {
    const { fetchImpl, calls } = fakeToken(200, {
      access_token: 'at', refresh_token: 'rt', expires_in: 43200, created_at: 1,
    });
    const tok = await exchangeAuthorizationCode(CONFIG, 'thecode', fetchImpl);
    expect(tok.refresh_token).toBe('rt');
    expect(calls[0]).toMatchObject({
      grant_type: 'authorization_code',
      code: 'thecode',
      client_id: 'cid',
      client_secret: 'csecret',
      redirect_uri: 'https://localhost',
    });
  });

  it('accepts a pasted redirect URL in place of the code', async () => {
    const { fetchImpl, calls } = fakeToken(200, {
      access_token: 'at', refresh_token: 'rt', expires_in: 43200, created_at: 1,
    });
    await exchangeAuthorizationCode(CONFIG, 'https://localhost/?code=fromurl', fetchImpl);
    expect(calls[0]!.code).toBe('fromurl');
  });

  // An authorization code is single-use: a failed exchange cannot be retried
  // with the same code, so the error has to say that rather than inviting one.
  // Asserted on the HINT, not the message: this repo puts actionable next steps
  // in `hint` (McpToolError), and the message carries FreshBooks' own words.
  // Checking the message would have pushed the guidance into the wrong field.
  it('explains that the code is spent when the exchange fails', async () => {
    const { fetchImpl } = fakeToken(400, { error: 'invalid_grant' });
    const err = await exchangeAuthorizationCode(CONFIG, 'thecode', fetchImpl).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/invalid_grant/);
    expect((err as { hint?: string }).hint).toMatch(/single-use/i);
  });

  it('fails when the response carries no refresh token', async () => {
    const { fetchImpl } = fakeToken(200, { access_token: 'at', expires_in: 1, created_at: 1 });
    await expect(exchangeAuthorizationCode(CONFIG, 'thecode', fetchImpl)).rejects.toThrow(/refresh/i);
  });
});

// The finding that made the first version of these tools useless: they read
// readOAuthConfig(), which demands FRESHBOOKS_REFRESH_TOKEN — the very thing
// they exist to mint. A first-time user is ALWAYS in the state that blocked.
describe('readBootstrapConfig', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    for (const k of ['FRESHBOOKS_CLIENT_ID', 'FRESHBOOKS_CLIENT_SECRET', 'FRESHBOOKS_REFRESH_TOKEN', 'FRESHBOOKS_REDIRECT_URI']) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ['FRESHBOOKS_CLIENT_ID', 'FRESHBOOKS_CLIENT_SECRET', 'FRESHBOOKS_REFRESH_TOKEN', 'FRESHBOOKS_REDIRECT_URI']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('succeeds with NO refresh token — the first-time case', async () => {
    process.env.FRESHBOOKS_CLIENT_ID = 'cid';
    process.env.FRESHBOOKS_CLIENT_SECRET = 'csecret';
    const { readBootstrapConfig } = await import('../src/auth.js');
    const r = readBootstrapConfig();
    expect('config' in r).toBe(true);
    if ('config' in r) {
      expect(r.config.clientId).toBe('cid');
      expect(r.config.refreshToken).toBe('');
    }
  });

  it('still refuses when the app credentials are missing, and says a token is not needed', async () => {
    const { readBootstrapConfig } = await import('../src/auth.js');
    const r = readBootstrapConfig();
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect(r.error).toMatch(/FRESHBOOKS_CLIENT_ID/);
      expect(r.error).not.toMatch(/FRESHBOOKS_REFRESH_TOKEN/);
      expect(r.error).toMatch(/mint one/i);
    }
  });

  it('defaults the redirect URI, and honours an override', async () => {
    process.env.FRESHBOOKS_CLIENT_ID = 'cid';
    process.env.FRESHBOOKS_CLIENT_SECRET = 'csecret';
    const { readBootstrapConfig } = await import('../src/auth.js');
    const a = readBootstrapConfig();
    expect('config' in a && a.config.redirectUri).toBe('https://localhost');
    process.env.FRESHBOOKS_REDIRECT_URI = 'https://example.test/cb';
    const b = readBootstrapConfig();
    expect('config' in b && b.config.redirectUri).toBe('https://example.test/cb');
  });
});
