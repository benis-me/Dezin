/**
 * Agent runner abstraction. A runner drives ONE agent turn: given a system prompt
 * and a message, it produces an artifact (in practice by writing a file the agent
 * controls) and returns the artifact HTML. Keeping this an interface lets the
 * generation logic + closed loop be unit-tested with a FakeRunner, while the real
 * ClaudeCodeRunner spawns the `claude` CLI.
 */

export type TurnRole = "user" | "assistant";

/** A live step in the agent's process, surfaced to the UI as it streams. */
export type AgentActivity = { kind: "text"; text: string } | { kind: "tool"; name: string; summary: string };

/** Raised when a run is cancelled (user Stop / client disconnect) so callers can treat it as
 *  a clean stop rather than a failure, and retries don't kick in. */
export class AbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}
export const abortError = (): AbortError => new AbortError();
export const isAbortError = (e: unknown): boolean => e instanceof Error && e.name === "AbortError";

export interface AgentTurnInput {
  /** The composed system prompt (from @dezin/prompt). */
  systemPrompt: string;
  /** This turn's user message: the brief, or the <artifact-lint> feedback on a repair turn. */
  message: string;
  /** Directory the agent writes artifacts into. */
  projectDir: string;
  /** Prior turns for context. */
  history?: { role: TurnRole; content: string }[];
  /** True when this turn is a lint-driven repair (runners may treat it differently). */
  isRepair?: boolean;
  /** Called with each live activity (text chunk / tool step) as the agent works. */
  onActivity?: (ev: AgentActivity) => void;
  /** Optional wall-clock limit for this turn; providers may enforce a default when omitted. */
  timeoutMs?: number;
  /** Abort to cancel this turn (terminates the spawned CLI). */
  signal?: AbortSignal;
  /** Extra environment variables for the spawned agent process. */
  env?: NodeJS.ProcessEnv;
}

export interface AgentExecutionIdentity {
  requested: {
    providerId: string;
    model: string | null;
  };
  observed: {
    /** Provider bound to the exact spawned CLI command for this turn. */
    providerId: string;
    /** Runtime-selected model reported by the CLI system/init envelope. */
    model: string;
    command: string;
    cliVersion: string | null;
    apiKeySource: string | null;
    protocol: "claude-stream-json-init-v1";
  };
}

/** A turn whose self-reported identity is missing, ambiguous, or mismatched. */
export class AgentExecutionIdentityError extends Error {
  readonly code = "AGENT_EXECUTION_IDENTITY_MISMATCH";
  readonly requested: AgentExecutionIdentity["requested"];
  readonly observed: AgentExecutionIdentity["observed"] | null;

  constructor(
    message: string,
    requested: AgentExecutionIdentity["requested"],
    observed: AgentExecutionIdentity["observed"] | null,
  ) {
    super(message);
    this.name = "AgentExecutionIdentityError";
    this.requested = requested;
    this.observed = observed;
  }
}

/** A failed turn whose runtime execution identity was attested before failure. */
export class AgentTurnError extends Error {
  readonly code = "AGENT_TURN_FAILED";
  readonly executionIdentity: AgentExecutionIdentity;

  constructor(message: string, executionIdentity: AgentExecutionIdentity, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentTurnError";
    this.executionIdentity = executionIdentity;
  }
}

export interface AgentTurnResult {
  /** The assistant's narration text. */
  text: string;
  /** The artifact HTML produced this turn (e.g. read back from projectDir/index.html). */
  artifactHtml: string;
  /** Relative path of the canonical artifact, default "index.html". */
  artifactPath?: string;
  /** Requested versus runtime-observed execution identity, when the CLI exposes it. */
  executionIdentity?: AgentExecutionIdentity;
}

export interface AgentRunner {
  /** Identifier, e.g. "fake" or "claude-code". */
  readonly id: string;
  /** Runtime identity evidence a successful turn is required to return. */
  readonly identityProtocol?: "claude-stream-json-init-v1" | "invocation";
  runTurn(input: AgentTurnInput): Promise<AgentTurnResult>;
}
