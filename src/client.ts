import { McpToolError, buildQueryString, readEnvVar, truncateErrorMessage } from '@chrischall/mcp-utils';
import type { TokenManager } from '@chrischall/mcp-utils/session';
import { createTokenManager, hasRotated, ownerSetHint, readOAuthConfig, recoveryHint, type OAuthConfig } from './auth.js';

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
  /**
   * Every business this identity belongs to — present only when there is more
   * than one, so the caller can see what else could have been chosen.
   */
  businesses?: BusinessSummary[];
  /**
   * Set when writes are refused: the business was not chosen explicitly among several,
   * or FreshBooks returned no account_id for the chosen one so its accountId is unconfirmed.
   */
  note?: string;
}

/** One business membership, as listed when an identity belongs to several. */
export interface BusinessSummary {
  businessId: number | null;
  accountId: string | null;
  businessUuid: string | null;
  name: string | null;
  role: string | null;
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
  /** The advice `readOAuthConfig` chose for that error — never re-derived. */
  private readonly configAdvice: string | null;
  private readonly config: OAuthConfig | null;
  private tokenManager: TokenManager | null = null;
  private identityCache: Identity | null = null;
  /**
   * Why writes are refused for the cached identity, or null when they are allowed:
   * the business was guessed among several, or its accountId could not be tied to it.
   */
  /**
   * Why writes are refused, per family. Projects and time entries use only the
   * chosen businessId, so an accountId that cannot be tied to that business blocks
   * accounting writes alone; a business that was guessed rather than chosen blocks both.
   */
  private writeRefusal: {
    accounting: { message: string; hint: string } | null;
    business: { message: string; hint: string } | null;
  } = { accounting: null, business: null };
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
      this.configAdvice = result.advice;
      this.config = null;
    } else {
      this.configError = null;
      this.configAdvice = null;
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
      // The message and this hint are two halves of one answer, so they must
      // never disagree. `readOAuthConfig` already decided which advice fits —
      // reconnect, or "the app credentials are the operator's" — so take it
      // rather than re-deriving it here.
      //
      // This used to regex-match the rendered message for
      // FRESHBOOKS_REFRESH_TOKEN, which is true whenever the token is merely
      // NAMED among the missing vars. With an app credential missing too, the
      // message said "reconnecting cannot supply them" while the hint said
      // "Reconnect this connector" — the loop this was meant to close.
      throw new McpToolError(this.configError ?? 'FreshBooks is not configured.', {
        hint: this.configAdvice ?? undefined,
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

    const accountOverride = readEnvVar('FRESHBOOKS_ACCOUNT_ID');
    const businessOverride = readEnvVar('FRESHBOOKS_BUSINESS_ID');
    const body = (await this.request('/auth/api/v1/users/me')) as {
      response?: Record<string, unknown>;
    };
    const me = (body.response ?? body) as Record<string, unknown>;
    const memberships = (Array.isArray(me.business_memberships) ? me.business_memberships : []).map(
      (m) => (m ?? {}) as Record<string, unknown>,
    );
    const businessOf = (m: Record<string, unknown>) => (m.business ?? {}) as Record<string, unknown>;
    const summaries: BusinessSummary[] = memberships.map((m) => {
      const b = businessOf(m);
      return {
        businessId: asNumber(b.id),
        accountId: asString(b.account_id),
        businessUuid: asString(b.business_uuid),
        name: asString(b.name),
        role: asString(m.role),
      };
    });
    const listing = () =>
      summaries
        .map((b) => `${b.businessId} (${b.name ?? 'unnamed'}, accountId ${b.accountId ?? 'none'}, role ${b.role ?? 'unknown'})`)
        .join('; ');

    // Which business every tool reads and writes. With several memberships the
    // API's ordering is NOT a choice: it decided whose books time entries and
    // invoices landed in. An explicit choice selects the membership as a whole,
    // so accountId and businessId always come from the SAME business.
    let chosenIndex: number;
    let ambiguous = false;
    if (businessOverride !== undefined) {
      chosenIndex = summaries.findIndex((b) => String(b.businessId) === businessOverride.trim());
      if (chosenIndex < 0) {
        throw new McpToolError(
          `FRESHBOOKS_BUSINESS_ID=${businessOverride} matches none of this identity's businesses: ${listing() || 'none'}.`,
          { hint: ownerSetHint('FRESHBOOKS_BUSINESS_ID') },
        );
      }
    } else if (accountOverride !== undefined && memberships.length > 1) {
      chosenIndex = summaries.findIndex((b) => b.accountId === accountOverride);
      if (chosenIndex < 0) {
        throw new McpToolError(
          `FRESHBOOKS_ACCOUNT_ID=${accountOverride} does not identify one of this identity's businesses, ` +
            `so the businessId for projects and time tracking cannot be matched to it: ${listing()}. ` +
            'Set FRESHBOOKS_BUSINESS_ID to the businessId to work in.',
          { hint: 'Choose the business explicitly. ' + ownerSetHint('FRESHBOOKS_BUSINESS_ID') },
        );
      }
    } else {
      chosenIndex = 0;
      ambiguous = memberships.length > 1;
    }
    const first = memberships[chosenIndex] ?? {};
    const business = businessOf(first);

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

    // With several memberships only an accountId the CHOSEN membership carries is
    // known to belong to it: roles[] and business_clients are not keyed by business,
    // so their first accountid is whichever account FreshBooks listed first — often
    // a vendor's, which would split invoices and time entries across two books.
    const multi = memberships.length > 1;
    const membershipAccountId = asString(business.account_id);
    const chosenBusinessId = asNumber(business.id);
    if (
      accountOverride !== undefined &&
      (multi || businessOverride !== undefined) &&
      membershipAccountId !== null &&
      accountOverride !== membershipAccountId
    ) {
      throw new McpToolError(
        `FRESHBOOKS_ACCOUNT_ID=${accountOverride} does not belong to business ${chosenBusinessId}, whose ` +
          `accountId is ${membershipAccountId}. Invoices and expenses would land in one business's books ` +
          `and projects and time entries in another's: ${listing()}.`,
        {
          hint:
            'Unset FRESHBOOKS_ACCOUNT_ID (it is derived from FRESHBOOKS_BUSINESS_ID) or set it to the ' +
            'accountId of the same business. ' +
            ownerSetHint('FRESHBOOKS_BUSINESS_ID'),
        },
      );
    }
    const accountUnconfirmed = multi && membershipAccountId === null;
    // FreshBooks gave nothing to check the pairing against, so an explicit
    // FRESHBOOKS_BUSINESS_ID + FRESHBOOKS_ACCOUNT_ID pair is the operator's own
    // decision about whose books this is — honour it rather than lock them out.
    const operatorPaired =
      accountUnconfirmed && accountOverride !== undefined && businessOverride !== undefined;
    const accountUntied = accountUnconfirmed && !operatorPaired;

    const accountId =
      accountOverride ?? membershipAccountId ?? roleAccountId ?? clientAccountId ?? null;
    const businessId = chosenBusinessId;

    if (accountId === null || businessId === null) {
      throw new McpToolError(
        'Could not resolve a FreshBooks account from /auth/api/v1/users/me — no business membership was returned.',
        {
          hint:
            'The authenticated identity may not belong to any business yet. ' +
            ownerSetHint('FRESHBOOKS_ACCOUNT_ID'),
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
      ...(memberships.length > 1 ? { businesses: summaries } : {}),
      ...(ambiguous
        ? {
            note:
              `This identity belongs to ${memberships.length} businesses and none was chosen, so reads ` +
              `use the first one FreshBooks listed (${businessId}) and writes are refused. ` +
              'Set FRESHBOOKS_BUSINESS_ID to the businessId to work in.',
          }
        : accountUntied
          ? {
              note:
                `FreshBooks returned no account_id for business ${businessId}, so accountId ${accountId} ` +
                'cannot be confirmed to belong to it: invoice, expense and other accounting writes are ' +
                'refused (projects and time entries still work) and reads of accounting records may show ' +
                "another business's books. FRESHBOOKS_ACCOUNT_ID, given alongside FRESHBOOKS_BUSINESS_ID, " +
                "confirms this business's accountId.",
            }
          : operatorPaired
            ? {
                note:
                  `FreshBooks returned no account_id for business ${businessId}; accountId ${accountId} is ` +
                  'used because FRESHBOOKS_BUSINESS_ID and FRESHBOOKS_ACCOUNT_ID were both set, and ' +
                  'FreshBooks could not confirm the pairing.',
              }
            : {}),
    };
    const names = summaries.map((b) => `${b.businessId} (${b.name ?? 'unnamed'})`).join(', ');
    const ambiguousRefusal = ambiguous
      ? {
          message:
            `Refusing to write: this identity belongs to several FreshBooks businesses (${names}) and ` +
            'FRESHBOOKS_BUSINESS_ID does not say which one to write to.',
          hint: ownerSetHint('FRESHBOOKS_BUSINESS_ID'),
        }
      : null;
    this.writeRefusal = {
      business: ambiguousRefusal,
      accounting:
        ambiguousRefusal ??
        (accountUntied
          ? {
              message:
                `Refusing to write: FreshBooks returned no account_id for business ${businessId}, so accountId ` +
                `${accountId} cannot be confirmed to belong to it — invoices could land in another business's ` +
                `books while projects and time entries land in ${businessId}'s. Businesses: ${names}.`,
              hint:
                "Confirm the pairing with this business's own accountId, given alongside " +
                'FRESHBOOKS_BUSINESS_ID. ' +
                ownerSetHint('FRESHBOOKS_ACCOUNT_ID'),
            }
          : null),
    };
    return this.identityCache;
  }

  /**
   * Refuse a write while the business was guessed rather than chosen — creating
   * records in the wrong company's books is not undoable from here.
   */
  private async identityForWrite(
    method: string | undefined,
    family: 'accounting' | 'business',
  ): Promise<Identity> {
    const identity = await this.getIdentity();
    const refusal = this.writeRefusal[family];
    if (method !== undefined && method !== 'GET' && refusal !== null) {
      throw new McpToolError(refusal.message, { hint: refusal.hint });
    }
    return identity;
  }

  /** Accounting family: `/accounting/account/{accountId}/{path}`, envelope `response.result`. */
  private async accounting(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<Record<string, unknown>> {
    const { accountId } = await this.identityForWrite(init.method, 'accounting');
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
    const { businessId } = await this.identityForWrite(init.method, 'business');
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
