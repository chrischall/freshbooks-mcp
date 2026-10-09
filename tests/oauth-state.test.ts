// The consent round-trip must be bound to THIS session: without a `state`, a
// socially engineered paste of someone else's redirect URL connects the server
// to THEIR FreshBooks account, and every later create_client/create_invoice
// puts the user's customer data into it. (chrischall/fleet-audit#465)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import {
  authorizeUrl,
  issueAuthState,
  resetAuthStatesForTesting,
  verifyAuthorizationResponse,
} from '../src/auth.js';
import type { OAuthConfig } from '../src/auth.js';
import { registerAuthTools } from '../src/tools/auth.js';

const CONFIG: OAuthConfig = {
  clientId: 'cid',
  clientSecret: 'csecret',
  redirectUri: 'https://localhost',
  refreshToken: '',
};

beforeEach(() => resetAuthStatesForTesting());

describe('authorizeUrl state', () => {
  it('carries the state it is given', () => {
    const u = new URL(authorizeUrl(CONFIG, 'abc'));
    expect(u.searchParams.get('state')).toBe('abc');
  });

  it('issues an unguessable, distinct state each time', () => {
    const a = issueAuthState();
    const b = issueAuthState();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });
});

describe('verifyAuthorizationResponse', () => {
  it('accepts the redirect URL carrying the state this session issued', () => {
    const state = issueAuthState();
    expect(() => verifyAuthorizationResponse(`https://localhost/?code=c&state=${state}`, CONFIG)).not.toThrow();
  });

  it('refuses a redirect URL whose state this session did not issue', () => {
    issueAuthState();
    expect(() => verifyAuthorizationResponse('https://localhost/?code=c&state=attacker', CONFIG)).toThrow(
      /state/i,
    );
  });

  it('refuses a redirect URL with no state once a consent URL was issued', () => {
    issueAuthState();
    expect(() => verifyAuthorizationResponse('https://localhost/?code=c', CONFIG)).toThrow(/state/i);
  });

  it('refuses a bare code once a consent URL was issued — it cannot be bound', () => {
    issueAuthState();
    expect(() => verifyAuthorizationResponse('barecode', CONFIG)).toThrow(/whole redirect URL/i);
  });

  it('makes a state single-use', () => {
    const state = issueAuthState();
    verifyAuthorizationResponse(`https://localhost/?code=c&state=${state}`, CONFIG);
    issueAuthState();
    expect(() => verifyAuthorizationResponse(`https://localhost/?code=c2&state=${state}`, CONFIG)).toThrow(
      /state/i,
    );
  });

  it('expires an issued state', () => {
    const t0 = 1_000_000;
    const state = issueAuthState(t0);
    expect(() =>
      verifyAuthorizationResponse(`https://localhost/?code=c&state=${state}`, CONFIG, t0 + 60 * 60_000),
    ).toThrow(/state/i);
  });

  it('refuses a URL that is not this connection\'s redirect URI', () => {
    const state = issueAuthState();
    expect(() =>
      verifyAuthorizationResponse(`https://evil.example/?code=c&state=${state}`, CONFIG),
    ).toThrow(/redirect/i);
  });

  it('refuses a stateful URL when this session issued none (e.g. after a restart)', () => {
    let err: unknown;
    try {
      verifyAuthorizationResponse('https://localhost/?code=c&state=old', CONFIG);
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toMatch(/state/i);
    expect((err as Error & { hint?: string }).hint).toMatch(/freshbooks_auth_url/);
  });

  it('still accepts a bare code when no consent URL was issued here', () => {
    expect(() => verifyAuthorizationResponse('barecode', CONFIG)).not.toThrow();
  });
});

describe('auth tools bind the round-trip', () => {
  const variables = [
    'FRESHBOOKS_CLIENT_ID', 'FRESHBOOKS_CLIENT_SECRET', 'FRESHBOOKS_REFRESH_TOKEN',
    'FRESHBOOKS_REDIRECT_URI', 'FRESHBOOKS_TOKEN_STORE', 'MCP_DATA_DIR',
  ] as const;
  let saved: Record<string, string | undefined>;
  let directory: string;

  beforeEach(() => {
    saved = Object.fromEntries(variables.map((name) => [name, process.env[name]]));
    for (const name of variables) delete process.env[name];
    directory = mkdtempSync(join(tmpdir(), 'freshbooks-oauth-state-'));
    process.env.FRESHBOOKS_CLIENT_ID = 'dummy-app';
    process.env.FRESHBOOKS_CLIENT_SECRET = 'dummy-secret';
    process.env.FRESHBOOKS_TOKEN_STORE = join(directory, 'session.json');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const name of variables) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it('refuses a foreign redirect URL without spending a code at FreshBooks', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('must not contact FreshBooks');
    });
    vi.stubGlobal('fetch', fetchImpl);
    const h = await createTestHarness((server) => registerAuthTools(server));
    try {
      const url = parseToolResult(await h.callTool('freshbooks_auth_url', {})) as { authorize_url: string };
      expect(new URL(url.authorize_url).searchParams.get('state')).toBeTruthy();
      const result = await h.callTool('freshbooks_auth_exchange', {
        code: 'https://localhost/?code=attackers-code&state=attackers-state',
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toMatch(/state/i);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  it('completes when the pasted URL carries the issued state', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === 'https://api.freshbooks.com/auth/oauth/token') {
        return Response.json({
          access_token: 'a', refresh_token: 'r', created_at: Math.floor(Date.now() / 1000), expires_in: 3600,
        });
      }
      throw new Error(`Unexpected test request: ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const h = await createTestHarness((server) => registerAuthTools(server));
    try {
      const url = parseToolResult(await h.callTool('freshbooks_auth_url', {})) as { authorize_url: string };
      const state = new URL(url.authorize_url).searchParams.get('state');
      const result = await h.callTool('freshbooks_auth_exchange', {
        code: `https://localhost/?code=good&state=${state}`,
      });
      expect(result.isError).toBeFalsy();
      expect(parseToolResult(result)).toMatchObject({ connected: true });
    } finally {
      await h.close();
    }
  });
});
