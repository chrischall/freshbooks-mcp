// The confirm gate on every write: a client that cannot be prompted gets a preview and
// a single-use confirmToken bound to the exact arguments; one that can be prompted gets
// the real prompt. Asserted on what leaves the process, not on the result text alone.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestHarness, parseToolResult, type TestHarnessOptions } from '@chrischall/mcp-utils/test';
import { FreshbooksClient } from '../src/client.js';
import { registerEstimateTools } from '../src/tools/estimates.js';
import { registerExpenseTools } from '../src/tools/expenses.js';
import { registerInvoicingTools } from '../src/tools/invoicing.js';
import { registerProjectTools } from '../src/tools/projects.js';

const IDENTITY = {
  response: {
    identity_id: 1,
    email: 'a@b.com',
    business_memberships: [{ business: { id: 7, account_id: 'acct', business_uuid: 'u', name: 'Acme' } }],
  },
};

const ESTIMATE = { id: 279405, customerid: 555, accepted: false, invoiced: false, status: 3 };

/** A FreshBooks stand-in answering every write tool's shape; records every non-token request. */
function server() {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const u = String(url);
    if (u.includes('/auth/oauth/token')) {
      return new Response(
        JSON.stringify({ access_token: 'at', refresh_token: 'rt2', created_at: Math.floor(Date.now() / 1000), expires_in: 3600 }),
        { status: 200 },
      );
    }
    requests.push({ url: u, method: init.method ?? 'GET', body: init.body });
    if (u.includes('/users/me')) return new Response(JSON.stringify(IDENTITY), { status: 200 });
    return new Response(
      JSON.stringify({
        response: {
          result: {
            estimate: ESTIMATE,
            invoice: { id: 99 },
            client: { id: 3 },
            payment: { id: 4 },
            expense: { id: 5 },
          },
        },
        project: { id: 6 },
        time_entry: { id: 8 },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const client = new FreshbooksClient({ fetchImpl, storePath: '/tmp/fb-confirm-test.json' });
  return { requests, writes: () => requests.filter((r) => r.method !== 'GET'), client };
}

async function harness(client: FreshbooksClient, options?: TestHarnessOptions) {
  return createTestHarness((s) => {
    registerInvoicingTools(s, client);
    registerEstimateTools(s, client);
    registerExpenseTools(s, client);
    registerProjectTools(s, client);
  }, options);
}

const WRITES: Array<[string, Record<string, unknown>, string, string]> = [
  ['freshbooks_create_client', { email: 'x@example.com' }, 'POST', '/accounting/account/acct/users/clients'],
  ['freshbooks_create_invoice', { customerid: 1 }, 'POST', '/accounting/account/acct/invoices/invoices'],
  ['freshbooks_update_invoice', { id: 5, fields: { notes: 'hi' } }, 'PUT', '/invoices/invoices/5'],
  [
    'freshbooks_record_payment',
    { invoiceid: 5, amount: { amount: '10.00', code: 'USD' } },
    'POST',
    '/accounting/account/acct/payments/payments',
  ],
  ['freshbooks_accept_estimate', { id: 279405 }, 'PUT', '/estimates/estimates/279405'],
  ['freshbooks_update_estimate', { id: 279405, notes: 'hi' }, 'PUT', '/estimates/estimates/279405'],
  ['freshbooks_send_estimate', { id: 279405 }, 'PUT', '/estimates/estimates/279405'],
  [
    'freshbooks_create_expense',
    { amount: { amount: '10.00', code: 'USD' } },
    'POST',
    '/accounting/account/acct/expenses/expenses',
  ],
  ['freshbooks_create_project', { title: 'Patio' }, 'POST', '/projects/business/7/projects'],
  [
    'freshbooks_create_time_entry',
    { duration: 3600, started_at: '2026-08-12T09:00:00Z' },
    'POST',
    '/timetracking/business/7/time_entries',
  ],
];

const savedEnv = { ...process.env };

beforeEach(() => {
  process.env.FRESHBOOKS_CLIENT_ID = 'cid';
  process.env.FRESHBOOKS_CLIENT_SECRET = 'csecret';
  process.env.FRESHBOOKS_REFRESH_TOKEN = 'rt';
  delete process.env.MCP_CONFIRM_MODE;
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

describe('confirm token flow (client cannot be prompted)', () => {
  it.each(WRITES)('%s: phase 1 previews and sends nothing; phase 2 writes once', async (tool, args, method, path) => {
    const { requests, writes, client } = server();
    const h = await harness(client);

    const first = parseToolResult(await h.callTool(tool, args)) as Record<string, any>;
    expect(first.status).toBe('confirmation-required');
    expect(first.dispatched).toBe(false);
    expect(typeof first.confirmToken).toBe('string');
    expect(first.preview.method).toBe(method);
    expect(first.preview.path).toBeDefined();
    expect(first.preview.willSend).toBeDefined();
    // Nothing left the process — not even an identity read.
    expect(requests).toHaveLength(0);

    const second = await h.callTool(tool, { ...args, confirmToken: first.confirmToken });
    expect(second.isError).toBeFalsy();
    expect(writes()).toHaveLength(1);
    expect(writes()[0].method).toBe(method);
    expect(writes()[0].url).toContain(path);
    await h.close();
  });

  it('preview carries the exact payload that is then sent', async () => {
    const { writes, client } = server();
    const h = await harness(client);
    const first = parseToolResult(
      await h.callTool('freshbooks_create_invoice', { customerid: 1, notes: 'n' }),
    ) as Record<string, any>;
    expect(first.preview).toMatchObject({
      action: 'Create FreshBooks invoice',
      method: 'POST',
      path: 'invoices/invoices',
      willSend: { invoice: { customerid: 1, notes: 'n' } },
    });
    await h.callTool('freshbooks_create_invoice', { customerid: 1, notes: 'n', confirmToken: first.confirmToken });
    expect(JSON.parse(String(writes()[0].body))).toEqual({ invoice: { customerid: 1, notes: 'n' } });
    await h.close();
  });

  it('send_estimate preview names the recipients and the unchecked-recipient warning', async () => {
    const { client } = server();
    const h = await harness(client);
    const first = parseToolResult(
      await h.callTool('freshbooks_send_estimate', {
        id: 279405,
        email_recipients: ['a@x.example'],
        allow_non_client_recipients: true,
      }),
    ) as Record<string, any>;
    expect(first.preview.recipients).toEqual(['a@x.example']);
    expect(first.preview.warning).toMatch(/NOT be checked/);
    await h.close();
  });

  it('update_invoice preview names the recipients and the unchecked-recipient warning', async () => {
    const { client } = server();
    const h = await harness(client);
    const first = parseToolResult(
      await h.callTool('freshbooks_update_invoice', {
        id: 5,
        fields: { email_recipients: ['a@x.example'] },
        allow_non_client_recipients: true,
      }),
    ) as Record<string, any>;
    expect(first.preview.recipients).toEqual(['a@x.example']);
    expect(first.preview.warning).toMatch(/NOT be checked/);
    await h.close();
  });

  it('update_invoice preview carries no warning when recipients are checked', async () => {
    const { client } = server();
    const h = await harness(client);
    const first = parseToolResult(
      await h.callTool('freshbooks_update_invoice', {
        id: 5,
        fields: { email_recipients: ['a@x.example'] },
      }),
    ) as Record<string, any>;
    expect(first.preview.recipients).toEqual(['a@x.example']);
    expect(first.preview.warning).toBeUndefined();
    await h.close();
  });

  it('refuses a replayed token with TOKEN_REUSED and writes nothing more', async () => {
    const { writes, client } = server();
    const h = await harness(client);
    const args = { customerid: 1 };
    const first = parseToolResult(await h.callTool('freshbooks_create_invoice', args)) as Record<string, any>;
    await h.callTool('freshbooks_create_invoice', { ...args, confirmToken: first.confirmToken });
    expect(writes()).toHaveLength(1);

    const replay = await h.callTool('freshbooks_create_invoice', { ...args, confirmToken: first.confirmToken });
    expect(replay.isError).toBe(true);
    expect((parseToolResult(replay) as Record<string, any>).error).toBe('TOKEN_REUSED');
    expect(writes()).toHaveLength(1);
    await h.close();
  });

  it('refuses a token when an argument changed between the phases (DRAFT_CHANGED)', async () => {
    const { requests, client } = server();
    const h = await harness(client);
    const first = parseToolResult(
      await h.callTool('freshbooks_record_payment', { invoiceid: 5, amount: { amount: '10.00', code: 'USD' } }),
    ) as Record<string, any>;
    const changed = await h.callTool('freshbooks_record_payment', {
      invoiceid: 5,
      amount: { amount: '1000.00', code: 'USD' },
      confirmToken: first.confirmToken,
    });
    expect(changed.isError).toBe(true);
    expect((parseToolResult(changed) as Record<string, any>).error).toBe('DRAFT_CHANGED');
    expect(requests).toHaveLength(0);
    await h.close();
  });

  it('binds allow_non_client_recipients into the token', async () => {
    const { requests, client } = server();
    const h = await harness(client);
    const args = { id: 279405, email_recipients: ['a@x.example'] };
    const first = parseToolResult(await h.callTool('freshbooks_send_estimate', args)) as Record<string, any>;
    const changed = await h.callTool('freshbooks_send_estimate', {
      ...args,
      allow_non_client_recipients: true,
      confirmToken: first.confirmToken,
    });
    expect((parseToolResult(changed) as Record<string, any>).error).toBe('DRAFT_CHANGED');
    expect(requests).toHaveLength(0);
    await h.close();
  });

  it('refuses writes with confirmation-unsupported under MCP_CONFIRM_MODE=refuse', async () => {
    process.env.MCP_CONFIRM_MODE = 'refuse';
    const { requests, client } = server();
    const h = await harness(client);
    const res = parseToolResult(
      await h.callTool('freshbooks_create_expense', { amount: { amount: '10.00', code: 'USD' } }),
    ) as Record<string, any>;
    expect(res.reason).toBe('confirmation-unsupported');
    expect(res.dispatched).toBe(false);
    expect(res.confirmToken).toBeUndefined();
    expect(requests).toHaveLength(0);
    await h.close();
  });

  it('no longer takes confirm: true as approval', async () => {
    const { requests, client } = server();
    const h = await harness(client);
    const res = parseToolResult(
      await h.callTool('freshbooks_create_project', { title: 'Patio', confirm: true }),
    ) as Record<string, any>;
    expect(res.status).toBe('confirmation-required');
    expect(requests).toHaveLength(0);
    await h.close();
  });
});

describe('confirm prompt (client can be prompted)', () => {
  it('writes once the user accepts the prompt', async () => {
    const { writes, client } = server();
    const h = await harness(client, {
      elicitation: async () => ({ action: 'accept', content: { confirmed: true } }),
    });
    const res = await h.callTool('freshbooks_create_time_entry', { duration: 60, started_at: '2026-08-12T09:00:00Z' });
    expect(res.isError).toBeFalsy();
    expect(writes()).toHaveLength(1);
    await h.close();
  });

  it('writes nothing when the user declines', async () => {
    const { requests, client } = server();
    const h = await harness(client, { elicitation: async () => ({ action: 'decline' }) });
    const res = parseToolResult(
      await h.callTool('freshbooks_create_time_entry', { duration: 60, started_at: '2026-08-12T09:00:00Z' }),
    ) as Record<string, any>;
    expect(res.confirmed).toBe(false);
    expect(requests).toHaveLength(0);
    await h.close();
  });
});
