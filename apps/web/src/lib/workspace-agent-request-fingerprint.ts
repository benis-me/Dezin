import type { WorkspaceAgentTurnInput } from "./api.ts";

/**
 * Stable browser-side identity for the immutable facts accepted by one
 * Workspace Agent turn. The idempotency turnId is deliberately excluded.
 */
export function workspaceAgentRequestFingerprint(
  request: Omit<WorkspaceAgentTurnInput, "turnId">,
): string {
  return JSON.stringify({
    message: request.message,
    agentCommand: request.agentCommand,
    model: request.model,
    explicitContext: request.explicitContext,
    graphRevision: request.graphRevision,
    selection: request.selection ?? [],
  });
}
