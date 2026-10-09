import { McpToolError } from "@chrischall/mcp-utils";

/**
 * Refuse an update with nothing in it. An empty PUT is a write that reports
 * success while changing nothing — exactly the "assume success from a 200"
 * failure these tools are meant to rule out. Shared by every update tool so
 * invoices and estimates cannot disagree about it.
 */
export function assertNonEmptyUpdate(
  payload: Record<string, unknown>,
  target: string,
  hint: string,
): void {
  if (Object.keys(payload).length > 0) return;
  throw new McpToolError(`No fields supplied, so there is nothing to update on ${target}.`, { hint });
}
