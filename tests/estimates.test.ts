// Estimate writes. The mechanism under test is FreshBooks' `action_accept` on the
// estimate itself — NOT a status field — so these assert the exact body that leaves
// the process, not just that a call happened.
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { FreshbooksClient } from '../src/client.js';
import { registerEstimateTools } from '../src/tools/estimates.js';

const IDENTITY = {
  response: {
    identity_id: 1,
    email: 'a@b.com',
    // Mirrors the live account: `owner` of a business, but only `client` on the
    // accounting account the estimate lives on.
    roles: [{ accountid: 'acct', role: 'client' }],
    business_memberships: [
      { role: 'owner', business: { id: 7, account_id: 'acct', business_uuid: 'u', name: 'Acme' } },
    ],
  },
};

/** Estimate 279405 as the live account returns it: viewed, not accepted. */
const OPEN_ESTIMATE = {
  id: 279405,
  estimateid: 279405,
  estimate_number: '0000654',
  accepted: false,
  invoiced: false,
  status: 3,
  display_status: 'viewed',
  ui_status: 'open',
  notes: '',
  terms: '1/2 Up Front and Rest upon Completion',
  description: 'Grind concrete, Install Moisture Vapor Barrier',
  amount: { amount: '800.00', code: 'USD' },
};

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

/**
 * A FreshBooks stand-in that actually holds an estimate: the accept path reads before
 * it writes and reads again after, so a fixed single response cannot exercise it.
 */
function estimateServer(
  opts: {
    estimate?: Record<string, unknown>;
    /** Applied to the stored estimate when a PUT arrives, standing in for FreshBooks. */
    onWrite?: (body: Record<string, unknown>, current: Record<string, unknown>) => Record<string, unknown>;
    /** Overrides the PUT response entirely (used for the permission paths). */
    writeResponse?: () => Response;
  } = {},
) {
  const requests: Recorded[] = [];
  let stored: Record<string, unknown> = { ...(opts.estimate ?? OPEN_ESTIMATE) };

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
    const method = init.method ?? 'GET';
    requests.push({ url: u, method, body: init.body });
    if (u.includes('/users/me')) return new Response(JSON.stringify(IDENTITY), { status: 200 });

    if (method === 'PUT') {
      if (opts.writeResponse) return opts.writeResponse();
      const sent = (JSON.parse(String(init.body)) as { estimate: Record<string, unknown> }).estimate;
      stored = opts.onWrite ? opts.onWrite(sent, stored) : { ...stored, ...sent };
    }
    return new Response(JSON.stringify({ response: { result: { estimate: stored } } }), { status: 200 });
  }) as unknown as typeof fetch;

  return {
    requests,
    puts: () => requests.filter((r) => r.method === 'PUT'),
    client: new FreshbooksClient({ fetchImpl, storePath: '/tmp/fb-estimates-test.json' }),
  };
}

const harnessFor = (client: FreshbooksClient) =>
  createTestHarness((s) => registerEstimateTools(s, client));

/** FreshBooks' own accept semantics: action_accept moves accepted/status/display_status. */
function acceptOnServer(sent: Record<string, unknown>, current: Record<string, unknown>) {
  if (sent.action_accept === true) {
    return { ...current, accepted: true, status: 5, display_status: 'accepted', ui_status: 'accepted' };
  }
  return { ...current, ...sent };
}

beforeEach(() => {
  process.env.FRESHBOOKS_CLIENT_ID = 'cid';
  process.env.FRESHBOOKS_CLIENT_SECRET = 'csecret';
  process.env.FRESHBOOKS_REFRESH_TOKEN = 'rt';
});

