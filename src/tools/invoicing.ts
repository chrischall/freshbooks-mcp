import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult } from '@chrischall/mcp-utils';
import type { FreshbooksClient } from '../client.js';
import { previewUnlessConfirmed, schemaConfirm } from './_confirm.js';

/** Accounting-family resources. Several paths are doubled upstream (`invoices/invoices`). */
const RESOURCES = {
  invoices: { path: 'invoices/invoices', single: 'invoice', list: 'invoices' },
  clients: { path: 'users/clients', single: 'client', list: 'clients' },
  estimates: { path: 'estimates/estimates', single: 'estimate', list: 'estimates' },
  payments: { path: 'payments/payments', single: 'payment', list: 'payments' },
  items: { path: 'items/items', single: 'item', list: 'items' },
} as const;

const pageArgs = {
  page: z.number().int().positive().optional().describe('1-based page number'),
  per_page: z.number().int().positive().max(100).optional().describe('Results per page (max 100)'),
  search: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe(
      'Raw FreshBooks filter params passed through verbatim, e.g. {"search[customerid]": 123} or ' +
        '{"include[]": "lines"}. Field names are not validated.',
    ),
};

/** Line item on an invoice or estimate. */
const lineSchema = z
  .object({
    name: z.string().optional().describe('Line item name'),
    description: z.string().optional(),
    qty: z.union([z.number(), z.string()]).optional().describe('Quantity'),
    unit_cost: z
      .object({
        amount: z.string().describe('Decimal amount as a string, e.g. "150.00"'),
        code: z.string().describe('Currency code, e.g. "USD"'),
      })
      .optional()
      .describe('Unit cost. FreshBooks represents money as {amount, code} with amount as a string.'),
  })
  .passthrough();

export function registerInvoicingTools(server: McpServer, client: FreshbooksClient): void {
  // ---- Reads -------------------------------------------------------------
  for (const [name, res] of Object.entries(RESOURCES)) {
    server.registerTool(
      `freshbooks_list_${name}`,
      {
        description:
          `List ${name} for the authenticated FreshBooks account. Supports pagination and raw ` +
          `FreshBooks filter params. Returns items plus page/pages/total.`,
        annotations: { readOnlyHint: true },
        inputSchema: pageArgs,
      },
      async ({ page, per_page, search }) =>
        textResult(
          await client.accountingList(res.path, res.list, {
            page,
            perPage: per_page,
            filters: search,
          }),
        ),
    );

    server.registerTool(
      `freshbooks_get_${name.replace(/s$/, '')}`,
      {
        description: `Get a single ${name.replace(/s$/, '')} by its numeric FreshBooks id.`,
        annotations: { readOnlyHint: true },
        inputSchema: { id: z.number().int().positive().describe(`The ${name.replace(/s$/, '')} id`) },
      },
      async ({ id }) => textResult(await client.accountingGet(res.path, id, res.single)),
    );
  }

  // ---- Writes (confirm-gated) -------------------------------------------
  server.registerTool(
    'freshbooks_create_client',
    {
      description:
        'Create a client (customer) in FreshBooks. Requires confirm: true to execute; without it ' +
        'returns a dry-run preview and makes no network call.',
      inputSchema: {
        email: z.string().optional().describe("Client's email address"),
        fname: z.string().optional().describe('First name'),
        lname: z.string().optional().describe('Last name'),
        organization: z.string().optional().describe('Company / organization name'),
        currency_code: z.string().optional().describe('Currency code, e.g. "USD"'),
        fields: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Additional raw FreshBooks client fields, merged into the payload.'),
        confirm: schemaConfirm,
      },
    },
    async ({ confirm, fields, ...rest }) => {
      const payload = { ...stripUndefined(rest), ...(fields ?? {}) };
      const gate = previewUnlessConfirmed(
        confirm,
        'Create FreshBooks client',
        'POST',
        RESOURCES.clients.path,
        { client: payload },
      );
      if (gate) return gate;
      return textResult(
        await client.accountingWrite(RESOURCES.clients.path, RESOURCES.clients.single, payload),
      );
    },
  );

  server.registerTool(
    'freshbooks_create_invoice',
    {
      description:
        'Create an invoice for a client. Created invoices start as drafts. Requires confirm: true ' +
        'to execute; without it returns a dry-run preview and makes no network call.',
      inputSchema: {
        customerid: z.number().int().positive().describe('Client id to invoice (see freshbooks_list_clients)'),
        create_date: z.string().optional().describe('Invoice date, YYYY-MM-DD'),
        due_offset_days: z.number().int().nonnegative().optional().describe('Days until due'),
        currency_code: z.string().optional().describe('Currency code, e.g. "USD"'),
        notes: z.string().optional(),
        lines: z.array(lineSchema).optional().describe('Invoice line items'),
        fields: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Additional raw FreshBooks invoice fields, merged into the payload.'),
        confirm: schemaConfirm,
      },
    },
    async ({ confirm, fields, ...rest }) => {
      const payload = { ...stripUndefined(rest), ...(fields ?? {}) };
      const gate = previewUnlessConfirmed(
        confirm,
        'Create FreshBooks invoice',
        'POST',
        RESOURCES.invoices.path,
        { invoice: payload },
      );
      if (gate) return gate;
      return textResult(
        await client.accountingWrite(RESOURCES.invoices.path, RESOURCES.invoices.single, payload),
      );
    },
  );

  server.registerTool(
    'freshbooks_update_invoice',
    {
      description:
        'Update an existing invoice. Only the supplied fields are sent. Requires confirm: true to ' +
        'execute; without it returns a dry-run preview and makes no network call. Note that changing ' +
        'an invoice out of draft can email it to the client.',
      inputSchema: {
        id: z.number().int().positive().describe('Invoice id'),
        fields: z
          .record(z.string(), z.unknown())
          .describe('Raw FreshBooks invoice fields to change, e.g. {"notes": "..."}.'),
        confirm: schemaConfirm,
      },
    },
    async ({ id, fields, confirm }) => {
      const gate = previewUnlessConfirmed(
        confirm,
        `Update FreshBooks invoice ${id}`,
        'PUT',
        `${RESOURCES.invoices.path}/${id}`,
        { invoice: fields },
      );
      if (gate) return gate;
      return textResult(
        await client.accountingWrite(RESOURCES.invoices.path, RESOURCES.invoices.single, fields, { id }),
      );
    },
  );

  server.registerTool(
    'freshbooks_record_payment',
    {
      description:
        'Record a payment against an invoice. Requires confirm: true to execute; without it returns ' +
        'a dry-run preview and makes no network call.',
      inputSchema: {
        invoiceid: z.number().int().positive().describe('Invoice the payment applies to'),
        amount: z
          .object({
            amount: z.string().describe('Decimal amount as a string, e.g. "150.00"'),
            code: z.string().describe('Currency code, e.g. "USD"'),
          })
          .describe('Payment amount'),
        date: z.string().optional().describe('Payment date, YYYY-MM-DD'),
        type: z.string().optional().describe('Payment type, e.g. "Check", "Credit"'),
        note: z.string().optional(),
        confirm: schemaConfirm,
      },
    },
    async ({ confirm, ...rest }) => {
      const payload = stripUndefined(rest);
      const gate = previewUnlessConfirmed(
        confirm,
        'Record FreshBooks payment',
        'POST',
        RESOURCES.payments.path,
        { payment: payload },
      );
      if (gate) return gate;
      return textResult(
        await client.accountingWrite(RESOURCES.payments.path, RESOURCES.payments.single, payload),
      );
    },
  );
}

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
