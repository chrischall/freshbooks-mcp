/**
 * The brief view of a canonical read: one line per item, at most 120
 * characters, `title — <ISO date | no date> — <status>` (the mcp-host
 * context-groups contract — the host speaks from these lines).
 */
const BRIEF_MAX = 120;

function str(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function money(v: unknown): string | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const m = v as Record<string, unknown>;
  const amount = str(m.amount);
  if (amount === undefined) return undefined;
  const code = str(m.code);
  return code ? `${amount} ${code}` : amount;
}

/**
 * One FreshBooks invoice as one line. Read only from fields the invoice
 * carries: `invoice_number` (else `id`), the client (`organization`, else
 * `fname lname`), the amount still owed (`outstanding`, else `amount`),
 * `due_date` (FreshBooks' computed YYYY-MM-DD) and the status (`v3_status`,
 * else `payment_status`, else `display_status`). The title is shortened to fit;
 * a missing status reads "no status" rather than a guess.
 */
export function invoiceBriefLine(item: unknown): string {
  const inv = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
  const number = str(inv.invoice_number) ?? str(inv.id) ?? '(unnumbered)';
  const person = [str(inv.fname), str(inv.lname)].filter(Boolean).join(' ');
  const who = str(inv.organization) ?? (person || undefined);
  const owed = money(inv.outstanding) ?? money(inv.amount);
  const title = [`Invoice ${number}`, who, owed].filter(Boolean).join(', ');
  const due = str(inv.due_date) ?? 'no date';
  const status = str(inv.v3_status) ?? str(inv.payment_status) ?? str(inv.display_status) ?? 'no status';
  const tail = ` — ${due} — ${status}`;
  const room = BRIEF_MAX - tail.length;
  const shown = title.length > room ? `${title.slice(0, Math.max(room - 1, 0))}…` : title;
  return `${shown}${tail}`;
}
