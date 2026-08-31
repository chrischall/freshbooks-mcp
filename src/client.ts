import { McpToolError, buildQueryString, readEnvVar, truncateErrorMessage } from '@chrischall/mcp-utils';
import type { TokenManager } from '@chrischall/mcp-utils/session';
import { createTokenManager, hasRotated, readOAuthConfig, type OAuthConfig, recoveryHint } from './auth.js';

const BASE_URL = 'https://api.freshbooks.com';

/** The identifiers FreshBooks hands out. They are NOT interchangeable — see docs/FRESHBOOKS-API.md. */
export interface Identity {
  identityId: number | null;
  email: string | null;
  /** Alphanumeric, e.g. `xZNQ1X`. Used by /accounting/account and /payments/account. */
  accountId: string;
  /** Integer. Used by /projects/business, /timetracking/business, /comments/business. */
  businessId: number;
  /** UUID. Used by /accounting/businesses. */
  businessUuid: string | null;
  businessName: string | null;
  /**
   * The role this identity holds on `accountId` — `owner`/`admin` can write, `client`
   * can only read. Distinct from the business membership role: an identity can OWN a
   * business that has no accounting account while being merely a CLIENT on the only
   * accounting account it can see.
   */
  accountRole: string | null;
  /** The role held on the business itself (`owner`, `member`, …). */
  businessRole: string | null;
}

/** Families keyed by businessId rather than accountId, each on its own URL prefix. */
export type BusinessFamily = 'projects' | 'timetracking' | 'comments';

/**
 * One of the three identifiers was used in a slot that wants a different one. Named
 * rather than left to FreshBooks, which answers a swapped identifier with a bare `404`
 * that reads as "no such record" — the single most expensive wrong turn on this API.
 */
export class WrongIdentifierError extends McpToolError {}

/**
 * The identity may read the record but not write it. FreshBooks signals this three
 * different ways (403, a 200 carrying errno 1003, or a 404 on the write path for a
 * record that reads fine), so the classification lives in one named error rather
 * than in each caller's string matching.
 */
export class PermissionDeniedError extends McpToolError {}

/**
 * errno values FreshBooks uses for a role/permission refusal, as opposed to plan gating.
 * Only errnos actually observed as role refusals belong here — everything in this set
 * inherits remediation text about account role, which is the wrong fix for anything else.
 * 1003 is live-observed (other_income, "Permission Denied").
 */
const PERMISSION_ERRNOS = new Set([1003]);

export interface ListResult {
  items: unknown[];
  page: number | null;
  pages: number | null;
  total: number | null;
  /** Set when the response is self-inconsistent in a way worth reporting to the caller. */
  note?: string;
  /**
   * Non-pagination fields from a business-family `meta` block — `total_logged`,
   * `total_unbilled`, `total_logged_per_client` and friends. Pagination is already
   * surfaced above, so it is excluded here rather than duplicated.
   */
  meta?: Record<string, unknown>;
}

export interface ListOptions {
  page?: number;
  perPage?: number;
  /** Raw `search[...]`/`include[]` style filters, passed through verbatim. */
  filters?: Record<string, string | number | boolean>;
}

interface AccountingEnvelope {
  response?: {
    result?: Record<string, unknown>;
    errors?: Array<{ message?: string; errno?: number }> | { message?: string; errno?: number };
  };
}

export class FreshbooksClient {
  private readonly configError: string | null;
  private readonly config: OAuthConfig | null;
  private tokenManager: TokenManager | null = null;
  private identityCache: Identity | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly storePath: string | undefined;

  constructor(opts: { fetchImpl?: typeof fetch; storePath?: string } = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.storePath = opts.storePath;
    // Deferred-config-error pattern: the server must still boot (and answer the host's
    // install-time tools/list probe) with no credentials present. The error surfaces on
    // the first tool call instead of at construction.
    const result = readOAuthConfig();
    if ('error' in result) {
      this.configError = result.error;
      this.config = null;
    } else {
      this.configError = null;
      this.config = result.config;
    }
  }

