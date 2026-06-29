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
  type ParsedClaudeStream,
  type ClaudeToolUse,
  type ClaudeActivity,
} from "./claude-stream.ts";
export {
  ClaudeCodeRunner,
  NodeSpawner,
  historyPreamble,
  type ClaudeCodeRunnerOptions,
  type ProcessSpawner,
  type SpawnInput,
  type SpawnOutput,
} from "./claude-runner.ts";
export {
  GenericCliRunner,
  type GenericAgentConfig,
  type GenericCliRunnerOptions,
} from "./generic-runner.ts";
export {
  AGENT_PROVIDERS,
  GENERIC_AGENTS,
  getProvider,
  probeVersion,
  runCapture,
  augmentedPath,
  dedupModels,
  type AgentProvider,
  type VersionProbe,
} from "./providers/index.ts";
