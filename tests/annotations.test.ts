import { describe, it, expect } from 'vitest';
import { registeredTools } from './registered-tools.js';

// Hosts read these hints to tell additive creates from irreversible or
// externally visible actions; the spec's defaults (destructive, open-world)
// would mark every create as dangerous. (chrischall/fleet-audit#463)
describe('tool annotations', () => {
  const tools = registeredTools();

  it('annotates every registered tool with an explicit readOnlyHint', () => {
    const missing = [...tools].filter(([, c]) => typeof c.annotations?.readOnlyHint !== 'boolean').map(([n]) => n);
    expect(missing).toEqual([]);
  });

  it('gives every write tool an explicit destructiveHint', () => {
    const missing = [...tools]
      .filter(([, c]) => c.annotations?.readOnlyHint === false && typeof c.annotations.destructiveHint !== 'boolean')
      .map(([n]) => n);
    expect(missing).toEqual([]);
  });

  it('never marks a read-only tool destructive', () => {
    const wrong = [...tools]
      .filter(([, c]) => c.annotations?.readOnlyHint === true && c.annotations.destructiveHint === true)
      .map(([n]) => n);
    expect(wrong).toEqual([]);
  });

  it('gives every tool an explicit openWorldHint', () => {
    const missing = [...tools].filter(([, c]) => typeof c.annotations?.openWorldHint !== 'boolean').map(([n]) => n);
    expect(missing).toEqual([]);
  });

  // The inverse test: a write is additive only if a later call in this tool set
  // restores the prior state. Nothing here deletes, voids or archives a client,
  // invoice, payment, expense, project or time entry, so every create is destructive.
  it.each([
    'freshbooks_create_client',
    'freshbooks_create_invoice',
    'freshbooks_record_payment',
    'freshbooks_create_expense',
    'freshbooks_create_project',
    'freshbooks_create_time_entry',
  ])('%s has no inverse, so it is destructive', (name) => {
    expect(tools.get(name)?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('auth_exchange spends a single-use code, so it is destructive', () => {
    expect(tools.get('freshbooks_auth_exchange')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
  });

  it.each(['freshbooks_update_invoice', 'freshbooks_update_estimate', 'freshbooks_send_estimate'])(
    '%s is destructive',
    (name) => {
      expect(tools.get(name)?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    },
  );

  it('accept_estimate is irreversible but idempotent', () => {
    expect(tools.get('freshbooks_accept_estimate')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
  });

  it.each(['freshbooks_decline_estimate', 'freshbooks_auth_url'])(
    '%s never sends a request, so it is read-only and closed-world',
    (name) => {
      expect(tools.get(name)?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    },
  );
});
