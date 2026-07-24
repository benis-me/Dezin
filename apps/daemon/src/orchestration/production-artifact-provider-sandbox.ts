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
  NodeSpawner,
  getProvider,
  type AgentProvider,
  type AgentRunner,
  type ProcessSpawner,
  type SpawnInput,
} from "../../../../packages/agent/src/index.ts";

const MAX_ENVIRONMENT_VALUE_BYTES = 64 * 1024;
const CODEBUDDY_ARTIFACT_TURN_TIMEOUT_MS = 8 * 60 * 1_000;
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
  // CodeBuddy's Bash sandbox cannot mask credential environment variables.
  // Scoped Artifact runs therefore use only the CLI's official host login state.
  codebuddy: new Set<string>(),
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
const CODEBUDDY_ARTIFACT_TOOLS = "Read,Write,Edit,Glob,Grep";
const CODEBUDDY_DENIED_TOOLS = [
  "Bash",
  "PowerShell",
  "Agent",
  "Skill",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "EnterPlanMode",
  "ExitPlanMode",
  "TaskCreate",
  "TaskGet",
  "TaskUpdate",
  "TaskList",
  "TaskStop",
  "TaskOutput",
  "AskUserQuestion",
  "StructuredOutput",
  "ToolSearch",
  "DeferExecuteTool",
  "SendMessage",
  "TeamCreate",
  "TeamDelete",
  "LSP",
  "ImageGen",
  "ImageEdit",
  "ShareLink",
  "VideoGen",
  "EnterWorktree",
  "LeaveWorktree",
  "CronCreate",
  "CronDelete",
  "CronList",
  "WeChatReply",
  "WeComReply",
  "ComputerUse",
  "ListMcpResources",
  "ReadMcpResource",
  "WaitForMcpServers",
  "Workflow",
] as const;

type SupportedArtifactProviderId = "claude" | "codebuddy";
type SupportedArtifactProvider = AgentProvider & { readonly id: SupportedArtifactProviderId };

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
  /** Test seam. Production CodeBuddy Artifact execution is macOS-only. */
  readonly platform?: NodeJS.Platform;
  /** Test seam. Production uses the fixed macOS Seatbelt launcher. */
  readonly sandboxExecutable?: string;
}

export interface ProductionArtifactClaudeArgsInput {
  readonly worktreeDir: string;
  readonly runtimeRoot: string;
  readonly systemPrompt: string;
  readonly model?: string;
}

export interface ProductionArtifactCodeBuddyArgsInput {
  readonly worktreeDir: string;
  readonly runtimeRoot: string;
  readonly hostHome: string;
  readonly systemPrompt: string;
  readonly model?: string;
}

