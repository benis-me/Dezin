/**
 * generateArtifact — the generation service. Runs the first agent turn, then wires
 * @dezin/quality's lint→repair closed loop around it: after each artifact, lint it;
 * if it has blocking findings and rounds remain, feed the <artifact-lint> block back
 * as the next turn. This closes the lint→repair loop.
 */

import { lintAndRepair, type ClosedLoopOptions, type Finding } from "../../quality/src/index.ts";
import type { AgentActivity, AgentRunner, AgentTurnInput, AgentTurnResult, TurnRole } from "./types.ts";
import { isAbortError } from "./types.ts";

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
      // A cancel is final — don't retry into a killed/aborted run.
      if (isAbortError(err) || turnInput.signal?.aborted) throw err;
      if (attempt < maxAttempts) {
        opts.onRetry?.(attempt, err);
        await sleep(400 * 2 ** (attempt - 1));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export interface GenerateInput {
  runner: AgentRunner;
  /** Composed system prompt (from @dezin/prompt). */
  systemPrompt: string;
  /** The user's initial brief. */
  brief: string;
  /** Directory the runner writes artifacts into. */
  projectDir: string;
  /** Lint + loop options (maxRounds, blockOn, accentOveruseCap, …). */
  lint?: ClosedLoopOptions;
  /** Optional progress callback (emit run events for SSE). */
  onEvent?: (event: GenerateEvent) => void;
  /** Abort to cancel the run (terminates the active turn + stops the loop). */
  signal?: AbortSignal;
  /** Prior turns in this conversation, so the agent has chat context (not just the artifact). */
  history?: { role: TurnRole; content: string }[];
  /** Extra environment variables for spawned agent turns. */
  env?: NodeJS.ProcessEnv;
}

export type GenerateEvent =
  | { type: "turn-start"; round: number; isRepair: boolean }
  | { type: "turn-end"; round: number; text: string }
  | { type: "activity"; round: number; activity: AgentActivity }
  | { type: "lint"; round: number; findings: Finding[] }
  | { type: "done"; rounds: number; passed: boolean };

export interface GenerateResult {
  /** The final artifact HTML. */
  html: string;
  artifactPath: string;
  /** Number of lint-driven repair rounds. */
  rounds: number;
  /** Did the final artifact pass the blocking lint gate? */
  passed: boolean;
  /** Findings remaining on the final artifact. */
  findings: Finding[];
  /** Every turn (initial + repairs), in order. */
  turns: AgentTurnResult[];
}

export async function generateArtifact(input: GenerateInput): Promise<GenerateResult> {
  const { runner, systemPrompt, brief, projectDir, lint, onEvent, signal } = input;
  const history: { role: TurnRole; content: string }[] = [...(input.history ?? [])];
  const turns: AgentTurnResult[] = [];

  const runTurn = async (message: string, round: number, isRepair: boolean): Promise<AgentTurnResult> => {
    onEvent?.({ type: "turn-start", round, isRepair });
    const turnInput: AgentTurnInput = {
      systemPrompt,
      message,
      projectDir,
      history: [...history],
      isRepair,
      onActivity: (activity) => onEvent?.({ type: "activity", round, activity }),
      signal,
      env: input.env,
    };
    const result = await runTurnWithRetry(runner, turnInput, {
      onRetry: (attempt) =>
        onEvent?.({ type: "activity", round, activity: { kind: "tool", name: "retry", summary: `Agent hiccup — retrying (attempt ${attempt + 1})…` } }),
    });
    history.push({ role: "user", content: message });
    history.push({ role: "assistant", content: result.text });
    turns.push(result);
    onEvent?.({ type: "turn-end", round, text: result.text });
    return result;
  };

  // Initial draft.
  const first = await runTurn(brief, 0, false);

  // Closed loop: lint → if blocking, feed the <artifact-lint> block back as a repair turn.
  const loop = await lintAndRepair(
    first.artifactHtml,
    async (lintBlock, ctx) => {
      onEvent?.({ type: "lint", round: ctx.round, findings: ctx.findings });
      const repaired = await runTurn(lintBlock, ctx.round, true);
      return repaired.artifactHtml;
    },
    lint,
  );

  onEvent?.({ type: "done", rounds: loop.rounds, passed: loop.passed });

  return {
    html: loop.html,
    artifactPath: turns.at(-1)?.artifactPath ?? "index.html",
    rounds: loop.rounds,
    passed: loop.passed,
    findings: loop.findings,
    turns,
  };
}
