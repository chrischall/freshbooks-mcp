import { parseToolResult, type TestHarness } from '@chrischall/mcp-utils/test';

/**
 * Walk the consent round-trip the way a person does: ask
 * `freshbooks_auth_url` for the consent URL, then build the redirect URL
 * FreshBooks would send them to — carrying `code` and the issued `state`.
 * `freshbooks_auth_exchange` refuses anything else (fleet-audit#465).
 */
export async function consentRedirect(h: TestHarness, code: string): Promise<string> {
  const issued = parseToolResult(await h.callTool('freshbooks_auth_url', {})) as {
    authorize_url: string;
    redirect_uri: string;
  };
  const state = new URL(issued.authorize_url).searchParams.get('state');
  if (!state) throw new Error('freshbooks_auth_url issued no state');
  const redirect = new URL(issued.redirect_uri);
  redirect.searchParams.set('code', code);
  redirect.searchParams.set('state', state);
  return redirect.toString();
}
