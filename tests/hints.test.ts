// Context-group hints (`_meta.mint`, the mcp-host context-groups contract):
// read off `tools/list`, which is what a host sees, for every tool this server
// serves. Only the mcp-utils healthcheck goes unhinted — it takes no `_meta`
// and joins no group.
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { FreshbooksClient } from '../src/client.js';
import { registerAccountTools } from '../src/tools/account.js';
import { registerAuthTools } from '../src/tools/auth.js';
import { registerEstimateTools } from '../src/tools/estimates.js';
import { registerExpenseTools } from '../src/tools/expenses.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { registerInvoicingTools } from '../src/tools/invoicing.js';
import { registerProjectTools } from '../src/tools/projects.js';
import { registerRecordTools } from '../src/tools/records.js';

type Mint = {
  domain?: string;
  intent?: string;
  canonical?: boolean;
  subject?: string;
  when?: { start: string; end: string };
  aliases?: string[];
};
type Listed = {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  inputSchema: { properties?: Record<string, { enum?: unknown[] }> };
  _meta?: { mint?: Mint };
};

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const READ_INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'other'];
const WRITE_INTENTS = ['turn-on-off', 'send', 'change', 'other'];
const CANONICAL_INTENTS = ['whats-new', 'whats-due', 'whats-on'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];

/** The intent every tool declares — this table is the assertion, so a new tool cannot skip the decision. */
const EXPECTED_INTENT: Record<string, string> = {
  freshbooks_auth_url: 'other',
  freshbooks_auth_exchange: 'other',
  freshbooks_get_identity: 'lookup',
  freshbooks_list_invoices: 'whats-due',
  freshbooks_get_invoice: 'lookup',
  freshbooks_list_clients: 'lookup',
  freshbooks_get_client: 'lookup',
  freshbooks_list_estimates: 'lookup',
  freshbooks_get_estimate: 'lookup',
  freshbooks_list_payments: 'lookup',
  freshbooks_get_payment: 'lookup',
  freshbooks_list_items: 'lookup',
  freshbooks_get_item: 'lookup',
  freshbooks_create_client: 'change',
  freshbooks_create_invoice: 'change',
  freshbooks_update_invoice: 'change',
  freshbooks_record_payment: 'change',
  freshbooks_accept_estimate: 'change',
  freshbooks_decline_estimate: 'other',
  freshbooks_update_estimate: 'change',
  freshbooks_send_estimate: 'send',
  freshbooks_list_expenses: 'lookup',
  freshbooks_get_expense: 'lookup',
  freshbooks_list_expense_categories: 'lookup',
  freshbooks_create_expense: 'change',
  freshbooks_list_projects: 'lookup',
  freshbooks_get_project: 'lookup',
  freshbooks_create_project: 'change',
  freshbooks_list_time_entries: 'lookup',
  freshbooks_create_time_entry: 'change',
  freshbooks_list_services: 'lookup',
  freshbooks_list_records: 'lookup',
  freshbooks_get_record: 'lookup',
};

const INVOICES = [
  {
    id: 11,
    invoice_number: '0000101',
    organization: 'Example Studio',
    due_date: '2026-11-20',
    v3_status: 'overdue',
    outstanding: { amount: '150.00', code: 'USD' },
  },
  {
    id: 12,
    invoice_number: '0000102',
    fname: 'Sam',
    lname: 'Sample',
    v3_status: 'draft',
    amount: { amount: '75.50', code: 'USD' },
  },
  {
    id: 13,
    invoice_number: '0000103',
    organization: 'A client with a very long organization name that keeps going well past any sensible width',
    due_date: '2026-12-01',
    payment_status: 'unpaid',
    outstanding: { amount: '1200.00', code: 'USD' },
  },
  { id: 14 },
];

const IDENTITY = {
  response: {
    identity_id: 1,
    email: 'owner@example.com',
    business_memberships: [{ business: { id: 7, account_id: 'acct', business_uuid: 'u', name: 'Example' } }],
  },
};

