import type { CallToolResult } from '@modelcontextprotocol/server';
import { parseToolResult, type TestHarness } from '@chrischall/mcp-utils/test';

/**
 * Drive a gated write the way a client that cannot be prompted does: call once for the
 * preview + confirmToken, then again with the token. A first call that is not a
 * confirmation request (a pre-gate refusal) is returned as-is.
 */
export async function callConfirmed(
  h: TestHarness,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const first = await h.callTool(name, args);
  if (first.isError) return first;
  const body = parseToolResult(first) as Record<string, unknown>;
  if (body.status !== 'confirmation-required') return first;
  return h.callTool(name, { ...args, confirmToken: body.confirmToken });
}
