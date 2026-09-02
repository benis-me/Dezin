/**
 * @dezin/agent — agent runner abstraction: provider CLI runners, Claude stream
 * parsing, and bounded turn retry with failure classification.
 */

export type {
  AgentActivity,
  AgentToolName,
  AgentRunner,
  AgentTurnInput,
  AgentTurnResult,
  AgentExecutionIdentity,
  TurnRole,
} from "./types.ts";
export {
  AGENT_TOOL_NAMES,
  AbortError,
  AgentExecutionIdentityError,
  AgentTurnError,
  abortError,
  isAbortError,
  normalizeAgentToolName,
} from "./types.ts";
export { FakeRunner, type FakeRunnerOptions } from "./fake-runner.ts";
export {
  runTurnWithRetry,
  classifyAgentTurnFailure,
  type AgentTurnFailureCategory,
  type AgentTurnFailureClassification,
} from "./turn-retry.ts";
export {
  parseClaudeStream,
  parseClaudeLine,
  extractAskUserQuestion,
  extractFinalSummary,
  FINAL_SUMMARY_START,
  FINAL_SUMMARY_END,
  type ParsedClaudeStream,
  type ClaudeToolUse,
  type ClaudeStreamInit,
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
  type TerminalStdoutContract,
} from "./claude-runner.ts";
export { BoundedTextBuffer, OUTPUT_TRUNCATION_MARKER } from "./bounded-text-buffer.ts";
export {
  AgentArtifactError,
  type AgentArtifactFailureReason,
} from "./runner-utils.ts";
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
  CODEBUDDY_CREDENTIAL_ENVIRONMENT_KEYS,
  codeBuddyHostLoginEnvironment,
  dedupModels,
  type AgentProvider,
  type AgentReadiness,
  type AgentReadinessProbeOptions,
  type VersionProbe,
} from "./providers/index.ts";