function stubClient(): { client: FreshbooksClient; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    const u = String(url);
    if (u.includes('/auth/oauth/token')) {
      return new Response(
        JSON.stringify({ access_token: 'at', refresh_token: 'rt2', created_at: Math.floor(Date.now() / 1000), expires_in: 3600 }),
        { status: 200 },
      );
    }
    urls.push(u);
    if (u.includes('/users/me')) return new Response(JSON.stringify(IDENTITY), { status: 200 });
    return new Response(
      JSON.stringify({ response: { result: { invoices: INVOICES, page: 1, pages: 1, total: INVOICES.length } } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { urls, client: new FreshbooksClient({ fetchImpl, storePath: '/tmp/fb-hints-test.json' }) };
}

async function harness() {
  const { client, urls } = stubClient();
  const h = await createTestHarness((s) => {
    registerAuthTools(s);
    registerAccountTools(s, client);
    registerHealthcheckTools(s, client);
    registerInvoicingTools(s, client);
    registerEstimateTools(s, client);
    registerExpenseTools(s, client);
    registerProjectTools(s, client);
    registerRecordTools(s, client);
  });
  return { h, urls };
}

async function served(): Promise<Listed[]> {
  const { h } = await harness();
  const { tools } = await h.client.listTools();
  await h.close();
  return tools as unknown as Listed[];
}

beforeEach(() => {
  process.env.FRESHBOOKS_CLIENT_ID = 'cid';
  process.env.FRESHBOOKS_CLIENT_SECRET = 'csecret';
  process.env.FRESHBOOKS_REFRESH_TOKEN = 'rt';
});

describe('_meta.mint on tools/list', () => {
  it('names every served tool, so a new tool cannot skip the decision', async () => {
    const names = (await served()).map((t) => t.name).filter((n) => n !== 'freshbooks_healthcheck');
    expect(names.sort()).toEqual(Object.keys(EXPECTED_INTENT).sort());
  });

  it('leaves only the mcp-utils healthcheck unhinted', async () => {
    const unhinted = (await served()).filter((t) => !t._meta?.mint).map((t) => t.name);
    expect(unhinted).toEqual(['freshbooks_healthcheck']);
  });

  it('every other tool is in the money domain with the intent that fits', async () => {
    for (const t of await served()) {
      if (t.name === 'freshbooks_healthcheck') continue;
      const m = t._meta!.mint!;
      expect(m.domain, t.name).toBe('money');
      expect(m.intent, t.name).toBe(EXPECTED_INTENT[t.name]);
    }
  });

  it('every hint is shaped per the host contract', async () => {
    for (const t of await served()) {
      const m = t._meta?.mint;
      if (!m) continue;
      const props = t.inputSchema.properties ?? {};
      expect(Object.keys(m).filter((k) => !KEYS.includes(k)), t.name).toEqual([]);
      expect(DOMAINS, t.name).toContain(m.domain);
      expect(INTENTS, t.name).toContain(m.intent);
      if (t.annotations?.readOnlyHint === true) expect(READ_INTENTS, t.name).toContain(m.intent);
      else expect(WRITE_INTENTS, t.name).toContain(m.intent);
      if ('canonical' in m) {
        expect(m.canonical, t.name).toBe(true);
        expect(t.annotations?.readOnlyHint, t.name).toBe(true);
        expect(CANONICAL_INTENTS, t.name).toContain(m.intent);
      }
      if (m.subject !== undefined) expect(props, t.name).toHaveProperty(m.subject);
      if (m.when !== undefined) {
        expect(Object.keys(m.when).sort(), t.name).toEqual(['end', 'start']);
        expect(props, t.name).toHaveProperty(m.when.start);
        expect(props, t.name).toHaveProperty(m.when.end);
      }
      if (m.aliases !== undefined) {
        expect(m.aliases.length, t.name).toBeGreaterThan(0);
        expect(m.aliases.length, t.name).toBeLessThanOrEqual(8);
        for (const a of m.aliases) {
          expect(a.length, t.name).toBeLessThanOrEqual(40);
          expect(a, t.name).toBe(a.toLowerCase());
        }
      }
    }
  });

  it('marks at most one canonical read per intent: the invoice list for whats-due', async () => {
    const canonical = (await served()).filter((t) => t._meta?.mint?.canonical === true);
    const intents = canonical.map((t) => t._meta!.mint!.intent);
    expect(new Set(intents).size).toBe(intents.length);
    expect(canonical.map((t) => [t.name, t._meta!.mint!.intent])).toEqual([['freshbooks_list_invoices', 'whats-due']]);
  });

  it('the canonical invoice read names no subject (FreshBooks has no listable subjects) and carries spoken words', async () => {
    const invoices = (await served()).find((t) => t.name === 'freshbooks_list_invoices')!;
    expect(invoices._meta!.mint).toEqual({
      domain: 'money',
      intent: 'whats-due',
      canonical: true,
      aliases: ['invoices', 'unpaid', 'overdue', 'outstanding', 'owed', 'billing'],
    });
  });

  it('every canonical read accepts view: brief', async () => {
    for (const t of (await served()).filter((x) => x._meta?.mint?.canonical === true)) {
      expect(t.inputSchema.properties?.view?.enum, t.name).toEqual(['full', 'brief']);
    }
  });
});

describe('freshbooks_list_invoices view: brief', () => {
  it('answers one line per invoice, ≤ 120 chars, "title — <ISO date | no date> — <status>"', async () => {
    const { h } = await harness();
    const res = await h.callTool('freshbooks_list_invoices', { view: 'brief' });
    await h.close();
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    const lines = text.split('\n');
    expect(lines).toHaveLength(INVOICES.length);
    for (const line of lines) {
      expect(line.length, line).toBeLessThanOrEqual(120);
      expect(line, line).toMatch(/^.+ — (\d{4}-\d{2}-\d{2}|no date) — \S.*$/);
    }
    expect(lines[0]).toBe('Invoice 0000101, Example Studio, 150.00 USD — 2026-11-20 — overdue');
    expect(lines[1]).toBe('Invoice 0000102, Sam Sample, 75.50 USD — no date — draft');
    expect(lines[2]).toMatch(/^Invoice 0000103, A client with a very long .*… — 2026-12-01 — unpaid$/);
    expect(lines[3]).toBe('Invoice 14 — no date — no status');
  });

  it('passes the page and filters through, the same request the full view sends', async () => {
    const { h, urls } = await harness();
    await h.callTool('freshbooks_list_invoices', { view: 'brief', page: 2, search: { 'search[customerid]': 5 } });
    await h.close();
    const list = urls.find((u) => u.includes('/invoices/invoices'))!;
    expect(list).toContain('page=2');
    expect(decodeURIComponent(list)).toContain('search[customerid]=5');
  });

  it('keeps the full view the default', async () => {
    const { h } = await harness();
    const res = await h.callTool('freshbooks_list_invoices', {});
    await h.close();
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    expect(JSON.parse(text)).toMatchObject({ items: [{ id: 11 }, { id: 12 }, { id: 13 }, { id: 14 }], total: 4 });
  });
});
