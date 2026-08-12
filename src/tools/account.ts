import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult } from '@chrischall/mcp-utils';
import type { FreshbooksClient } from '../client.js';

export function registerAccountTools(server: McpServer, client: FreshbooksClient): void {
  server.registerTool(
    'freshbooks_get_identity',
    {
      description:
        'Resolve the authenticated FreshBooks user and their identifiers: accountId (alphanumeric, ' +
        'used by accounting and payments endpoints), businessId (integer, used by projects and time ' +
        'tracking) and businessUuid. The three are not interchangeable — using the wrong one returns ' +
        'a 404 rather than a useful error.',
      annotations: { readOnlyHint: true },
    },
    async () => textResult(await client.getIdentity()),
  );
}
