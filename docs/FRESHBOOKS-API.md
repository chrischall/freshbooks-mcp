# FreshBooks API — pinned shapes

**Verification status:** the auth flow and the invoicing read surface are **LIVE-VERIFIED**
against a real account (2026-08-12). Write bodies remain SDK-derived. Shapes below are otherwise — transcribed from the official
[`freshbooks-python-sdk`](https://github.com/freshbooks/freshbooks-python-sdk) source (authoritative
code, not a doc scrape), plus unauthenticated live probes of the auth endpoints. Anything marked
`LIVE-VERIFIED` has been exercised against a real account. Everything else is **pending live
verification** and must not be treated as confirmed.

Live-probed so far (no credentials needed):

| Probe | Result |
| --- | --- |
| `GET /auth/api/v1/users/me` with bogus bearer | `401 {"error":"unauthenticated",...}` — clean JSON, **no bot wall** |
| `POST /auth/oauth/token` form-encoded, fake client | `401 {"error":"invalid_client",...}` — body parsed, so **form encoding is accepted** |
| `POST /auth/oauth/token` JSON body, fake client | `401 invalid_client` |
| `GET auth.freshbooks.com/oauth/authorize/` fake client | `500` — unknown client, no wall |

### LIVE-VERIFIED (real account, 2026-08-12)

| Check | Result |
| --- | --- |
| Authorization-code exchange | works form-encoded; access token is a JWT, `expires_in` **43200s (12h)** |
| Refresh grant | works; returns a **new** refresh token each time, old one dies |
| `GET /accounting/account/{acct}/invoices/invoices` | `200`, `response.result.invoices` + `page`/`pages`/`per_page`/`total` |
| `users/clients`, `estimates/estimates`, `payments/payments` | `200`, same envelope |
| `items/items` | **`200` with `response.errors[]`** — errno 12001 "You do not have access to items." |
| Detail `GET .../users/clients/{id}` | `200`, unwraps at `response.result.client` |
| Wrong identifier (businessId in an accountId slot) | `404` |
| Money fields | `{"amount":"800.00","code":"USD"}` — amount is a **string** |

## Authentication

OAuth2 **only**. There is no API key and no personal access token, and `client_credentials` is
explicitly unsupported — so every deployment requires a human-registered app.

