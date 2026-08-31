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
