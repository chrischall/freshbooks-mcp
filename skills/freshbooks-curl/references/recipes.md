# FreshBooks curl recipes

All examples assume:

```sh
set -a; . ~/.secrets; set +a
. references/fb-token.sh
ACCT=$(fb_account_id)
BIZ=$(fb_ids | jq -r .businessId)
```

Paths marked **(unverified)** are transcribed from the official
`freshbooks-python-sdk` source but have not been exercised against a live account.

## Identity

```sh
fb_curl /auth/api/v1/users/me | jq '.response | {identity_id, email}'
fb_ids   # accountId / businessId / businessUuid — run before anything else
```

## Invoices

```sh
# List (newest first via FreshBooks' own sort param)
fb_curl "/accounting/account/$ACCT/invoices/invoices?per_page=25&page=1" \
  | jq '.response.result | {page, pages, total,
        invoices: [.invoices[] | {id, invoice_number, organization, create_date,
                                  amount: .amount.amount, outstanding: .outstanding.amount, status}]}'

# One invoice, with line items expanded
fb_curl "/accounting/account/$ACCT/invoices/invoices/INVOICE_ID?include[]=lines" \
  | jq '.response.result.invoice'

# Outstanding only — v3_status is the useful status field
fb_curl "/accounting/account/$ACCT/invoices/invoices?search[v3_status]=overdue" \
  | jq '[.response.result.invoices[] | {id, invoice_number, outstanding: .outstanding.amount}]'

# Total outstanding across a page
fb_curl "/accounting/account/$ACCT/invoices/invoices?per_page=100" \
  | jq '[.response.result.invoices[].outstanding.amount | tonumber] | add'
```

Create **(unverified)** — money amounts are strings:

```sh
fb_curl "/accounting/account/$ACCT/invoices/invoices" -X POST \
  -H 'Content-Type: application/json' -d '{
  "invoice": {
    "customerid": 123,
    "create_date": "2026-08-12",
    "lines": [
      { "name": "Consulting", "description": "August retainer",
        "qty": 1, "unit_cost": { "amount": "1500.00", "code": "USD" } }
    ]
  }
}' | jq '.response.result.invoice | {id, invoice_number, amount}'
```

## Clients

```sh
fb_curl "/accounting/account/$ACCT/users/clients?per_page=100" \
  | jq '[.response.result.clients[] | {id: .userid, organization, fname, lname, email}]'

# Find a client by name
fb_curl "/accounting/account/$ACCT/users/clients?search[organization_like]=acme" \
  | jq '.response.result.clients'
```

Create **(unverified)**:

```sh
fb_curl "/accounting/account/$ACCT/users/clients" -X POST \
  -H 'Content-Type: application/json' \
  -d '{"client":{"email":"ap@example.com","organization":"Example Co","fname":"Pat","lname":"Doe"}}' \
  | jq '.response.result.client | {userid, organization}'
```

## Payments

```sh
fb_curl "/accounting/account/$ACCT/payments/payments?per_page=50" \
  | jq '[.response.result.payments[] | {id, invoiceid, date, amount: .amount.amount, type}]'
```

Record a payment **(unverified)**:

```sh
fb_curl "/accounting/account/$ACCT/payments/payments" -X POST \
  -H 'Content-Type: application/json' \
  -d '{"payment":{"invoiceid":456,"amount":{"amount":"1500.00","code":"USD"},"date":"2026-08-12","type":"Check"}}'
```

## Estimates, items, taxes, expenses

Same accounting family and envelope; only the path suffix and keys change:

| Resource | Path suffix | List key |
| --- | --- | --- |
| Estimates | `estimates/estimates` | `estimates` |
| Credit notes | `credit_notes/credit_notes` | `credit_notes` |
| Items | `items/items` | `items` |
| Taxes | `taxes/taxes` | `taxes` |
| Expenses | `expenses/expenses` | `expenses` |
| Invoice profiles | `invoice_profiles/invoice_profiles` | `invoice_profiles` |

```sh
fb_curl "/accounting/account/$ACCT/expenses/expenses?per_page=50" \
  | jq '[.response.result.expenses[] | {id, date, amount: .amount.amount, vendor, notes}]'
```

## Projects and time tracking — different id, different envelope

These take `businessId` and return **bare** objects, not `.response.result`:

```sh
fb_curl "/projects/business/$BIZ/projects" | jq '[.projects[] | {id, title, client_id, active}]'

fb_curl "/timetracking/business/$BIZ/time_entries" \
  | jq '[.time_entries[] | {id, project_id, duration, started_at, note}]'
```

Errors here are `.error`, a plain string — not `.response.errors[]`.

## Pagination

Accounting lists carry `page`, `pages`, `per_page`, `total` on the result envelope.
Walk them:

```sh
p=1
while :; do
  body=$(fb_curl "/accounting/account/$ACCT/invoices/invoices?per_page=100&page=$p")
  printf '%s' "$body" | jq -c '.response.result.invoices[]'
  pages=$(printf '%s' "$body" | jq -r '.response.result.pages')
  [ "$p" -ge "$pages" ] && break
  p=$((p + 1))
done
```

## Error shapes by family

```sh
# Accounting / events
jq -r '.response.errors[]? | "\(.errno): \(.message)"'
# Accounting-business
jq -r '.errors? | "\(.message) \(.details[]?.reason // "")"'
# Payments
jq -r '.errors?.details[]? | "\(.field): \(.message)"'
# Projects / time tracking / comments / uploads
jq -r '.error? // empty'
```
