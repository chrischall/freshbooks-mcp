import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpToolError, textResult } from '@chrischall/mcp-utils';
import type { FreshbooksClient } from '../client.js';
import { WrongIdentifierError } from '../client.js';
import { ACCOUNTING_RESOURCES } from '../resources.js';
import { previewUnlessConfirmed, schemaConfirm } from './_confirm.js';
import { lineSchema } from './_lines.js';

/**
 * Estimate writes.
 *
 * The mechanism is NOT what the field names suggest. `status` (int), `display_status`
 * and `ui_status` are computed read-only fields on the estimate — they disagree with
 * each other by design (a viewed estimate reads `status: 3`, `display_status: "viewed"`,
 * `ui_status: "open"`) and writing them does nothing. Acceptance is an *action* sent
 * on the estimate itself:
 *
 *   PUT /accounting/account/{accountId}/estimates/estimates/{id}
 *   {"estimate": {"action_accept": true}}
 *
 * That shape comes from FreshBooks' own Postman collection (linked from
 * freshbooks.com/api/postman-collection), which carries the estimate actions the
 * public docs page omits — see docs/FRESHBOOKS-API.md.
 *
 * There is no decline. See `freshbooks_decline_estimate` below.
 */
const EST = ACCOUNTING_RESOURCES.estimates;

/** `status` >= 5 is Accepted (5) or Invoiced (6) — both mean acceptance already happened. */
const STATUS_ACCEPTED = 5;

/** The fields worth echoing before/after a write so a caller can see the state move. */
const STATE_KEYS = ['accepted', 'status', 'display_status', 'ui_status', 'invoiced'] as const;

