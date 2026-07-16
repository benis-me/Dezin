import { isDeepStrictEqual } from "node:util";

import type {
  AgentRunner,
  AgentTurnResult,
  TurnRole,
} from "../../../../packages/agent/src/index.ts";
import type { AgentActivity } from "../../../../packages/agent/src/types.ts";
import type { GenerationTaskFailureClass } from "../../../../packages/core/src/index.ts";

export interface StandardArtifactCandidateIdentity {
  commitHash: string;
  treeHash: string;
}

export interface StandardArtifactCandidateTransactionPort {
  readonly dir: string;
  fingerprint(signal: AbortSignal): Promise<string>;
  commit(message: string, signal: AbortSignal): Promise<StandardArtifactCandidateIdentity>;
  restore(candidate: StandardArtifactCandidateIdentity, signal: AbortSignal): Promise<void>;
}

export interface StandardArtifactQualityResult {
  passed: boolean;
  score: number;
  renderSpec: Record<string, unknown>;
  quality: Record<string, unknown>;
  evidence: Record<string, unknown>;
  /** Canonical, bounded findings sent to the next Agent turn. */
  repairFindings: Array<Record<string, unknown>>;
}

export interface StandardArtifactQualityEvaluatorPort {
  evaluate(input: {
    candidate: StandardArtifactCandidateIdentity;
    dir: string;
    round: number;
    signal: AbortSignal;
  }): Promise<StandardArtifactQualityResult>;
}

export interface StandardArtifactExecutionVersion {
  round: number;
  candidate: StandardArtifactCandidateIdentity;
  quality: StandardArtifactQualityResult;
  assistantText: string;
}

export interface StandardArtifactExecutionResult {
  selected: StandardArtifactExecutionVersion;
  versions: StandardArtifactExecutionVersion[];
  turns: AgentTurnResult[];
}

export interface StandardArtifactExecutionEvent {
  type: "turn-start" | "activity" | "turn-end" | "candidate" | "quality" | "restore";
  round: number;
  isRepair?: boolean;
  activity?: AgentActivity;
  assistantText?: string;
  candidate?: StandardArtifactCandidateIdentity;
  quality?: StandardArtifactQualityResult;
}

export interface StandardArtifactExecutionInput {
  runner: AgentRunner;
  transaction: StandardArtifactCandidateTransactionPort;
  evaluator: StandardArtifactQualityEvaluatorPort;
  systemPrompt: string;
  initialMessage: string;
  history?: Array<{ role: TurnRole; content: string }>;
  env?: NodeJS.ProcessEnv;
  signal: AbortSignal;
  maxRepairRounds: number;
  maxTurns: number;
  commitMessage(round: number): string;
  buildRepairPrompt(input: {
    round: number;
    maxRepairRounds: number;
    prior: StandardArtifactExecutionVersion;
  }): string | null;
  onEvent?: (event: StandardArtifactExecutionEvent) => void;
}

export class StandardArtifactExecutionError extends Error {
  readonly code:
    | "invalid-input"
    | "turn-budget-exhausted"
    | "no-source-change"
    | "invalid-candidate"
    | "invalid-quality";
  readonly failureClass: GenerationTaskFailureClass;

  constructor(
    code: StandardArtifactExecutionError["code"],
    message: string,
  ) {
    super(message);
    this.name = "StandardArtifactExecutionError";
    this.code = code;
    this.failureClass = code === "invalid-quality"
      ? "qa"
      : code === "no-source-change" || code === "turn-budget-exhausted"
        ? "design"
        : "build-infrastructure";
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Standard Artifact execution aborted", "AbortError");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function binaryCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalObject(value: unknown, label: string): Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new StandardArtifactExecutionError("invalid-quality", `${label} must be a plain object`);
    }
    return structuredClone(value as Record<string, unknown>);
  } catch (error) {
    if (error instanceof StandardArtifactExecutionError) throw error;
    throw new StandardArtifactExecutionError("invalid-quality", `${label} must be cloneable`);
  }
}

function canonicalCandidate(value: StandardArtifactCandidateIdentity): StandardArtifactCandidateIdentity {
  const commitHash = value?.commitHash;
  const treeHash = value?.treeHash;
  if (typeof commitHash !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commitHash)
    || typeof treeHash !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(treeHash)) {
    throw new StandardArtifactExecutionError(
      "invalid-candidate",
      "Standard Artifact candidate must contain canonical Git commit and tree object ids",
    );
  }
  return { commitHash, treeHash };
}

function canonicalQuality(value: StandardArtifactQualityResult): StandardArtifactQualityResult {
  if (typeof value?.passed !== "boolean" || typeof value?.score !== "number"
    || !Number.isFinite(value.score) || value.score < 0 || value.score > 100
    || !Array.isArray(value.repairFindings)) {
    throw new StandardArtifactExecutionError(
      "invalid-quality",
      "Standard Artifact quality result has invalid scalar fields",
    );
  }
  const repairFindings = value.repairFindings.map((finding, index) => (
    canonicalObject(finding, `Standard Artifact repair finding ${index}`)
  ));
  return {
    passed: value.passed,
    score: value.score,
    renderSpec: canonicalObject(value.renderSpec, "Standard Artifact RenderSpec"),
    quality: canonicalObject(value.quality, "Standard Artifact quality"),
    evidence: canonicalObject(value.evidence, "Standard Artifact evidence"),
    repairFindings,
  };
}

