import { lstat, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  GenericCliRunner,
  NodeSpawner,
  getProvider,
  type AgentRunner,
  type ProcessSpawner,
  type SpawnInput,
  type SpawnOutput,
} from "../../../../packages/agent/src/index.ts";
import type { Settings } from "../../../../packages/core/src/index.ts";

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DESIGN_FILE_TOOLS = "Read,Write,Edit,Glob,Grep";
const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';
const STRICT_DESIGN_AGENT_COMMANDS = ["claude", "codebuddy"] as const;
const CODEBUDDY_DESIGN_SETTINGS = JSON.stringify({
  disableAllHooks: true,
  promptSuggestionEnabled: false,
  memory: {
    autoMemoryEnabled: false,
    relevanceSelection: false,
    memoryExtraction: false,
    teamMemory: { enabled: false },
  },
  permissions: {
    defaultMode: "acceptEdits",
    disableBypassPermissionsMode: "disable",
    disableAutoMode: "disable",
  },
});
const DESIGN_RUNTIME_ENVIRONMENT_KEYS = ["HOME", "TMPDIR", "LANG", "LC_ALL"] as const;
const DESIGN_PROVIDER_ENVIRONMENT_KEYS: Record<StrictDesignProvider, readonly string[]> = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
  codebuddy: [],
};

type StrictDesignProvider = (typeof STRICT_DESIGN_AGENT_COMMANDS)[number];

/** Canonical non-secret provider identity derived from an executable selection. */
export function designAgentProviderId(command: string): string {
  const provider = getProvider(command);
  return provider?.id
    ?? (command.split(/[\\/]/).pop() ?? command).replace(/\.(?:exe|cmd|bat|ps1)$/i, "");
}

function minimalDesignAgentEnvironment(
  provider: string,
  requested: NodeJS.ProcessEnv | undefined,
  runtime: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of DESIGN_RUNTIME_ENVIRONMENT_KEYS) {
    const value = runtime[key];
    if (typeof value === "string" && value.length > 0) result[key] = value;
  }
  const home = runtime.HOME;
  const runtimeDirectories = [
    dirname(process.execPath),
    ...(home ? [
      join(home, ".local", "bin"),
      join(home, "bin"),
      join(home, ".npm-global", "bin"),
      join(home, ".volta", "bin"),
      join(home, ".bun", "bin"),
      join(home, ".asdf", "shims"),
      join(home, "Library", "pnpm"),
    ] : []),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const trustedDirectories = [...new Set(runtimeDirectories.filter(isAbsolute))];
  const runtimeOrder = (runtime.PATH ?? "")
    .split(delimiter)
    .filter((directory) => trustedDirectories.includes(directory));
  result.PATH = [...new Set([...runtimeOrder, ...trustedDirectories])].join(delimiter);
  if ((STRICT_DESIGN_AGENT_COMMANDS as readonly string[]).includes(provider)) {
    for (const key of DESIGN_PROVIDER_ENVIRONMENT_KEYS[provider as StrictDesignProvider]) {
      const value = requested?.[key];
      if (typeof value === "string" && value.length > 0) result[key] = value;
    }
  } else {
    for (const [key, value] of Object.entries(requested ?? {})) {
      if (key === "DEZIN_DAEMON_TOKEN" || key === "NODE_OPTIONS"
        || key.startsWith("DYLD_") || key.startsWith("LD_")) continue;
      if (typeof value === "string" && value.length > 0) result[key] = value;
    }
  }
  return result;
}

export class DesignAgentProviderUnsupportedError extends Error {
  readonly command: string;

  constructor(command: string) {
    super(
      `The selected Agent ${JSON.stringify(command)} does not expose a verified Design execution contract`,
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
  model: string | undefined,
  systemPrompt: string,
): string[] {
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
    DESIGN_FILE_TOOLS,
    "--safe-mode",
    "--strict-mcp-config",
    "--mcp-config",
    EMPTY_MCP_CONFIG,
    "--no-chrome",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--append-system-prompt",
    systemPrompt,
    ...(model ? ["--model", model] : []),
  ];
}

export function designCodeBuddyArgs(
  model: string | undefined,
  systemPrompt: string,
): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "acceptEdits",
    "--tools",
    DESIGN_FILE_TOOLS,
    "--strict-mcp-config",
    "--mcp-config",
    EMPTY_MCP_CONFIG,
    "--setting-sources",
    "",
    "--settings",
    CODEBUDDY_DESIGN_SETTINGS,
    "--no-session-persistence",
    "--append-system-prompt",
    systemPrompt,
    ...(model ? ["--model", model] : []),
  ];
}

