import type { CallToolResult, InputRequiredResult, ServerContext } from "@modelcontextprotocol/server";
import {
  confirmationFromEnv,
  confirmTokenParam,
  requireConfirmationWithFallback,
} from "@chrischall/mcp-utils";

export { confirmTokenParam };

/** Appended to every gated tool's description. */
export const CONFIRM_DESCRIPTION =
  "Asks the user to confirm first: a confirmation prompt where the client supports one; otherwise " +
  "the first call returns a preview and a confirmToken and makes no network call, and only a repeat " +
  "call with that token proceeds (see MCP_CONFIRM_MODE).";

export interface ConfirmWriteOptions {
  /** The tool name the token is bound to. */
  tool: string;
  /** `<resource>.<verb>`, e.g. `invoice.create`. */
  action: string;
  /** Human summary shown in the preview, e.g. "Create FreshBooks invoice". */
  summary: string;
  method: string;
  path: string;
  /** Exactly what the write will send. */
  body: unknown;
  /** The record the write acts on, or undefined for a create. */
  target?: number;
  /** Shown ahead of the payload — e.g. who an email would go to. */
  highlights?: Record<string, unknown>;
  /** Options that change what the write does without being sent (bound into the token). */
  options?: Record<string, unknown>;
  confirmToken: string | undefined;
}

/**
 * Confirm-gate for a mutating tool. FreshBooks writes are client-visible financial
 * records — an invoice can be emailed to a customer the moment it leaves draft — so a
 * hallucinated call must not fire silently.
 *
 * Returns `undefined` when the write may proceed, otherwise the result to return
 * unchanged (the elicitation round, the phase-1 preview + token, or a refusal). The
 * preview is built from the arguments alone: no network call happens before approval.
 */
export async function confirmWrite(
  ctx: ServerContext,
  o: ConfirmWriteOptions,
): Promise<InputRequiredResult | CallToolResult | undefined> {
  const preview: Record<string, unknown> = {
    action: o.summary,
    ...(o.highlights ?? {}),
    method: o.method,
    path: o.path,
    ...(o.body !== undefined ? { willSend: o.body } : {}),
  };
  return requireConfirmationWithFallback(
    ctx,
    confirmationFromEnv({
      action: o.action,
      message: `Review and confirm: ${o.summary}`,
      details: preview,
      tool: o.tool,
      confirmToken: o.confirmToken,
      subject: () => ({
        target: o.target === undefined ? "" : String(o.target),
        payload: {
          method: o.method,
          path: o.path,
          body: o.body,
          ...(o.options ? { options: o.options } : {}),
        },
        preview,
      }),
    }),
  );
}
