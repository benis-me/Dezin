import { lstat, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import {
  NodeSpawner,
  getProvider,
  type AgentRunner,
  type ProcessSpawner,
  type SpawnInput,
  type SpawnOutput,
} from "../../../../packages/agent/src/index.ts";
import type { Settings } from "../../../../packages/core/src/index.ts";

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CLAUDE_DESIGN_TOOLS = "Read,Write,Edit,Glob,Grep";
const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';
const DESIGN_AGENT_COMMANDS = ["claude", "codebuddy", "codex"] as const;

type ConfinedDesignProvider = (typeof DESIGN_AGENT_COMMANDS)[number];

export class DesignAgentProviderUnsupportedError extends Error {
  readonly command: string;

  constructor(command: string) {
    super(
      `Design Agents support only the exact confined commands claude, codebuddy, or codex; ${JSON.stringify(command)} has no verified Design sandbox`,
    );
    this.name = "DesignAgentProviderUnsupportedError";
    this.command = command;
  }
}

export class DesignAgentConfinementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignAgentConfinementError";
  }
}

export interface CreateConfinedDesignRunnerInput {
  settings: Settings;
  dataDir: string;
  projectId: string;
  override?: { agentCommand?: string; model?: string };
  enforceArtifactUpdate: boolean;
  spawner?: ProcessSpawner;
}

function safeSegment(value: string, label: string): string {
  if (!SAFE_SEGMENT.test(value) || value === "." || value === "..") {
    throw new DesignAgentConfinementError(`${label} is invalid`);
  }
  return value;
}

function assertExactArgs(
  actual: readonly string[],
  expected: readonly string[],
  wildcardIndexes: readonly number[] = [],
): void {
  if (actual.length !== expected.length) {
    throw new DesignAgentConfinementError("Design Agent arguments do not match the confined policy");
  }
  const wildcards = new Set(wildcardIndexes);
  for (let index = 0; index < expected.length; index += 1) {
    if (wildcards.has(index)) {
      if (typeof actual[index] !== "string" || actual[index]!.length === 0) {
        throw new DesignAgentConfinementError("Design Agent prompt argument is invalid");
      }
      continue;
    }
    if (actual[index] !== expected[index]) {
      throw new DesignAgentConfinementError("Design Agent arguments do not match the confined policy");
    }
  }
}

export function designClaudeArgs(
  provider: "claude" | "codebuddy",
  model: string | undefined,
  systemPrompt: string,
): string[] {
  const isolation = provider === "claude"
    ? [
        "--safe-mode",
        "--strict-mcp-config",
        "--mcp-config",
        EMPTY_MCP_CONFIG,
        "--no-chrome",
        "--disable-slash-commands",
      ]
    : [
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        EMPTY_MCP_CONFIG,
      ];
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "dontAsk",
    "--tools",
    CLAUDE_DESIGN_TOOLS,
    ...isolation,
    "--no-session-persistence",
    "--append-system-prompt",
    systemPrompt,
    ...(model ? ["--model", model] : []),
  ];
}

export function designCodexArgs(model: string | undefined): string[] {
  return [
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    ...(model ? ["-m", model] : []),
    "-",
  ];
}

function assertConfinedArguments(
  provider: ConfinedDesignProvider,
  model: string | undefined,
  args: readonly string[],
): void {
  if (provider === "codex") {
    assertExactArgs(args, designCodexArgs(model));
    return;
  }
  const expected = designClaudeArgs(provider, model, "__SYSTEM_PROMPT__");
  const promptIndex = expected.indexOf("__SYSTEM_PROMPT__");
  assertExactArgs(args, expected, [promptIndex]);
}

function stagingPathKind(relativePath: string): "node" | "global" | null {
  const segments = relativePath.split(sep);
  if (segments.length === 5
    && segments[0] === "nodes"
    && safeSegment(segments[1]!, "Node id")
    && segments[2] === ".pending"
    && segments[3] === "jobs"
    && safeSegment(segments[4]!, "Job id")) {
    return "node";
  }
  if (segments.length === 3
    && segments[0] === "exports"
    && segments[1] === ".pending"
    && safeSegment(segments[2]!, "Export id")) {
    return "global";
  }
  return null;
}

