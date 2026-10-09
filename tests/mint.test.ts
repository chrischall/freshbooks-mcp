// mint.yaml's auth.flow is what mcp-host runs to sign a hosted person in. It
// drives this server's OWN tools, so a flow naming a tool that is not
// registered, or an argument its schema does not accept, fails at CONNECT time,
// in front of the person signing in. These tests pin the flow against the
// registrars themselves, then run it end to end the way the host does.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/server';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerAuthTools } from '../src/tools/auth.js';

type Arg = string | number | boolean | { from: string };
type Prompt = { name: string; label: string; type?: string; help?: string };
type Step = {
  tool: string;
  args?: Record<string, Arg>;
  prompt?: Prompt[];
  carry?: string[];
  title?: string;
  description?: string;
  link?: { from: string; hosts: string[]; label?: string };
};
type Flow = {
  steps: Step[];
  capture?: { tool: string; args?: Record<string, Arg>; path?: string; into: string };
};

const mint = readFileSync(fileURLToPath(new URL('../mint.yaml', import.meta.url)), 'utf8');

/**
 * The flow, parsed. mint.yaml writes it in YAML's JSON-compatible flow style
 * precisely so it can be read here without a YAML dependency, and so the same
 * document is what gets PUT onto the live registration.
 */
function readFlow(): Flow {
  const lines = mint.split('\n');
  const start = lines.findIndex((line) => /^ {2}flow:\s*$/.test(line));
  expect(start, 'mint.yaml has no auth.flow').toBeGreaterThan(-1);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // the next top-level key
    if (/^\s*#/.test(line)) continue;
    body.push(line);
  }
  return JSON.parse(body.join('\n')) as Flow;
}

/** Each auth tool's accepted argument names, read from what it REGISTERS. */
function authToolArgs(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const server = {
    registerTool: (name: string, def: { inputSchema?: { shape?: Record<string, unknown> } }) => {
      out[name] = Object.keys(def.inputSchema?.shape ?? {});
    },
  } as unknown as McpServer;
  registerAuthTools(server);
  return out;
}

const flow = readFlow();
const tools = authToolArgs();
const allCalls = [...flow.steps, ...(flow.capture ? [flow.capture] : [])];

describe('mint.yaml auth flow matches the registered tools', () => {
  it('names only tools the server registers', () => {
    expect(allCalls.length).toBeGreaterThan(1);
    for (const call of allCalls) expect(Object.keys(tools)).toContain(call.tool);
  });

  it('passes only arguments each tool accepts', () => {
    let checked = 0;
    for (const call of allCalls) {
      for (const arg of Object.keys(call.args ?? {})) {
        expect(tools[call.tool], `${call.tool} accepts ${arg}`).toContain(arg);
        checked++;
      }
    }
    // Anti-vacuity: a parse that found no arguments would pass everything above.
    expect(checked).toBeGreaterThanOrEqual(1);
  });

  it('reads every {from} only after an earlier step or this step\'s prompt provides it', () => {
    const scope = new Set<string>();
    for (const step of flow.steps) {
      if (step.link) {
        expect(step.prompt?.length, 'a link is only shown on a step that prompts').toBeGreaterThan(0);
        expect(scope.has(step.link.from), `link reads "${step.link.from}" from an earlier step`).toBe(true);
      }
      for (const prompt of step.prompt ?? []) scope.add(prompt.name);
      for (const value of Object.values(step.args ?? {})) {
        if (typeof value === 'object') expect(scope.has(value.from)).toBe(true);
      }
      for (const name of step.carry ?? []) scope.add(name);
    }
    for (const value of Object.values(flow.capture?.args ?? {})) {
      if (typeof value === 'object') expect(scope.has(value.from)).toBe(true);
    }
  });
});

