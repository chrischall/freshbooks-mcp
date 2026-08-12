// FreshBooks uses four different error envelopes across its six URL families, so a
// single generic parser is wrong for most of them. These pin each documented shape.
import { describe, it, expect } from 'vitest';
import { extractErrorMessage, FreshbooksClient } from '../src/client.js';

describe('extractErrorMessage', () => {
  it('reads the accounting shape (response.errors[])', () => {
    expect(
      extractErrorMessage({ response: { errors: [{ message: 'Client not found.', errno: 1012 }] } }),
    ).toBe('Client not found.');
  });

  it('reads a non-array accounting errors object', () => {
    expect(extractErrorMessage({ response: { errors: { message: 'Bad request', errno: 1001 } } })).toBe(
      'Bad request',
    );
  });

  it('reads the accounting-business shape (errors.details[].reason)', () => {
    expect(
      extractErrorMessage({
        errors: { message: 'Validation failed', details: [{ reason: 'name is required' }] },
      }),
    ).toBe('Validation failed (name is required)');
  });

  it('reads the payments shape (errors.details[].field)', () => {
    expect(
      extractErrorMessage({
        errors: { message: 'Invalid', details: [{ field: 'amount', message: 'must be positive' }] },
      }),
    ).toBe('amount: must be positive');
  });

  it('reads the projects/timetracking flat shape (error)', () => {
    expect(extractErrorMessage({ error: 'Not found' })).toBe('Not found');
  });

  it('returns null when nothing recognizable is present', () => {
    expect(extractErrorMessage({ unexpected: true })).toBeNull();
    expect(extractErrorMessage(null)).toBeNull();
    expect(extractErrorMessage('a string')).toBeNull();
  });
});

/** Build a client wired to a canned response, with credentials present. */
function clientWith(handler: (url: string, init: RequestInit) => Response, storePath: string) {
  const env = process.env;
  env.FRESHBOOKS_CLIENT_ID = 'cid';
  env.FRESHBOOKS_CLIENT_SECRET = 'csecret';
  env.FRESHBOOKS_REFRESH_TOKEN = 'rt';
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (String(url).includes('/auth/oauth/token')) {
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
    return handler(String(url), init);
  }) as unknown as typeof fetch;
  return new FreshbooksClient({ fetchImpl, storePath });
}

