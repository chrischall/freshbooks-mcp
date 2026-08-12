# freshbooks-mcp

MCP server for [FreshBooks](https://www.freshbooks.com) — invoices, clients, estimates and
payments, exposed to Claude as typed tools.

> This project was developed and is maintained by AI (Claude Code). Use at your own discretion.

## Install

```sh
npm install -g @chrischall/freshbooks-mcp
```

## Setup

FreshBooks is **OAuth2 only** — there is no API key and no personal access token, so a
one-time browser authorization is required.

1. Register an app at <https://my.freshbooks.com/#/developer>. The redirect URI must be
   **HTTPS with no query string**; `https://localhost` works and never needs to resolve.
2. Note the **Client ID** and **Client Secret**.
3. Run the one-time bootstrap to obtain a refresh token — see
   [`skills/freshbooks-curl`](skills/freshbooks-curl/SKILL.md), which ships the
   bootstrap script.
4. Configure:

```sh
FRESHBOOKS_CLIENT_ID=...
FRESHBOOKS_CLIENT_SECRET=...
FRESHBOOKS_REFRESH_TOKEN=...       # from the bootstrap
FRESHBOOKS_REDIRECT_URI=https://localhost   # optional; must match what you registered
FRESHBOOKS_TOKEN_STORE=~/.freshbooks-mcp/session.json   # optional
```

### ⚠️ Refresh tokens rotate

FreshBooks issues a **new refresh token on every refresh and immediately invalidates the
old one**. This server persists each rotation to `FRESHBOOKS_TOKEN_STORE` (mode `0600`)
before the refresh is considered complete, and prefers the stored token over the
environment value — the stored one has rotated past it.

Two consequences worth knowing:

- **Do not point two tools at the same store.** The MCP server and the `freshbooks-curl`
  skill keep separate state files on purpose; sharing one makes them spend each other's
  tokens and locks both out.
- **If the store is lost, re-run the bootstrap.** A spent refresh token cannot be
  recovered.

Changing `FRESHBOOKS_REFRESH_TOKEN` to a freshly bootstrapped value is detected and
adopted, so re-bootstrapping is the supported recovery path.

## Tools

| Tool | Purpose |
| --- | --- |
| `freshbooks_get_identity` | Resolve accountId / businessId / businessUuid |
| `freshbooks_list_invoices` / `freshbooks_get_invoice` | Browse and fetch invoices |
| `freshbooks_list_clients` / `freshbooks_get_client` | Browse and fetch clients |
| `freshbooks_list_estimates` / `freshbooks_get_estimate` | Browse and fetch estimates |
| `freshbooks_list_payments` / `freshbooks_get_payment` | Browse and fetch payments |
| `freshbooks_list_items` / `freshbooks_get_item` | Browse and fetch catalogue items |
| `freshbooks_create_client` | Create a client — confirm-gated |
| `freshbooks_create_invoice` | Create an invoice — confirm-gated |
| `freshbooks_update_invoice` | Update an invoice — confirm-gated |
| `freshbooks_record_payment` | Record a payment against an invoice — confirm-gated |

**Confirm-gated** means the tool makes *no* network call unless `confirm: true` is passed;
without it you get a dry-run preview of exactly what would be sent.

## Writes require an owner/admin accounting account

FreshBooks separates the role you hold on a *business* from the role you hold on an
*accounting account*. You can own a business that has **no** accounting account
(`account_id: null`) while being only a **client** on the account you can actually see —
in which case reads succeed and every write returns `403 Permission Denied`, even though
your OAuth token carries all the `:write` scopes.

`freshbooks_get_identity` reports `accountRole` and `businessRole` so this is visible up
front. If `accountRole` is `client`, the invoicing write tools will not work against that
account — that is an account permission, not a configuration problem.

## The three identifiers

FreshBooks hands out three non-interchangeable ids, and using the wrong one returns a bare
**404** that reads like a missing record:

| Identifier | Used by |
| --- | --- |
| `accountId` (alphanumeric) | `/accounting/account/…`, `/payments/account/…` |
| `businessId` (integer) | `/projects/business/…`, `/timetracking/business/…` |
| `businessUuid` (UUID) | `/accounting/businesses/…` |

Call `freshbooks_get_identity` first. Full API notes, including the four different error
envelopes, are in [`docs/FRESHBOOKS-API.md`](docs/FRESHBOOKS-API.md).

## Shell access without the server

[`skills/freshbooks-curl`](skills/freshbooks-curl/SKILL.md) covers the same API from a
shell with `curl` + `jq`, including the OAuth bootstrap and rotation-safe token handling.

## Development

```sh
npm install
npm run build
npm test
```

## License

MIT
