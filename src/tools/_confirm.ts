import type { CallToolResult } from "@modelcontextprotocol/server";
import { minifiedResult, schemaConfirm } from "@chrischall/mcp-utils";

export { schemaConfirm };

/**
 * Confirm-gate for a mutating tool (the fleet convention). When `confirm` is not
 * `true`, returns a no-network dry-run preview of exactly what would be sent; when
 * it is `true`, returns `null` so the caller proceeds with the write.
 *
 * FreshBooks writes are client-visible financial records — an invoice can be emailed
 * to a customer the moment it leaves draft — so a hallucinated call must not fire
 * silently.
 */
export function previewUnlessConfirmed(
  confirm: boolean | undefined,
  action: string,
  method: string,
  path: string,
  body?: unknown,
  /** Shown ahead of the payload — e.g. who an email would go to. */
  highlights: Record<string, unknown> = {},
): CallToolResult | null {
  if (confirm === true) return null;
  return minifiedResult({
    dryRun: true,
    action,
    ...highlights,
    method,
    path,
    ...(body !== undefined ? { willSend: body } : {}),
    note: "Re-run with confirm: true to execute.",
  });
}
