import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
  sep,
} from "node:path";

import {
  ClaudeCodeRunner,
  NodeSpawner,
  getProvider,
  type AgentRunner,
  type ProcessSpawner,
  type SpawnInput,
} from "../../../../packages/agent/src/index.ts";

const MAX_ENVIRONMENT_VALUE_BYTES = 64 * 1024;
const ARTIFACT_SCOPE_ENVIRONMENT_KEYS = new Set([
  "DEZIN_AGENT_SCOPE_PROTOCOL",
  "DEZIN_PROJECT_ID",
  "DEZIN_WORKSPACE_ID",
  "DEZIN_PLAN_ID",
  "DEZIN_TASK_ID",
  "DEZIN_TASK_ATTEMPT",
  "DEZIN_ARTIFACT_ID",
  "DEZIN_TRACK_ID",
  "DEZIN_CONTEXT_PACK_ID",
  "DEZIN_CONTEXT_PACK_HASH",
  "DEZIN_SOURCE_COMMIT_HASH",
  "DEZIN_SOURCE_TREE_HASH",
  "DEZIN_AGENT_CAPABILITIES",
]);
const PROVIDER_ENVIRONMENT_KEYS = Object.freeze({
  claude: new Set([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ]),
});
const SAFE_AMBIENT_ENVIRONMENT_KEYS = ["LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "USER"] as const;
const CLAUDE_DENIED_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "Task",
  "Skill",
] as const;

type SupportedArtifactProviderId = "claude";

export interface ProductionArtifactProviderRunnerInput {
  readonly providerId: string;
  readonly command: string;
  readonly model?: string;
  readonly worktreeDir: string;
  readonly enforceArtifactUpdate?: boolean;
}

export interface ProductionArtifactProviderSandboxDependencies {
  /** Test seam. Production always verifies a fixed official CLI install root. */
  readonly resolveExecutable?: (
    providerId: SupportedArtifactProviderId,
    command: string,
  ) => string;
  /** Test seam. Production uses a private sibling of the candidate worktree. */
  readonly runtimeRoot?: string;
  /** Test seam. Production uses a non-inheriting Node spawner. */
  readonly spawner?: ProcessSpawner;
  /** Test seam for the provider process's official host authentication lookup. */
  readonly hostHome?: string;
  /** Test seam for an explicit Claude authentication root. */
  readonly claudeConfigDir?: string;
}

export interface ProductionArtifactClaudeArgsInput {
  readonly worktreeDir: string;
  readonly runtimeRoot: string;
  readonly systemPrompt: string;
  readonly model?: string;
}

export class ProductionArtifactProviderSandboxError extends Error {
  readonly failureClass = "adapter" as const;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ProductionArtifactProviderSandboxError";
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function safeEnvironmentValue(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_ENVIRONMENT_VALUE_BYTES) {
    throw new ProductionArtifactProviderSandboxError(`${label} is invalid`);
  }
  return value;
}

function exactPlainDirectory(value: string, label: string): string {
  try {
    const exact = realpathSync(value);
    const stats = lstatSync(exact);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("not a plain directory");
    return exact;
  } catch (error) {
    throw new ProductionArtifactProviderSandboxError(`${label} is unavailable`, error);
  }
}

