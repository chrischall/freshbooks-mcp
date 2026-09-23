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

  it('lets a Claude Desktop (.mcpb) user choose the business and confirm its accountId', () => {
    // A multi-business identity has writes refused until FRESHBOOKS_BUSINESS_ID is
    // set; the Desktop extension UI can only set what user_config exposes.
    const m = read('manifest.json');
    for (const [key, env] of [
      ['freshbooks_business_id', 'FRESHBOOKS_BUSINESS_ID'],
      ['freshbooks_account_id', 'FRESHBOOKS_ACCOUNT_ID'],
    ]) {
      expect(m.user_config[key], key).toBeDefined();
      expect(m.user_config[key].required, key).toBe(false);
      expect(m.server.mcp_config.env[env]).toBe(`\${user_config.${key}}`);
    }
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
    // `bump-minor-pre-major` was asserted here too and is a DIFFERENT claim
    // wearing the same sentence. `initial-version` pins the FIRST release;
    // that flag governs every later breaking change, by downgrading one to a
    // minor for as long as the package sits below 1.0. It kept this server on
    // 0.x through the SDK v2 migration — a breaking change with its own
    // warning section in the changelog — and would have kept it there for
    // good. Removed, not inverted: the repos that behave correctly omit it.
    expect(p['bump-minor-pre-major']).toBeUndefined();
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