function validateInput(input: StandardArtifactExecutionInput): void {
  if (!input.runner || typeof input.runner.runTurn !== "function"
    || !input.transaction || typeof input.transaction.fingerprint !== "function"
    || typeof input.transaction.commit !== "function" || typeof input.transaction.restore !== "function"
    || !input.evaluator || typeof input.evaluator.evaluate !== "function"
    || typeof input.systemPrompt !== "string" || input.systemPrompt.length === 0
    || typeof input.initialMessage !== "string" || input.initialMessage.length === 0
    || !Number.isSafeInteger(input.maxRepairRounds) || input.maxRepairRounds < 0
    || !Number.isSafeInteger(input.maxTurns) || input.maxTurns < 1
    || input.maxRepairRounds + 1 > input.maxTurns
    || typeof input.commitMessage !== "function" || typeof input.buildRepairPrompt !== "function") {
    throw new StandardArtifactExecutionError("invalid-input", "Standard Artifact execution input is invalid");
  }
}

function betterVersion(
  candidate: StandardArtifactExecutionVersion,
  selected: StandardArtifactExecutionVersion,
): boolean {
  if (candidate.quality.passed !== selected.quality.passed) return candidate.quality.passed;
  if (candidate.quality.score !== selected.quality.score) {
    return candidate.quality.score > selected.quality.score;
  }
  return candidate.round > selected.round;
}

/**
 * Shared, transport-free Standard Artifact quality loop. It deliberately does
 * not publish a source branch or Core result: every round remains an isolated
 * candidate until the caller stages it through TaskPublication.
 */
export async function executeStandardArtifact(
  input: StandardArtifactExecutionInput,
): Promise<StandardArtifactExecutionResult> {
  validateInput(input);
  checkAbort(input.signal);
  const history = structuredClone(input.history ?? []);
  const versions: StandardArtifactExecutionVersion[] = [];
  const turns: AgentTurnResult[] = [];
  const seenTrees = new Set<string>();
  let message = input.initialMessage;

  for (let round = 0; round <= input.maxRepairRounds; round += 1) {
    if (turns.length >= input.maxTurns) {
      throw new StandardArtifactExecutionError(
        "turn-budget-exhausted",
        `Standard Artifact execution exhausted its ${input.maxTurns}-turn budget`,
      );
    }
    checkAbort(input.signal);
    const before = await input.transaction.fingerprint(input.signal);
    checkAbort(input.signal);
    input.onEvent?.({ type: "turn-start", round, isRepair: round > 0 });
    const result = await input.runner.runTurn({
      systemPrompt: input.systemPrompt,
      message,
      projectDir: input.transaction.dir,
      history: structuredClone(history),
      isRepair: round > 0,
      signal: input.signal,
      env: input.env,
      onActivity: (activity) => input.onEvent?.({ type: "activity", round, activity }),
    });
    checkAbort(input.signal);
    const after = await input.transaction.fingerprint(input.signal);
    checkAbort(input.signal);
    if (after === before) {
      throw new StandardArtifactExecutionError(
        "no-source-change",
        `Standard Artifact Agent turn ${round} finished without changing project files`,
      );
    }
    const assistantText = typeof result.text === "string" ? result.text : "";
    turns.push(result);
    input.onEvent?.({ type: "turn-end", round, assistantText });

    const candidate = canonicalCandidate(await input.transaction.commit(
      input.commitMessage(round),
      input.signal,
    ));
    checkAbort(input.signal);
    input.onEvent?.({ type: "candidate", round, candidate });
    const repeatedTree = seenTrees.has(candidate.treeHash);
    seenTrees.add(candidate.treeHash);

    const quality = canonicalQuality(await input.evaluator.evaluate({
      candidate,
      dir: input.transaction.dir,
      round,
      signal: input.signal,
    }));
    checkAbort(input.signal);
    const version: StandardArtifactExecutionVersion = {
      round,
      candidate,
      quality,
      assistantText,
    };
    versions.push(version);
    input.onEvent?.({ type: "quality", round, quality });

    // A repeated tree still names a newly retained commit in the Attempt's
    // linear history. Evaluate and record that exact commit before stopping so
    // durable Git refs and immutable version evidence can never diverge.
    if (repeatedTree || round >= input.maxRepairRounds || quality.repairFindings.length === 0) break;
    const repair = input.buildRepairPrompt({
      round: round + 1,
      maxRepairRounds: input.maxRepairRounds,
      prior: structuredClone(version),
    });
    if (repair === null || repair.length === 0) break;
    history.push({ role: "user", content: message });
    history.push({ role: "assistant", content: assistantText });
    message = repair;
  }

  if (versions.length === 0) {
    throw new StandardArtifactExecutionError(
      "invalid-candidate",
      "Standard Artifact execution produced no evaluated candidate",
    );
  }
  let selected = versions[0]!;
  for (const version of versions.slice(1)) {
    if (betterVersion(version, selected)) selected = version;
  }
  const current = versions.at(-1)!;
  if (!isDeepStrictEqual(current.candidate, selected.candidate)) {
    await input.transaction.restore(selected.candidate, input.signal);
    checkAbort(input.signal);
    input.onEvent?.({ type: "restore", round: selected.round, candidate: selected.candidate });
  }
  return {
    selected: structuredClone(selected),
    versions: structuredClone(versions),
    turns: structuredClone(turns),
  };
}

export function sortStandardArtifactVersions(
  versions: readonly StandardArtifactExecutionVersion[],
): StandardArtifactExecutionVersion[] {
  return [...versions].sort((left, right) => (
    Number(right.quality.passed) - Number(left.quality.passed)
    || right.quality.score - left.quality.score
    || right.round - left.round
    || binaryCompare(left.candidate.commitHash, right.candidate.commitHash)
  ));
}
