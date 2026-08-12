#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { FreshbooksClient } from './client.js';
import { registerAccountTools } from './tools/account.js';
import { registerInvoicingTools } from './tools/invoicing.js';
import { VERSION } from './version.js';

// Built in the caller so the deferred-config-error pattern holds: the server still
// boots (and answers the host's install-time tools/list probe) with no credentials
// present, and the configuration error surfaces on the first tool call instead.
const client = new FreshbooksClient();

await runMcp({
  name: 'freshbooks-mcp',
  version: VERSION,
  banner: '[freshbooks-mcp] This project was developed and is maintained by AI. Use at your own discretion.',
  deps: client,
  tools: [registerAccountTools, registerInvoicingTools],
});
