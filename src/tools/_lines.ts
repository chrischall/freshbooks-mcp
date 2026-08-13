import { z } from 'zod';

/**
 * Line item on an invoice or an estimate — the two share a shape, so they share a
 * schema. `passthrough` because FreshBooks accepts more line fields (taxName1,
 * taxAmount1, type, …) than are worth enumerating, and a stripped unknown key
 * silently changes what the caller asked to send.
 */
export const lineSchema = z
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
