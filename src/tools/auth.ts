import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { minifiedResult } from "@chrischall/mcp-utils";
import {
  authorizeUrl,
  authorizeLocally,
  exchangeAuthorizationCode,
  isHosted,
  issueAuthState,
  readBootstrapConfig,
  verifyAuthorizationResponse,
} from "../auth.js";

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
 * what comes back into a refresh token. Local sessions save it privately;
 * hosted sessions return it to mcp-host's credential-capture flow.
 */
export function registerAuthTools(server: McpServer): void {
  server.registerTool(
    "freshbooks_auth_url",
    {
      description:
        "Get the FreshBooks consent URL to authorize this connection. Open it, approve, and you'll land on the redirect URL — pass that whole URL to freshbooks_auth_exchange (its state parameter binds the approval to this server; valid 15 minutes, single-use). Read-only; contacts nothing.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const result = readBootstrapConfig();
      if ("error" in result) return minifiedResult({ error: result.error });
      // No network call: this is string assembly, and saying so stops a caller
      // treating a failure here as FreshBooks being down.
      return minifiedResult({
        authorize_url: authorizeUrl(result.config, issueAuthState()),
        redirect_uri: result.config.redirectUri,
        next: "Open authorize_url, approve, then pass the URL you land on to freshbooks_auth_exchange.",
      });
    },
  );

  server.registerTool(
    "freshbooks_auth_exchange",
    {
      description:
        "Complete FreshBooks authorization. Local sessions save the credentials privately and return only status; hosted sessions return the refresh token to the host's credential-capture flow. Pass the whole redirect URL: its state must match a consent URL freshbooks_auth_url issued, so a bare code is refused. The code is SINGLE-USE — if this fails, authorize again rather than retrying it.",
      inputSchema: z.object({
        code: z
          .string()
          .describe(
            "The entire redirect URL you were sent to after approving, including its state parameter. A bare ?code= value is refused.",
          ),
      }),
      // Destructive: it spends a single-use authorization code and replaces the saved
      // credentials, and nothing in this tool set restores either.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ code }: { code: string }) => {
      const result = readBootstrapConfig();
      if ("error" in result) return minifiedResult({ error: result.error });
      // Before the code is spent: refuse a paste that is not the redirect from
      // a consent URL this server issued (fleet-audit#465).
      verifyAuthorizationResponse(code, result.config);
      if (!isHosted()) {
        await authorizeLocally(result.config, code);
        return minifiedResult({
          connected: true,
          note: "Credentials were saved privately. Restart the local MCP server to use them. No refresh token needs to be copied into chat or configuration.",
        });
      }
      // The refresh token IS the durable credential mcp-host's authFlow
      // captures from this step. The access token is deliberately NOT
      // returned: it expires in hours and echoing it only widens where a live
      // credential can be read from.
      const tokens = await exchangeAuthorizationCode(result.config, code);
      return minifiedResult({
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in,
        note: "Store refresh_token as FRESHBOOKS_REFRESH_TOKEN. It rotates on every refresh.",
      });
    },
  );
}
