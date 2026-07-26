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
  relative,
  resolve,
  sep,
} from "node:path";

import {
  GenericCliRunner,
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
const EMPTY_PROVIDER_ENVIRONMENT_KEYS = new Set<string>();
const PROVIDER_ENVIRONMENT_KEYS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  claude: new Set([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ]),
  // CodeBuddy's Bash sandbox cannot mask credential environment variables.
  // Scoped Artifact runs therefore use only the CLI's official host login state.
  codebuddy: EMPTY_PROVIDER_ENVIRONMENT_KEYS,
  codex: new Set([
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
  ]),
  gemini: new Set([
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
  ]),
  // The remaining generic CLIs use their provider-scoped host login state.
  // Do not pass through unrelated model-provider credentials to model-agnostic
  // CLIs: their selected account/config remains the source of truth.
  "cursor-agent": EMPTY_PROVIDER_ENVIRONMENT_KEYS,
  copilot: EMPTY_PROVIDER_ENVIRONMENT_KEYS,
  qwen: EMPTY_PROVIDER_ENVIRONMENT_KEYS,
  opencode: EMPTY_PROVIDER_ENVIRONMENT_KEYS,
  kimi: EMPTY_PROVIDER_ENVIRONMENT_KEYS,
  trae: EMPTY_PROVIDER_ENVIRONMENT_KEYS,
  pi: EMPTY_PROVIDER_ENVIRONMENT_KEYS,
  hermes: EMPTY_PROVIDER_ENVIRONMENT_KEYS,
});
const GENERIC_PROVIDER_AUTH_RELATIVE_PATHS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  codex: [".codex"],
  gemini: [".gemini", join(".config", "gemini"), join(".cache", "gemini")],
  "cursor-agent": [
    ".cursor",
    join(".config", "Cursor"),
    join(".local", "share", "cursor-agent"),
    join("Library", "Application Support", "Cursor"),
    join("Library", "Caches", "Cursor"),
  ],
  copilot: [
    ".copilot",
    join(".config", "gh"),
    join("Library", "Application Support", "GitHub Copilot"),
    join("Library", "Caches", "GitHub Copilot"),
  ],
  qwen: [".qwen", join(".config", "qwen"), join(".cache", "qwen")],
  opencode: [
    join(".config", "opencode"),
    join(".local", "share", "opencode"),
    join(".cache", "opencode"),
  ],
  kimi: [".kimi", join(".config", "kimi"), join(".cache", "kimi")],
  trae: [
    ".trae",
    join(".config", "trae"),
    join(".cache", "trae"),
    join("Library", "Application Support", "Trae"),
  ],
  pi: [".pi", join(".config", "pi"), join(".cache", "pi")],
  hermes: [".hermes"],
});
const GENERIC_PROVIDER_RUNTIME_RELATIVE_PATHS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // The registered Hermes launcher delegates to its uv-managed Python runtime.
  hermes: [join(".local", "share", "uv")],
});
const SAFE_AMBIENT_ENVIRONMENT_KEYS = ["LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "USER"] as const;
const DAEMON_OWNED_PACKAGE_MANAGER_ENVIRONMENT_KEYS = new Set([
  "npm_config_cache",
  "pnpm_config_store_dir",
  "YARN_CACHE_FOLDER",
  "COREPACK_HOME",
  "BUN_INSTALL_CACHE_DIR",
]);
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

type StrictArtifactProviderId = "claude" | "codebuddy";

export interface ProductionArtifactProviderRunnerInput {
  readonly providerId: string;
  readonly command: string;
  readonly model?: string;
  /** Root of the isolated Git candidate transaction. */
  readonly candidateWorktreeDir: string;
  /** Exact Artifact source scope used as the provider cwd. */
  readonly worktreeDir: string;
  readonly enforceArtifactUpdate?: boolean;
}

export interface ProductionArtifactProviderSandboxDependencies {
  /** Test seam. Production verifies official strict CLIs or a registry-canonical generic CLI. */
  readonly resolveExecutable?: (
    providerId: string,
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

export interface ProductionArtifactCodexArgsInput {
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

export interface ProductionArtifactGenericSeatbeltInput {
  readonly providerId: string;
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
  candidateWorktreeDir: string,
  worktreeDir: string,
  requestedRoot: string | undefined,
): ArtifactProviderRuntime {
  if (!inside(candidateWorktreeDir, worktreeDir)) {
    throw new ProductionArtifactProviderSandboxError(
      "Artifact provider scoped worktree must remain inside the exact candidate worktree",
    );
  }
  const transactionRoot = exactPlainDirectory(
    dirname(candidateWorktreeDir),
    "Artifact transaction root",
  );
  const requestedPath = resolve(requestedRoot ?? join(transactionRoot, "provider-runtime"));
  const requestedParent = exactPlainDirectory(
    dirname(requestedPath),
    "Artifact provider runtime parent",
  );
  const rootPath = join(requestedParent, basename(requestedPath));
  if (requestedParent !== transactionRoot || inside(candidateWorktreeDir, rootPath)) {
    throw new ProductionArtifactProviderSandboxError(
      "Artifact provider runtime must be a private sibling inside the exact candidate transaction",
    );
  }
  const root = ensurePrivateDirectory(rootPath, "Artifact provider runtime");
  if (!inside(transactionRoot, root) || inside(candidateWorktreeDir, root)) {
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
    `${home}/.bun/bin`,
    `${home}/.deno/bin`,
    `${home}/.npm-global/bin`,
    `${home}/.cargo/bin`,
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
  providerId: StrictArtifactProviderId,
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
  providerId: StrictArtifactProviderId,
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
  providerId: StrictArtifactProviderId,
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

function genericTrustedInstallRoots(home: string): string[] {
  return [...new Set([
    join(home, ".local"),
    join(home, ".bun"),
    join(home, ".deno"),
    join(home, ".npm-global"),
    join(home, ".cargo"),
    resolve(dirname(process.execPath), ".."),
    "/opt/homebrew",
    "/usr/local",
    "/usr",
    "/bin",
  ].map((root) => resolve(root)))];
}

function resolveCanonicalRegistryExecutable(
  provider: AgentProvider,
  home: string,
): string {
  if (
    isAbsolute(provider.command)
    || provider.command.includes("/")
    || provider.command.includes("\\")
  ) {
    throw new ProductionArtifactProviderSandboxError(
      `Artifact provider ${provider.id} has an invalid registry executable`,
    );
  }
  const trustedRoots = genericTrustedInstallRoots(home);
  for (const candidate of executableCandidates(provider.command, home)) {
    try {
      accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      const exact = realpathSync(candidate);
      if (
        statSync(exact).isFile()
        && trustedRoots.some((root) => inside(root, exact))
      ) {
        return exact;
      }
    } catch {
      // Continue through only the fixed registry search roots.
    }
  }
  throw new ProductionArtifactProviderSandboxError(
    `The canonical ${provider.id} registry executable could not be verified in a fixed install root`,
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
  readonly providerId: string;
  readonly request: NodeJS.ProcessEnv | undefined;
  readonly hostHome: string;
  readonly runtime: ArtifactProviderRuntime;
  readonly claudeConfigDir?: string;
}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: input.hostHome,
    PATH: safeSearchDirectories(input.hostHome).join(delimiter),
    TMPDIR: input.runtime.tmp,
    npm_config_cache: join(input.runtime.root, "npm-cache"),
    pnpm_config_store_dir: join(input.runtime.root, "pnpm-store"),
    YARN_CACHE_FOLDER: join(input.runtime.root, "yarn-cache"),
    COREPACK_HOME: join(input.runtime.root, "corepack"),
    BUN_INSTALL_CACHE_DIR: join(input.runtime.root, "bun-install-cache"),
    TERM: "dumb",
    NO_COLOR: "1",
    IMPECCABLE_HOOK_DISABLED: "1",
    IMPECCABLE_HOOK_QUIET: "1",
    DEZIN_DAEMON_TOKEN: undefined,
  };
  if (input.providerId === "claude" || input.providerId === "codebuddy") {
    environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  }
  if (input.claudeConfigDir !== undefined) environment.CLAUDE_CONFIG_DIR = input.claudeConfigDir;
  for (const key of SAFE_AMBIENT_ENVIRONMENT_KEYS) {
    const value = safeEnvironmentValue(process.env[key], `Artifact provider ambient ${key}`);
    if (value !== undefined) environment[key] = value;
  }
  const providerKeys = PROVIDER_ENVIRONMENT_KEYS[input.providerId];
  if (!providerKeys) {
    throw new ProductionArtifactProviderSandboxError(
      `Artifact provider ${input.providerId} has no environment policy`,
    );
  }
  for (const [key, rawValue] of Object.entries(input.request ?? {})) {
    if (DAEMON_OWNED_PACKAGE_MANAGER_ENVIRONMENT_KEYS.has(key)) {
      if (rawValue !== undefined) {
        throw new ProductionArtifactProviderSandboxError(
          `Artifact provider environment variable ${key} is daemon-owned and cannot be overridden`,
        );
      }
      continue;
    }
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

function nodePackageRoot(executable: string): string | undefined {
  const parts = executable.split(sep);
  const nodeModulesIndex = parts.lastIndexOf("node_modules");
  if (nodeModulesIndex < 0 || nodeModulesIndex + 1 >= parts.length) return undefined;
  const packageParts = parts[nodeModulesIndex + 1]!.startsWith("@") ? 2 : 1;
  if (nodeModulesIndex + packageParts >= parts.length) return undefined;
  return parts.slice(0, nodeModulesIndex + 1 + packageParts).join(sep) || sep;
}

function firstDescendantRoot(root: string, candidate: string): string | undefined {
  if (!inside(root, candidate)) return undefined;
  const descendant = relative(root, candidate).split(sep)[0];
  return descendant ? join(root, descendant) : root;
}

function genericExecutableRuntimeRoots(
  executable: string,
  hostHome: string,
  nodeRuntimeRoot: string,
): string[] {
  const packageRoot = nodePackageRoot(executable);
  const localShareRoot = firstDescendantRoot(join(hostHome, ".local", "share"), executable);
  const homebrewCellarRoot = firstDescendantRoot("/opt/homebrew/Cellar", executable);
  const localCellarRoot = firstDescendantRoot("/usr/local/Cellar", executable);
  return [...new Set([
    dirname(executable),
    nodeRuntimeRoot,
    packageRoot,
    localShareRoot,
    homebrewCellarRoot,
    localCellarRoot,
  ].filter((root): root is string => root !== undefined))];
}

function genericProviderAuthRoots(providerId: string, hostHome: string): string[] {
  const relativePaths = GENERIC_PROVIDER_AUTH_RELATIVE_PATHS[providerId];
  if (!relativePaths) {
    throw new ProductionArtifactProviderSandboxError(
      `Artifact provider ${providerId} has no host authentication boundary`,
    );
  }
  return relativePaths.map((path) => join(hostHome, path));
}

function genericProviderRuntimeRoots(providerId: string, hostHome: string): string[] {
  return (GENERIC_PROVIDER_RUNTIME_RELATIVE_PATHS[providerId] ?? [])
    .map((path) => join(hostHome, path));
}

/**
 * Generic CLIs commonly run with broad auto-approval flags. Their entire
 * process tree therefore runs inside an outer Seatbelt boundary that re-opens
 * only the candidate transaction, the exact CLI runtime, and that provider's
 * own host-login state. The configured command is never added to this profile;
 * only the registry-canonical executable is.
 */
export function buildProductionArtifactGenericSeatbeltProfile(
  input: ProductionArtifactGenericSeatbeltInput,
): string {
  const authRoots = genericProviderAuthRoots(input.providerId, input.hostHome);
  const providerRuntimeRoots = genericProviderRuntimeRoots(input.providerId, input.hostHome);
  const executableRoots = genericExecutableRuntimeRoots(
    input.executable,
    input.hostHome,
    input.nodeRuntimeRoot,
  );
  const readRoots = [...new Set([
    ...artifactSandboxReadRoots(input.worktreeDir, input.runtimeRoot),
    ...executableRoots,
    ...providerRuntimeRoots,
    ...authRoots,
    "/dev",
    "/private/var/db",
    "/private/var/run",
  ])];
  const writeRoots = [...new Set([
    input.worktreeDir,
    input.runtimeRoot,
    // Account-scoped CLIs may refresh their own login/session state, but no
    // other provider or host directory is writable.
    ...authRoots,
    "/dev",
  ])];
  const sensitiveRoots = [...new Set([
    input.hostHome,
    "/Users",
    "/private/tmp",
    "/tmp",
    "/private/var/folders",
    "/var/folders",
    "/Volumes",
  ])];
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-read-data ${seatbeltSubpaths(sensitiveRoots)})`,
    `(allow file-read-data ${seatbeltSubpaths(readRoots)})`,
    "(deny file-write*)",
    `(allow file-write* ${seatbeltSubpaths(writeRoots)})`,
    `(deny file-write* (subpath ${seatbeltString(join(input.worktreeDir, ".git"))}))`,
  ].join("\n");
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

/**
 * Production Artifact runs keep Codex login state while refusing host-specific
 * execution policy and cwd/parent AGENTS.md project documents. The selected
 * model remains explicit, but reasoning effort is intentionally left to that
 * model's own default.
 */
export function buildProductionArtifactCodexArgs(
  input: ProductionArtifactCodexArgsInput,
): string[] {
  return [
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "danger-full-access",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "-c",
    "project_doc_max_bytes=0",
    ...(input.model ? ["-m", input.model] : []),
    input.systemPrompt,
  ];
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
  readonly #providerId: string;
  readonly #executable: string;
  readonly #worktreeDir: string;
  readonly #hostHome: string;
  readonly #runtime: ArtifactProviderRuntime;
  readonly #claudeConfigDir: string | undefined;
  readonly #sandboxExecutable: string | undefined;
  readonly #sandboxProfile: string | undefined;

  constructor(input: {
    readonly delegate: ProcessSpawner;
    readonly providerId: string;
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

function supportedProvider(providerId: string, command: string): AgentProvider {
  const provider = getProvider(providerId);
  if (!provider || provider.id !== providerId) {
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
  return provider;
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
  const candidateWorktreeDir = exactPlainDirectory(
    input.candidateWorktreeDir,
    "Artifact candidate worktree",
  );
  const worktreeDir = exactPlainDirectory(input.worktreeDir, "Artifact provider worktree");
  if (!inside(candidateWorktreeDir, worktreeDir)) {
    throw new ProductionArtifactProviderSandboxError(
      "Artifact provider scoped worktree must remain inside the exact candidate worktree",
    );
  }
  const hostHome = canonicalHostHome(dependencies.hostHome);
  let executable: string;
  if (providerId === "claude" || providerId === "codebuddy") {
    executable = dependencies.resolveExecutable?.(providerId, input.command)
      ?? resolveTrustedExecutable(providerId, input.command, hostHome);
  } else {
    executable = dependencies.resolveExecutable?.(providerId, provider.command)
      ?? resolveCanonicalRegistryExecutable(provider, hostHome);
  }
  const exactExecutable = exactPlainFile(executable, "Artifact provider executable");
  const runtime = createArtifactProviderRuntime(
    candidateWorktreeDir,
    worktreeDir,
    dependencies.runtimeRoot,
  );
  const claudeConfigDir = providerId === "claude"
    ? canonicalOptionalDirectory(
        dependencies.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR,
        "Claude authentication directory",
      )
    : undefined;
  const platform = dependencies.platform ?? process.platform;
  const genericProvider = provider.genericConfig !== undefined;
  if (providerId === "codebuddy" && platform !== "darwin") {
    throw new ProductionArtifactProviderSandboxError(
      "CodeBuddy Artifact generation requires the exact macOS Seatbelt provider boundary",
    );
  }
  if (genericProvider && platform !== "darwin") {
    throw new ProductionArtifactProviderSandboxError(
      `${provider.label} Artifact generation requires the outer macOS Seatbelt process sandbox`,
    );
  }
  const sandboxedProvider = providerId === "codebuddy" || genericProvider;
  const sandboxExecutable = sandboxedProvider
    ? exactPlainFile(
        dependencies.sandboxExecutable ?? "/usr/bin/sandbox-exec",
        "Artifact provider macOS sandbox executable",
      )
    : undefined;
  const nodeRuntimeRoot = resolve(dirname(process.execPath), "..");
  const sandboxProfile = providerId === "codebuddy"
    ? buildProductionArtifactCodeBuddySeatbeltProfile({
      worktreeDir,
      runtimeRoot: runtime.root,
      hostHome,
      executable: exactExecutable,
      nodeRuntimeRoot,
    })
    : genericProvider
      ? buildProductionArtifactGenericSeatbeltProfile({
        providerId,
        worktreeDir,
        runtimeRoot: runtime.root,
        hostHome,
        executable: exactExecutable,
        nodeRuntimeRoot,
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
  const buildArgs = providerId === "codebuddy"
    ? (systemPrompt: string) => buildProductionArtifactCodeBuddyArgs({
      worktreeDir,
      runtimeRoot: runtime.root,
      hostHome,
      systemPrompt,
      model: input.model,
    })
    : providerId === "claude"
      ? (systemPrompt: string) => buildProductionArtifactClaudeArgs({
        worktreeDir,
        runtimeRoot: runtime.root,
        systemPrompt,
        model: input.model,
      })
      : undefined;
  if (providerId === "codex") {
    return new GenericCliRunner({
      id: "codex",
      command: exactExecutable,
      model: input.model,
      config: {
        buildArgs: (model, prompt) => buildProductionArtifactCodexArgs({
          systemPrompt: prompt,
          model,
        }),
      },
      spawner,
      enforceArtifactUpdate,
    });
  }
  return provider.createRunner({
    command: exactExecutable,
    model: input.model,
    spawner,
    enforceArtifactUpdate,
    ...(buildArgs ? { buildArgs } : {}),
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