  /**
   * Which credential source is configured, for `freshbooks_healthcheck` — a
   * LABEL and the non-secret facts, never the client secret or refresh token.
   *
   * Reports `configError` as the reason when nothing resolved, because that
   * string already names exactly which of the three env vars are missing —
   * which is the whole question a healthcheck is asked here.
   */
  describeCredential(): { source: string | null; detail?: Record<string, unknown> } {
    if (this.config === null) return { source: null };
    // Real rotation state, read from the persisted store — NOT inferred from
    // whether `tokenManager` happens to have been constructed, which only
    // tracks "a request already ran in this process". `null` means nothing is
    // persisted yet, which is "unknown" rather than "not rotated".
    const rotated = hasRotated(this.config, this.storePath ? { storePath: this.storePath } : {});
    return {
      source: 'env',
      detail: {
        refresh_token:
          rotated === null ? 'unknown (nothing persisted yet)' : rotated ? 'rotated' : 'as-configured',
      },
    };
  }

  /** The reason no credential resolved, for the healthcheck's message. */
  get credentialError(): string | null {
    return this.configError;
  }

  private requireConfig(): OAuthConfig {
    if (this.config === null) {
      // An ABSENT credential needs the SAME environment-aware advice as a
      // rejected one. It used to get "Set FRESHBOOKS_CLIENT_ID,
      // FRESHBOOKS_CLIENT_SECRET and FRESHBOOKS_REFRESH_TOKEN" — impossible on
      // a hosted registration, where there is no shell to export into and the
      // value arrives from a principal secret. A connector authorized before
      // the connect flow existed lands here with no token at all, so this is
      // the message a person actually meets first.
      //
      // Only the TOKEN is recoverable by the person: the app credentials are
      // the operator's, so a missing one of those keeps a config-shaped hint
      // rather than telling someone to reconnect over a problem reconnecting
      // cannot fix.
      const missingToken = /FRESHBOOKS_REFRESH_TOKEN/.test(this.configError ?? '');
      throw new McpToolError(this.configError ?? 'FreshBooks is not configured.', {
        hint: missingToken
          ? recoveryHint()
          : 'FRESHBOOKS_CLIENT_ID and FRESHBOOKS_CLIENT_SECRET identify the FreshBooks app ' +
            'itself; on a hosted registration they are the operator\'s to set, not yours.',
      });
    }
    return this.config;
  }

  private tokens(): TokenManager {
    if (this.tokenManager === null) {
      this.tokenManager = createTokenManager(this.requireConfig(), {
        storePath: this.storePath,
        fetchImpl: this.fetchImpl,
      });
    }
    return this.tokenManager;
  }

  /** Every request goes through here so auth and error normalization stay in one place. */
  private async request(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<unknown> {
    const token = await this.tokens().getAccessToken();
    const method = init.method ?? 'GET';
    const res = await this.fetchImpl(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Api-Version': 'alpha',
        Accept: 'application/json',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

    const raw = await res.text();
    let parsed: unknown = null;
    if (raw !== '') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new McpToolError(
          `FreshBooks returned a non-JSON response for ${method} ${path} (HTTP ${res.status}).`,
          { hint: 'This usually indicates an outage or an unexpected redirect.' },
        );
      }
    }

    if (!res.ok) throw this.toError(res.status, method, path, parsed);

    // FreshBooks' accounting family delivers some failures as HTTP 200 with an
    // `response.errors[]` body and no `response.result` — observed live: `items` on an
    // account lacking that feature returns 200 + errno 12001. Checking only `res.ok`
    // turns that into a silently empty list, which reads as "there are none" rather
    // than "you cannot see these".
    const embedded = extractErrorMessage(parsed);
    if (embedded !== null && hasErrorEnvelope(parsed)) {
      throw this.toError(res.status, method, path, parsed);
    }
    return parsed;
  }