export interface ProductionArtifactCodeBuddySeatbeltInput {
  readonly worktreeDir: string;
  readonly runtimeRoot: string;
  readonly hostHome: string;
  readonly executable: string;
  readonly nodeRuntimeRoot: string;
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
  providerId: SupportedArtifactProviderId,
): boolean {
  const packageSuffix = providerId === "codebuddy"
    ? join("@tencent-ai", "codebuddy-code", "bin", "codebuddy")
    : join("@anthropic-ai", "claude-code", "cli.js");
  const fixedGlobalRoots = [
    ...(providerId === "codebuddy" ? [join(home, ".local", "lib", "node_modules")] : []),
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

function trustedExecutablePath(
  value: string,
  home: string,
  providerId: SupportedArtifactProviderId,
): boolean {
  const path = value.replaceAll("\\", "/");
  if (providerId === "codebuddy") return trustedNodePackageExecutable(path, home, providerId);
  const normalizedHome = home.replaceAll("\\", "/").replace(/\/$/, "");
  return new RegExp(`^${escapedRegExp(normalizedHome)}/\\.local/share/claude/versions/[^/]+$`).test(path)
    || trustedNodePackageExecutable(path, home, providerId)
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
      if (statSync(exact).isFile() && trustedExecutablePath(exact, home, providerId)) return exact;
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
  readonly providerId: SupportedArtifactProviderId;
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
  const providerKeys = PROVIDER_ENVIRONMENT_KEYS[input.providerId];
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

function artifactSandboxReadRoots(worktreeDir: string, runtimeRoot: string): string[] {
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

function codeBuddyHostAuthRoots(hostHome: string): string[] {
  return [
    join(hostHome, ".codebuddy"),
    join(
      hostHome,
      "Library",
      "Application Support",
      "CodeBuddyExtension",
      "Data",
      "Public",
      "auth",
    ),
  ];
}

function codeBuddyAbsolutePermissionPath(value: string): string {
  return `//${value.replace(/^\/+/, "")}`;
}

function seatbeltString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function seatbeltSubpaths(paths: readonly string[]): string {
  return paths.map((path) => `(subpath ${seatbeltString(path)})`).join(" ");
}

/**
 * CodeBuddy's own Bash sandbox has no allowRead setting and merges filesystem
 * arrays with user defaults. The outer macOS Seatbelt profile therefore owns
 * the exact provider-process read/write boundary; CodeBuddy's documented
 * sandbox remains enabled inside it to isolate Bash networking and protect the
 * CLI authentication directory from agent commands.
 */
export function buildProductionArtifactCodeBuddySeatbeltProfile(
  input: ProductionArtifactCodeBuddySeatbeltInput,
): string {
  const packageRoot = resolve(dirname(input.executable), "..");
  const authRoots = codeBuddyHostAuthRoots(input.hostHome);
  const readRoots = [...new Set([
    ...artifactSandboxReadRoots(input.worktreeDir, input.runtimeRoot),
    input.nodeRuntimeRoot,
    packageRoot,
    ...authRoots,
    "/dev",
    "/private/var/db",
    "/private/var/run",
  ])];
  const writeRoots = [...new Set([
    input.worktreeDir,
    input.runtimeRoot,
    ...authRoots,
    "/dev",
  ])];
  return [
    "(version 1)",
    "(allow default)",
    // CodeBuddy and Node read undocumented system/runtime files while starting.
    // Keep those available, but block user, temporary, and mounted-volume data;
    // exact provider roots below are more-specific re-opens. Metadata stays
    // visible so /usr/bin/env and Node can resolve ancestor directories.
    '(deny file-read-data (subpath "/Users"))',
    '(deny file-read-data (subpath "/private/tmp"))',
    '(deny file-read-data (subpath "/tmp"))',
    '(deny file-read-data (subpath "/Volumes"))',
    `(allow file-read-data ${seatbeltSubpaths(readRoots)})`,
    "(deny file-write*)",
    `(allow file-write* ${seatbeltSubpaths(writeRoots)})`,
    `(deny file-write* (subpath ${seatbeltString(join(input.worktreeDir, ".git"))}))`,
  ].join("\n");
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
        allowRead: artifactSandboxReadRoots(input.worktreeDir, input.runtimeRoot),
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

export function buildProductionArtifactCodeBuddyArgs(
  input: ProductionArtifactCodeBuddyArgsInput,
): string[] {
  const authRoots = codeBuddyHostAuthRoots(input.hostHome);
  const authPermissionRules = authRoots.flatMap((path) => {
    const absolute = `${codeBuddyAbsolutePermissionPath(path)}/**`;
    return [`Read(${absolute})`, `Edit(${absolute})`];
  });
  const worktreePermission = `${codeBuddyAbsolutePermissionPath(input.worktreeDir)}/**`;
  const gitPermission = `${codeBuddyAbsolutePermissionPath(join(input.worktreeDir, ".git"))}/**`;
  const settings = {
    permissions: {
      allow: [
        `Read(${worktreePermission})`,
        `Edit(${worktreePermission})`,
        "Glob",
        "Grep",
      ],
      ask: [],
      deny: [
        ...CODEBUDDY_DENIED_TOOLS,
        ...authPermissionRules,
        `Edit(${gitPermission})`,
      ],
    },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      excludedCommands: [],
      allowUnsandboxedCommands: false,
      filesystem: {
        denyRead: authRoots,
        allowWrite: [input.worktreeDir, input.runtimeRoot],
        denyWrite: [
          join(input.worktreeDir, ".git"),
          ...authRoots,
        ],
      },
      network: {
        allowedDomains: [],
        deniedDomains: ["*"],
        allowUnixSockets: [],
        allowLocalBinding: false,
      },
    },
  };
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--setting-sources", "",
    "--settings", JSON.stringify(settings),
    "--permission-mode", "dontAsk",
    "--tools", CODEBUDDY_ARTIFACT_TOOLS,
    "--disallowedTools", CODEBUDDY_DENIED_TOOLS.join(","),
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--no-session-persistence",
    "--system-prompt", input.systemPrompt,
  ];
  if (input.model) args.push("--model", input.model);
  return args;
}

class ExactArtifactProviderSpawner implements ProcessSpawner {
  readonly #delegate: ProcessSpawner;
  readonly #providerId: SupportedArtifactProviderId;
  readonly #executable: string;
  readonly #worktreeDir: string;
  readonly #hostHome: string;
  readonly #runtime: ArtifactProviderRuntime;
  readonly #claudeConfigDir: string | undefined;
  readonly #sandboxExecutable: string | undefined;
  readonly #sandboxProfile: string | undefined;

  constructor(input: {
    readonly delegate: ProcessSpawner;
    readonly providerId: SupportedArtifactProviderId;
    readonly executable: string;
    readonly worktreeDir: string;
    readonly hostHome: string;
    readonly runtime: ArtifactProviderRuntime;
    readonly claudeConfigDir?: string;
    readonly sandboxExecutable?: string;
    readonly sandboxProfile?: string;
  }) {
    this.#delegate = input.delegate;
    this.#providerId = input.providerId;
    this.#executable = input.executable;
    this.#worktreeDir = input.worktreeDir;
    this.#hostHome = input.hostHome;
    this.#runtime = input.runtime;
    this.#claudeConfigDir = input.claudeConfigDir;
    this.#sandboxExecutable = input.sandboxExecutable;
    this.#sandboxProfile = input.sandboxProfile;
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
      providerId: this.#providerId,
      request: input.env,
      hostHome: this.#hostHome,
      runtime: this.#runtime,
      claudeConfigDir: this.#claudeConfigDir,
    });
    const sandboxed = this.#sandboxExecutable !== undefined;
    if (sandboxed && !this.#sandboxProfile) {
      throw new ProductionArtifactProviderSandboxError(
        "Artifact provider sandbox profile is unavailable",
      );
    }
    return this.#delegate.run({
      ...input,
      ...(this.#providerId === "codebuddy"
        ? {
            timeoutMs: input.timeoutMs === undefined || input.timeoutMs <= 0
              ? CODEBUDDY_ARTIFACT_TURN_TIMEOUT_MS
              : Math.min(input.timeoutMs, CODEBUDDY_ARTIFACT_TURN_TIMEOUT_MS),
          }
        : {}),
      command: this.#sandboxExecutable ?? this.#executable,
      args: sandboxed
        ? ["-p", this.#sandboxProfile!, this.#executable, ...input.args]
        : input.args,
      cwd: this.#worktreeDir,
      env: environment,
    });
  }
}

