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
      // Judge CODE, not commentary. A comment that QUOTES the bad advice in
      // order to explain what it prevents is not committing it — and once the
      // guard widened, those comments were the only thing it caught. Whole-line
      // comments only, so a `https://…` inside a string is never mistaken for
      // one.
      const src = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*)/.test(line))
        .join('\n');
      // Widened after the ABSENT-credential path shipped local-only advice
      // that the narrower pattern could not see: "Set FRESHBOOKS_CLIENT_ID,
      // FRESHBOOKS_CLIENT_SECRET and FRESHBOOKS_REFRESH_TOKEN" and "run the
      // one-time OAuth bootstrap" are the same mistake in different words.
      // The lookbehind spares the CORRECT hosted line, which has to be allowed
      // to say "do not try to set FRESHBOOKS_REFRESH_TOKEN yourself".
      //
      // Scoped to the three CREDENTIAL variables on purpose.
      // FRESHBOOKS_ACCOUNT_ID is an owner-set override for an identity with no
      // business membership, not a credential a caller recovers — a different
      // question from the one this guard asks.
      return /re-run the OAuth bootstrap|one-time OAuth bootstrap|update FRESHBOOKS_REFRESH_TOKEN\b|(?<!do not try to )\bset (the )?FRESHBOOKS_(REFRESH_TOKEN|CLIENT_ID|CLIENT_SECRET)/i.test(
        src,
      );
    });
    expect(offenders, 'these restate recovery advice instead of calling recoveryHint()').toEqual([]);
  });
});

// The ABSENT credential is a different path from the REJECTED one, and it was
// the one still handing out local-only advice. A connector authorized before
// the connect flow existed has no stored token at all, so its child starts
// with FRESHBOOKS_REFRESH_TOKEN unset — and the reply told the person to set
// an environment variable on a host they have no shell on. Observed live on
// 2026-08-31: the hosted registration's own healthcheck said "the environment
// variable FRESHBOOKS_REFRESH_TOKEN is still not set", and the only way it
// offered out was impossible.
describe('an ABSENT credential gets the same environment-aware advice as a rejected one', () => {
  const saved = process.env.MCP_DATA_DIR;
  beforeEach(() => delete process.env.MCP_DATA_DIR);
  afterEach(() => {
    if (saved === undefined) delete process.env.MCP_DATA_DIR;
    else process.env.MCP_DATA_DIR = saved;
  });

  async function missingTokenError(): Promise<string> {
    const { FreshbooksClient } = await import('../src/client.js');
    const c = new FreshbooksClient({
      clientId: 'id',
      clientSecret: 'secret',
      refreshToken: '',
    } as never);
    try {
      await c.getIdentity();
      throw new Error('expected the call to fail with no refresh token');
    } catch (e) {
      const err = e as { message?: string; hint?: string; data?: { hint?: string } };
      return [err.message, err.hint, err.data?.hint].filter(Boolean).join(' ');
    }
  }

  it('tells a HOSTED user to reconnect, and never to set the variable', async () => {
    process.env.MCP_DATA_DIR = '/data/state/reg_x';
    const text = await missingTokenError();
    expect(text).toMatch(/reconnect/i);
    // The two impossible instructions this used to give: "Set
    // FRESHBOOKS_CLIENT_ID, FRESHBOOKS_CLIENT_SECRET and
    // FRESHBOOKS_REFRESH_TOKEN" (no shell), and "register an app, then run the
    // one-time OAuth bootstrap" (the app is the operator's).
    //
    // Matched with a lookbehind so the CORRECT hosted line — "Do not try to
    // set FRESHBOOKS_REFRESH_TOKEN yourself" — is not itself flagged. A blunt
    // /set FRESHBOOKS_/ fails on the fixed text, which is how this assertion
    // was first written and why it is spelled out here.
    expect(text).not.toMatch(/(?<!do not try to )\bset (the )?FRESHBOOKS_[A-Z_]+/i);
    expect(text).not.toMatch(/register an app|one-time OAuth bootstrap/i);
  });

  it('still tells a LOCAL user how to mint one', async () => {
    const text = await missingTokenError();
    expect(text).toMatch(/freshbooks_auth_url/);
  });
});