export function registerEstimateTools(server: McpServer, client: FreshbooksClient): void {
  server.registerTool(
    'freshbooks_accept_estimate',
    {
      description:
        'Accept an estimate on behalf of the account, by sending FreshBooks\' action_accept on ' +
        'the estimate (PUT estimates/estimates/{id} with {"estimate": {"action_accept": true}}). ' +
        'Acceptance is not reversible through the API — there is no un-accept action — so this ' +
        'requires confirm: true to execute; without it returns a dry-run preview and makes no ' +
        'network call. Idempotent: an estimate already accepted or invoiced is returned unchanged ' +
        'with changed: false and no write is sent. Returns the re-fetched estimate.',
      inputSchema: {
        id: z.number().int().positive().describe('Estimate id (see freshbooks_list_estimates)'),
        confirm: schemaConfirm,
      },
    },
    async ({ id, confirm }) => {
      const gate = previewUnlessConfirmed(
        confirm,
        `Accept FreshBooks estimate ${id}`,
        'PUT',
        `${EST.path}/${id}`,
        { estimate: { action_accept: true } },
      );
      if (gate) return gate;

      await assertAccountIdShape(client);
      const before = await readEstimateForWrite(client, id);
      if (isAccepted(before)) {
        // Idempotent rather than an error: the caller's intent ("this estimate should be
        // accepted") already holds. Re-sending action_accept on an accepted estimate has
        // an unknown side effect (FreshBooks does not document one) and acceptance cannot
        // be undone, so the safe answer is to send nothing and say so.
        return textResult({
          changed: false,
          changedFields: [],
          alreadyAccepted: true,
          before: stateOf(before),
          after: stateOf(before),
          estimate: before,
          note: 'Estimate was already accepted (or invoiced). No write was sent.',
        });
      }

      const written = await mutate(client, id, { action_accept: true }, 'accept');
      return textResult({ ...(await verify(client, id, before, written)), accepted: true });
    },
  );

  server.registerTool(
    'freshbooks_decline_estimate',
    {
      description:
        'NOT SUPPORTED by the FreshBooks API — this tool always fails, and never sends a request. ' +
        'FreshBooks models no declined state for estimates: the status set is draft / sent / viewed / ' +
        'replied / accepted / invoiced, there is no action_deny or action_decline counterpart to ' +
        'action_accept in FreshBooks\' own API collection, and there is no estimate.decline webhook ' +
        'event. The tool exists so this answers with the reason instead of a plausible-looking write ' +
        'that changes nothing. Call it to get the alternatives.',
      // No `confirm` parameter, deliberately: everywhere else in this server `confirm`
      // means "an executable write, behind a gate", so offering it here would invite a
      // retry with confirm: true in the belief that decline exists and is merely gated.
      inputSchema: { id: z.number().int().positive().describe('Estimate id') },
    },
    // No confirm gate and no network call: a dry-run preview here would advertise a
    // request that does not exist.
    async ({ id }) => {
      // The remediation lives in the MESSAGE because the MCP tool boundary forwards
      // `error.message` and drops `hint` — and here the alternatives are the whole point.
      const alternatives =
        'Options: (1) leave it — an estimate that is never accepted simply stays open; ' +
        '(2) take it off the active list with freshbooks_update_estimate id, fields ' +
        '{"vis_state": 1}, which is FreshBooks\' documented soft delete (a deletion, not a ' +
        'decline, and not the same as telling the sender no); (3) decline out of band, in the ' +
        'FreshBooks web portal or by replying to whoever sent it. freshbooks_accept_estimate is ' +
        'the only estimate action the API exposes.';
      throw new McpToolError(
        `FreshBooks has no decline operation for estimates, so estimate ${id} cannot be declined ` +
          'through the API. Nothing was sent. Its status set is draft / sent / viewed / replied / ' +
          'accepted / invoiced — there is no declined or rejected state to move it to. ' +
          alternatives,
        { hint: alternatives },
      );
    },
  );

  server.registerTool(
    'freshbooks_update_estimate',
    {
      description:
        'Update an existing estimate. Only the supplied fields are sent; anything omitted is left ' +
        'alone. Requires confirm: true to execute; without it returns a dry-run preview and makes ' +
        'no network call. Supplying lines REPLACES the whole line set — include each existing ' +
        'line\'s lineid to keep it. Returns the re-fetched estimate.',
      inputSchema: {
        id: z.number().int().positive().describe('Estimate id'),
        notes: z.string().optional().describe('Notes shown on the estimate'),
        terms: z.string().optional().describe('Terms shown on the estimate'),
        description: z.string().optional().describe('Estimate description / summary line'),
        presentation: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Presentation block — theme_primary_color, theme_font_name, image_logo_src, ' +
              'date_format and friends.',
          ),
        lines: z
          .array(lineSchema)
          .optional()
          .describe('Full replacement line set. Include lineid on a line to update it in place.'),
        estimate_number: z.string().optional().describe('User-visible estimate number, e.g. "0000654"'),
        po_number: z.string().optional(),
        create_date: z.string().optional().describe('Estimate date, YYYY-MM-DD'),
        currency_code: z.string().optional().describe('Currency code, e.g. "USD"'),
        discount_value: z.string().optional().describe('Discount percentage as a decimal string, e.g. "30"'),
        customerid: z.number().int().positive().optional().describe('Client the estimate is for'),
        fields: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Additional raw FreshBooks estimate fields, merged into the payload — e.g. ' +
              '{"vis_state": 1} to soft-delete. Field names are not validated.',
          ),
        confirm: schemaConfirm,
      },
    },
    async ({ id, confirm, fields, ...rest }) => {
      const payload = { ...stripUndefined(rest), ...(fields ?? {}) };
      if (Object.keys(payload).length === 0) {
        // An empty PUT is a write that reports success while changing nothing — exactly
        // the "assume success from a 200" failure these tools are meant to rule out.
        throw new McpToolError(`No fields supplied, so there is nothing to update on estimate ${id}.`, {
          hint: 'Pass at least one field (notes, terms, lines, presentation, …) or a raw `fields` object.',
        });
      }
      const gate = previewUnlessConfirmed(
        confirm,
        `Update FreshBooks estimate ${id}`,
        'PUT',
        `${EST.path}/${id}`,
        { estimate: payload },
      );
      if (gate) return gate;

      await assertAccountIdShape(client);
      const before = await readEstimateForWrite(client, id);
      const sentFields = Object.keys(payload);
      const written = await mutate(client, id, payload, 'update');
      // Watch the fields this write actually set: the status projection alone never moves
      // on a field edit, so `changed` would report every successful update as a no-op.
      return textResult({ ...(await verify(client, id, before, written, sentFields)), sentFields });
    },
  );

  server.registerTool(
    'freshbooks_send_estimate',
    {
      description:
        'Email an estimate to the client, by sending FreshBooks\' action_email on the estimate ' +
        '(PUT estimates/estimates/{id} with {"estimate": {"action_email": true, …}}). This puts ' +
        'mail in a client\'s inbox, so it requires confirm: true to execute; without it returns a ' +
        'dry-run preview and makes no network call. Omitting email_recipients lets FreshBooks use ' +
        'the client\'s own address. Returns the re-fetched estimate.',
      inputSchema: {
        id: z.number().int().positive().describe('Estimate id'),
        email_recipients: z
          .array(z.string())
          .optional()
          .describe("Recipient addresses. Omit to let FreshBooks send to the client's address on file."),
        subject: z.string().optional().describe('Custom email subject'),
        body: z.string().optional().describe('Custom email body'),
        confirm: schemaConfirm,
      },
    },
    async ({ id, email_recipients, subject, body, confirm }) => {
      const customized = stripUndefined({ subject, body });
      const payload: Record<string, unknown> = {
        action_email: true,
        ...(email_recipients === undefined ? {} : { email_recipients }),
        // Note the key: estimates use `estimate_customized_email`, NOT the
        // `invoice_customized_email` the invoice endpoint takes.
        ...(Object.keys(customized).length > 0 ? { estimate_customized_email: customized } : {}),
      };
      const gate = previewUnlessConfirmed(
        confirm,
        `Email FreshBooks estimate ${id} to the client`,
        'PUT',
        `${EST.path}/${id}`,
        { estimate: payload },
      );
      if (gate) return gate;

      await assertAccountIdShape(client);
      const before = await readEstimateForWrite(client, id);
      const written = await mutate(client, id, payload, 'email');
      return textResult({
        ...(await verify(client, id, before, written)),
        emailed: true,
        // `changed` here describes the RECORD, not the mail. Sending an estimate that was
        // already sent moves nothing on it, and a caller who reads `changed: false` as
        // "that didn't work" and retries puts a second email in a client's inbox.
        sendNote:
          'The email was accepted by FreshBooks. `changed` reports whether the estimate ' +
          'record moved, which it need not for an already-sent estimate — do not retry on ' +
          'the strength of changed: false.',
      });
    },
  );
}