describe('FreshbooksClient', () => {
  it('resolves all three identifiers from /users/me', async () => {
    const c = clientWith(
      () =>
        new Response(
          JSON.stringify({
            response: {
              identity_id: 42,
              email: 'a@b.com',
              business_memberships: [
                { business: { id: 77213, account_id: 'xZNQ1X', business_uuid: 'uuid-1', name: 'Acme' } },
              ],
            },
          }),
          { status: 200 },
        ),
      '/tmp/fb-client-test-1.json',
    );
    const id = await c.getIdentity();
    expect(id).toMatchObject({
      accountId: 'xZNQ1X',
      businessId: 77213,
      businessUuid: 'uuid-1',
      email: 'a@b.com',
    });
  });

  it('fails usefully when the identity has no business membership', async () => {
    const c = clientWith(
      () => new Response(JSON.stringify({ response: { business_memberships: [] } }), { status: 200 }),
      '/tmp/fb-client-test-2.json',
    );
    await expect(c.getIdentity()).rejects.toThrow(/could not resolve a freshbooks account/i);
  });

  it('tells the caller a 404 is probably the wrong identifier, not a missing record', async () => {
    // The three ids are not interchangeable and FreshBooks just 404s — without this
    // hint the failure reads as "the invoice does not exist", which sends you hunting
    // in the wrong place entirely.
    const c = clientWith((url) => {
      if (url.includes('/users/me')) {
        return new Response(
          JSON.stringify({
            response: { business_memberships: [{ business: { id: 1, account_id: 'acct', business_uuid: 'u' } }] },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ response: { errors: [{ message: 'Not found', errno: 1012 }] } }), {
        status: 404,
      });
    }, '/tmp/fb-client-test-3.json');

    await expect(c.accountingGet('invoices/invoices', 9, 'invoice')).rejects.toMatchObject({
      hint: expect.stringMatching(/accountId|businessId|businessUuid/),
    });
  });

  it('unwraps the accounting envelope and surfaces pagination', async () => {
    const c = clientWith((url) => {
      if (url.includes('/users/me')) {
        return new Response(
          JSON.stringify({
            response: { business_memberships: [{ business: { id: 1, account_id: 'acct', business_uuid: 'u' } }] },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          response: { result: { invoices: [{ id: 1 }, { id: 2 }], page: 1, pages: 3, total: 25 } },
        }),
        { status: 200 },
      );
    }, '/tmp/fb-client-test-4.json');

    const res = await c.accountingList('invoices/invoices', 'invoices');
    expect(res.items).toHaveLength(2);
    expect(res).toMatchObject({ page: 1, pages: 3, total: 25 });
  });
});

describe('errors delivered with a 200 status (live-observed)', () => {
  // FreshBooks' accounting family returns some failures as HTTP 200 with an
  // `response.errors[]` body and NO `response.result`. Observed live: `items` on an
  // account without that feature answers 200 + errno 12001 "You do not have access to
  // items." Checking only `res.ok` turns that into a silently empty list, which reads
  // as "you have no items" rather than "you cannot see items".
  it('surfaces a 200 + response.errors body as an error, not an empty result', async () => {
    const c = clientWith((url) => {
      if (url.includes('/users/me')) {
        return new Response(
          JSON.stringify({
            response: { business_memberships: [{ business: { id: 1, account_id: 'acct', business_uuid: 'u' } }] },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          response: { errors: [{ errno: 12001, message: 'You do not have access to items.' }] },
        }),
        { status: 200 },
      );
    }, '/tmp/fb-client-test-5.json');

    await expect(c.accountingList('items/items', 'items')).rejects.toThrow(/do not have access to items/i);
  });
});

describe('accountId resolution (live-observed)', () => {
  // Live: business.account_id came back NULL on a real owner account, while the usable
  // accountId sat at roles[0].accountid. Trusting business.account_id alone makes every
  // accounting call target `/accounting/account/null/...`.
  it('falls back to roles[].accountid when business.account_id is null', async () => {
    const c = clientWith(
      () =>
        new Response(
          JSON.stringify({
            response: {
              identity_id: 1,
              email: 'a@b.com',
              roles: [{ role: 'client', accountid: 'XyM7Y3' }],
              business_memberships: [
                { role: 'owner', business: { id: 14754156, account_id: null, business_uuid: 'u', name: '' } },
              ],
            },
          }),
          { status: 200 },
        ),
      '/tmp/fb-client-test-6.json',
    );
    const id = await c.getIdentity();
    expect(id.accountId).toBe('XyM7Y3');
    expect(id.businessId).toBe(14754156);
  });

  it('falls back to business_clients[].account_id as a last resort', async () => {
    const c = clientWith(
      () =>
        new Response(
          JSON.stringify({
            response: {
              business_memberships: [
                {
                  business: {
                    id: 5,
                    account_id: null,
                    business_uuid: 'u',
                    business_clients: [{ account_id: 'ZZ9' }],
                  },
                },
              ],
            },
          }),
          { status: 200 },
        ),
      '/tmp/fb-client-test-7.json',
    );
    expect((await c.getIdentity()).accountId).toBe('ZZ9');
  });
});

describe('account role and 403 handling (live-observed)', () => {
  // Live finding: an identity can be OWNER of a business that has no accounting
  // account (business.account_id === null) while its only accounting role is
  // `client` on someone else's account. Reads succeed there; every write 403s.
  // A bare "Permission Denied" sends you looking at OAuth scopes, which are fine.
  it('reports the role held on the resolved account', async () => {
    const c = clientWith(
      () =>
        new Response(
          JSON.stringify({
            response: {
              roles: [{ role: 'client', accountid: 'XyM7Y3' }],
              business_memberships: [{ role: 'owner', business: { id: 1, account_id: null, business_uuid: 'u' } }],
            },
          }),
          { status: 200 },
        ),
      '/tmp/fb-client-test-8.json',
    );
    const id = await c.getIdentity();
    expect(id.accountId).toBe('XyM7Y3');
    expect(id.accountRole).toBe('client');
  });

  it('explains a 403 in terms of account role, not scopes', async () => {
    const c = clientWith((url) => {
      if (url.includes('/users/me')) {
        return new Response(
          JSON.stringify({
            response: {
              roles: [{ role: 'client', accountid: 'acct' }],
              business_memberships: [{ role: 'owner', business: { id: 1, account_id: null, business_uuid: 'u' } }],
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ response: { errors: [{ message: 'Permission Denied.' }] } }), {
        status: 403,
      });
    }, '/tmp/fb-client-test-9.json');

    await expect(c.accountingWrite('users/clients', 'client', { email: 'x@example.com' })).rejects.toMatchObject(
      { hint: expect.stringMatching(/client|owner|admin/i) },
    );
  });
});
