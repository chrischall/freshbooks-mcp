import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registeredTools } from './registered-tools.js';

/**
 * `manifest.json`'s tool roster must equal the REGISTERED roster, both ways.
 *
 * An mcpb host or registry reads this to decide what to show; with no `tools`
 * array it sees an empty surface, and drift between the manifest and the
 * server goes unnoticed. (chrischall/fleet-audit#1007)
 */
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../manifest.json', import.meta.url)), 'utf8'),
) as { tools?: { name: string; description?: string }[] };

describe('manifest.json tool roster', () => {
  const registered = [...registeredTools().keys()];
  const listed = (manifest.tools ?? []).map((t) => t.name);

  it('lists every registered tool', () => {
    expect(registered.filter((n) => !listed.includes(n))).toEqual([]);
  });

  it('lists no tool that is not registered', () => {
    expect(listed.filter((n) => !registered.includes(n))).toEqual([]);
  });

  it('gives every entry a non-blank description', () => {
    expect((manifest.tools ?? []).filter((t) => !t.description?.trim()).map((t) => t.name)).toEqual([]);
  });
});