describe('freshbooks_accept_estimate', () => {
  it('sends action_accept on an open estimate and returns the moved state', async () => {
    const { client, requests, puts } = estimateServer({ onWrite: acceptOnServer });
    const h = await harnessFor(client);

    const res = parseToolResult(
      await h.callTool('freshbooks_accept_estimate', { id: 279405, confirm: true }),
    ) as Record<string, any>;

    // The exact mechanism: an action on the estimate, not a status write.
    expect(puts()).toHaveLength(1);
    expect(puts()[0].url).toContain('/accounting/account/acct/estimates/estimates/279405');
    expect(JSON.parse(String(puts()[0].body))).toEqual({ estimate: { action_accept: true } });

    expect(res.changed).toBe(true);
    expect(res.before).toEqual({ accepted: false, status: 3, display_status: 'viewed', ui_status: 'open', invoiced: false });
    expect(res.after.accepted).toBe(true);
    expect(res.after.status).toBe(5);
    // The full object comes back, not just the status — a caller can verify anything.
    expect(res.estimate.estimate_number).toBe('0000654');
    expect(res.estimate.amount).toEqual({ amount: '800.00', code: 'USD' });

    // Read, write, read: the after-state is re-fetched rather than assumed from the 200.
    expect(requests.filter((r) => r.method === 'GET' && r.url.includes('/estimates/'))).toHaveLength(2);
    await h.close();
  });

  it('is a no-op on an already-accepted estimate', async () => {
    const { client, puts } = estimateServer({
      estimate: { ...OPEN_ESTIMATE, accepted: true, status: 5, display_status: 'accepted', ui_status: 'accepted' },
    });
    const h = await harnessFor(client);

    const res = parseToolResult(
      await h.callTool('freshbooks_accept_estimate', { id: 279405, confirm: true }),
    ) as Record<string, any>;

    expect(res.alreadyAccepted).toBe(true);
    expect(res.changed).toBe(false);
    expect(res.estimate.id).toBe(279405);
    // Idempotent means NO second acceptance leaves the process, not just a tidy reply.
    expect(puts()).toHaveLength(0);
    await h.close();
  });

  it('treats an invoiced estimate as already accepted', async () => {
    const { client, puts } = estimateServer({
      estimate: { ...OPEN_ESTIMATE, accepted: false, invoiced: true, status: 6, ui_status: 'invoiced' },
    });
    const h = await harnessFor(client);
    const res = parseToolResult(
      await h.callTool('freshbooks_accept_estimate', { id: 279405, confirm: true }),
    ) as Record<string, any>;
    expect(res.alreadyAccepted).toBe(true);
    expect(puts()).toHaveLength(0);
    await h.close();
  });

  it('previews without confirm and sends nothing at all', async () => {
    const { client, requests } = estimateServer();
    const h = await harnessFor(client);
    const res = parseToolResult(await h.callTool('freshbooks_accept_estimate', { id: 279405 })) as Record<
      string,
      unknown
    >;
    expect(res.dryRun).toBe(true);
    expect(res.willSend).toEqual({ estimate: { action_accept: true } });
    expect(requests).toHaveLength(0);
    await h.close();
  });
});

describe('freshbooks_decline_estimate', () => {
  it('fails with the reason and sends no request', async () => {
    const { client, requests } = estimateServer();
    const h = await harnessFor(client);

    const res = await h.callTool('freshbooks_decline_estimate', { id: 279405, confirm: true });

    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    expect(text).toMatch(/no decline operation/i);
    // The alternatives matter more than the refusal: a caller must not be left guessing.
    expect(text).toMatch(/vis_state/);
    expect(requests).toHaveLength(0);
    await h.close();
  });
});

describe('freshbooks_update_estimate', () => {
  it('sends only the supplied fields and leaves the rest alone', async () => {
    const { client, puts } = estimateServer();
    const h = await harnessFor(client);

    const res = parseToolResult(
      await h.callTool('freshbooks_update_estimate', {
        id: 279405,
        notes: 'Deposit received 2026-08-13',
        confirm: true,
      }),
    ) as Record<string, any>;

    // Partial means partial: terms/description/lines must not be echoed back as writes,
    // which would silently overwrite whatever changed on FreshBooks' side since the read.
    expect(JSON.parse(String(puts()[0].body))).toEqual({
      estimate: { notes: 'Deposit received 2026-08-13' },
    });
    expect(res.sentFields).toEqual(['notes']);
    expect(res.estimate.notes).toBe('Deposit received 2026-08-13');
    expect(res.estimate.terms).toBe('1/2 Up Front and Rest upon Completion');
    expect(res.estimate.description).toBe('Grind concrete, Install Moisture Vapor Barrier');
    await h.close();
  });

  it('merges typed fields with the raw escape hatch', async () => {
    const { client, puts } = estimateServer();
    const h = await harnessFor(client);
    await h.callTool('freshbooks_update_estimate', {
      id: 279405,
      terms: 'Net 30',
      presentation: { theme_primary_color: '#4f697a' },
      lines: [{ name: 'Epoxy flake', qty: 1, unit_cost: { amount: '800.00', code: 'USD' } }],
      fields: { vis_state: 0 },
      confirm: true,
    });
    expect(JSON.parse(String(puts()[0].body))).toEqual({
      estimate: {
        terms: 'Net 30',
        presentation: { theme_primary_color: '#4f697a' },
        lines: [{ name: 'Epoxy flake', qty: 1, unit_cost: { amount: '800.00', code: 'USD' } }],
        vis_state: 0,
      },
    });
    await h.close();
  });

  it('refuses an empty update rather than sending a no-op write', async () => {
    const { client, requests } = estimateServer();
    const h = await harnessFor(client);
    const res = await h.callTool('freshbooks_update_estimate', { id: 279405, confirm: true });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/nothing to update/i);
    expect(requests).toHaveLength(0);
    await h.close();
  });
});