function supportedProvider(providerId: string, command: string): SupportedArtifactProvider {
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
  if (providerId !== "claude" && providerId !== "codebuddy") {
    throw new ProductionArtifactProviderSandboxError(
      `Artifact provider ${providerId || "(empty)"} is unsupported by the production workspace sandbox`,
    );
  }
  const commandProvider = getProvider(command);
  if (commandProvider?.id !== providerId) {
    throw new ProductionArtifactProviderSandboxError(
      `Artifact provider command mismatch: ${providerId} cannot execute ${command}`,
    );
  }
  return commandProvider as SupportedArtifactProvider;
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
  const provider = supportedProvider(input.providerId, input.command);
  const providerId = provider.id;
  const worktreeDir = exactPlainDirectory(input.worktreeDir, "Artifact provider worktree");
  const hostHome = canonicalHostHome(dependencies.hostHome);
  const executable = dependencies.resolveExecutable?.(providerId, input.command)
    ?? resolveTrustedExecutable(providerId, input.command, hostHome);
  const exactExecutable = exactPlainFile(executable, "Artifact provider executable");
  const runtime = createArtifactProviderRuntime(worktreeDir, dependencies.runtimeRoot);
  const claudeConfigDir = providerId === "claude"
    ? canonicalOptionalDirectory(
        dependencies.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR,
        "Claude authentication directory",
      )
    : undefined;
  const platform = dependencies.platform ?? process.platform;
  if (providerId === "codebuddy" && platform !== "darwin") {
    throw new ProductionArtifactProviderSandboxError(
      "CodeBuddy Artifact generation requires the exact macOS Seatbelt provider boundary",
    );
  }
  const sandboxExecutable = providerId === "codebuddy"
    ? exactPlainFile(
        dependencies.sandboxExecutable ?? "/usr/bin/sandbox-exec",
        "CodeBuddy macOS sandbox executable",
      )
    : undefined;
  const sandboxProfile = providerId === "codebuddy"
    ? buildProductionArtifactCodeBuddySeatbeltProfile({
        worktreeDir,
        runtimeRoot: runtime.root,
        hostHome,
        executable: exactExecutable,
        nodeRuntimeRoot: resolve(dirname(process.execPath), ".."),
      })
    : undefined;
  const delegate = dependencies.spawner ?? new NodeSpawner({ inheritEnvironment: false });
  const spawner = new ExactArtifactProviderSpawner({
    delegate,
    providerId,
    executable: exactExecutable,
    worktreeDir,
    hostHome,
    runtime,
    claudeConfigDir,
    sandboxExecutable,
    sandboxProfile,
  });
  const enforceArtifactUpdate = input.enforceArtifactUpdate ?? false;
  return provider.createRunner({
    command: exactExecutable,
    model: input.model,
    spawner,
    enforceArtifactUpdate,
    buildArgs: (systemPrompt) => (
      providerId === "codebuddy"
        ? buildProductionArtifactCodeBuddyArgs({
            worktreeDir,
            runtimeRoot: runtime.root,
            hostHome,
            systemPrompt,
            model: input.model,
          })
        : buildProductionArtifactClaudeArgs({
            worktreeDir,
            runtimeRoot: runtime.root,
            systemPrompt,
            model: input.model,
          })
    ),
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
