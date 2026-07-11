/**
 * @dezin/agent — agent runner abstraction + the generation service that wires the
 * lint→repair closed loop into a runner-driven generation.
 */

export type {
  AgentRunner,
  AgentTurnInput,
  AgentTurnResult,
  TurnRole,
} from "./types.ts";
export { AbortError, abortError, isAbortError } from "./types.ts";
export { FakeRunner, type FakeRunnerOptions } from "./fake-runner.ts";
export {
  generateArtifact,
  runTurnWithRetry,
  type GenerateInput,
  type GenerateResult,
  type GenerateEvent,
} from "./generate.ts";
export {
  parseClaudeStream,
  parseClaudeLine,
  extractAskUserQuestion,
  extractFinalSummary,
  FINAL_SUMMARY_START,
  FINAL_SUMMARY_END,
  type ParsedClaudeStream,
  type ClaudeToolUse,
  type ClaudeActivity,
  type AskUserQuestionExtraction,
  type FinalSummaryExtraction,
} from "./claude-stream.ts";
export {
  ClaudeCodeRunner,
  NodeSpawner,
  AgentOutputLimitError,
  AGENT_STDOUT_LIMIT_BYTES,
  AGENT_STDERR_LIMIT_BYTES,
  historyPreamble,
  type ClaudeCodeRunnerOptions,
  type NodeSpawnerOptions,
  type ProcessSpawner,
  type SpawnInput,
  type SpawnOutput,
} from "./claude-runner.ts";
export { BoundedTextBuffer, OUTPUT_TRUNCATION_MARKER } from "./bounded-text-buffer.ts";
export { ProcessGroupCleanupError, terminateOwnedProcessGroup, type OwnedProcessGroupOptions } from "./process-group.ts";
export {
  GenericCliRunner,
  type GenericAgentConfig,
  type GenericCliRunnerOptions,
} from "./generic-runner.ts";
export {
  AGENT_PROVIDERS,
  GENERIC_AGENTS,
  getProvider,
  providerFamily,
  probeVersion,
  runCapture,
  augmentedPath,
  agentSpawnEnv,
  dedupModels,
  type AgentProvider,
  type VersionProbe,
} from "./providers/index.ts";
