// The freshbooks-curl skill's token helper, driven through bash with a fake
// `curl` on PATH. (chrischall/fleet-audit#461)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../skills/freshbooks-curl/references/fb-token.sh', import.meta.url));
const hasJq = spawnSync('jq', ['--version']).status === 0;

let dir: string;
let state: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fb-skill-'));
  state = join(dir, 'state', 'session.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A fake curl that answers the token endpoint with `token` and everything else with `me`. */
function fakeCurl(token: unknown, me: unknown = {}): void {
  writeFileSync(join(dir, 'token.json'), JSON.stringify(token));
  writeFileSync(join(dir, 'me.json'), JSON.stringify(me));
  const curl = join(dir, 'curl');
  writeFileSync(
    curl,
    `#!/usr/bin/env bash\ncase "$*" in *oauth/token*) cat "${dir}/token.json";; *) cat "${dir}/me.json";; esac\n`,
  );
  chmodSync(curl, 0o755);
  // Records the mode a file had at the moment it was chmod-ed, so the window
  // before the chmod is observable.
  const chmod = join(dir, 'chmod');
  writeFileSync(
    chmod,
    `#!/usr/bin/env bash\nfor a in "$@"; do [ -f "$a" ] && ls -l "$a" | cut -c1-10 >> "${dir}/modes.log"; done\n/bin/chmod "$@"\n`,
  );
  chmodSync(chmod, 0o755);
}

function run(fn: string, umask = '022') {
  return spawnSync('bash', ['-c', `umask ${umask}; . "${SCRIPT}"; ${fn}`], {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      HOME: dir,
      FB_STATE: state,
      FRESHBOOKS_CLIENT_ID: 'cid',
      FRESHBOOKS_CLIENT_SECRET: 'csecret',
      FRESHBOOKS_REFRESH_TOKEN: 'rt-seed',
    },
    encoding: 'utf8',
  });
}

const GOOD_TOKEN = { access_token: 'at', refresh_token: 'rt-next', created_at: Math.floor(Date.now() / 1000), expires_in: 3600 };

describe.skipIf(!hasJq)('freshbooks-curl fb-token.sh', () => {
  it('falls back to roles[].accountid when business.account_id is null', () => {
    fakeCurl(GOOD_TOKEN, {
      response: {
        roles: [{ accountid: 'xZNQ1X' }],
        business_memberships: [{ business: { id: 7, account_id: null, business_uuid: 'u', name: 'Acme' } }],
      },
    });
    const r = run('fb_account_id');
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('xZNQ1X');
  });

  it('still prefers business.account_id when present', () => {
    fakeCurl(GOOD_TOKEN, {
      response: {
        roles: [{ accountid: 'other' }],
        business_memberships: [{ business: { id: 7, account_id: 'mine' } }],
      },
    });
    expect(run('fb_account_id').stdout.trim()).toBe('mine');
  });

  it('refuses a refresh response with no refresh token and keeps the stored one', () => {
    fakeCurl({ access_token: 'at', created_at: 1, expires_in: 3600 });
    const r = run('fb_access_token');
    expect(r.status).not.toBe(0);
    expect(JSON.parse(readFileSync(state, 'utf8')).refresh_token).toBe('rt-seed');
  });

  it('never writes rotated tokens to a file other users can read', () => {
    fakeCurl(GOOD_TOKEN);
    const r = run('fb_access_token', '022');
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(state, 'utf8')).refresh_token).toBe('rt-next');
    const modes = existsSync(join(dir, 'modes.log'))
      ? readFileSync(join(dir, 'modes.log'), 'utf8').trim().split('\n')
      : [];
    // Every file the helper wrote was already owner-only before any chmod.
    expect(modes.filter((m) => m !== '-rw-------')).toEqual([]);
  });
});
