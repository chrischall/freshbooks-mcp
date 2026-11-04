import { UNTRUSTED_CONTENT_RULE } from '@chrischall/mcp-utils';
import type { ListResult } from '../client.js';

/**
 * The brief view of a canonical read: one line per item, at most 120
 * characters, `title — <ISO date | no date> — <status>` (the mcp-host
 * context-groups contract — the host speaks from these lines). A line that
 * starts with `-- ` is a note, not an item: `-- none`, `-- N of M shown`,
 * `-- more`. Every title here starts with "Invoice ", so none needs the
 * contract's leading-backslash escape.
 */
const BRIEF_MAX = 120;

/**
 * Who writes the brief lines' text: a client's name is typed into FreshBooks by
 * the account's users or by the client itself (its portal profile), never by
 * this server — so the lines ride in the untrusted-data envelope.
 */
export const UNTRUSTED_BRIEF_NOTE =
  `Client names below are written in FreshBooks by the account's users and its clients, not by this server. ${UNTRUSTED_CONTENT_RULE}`;

function str(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' && v.trim() !== '' ? v.replace(/\s+/g, ' ').trim() : undefined;
}

/** The shortest a title is cut to before the status gives way too. */
const TITLE_FLOOR = 24;

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, Math.max(n - 1, 0))}…` : s);

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
 * else `payment_status`, else `display_status`). The line is cut to fit as a
 * WHOLE, title first: the title shortens until the line fits, and only once it
 * is at its floor does the status give way too. A missing status reads
 * "no status" rather than a guess.
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
  const sep = ` — ${due} — `;
  const room = BRIEF_MAX - sep.length;
  if (title.length + status.length <= room) return `${title}${sep}${status}`;
  const shown = cut(title, Math.max(room - status.length, Math.min(title.length, TITLE_FLOOR)));
  return `${shown}${sep}${cut(status, room - shown.length)}`;
}

/**
 * One page of invoices as brief lines, notes included: `-- none` for an empty
 * page, then `-- N of M shown` when FreshBooks' total exceeds the rows on the
 * page (which also keeps rows this identity cannot read from vanishing), or
 * `-- more` when only `pages` says another page exists.
 */
export function invoiceBriefLines(list: ListResult): string[] {
  const lines = list.items.length === 0 ? ['-- none'] : list.items.map(invoiceBriefLine);
  if (list.total !== null) {
    if (list.total > list.items.length) lines.push(`-- ${list.items.length} of ${list.total} shown`);
  } else if (list.pages !== null && (list.page ?? 1) < list.pages) {
    lines.push('-- more');
  }
  return lines;
}
