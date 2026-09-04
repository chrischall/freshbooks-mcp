import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { minifiedResult } from '@chrischall/mcp-utils';
import type { FreshbooksClient } from '../client.js';
import { BUSINESS_RESOURCES } from '../resources.js';
import { previewUnlessConfirmed, schemaConfirm } from './_confirm.js';

/**
 * Projects, time tracking and services.
 *
 * These are keyed by the integer businessId — NOT the accountId the invoicing tools use —
 * and live on their own URL prefixes with a bare response envelope. They also work on a
 * business that has no accounting account at all, which is why they can be available when
 * every invoicing endpoint is not.
 */
export function registerProjectTools(server: McpServer, client: FreshbooksClient): void {
  const R = BUSINESS_RESOURCES;

  const page = {
    page: z.number().int().positive().optional(),
    per_page: z.number().int().positive().max(100).optional(),
  };

  server.registerTool(
    'freshbooks_list_projects',
    {
      description:
        'List projects for the business. Uses businessId (not accountId) and works even when ' +
        'the business has no accounting account.',
      annotations: { readOnlyHint: true },
      inputSchema: page,
    },
    async ({ page: p, per_page }) =>
      minifiedResult(await client.businessList(R.projects.family, R.projects.path, R.projects.list, { page: p, perPage: per_page })),
  );

  server.registerTool(
    'freshbooks_get_project',
    {
      description: 'Get a single project by its numeric id.',
      annotations: { readOnlyHint: true },
      inputSchema: { id: z.number().int().positive().describe('Project id') },
    },
    async ({ id }) =>
      minifiedResult(await client.businessGet(R.projects.family, R.projects.path, id, R.projects.single)),
  );

  server.registerTool(
    'freshbooks_create_project',
    {
      description:
        'Create a project. Requires confirm: true to execute; without it returns a dry-run ' +
        'preview and makes no network call.',
      inputSchema: {
        title: z.string().describe('Project title'),
        client_id: z.number().int().positive().optional().describe('Client this project is for'),
        project_type: z
          .enum(['fixed_price', 'hourly_rate'])
          .optional()
          .describe('Billing model for the project'),
        fixed_price: z.string().optional().describe('Fixed price as a decimal string, when project_type is fixed_price'),
        rate: z.string().optional().describe('Hourly rate as a decimal string, when project_type is hourly_rate'),
        due_date: z.string().optional().describe('Due date, YYYY-MM-DD'),
        description: z.string().optional(),
        fields: z.record(z.string(), z.unknown()).optional().describe('Additional raw project fields.'),
        confirm: schemaConfirm,
      },
    },
    async ({ confirm, fields, ...rest }) => {
      const payload = {
        ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
        ...(fields ?? {}),
      };
      const gate = previewUnlessConfirmed(confirm, 'Create FreshBooks project', 'POST', R.projects.path, {
        project: payload,
      });
      if (gate) return gate;
      return minifiedResult(
        await client.businessWrite(R.projects.family, R.projects.path, R.projects.single, payload),
      );
    },
  );

  server.registerTool(
    'freshbooks_list_time_entries',
    {
      description:
        'List tracked time entries for the business. The response envelope also carries ' +
        'total_logged and total_unbilled alongside the rows.',
      annotations: { readOnlyHint: true },
      inputSchema: page,
    },
    async ({ page: p, per_page }) =>
      minifiedResult(
        await client.businessList(R.time_entries.family, R.time_entries.path, R.time_entries.list, {
          page: p,
          perPage: per_page,
        }),
      ),
  );

  server.registerTool(
    'freshbooks_create_time_entry',
    {
      description:
        'Log a time entry. Duration is in SECONDS. Requires confirm: true to execute; without ' +
        'it returns a dry-run preview and makes no network call.',
      inputSchema: {
        duration: z.number().int().nonnegative().describe('Logged time in SECONDS (e.g. 3600 = 1 hour)'),
        started_at: z.string().describe('ISO 8601 start time, e.g. 2026-08-12T09:00:00Z'),
        project_id: z.number().int().positive().optional(),
        client_id: z.number().int().positive().optional(),
        service_id: z.number().int().positive().optional(),
        note: z.string().optional(),
        billable: z.boolean().optional(),
        confirm: schemaConfirm,
      },
    },
    async ({ confirm, ...rest }) => {
      const payload = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      const gate = previewUnlessConfirmed(
        confirm,
        'Log FreshBooks time entry',
        'POST',
        R.time_entries.path,
        { time_entry: payload },
      );
      if (gate) return gate;
      return minifiedResult(
        await client.businessWrite(R.time_entries.family, R.time_entries.path, R.time_entries.single, payload),
      );
    },
  );

  server.registerTool(
    'freshbooks_list_services',
    {
      description:
        'List services (the billable work types available to projects and time entries).',
      annotations: { readOnlyHint: true },
      inputSchema: page,
    },
    async ({ page: p, per_page }) =>
      minifiedResult(
        await client.businessList(R.services.family, R.services.path, R.services.list, {
          page: p,
          perPage: per_page,
        }),
      ),
  );
}
