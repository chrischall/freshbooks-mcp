// Two REAL OS processes sharing one token store (fleet-audit#1008).
//
// The in-process tests in auth.test.ts construct two TokenManagers in one
// process. That proves the re-read, but not that the lock is a cross-process
// one: an in-memory mutex would pass them too. Here each side is a separate
// `node` process, racing an expired token against a FreshBooks-like endpoint
// that accepts each refresh token exactly once. If either process spent a
// refresh token the other had already rotated, the endpoint answers
// invalid_grant and that process fails — and the token left on disk is no
// longer the live one.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let bundleDir: string;
let childScript: string;

beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), 'fb-xproc-bundle-'));
  childScript = join(bundleDir, 'child.mjs');
  // A tiny child: build a TokenManager over the shared store, ask for a token,
  // print it. The token endpoint is redirected to the parent's local server.
  await build({
    stdin: {
      contents: `
        import { createTokenManager } from ${JSON.stringify(join(ROOT, 'src/auth.ts'))};
        const [storePath, endpoint] = process.argv.slice(2);
        const fetchImpl = (_url, init) => fetch(endpoint, init);
        const tm = createTokenManager(
          { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://localhost', refreshToken: 'env-token-1' },
          { storePath, fetchImpl },
        );
        try {
          process.stdout.write(await tm.getAccessToken());
        } catch (err) {
          process.stderr.write(String(err && err.message));
          process.exit(1);
        }
      `,
      resolveDir: ROOT,
      sourcefile: 'child.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: childScript,
    logLevel: 'silent',
  });
}, 30_000);
afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

let dir: string;
let storePath: string;
let server: Server;
let endpoint: string;
let spent: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fb-xproc-'));
  storePath = join(dir, 'session.json');
  spent = [];
  const valid = new Set(['env-token-1']);
  let n = 0;
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const rt = new URLSearchParams(raw).get('refresh_token') ?? '';
      spent.push(rt);
      // Hold the exchange open so the two processes genuinely overlap.
      setTimeout(() => {
        res.setHeader('Content-Type', 'application/json');
        if (!valid.delete(rt)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        n += 1;
        valid.add(`rotated-${n}`);
        res.end(
          JSON.stringify({
            access_token: `access-${n}`,
            refresh_token: `rotated-${n}`,
            created_at: Math.floor(Date.now() / 1000),
            expires_in: 3600,
          }),
        );
      }, 150);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  endpoint = `http://127.0.0.1:${addr.port}/auth/oauth/token`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function runChild(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [childScript, storePath, endpoint], {
      env: { ...process.env, MCP_DATA_DIR: '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

describe('two processes refreshing one store', () => {
  it('spend the single-use refresh token once and leave the live rotation on disk', async () => {
    const [a, b] = await Promise.all([runChild(), runChild()]);

    expect(a).toMatchObject({ code: 0, stderr: '' });
    expect(b).toMatchObject({ code: 0, stderr: '' });
    // One exchange: the loser adopted the winner's token instead of replaying
    // env-token-1 (which would have been an invalid_grant lockout).
    expect(spent).toEqual(['env-token-1']);
    expect(a.stdout).toBe('access-1');
    expect(b.stdout).toBe('access-1');
    // The rotated refresh token was not clobbered by a stale write.
    expect(readFileSync(storePath, 'utf8')).toContain('rotated-1');
    expect(readFileSync(storePath, 'utf8')).not.toContain('env-token-1');
  }, 30_000);
});
