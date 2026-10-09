import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { minifiedResult } from "@chrischall/mcp-utils";
import type { FreshbooksClient } from "../client.js";
import {
  ACCOUNTING_RESOURCES,
  ACCOUNTING_RESOURCE_NAMES,
  type AccountingResourceName,
} from "../resources.js";

/**
 * Generic accessors for the accounting family's long tail.
 *
 * The high-traffic resources get typed tools of their own; everything else is reachable
 * here without adding two more tools per resource to the agent's menu. The resource map
 * is shared with the typed tools so paths cannot drift between the two surfaces.
 */
export function registerRecordTools(
  server: McpServer,
  client: FreshbooksClient,
): void {
  const resourceArg = z
    .enum(ACCOUNTING_RESOURCE_NAMES)
    .describe(
      "Accounting resource to read. All use the alphanumeric accountId.",
    );

  server.registerTool(
    "freshbooks_list_records",
    {
      description:
        "List any FreshBooks accounting resource by name — the generic reader covering the " +
        "long tail (taxes, credit notes, invoice profiles, tasks, staff, gateways, bills, " +
        "bill vendors, bill payments, other income, expense categories) alongside the ones " +
        "with dedicated tools. Returns items plus page/pages/total. Some resources are gated " +
        "by plan or account role and will report that rather than returning rows.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: z.object({
        resource: resourceArg,
        page: z.number().int().positive().optional(),
        per_page: z.number().int().positive().max(100).optional(),
        search: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Raw FreshBooks filter params passed through verbatim."),
      }),
    },
    async ({ resource, page, per_page, search }) => {
      const r = ACCOUNTING_RESOURCES[resource as AccountingResourceName];
      const res = await client.accountingList(r.path, r.list, {
        page,
        perPage: per_page,
        filters: search,
      });
      return minifiedResult({
        resource,
        ...res,
        ...("note" in r ? { resourceNote: r.note } : {}),
      });
    },
  );

  server.registerTool(
    "freshbooks_get_record",
    {
      description:
        "Get a single record from any FreshBooks accounting resource by name and id. Ids are " +
        "numeric on every resource mapped here; the schema also accepts a string so an id " +
        "carried around as text still works.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: z.object({
        resource: resourceArg,
        id: z
          // A string id must still be all digits: encodeURIComponent leaves '.'
          // and '..' alone and URL normalisation resolves them, so a free-form
          // string could address a different endpoint than `resource` allows.
          .union([
            z.number().int().positive(),
            z.string().regex(/^[1-9]\d*$/, "id must be a positive integer"),
          ])
          .describe(
            "The record id — numeric for all currently mapped resources (digits only if passed as text)",
          ),
      }),
    },
    async ({ resource, id }) => {
      const r = ACCOUNTING_RESOURCES[resource as AccountingResourceName];
      return minifiedResult(await client.accountingGet(r.path, id, r.single));
    },
  );
}
