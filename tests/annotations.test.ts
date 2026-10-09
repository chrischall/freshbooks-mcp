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

  it.each([
    'freshbooks_create_client',
    'freshbooks_create_invoice',
    'freshbooks_record_payment',
    'freshbooks_create_expense',
    'freshbooks_create_project',
    'freshbooks_create_time_entry',
  ])('%s is an additive write', (name) => {
    expect(tools.get(name)?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
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

  it('decline_estimate never sends a request, so it is read-only', () => {
    expect(tools.get('freshbooks_decline_estimate')?.annotations).toMatchObject({ readOnlyHint: true });
  });
});