function designAgentArgs(
  provider: StrictDesignProvider,
  model: string | undefined,
  systemPrompt: string,
): string[] {
  return provider === "codebuddy"
    ? designCodeBuddyArgs(model, systemPrompt)
    : designClaudeArgs(model, systemPrompt);
}

function boundedDesignProviderArgs(
  provider: string,
  model: string | undefined,
  systemPrompt: string,
): string[] | null {
  if (provider !== "codex") return null;
  return [
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    ...(model ? ["-m", model] : []),
    systemPrompt,
  ];
}

function assertConfinedArguments(
  provider: StrictDesignProvider,
  model: string | undefined,
  args: readonly string[],
): void {
  const expected = designAgentArgs(provider, model, "__SYSTEM_PROMPT__");
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
  readonly #provider: string;
  readonly #command: string;
  readonly #model: string | undefined;
  readonly #delegate: ProcessSpawner;
  readonly #platform: NodeJS.Platform;
  readonly #runtimeEnvironment: NodeJS.ProcessEnv;

  constructor(input: {
    dataDir: string;
    projectId: string;
    provider: string;
    command: string;
    model?: string;
    delegate?: ProcessSpawner;
    /** Platform seam for proving Windows fail-closed behavior without a Windows host. */
    platform?: NodeJS.Platform;
    /** Runtime-only seam; caller-supplied Agent env never controls HOME or command lookup. */
    runtimeEnvironment?: NodeJS.ProcessEnv;
  }) {
    this.#dataDir = resolve(input.dataDir);
    this.#projectId = safeSegment(input.projectId, "Project id");
    this.#provider = input.provider;
    this.#command = input.command;
    this.#model = input.model;
    this.#delegate = input.delegate ?? new NodeSpawner({ inheritEnvironment: false });
    this.#platform = input.platform ?? process.platform;
    this.#runtimeEnvironment = input.runtimeEnvironment ?? process.env;
  }

  async run(input: SpawnInput): Promise<SpawnOutput> {
    if (this.#platform === "win32") {
      throw new DesignAgentConfinementError(
        "Windows Design Agent process confinement is not verified and is not available",
      );
    }
    if (input.command !== this.#command) {
      throw new DesignAgentConfinementError("Design Agent command changed after policy selection");
    }
    if ((STRICT_DESIGN_AGENT_COMMANDS as readonly string[]).includes(this.#provider)) {
      assertConfinedArguments(this.#provider as StrictDesignProvider, this.#model, input.args);
      if (input.stdin.length === 0) {
        throw new DesignAgentConfinementError("Confined Design Agent prompt must be delivered on stdin");
      }
    } else {
      const boundedArgs = boundedDesignProviderArgs(this.#provider, this.#model, "__SYSTEM_PROMPT__");
      if (boundedArgs !== null) assertExactArgs(input.args, boundedArgs, [boundedArgs.length - 1]);
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
    return this.#delegate.run({
      ...input,
      cwd: canonicalCwd,
      env: minimalDesignAgentEnvironment(this.#provider, input.env, this.#runtimeEnvironment),
    });
  }
}

export function createConfinedDesignAgentRunner(input: CreateConfinedDesignRunnerInput): AgentRunner {
  const command = input.override?.agentCommand || input.settings.agentCommand || "claude";
  const model = input.override?.model || input.settings.model || undefined;
  const provider = getProvider(command);
  const providerId = designAgentProviderId(command);
  if (!SAFE_SEGMENT.test(providerId)) throw new DesignAgentProviderUnsupportedError(command);
  const strictProvider = (STRICT_DESIGN_AGENT_COMMANDS as readonly string[]).includes(providerId)
    ? providerId as StrictDesignProvider
    : null;
  const boundedArgs = boundedDesignProviderArgs(providerId, model, "__SYSTEM_PROMPT__");
  const spawner = new DesignConfinedSpawner({
    dataDir: input.dataDir,
    projectId: input.projectId,
    provider: providerId,
    command,
    model,
    delegate: input.spawner,
  });
  if (provider) {
    return provider.createRunner({
      command,
      model,
      enforceArtifactUpdate: input.enforceArtifactUpdate,
      spawner,
      ...(strictProvider !== null
        ? { buildArgs: (systemPrompt: string) => designAgentArgs(strictProvider, model, systemPrompt) }
        : boundedArgs !== null
          ? { buildArgs: (systemPrompt: string) => boundedDesignProviderArgs(providerId, model, systemPrompt)! }
          : {}),
    });
  }
  return new GenericCliRunner({
    id: providerId,
    command,
    model,
    config: {
      buildArgs: (candidateModel, prompt) => [
        ...(candidateModel ? ["--model", candidateModel] : []),
        prompt,
      ],
    },
    enforceArtifactUpdate: input.enforceArtifactUpdate,
    spawner,
  });
}
