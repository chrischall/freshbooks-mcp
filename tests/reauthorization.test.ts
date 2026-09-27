import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStatePersistence, type BearerTokens } from '@chrischall/mcp-utils/session';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { createTokenManager, type OAuthConfig } from '../src/auth.js';
import { registerAuthTools } from '../src/tools/auth.js';

// Simulate another process committing immediately after this process releases
// its lock, before TokenManager's awaiting continuation resumes.
const hooks = vi.hoisted(() => ({
  beforeLock: undefined as (() => void) | undefined,
  afterUnlock: undefined as (() => void) | undefined,
}));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    openSync(path: import('node:fs').PathLike, flags: string | number, mode?: import('node:fs').Mode) {
      if (String(path).endsWith('.lock')) hooks.beforeLock?.();
      return fs.openSync(path, flags, mode);
    },
    unlinkSync(path: import('node:fs').PathLike) {
      fs.unlinkSync(path);
      if (String(path).endsWith('.lock')) hooks.afterUnlock?.();
    },
  };
});

const config: OAuthConfig = {
  clientId: 'dummy-app', clientSecret: 'dummy-secret',
  redirectUri: 'https://localhost', refreshToken: 'dummy-old-seed',
};
let directory: string;
let storePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'freshbooks-reauthorization-'));
  storePath = join(directory, 'session.json');
  vi.stubEnv('FRESHBOOKS_CLIENT_ID', config.clientId);
  vi.stubEnv('FRESHBOOKS_CLIENT_SECRET', config.clientSecret);
  vi.stubEnv('FRESHBOOKS_REDIRECT_URI', config.redirectUri);
  vi.stubEnv('FRESHBOOKS_REFRESH_TOKEN', config.refreshToken);
  vi.stubEnv('FRESHBOOKS_TOKEN_STORE', storePath);
  vi.stubEnv('MCP_DATA_DIR', '');
});

afterEach(() => {
  hooks.beforeLock = undefined;
  hooks.afterUnlock = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function response(label: string) {
  return Response.json({
    access_token: `dummy-access-${label}`, refresh_token: `dummy-refresh-${label}`,
    created_at: Math.floor(Date.now() / 1000), expires_in: 3600,
  });
}

describe('reauthorization and refresh share one write boundary', () => {
  it('waits for an in-flight refresh before exchanging and saving a new authorization', async () => {
    const refreshStarted = Promise.withResolvers<void>();
    const finishRefresh = Promise.withResolvers<void>();
    const loginStarted = Promise.withResolvers<void>();
    let authCalls = 0;
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const grant = new URLSearchParams(String(init?.body)).get('grant_type');
      if (grant === 'refresh_token') {
        refreshStarted.resolve();
        await finishRefresh.promise;
        return response('old-refresh');
      }
      authCalls++;
      loginStarted.resolve();
      return response('new-login');
    });
    vi.stubGlobal('fetch', fetchImpl);
    const h = await createTestHarness(registerAuthTools);
    try {
      const refresh = createTokenManager(config, { storePath, fetchImpl }).getAccessToken();
      await refreshStarted.promise;
      // Either the fixed path attempts the held lock, or the broken path
      // reaches the token endpoint directly. No timing assumption is needed.
      hooks.beforeLock = () => loginStarted.resolve();
      const login = h.callTool('freshbooks_auth_exchange', { code: 'dummy-code' });
      await loginStarted.promise;
      const exchangedWhileRefreshing = authCalls;
      finishRefresh.resolve();
      const [, result] = await Promise.all([refresh, login]);
      expect(exchangedWhileRefreshing).toBe(0);
      expect(parseToolResult(result)).toMatchObject({ connected: true });
      expect(await createTokenManager(config, { storePath, fetchImpl }).getAccessToken())
        .toBe('dummy-access-new-login');
      expect(authCalls).toBe(1);
    } finally {
      finishRefresh.resolve();
      await h.close();
    }
  });

  it('cannot overwrite a newer login after releasing the refresh lock', async () => {
    const newer = {
      accessToken: 'dummy-access-new-login', refreshToken: 'dummy-refresh-new-login',
      expiresAt: Date.now() + 3_600_000,
    };
    hooks.afterUnlock = () => {
      hooks.afterUnlock = undefined;
      createFileStatePersistence<BearerTokens>({ filePath: storePath, boundTo: config.refreshToken }).save(newer);
    };
    const fetchImpl = vi.fn(async () => response('old-refresh'));
    await createTokenManager(config, { storePath, fetchImpl }).getAccessToken();
    expect(await createTokenManager(config, { storePath, fetchImpl }).getAccessToken())
      .toBe(newer.accessToken);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