function ensurePrivateDirectory(value: string, label: string): string {
  try {
    try {
      mkdirSync(value, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stats = lstatSync(value);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("not a plain directory");
    chmodSync(value, 0o700);
    return realpathSync(value);
  } catch (error) {
    throw new ProductionArtifactProviderSandboxError(`${label} could not be created safely`, error);
  }
}

interface ArtifactProviderRuntime {
  readonly root: string;
  readonly tmp: string;
}

function createArtifactProviderRuntime(
  worktreeDir: string,
  requestedRoot: string | undefined,
): ArtifactProviderRuntime {
  const transactionRoot = exactPlainDirectory(dirname(worktreeDir), "Artifact transaction root");
  const requestedPath = resolve(requestedRoot ?? join(transactionRoot, "provider-runtime"));
  const requestedParent = exactPlainDirectory(
    dirname(requestedPath),
    "Artifact provider runtime parent",
  );
  const rootPath = join(requestedParent, basename(requestedPath));
  if (requestedParent !== transactionRoot || inside(worktreeDir, rootPath)) {
    throw new ProductionArtifactProviderSandboxError(
      "Artifact provider runtime must be a private sibling inside the exact candidate transaction",
    );
  }
  const root = ensurePrivateDirectory(rootPath, "Artifact provider runtime");
  if (!inside(transactionRoot, root) || inside(worktreeDir, root)) {
    throw new ProductionArtifactProviderSandboxError("Artifact provider runtime resolves outside its transaction");
  }
  return Object.freeze({
    root,
    tmp: ensurePrivateDirectory(join(root, "tmp"), "Artifact provider temporary directory"),
  });
}

function safeSearchDirectories(home: string): string[] {
  return [...new Set([
    `${home}/.local/bin`,
    dirname(process.execPath),
    `${home}/.npm-global/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ])];
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trustedNodePackageExecutable(
  path: string,
  home: string,
): boolean {
  const packageSuffix = join("@anthropic-ai", "claude-code", "cli.js");
  const fixedGlobalRoots = [
    join(home, ".npm-global", "lib", "node_modules"),
    join(resolve(dirname(process.execPath), ".."), "lib", "node_modules"),
    "/opt/homebrew/lib/node_modules",
    "/usr/local/lib/node_modules",
  ];
  if (fixedGlobalRoots.some((root) => path === join(root, packageSuffix))) return true;
  const normalizedHome = home.replaceAll("\\", "/").replace(/\/$/, "");
  const nvmSuffix = packageSuffix.replaceAll("\\", "/");
  return new RegExp(
    `^${escapedRegExp(normalizedHome)}/\\.nvm/versions/node/[^/]+/lib/node_modules/${escapedRegExp(nvmSuffix)}$`,
  ).test(path.replaceAll("\\", "/"));
}

function trustedExecutablePath(value: string, home: string): boolean {
  const path = value.replaceAll("\\", "/");
  const normalizedHome = home.replaceAll("\\", "/").replace(/\/$/, "");
  return new RegExp(`^${escapedRegExp(normalizedHome)}/\\.local/share/claude/versions/[^/]+$`).test(path)
    || trustedNodePackageExecutable(path, home)
    || /^\/(?:opt\/homebrew|usr\/local)\/Cellar\/(?:claude-code|claude)\/[^/]+\/.+\/claude$/.test(path);
}

function executableCandidates(
  command: string,
  home: string,
): string[] {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) return [command];
  const names = process.platform === "win32"
    ? [`${command}.exe`, `${command}.cmd`, command]
    : [command];
  return safeSearchDirectories(home)
    .flatMap((directory) => names.map((name) => join(directory, name)));
}

function resolveTrustedExecutable(
  providerId: SupportedArtifactProviderId,
  command: string,
  home: string,
): string {
  for (const candidate of executableCandidates(command, home)) {
    try {
      accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      const exact = realpathSync(candidate);
      if (statSync(exact).isFile() && trustedExecutablePath(exact, home)) return exact;
    } catch {
      // Continue through only the fixed, trusted install roots.
    }
  }
  throw new ProductionArtifactProviderSandboxError(
    `The official ${providerId} executable could not be verified in a trusted install location`,
  );
}

function canonicalOptionalDirectory(value: string | undefined, label: string): string | undefined {
  if (!value?.trim()) return undefined;
  return exactPlainDirectory(value, label);
}

function canonicalHostHome(value: string | undefined): string {
  return exactPlainDirectory(value ?? homedir(), "Artifact provider host home");
}

function providerProcessEnvironment(input: {
  readonly request: NodeJS.ProcessEnv | undefined;
  readonly hostHome: string;
  readonly runtime: ArtifactProviderRuntime;
  readonly claudeConfigDir?: string;
}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: input.hostHome,
    PATH: safeSearchDirectories(input.hostHome).join(delimiter),
    TMPDIR: input.runtime.tmp,
    TERM: "dumb",
    NO_COLOR: "1",
    IMPECCABLE_HOOK_DISABLED: "1",
    IMPECCABLE_HOOK_QUIET: "1",
    DEZIN_DAEMON_TOKEN: undefined,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  if (input.claudeConfigDir !== undefined) environment.CLAUDE_CONFIG_DIR = input.claudeConfigDir;
  for (const key of SAFE_AMBIENT_ENVIRONMENT_KEYS) {
    const value = safeEnvironmentValue(process.env[key], `Artifact provider ambient ${key}`);
    if (value !== undefined) environment[key] = value;
  }
  const providerKeys = PROVIDER_ENVIRONMENT_KEYS.claude;
  for (const [key, rawValue] of Object.entries(input.request ?? {})) {
    if (key === "DEZIN_DAEMON_TOKEN") {
      if (rawValue !== undefined) {
        throw new ProductionArtifactProviderSandboxError(
          "Artifact provider cannot receive the daemon mutation token",
        );
      }
      continue;
    }
    if (!providerKeys.has(key) && !ARTIFACT_SCOPE_ENVIRONMENT_KEYS.has(key)) {
      if (rawValue !== undefined) {
        throw new ProductionArtifactProviderSandboxError(
          `Artifact provider environment variable ${key} is not permitted`,
        );
      }
      continue;
    }
    const value = safeEnvironmentValue(rawValue, `Artifact provider environment variable ${key}`);
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function claudeSandboxReadRoots(worktreeDir: string, runtimeRoot: string): string[] {
  return [...new Set([
    worktreeDir,
    runtimeRoot,
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/Library",
    "/opt/homebrew",
    "/usr/local",
    "/private/etc",
    resolve(dirname(process.execPath), ".."),
  ])];
}

export function buildProductionArtifactClaudeArgs(
  input: ProductionArtifactClaudeArgsInput,
): string[] {
  const settings = {
    permissions: {
      allow: ["Bash"],
      deny: [...CLAUDE_DENIED_TOOLS],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      excludedCommands: [],
      allowUnsandboxedCommands: false,
      filesystem: {
        // Do not broaden this to /tmp/claude-$uid. Claude 2.1.212 may append a
        // harmless cwd-marker EPERM to Bash results under a root read deny;
        // allowing that shared temp root would expose other Claude sessions.
        denyRead: ["/"],
        allowRead: claudeSandboxReadRoots(input.worktreeDir, input.runtimeRoot),
        // Claude's sandbox already grants write only to cwd and its private
        // session temp. A root deny cannot be re-opened by allowWrite, so keep
        // the default cwd boundary and narrow Git metadata explicitly.
        denyWrite: [join(input.worktreeDir, ".git")],
        allowWrite: [input.runtimeRoot],
      },
      network: {
        allowedDomains: [],
        deniedDomains: ["*"],
      },
      credentials: {
        envVars: [
          { name: "ANTHROPIC_API_KEY", mode: "deny" },
          { name: "ANTHROPIC_AUTH_TOKEN", mode: "deny" },
          { name: "CLAUDE_CODE_OAUTH_TOKEN", mode: "deny" },
        ],
      },
    },
  };
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--safe-mode",
    "--setting-sources", "",
    "--settings", JSON.stringify(settings),
    "--permission-mode", "dontAsk",
    "--tools", "Bash",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--no-session-persistence",
    "--no-chrome",
    "--system-prompt", input.systemPrompt,
  ];
  if (input.model) args.push("--model", input.model);
  return args;
}

class ProductionArtifactClaudeRunner extends ClaudeCodeRunner {
  readonly #worktreeDir: string;
  readonly #runtimeRoot: string;
  readonly #model: string | undefined;

  constructor(options: {
    readonly command: string;
    readonly model?: string;
    readonly spawner: ProcessSpawner;
    readonly worktreeDir: string;
    readonly runtimeRoot: string;
    readonly enforceArtifactUpdate: boolean;
  }) {
    super({
      command: options.command,
      model: options.model,
      spawner: options.spawner,
      enforceArtifactUpdate: options.enforceArtifactUpdate,
    });
    this.#worktreeDir = options.worktreeDir;
    this.#runtimeRoot = options.runtimeRoot;
    this.#model = options.model;
  }

  override buildArgs(systemPrompt: string): string[] {
    return buildProductionArtifactClaudeArgs({
      worktreeDir: this.#worktreeDir,
      runtimeRoot: this.#runtimeRoot,
      systemPrompt,
      model: this.#model,
    });
  }
}

class ExactArtifactProviderSpawner implements ProcessSpawner {
  readonly #delegate: ProcessSpawner;
  readonly #executable: string;
  readonly #worktreeDir: string;
  readonly #hostHome: string;
  readonly #runtime: ArtifactProviderRuntime;
  readonly #claudeConfigDir: string | undefined;

  constructor(input: {
    readonly delegate: ProcessSpawner;
    readonly executable: string;
    readonly worktreeDir: string;
    readonly hostHome: string;
    readonly runtime: ArtifactProviderRuntime;
    readonly claudeConfigDir?: string;
  }) {
    this.#delegate = input.delegate;
    this.#executable = input.executable;
    this.#worktreeDir = input.worktreeDir;
    this.#hostHome = input.hostHome;
    this.#runtime = input.runtime;
    this.#claudeConfigDir = input.claudeConfigDir;
  }

  async run(input: SpawnInput) {
    let exactCwd: string;
    try {
      exactCwd = realpathSync(input.cwd);
    } catch (error) {
      throw new ProductionArtifactProviderSandboxError("Artifact provider cwd is unavailable", error);
    }
    if (input.command !== this.#executable || exactCwd !== this.#worktreeDir) {
      throw new ProductionArtifactProviderSandboxError(
        "Artifact provider spawn does not match its exact executable and candidate worktree",
      );
    }
    const environment = providerProcessEnvironment({
      request: input.env,
      hostHome: this.#hostHome,
      runtime: this.#runtime,
      claudeConfigDir: this.#claudeConfigDir,
    });
    return this.#delegate.run({
      ...input,
      command: this.#executable,
      cwd: this.#worktreeDir,
      env: environment,
    });
  }
}

function supportedProvider(providerId: string, command: string): SupportedArtifactProviderId {
  if (providerId === "codex") {
    throw new ProductionArtifactProviderSandboxError(
      "Codex Artifact generation is disabled: its /tmp-granting tool sandbox cannot be safely nested inside the required provider-level macOS sandbox",
    );
  }
  if (providerId === "gemini") {
    throw new ProductionArtifactProviderSandboxError(
      "Gemini Artifact generation is unsupported because its installed sandbox cannot confine workspace reads",
    );
  }
  if (providerId !== "claude") {
    throw new ProductionArtifactProviderSandboxError(
      `Artifact provider ${providerId || "(empty)"} is unsupported by the production workspace sandbox`,
    );
  }
  const commandProvider = getProvider(command)?.id;
  if (commandProvider !== providerId) {
    throw new ProductionArtifactProviderSandboxError(
      `Artifact provider command mismatch: ${providerId} cannot execute ${command}`,
    );
  }
  return providerId;
}

/**
 * Builds the production-only Page/Component provider runner. It intentionally
 * does not alter Dezin's global provider registry: only scoped Artifact tasks
 * get the strict OS workspace boundary and exact non-inheriting environment.
 */
export function createProductionArtifactProviderRunner(
  input: ProductionArtifactProviderRunnerInput,
  dependencies: ProductionArtifactProviderSandboxDependencies = {},
): AgentRunner {
  const providerId = supportedProvider(input.providerId, input.command);
  const worktreeDir = exactPlainDirectory(input.worktreeDir, "Artifact provider worktree");
  const hostHome = canonicalHostHome(dependencies.hostHome);
  const executable = dependencies.resolveExecutable?.(providerId, input.command)
    ?? resolveTrustedExecutable(providerId, input.command, hostHome);
  const exactExecutable = exactPlainFile(executable, "Artifact provider executable");
  const runtime = createArtifactProviderRuntime(worktreeDir, dependencies.runtimeRoot);
  const claudeConfigDir = canonicalOptionalDirectory(
    dependencies.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR,
    "Claude authentication directory",
  );
  const delegate = dependencies.spawner ?? new NodeSpawner({ inheritEnvironment: false });
  const spawner = new ExactArtifactProviderSpawner({
    delegate,
    executable: exactExecutable,
    worktreeDir,
    hostHome,
    runtime,
    claudeConfigDir,
  });
  const enforceArtifactUpdate = input.enforceArtifactUpdate ?? false;
  return new ProductionArtifactClaudeRunner({
    command: exactExecutable,
    model: input.model,
    spawner,
    worktreeDir,
    runtimeRoot: runtime.root,
    enforceArtifactUpdate,
  });
}

function exactPlainFile(value: string, label: string): string {
  try {
    const exact = realpathSync(value);
    if (!statSync(exact).isFile()) throw new Error("not a file");
    return exact;
  } catch (error) {
    throw new ProductionArtifactProviderSandboxError(`${label} is unavailable`, error);
  }
}
