import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { FreshbooksClient } from '../src/client.js';
import { registerAuthTools } from '../src/tools/auth.js';

const ACCESS = 'dummy-local-access-token';
const REFRESH = 'dummy-local-refresh-token';
const variables = [
  'FRESHBOOKS_CLIENT_ID', 'FRESHBOOKS_CLIENT_SECRET', 'FRESHBOOKS_REFRESH_TOKEN',
  'FRESHBOOKS_REDIRECT_URI', 'FRESHBOOKS_TOKEN_STORE', 'MCP_DATA_DIR',
] as const;
let saved: Record<string, string | undefined>;
let directory: string;
let storePath: string;

beforeEach(() => {
  saved = Object.fromEntries(variables.map((name) => [name, process.env[name]]));
  for (const name of variables) delete process.env[name];
  directory = mkdtempSync(join(tmpdir(), 'freshbooks-local-auth-'));
  storePath = join(directory, 'private', 'session.json');
  process.env.FRESHBOOKS_CLIENT_ID = 'dummy-app';
  process.env.FRESHBOOKS_CLIENT_SECRET = 'dummy-secret';
  process.env.FRESHBOOKS_TOKEN_STORE = storePath;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const name of variables) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(directory, { recursive: true, force: true });
});

function tokenEndpoint() {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  let exchanges = 0;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, authorization: new Headers(init?.headers).get('Authorization') });
    if (url === 'https://api.freshbooks.com/auth/oauth/token') {
      const suffix = ++exchanges === 1 ? '' : `-${exchanges}`;
      return Response.json({
        access_token: ACCESS + suffix, refresh_token: REFRESH + suffix,
        created_at: Math.floor(Date.now() / 1000), expires_in: 3600,
      });
    }
    if (url === 'https://api.freshbooks.com/auth/api/v1/users/me') {
      return Response.json({ response: {
        identity_id: 1, email: 'person@example.test',
        business_memberships: [{ business: { id: 7, account_id: 'account', name: 'Test business' } }],
      } });
    }
    throw new Error(`Unexpected test request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchImpl);
  return { fetchImpl, requests };
}

describe('local OAuth credentials stay out of MCP results', () => {
  it('saves tokens privately and can read the account after restart without a token environment variable', async () => {
    const { fetchImpl, requests } = tokenEndpoint();
    const h = await createTestHarness((server) => registerAuthTools(server));
    try {
      const result = await h.callTool('freshbooks_auth_exchange', { code: 'dummy-code' });
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result)).not.toContain(REFRESH);
      expect(JSON.stringify(result)).not.toContain(ACCESS);
      expect(parseToolResult(result)).toMatchObject({ connected: true });
      expect(readFileSync(storePath, 'utf8')).toContain(REFRESH);
      expect(statSync(storePath).mode & 0o777).toBe(0o600);
      expect(statSync(join(directory, 'private')).mode & 0o777).toBe(0o700);
      expect(process.env.FRESHBOOKS_REFRESH_TOKEN).toBeUndefined();

      const restarted = new FreshbooksClient({ fetchImpl, storePath });
      expect(await restarted.getIdentity()).toMatchObject({ accountId: 'account', businessId: 7 });
      expect(requests.filter((r) => r.url.endsWith('/auth/oauth/token'))).toHaveLength(1);
      expect(requests.at(-1)?.authorization).toBe(`Bearer ${ACCESS}`);
      expect(restarted.describeCredential().source).toBe('token-store');

      // A later process refreshes the expired access token, then another
      // process reuses the saved replacement rather than the spent seed.
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 7_200_000);
      await new FreshbooksClient({ fetchImpl, storePath }).getIdentity();
      await new FreshbooksClient({ fetchImpl, storePath }).getIdentity();
      expect(requests.filter((r) => r.url.endsWith('/auth/oauth/token'))).toHaveLength(2);
      expect(requests.at(-1)?.authorization).toBe(`Bearer ${ACCESS}-2`);
      expect(readFileSync(storePath, 'utf8')).toContain(`${REFRESH}-2`);
    } finally {
      await h.close();
    }
  });

  it('keeps an existing environment seed compatible after local reauthorization', async () => {
    process.env.FRESHBOOKS_REFRESH_TOKEN = 'dummy-previous-seed';
    const { fetchImpl, requests } = tokenEndpoint();
    const h = await createTestHarness((server) => registerAuthTools(server));
    try {
      const result = await h.callTool('freshbooks_auth_exchange', { code: 'dummy-code' });
      expect(parseToolResult(result)).toMatchObject({ connected: true });
      expect(JSON.stringify(result)).not.toContain(REFRESH);
      await new FreshbooksClient({ fetchImpl, storePath }).getIdentity();
      expect(requests.filter((r) => r.url.endsWith('/auth/oauth/token'))).toHaveLength(1);
      expect(requests.at(-1)?.authorization).toBe(`Bearer ${ACCESS}`);
    } finally {
      await h.close();
    }
  });

  it('does not reuse a local credential for a different app', async () => {
    const { fetchImpl, requests } = tokenEndpoint();
    const h = await createTestHarness((server) => registerAuthTools(server));
    try {
      await h.callTool('freshbooks_auth_exchange', { code: 'dummy-code' });
      process.env.FRESHBOOKS_CLIENT_ID = 'different-app';
      await expect(new FreshbooksClient({ fetchImpl, storePath }).getIdentity()).rejects.toThrow(/not configured/i);
      expect(requests).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('does not adopt local credentials in hosted mode without an environment seed', async () => {
    const { fetchImpl, requests } = tokenEndpoint();
    const h = await createTestHarness((server) => registerAuthTools(server));
    try {
      await h.callTool('freshbooks_auth_exchange', { code: 'dummy-code' });
      process.env.MCP_DATA_DIR = join(directory, 'hosted');
      await expect(new FreshbooksClient({ fetchImpl, storePath }).getIdentity()).rejects.toThrow(/not configured/i);
      expect(requests).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it.each([
    { status: 400, body: { refresh_token: REFRESH } },
    { status: 400, body: { error: REFRESH, error_description: ACCESS } },
    { status: 200, body: { refresh_token: REFRESH } },
    { status: 200, body: { access_token: ACCESS, refresh_token: REFRESH, expires_in: -1, created_at: 1 } },
  ])('keeps tokens out of malformed and failed exchange results: %j', async ({ status, body }) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status })));
    const h = await createTestHarness((server) => registerAuthTools(server));
    try {
      const result = await h.callTool('freshbooks_auth_exchange', { code: 'dummy-code' });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(ACCESS);
      expect(JSON.stringify(result)).not.toContain(REFRESH);
    } finally {
      await h.close();
    }
  });

  it('reports a save failure without exposing either token', async () => {
    mkdirSync(storePath, { recursive: true });
    tokenEndpoint();
    const h = await createTestHarness((server) => registerAuthTools(server));
    try {
      const result = await h.callTool('freshbooks_auth_exchange', { code: 'dummy-code' });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toMatch(/could not be saved/);
      expect(JSON.stringify(result)).not.toContain(ACCESS);
      expect(JSON.stringify(result)).not.toContain(REFRESH);
    } finally {
      await h.close();
    }
  });

  it('preserves the hosted credential-capture response', async () => {
    process.env.MCP_DATA_DIR = join(directory, 'hosted');
    tokenEndpoint();
    const h = await createTestHarness((server) => registerAuthTools(server));
    try {
      const result = await h.callTool('freshbooks_auth_exchange', { code: 'dummy-code' });
      expect(parseToolResult(result)).toMatchObject({ refresh_token: REFRESH });
      expect(JSON.stringify(result)).not.toContain(ACCESS);
    } finally {
      await h.close();
    }
  });
});