describe('freshbooks_send_estimate', () => {
  it('sends action_email with the estimate-specific customized-email key', async () => {
    const { client, puts } = estimateServer();
    const h = await harnessFor(client);
    await h.callTool('freshbooks_send_estimate', {
      id: 279405,
      email_recipients: ['vendor@example.com'],
      subject: 'Accepted — please invoice',
      confirm: true,
    });
    // `estimate_customized_email`, NOT the invoice endpoint's `invoice_customized_email`.
    expect(JSON.parse(String(puts()[0].body))).toEqual({
      estimate: {
        action_email: true,
        email_recipients: ['vendor@example.com'],
        estimate_customized_email: { subject: 'Accepted — please invoice' },
      },
    });
    await h.close();
  });

  it('omits the recipient list so FreshBooks uses the client address on file', async () => {
    const { client, puts } = estimateServer();
    const h = await harnessFor(client);
    await h.callTool('freshbooks_send_estimate', { id: 279405, confirm: true });
    expect(JSON.parse(String(puts()[0].body))).toEqual({ estimate: { action_email: true } });
    await h.close();
  });
});

describe('permission boundaries', () => {
  it('names the role when the write is refused with 403', async () => {
    const { client } = estimateServer({
      writeResponse: () =>
        new Response(JSON.stringify({ response: { errors: [{ message: 'Permission Denied', errno: 1003 }] } }), {
          status: 403,
        }),
    });
    const h = await harnessFor(client);
    const res = await h.callTool('freshbooks_accept_estimate', { id: 279405, confirm: true });
    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    expect(text).toMatch(/denied/i);
    // The role is the answer here — a bare "Permission Denied" sends the reader to scopes.
    expect(text).toMatch(/role on account acct is .*client/);
    expect(text).toMatch(/owner or admin/);
    await h.close();
  });

  it('classifies a permission refusal that arrives as HTTP 200 + errno 1003', async () => {
    // The accounting family really does answer some refusals with a 200. Left to the
    // generic branch this reads as "failed (HTTP 200)", which looks like a client bug.
    const { client } = estimateServer({
      writeResponse: () =>
        new Response(JSON.stringify({ response: { errors: [{ message: 'Permission Denied', errno: 1003 }] } }), {
          status: 200,
        }),
    });
    const h = await harnessFor(client);
    const res = await h.callTool('freshbooks_accept_estimate', { id: 279405, confirm: true });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/owner or admin/);
    await h.close();
  });

  it('reads a 404 on the write of a readable estimate as a permission boundary', async () => {
    const { client } = estimateServer({
      writeResponse: () =>
        new Response(JSON.stringify({ response: { errors: [{ message: 'Not Found', errno: 1012 }] } }), {
          status: 404,
        }),
    });
    const h = await harnessFor(client);
    const res = await h.callTool('freshbooks_accept_estimate', { id: 279405, confirm: true });
    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    expect(text).toMatch(/the record exists/);
    expect(text).toMatch(/permission boundary/);
    await h.close();
  });
});

describe('identifier guards', () => {
  it('rejects the businessId in the estimate-id slot before any write', async () => {
    const { client, puts } = estimateServer();
    const h = await harnessFor(client);
    // 7 is the businessId in this identity — a plausible copy/paste, and one FreshBooks
    // would answer with a bare 404.
    const res = await h.callTool('freshbooks_accept_estimate', { id: 7, confirm: true });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/businessId, not an estimate id/);
    expect(puts()).toHaveLength(0);
    await h.close();
  });

  it('rejects an accountId override that is really the businessUuid', async () => {
    process.env.FRESHBOOKS_ACCOUNT_ID = 'u';
    try {
      const { client, puts } = estimateServer();
      const h = await harnessFor(client);
      const res = await h.callTool('freshbooks_accept_estimate', { id: 279405, confirm: true });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toMatch(/businessUuid/);
      expect(puts()).toHaveLength(0);
      await h.close();
    } finally {
      delete process.env.FRESHBOOKS_ACCOUNT_ID;
    }
  });
});
