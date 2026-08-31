import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { recoveryHint } from '../src/auth.js';

/**
 * The hint that a spent refresh token produces is the ONE piece of text a
 * person acts on when the connector dies, and it was written for local dev:
 * "re-run the OAuth bootstrap and update FRESHBOOKS_REFRESH_TOKEN".
 *
 * On a hosted registration that advice is not merely unhelpful, it is
 * impossible — there is no shell to export into and no server to restart, and
 * the value the child receives comes from a principal secret the person cannot
 * edit from a chat. Following it costs a manual bootstrap whose result then has
 * nowhere to go.
 */
describe('recoveryHint', () => {
  const saved = process.env.MCP_DATA_DIR;
  beforeEach(() => delete process.env.MCP_DATA_DIR);
  afterEach(() => {
    if (saved === undefined) delete process.env.MCP_DATA_DIR;
    else process.env.MCP_DATA_DIR = saved;
  });

  it('tells a HOSTED user to reconnect, and not to set the env var', () => {
    process.env.MCP_DATA_DIR = '/data/state/reg_x';
    const h = recoveryHint();
    expect(h).toMatch(/reconnect/i);
    expect(h).not.toMatch(/export/i);
    expect(h).not.toMatch(/restart/i);
  });

  it('tells a LOCAL user how to mint one, preferring the tools over the script', () => {
    const h = recoveryHint();
    expect(h).toMatch(/freshbooks_auth_url/);
    expect(h).toMatch(/FRESHBOOKS_REFRESH_TOKEN/);
  });

  // Both paths must name the cause, or the reader assumes a transient failure
  // and retries a token that can never work again.
  it('says the token is single-use in both environments', () => {
    expect(recoveryHint()).toMatch(/single-use|rotate/i);
    process.env.MCP_DATA_DIR = '/data/state/reg_x';
    expect(recoveryHint()).toMatch(/single-use|rotate/i);
  });
});

// Four sites carried this advice and I fixed three; the healthcheck's own hint
// was the one left behind — and it is the worst one to miss, since a
// healthcheck exists to tell someone what to do. Nothing structural stopped a
// fifth copy appearing, so this does.
describe('no site restates the recovery advice', () => {
  it('only auth.ts defines it; everywhere else calls recoveryHint()', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(__dirname, '..', 'src');
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((e) => {
        const p = join(d, e);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
      });
    // Exactly src/auth.ts, matched on the full path. `endsWith('auth.ts')`
    // reads the same but also exempts src/tools/auth.ts — the file most
    // likely to grow a fifth copy of this advice, so the blind spot sat
    // precisely where the guard was needed.
    const definition = join(root, 'auth.ts');
    const offenders = walk(root).filter((f) => {
      if (f === definition) return false; // the definition lives here
      const src = readFileSync(f, 'utf8');
      return /re-run the OAuth bootstrap|update FRESHBOOKS_REFRESH_TOKEN\b/i.test(src);
    });
    expect(offenders, 'these restate recovery advice instead of calling recoveryHint()').toEqual([]);
  });
});