describe('mint.yaml sign-in uses the consent URL freshbooks_auth_url issues', () => {
  it('carries authorize_url and shows it as a step link on auth.freshbooks.com', () => {
    const issuing = flow.steps.findIndex((step) => step.tool === 'freshbooks_auth_url' && step.carry?.includes('authorize_url'));
    expect(issuing).toBeGreaterThan(-1);
    const linked = flow.steps.findIndex((step) => step.link?.from === 'authorize_url');
    expect(linked).toBeGreaterThan(issuing);
    expect(flow.steps[linked]!.link!.hosts).toEqual(['auth.freshbooks.com']);
  });

  it('asks the linked step for the WHOLE redirect URL and hands it to the exchange', () => {
    const linked = flow.steps.find((step) => step.link?.from === 'authorize_url')!;
    expect(linked.prompt).toHaveLength(1);
    const prompt = linked.prompt![0]!;
    expect(prompt.type).toBe('text');
    expect(`${prompt.label} ${prompt.help ?? ''}`).toMatch(/whole|full|entire/i);
    expect(flow.capture).toMatchObject({
      tool: 'freshbooks_auth_exchange',
      args: { code: { from: prompt.name } },
      path: 'refresh_token',
      into: 'FRESHBOOKS_REFRESH_TOKEN',
    });
  });

  it('carries no static consent link — a state-less link is refused by the exchange', () => {
    expect(mint).not.toMatch(/oauth\/authorize/);
    expect(mint).not.toMatch(/client_id=/);
  });

  it('declares per-user children and a data dir, so both calls see one state file', () => {
    expect(mint).toMatch(/^identity:\n {2}perUserChild: true$/m);
    expect(mint).toMatch(/^state:\n {2}dataDir: true$/m);
  });
});

describe('mint.yaml auth flow, run the way mcp-host runs it', () => {
  const variables = [
    'FRESHBOOKS_CLIENT_ID', 'FRESHBOOKS_CLIENT_SECRET', 'FRESHBOOKS_REFRESH_TOKEN',
    'FRESHBOOKS_REDIRECT_URI', 'FRESHBOOKS_TOKEN_STORE', 'MCP_DATA_DIR',
  ] as const;
  let saved: Record<string, string | undefined>;
  let directory: string;

  beforeEach(() => {
    saved = Object.fromEntries(variables.map((name) => [name, process.env[name]]));
    for (const name of variables) delete process.env[name];
    directory = mkdtempSync(join(tmpdir(), 'freshbooks-mint-flow-'));
    process.env.FRESHBOOKS_CLIENT_ID = 'dummy-app';
    process.env.FRESHBOOKS_CLIENT_SECRET = 'dummy-secret';
    process.env.MCP_DATA_DIR = join(directory, 'data'); // hosted
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    for (const name of variables) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    rmSync(directory, { recursive: true, force: true });
  });

  /** One call on a FRESH module instance: the child may respawn between any two calls. */
  async function callOnFreshChild(tool: string, args: Record<string, unknown>) {
    vi.resetModules();
    const { registerAuthTools: register } = await import('../src/tools/auth.js');
    const h = await createTestHarness((server) => register(server));
    try {
      return await h.callTool(tool, args);
    } finally {
      await h.close();
    }
  }

  function resolve(args: Record<string, Arg> | undefined, bag: Record<string, string>) {
    return Object.fromEntries(
      Object.entries(args ?? {}).map(([k, v]) => [k, typeof v === 'object' ? bag[v.from] : v]),
    );
  }

  it('captures a refresh token from the redirect of the link it showed, across respawns', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (String(input) === 'https://api.freshbooks.com/auth/oauth/token') {
        return Response.json({
          access_token: 'a', refresh_token: 'captured-rt', created_at: Math.floor(Date.now() / 1000), expires_in: 3600,
        });
      }
      throw new Error(`Unexpected test request: ${String(input)}`);
    }));

    const bag: Record<string, string> = {};
    for (const step of flow.steps) {
      for (const prompt of step.prompt ?? []) {
        // The person opens the link, approves, and pastes where FreshBooks sent them.
        const consent = new URL(bag[step.link!.from]!);
        expect(step.link!.hosts).toContain(consent.hostname);
        const redirect = new URL(consent.searchParams.get('redirect_uri')!);
        redirect.searchParams.set('code', 'one-time-code');
        redirect.searchParams.set('state', consent.searchParams.get('state')!);
        bag[prompt.name] = redirect.toString();
      }
      const result = await callOnFreshChild(step.tool, resolve(step.args, bag));
      expect(result.isError, `${step.tool} refused`).toBeFalsy();
      const structured = parseToolResult(result) as Record<string, unknown>;
      for (const name of step.carry ?? []) {
        expect(typeof structured[name]).toBe('string');
        bag[name] = structured[name] as string;
      }
    }

    const capture = flow.capture!;
    const result = await callOnFreshChild(capture.tool, resolve(capture.args, bag));
    expect(result.isError).toBeFalsy();
    expect((parseToolResult(result) as Record<string, unknown>)[capture.path!]).toBe('captured-rt');
  });
});
