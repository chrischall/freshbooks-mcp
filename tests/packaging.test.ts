// Packaging invariants that otherwise only fail once a tag exists — after
// release-please has already cut a GitHub Release, when `npm publish --provenance`
// rejects the whole publish and the registry/plugin steps silently skip.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

describe('packaging', () => {
  const pkg = read('package.json');

  it('declares repository.url so sigstore provenance validates', () => {
    // npm rejects the publish with E422 when this is missing, AFTER the tag exists.
    expect(pkg.repository?.url).toBe('git+https://github.com/chrischall/freshbooks-mcp.git');
  });

  it('is scoped with public access', () => {
    expect(pkg.name).toBe('@chrischall/freshbooks-mcp');
    expect(pkg.publishConfig?.access).toBe('public');
  });

  it('ships skills/ on npm', () => {
    expect(pkg.files).toContain('skills/');
  });

  it('keeps the mcpb node floor on an LTS release', () => {
    // Not 26 — an LTS floor is what lets LTS users install the .mcpb at all.
    expect(read('manifest.json').compatibility.runtimes.node).toBe('>=22.5');
  });

  it("keeps server.json's description within the MCP registry's 100-char limit", () => {
    // mcp-publisher 422s over 100 characters.
    expect(read('server.json').description.length).toBeLessThanOrEqual(100);
  });

  it('registers every version-bearing file in release-please extra-files', () => {
    const extra = JSON.stringify(read('release-please-config.json').packages['.']['extra-files']);
    for (const f of [
      'manifest.json',
      'server.json',
      '.claude-plugin/plugin.json',
      '.claude-plugin/marketplace.json',
      'src/version.ts',
    ]) {
      expect(extra, `missing ${f}`).toContain(f);
    }
  });

  it('seeds a 0.x initial version rather than release-please\'s 1.0.0 default', () => {
    const p = read('release-please-config.json').packages['.'];
    expect(p['initial-version']).toBe('0.1.0');
    expect(p['bump-minor-pre-major']).toBe(true);
  });

  it('keeps all manifests at one version', () => {
    const v = pkg.version;
    expect(read('manifest.json').version).toBe(v);
    expect(read('server.json').version).toBe(v);
    expect(read('server.json').packages[0].version).toBe(v);
    expect(read('.claude-plugin/plugin.json').version).toBe(v);
    expect(read('.claude-plugin/marketplace.json').metadata.version).toBe(v);
    expect(read('.claude-plugin/marketplace.json').plugins[0].version).toBe(v);
  });
});
