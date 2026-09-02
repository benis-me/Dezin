import {
  AgentExecutionIdentityError,
  AgentTurnError,
  type AgentRunner,
  type AgentTurnResult,
} from "@dezin/agent";

export interface ObservedDesignAgentIdentity {
  runnerId: string;
  model: string | null;
}

function exactIdentity(input: ObservedDesignAgentIdentity): ObservedDesignAgentIdentity {
  if (typeof input.runnerId !== "string" || !input.runnerId.trim()
    || input.runnerId.trim() !== input.runnerId || Buffer.byteLength(input.runnerId, "utf8") > 512
    || !(input.model === null || (typeof input.model === "string" && input.model.trim()
      && input.model.trim() === input.model && Buffer.byteLength(input.model, "utf8") <= 512))) {
    throw new Error("Design Agent returned an invalid execution identity");
  }
  return input;
}

/**
 * Claude-compatible production runners attest identity through system/init.
 * Invocation-only runners (including test adapters) retain the exact provider
 * and model bound to their spawned command.
 */
export function observedDesignAgentIdentity(input: {
  runner: AgentRunner;
  requestedModel: string | null;
  result: AgentTurnResult;
}): ObservedDesignAgentIdentity {
  const execution = input.result.executionIdentity;
  if (execution === undefined) {
    if (input.runner.identityProtocol === "claude-stream-json-init-v1") {
      throw new Error("Design Agent omitted its required stream execution identity");
    }
    return exactIdentity({ runnerId: input.runner.id, model: input.requestedModel });
  }
  if (execution.requested.providerId !== input.runner.id
    || execution.requested.model !== input.requestedModel) {
    throw new Error("Design Agent execution identity does not match the requested runner invocation");
  }
  if (execution.observed.providerId !== input.runner.id) {
    throw new Error("Design Agent runtime reported a different provider identity");
  }
  return exactIdentity({
    runnerId: execution.observed.providerId,
    model: execution.observed.model,
  });
}

export function observedDesignAgentIdentityFromError(
  error: unknown,
  input: { runner: AgentRunner; requestedModel: string | null },
): ObservedDesignAgentIdentity | null {
  const execution = error instanceof AgentTurnError
    ? error.executionIdentity
    : error instanceof AgentExecutionIdentityError && error.observed !== null
      ? { requested: error.requested, observed: error.observed }
      : null;
  if (execution === null
    || execution.requested.providerId !== input.runner.id
    || execution.requested.model !== input.requestedModel
    || execution.observed.providerId !== input.runner.id) return null;
  return exactIdentity({
    runnerId: execution.observed.providerId,
    model: execution.observed.model,
  });
}