- **Authorize:** `https://auth.freshbooks.com/oauth/authorize/?client_id=<id>&response_type=code&redirect_uri=<uri>`
  (optional `&scope=<space-separated>`; omitted means the app's default registered scopes)
- **Token:** `POST https://api.freshbooks.com/auth/oauth/token`, **`application/x-www-form-urlencoded`**
  (the SDK passes a dict positionally to `requests.post`, which form-encodes — it is *not* JSON)

Authorization-code grant fields: `client_id`, `client_secret`, `grant_type=authorization_code`,
`redirect_uri`, `code`.
Refresh grant fields: identical but `grant_type=refresh_token` and `refresh_token` instead of `code`
— note the refresh call **still requires `client_secret` and `redirect_uri`**, which is unusual and a
common source of `invalid_client` when porting a generic OAuth client.

Token response: `access_token`, `refresh_token`, `created_at` (epoch **seconds**), `expires_in`
(seconds). Absolute expiry is `created_at + expires_in`.

### Redirect URI rules

Must be **HTTPS**, and must **not** contain query-string parameters. This rules out the
`http://localhost:<port>/` loopback-listener pattern used elsewhere in the fleet (musicbrainz).
The bootstrap therefore registers `https://localhost`, which never needs to resolve — the
browser fails to load it and the `?code=` is read off the address bar.

### ⚠️ Refresh tokens rotate and are one-time-use

> "A new Refresh Token is generated every time a Bearer Token is issued."

Every refresh **invalidates the token that was used**. Consequences that shape the whole design:

1. **The rotated token must be persisted before the refresh call is considered complete.** An
   in-memory-only `TokenManager` works until the process restarts, then the token on disk is stale
   and the account is locked out permanently — a failure that appears only on a cold start, long
   after the code looked correct.
2. **A crash between the HTTP exchange and the disk write burns the token irrecoverably.** Persist
   immediately on resolve and treat a failed write as fatal, so the failure is loud rather than
   silent.
3. **Concurrent refreshes lock each other out.** Two processes (or two un-serialized calls) each
   spend the same token; the loser is dead. Refresh must be single-flight *and* the store must be
   the single source of truth.
4. Recovery from a burned token is **re-running the full authorize flow** — there is no way back
   without the human. Error messages on the refresh path must say that explicitly.

## The three identifiers — the single biggest trap

Six URL families, and they do **not** share an identifier. Using the wrong one 404s rather than
erroring usefully:

| Identifier | Type | Example shape |
| --- | --- | --- |
| `accountId` | alphanumeric string | `xZNQ1X` |
| `businessId` | integer | `77213` |
| `businessUuid` | UUID | `f8e...` |

All three come from `GET /auth/api/v1/users/me` → `response.business_memberships[]`, each entry
carrying a `business` with `id`, `account_id`, and `business_uuid`. **Resolve first, then call** —
never let a caller guess which id a given endpoint wants.

### ⚠️ `business.account_id` can be NULL — do not trust it alone

Verified live on a real **owner** account: `business_memberships[0].business.account_id` was
`null` while the working accountId (`XyM7Y3`) appeared at:

- `response.roles[].accountid` ← the reliable one on that account
- `response.business_memberships[].business.business_clients[].account_id`

Reading only the documented `business.account_id` therefore builds
`/accounting/account/null/...` and 404s on every call. Walk all three locations in order.

Note also that `roles[].role` may read `"client"` even for a business owner — the ownership
signal is `business_memberships[].role` (and `groups[].role`), which read `"owner"`.

### ⚠️ Account ROLE decides writes — and it is not the business membership role

An identity carries two independent roles, and confusing them makes a `403` unreadable:

- `business_memberships[].role` — role on the *business* (`owner`, …)
- `roles[].role` — role on an *accounting account* (`owner`, `admin`, `client`)

Verified live on a real account: the identity was **`owner` of business 14754156**, but that
business had **`account_id: null`** — meaning no accounting account exists for it, so there is
nothing to invoice from. Its only accounting role was **`client` on account `XyM7Y3`**, a
different business. The result:

| Operation | Result |
| --- | --- |
| Reads on `XyM7Y3` (invoices, clients, estimates, payments) | `200` — a client sees records addressed to it |
| `items/items` | `200` + errno 12001 "You do not have access to items." |
| Any write on `XyM7Y3` | **`403 Permission Denied`** |
| `projects` / `time_entries` on own business `14754156` | `200` — these key off `businessId` and need no accounting account |

The access token carried **every** `:write` scope (`user:clients:write`, `user:invoices:write`, …),
so **scopes are the wrong place to look** — decoding the JWT's `scope` claim confirms this in
seconds and saves a long detour. A `403` here means the identity is a `client` on that account,
or that the business it owns has no accounting account at all.

`freshbooks_get_identity` therefore reports `accountRole` and `businessRole` alongside the ids.

### ⚠️ Errors can arrive with HTTP 200

The accounting family returns some failures as **`200` with a `response.errors[]` body and no
`response.result`**. Verified live: `items/items` on an account without that feature answers
`200` + errno 12001. A client that gates on `res.ok` alone silently converts this into an empty
list — "you have no items" instead of "you cannot see items". Check for an error envelope
regardless of status code.

## URL families, envelopes, and error shapes

Each family has its own envelope *and* its own error shape. A single generic response parser will be
wrong for at least four of them.

| Family | Path | Id | Success envelope | Error shape |
| --- | --- | --- | --- | --- |
| Accounting | `/accounting/account/{accountId}/{path}` | `accountId` | `response.result.{name}` | `response.errors[]` → `message`, `errno` |
| Accounting (business) | `/accounting/businesses/{businessUuid}/{path}` | `businessUuid` | `data` | `errors.message` + `errors.details[].reason` |
| Projects | `/projects/business/{businessId}/{path}` | `businessId` | bare / `{project:…}` | `error` (string) |
| Time tracking | `/timetracking/business/{businessId}/{path}` | `businessId` | bare | `error` |
| Comments / services | `/comments/business/{businessId}/{path}` | `businessId` | bare | `error` |
| Payments | `/payments/account/{accountId}/{path}` | `accountId` | — | `errors.message` + `details[].field` |
| Events / webhooks | `/events/account/{accountId}/events/callbacks` | `accountId` | `response.result` | as accounting |
| Uploads | `/uploads/account/{accountId}/{images\|attachments}` | `accountId` | `{<name>:…, link}` | `error` |

Accounting writes wrap the payload in the **singular** resource name
(`{"invoice": {...}}`); projects/timetracking do the same with their own singular name.

### ⚠️ `total` counts records you cannot read

Verified live: `expenses` returned **`total: 16` with zero rows**, and `expense_categories`
returned **`total: 59` with zero rows**. The count includes records the identity lacks
permission to read, and paging further never surfaces them. A consumer that trusts `total`
reports "16 expenses" while showing none, or walks 16 empty pages. `accountingList` /
`businessList` therefore attach a `note` when `total > 0`, no rows came back, **and the
requested page is within range**.

That last condition matters: an empty page with a non-zero total is also exactly what
paging past the end looks like (`page: 99` of `pages: 1`). Annotating that as a permission
boundary would be a confident wrong answer in the opposite direction, so an out-of-range
page gets no note.

### Resource paths — several are not what you would guess

Four of these cost a round of 404s before the SDK source settled them:

| Resource | Correct path | A reasonable wrong guess |
| --- | --- | --- |
| Expense categories | `expenses/categories` | `expense_categories/expense_categories` |
| Staff | `users/staffs` | `staff/staff` |
| Gateways | `systems/gateways` | `gateways/gateways` |
| Other income | `other_incomes/other_incomes` | `other_income/other_incomes` |

And `projects/tasks` is in the **accounting** family keyed by `accountId`, despite the
`projects/` prefix — it is not part of the businessId-keyed projects family.

### Live coverage matrix (real account, 2026-08-12)

Every path below resolved — no 404s — so the paths are confirmed even where the account
lacks access. "Gated" means `200` (or `403`) carrying an error envelope, not an empty list.

| Resource | Path | Result |
| --- | --- | --- |
| invoices | `invoices/invoices` | OK |
| clients | `users/clients` | OK (1 row) |
| estimates | `estimates/estimates` | OK (1 row) |
| payments | `payments/payments` | OK |
| expenses | `expenses/expenses` | OK — `total: 16`, **0 rows** (filtered) |
| expense_categories | `expenses/categories` | OK — `total: 59`, **0 rows** (filtered) |
| taxes | `taxes/taxes` | OK |
| credit_notes | `credit_notes/credit_notes` | OK |
| invoice_profiles | `invoice_profiles/invoice_profiles` | OK |
| tasks | `projects/tasks` | OK (77 total — the contractor's service catalogue) |
| staff | `users/staffs` | OK (1 row) |
| gateways | `systems/gateways` | OK |
| items | `items/items` | Gated — errno 12001 |
| bills | `bills/bills` | Gated — errno 41001 |
| bill_vendors | `bill_vendors/bill_vendors` | Gated — errno 31001 |
| bill_payments | `bill_payments/bill_payments` | Gated — errno 41101 |
| other_income | `other_incomes/other_incomes` | Gated — errno 1003 Permission Denied |
| projects | `projects/business/{businessId}/projects` | OK |
| time_entries | `timetracking/business/{businessId}/time_entries` | OK |
| services | `comments/business/{businessId}/services` | OK |

### Business-scoped families use a `meta` block, not flat pagination

The accounting family puts `page`/`pages`/`per_page`/`total` directly on
`response.result`. The businessId-keyed families instead return a **bare** object with
pagination nested under `meta`:

```json
{ "meta": { "total": 0, "per_page": 30, "page": 1, "pages": 0 }, "projects": [] }
```

`time_entries` additionally carries `total_logged`, `total_unbilled` and
`total_logged_per_client` in that `meta`. Reading `result.total` here yields `undefined`,
which looks like an empty account rather than a parsing mistake.

These families also work on a business with **no accounting account**, which is why they
can succeed when every invoicing endpoint fails.

### Invoicing & AR resources (accounting family, `accountId`)

Path suffixes as used by the SDK — note several are doubled (`invoices/invoices`):

| Resource | Path suffix | Singular / plural key |
| --- | --- | --- |
| Invoices | `invoices/invoices` | `invoice` / `invoices` |
| Clients | `users/clients` | `client` / `clients` |
| Estimates | `estimates/estimates` | `estimate` / `estimates` |
| Credit notes | `credit_notes/credit_notes` | `credit_note` / `credit_notes` |
| Payments | `payments/payments` | `payment` / `payments` |
| Invoice profiles | `invoice_profiles/invoice_profiles` | `invoice_profile` / `invoice_profiles` |
| Items | `items/items` | `item` / `items` |
| Taxes | `taxes/taxes` | `tax` / `taxes` |
| Expenses | `expenses/expenses` | `expense` / `expenses` |

### Estimate actions — the docs page does not have them, the Postman collection does

The public [estimates page](https://www.freshbooks.com/api/estimates) lists `status`,
`ui_status`, `display_status`, `invoiced` and `sentid` under **Computed Fields (read only)**, and
documents only GET / POST / PUT / delete. It describes **no** accept, decline or email operation —
the only route to `accepted` it mentions is creating an invoice from the estimate. Reading only
that page, the obvious move is to PUT a `status` or `display_status`, which does nothing.

FreshBooks' own **Postman collection** — linked from
[freshbooks.com/api/postman-collection](https://www.freshbooks.com/api/postman-collection), served at
`documenter.getpostman.com/view/3322108/S1ERwwza` — carries the requests the page omits:

| Action | Request |
| --- | --- |
| Accept | `PUT /accounting/account/{accountId}/estimates/estimates/{id}` → `{"estimate": {"action_accept": true}}` |
| Email to client | same PUT → `{"estimate": {"action_email": true, "email_recipients": ["…"], "estimate_customized_email": {"subject": "…", "body": "…"}}}` |
| Soft delete | same PUT → `{"estimate": {"vis_state": 1}}` |

Note `estimate_customized_email` — the invoices endpoint uses `invoice_customized_email`, and the
analogy does not carry. Estimates also have no `action_mark_as_sent`; invoices do.

#### ⚠️ There is no way to decline an estimate

Not an oversight in this server — the API has no representation for it:

- Statuses are `1 Draft, 2 Sent, 3 Viewed, 4 Replied, 5 Accepted, 6 Invoiced`; the UI-status list is
  `created / draft / sent / viewed / replied / accepted / invoiced`. No declined or rejected state.
- No `action_deny` / `action_decline` / `action_reject` anywhere in the official collection —
  `action_accept` has no counterpart.
- Webhook events for estimates are `estimate.create`, `estimate.update`, `estimate.delete` only.

`freshbooks_decline_estimate` therefore refuses and explains, rather than sending a plausible-looking
write that silently changes nothing.

#### Live shape (real account, 2026-08-13)

`GET estimates/estimates/279405` returns `accepted: false` — a field the docs' own field table does
not list — alongside `status: 3`, `display_status: "viewed"`, `ui_status: "open"`. The three status
fields genuinely disagree, which is why none of them is the lever, and why the write tools return
the re-fetched object with before/after state instead of reporting success from a `200`.

**Accept is not verified live**: the probe identity is a `client` on `XyM7Y3`, so every estimate
write 403s. The request shapes above are from FreshBooks' own collection, not from a successful call.

Deletes on the accounting family are frequently **soft deletes via update** (`vis_state`), not HTTP
`DELETE` — the SDK carries a `delete_via_update` flag per resource for exactly this. Confirm per
resource before wiring a delete tool.

## Open questions — must be answered by live verification

- [x] `/users/me` payload — verified; see the `account_id` caveat above.
- [x] Accounting list pagination — `page` / `per_page` params, `page`/`pages`/`per_page`/`total` on the envelope.
- [ ] **Estimate `action_accept` / `action_email` unverified live** — collection-derived; the probe
      identity's `client` role 403s every estimate write. Also unverified: whether re-sending
      `action_accept` on an already-accepted estimate is inert (this server does not send it) and
      whether a `lines` update replaces or merges the line set.
- [ ] **Write bodies remain unverified.** A live write test was attempted and returned `403` — not because the request was malformed, but because the only accounting account reachable by the test identity holds a `client` role. Verifying writes requires an identity with `owner`/`admin` on an accounting account. The request *shapes* are still SDK-derived.
- [ ] Which invoicing resources soft-delete via `vis_state` vs. accept `DELETE`.
- [ ] Whether `Api-Version: alpha` is required, optional, or ignored on each family.
- [ ] A real 401 body from an expired access token — expiry detection currently assumes 401.
- [ ] Rate limits and their signalling status code.
