import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCredentialHealthcheckTool } from '@chrischall/mcp-utils/healthcheck';
import type { FreshbooksClient } from '../client.js';

/**
 * Register `freshbooks_healthcheck` — resolves the OAuth config the way real
 * tools do, then makes one authenticated call to `/auth/api/v1/users/me`.
 *
 * FreshBooks has no browser bridge, so health is entirely about the
 * credential. It is also the connector where the distinction matters most:
 * the refresh token ROTATES, so each refresh spends the old one and persists a
 * replacement. "The token was rejected" therefore has a specific and
 * recoverable cause here — a spent or superseded token — that is worth naming
 * separately from "FreshBooks is down".
 *
 * `/auth/api/v1/users/me` is the probe because it is the cheapest endpoint that
 * requires a valid access token, so it exercises the whole refresh path.
 */
export function registerHealthcheckTools(server: McpServer, client: FreshbooksClient): void {
  registerCredentialHealthcheckTool({
    server,
    prefix: 'freshbooks',
    hostLabel: 'api.freshbooks.com',
    probePath: '/auth/api/v1/users/me',
    resolveCredential: async () => {
      const state = client.describeCredential();
      if (state.source === null && client.credentialError) {
        // The stored config error already names which vars are missing, which
        // is exactly what the caller needs; surface it rather than a generic
        // "no credential".
        throw new Error(client.credentialError);
      }
      return state;
    },
    probeFn: () => client.getIdentity(),
    hints: {
      credential_rejected:
        'FreshBooks rejected the credential. Refresh tokens ROTATE — each refresh spends the old one — so this usually means the stored token was superseded or the persisted copy was lost. Re-run the OAuth bootstrap to mint a fresh FRESHBOOKS_REFRESH_TOKEN.',
    },
  });
}
