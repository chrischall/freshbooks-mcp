import { describe, it, expect, vi } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import type { FreshbooksClient } from '../src/client.js';

interface Result {
  ok: boolean;
  credential: { source: string | null; resolved: boolean; detail?: Record<string, unknown> };
  error?: { kind: string; message: string };
  hint: string;
}

function clientWith(
  state: { source: string | null; detail?: Record<string, unknown> },
  probe: () => Promise<unknown>,
  credentialError: string | null = null,
): FreshbooksClient {
  return {
    describeCredential: () => state,
    get credentialError() {
      return credentialError;
    },
    getIdentity: probe,
  } as unknown as FreshbooksClient;
}

async function call(client: FreshbooksClient) {
  const h = await createTestHarness((server) => registerHealthcheckTools(server, client));
  const res = await h.client.callTool({ name: 'freshbooks_healthcheck', arguments: {} });
  await h.close?.();
  return parseToolResult<Result>(res as never);
}

describe('freshbooks_healthcheck', () => {
  it('reports ok and echoes the rotation state', async () => {
    const r = await call(
      clientWith({ source: 'env', detail: { refresh_token: 'rotated' } }, async () => ({ accountId: 'a' })),
    );
    expect(r.ok).toBe(true);
    expect(r.credential.detail).toEqual({ refresh_token: 'rotated' });
  });

  // The stored config error names WHICH of the three vars are missing, which is
  // the whole question asked here — so it must reach the caller, not be
  // replaced by a generic "no credential".
  it('surfaces the config error verbatim when nothing resolved', async () => {
    const r = await call(
      clientWith({ source: null }, async () => ({}), 'FRESHBOOKS_CLIENT_SECRET is unset.'),
    );
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('no_credential');
    expect(r.error?.message).toMatch(/FRESHBOOKS_CLIENT_SECRET/);
  });

  it('does not probe when no credential resolved', async () => {
    let probed = false;
    await call(
      clientWith({ source: null }, async () => {
        probed = true;
        return {};
      }, 'unset'),
    );
    expect(probed).toBe(false);
  });

  it('names rotation as the likely cause of a rejection', async () => {
    const r = await call(
      clientWith({ source: 'env' }, async () => {
        throw Object.assign(new Error('Unauthorized'), { status: 401 });
      }),
    );
    expect(r.error?.kind).toBe('credential_rejected');
    expect(r.hint).toMatch(/rotate/i);
    // /rotate/i alone passed while this hint still carried local-only advice.
    // A healthcheck exists to tell someone what to DO, so assert the recovery
    // it names rather than merely that it mentions rotation.
    expect(r.hint, 'must defer to recoveryHint(), not restate it').toMatch(/reconnect|freshbooks_auth_url/i);
  });

  it('keeps a FreshBooks-side error distinct from a rejection', async () => {
    const r = await call(
      clientWith({ source: 'env' }, async () => {
        throw Object.assign(new Error('Bad gateway'), { status: 502 });
      }),
    );
    expect(r.error?.kind).toBe('http');
  });

  it('never reports a token value', async () => {
    const r = await call(clientWith({ source: 'env', detail: { refresh_token: 'rotated' } }, async () => ({})));
    expect(JSON.stringify(r)).not.toMatch(/[A-Za-z0-9_-]{40,}/);
  });
});
