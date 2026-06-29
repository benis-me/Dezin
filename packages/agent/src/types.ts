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
  /** Abort to cancel this turn (terminates the spawned CLI). */
  signal?: AbortSignal;
}

export interface AgentTurnResult {
  /** The assistant's narration text. */
  text: string;
  /** The artifact HTML produced this turn (e.g. read back from projectDir/index.html). */
  artifactHtml: string;
  /** Relative path of the canonical artifact, default "index.html". */
  artifactPath?: string;
}

export interface AgentRunner {
  /** Identifier, e.g. "fake" or "claude-code". */
  readonly id: string;
  runTurn(input: AgentTurnInput): Promise<AgentTurnResult>;
}