function confinedRelative(root: string, candidate: string): string {
  const result = relative(root, candidate);
  if (!result || result === ".." || result.startsWith(`..${sep}`)) {
    throw new DesignAgentConfinementError("Design Agent cwd is outside its Project staging root");
  }
  return result;
}

/**
 * Last-mile policy fence around the real process spawner. The CLI receives one
 * canonical pending job directory as cwd; symlink aliases, final output paths,
 * sibling Projects, and argument drift are rejected before process creation.
 */
export class DesignConfinedSpawner implements ProcessSpawner {
  readonly #dataDir: string;
  readonly #projectId: string;
  readonly #provider: ConfinedDesignProvider;
  readonly #command: string;
  readonly #model: string | undefined;
  readonly #delegate: ProcessSpawner;

  constructor(input: {
    dataDir: string;
    projectId: string;
    provider: ConfinedDesignProvider;
    command: string;
    model?: string;
    delegate?: ProcessSpawner;
  }) {
    this.#dataDir = resolve(input.dataDir);
    this.#projectId = safeSegment(input.projectId, "Project id");
    this.#provider = input.provider;
    this.#command = input.command;
    this.#model = input.model;
    this.#delegate = input.delegate ?? new NodeSpawner();
  }

  async run(input: SpawnInput): Promise<SpawnOutput> {
    if (input.command !== this.#command) {
      throw new DesignAgentConfinementError("Design Agent command changed after policy selection");
    }
    assertConfinedArguments(this.#provider, this.#model, input.args);
    if (input.stdin.length === 0) {
      throw new DesignAgentConfinementError("Confined Design Agent prompt must be delivered on stdin");
    }

    const designRoot = resolve(this.#dataDir, "projects", this.#projectId, "design");
    const lexicalCwd = resolve(input.cwd);
    const lexicalRelative = confinedRelative(designRoot, lexicalCwd);
    if (stagingPathKind(lexicalRelative) === null) {
      throw new DesignAgentConfinementError("Design Agent cwd is not an exact pending job directory");
    }
    const metadata = await lstat(lexicalCwd);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new DesignAgentConfinementError("Design Agent cwd must be a real staging directory");
    }
    const [canonicalDataDir, canonicalRoot, canonicalCwd] = await Promise.all([
      realpath(this.#dataDir),
      realpath(designRoot),
      realpath(lexicalCwd),
    ]);
    const expectedCanonicalRoot = resolve(canonicalDataDir, "projects", this.#projectId, "design");
    if (canonicalRoot !== expectedCanonicalRoot) {
      throw new DesignAgentConfinementError("Design Agent Project staging root traverses a symbolic link");
    }
    const canonicalRelative = confinedRelative(canonicalRoot, canonicalCwd);
    if (canonicalRelative !== lexicalRelative || stagingPathKind(canonicalRelative) === null) {
      throw new DesignAgentConfinementError("Design Agent cwd traverses a staging symlink");
    }
    return this.#delegate.run({ ...input, cwd: canonicalCwd });
  }
}

export function createConfinedDesignAgentRunner(input: CreateConfinedDesignRunnerInput): AgentRunner {
  const command = input.override?.agentCommand || input.settings.agentCommand || "claude";
  const model = input.override?.model || input.settings.model || undefined;
  if (!(DESIGN_AGENT_COMMANDS as readonly string[]).includes(command)) {
    throw new DesignAgentProviderUnsupportedError(command);
  }
  const provider = getProvider(command);
  if (!provider || provider.id !== command) {
    throw new DesignAgentProviderUnsupportedError(command);
  }
  const providerId = provider.id as ConfinedDesignProvider;
  const spawner = new DesignConfinedSpawner({
    dataDir: input.dataDir,
    projectId: input.projectId,
    provider: providerId,
    command,
    model,
    delegate: input.spawner,
  });
  return provider.createRunner({
    command,
    model,
    enforceArtifactUpdate: input.enforceArtifactUpdate,
    spawner,
    ...(providerId === "codex"
      ? {
          buildArgs: () => designCodexArgs(model),
          viaStdin: true,
        }
      : {
          buildArgs: (systemPrompt: string) => designClaudeArgs(providerId, model, systemPrompt),
        }),
  });
}
