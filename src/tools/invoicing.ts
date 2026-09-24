import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { minifiedResult } from "@chrischall/mcp-utils";
import type { FreshbooksClient } from "../client.js";
import { CONFIRM_DESCRIPTION, confirmTokenParam, confirmWrite } from "./_confirm.js";
import { lineSchema } from "./_lines.js";
import { assertClientRecipients, schemaAllowNonClientRecipients } from "./_recipients.js";

import { ACCOUNTING_RESOURCES } from "../resources.js";

/**
 * The invoicing subset gets dedicated typed tools; the shared map is the single source of
 * truth for paths so these cannot drift from `freshbooks_list_records`.
 */
const RESOURCES = {
  invoices: ACCOUNTING_RESOURCES.invoices,
  clients: ACCOUNTING_RESOURCES.clients,
  estimates: ACCOUNTING_RESOURCES.estimates,
  payments: ACCOUNTING_RESOURCES.payments,
  items: ACCOUNTING_RESOURCES.items,
} as const;

const pageArgs = z.object({
  page: z.number().int().positive().optional().describe("1-based page number"),
  per_page: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("Results per page (max 100)"),
  search: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe(
      'Raw FreshBooks filter params passed through verbatim, e.g. {"search[customerid]": 123} or ' +
        '{"include[]": "lines"}. Field names are not validated.',
    ),
});

