import { describe, it, expect, beforeEach } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { FreshbooksClient } from '../src/client.js';
import { registerAccountTools } from '../src/tools/account.js';
import { registerInvoicingTools } from '../src/tools/invoicing.js';

const IDENTITY = {
  response: {
    identity_id: 1,
    email: 'a@b.com',
    business_memberships: [{ business: { id: 7, account_id: 'acct', business_uuid: 'u', name: 'Acme' } }],
  },
};

/** Track every non-token request so we can assert a gated write sent nothing. */
function trackedClient() {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const u = String(url);
    if (u.includes('/auth/oauth/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'at',
          refresh_token: 'rt2',
          created_at: Math.floor(Date.now() / 1000),
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }
    requests.push({ url: u, method: init.method ?? 'GET', body: init.body });
    if (u.includes('/users/me')) return new Response(JSON.stringify(IDENTITY), { status: 200 });
    return new Response(JSON.stringify({ response: { result: { invoice: { id: 99 } } } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { requests, client: new FreshbooksClient({ fetchImpl, storePath: '/tmp/fb-tools-test.json' }) };
}

beforeEach(() => {
  process.env.FRESHBOOKS_CLIENT_ID = 'cid';
  process.env.FRESHBOOKS_CLIENT_SECRET = 'csecret';
  process.env.FRESHBOOKS_REFRESH_TOKEN = 'rt';
});

describe('tool roster', () => {
  it('registers the invoicing surface', async () => {
    const { client } = trackedClient();
    const h = await createTestHarness((s) => {
      registerAccountTools(s, client);
      registerInvoicingTools(s, client);
    });
    const names = (await h.listTools()).map((t) => t.name).sort();
    expect(names).toContain('freshbooks_get_identity');
    expect(names).toContain('freshbooks_list_invoices');
    expect(names).toContain('freshbooks_get_invoice');
    expect(names).toContain('freshbooks_create_invoice');
    expect(names).toContain('freshbooks_record_payment');
    // Guard against an accidental drop, without pinning an exact count that a
    // parallel PR would break (PR CI runs the branch merged with main).
    expect(names.length).toBeGreaterThanOrEqual(14);
    await h.close();
  });
});

describe('confirm gate', () => {
  const writes: Array<[string, Record<string, unknown>]> = [
    ['freshbooks_create_invoice', { customerid: 1 }],
    ['freshbooks_create_client', { email: 'x@example.com' }],
    ['freshbooks_update_invoice', { id: 5, fields: { notes: 'hi' } }],
    ['freshbooks_record_payment', { invoiceid: 5, amount: { amount: '10.00', code: 'USD' } }],
  ];

  it.each(writes)('%s sends NO request without confirm', async (tool, args) => {
    // The property that matters is that nothing left the process — asserting only
    // that a preview came back would pass even if the write had also fired.
    const { requests, client } = trackedClient();
    const h = await createTestHarness((s) => registerInvoicingTools(s, client));
    const res = parseToolResult(await h.callTool(tool, args)) as Record<string, unknown>;
    expect(res.dryRun).toBe(true);
    expect(requests).toHaveLength(0);
    await h.close();
  });

  it('sends the write once confirm is true, wrapped in the singular resource key', async () => {
    const { requests, client } = trackedClient();
    const h = await createTestHarness((s) => registerInvoicingTools(s, client));
    await h.callTool('freshbooks_create_invoice', { customerid: 1, confirm: true });

    const write = requests.find((r) => r.method === 'POST');
    expect(write?.url).toContain('/accounting/account/acct/invoices/invoices');
    expect(JSON.parse(String(write?.body))).toEqual({ invoice: { customerid: 1 } });
    await h.close();
  });
});

describe('deferred config error', () => {
  it('boots without credentials and fails only on the first tool call', async () => {
    delete process.env.FRESHBOOKS_CLIENT_ID;
    delete process.env.FRESHBOOKS_CLIENT_SECRET;
    delete process.env.FRESHBOOKS_REFRESH_TOKEN;
    const client = new FreshbooksClient({ storePath: '/tmp/fb-noconf.json' });
    const h = await createTestHarness((s) => registerAccountTools(s, client));

    // tools/list must still work — the host probes it at install time.
    expect((await h.listTools()).length).toBeGreaterThan(0);

    const res = await h.callTool('freshbooks_get_identity');
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/not configured/i);
    await h.close();
  });
});
