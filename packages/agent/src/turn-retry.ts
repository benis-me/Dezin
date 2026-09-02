/**
 * Turn failure classification and bounded retry for coding-agent runs.
 */

import type { AgentRunner, AgentTurnInput, AgentTurnResult } from "./types.ts";
import { AgentExecutionIdentityError, isAbortError } from "./types.ts";

export type AgentTurnFailureCategory =
  | "cancelled"
  | "identity"
  | "authentication"
  | "permission"
  | "contract"
  | "rate-limit"
  | "timeout"
  | "transport"
  | "provider-unavailable"
  | "process-crash"
  | "unknown";

export interface AgentTurnFailureClassification {
  category: AgentTurnFailureCategory;
  retryable: boolean;
}

function agentFailureText(error: unknown): string {
  const parts: string[] = [];
  let candidate = error;
  for (let depth = 0; depth < 4 && candidate !== null && candidate !== undefined; depth += 1) {
    if (candidate instanceof Error) {
      parts.push(`${candidate.name}: ${candidate.message}`);
      candidate = candidate.cause;
    } else {
      parts.push(String(candidate));
      break;
    }
  }
  return parts.join("\n");
}

/**
 * Conservative retry contract for coding-agent turns. A retry is permitted only
 * for a failure that is both transient and safe to replay inside the same
 * confined staging directory. Unknown, identity, auth, permission, artifact and
 * cancellation failures remain fail-closed.
 */
export function classifyAgentTurnFailure(error: unknown): AgentTurnFailureClassification {
  if (isAbortError(error)) return { category: "cancelled", retryable: false };
  if (error instanceof AgentExecutionIdentityError
    || (error && typeof error === "object"
      && (error as { code?: unknown }).code === "AGENT_EXECUTION_IDENTITY_MISMATCH")) {
    return { category: "identity", retryable: false };
  }
  const text = agentFailureText(error);
  if (/\b(auth(?:entication|orization)?|unauthori[sz]ed|login required|not logged in)\b|api[- ]?key\s+(?:is\s+)?(?:missing|invalid|expired)|credential\s+(?:is\s+)?(?:missing|invalid|expired)|token\s+(?:is\s+)?expired/i.test(text)) {
    return { category: "authentication", retryable: false };
  }
  if (/\b(permission denied|forbidden|access denied|operation not permitted|not allowed by (?:provider )?policy)\b/i.test(text)) {
    return { category: "permission", retryable: false };
  }
  if (/AGENT_ARTIFACT_|AGENT_OUTPUT_LIMIT|artifact (?:not updated|missing|empty)|invalid request|unsupported provider/i.test(text)) {
    return { category: "contract", retryable: false };
  }
  if (/\b429\b|too many requests|rate[- ]?limit(?:ed| exceeded)?|quota reset/i.test(text)) {
    return { category: "rate-limit", retryable: true };
  }
  if (/timed? out|\bETIMEDOUT\b/i.test(text)) return { category: "timeout", retryable: true };
  if (/\b(?:ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|ENETUNREACH|UND_ERR_[A-Z_]+)\b|socket hang up|stream hiccup|connection (?:reset|closed|lost)/i.test(text)) {
    return { category: "transport", retryable: true };
  }
  if (/\b(?:502|503|504)\b|service unavailable|provider unavailable|temporarily unavailable|overloaded/i.test(text)) {
    return { category: "provider-unavailable", retryable: true };
  }
  if (/process (?:crashed|terminated)|agent crashed|segmentation fault|\bSIG(?:ABRT|BUS|ILL|SEGV)\b|exited with (?:code|signal)\s+(?:1|[2-9]|[1-9]\d+)/i.test(text)) {
    return { category: "process-crash", retryable: true };
  }
  return { category: "unknown", retryable: false };
}

/**
 * Run one agent turn with bounded retry + exponential backoff. Coding-agent CLIs
 * fail transiently (timeouts, stream hiccups, OOM); a retry usually clears it.
 * The FakeRunner never throws, so tests are unaffected.
 */
export async function runTurnWithRetry(
  runner: AgentRunner,
  turnInput: AgentTurnInput,
  opts: { maxAttempts?: number; onRetry?: (attempt: number, err: unknown) => void; sleep?: (ms: number) => Promise<void> } = {},
): Promise<AgentTurnResult> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await runner.runTurn(turnInput);
    } catch (err) {
      lastErr = err;
      // Cancellation and non-transient failures are final. In particular, do
      // not amplify auth, permission or execution-identity conflicts.
      if (turnInput.signal?.aborted || !classifyAgentTurnFailure(err).retryable) throw err;
      if (attempt < maxAttempts) {
        opts.onRetry?.(attempt, err);
        await sleep(400 * 2 ** (attempt - 1));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
