import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult } from '@chrischall/mcp-utils';
import type { FreshbooksClient } from '../client.js';
import { ACCOUNTING_RESOURCES } from '../resources.js';
import { previewUnlessConfirmed, schemaConfirm } from './_confirm.js';

const money = z
  .object({
    amount: z.string().describe('Decimal amount as a string, e.g. "42.50"'),
    code: z.string().describe('Currency code, e.g. "USD"'),
  })
  .describe('FreshBooks money value — the amount is a string, not a number.');

export function registerExpenseTools(server: McpServer, client: FreshbooksClient): void {
  const R = ACCOUNTING_RESOURCES;

  server.registerTool(
    'freshbooks_list_expenses',
    {
      description:
        'List expenses for the account, newest-first by default. Supports pagination and raw ' +
        'FreshBooks filters (e.g. {"search[categoryid]": 5}). If the response reports a total ' +
        'with no rows, the count includes records this identity cannot read — that is reported ' +
        'in the `note` field rather than looking like an empty account.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        page: z.number().int().positive().optional(),
        per_page: z.number().int().positive().max(100).optional(),
        search: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      },
    },
    async ({ page, per_page, search }) =>
      textResult(
        await client.accountingList(R.expenses.path, R.expenses.list, {
          page,
          perPage: per_page,
          filters: search,
        }),
      ),
  );

  server.registerTool(
    'freshbooks_get_expense',
    {
      description: 'Get a single expense by its numeric id.',
      annotations: { readOnlyHint: true },
      inputSchema: { id: z.number().int().positive().describe('Expense id') },
    },
    async ({ id }) => textResult(await client.accountingGet(R.expenses.path, id, R.expenses.single)),
  );

  server.registerTool(
    'freshbooks_list_expense_categories',
    {
      description:
        'List expense categories, which supply the categoryid used when creating an expense.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        page: z.number().int().positive().optional(),
        per_page: z.number().int().positive().max(100).optional(),
      },
    },
    async ({ page, per_page }) =>
      textResult(
        await client.accountingList(R.expense_categories.path, R.expense_categories.list, {
          page,
          perPage: per_page,
        }),
      ),
  );

  server.registerTool(
    'freshbooks_create_expense',
    {
      description:
        'Record an expense. Requires confirm: true to execute; without it returns a dry-run ' +
        'preview and makes no network call.',
      inputSchema: {
        amount: money,
        date: z.string().optional().describe('Expense date, YYYY-MM-DD'),
        categoryid: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Category id (see freshbooks_list_expense_categories)'),
        vendor: z.string().optional().describe('Who was paid'),
        notes: z.string().optional(),
        clientid: z.number().int().positive().optional().describe('Client to rebill this expense to'),
        billable: z.boolean().optional().describe('Whether the expense is rebillable to the client'),
        fields: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Additional raw FreshBooks expense fields, merged into the payload.'),
        confirm: schemaConfirm,
      },
    },
    async ({ confirm, fields, ...rest }) => {
      const payload = {
        ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
        ...(fields ?? {}),
      };
      const gate = previewUnlessConfirmed(confirm, 'Create FreshBooks expense', 'POST', R.expenses.path, {
        expense: payload,
      });
      if (gate) return gate;
      return textResult(await client.accountingWrite(R.expenses.path, R.expenses.single, payload));
    },
  );
}
