// A hung FreshBooks connection must not hold a tool call open until the host
// kills it — and a write that times out must not read as "nothing happened".
// (chrischall/fleet-audit#1006)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FreshbooksClient } from '../src/client.js';

const IDENTITY = {
  response: {
    identity_id: 1,
    business_memberships: [{ business: { id: 7, account_id: 'acct', business_uuid: 'u', name: 'Acme' } }],
  },
};

/** Answers the token and identity calls, and hangs every other request until aborted. */
function hangingClient() {
  const signals: Array<AbortSignal | undefined> = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const u = String(url);
    if (u.includes('/auth/oauth/token')) {
      return new Response(
        JSON.stringify({ access_token: 'at', refresh_token: 'rt2', created_at: Math.floor(Date.now() / 1000), expires_in: 3600 }),
        { status: 200 },
      );
    }
    signals.push(init.signal ?? undefined);
    if (u.includes('/users/me')) return new Response(JSON.stringify(IDENTITY), { status: 200 });
    return new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
  }) as unknown as typeof fetch;
  return { signals, client: new FreshbooksClient({ fetchImpl, storePath: `/tmp/fb-timeout-${process.pid}.json` }) };
}

describe('request timeout', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.FRESHBOOKS_CLIENT_ID = 'cid';
    process.env.FRESHBOOKS_CLIENT_SECRET = 'csecret';
    process.env.FRESHBOOKS_REFRESH_TOKEN = 'rt';
    process.env.FRESHBOOKS_REQUEST_TIMEOUT_MS = '30';
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('passes an abort signal on every API request', async () => {
    const { signals, client } = hangingClient();
    await client.getIdentity();
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });

  it('bounds a hung read and says it timed out', async () => {
    const { client } = hangingClient();
    await expect(client.accountingGet('/invoices/invoices', 5, 'invoice')).rejects.toThrow(
      /did not respond within 30ms/,
    );
  });

  it('warns that a timed-out write may still have been recorded', async () => {
    const { client } = hangingClient();
    const err = await client
      .accountingWrite('/payments/payments', 'payment', { invoiceid: 5 })
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/did not respond within 30ms to POST /);
    expect(err.message).toMatch(/may have been recorded/i);
  });
});
