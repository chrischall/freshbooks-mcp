#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { FreshbooksClient } from './client.js';
import { registerAccountTools } from './tools/account.js';
import { registerHealthcheckTools } from './tools/healthcheck.js';
import { registerEstimateTools } from './tools/estimates.js';
import { registerExpenseTools } from './tools/expenses.js';
import { registerInvoicingTools } from './tools/invoicing.js';
import { registerProjectTools } from './tools/projects.js';
import { registerRecordTools } from './tools/records.js';
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
  tools: [
    registerAccountTools,
    registerHealthcheckTools,
    registerInvoicingTools,
    registerEstimateTools,
    registerExpenseTools,
    registerProjectTools,
    registerRecordTools,
  ],
});