/**
 * Estimates are an ACCOUNTING resource, keyed by the alphanumeric accountId. This catches
 * the unambiguous half of the identifier trap: an accountId that is really one of the
 * other two ids, which makes every accounting URL 404 regardless of the estimate id.
 *
 * The other half — a businessId passed as the estimate id — is NOT checked here, because
 * the two are plain integers and a genuine estimate could collide with the businessId.
 * That case is decided by whether the record reads (see `readEstimateForWrite`), so a
 * real estimate is never blocked by a guess about its id.
 */
async function assertAccountIdShape(client: FreshbooksClient): Promise<void> {
  const identity = await client.getIdentity();
  if (identity.accountId === String(identity.businessId) || identity.accountId === identity.businessUuid) {
    throw new WrongIdentifierError(
      `The resolved accountId is "${identity.accountId}", which is this account's ` +
        `${identity.accountId === identity.businessUuid ? 'businessUuid' : 'businessId'} — not an ` +
        'accountId. Every accounting call built from it would 404.',
      {
        hint:
          'FRESHBOOKS_ACCOUNT_ID is almost certainly set to the wrong identifier. Unset it, or set ' +
          'it to the alphanumeric accountId reported by freshbooks_get_identity.',
      },
    );
  }
}

/**
 * The read every write starts from. When the record is not there AND the id given is this
 * account's businessId, name that — FreshBooks answers a swapped identifier with the same
 * 404 it gives a deleted estimate, and the two need different fixes. An estimate that
 * really does carry that id reads fine and proceeds untouched.
 */
