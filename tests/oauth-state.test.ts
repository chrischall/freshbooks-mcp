// The consent round-trip must be bound to THIS session: without a `state`, a
// socially engineered paste of someone else's redirect URL connects the server
// to THEIR FreshBooks account, and every later create_client/create_invoice
// puts the user's customer data into it. (chrischall/fleet-audit#465)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

// Issued states are persisted beside the token store (or under MCP_DATA_DIR
// when hosted), so every test points that at a private temp directory.
let stateDir: string;
const savedStore = process.env.FRESHBOOKS_TOKEN_STORE;
const savedDataDir = process.env.MCP_DATA_DIR;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'freshbooks-oauth-state-unit-'));
  process.env.FRESHBOOKS_TOKEN_STORE = join(stateDir, 'session.json');
  delete process.env.MCP_DATA_DIR;
  resetAuthStatesForTesting();
});
afterEach(() => {
  resetAuthStatesForTesting();
  if (savedStore === undefined) delete process.env.FRESHBOOKS_TOKEN_STORE;
  else process.env.FRESHBOOKS_TOKEN_STORE = savedStore;
  if (savedDataDir === undefined) delete process.env.MCP_DATA_DIR;
  else process.env.MCP_DATA_DIR = savedDataDir;
  rmSync(stateDir, { recursive: true, force: true });
});

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

  it('refuses a redirect URL with no state', () => {
    issueAuthState();
    expect(() => verifyAuthorizationResponse('https://localhost/?code=c', CONFIG)).toThrow(/state/i);
  });

  it('refuses a bare code — it carries no state, so it cannot be bound', () => {
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

  // The attack in fleet-audit#465 starts in a FRESH session: the attacker
  // opens the public consent URL themselves (no state), and sends the victim
  // the redirect URL. Nothing having been issued here must not make it pass.
  it('refuses a bare code even when no consent URL was issued here', () => {
    let err: unknown;
    try {
      verifyAuthorizationResponse('barecode', CONFIG);
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toMatch(/whole redirect URL/i);
    expect((err as Error & { hint?: string }).hint).toMatch(/freshbooks_auth_url/);
  });

  it('refuses a state-less redirect URL even when no consent URL was issued here', () => {
    let err: unknown;
    try {
      verifyAuthorizationResponse('https://localhost/?code=attackers-code', CONFIG);
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toMatch(/state/i);
    expect((err as Error & { hint?: string }).hint).toMatch(/freshbooks_auth_url/);
  });
});

describe('issued states survive a restart', () => {
  it('accepts a state issued before the process restarted, then consumes it', async () => {
    const state = issueAuthState();
    // A fresh module instance is what a respawned child has: empty memory.
    vi.resetModules();
    const fresh = await import('../src/auth.js');
    expect(() => fresh.verifyAuthorizationResponse(`https://localhost/?code=c&state=${state}`, CONFIG)).not.toThrow();
    vi.resetModules();
    const again = await import('../src/auth.js');
    expect(() => again.verifyAuthorizationResponse(`https://localhost/?code=c&state=${state}`, CONFIG)).toThrow(
      /state/i,
    );
  });

  it('keeps hosted states under MCP_DATA_DIR, privately, as digests only', async () => {
    const dataDir = join(stateDir, 'hosted');
    process.env.MCP_DATA_DIR = dataDir;
    const state = issueAuthState();
    const file = join(dataDir, 'freshbooks-oauth-state.json');
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).not.toContain(state);
    vi.resetModules();
    const fresh = await import('../src/auth.js');
    expect(() => fresh.verifyAuthorizationResponse(`https://localhost/?code=c&state=${state}`, CONFIG)).not.toThrow();
  });

  it('still binds the round-trip in memory when the state file cannot be written', () => {
    // A directory where the file should be makes every write fail.
    process.env.FRESHBOOKS_TOKEN_STORE = join(stateDir, 'blocked', 'session.json');
    rmSync(join(stateDir, 'blocked'), { recursive: true, force: true });
    mkdirSync(join(stateDir, 'blocked', 'session.json.oauth-state.json'), { recursive: true });
    const state = issueAuthState();
    expect(() => verifyAuthorizationResponse(`https://localhost/?code=c&state=${state}`, CONFIG)).not.toThrow();
  });

  it('ignores a corrupt state file rather than failing the login', () => {
    writeFileSync(join(stateDir, 'session.json.oauth-state.json'), 'not json');
    const state = issueAuthState();
    expect(() => verifyAuthorizationResponse(`https://localhost/?code=c&state=${state}`, CONFIG)).not.toThrow();
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

  it('tells the person to pass the WHOLE redirect URL, matching the refusals', async () => {
    const h = await createTestHarness((server) => registerAuthTools(server));
    try {
      const issued = parseToolResult(await h.callTool('freshbooks_auth_url', {})) as { next: string };
      expect(issued.next).toMatch(/whole URL/);
    } finally {
      await h.close();
    }
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
