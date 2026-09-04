import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { minifiedResult } from '@chrischall/mcp-utils';
import type { FreshbooksClient } from '../client.js';
import { ACCOUNTING_RESOURCES, ACCOUNTING_RESOURCE_NAMES, type AccountingResourceName } from '../resources.js';

/**
 * Generic accessors for the accounting family's long tail.
 *
 * The high-traffic resources get typed tools of their own; everything else is reachable
 * here without adding two more tools per resource to the agent's menu. The resource map
 * is shared with the typed tools so paths cannot drift between the two surfaces.
 */
export function registerRecordTools(server: McpServer, client: FreshbooksClient): void {
  const resourceArg = z
    .enum(ACCOUNTING_RESOURCE_NAMES)
    .describe('Accounting resource to read. All use the alphanumeric accountId.');

  server.registerTool(
    'freshbooks_list_records',
    {
      description:
        'List any FreshBooks accounting resource by name — the generic reader covering the ' +
        'long tail (taxes, credit notes, invoice profiles, tasks, staff, gateways, bills, ' +
        'bill vendors, bill payments, other income, expense categories) alongside the ones ' +
        'with dedicated tools. Returns items plus page/pages/total. Some resources are gated ' +
        'by plan or account role and will report that rather than returning rows.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        resource: resourceArg,
        page: z.number().int().positive().optional(),
        per_page: z.number().int().positive().max(100).optional(),
        search: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe('Raw FreshBooks filter params passed through verbatim.'),
      },
    },
    async ({ resource, page, per_page, search }) => {
      const r = ACCOUNTING_RESOURCES[resource as AccountingResourceName];
      const res = await client.accountingList(r.path, r.list, { page, perPage: per_page, filters: search });
      return minifiedResult({ resource, ...res, ...('note' in r ? { resourceNote: r.note } : {}) });
    },
  );

  server.registerTool(
    'freshbooks_get_record',
    {
      description:
        'Get a single record from any FreshBooks accounting resource by name and id. Ids are ' +
        'numeric on every resource mapped here; the schema also accepts a string so an id ' +
        'carried around as text still works.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        resource: resourceArg,
        id: z
          .union([z.number().int().positive(), z.string().min(1)])
          .describe('The record id — numeric for all currently mapped resources'),
      },
    },
    async ({ resource, id }) => {
      const r = ACCOUNTING_RESOURCES[resource as AccountingResourceName];
      return minifiedResult(await client.accountingGet(r.path, id, r.single));
    },
  );
}