  /**
   * Normalize the four different error shapes FreshBooks uses across its URL families
   * into one message. A 404 here is very often the wrong *identifier* rather than a
   * missing record — accountId, businessId and businessUuid are not interchangeable —
   * so the hint says so instead of implying the resource does not exist.
   */
  private toError(status: number, method: string, path: string, body: unknown): McpToolError {
    const detail = extractErrorMessage(body) ?? `HTTP ${status}`;
    if (status === 401) {
      return new McpToolError(`FreshBooks rejected the request as unauthenticated: ${detail}`, {
        hint: 'The access token was refused. If this persists, the refresh token may have been spent. ' + recoveryHint(),
      });
    }
    // Role refusals do not always arrive as 403: the accounting family also delivers
    // errno 1003 with HTTP 200 (verified live on other_income). Classifying on status
    // alone turns that into a generic "failed (HTTP 200)", which reads as a bug in this
    // client rather than as "your identity is not allowed to do that".
    if (status === 403 || isPermissionRefusal(detail, body)) {
      return this.permissionError(`FreshBooks denied the request: ${detail}`);
    }
    if (status === 404) {
      return new McpToolError(`FreshBooks returned 404 for ${method} ${path}: ${detail}`, {
        hint:
          'A 404 here is commonly a wrong identifier rather than a missing record: /accounting/account ' +
          'and /payments/account take the alphanumeric accountId, /projects/business and ' +
          '/timetracking/business take the integer businessId, and /accounting/businesses takes the ' +
          'businessUuid. Confirm which one this endpoint expects.',
      });
    }
    if (status === 429) {
      return new McpToolError(`FreshBooks rate-limited the request: ${detail}`, {
        hint: 'Slow down and retry.',
      });
    }
    return new McpToolError(
      truncateErrorMessage(`FreshBooks ${method} ${path} failed (HTTP ${status}): ${detail}`),
    );
  }

  /**
   * The role-aware permission failure. Every path that concludes "you may read this
   * but not write it" builds its message here, so the remediation text stays in one
   * place and always names the role rather than sending the reader after scopes.
   */
  permissionError(message: string): PermissionDeniedError {
    // Scopes are the obvious suspect and usually NOT the cause: a token can carry
    // every `:write` scope and still be refused because the identity is only a CLIENT
    // on this account. Name that first so the reader doesn't go re-checking scopes.
    const role = this.identityCache?.accountRole;
    const roleNote =
      role !== null && role !== undefined
        ? `This identity's role on account ${this.identityCache?.accountId} is "${role}". `
        : '';
    const remedy =
      `${roleNote}Writes require owner or admin access to the accounting account; a "client" ` +
      'role can read records addressed to it but cannot create or modify any. This is an account ' +
      'permission, not an OAuth scope — check freshbooks_get_identity, and note that owning a ' +
      'business whose account_id is null means that business has no accounting account to write to.';
    // The remediation goes in the MESSAGE, not only the hint: the MCP tool boundary
    // forwards `error.message` and drops everything else, so a hint-only explanation
    // never reaches the caller who needs it.
    return new PermissionDeniedError(`${message} ${remedy}`, { hint: remedy });
  }

  /**
   * Resolve the caller's identifiers. Cached for the process lifetime: the mapping is
   * stable, and every accounting call needs the accountId.
   */
  async getIdentity(): Promise<Identity> {
    if (this.identityCache !== null) return this.identityCache;

    const override = readEnvVar('FRESHBOOKS_ACCOUNT_ID');
    const body = (await this.request('/auth/api/v1/users/me')) as {
      response?: Record<string, unknown>;
    };
    const me = (body.response ?? body) as Record<string, unknown>;
    const memberships = Array.isArray(me.business_memberships) ? me.business_memberships : [];
    const first = (memberships[0] ?? {}) as Record<string, unknown>;
    const business = (first.business ?? {}) as Record<string, unknown>;

    // `business.account_id` is NOT reliable: observed live as null on a real owner
    // account while the usable accountId sat at roles[0].accountid. Walk the known
    // locations in order rather than trusting the documented one alone.
    const roles = Array.isArray(me.roles) ? me.roles : [];
    const roleAccountId = roles
      .map((r) => asString((r as Record<string, unknown>).accountid))
      .find((v): v is string => v !== null);
    const businessClients = Array.isArray(business.business_clients) ? business.business_clients : [];
    const clientAccountId = businessClients
      .map((c) => asString((c as Record<string, unknown>).account_id))
      .find((v): v is string => v !== null);

    const accountId =
      override ?? asString(business.account_id) ?? roleAccountId ?? clientAccountId ?? null;
    const businessId = asNumber(business.id);

    if (accountId === null || businessId === null) {
      throw new McpToolError(
        'Could not resolve a FreshBooks account from /auth/api/v1/users/me — no business membership was returned.',
        {
          hint:
            'The authenticated identity may not belong to any business yet. Set FRESHBOOKS_ACCOUNT_ID ' +
            'explicitly if you know it.',
        },
      );
    }

    const accountRole =
      roles
        .map((r) => r as Record<string, unknown>)
        .find((r) => asString(r.accountid) === accountId)?.role ?? null;

    this.identityCache = {
      identityId: asNumber(me.identity_id),
      email: asString(me.email),
      accountId,
      businessId,
      businessUuid: asString(business.business_uuid),
      businessName: asString(business.name),
      accountRole: typeof accountRole === 'string' ? accountRole : null,
      businessRole: asString(first.role),
    };
    return this.identityCache;
  }

