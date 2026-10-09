import type { McpServer } from '@modelcontextprotocol/server';
import { FreshbooksClient } from '../src/client.js';
import { registerAccountTools } from '../src/tools/account.js';
import { registerAuthTools } from '../src/tools/auth.js';
import { registerEstimateTools } from '../src/tools/estimates.js';
import { registerExpenseTools } from '../src/tools/expenses.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { registerInvoicingTools } from '../src/tools/invoicing.js';
import { registerProjectTools } from '../src/tools/projects.js';
import { registerRecordTools } from '../src/tools/records.js';

type Annotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

/**
 * Every registered tool's annotations, read by REGISTERING rather than by
 * scanning source — the invoicing reads are registered in a loop, so a grep
 * misses them. The test harness's listTools drops annotations, hence the stub.
 */
export function registeredTools(): Map<string, { description?: string; annotations?: Annotations }> {
  const tools = new Map<string, { description?: string; annotations?: Annotations }>();
  const server = {
    registerTool: (name: string, cfg: { description?: string; annotations?: Annotations }) =>
      void tools.set(name, cfg),
  } as unknown as McpServer;
  const client = new FreshbooksClient({ fetchImpl: (() => { throw new Error('no network'); }) as never, storePath: '/tmp/fb-annotations-test.json' });
  registerAuthTools(server);
  registerAccountTools(server, client);
  registerHealthcheckTools(server, client);
  registerInvoicingTools(server, client);
  registerEstimateTools(server, client);
  registerExpenseTools(server, client);
  registerProjectTools(server, client);
  registerRecordTools(server, client);
  return tools;
}
