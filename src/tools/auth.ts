import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { minifiedResult } from '@chrischall/mcp-utils';
import { authorizeUrl, exchangeAuthorizationCode, readBootstrapConfig } from '../auth.js';

/**
 * The two tools that mint a refresh token, so nobody has to run a bootstrap
 * script and paste the result into a form.
 *
 * They exist as TOOLS rather than a script because mcp-host's `authFlow`
 * drives a login by calling the child's own tools and capturing a durable
 * credential from the last step. A script cannot be driven that way, so the
 * hosted connector had no choice but to ask for `FRESHBOOKS_REFRESH_TOKEN`
 * up front — a value the person could only obtain by running that script
 * themselves.
 *
 * `freshbooks_auth_url` returns where to go; `freshbooks_auth_exchange` turns
 * what comes back into a refresh token.
 */
export function registerAuthTools(server: McpServer): void {
  server.tool(
    'freshbooks_auth_url',
    "Get the FreshBooks consent URL to authorise this connection. Open it, approve, and you'll land on the redirect URL — pass that whole URL (or just its ?code= value) to freshbooks_auth_exchange. Read-only; contacts nothing.",
    {},
    { readOnlyHint: true },
    async () => {
      const result = readBootstrapConfig();
      if ('error' in result) return minifiedResult({ error: result.error });
      // No network call: this is string assembly, and saying so stops a caller
      // treating a failure here as FreshBooks being down.
      return minifiedResult({
        authorize_url: authorizeUrl(result.config),
        redirect_uri: result.config.redirectUri,
        next: 'Open authorize_url, approve, then pass the URL you land on to freshbooks_auth_exchange.',
      });
    },
  );

  server.tool(
    'freshbooks_auth_exchange',
    'Exchange a FreshBooks authorization code for a refresh token. Accepts the whole redirect URL you landed on, or the bare code. The authorization code is SINGLE-USE — if this fails, get a new one from freshbooks_auth_url rather than retrying.',
    {
      code: z
        .string()
        .describe('The ?code= value, or the entire redirect URL you were sent to after approving.'),
    },
    // Not read-only: it spends the authorization code, which cannot be reused.
    { readOnlyHint: false, idempotentHint: false },
    async ({ code }: { code: string }) => {
      const result = readBootstrapConfig();
      if ('error' in result) return minifiedResult({ error: result.error });
      const tokens = await exchangeAuthorizationCode(result.config, code);
      // The refresh token IS the durable credential mcp-host's authFlow
      // captures from this step. The access token is deliberately NOT
      // returned: it expires in hours and echoing it only widens where a live
      // credential can be read from.
      return minifiedResult({
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in,
        note: 'Store refresh_token as FRESHBOOKS_REFRESH_TOKEN. It rotates on every refresh.',
      });
    },
  );
}