  /** Accounting family: `/accounting/account/{accountId}/{path}`, envelope `response.result`. */
  private async accounting(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<Record<string, unknown>> {
    const { accountId } = await this.getIdentity();
    const body = (await this.request(
      `/accounting/account/${accountId}/${path}`,
      init,
    )) as AccountingEnvelope;
    return body.response?.result ?? {};
  }

  async accountingList(
    resourcePath: string,
    listKey: string,
    opts: ListOptions = {},
  ): Promise<ListResult> {
    const query = buildQueryString({
      page: opts.page,
      per_page: opts.perPage,
      ...(opts.filters ?? {}),
    });
    const result = await this.accounting(`${resourcePath}${query}`);
    const items = Array.isArray(result[listKey]) ? (result[listKey] as unknown[]) : [];
    const total = asNumber(result.total);
    return withVisibilityNote({
      items,
      page: asNumber(result.page),
      pages: asNumber(result.pages),
      total,
    });
  }

  /**
   * Business-scoped families (`/projects`, `/timetracking`, `/comments`). These take the
   * integer businessId — NOT the accountId — return a bare object whose pagination lives
   * in a `meta` block, and report errors as a flat `error` string. None of that matches
   * the accounting family, so they get their own reader.
   */
  private async business(
    family: BusinessFamily,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<Record<string, unknown>> {
    const { businessId } = await this.getIdentity();
    // `family` IS the URL prefix for all three of these.
    const body = await this.request(`/${family}/business/${businessId}/${path}`, init);
    return (body ?? {}) as Record<string, unknown>;
  }

  async businessList(
    family: BusinessFamily,
    resourcePath: string,
    listKey: string,
    opts: ListOptions = {},
  ): Promise<ListResult> {
    const query = buildQueryString({
      page: opts.page,
      per_page: opts.perPage,
      ...(opts.filters ?? {}),
    });
    const result = await this.business(family, `${resourcePath}${query}`);
    const meta = (result.meta ?? {}) as Record<string, unknown>;
    const items = Array.isArray(result[listKey]) ? (result[listKey] as unknown[]) : [];
    // Pagination is surfaced at the top level; pass the REST of meta through rather than
    // dropping fields the time-entry tool advertises (total_logged, total_unbilled, …).
    const { page: _p, pages: _pg, per_page: _pp, total: _t, ...extraMeta } = meta;
    return withVisibilityNote({
      items,
      page: asNumber(meta.page),
      pages: asNumber(meta.pages),
      total: asNumber(meta.total),
      ...(Object.keys(extraMeta).length > 0 ? { meta: extraMeta } : {}),
    });
  }

  async businessGet(
    family: BusinessFamily,
    resourcePath: string,
    id: number | string,
    singleKey: string,
  ): Promise<unknown> {
    const result = await this.business(family, `${resourcePath}/${encodeURIComponent(String(id))}`);
    return result[singleKey] ?? result ?? null;
  }

  async businessWrite(
    family: BusinessFamily,
    resourcePath: string,
    singleKey: string,
    payload: Record<string, unknown>,
    opts: { id?: number | string; method?: 'POST' | 'PUT' } = {},
  ): Promise<unknown> {
    const method = opts.method ?? (opts.id === undefined ? 'POST' : 'PUT');
    const path =
      opts.id === undefined ? resourcePath : `${resourcePath}/${encodeURIComponent(String(opts.id))}`;
    const result = await this.business(family, path, { method, body: { [singleKey]: payload } });
    return result[singleKey] ?? null;
  }

  async accountingGet(resourcePath: string, id: number | string, singleKey: string): Promise<unknown> {
    const result = await this.accounting(`${resourcePath}/${encodeURIComponent(String(id))}`);
    return result[singleKey] ?? null;
  }

  /**
   * The single central write path. Every mutating tool routes through here so auth,
   * the singular-key payload wrapper and error normalization are applied in exactly
   * one place.
   */
  async accountingWrite(
    resourcePath: string,
    singleKey: string,
    payload: Record<string, unknown>,
    opts: { id?: number | string; method?: 'POST' | 'PUT' } = {},
  ): Promise<unknown> {
    const method = opts.method ?? (opts.id === undefined ? 'POST' : 'PUT');
    const path =
      opts.id === undefined ? resourcePath : `${resourcePath}/${encodeURIComponent(String(opts.id))}`;
    const result = await this.accounting(path, { method, body: { [singleKey]: payload } });
    return result[singleKey] ?? null;
  }
}

/**
 * True when an error body describes a role/permission refusal rather than a missing
 * feature. Deliberately narrow: errno 12001 ("You do not have access to items.") is
 * plan gating, not a role, and calling that a permission problem sends the reader to
 * the wrong fix.
 */
function isPermissionRefusal(detail: string, body: unknown): boolean {
  const errno = extractErrorNumber(body);
  if (errno !== null && PERMISSION_ERRNOS.has(errno)) return true;
  return /permission denied/i.test(detail);
}

/** Pull `errno` out of the accounting family's `response.errors[]` envelope. */
function extractErrorNumber(body: unknown): number | null {
  if (body === null || typeof body !== 'object') return null;
  const respErrors = ((body as Record<string, unknown>).response as Record<string, unknown> | undefined)
    ?.errors;
  const first = Array.isArray(respErrors) ? respErrors[0] : respErrors;
  if (first === null || first === undefined || typeof first !== 'object') return null;
  return asNumber((first as Record<string, unknown>).errno);
}

/** True when the body carries one of the recognized error envelopes. */
function hasErrorEnvelope(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  const respErrors = (b.response as Record<string, unknown> | undefined)?.errors;
  if (respErrors !== undefined && respErrors !== null) return true;
  if (b.errors !== undefined && b.errors !== null) return true;
  return typeof b.error === 'string';
}

/**
 * FreshBooks reports a `total` that counts records the caller may not actually read:
 * observed live as `total: 16` with an empty `expenses` array. Left unannotated, a
 * caller reports "16 expenses" while showing none, or pages through 16 empty pages.
 */
function withVisibilityNote(r: ListResult): ListResult {
  // `items: 0` with `total > 0` is ALSO what paging past the end looks like. Claiming a
  // permission boundary there is a confident wrong answer in the opposite direction from
  // the one this note exists to prevent, so only annotate an in-range page.
  const inRange = r.page === null || r.pages === null || r.page <= r.pages;
  if (inRange && r.items.length === 0 && r.total !== null && r.total > 0) {
    return {
      ...r,
      note:
        `FreshBooks reports total=${r.total} but returned no rows. The count includes records ` +
        'this identity does not have permission to read, so paging further will not surface them.',
    };
  }
  return r;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}
function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Pull a message out of whichever of the four documented error shapes arrived. */
export function extractErrorMessage(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;

  // Accounting / events: { response: { errors: [{ message, errno }] } }
  const respErrors = (b.response as Record<string, unknown> | undefined)?.errors;
  if (Array.isArray(respErrors) && respErrors.length > 0) {
    const msg = asString((respErrors[0] as Record<string, unknown>).message);
    if (msg !== null) return msg;
  }
  if (respErrors !== undefined && !Array.isArray(respErrors) && typeof respErrors === 'object') {
    const msg = asString((respErrors as Record<string, unknown>).message);
    if (msg !== null) return msg;
  }

  // Accounting-business: { errors: { message, details: [{ reason }] } }
  // Payments:            { errors: { message, details: [{ field, message }] } }
  if (b.errors !== null && typeof b.errors === 'object' && !Array.isArray(b.errors)) {
    const errs = b.errors as Record<string, unknown>;
    const details = Array.isArray(errs.details) ? errs.details : [];
    const first = (details[0] ?? {}) as Record<string, unknown>;
    const reason = asString(first.reason);
    const field = asString(first.field);
    const fieldMsg = asString(first.message);
    const base = asString(errs.message);
    if (field !== null && fieldMsg !== null) return `${field}: ${fieldMsg}`;
    if (reason !== null) return base !== null ? `${base} (${reason})` : reason;
    if (base !== null) return base;
  }

  // Projects / timetracking / comments / uploads: { error: "..." }
  const flat = asString(b.error);
  if (flat !== null) return flat;
  const desc = asString(b.error_description);
  if (desc !== null) return desc;
  return null;
}
