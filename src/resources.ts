/**
 * Canonical FreshBooks resource map.
 *
 * Paths are transcribed from the official `freshbooks-python-sdk` and corrected against
 * live probes — several are NOT what a reasonable guess produces:
 *   expenses/categories        (not expense_categories/expense_categories)
 *   users/staffs               (not staff/staff)
 *   systems/gateways           (not gateways/gateways)
 *   other_incomes/other_incomes
 * and `projects/tasks` lives in the ACCOUNTING family despite its name, keyed by
 * accountId — not in the businessId-keyed projects family.
 */
export interface AccountingResource {
  path: string;
  single: string;
  list: string;
  /** Set when a live probe showed this resource gated behind plan or role. */
  note?: string;
}

export const ACCOUNTING_RESOURCES = {
  invoices: { path: 'invoices/invoices', single: 'invoice', list: 'invoices' },
  clients: { path: 'users/clients', single: 'client', list: 'clients' },
  estimates: { path: 'estimates/estimates', single: 'estimate', list: 'estimates' },
  payments: { path: 'payments/payments', single: 'payment', list: 'payments' },
  items: { path: 'items/items', single: 'item', list: 'items' },
  expenses: { path: 'expenses/expenses', single: 'expense', list: 'expenses' },
  expense_categories: { path: 'expenses/categories', single: 'category', list: 'categories' },
  taxes: { path: 'taxes/taxes', single: 'tax', list: 'taxes' },
  credit_notes: { path: 'credit_notes/credit_notes', single: 'credit_note', list: 'credit_notes' },
  invoice_profiles: {
    path: 'invoice_profiles/invoice_profiles',
    single: 'invoice_profile',
    list: 'invoice_profiles',
  },
  tasks: {
    path: 'projects/tasks',
    single: 'task',
    list: 'tasks',
    note: 'Billable task catalogue. Accounting family (accountId) despite the "projects/" prefix.',
  },
  // List key is `staff`, not `staffs` — confirmed live against a raw response
  // (result keys: page, pages, per_page, staff, total). A wrong list key fails exactly
  // like a gated resource does: empty items, no error.
  staff: { path: 'users/staffs', single: 'staff', list: 'staff' },
  gateways: { path: 'systems/gateways', single: 'gateway', list: 'gateways' },
  bills: { path: 'bills/bills', single: 'bill', list: 'bills' },
  bill_vendors: { path: 'bill_vendors/bill_vendors', single: 'bill_vendor', list: 'bill_vendors' },
  bill_payments: {
    path: 'bill_payments/bill_payments',
    single: 'bill_payment',
    list: 'bill_payments',
  },
  other_income: {
    path: 'other_incomes/other_incomes',
    single: 'other_income',
    list: 'other_income',
    // SDK-declared list key; the path resolves live but the account is gated
    // (errno 1003), so no row has been observed to confirm `other_income` over
    // `other_incomes`. If this returns empty on an account that HAS other income,
    // suspect the key before the permissions.
    note: 'List key unconfirmed by live rows — the probe account is permission-gated on this resource.',
  },
} as const satisfies Record<string, AccountingResource>;

export type AccountingResourceName = keyof typeof ACCOUNTING_RESOURCES;

export const ACCOUNTING_RESOURCE_NAMES = Object.keys(ACCOUNTING_RESOURCES) as [
  AccountingResourceName,
  ...AccountingResourceName[],
];

/** Business-scoped resources, keyed by the integer businessId. */
export const BUSINESS_RESOURCES = {
  projects: { family: 'projects', path: 'projects', single: 'project', list: 'projects' },
  time_entries: {
    family: 'timetracking',
    path: 'time_entries',
    single: 'time_entry',
    list: 'time_entries',
  },
  services: { family: 'comments', path: 'services', single: 'service', list: 'services' },
} as const;

export type BusinessResourceName = keyof typeof BUSINESS_RESOURCES;