export function registerInvoicingTools(
  server: McpServer,
  client: FreshbooksClient,
): void {
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
        minifiedResult(
          await client.accountingList(res.path, res.list, {
            page,
            perPage: per_page,
            filters: search,
          }),
        ),
    );

    server.registerTool(
      `freshbooks_get_${name.replace(/s$/, "")}`,
      {
        description: `Get a single ${name.replace(/s$/, "")} by its numeric FreshBooks id.`,
        annotations: { readOnlyHint: true },
        inputSchema: z.object({
          id: z
            .number()
            .int()
            .positive()
            .describe(`The ${name.replace(/s$/, "")} id`),
        }),
      },
      async ({ id }) =>
        minifiedResult(await client.accountingGet(res.path, id, res.single)),
    );
  }

  // ---- Writes (confirmation-gated) -------------------------------------------
  server.registerTool(
    "freshbooks_create_client",
    {
      description:
        "Create a client (customer) in FreshBooks. " + CONFIRM_DESCRIPTION,
      inputSchema: z.object({
        email: z.string().optional().describe("Client's email address"),
        fname: z.string().optional().describe("First name"),
        lname: z.string().optional().describe("Last name"),
        organization: z
          .string()
          .optional()
          .describe("Company / organization name"),
        currency_code: z
          .string()
          .optional()
          .describe('Currency code, e.g. "USD"'),
        fields: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Additional raw FreshBooks client fields, merged into the payload.",
          ),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ confirmToken, fields, ...rest }, ctx) => {
      const payload = { ...stripUndefined(rest), ...(fields ?? {}) };
      const gate = await confirmWrite(ctx, {
        tool: "freshbooks_create_client",
        action: "client.create",
        summary: "Create FreshBooks client",
        method: "POST",
        path: RESOURCES.clients.path,
        body: { client: payload },
        confirmToken,
      });
      if (gate) return gate;
      return minifiedResult(
        await client.accountingWrite(
          RESOURCES.clients.path,
          RESOURCES.clients.single,
          payload,
        ),
      );
    },
  );

  server.registerTool(
    "freshbooks_create_invoice",
    {
      description:
        "Create an invoice for a client. Created invoices start as drafts. " + CONFIRM_DESCRIPTION,
      inputSchema: z.object({
        customerid: z
          .number()
          .int()
          .positive()
          .describe("Client id to invoice (see freshbooks_list_clients)"),
        create_date: z.string().optional().describe("Invoice date, YYYY-MM-DD"),
        due_offset_days: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Days until due"),
        currency_code: z
          .string()
          .optional()
          .describe('Currency code, e.g. "USD"'),
        notes: z.string().optional(),
        lines: z.array(lineSchema).optional().describe("Invoice line items"),
        fields: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Additional raw FreshBooks invoice fields, merged into the payload.",
          ),
        allow_non_client_recipients: schemaAllowNonClientRecipients,
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ confirmToken, fields, allow_non_client_recipients, ...rest }, ctx) => {
      const payload = { ...stripUndefined(rest), ...(fields ?? {}) };
      const gate = await confirmWrite(ctx, {
        tool: "freshbooks_create_invoice",
        action: "invoice.create",
        summary: "Create FreshBooks invoice",
        method: "POST",
        path: RESOURCES.invoices.path,
        body: { invoice: payload },
        options: { allow_non_client_recipients: allow_non_client_recipients === true },
        confirmToken,
      });
      if (gate) return gate;
      if (payload.email_recipients !== undefined && allow_non_client_recipients !== true) {
        await assertClientRecipients(client, payload.customerid, payload.email_recipients, "the new invoice");
      }
      return minifiedResult(
        await client.accountingWrite(
          RESOURCES.invoices.path,
          RESOURCES.invoices.single,
          payload,
        ),
      );
    },
  );

  server.registerTool(
    "freshbooks_update_invoice",
    {
      description:
        "Update an existing invoice. Only the supplied fields are sent. " + CONFIRM_DESCRIPTION +
        " Note that changing " +
        "an invoice out of draft can email it to the client. email_recipients in fields must be " +
        "addresses on the invoice's client record unless allow_non_client_recipients is set, which " +
        "is only for addresses the user named themselves.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: z.object({
        id: z.number().int().positive().describe("Invoice id"),
        fields: z
          .record(z.string(), z.unknown())
          .describe(
            'Raw FreshBooks invoice fields to change, e.g. {"notes": "..."}.',
          ),
        allow_non_client_recipients: schemaAllowNonClientRecipients,
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ id, fields, allow_non_client_recipients, confirmToken }, ctx) => {
      const gate = await confirmWrite(ctx, {
        tool: "freshbooks_update_invoice",
        action: "invoice.update",
        summary: `Update FreshBooks invoice ${id}`,
        method: "PUT",
        path: `${RESOURCES.invoices.path}/${id}`,
        body: { invoice: fields },
        target: id,
        highlights: fields.email_recipients === undefined ? {} : { recipients: fields.email_recipients },
        options: { allow_non_client_recipients: allow_non_client_recipients === true },
        confirmToken,
      });
      if (gate) return gate;
      if (fields.email_recipients !== undefined && allow_non_client_recipients !== true) {
        const invoice = await client.accountingGet(RESOURCES.invoices.path, id, RESOURCES.invoices.single);
        const customerid =
          invoice !== null && typeof invoice === "object"
            ? (invoice as Record<string, unknown>).customerid
            : undefined;
        await assertClientRecipients(client, customerid, fields.email_recipients, `invoice ${id}`);
      }
      return minifiedResult(
        await client.accountingWrite(
          RESOURCES.invoices.path,
          RESOURCES.invoices.single,
          fields,
          { id },
        ),
      );
    },
  );

  server.registerTool(
    "freshbooks_record_payment",
    {
      description:
        "Record a payment against an invoice. " + CONFIRM_DESCRIPTION,
      inputSchema: z.object({
        invoiceid: z
          .number()
          .int()
          .positive()
          .describe("Invoice the payment applies to"),
        amount: z
          .object({
            amount: z
              .string()
              .describe('Decimal amount as a string, e.g. "150.00"'),
            code: z.string().describe('Currency code, e.g. "USD"'),
          })
          .describe("Payment amount"),
        date: z.string().optional().describe("Payment date, YYYY-MM-DD"),
        type: z
          .string()
          .optional()
          .describe('Payment type, e.g. "Check", "Credit"'),
        note: z.string().optional(),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ confirmToken, ...rest }, ctx) => {
      const payload = stripUndefined(rest);
      const gate = await confirmWrite(ctx, {
        tool: "freshbooks_record_payment",
        action: "payment.create",
        summary: "Record FreshBooks payment",
        method: "POST",
        path: RESOURCES.payments.path,
        body: { payment: payload },
        target: payload.invoiceid as number,
        confirmToken,
      });
      if (gate) return gate;
      return minifiedResult(
        await client.accountingWrite(
          RESOURCES.payments.path,
          RESOURCES.payments.single,
          payload,
        ),
      );
    },
  );
}

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  );
}
