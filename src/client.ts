import { McpToolError, buildQueryString, readEnvVar, truncateErrorMessage } from '@chrischall/mcp-utils';
import type { TokenManager } from '@chrischall/mcp-utils/session';
import { createTokenManager, readOAuthConfig, type OAuthConfig } from './auth.js';

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

export interface ListResult {
  items: unknown[];
  page: number | null;
  pages: number | null;
  total: number | null;
  /** Set when the response is self-inconsistent in a way worth reporting to the caller. */
  note?: string;
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

  private requireConfig(): OAuthConfig {
    if (this.config === null) {
      throw new McpToolError(this.configError ?? 'FreshBooks is not configured.', {
        hint: 'Set FRESHBOOKS_CLIENT_ID, FRESHBOOKS_CLIENT_SECRET and FRESHBOOKS_REFRESH_TOKEN.',
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
        hint:
          'The access token was refused. If this persists, the refresh token may have been spent — ' +
          're-run the OAuth bootstrap.',
      });
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
    if (status === 403) {
      // Scopes are the obvious suspect and usually NOT the cause: a token can carry
      // every `:write` scope and still 403 because the identity is only a CLIENT on
      // this account. Name that first so the reader doesn't go re-checking scopes.
      const role = this.identityCache?.accountRole;
      const roleNote =
        role !== null && role !== undefined
          ? `This identity's role on account ${this.identityCache?.accountId} is "${role}".`
          : '';
      return new McpToolError(`FreshBooks denied the request: ${detail}`, {
        hint:
          `${roleNote} Writes require owner or admin access to the accounting account; a "client" ` +
          'role can read records addressed to it but cannot create or modify any. This is an account ' +
          'permission, not an OAuth scope — check freshbooks_get_identity, and note that owning a ' +
          'business whose account_id is null means that business has no accounting account to write to.',
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
    const prefix = family === 'projects' ? 'projects' : family === 'timetracking' ? 'timetracking' : 'comments';
    const body = await this.request(`/${prefix}/business/${businessId}/${path}`, init);
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
    return withVisibilityNote({
      items,
      page: asNumber(meta.page),
      pages: asNumber(meta.pages),
      total: asNumber(meta.total),
    });
  }

  async businessGet(
    family: BusinessFamily,
    resourcePath: string,
    id: number | string,
    singleKey: string,
  ): Promise<unknown> {
    const result = await this.business(family, `${resourcePath}/${id}`);
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
    const path = opts.id === undefined ? resourcePath : `${resourcePath}/${opts.id}`;
    const result = await this.business(family, path, { method, body: { [singleKey]: payload } });
    return result[singleKey] ?? null;
  }

  async accountingGet(resourcePath: string, id: number | string, singleKey: string): Promise<unknown> {
    const result = await this.accounting(`${resourcePath}/${id}`);
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
    const path = opts.id === undefined ? resourcePath : `${resourcePath}/${opts.id}`;
    const result = await this.accounting(path, { method, body: { [singleKey]: payload } });
    return result[singleKey] ?? null;
  }
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
  if (r.items.length === 0 && r.total !== null && r.total > 0) {
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
