// Spawn the REAL built artifacts and drive the MCP handshake.
//
// This catches two failures that unit tests (which mock everything) never see:
//   1. an eager top-level import of an esbuild-`--external` dep, which crashes the
//      .mcpb bundle at LOAD because that bundle ships no node_modules; and
//   2. a wrong `bin` path from a tsconfig rootDir mistake (dist/src/index.js).
import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Run the initialize + tools/list handshake against a server entrypoint. */
function handshake(entry: string, cwd: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      cwd,
      // No credentials: the server must still boot and answer tools/list.
      env: { ...process.env, FRESHBOOKS_CLIENT_ID: '', FRESHBOOKS_CLIENT_SECRET: '', FRESHBOOKS_REFRESH_TOKEN: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out. stderr: ${err.slice(0, 800)}`));
    }, 20_000);

    child.stdout.on('data', (d) => {
      out += String(d);
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: { tools?: { name: string }[] } };
          if (msg.id === 2 && msg.result?.tools) {
            clearTimeout(timer);
            child.kill();
            resolve(msg.result.tools.map((t) => t.name));
            return;
          }
        } catch {
          /* partial line */
        }
      }
    });
    child.stderr.on('data', (d) => (err += String(d)));
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== null && code !== 0) reject(new Error(`exited ${code}. stderr: ${err.slice(0, 800)}`));
    });

    const send = (o: unknown) => child.stdin.write(`${JSON.stringify(o)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'boot-test', version: '0' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  });
}

describe('server boot', () => {
  beforeAll(() => {
    if (!existsSync(join(ROOT, 'dist/bundle.js'))) {
      throw new Error('run `npm run build` before this test');
    }
  });

  it('the bin entrypoint answers initialize + tools/list', async () => {
    const tools = await handshake(join(ROOT, 'dist/index.js'), ROOT);
    expect(tools.length).toBeGreaterThanOrEqual(14);
    expect(tools).toContain('freshbooks_get_identity');
  }, 30_000);

  it('the .mcpb bundle boots with NO node_modules present', async () => {
    // Copy just the two files the .mcpb ships into an empty dir. An eager import of
    // an externalized dep dies here with ERR_MODULE_NOT_FOUND, which in a real host
    // surfaces only as "Server transport closed unexpectedly".
    const dir = mkdtempSync(join(tmpdir(), 'fb-mcpb-'));
    copyFileSync(join(ROOT, 'dist/bundle.js'), join(dir, 'bundle.js'));
    copyFileSync(join(ROOT, 'package.json'), join(dir, 'package.json'));
    const tools = await handshake(join(dir, 'bundle.js'), dir);
    expect(tools).toContain('freshbooks_list_invoices');
  }, 30_000);
});