async function readEstimateForWrite(client: FreshbooksClient, id: number): Promise<unknown> {
  try {
    return await readEstimate(client, id);
  } catch (err) {
    const { businessId, accountId } = await client.getIdentity();
    if (id !== businessId) throw err;
    throw new WrongIdentifierError(
      `No estimate ${id} on account ${accountId}, and ${id} is this account's businessId — the ` +
        'likely mistake is a businessId in the estimate-id slot. Estimates are addressed by ' +
        "accountId plus the estimate's own id.",
      {
        hint:
          'businessId addresses /projects and /timetracking only. Get estimate ids from ' +
          'freshbooks_list_estimates. (If an estimate really does have this id, it would have ' +
          'been read here and this error would not have fired.)',
        cause: err,
      },
    );
  }
}

/** Fetch an estimate, turning "no such record" into a message that names the likely cause. */
async function readEstimate(client: FreshbooksClient, id: number): Promise<unknown> {
  const estimate = await client.accountingGet(EST.path, id, EST.single);
  if (estimate === null || estimate === undefined) {
    throw new McpToolError(`FreshBooks returned no estimate ${id}.`, {
      hint:
        'Confirm the id with freshbooks_list_estimates — an estimate id is not the estimate NUMBER ' +
        'shown on the document (e.g. id 279405 vs number "0000654").',
    });
  }
  return estimate;
}

/**
 * Send the write, and translate the one failure that is easy to misread: a 404 on the
 * PUT for a record we just read successfully is a permission boundary, not a missing
 * estimate.
 */
async function mutate(
  client: FreshbooksClient,
  id: number,
  payload: Record<string, unknown>,
  action: string,
): Promise<unknown> {
  try {
    return await client.accountingWrite(EST.path, EST.single, payload, { id });
  } catch (err) {
    if (err instanceof McpToolError && /returned 404/.test(err.message)) {
      throw client.permissionError(
        `FreshBooks refused the ${action} of estimate ${id} with a 404, but this identity just READ ` +
          'that estimate — the record exists, so this is a permission boundary and not a missing record.',
      );
    }
    throw err;
  }
}

/**
 * Re-read the estimate after a write and report what actually moved. The write's own
 * response is not enough: a 200 that changed nothing looks identical to one that did,
 * which is the whole reason these tools return the object rather than a success flag.
 *
 * `watch` carries the fields THIS write was supposed to change, on top of the status
 * projection. Without it a notes update would always report `changed: false` — the
 * status fields never move on a field edit — and a caller would reasonably read that
 * as "the write did nothing" and retry.
 */
async function verify(
  client: FreshbooksClient,
  id: number,
  before: unknown,
  written: unknown,
  watch: string[] = [],
): Promise<Record<string, unknown>> {
  let after = written;
  let refetched = true;
  try {
    after = await readEstimate(client, id);
  } catch {
    // The mutation already happened; failing the whole call on a flaky read-back would
    // report a write that succeeded as a write that failed.
    refetched = false;
  }
  const b = asRecord(before);
  const a = asRecord(after);
  // `action_*` keys are instructions, not fields — they never appear on the record, so
  // watching them would report every write as unapplied.
  const watched = [...new Set([...STATE_KEYS, ...watch])].filter((k) => !k.startsWith('action_'));
  const changedFields = watched.filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]));
  return {
    changed: changedFields.length > 0,
    changedFields,
    before: stateOf(before),
    after: stateOf(after),
    estimate: after,
    ...(refetched
      ? {}
      : { note: 'Re-fetch after the write failed; `estimate` is the write response itself.' }),
  };
}

function stateOf(estimate: unknown): Record<string, unknown> {
  const e = asRecord(estimate);
  return Object.fromEntries(STATE_KEYS.filter((k) => k in e).map((k) => [k, e[k]]));
}

/** Accepted is expressed three ways at once, and an invoiced estimate passed through it. */
function isAccepted(estimate: unknown): boolean {
  const e = asRecord(estimate);
  if (e.accepted === true || e.invoiced === true) return true;
  if (typeof e.status === 'number' && e.status >= STATUS_ACCEPTED) return true;
  return [e.display_status, e.ui_status].some((v) => v === 'accepted' || v === 'invoiced');
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
