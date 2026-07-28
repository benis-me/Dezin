import {
  AgentOutputLimitError,
  codeBuddyHostLoginEnvironment,
  getProvider,
  NodeSpawner,
  type AgentProvider,
  type NodeSpawnerOptions,
  type ProcessSpawner,
} from "../../../../packages/agent/src/index.ts";
import {
  accessSync,
  constants,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 3 * 60 * 1_000;
const DEFAULT_STDERR_LIMIT_BYTES = 256 * 1024;
const MAX_ENVIRONMENT_VALUE_BYTES = 64 * 1024;
const MAX_IMAGE_COUNT = 2;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_SYSTEM_PROMPT_BYTES = 64 * 1024;
const MAX_MESSAGE_BYTES = 512 * 1024;
const MAX_OUTPUT_SCHEMA_BYTES = 64 * 1024;
const MAX_STDIN_BYTES = 16 * 1024 * 1024;
const MAX_CODEX_DIAGNOSTIC_BYTES = 16 * 1024;
const OUTPUT_SCHEMA_FILENAME = "dezin-final-output.schema.json";
const IMAGE_EVIDENCE_FILENAME_PREFIX = "dezin-image-evidence";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SAFE_REQUEST_ENVIRONMENT_KEYS = Object.freeze({
  claude: new Set([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ]),
  codebuddy: new Set<string>(),
  codex: new Set([
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
  ]),
  gemini: new Set([
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
  ]),
} satisfies Record<string, ReadonlySet<string>>);
const SAFE_AMBIENT_ENVIRONMENT_KEYS = ["LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "USER"] as const;

export type SafeStructuredAgentErrorCode =
  | "provider-unavailable"
  | "process-failed"
  | "quota-exhausted"
  | "timed-out"
  | "output-limit"
  | "output-invalid";

export type SafeStructuredAgentFailureReasonCode =
  | "quota-exhausted"
  | "rate-limited"
  | "request-rejected"
  | "upstream-unavailable";

export interface SafeStructuredAgentFailureDetails {
  readonly reasonCode: SafeStructuredAgentFailureReasonCode;
  readonly httpStatus?: number;
  readonly retryable: boolean;
}

export class SafeStructuredAgentError extends Error {
  readonly code: SafeStructuredAgentErrorCode;
  readonly details?: Readonly<SafeStructuredAgentFailureDetails>;

  constructor(
    code: SafeStructuredAgentErrorCode,
    message: string,
    cause?: unknown,
    details?: SafeStructuredAgentFailureDetails,
  ) {
    super(message);
    this.name = "SafeStructuredAgentError";
    this.code = code;
    if (details !== undefined) this.details = Object.freeze({ ...details });
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

export interface SafeStructuredAgentRequest {
  readonly command: string;
  readonly model?: string;
  /**
   * Primary task executors set caller-owned when their durable scheduler is the
   * sole retry owner. Review-only callers retain the bounded transport default.
   */
  readonly remoteRetryMode?: "transport-owned" | "caller-owned";
  /** Codex-only JSON Schema for the terminal Agent message. */
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  /** Codex-only, read-only Web Search capability for this exact structured turn. */
  readonly allowWebSearch?: boolean;
  readonly systemPrompt: string;
  readonly message: string;
  /** Image evidence delivered through a provider-native, no-tools transport. */
  readonly images?: readonly SafeStructuredAgentImage[];
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxOutputBytes: number;
}

export interface SafeStructuredAgentImage {
  readonly label: string;
  readonly mediaType: "image/png" | "image/jpeg";
  readonly data: string;
}

export interface SafeStructuredAgentResult {
  readonly providerId: string;
  readonly text: string;
}

export interface SafeStructuredAgentOptions {
  readonly createSpawner?: (options: NodeSpawnerOptions) => ProcessSpawner;
  /** Test seam; production always resolves the official CLI from fixed install roots. */
  readonly resolveClaudeExecutable?: () => string;
  readonly resolveCodeBuddyExecutable?: () => string;
  readonly resolveCodexExecutable?: () => string;
  /** Test seam; production resolves the registry's canonical binary through fixed search roots. */
  readonly resolveRegisteredExecutable?: (command: string) => string;
  /** Test seams for deterministic outer-confinement coverage on non-macOS CI. */
  readonly platform?: NodeJS.Platform;
  readonly resolveSandboxExecutable?: () => string;
  readonly stderrLimitBytes?: number;
}

function safeEnvironmentValue(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_ENVIRONMENT_VALUE_BYTES) {
    throw new SafeStructuredAgentError("output-invalid", `${label} is invalid`);
  }
  return value;
}

export function safeRegisteredSearchDirectories(home = homedir()): string[] {
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

function trustedClaudeNodePackageExecutable(
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
  if (fixedGlobalRoots.some((root) => path === join(root, packageSuffix).replaceAll("\\", "/"))) return true;
  const normalizedHome = home.replaceAll("\\", "/").replace(/\/$/, "");
  const nvmSuffix = packageSuffix.replaceAll("\\", "/");
  return new RegExp(
    `^${escapedRegExp(normalizedHome)}/\\.nvm/versions/node/[^/]+/lib/node_modules/${escapedRegExp(nvmSuffix)}$`,
  ).test(path);
}

export function isTrustedClaudeExecutablePath(value: string, trustedHome = homedir()): boolean {
  const path = value.replaceAll("\\", "/");
  const home = trustedHome.replaceAll("\\", "/").replace(/\/$/, "");
  return new RegExp(`^${escapedRegExp(home)}/\\.local/share/claude/versions/[^/]+$`).test(path)
    || trustedClaudeNodePackageExecutable(path, trustedHome)
    || /^\/(?:opt\/homebrew|usr\/local)\/Cellar\/(?:claude-code|claude)\/[^/]+\/.+\/claude$/.test(path);
}

function resolveTrustedClaudeExecutable(): string {
  const executableNames = process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  for (const directory of safeRegisteredSearchDirectories()) {
    for (const name of executableNames) {
      const candidate = join(directory, name);
      try {
        accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        const exact = realpathSync(candidate);
        if (statSync(exact).isFile() && isTrustedClaudeExecutablePath(exact)) return exact;
      } catch {
        // Keep searching the fixed install roots.
      }
    }
  }
  throw new SafeStructuredAgentError(
    "provider-unavailable",
    "The official Claude CLI executable could not be verified in a trusted install location",
  );
}

export function isTrustedCodeBuddyExecutablePath(value: string, trustedHome = homedir()): boolean {
  const path = value.replaceAll("\\", "/");
  const packageSuffix = join("@tencent-ai", "codebuddy-code", "bin", "codebuddy").replaceAll("\\", "/");
  const fixedGlobalRoots = [
    join(trustedHome, ".local", "lib", "node_modules"),
    join(trustedHome, ".npm-global", "lib", "node_modules"),
    join(resolve(dirname(process.execPath), ".."), "lib", "node_modules"),
    "/opt/homebrew/lib/node_modules",
    "/usr/local/lib/node_modules",
  ];
  return fixedGlobalRoots.some((root) => path === join(root, packageSuffix).replaceAll("\\", "/"));
}

function resolveTrustedCodeBuddyExecutable(): string {
  const executableNames = process.platform === "win32"
    ? ["codebuddy.exe", "codebuddy.cmd"]
    : ["codebuddy"];
  for (const directory of safeRegisteredSearchDirectories()) {
    for (const name of executableNames) {
      const candidate = join(directory, name);
      try {
        accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        const exact = realpathSync(candidate);
        if (statSync(exact).isFile() && isTrustedCodeBuddyExecutablePath(exact)) return exact;
      } catch {
        // Keep searching the fixed install roots.
      }
    }
  }
  throw new SafeStructuredAgentError(
    "provider-unavailable",
    "The official CodeBuddy CLI executable could not be verified in a trusted install location",
  );
}

export function resolveRegisteredProviderExecutable(
  command: string,
  trustedHome = homedir(),
): string {
  const executableNames = process.platform === "win32"
    ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command]
    : [command];
  for (const directory of safeRegisteredSearchDirectories(trustedHome)) {
    for (const name of executableNames) {
      const candidate = join(directory, name);
      try {
        accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        const exact = realpathSync(candidate);
        if (statSync(exact).isFile()) return exact;
      } catch {
        // Keep searching only the daemon-owned fixed path list.
      }
    }
  }
  throw new SafeStructuredAgentError(
    "provider-unavailable",
    `The registered ${command} CLI executable could not be resolved through fixed install roots`,
  );
}

function isTrustedCodexWrapperPath(value: string, trustedHome: string): boolean {
  const path = value.replaceAll("\\", "/");
  const home = trustedHome.replaceAll("\\", "/").replace(/\/$/, "");
  const packageSuffix = join("@openai", "codex", "bin", "codex.js").replaceAll("\\", "/");
  const fixedGlobalRoots = [
    join(trustedHome, ".local", "lib", "node_modules"),
    join(trustedHome, ".npm-global", "lib", "node_modules"),
    join(trustedHome, ".bun", "install", "global", "node_modules"),
    join(resolve(dirname(process.execPath), ".."), "lib", "node_modules"),
    "/opt/homebrew/lib/node_modules",
    "/usr/local/lib/node_modules",
  ];
  if (fixedGlobalRoots.some((root) => path === join(root, packageSuffix).replaceAll("\\", "/"))) {
    return true;
  }
  return new RegExp(
    `^${escapedRegExp(home)}/\\.nvm/versions/node/[^/]+/lib/node_modules/${escapedRegExp(packageSuffix)}$`,
  ).test(path);
}

interface TrustedCodexNativeResolutionOptions {
  readonly trustedHome?: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
}

/**
 * Resolve the official npm wrapper only as an install identity, then execute
 * its platform-native binary directly. The JavaScript wrapper is intentionally
 * never launched because it must spawn the native client after Seatbelt has
 * denied subprocess execution.
 */
export function resolveTrustedCodexNativeExecutable(
  options: TrustedCodexNativeResolutionOptions = {},
): string {
  const trustedHome = options.trustedHome ?? homedir();
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const target = new Map<string, {
    readonly packageName: string;
    readonly triple: string;
    readonly executableName: string;
  }>([
    ["linux:x64", {
      packageName: "@openai/codex-linux-x64",
      triple: "x86_64-unknown-linux-musl",
      executableName: "codex",
    }],
    ["linux:arm64", {
      packageName: "@openai/codex-linux-arm64",
      triple: "aarch64-unknown-linux-musl",
      executableName: "codex",
    }],
    ["android:x64", {
      packageName: "@openai/codex-linux-x64",
      triple: "x86_64-unknown-linux-musl",
      executableName: "codex",
    }],
    ["android:arm64", {
      packageName: "@openai/codex-linux-arm64",
      triple: "aarch64-unknown-linux-musl",
      executableName: "codex",
    }],
    ["darwin:x64", {
      packageName: "@openai/codex-darwin-x64",
      triple: "x86_64-apple-darwin",
      executableName: "codex",
    }],
    ["darwin:arm64", {
      packageName: "@openai/codex-darwin-arm64",
      triple: "aarch64-apple-darwin",
      executableName: "codex",
    }],
    ["win32:x64", {
      packageName: "@openai/codex-win32-x64",
      triple: "x86_64-pc-windows-msvc",
      executableName: "codex.exe",
    }],
    ["win32:arm64", {
      packageName: "@openai/codex-win32-arm64",
      triple: "aarch64-pc-windows-msvc",
      executableName: "codex.exe",
    }],
  ]).get(`${platform}:${architecture}`);
  if (!target) {
    throw new SafeStructuredAgentError(
      "provider-unavailable",
      `The official Codex native executable is unavailable for ${platform}/${architecture}`,
    );
  }
  const wrapper = resolveRegisteredProviderExecutable("codex", trustedHome);
  if (!isTrustedCodexWrapperPath(wrapper, trustedHome)) {
    throw new SafeStructuredAgentError(
      "provider-unavailable",
      "The official Codex CLI wrapper could not be verified in a trusted install location",
    );
  }
  const packageRoot = resolve(dirname(wrapper), "..");
  const relativeNativePath = [
    "vendor",
    target.triple,
    "bin",
    target.executableName,
  ] as const;
  const candidates = [
    join(packageRoot, "node_modules", ...target.packageName.split("/"), ...relativeNativePath),
    join(packageRoot, ...relativeNativePath),
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
      const exact = realpathSync(candidate);
      if (exact === resolve(candidate) && statSync(exact).isFile()) return exact;
    } catch {
      // Keep checking only the two official wrapper-owned distribution layouts.
    }
  }
  throw new SafeStructuredAgentError(
    "provider-unavailable",
    "The official Codex native executable could not be verified in its wrapper-owned package",
  );
}

function exactEmptyStructuredScratch(cwd: string): string {
  try {
    const exact = realpathSync(cwd);
    if (!statSync(exact).isDirectory() || readdirSync(exact).length !== 0) {
      throw new Error("not an empty directory");
    }
    return exact;
  } catch (error) {
    throw new SafeStructuredAgentError(
      "output-invalid",
      "Generic structured planning requires an existing empty per-run scratch directory",
      error,
    );
  }
}

function resolveSeatbeltExecutable(): string {
  const candidate = "/usr/bin/sandbox-exec";
  try {
    accessSync(candidate, constants.X_OK);
    const exact = realpathSync(candidate);
    if (exact === candidate && statSync(exact).isFile()) return exact;
  } catch {
    // Fall through to the capability error.
  }
  throw new SafeStructuredAgentError(
    "provider-unavailable",
    "Generic structured Agent outer filesystem confinement is unavailable",
  );
}

function seatbeltString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function seatbeltSubpaths(paths: readonly string[]): string {
  return paths.map((path) => `(subpath ${seatbeltString(path)})`).join(" ");
}

function genericExecutableRuntimeRoot(executable: string): string {
  const path = executable.replaceAll("\\", "/");
  const marker = "/node_modules/";
  const markerIndex = path.lastIndexOf(marker);
  if (markerIndex === -1) return dirname(executable);
  const prefix = path.slice(0, markerIndex + marker.length);
  const packagePath = path.slice(markerIndex + marker.length).split("/");
  const packageSegments = packagePath[0]?.startsWith("@") ? 2 : 1;
  return `${prefix}${packagePath.slice(0, packageSegments).join("/")}`;
}

function genericProviderAuthRoots(providerId: string, home: string): string[] {
  const roots: Record<string, readonly string[]> = {
    codex: [".codex"],
    gemini: [".gemini", ".config/gemini", ".cache/gemini"],
    "cursor-agent": [
      ".cursor",
      ".config/Cursor",
      ".local/share/cursor-agent",
      "Library/Application Support/Cursor",
      "Library/Caches/Cursor",
    ],
    copilot: [
      ".copilot",
      ".config/gh",
      "Library/Application Support/GitHub Copilot",
      "Library/Caches/GitHub Copilot",
    ],
    qwen: [".qwen", ".config/qwen", ".cache/qwen"],
    opencode: [".config/opencode", ".local/share/opencode", ".cache/opencode"],
    kimi: [".kimi", ".config/kimi", ".cache/kimi"],
    trae: [".trae", ".config/trae", ".cache/trae", "Library/Application Support/Trae"],
    pi: [".pi", ".config/pi", ".cache/pi"],
    hermes: [".hermes"],
  };
  return (roots[providerId] ?? []).map((path) => join(home, ...path.split("/")));
}

/**
 * Generic coding CLIs do not share an inspectable hard no-tools mode. On macOS
 * this outer Seatbelt boundary still prevents their one-shot process and any
 * subprocess from reading unrelated user/tmp/volume data or writing outside
 * the owned scratch and provider auth roots. Network remains available so the
 * selected provider can complete its model request.
 */
export function buildSafeStructuredGenericSeatbeltProfile(input: {
  readonly providerId: string;
  readonly executable: string;
  readonly scratch: string;
  readonly hostHome?: string;
}): string {
  const home = input.hostHome ?? homedir();
  const authRoots = genericProviderAuthRoots(input.providerId, home);
  const readRoots = [...new Set([
    input.scratch,
    genericExecutableRuntimeRoot(input.executable),
    ...authRoots,
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/Library",
    "/opt/homebrew",
    "/usr/local",
    "/private/etc",
    "/private/var/db",
    "/private/var/run",
    "/dev",
    resolve(dirname(process.execPath), ".."),
  ])];
  const writeRoots = [...new Set([
    input.scratch,
    ...authRoots,
    "/dev",
  ])];
  const processRules = input.providerId === "codex"
    ? [
        "(deny process-fork)",
        "(deny process-exec*)",
        `(allow process-exec (literal ${seatbeltString(input.executable)}))`,
      ]
    : [];
  return [
    "(version 1)",
    "(allow default)",
    ...processRules,
    '(deny file-read-data (subpath "/Users"))',
    '(deny file-read-data (subpath "/private/tmp"))',
    '(deny file-read-data (subpath "/tmp"))',
    '(deny file-read-data (subpath "/private/var/folders"))',
    '(deny file-read-data (subpath "/var/folders"))',
    '(deny file-read-data (subpath "/Volumes"))',
    `(allow file-read-data ${seatbeltSubpaths(readRoots)})`,
    "(deny file-write*)",
    `(allow file-write* ${seatbeltSubpaths(writeRoots)})`,
  ].join("\n");
}

function safeStructuredAgentEnvironment(
  extra: NodeJS.ProcessEnv | undefined,
  providerId: string,
): NodeJS.ProcessEnv {
  const permittedKeys = SAFE_REQUEST_ENVIRONMENT_KEYS[providerId as keyof typeof SAFE_REQUEST_ENVIRONMENT_KEYS]
    ?? new Set<string>();
  const environment: NodeJS.ProcessEnv = {};
  if (providerId === "codebuddy") {
    const hostLoginEnvironment = codeBuddyHostLoginEnvironment({
      TERM: "dumb",
      NO_COLOR: "1",
      IMPECCABLE_HOOK_DISABLED: "1",
      IMPECCABLE_HOOK_QUIET: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    for (const [key, rawValue] of Object.entries(hostLoginEnvironment)) {
      if (rawValue === undefined) {
        environment[key] = undefined;
        continue;
      }
      environment[key] = safeEnvironmentValue(rawValue, `CodeBuddy host-login environment ${key}`);
    }
  }
  Object.assign(environment, {
    HOME: environment.HOME ?? homedir(),
    PATH: environment.PATH ?? safeRegisteredSearchDirectories().join(delimiter),
    TMPDIR: environment.TMPDIR ?? tmpdir(),
    TERM: "dumb",
    NO_COLOR: "1",
    IMPECCABLE_HOOK_DISABLED: "1",
    IMPECCABLE_HOOK_QUIET: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DEZIN_DAEMON_TOKEN: undefined,
  });
  for (const key of SAFE_AMBIENT_ENVIRONMENT_KEYS) {
    const value = safeEnvironmentValue(process.env[key], `Structured Agent ambient ${key}`);
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, rawValue] of Object.entries(extra ?? {})) {
    if (key === "DEZIN_DAEMON_TOKEN") {
      if (rawValue !== undefined) {
        throw new SafeStructuredAgentError(
          "output-invalid",
          "Structured Agent cannot receive the daemon mutation token",
        );
      }
      continue;
    }
    if (!permittedKeys.has(key)) {
      if (rawValue !== undefined) {
        throw new SafeStructuredAgentError(
          "output-invalid",
          `Structured Agent environment variable ${key} is not permitted`,
        );
      }
      continue;
    }
    const value = safeEnvironmentValue(rawValue, `Structured Agent environment variable ${key}`);
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export function safeStructuredClaudeArgs(
  systemPrompt: string,
  model?: string,
  inputFormat: "text" | "stream-json" = "text",
): string[] {
  const streamOutput = inputFormat === "stream-json";
  const args = [
    "--print",
    "--input-format", inputFormat,
    "--output-format", streamOutput ? "stream-json" : "text",
    ...(streamOutput ? ["--verbose"] : []),
    "--permission-mode", "dontAsk",
    "--safe-mode",
    "--tools", "",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--no-session-persistence",
    "--no-chrome",
    "--system-prompt", systemPrompt,
  ];
  if (model) args.push("--model", model);
  return args;
}

export function safeStructuredCodexArgs(
  model?: string,
  outputSchemaPath?: string,
  imagePaths: readonly string[] = [],
  allowWebSearch = false,
): string[] {
  return [
    "exec",
    "--skip-git-repo-check",
    // The outer Seatbelt profile is authoritative. Avoid nesting Codex's
    // /tmp-granting sandbox inside that exact filesystem boundary.
    "--sandbox", "danger-full-access",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--color", "never",
    "--json",
    ...(allowWebSearch ? ["--enable", "standalone_web_search"] : []),
    ...imagePaths.flatMap((path) => ["--image", path]),
    ...(model ? ["--model", model] : []),
    ...(outputSchemaPath ? ["--output-schema", outputSchemaPath] : []),
    "-",
  ];
}

function safeStructuredGenericPrompt(
  systemPrompt: string,
  message: string,
  images: readonly ValidatedSafeStructuredAgentImage[] = [],
): string {
  return [
    systemPrompt,
    "--- DEZIN STRUCTURED REQUEST ---",
    message,
    ...images.map((image, index) => `Image evidence ${index + 1}: ${image.label}`),
  ].join("\n\n");
}

function safeStructuredGenericInvocation(
  provider: AgentProvider,
  request: SafeStructuredAgentRequest,
): { readonly args: string[]; readonly stdin: string } {
  const prompt = safeStructuredGenericPrompt(request.systemPrompt, request.message);
  const config = provider.genericConfig;
  if (config === undefined) {
    return { args: provider.oneShotArgs(request.model, prompt), stdin: "" };
  }
  const viaStdin = config.viaStdin === true;
  return {
    args: config.buildArgs(request.model, viaStdin ? "" : prompt),
    stdin: viaStdin ? prompt : "",
  };
}

function safeStructuredCodeBuddyArgs(
  systemPrompt: string,
  model?: string,
  inputFormat: "text" | "stream-json" = "text",
): string[] {
  const args = [
    "--print",
    "--input-format", inputFormat,
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "dontAsk",
    "--tools", "",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--setting-sources", "",
    "--no-session-persistence",
    "--system-prompt", systemPrompt,
  ];
  if (model) args.push("--model", model);
  return args;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  return value as Record<string, unknown>;
}

const CODEX_SCHEMA_MAP_KEYWORDS = [
  "$defs",
  "definitions",
  "properties",
  "patternProperties",
  "dependentSchemas",
] as const;
const CODEX_SCHEMA_ARRAY_KEYWORDS = [
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
] as const;
const CODEX_SCHEMA_SINGLE_KEYWORDS = [
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "unevaluatedItems",
  "contentSchema",
] as const;

function codexSchemaPathProperty(path: string, property: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(property)
    ? `${path}.${property}`
    : `${path}[${JSON.stringify(property)}]`;
}

function codexSchemaDiagnosticProperties(properties: readonly string[]): string {
  const maximum = 8;
  const values = properties.slice(0, maximum).map((property) => (
    /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(property)
      ? property
      : JSON.stringify(property.length <= 80 ? property : `${property.slice(0, 77)}...`)
  ));
  return `${values.join(", ")}${properties.length > maximum ? `, +${properties.length - maximum} more` : ""}`;
}

function validateCodexStrictObjectSchema(
  schema: Record<string, unknown>,
  path: string,
): void {
  const type = schema.type;
  const isObjectSchema = type === "object"
    || (Array.isArray(type) && type.includes("object"))
    || Object.hasOwn(schema, "properties");
  if (!isObjectSchema) return;
  if (schema.additionalProperties !== false) {
    throw new SafeStructuredAgentError(
      "output-invalid",
      `Codex final-output schema object at ${path} must set additionalProperties to false`,
    );
  }

  const rawProperties = schema.properties;
  const properties = rawProperties === undefined ? undefined : plainRecord(rawProperties);
  if (rawProperties !== undefined && properties === undefined) {
    throw new SafeStructuredAgentError(
      "output-invalid",
      `Codex final-output schema object at ${path} has a non-object properties declaration`,
    );
  }
  const propertyNames = properties === undefined ? [] : Object.keys(properties);
  const rawRequired = schema.required;
  if (rawRequired === undefined && propertyNames.length === 0) return;
  if (!Array.isArray(rawRequired) || rawRequired.some((value) => typeof value !== "string")) {
    throw new SafeStructuredAgentError(
      "output-invalid",
      `Codex final-output schema object at ${path} must declare required as an array of property names`,
    );
  }

  const requiredNames = rawRequired as string[];
  const requiredSet = new Set(requiredNames);
  const missing = propertyNames.filter((property) => !requiredSet.has(property));
  const unexpected = [...requiredSet].filter((property) => !Object.hasOwn(properties ?? {}, property));
  const duplicate = [...new Set(requiredNames.filter(
    (property, index) => requiredNames.indexOf(property) !== index,
  ))];
  if (missing.length === 0 && unexpected.length === 0 && duplicate.length === 0) return;

  const diagnostic = [
    ...(missing.length === 0 ? [] : [`missing: ${codexSchemaDiagnosticProperties(missing)}`]),
    ...(unexpected.length === 0 ? [] : [`unexpected: ${codexSchemaDiagnosticProperties(unexpected)}`]),
    ...(duplicate.length === 0 ? [] : [`duplicate: ${codexSchemaDiagnosticProperties(duplicate)}`]),
  ].join("; ");
  throw new SafeStructuredAgentError(
    "output-invalid",
    `Codex final-output schema object at ${path} must list every property exactly once in required (${diagnostic})`,
  );
}

function validateCodexStrictSchemaNode(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): void {
  if (typeof value === "boolean") return;
  const schema = plainRecord(value);
  if (schema === undefined) return;
  if (ancestors.has(schema)) {
    throw new SafeStructuredAgentError(
      "output-invalid",
      `Codex final-output schema contains a recursive in-memory reference at ${path}`,
    );
  }

  ancestors.add(schema);
  try {
    validateCodexStrictObjectSchema(schema, path);
    for (const keyword of CODEX_SCHEMA_MAP_KEYWORDS) {
      const entries = plainRecord(schema[keyword]);
      if (entries === undefined) continue;
      for (const [name, child] of Object.entries(entries)) {
        validateCodexStrictSchemaNode(
          child,
          codexSchemaPathProperty(`${path}.${keyword}`, name),
          ancestors,
        );
      }
    }
    for (const keyword of CODEX_SCHEMA_ARRAY_KEYWORDS) {
      const children = schema[keyword];
      if (!Array.isArray(children)) continue;
      children.forEach((child, index) => {
        validateCodexStrictSchemaNode(child, `${path}.${keyword}[${index}]`, ancestors);
      });
    }
    const items = schema.items;
    if (Array.isArray(items)) {
      items.forEach((child, index) => {
        validateCodexStrictSchemaNode(child, `${path}.items[${index}]`, ancestors);
      });
    } else if (items !== undefined) {
      validateCodexStrictSchemaNode(items, `${path}.items`, ancestors);
    }
    const dependencies = plainRecord(schema.dependencies);
    if (dependencies !== undefined) {
      for (const [name, child] of Object.entries(dependencies)) {
        if (Array.isArray(child)) continue;
        validateCodexStrictSchemaNode(
          child,
          codexSchemaPathProperty(`${path}.dependencies`, name),
          ancestors,
        );
      }
    }
    for (const keyword of CODEX_SCHEMA_SINGLE_KEYWORDS) {
      const child = schema[keyword];
      if (child !== undefined) {
        validateCodexStrictSchemaNode(child, `${path}.${keyword}`, ancestors);
      }
    }
  } finally {
    ancestors.delete(schema);
  }
}

function validateCodexStrictOutputSchema(schema: Record<string, unknown>): void {
  try {
    validateCodexStrictSchemaNode(schema, "$", new Set());
  } catch (error) {
    if (error instanceof SafeStructuredAgentError) throw error;
    throw new SafeStructuredAgentError(
      "output-invalid",
      "Codex final-output schema could not be validated locally",
      error,
    );
  }
}

/**
 * Multimodal Claude input requires stream-json output. Treat that transport as
 * a protocol, not as model text: exactly one successful terminal result owns
 * the response and any tool invocation is a hard no-tools contract breach.
 */
export function parseSafeStructuredClaudeStream(stdout: string): string {
  let terminal: Record<string, unknown> | undefined;
  let terminalSeen = false;
  for (const [index, rawLine] of stdout.split("\n").entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      throw new SafeStructuredAgentError(
        "output-invalid",
        `Structured Agent stream line ${index + 1} is not valid JSON`,
      );
    }
    const event = plainRecord(decoded);
    if (!event || typeof event.type !== "string") {
      throw new SafeStructuredAgentError(
        "output-invalid",
        `Structured Agent stream line ${index + 1} is not a protocol event`,
      );
    }
    if (terminalSeen) {
      throw new SafeStructuredAgentError(
        "output-invalid",
        "Structured Agent emitted events after its terminal result",
      );
    }
    if (event.type === "assistant") {
      const message = plainRecord(event.message);
      const content = message?.content;
      if (Array.isArray(content) && content.some((value) => plainRecord(value)?.type === "tool_use")) {
        throw new SafeStructuredAgentError(
          "output-invalid",
          "Structured Agent violated its hard no-tools output contract",
        );
      }
      continue;
    }
    if (event.type !== "result") continue;
    if (terminal !== undefined) {
      throw new SafeStructuredAgentError(
        "output-invalid",
        "Structured Agent emitted more than one terminal result",
      );
    }
    terminal = event;
    terminalSeen = true;
  }
  if (!terminal) {
    throw new SafeStructuredAgentError(
      "output-invalid",
      "Structured Agent stream has no terminal result",
    );
  }
  const result = terminal.result;
  const subtype = terminal.subtype;
  if (terminal.is_error === true || (typeof subtype === "string" && subtype.startsWith("error"))) {
    throw new SafeStructuredAgentError(
      "process-failed",
      "Structured Agent reported an unsuccessful terminal result",
    );
  }
  if (subtype !== "success" || terminal.is_error !== false
    || typeof result !== "string" || result.length === 0 || result.includes("\0")) {
    throw new SafeStructuredAgentError(
      "output-invalid",
      "Structured Agent terminal result is malformed",
    );
  }
  return result;
}

/**
 * Codex `exec --json` is a protocol envelope, not assistant text. Accept one
 * complete turn and return only its final completed Agent message.
 */
export function parseSafeStructuredCodexJsonl(
  stdout: string,
  options: { readonly allowWebSearch?: boolean } = {},
): string {
  let threadStarted = false;
  let turnStarted = false;
  let terminalSeen = false;
  let failedTerminalSeen = false;
  let topLevelErrorSeen = false;
  let message: string | undefined;
  for (const [index, rawLine] of stdout.split("\n").entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      throw new SafeStructuredAgentError(
        "output-invalid",
        `Codex structured stream line ${index + 1} is not valid JSON`,
      );
    }
    const event = plainRecord(decoded);
    if (!event || typeof event.type !== "string") {
      throw new SafeStructuredAgentError(
        "output-invalid",
        `Codex structured stream line ${index + 1} is not a protocol event`,
      );
    }
    if (terminalSeen) {
      throw new SafeStructuredAgentError(
        "output-invalid",
        "Codex structured stream emitted events after its terminal turn",
      );
    }
    if (event.type === "thread.started") {
      if (threadStarted || turnStarted || typeof event.thread_id !== "string"
        || event.thread_id.length === 0 || event.thread_id.includes("\0")) {
        throw new SafeStructuredAgentError(
          "output-invalid",
          "Codex structured stream has a malformed thread start",
        );
      }
      threadStarted = true;
      continue;
    }
    if (event.type === "turn.started") {
      if (!threadStarted || turnStarted) {
        throw new SafeStructuredAgentError(
          "output-invalid",
          "Codex structured stream has a malformed turn start",
        );
      }
      turnStarted = true;
      continue;
    }
    if (event.type === "item.started" || event.type === "item.updated"
      || event.type === "item.completed") {
      const item = plainRecord(event.item);
      if (!item || typeof item.type !== "string") {
        throw new SafeStructuredAgentError(
          "output-invalid",
          `Codex structured stream ${event.type} event is malformed`,
        );
      }
      if (item.type === "error") {
        if (!threadStarted
          || event.type !== "item.completed"
          || typeof item.message !== "string"
          || item.message.length === 0
          || item.message.includes("\0")
          || Buffer.byteLength(item.message, "utf8") > MAX_CODEX_DIAGNOSTIC_BYTES) {
          throw new SafeStructuredAgentError(
            "output-invalid",
            "Codex structured stream contains a malformed completed error diagnostic",
          );
        }
        // Codex uses completed `error` items for bounded, non-terminal client
        // diagnostics (for example, a skill-context budget warning), including
        // diagnostics emitted before `turn.started`. The turn outcome remains
        // authoritative and the diagnostic content is never surfaced.
        continue;
      }
      if (!turnStarted) {
        throw new SafeStructuredAgentError(
          "output-invalid",
          `Codex structured stream ${event.type} event is malformed`,
        );
      }
      if (item.type === "web_search") {
        if (options.allowWebSearch !== true) {
          throw new SafeStructuredAgentError(
            "output-invalid",
            "Codex structured stream emitted Web Search while that capability was not enabled",
          );
        }
        continue;
      }
      if (item.type !== "agent_message" && item.type !== "reasoning") {
        throw new SafeStructuredAgentError(
          "output-invalid",
          `Codex structured stream emitted forbidden item type ${item.type}`,
        );
      }
      if (event.type === "item.completed" && item.type === "agent_message") {
        if (typeof item.text !== "string" || item.text.length === 0 || item.text.includes("\0")) {
          throw new SafeStructuredAgentError(
            "output-invalid",
            "Codex structured stream contains a malformed completed Agent message",
          );
        }
        // Codex may emit intermediate Agent messages during one turn. Its JSONL
        // contract defines the last completed Agent message as the final output.
        message = item.text;
      }
      continue;
    }
    if (event.type === "turn.completed") {
      if (!threadStarted || !turnStarted || message === undefined) {
        if (topLevelErrorSeen && threadStarted && turnStarted) {
          throw new SafeStructuredAgentError(
            "process-failed",
            "Codex structured stream reported an unsuccessful turn",
          );
        }
        throw new SafeStructuredAgentError(
          "output-invalid",
          "Codex structured stream has an incomplete terminal turn",
        );
      }
      terminalSeen = true;
      continue;
    }
    if (event.type === "error") {
      if (!threadStarted
        || !turnStarted
        || typeof event.message !== "string"
        || event.message.length === 0
        || event.message.includes("\0")
        || Buffer.byteLength(event.message, "utf8") > MAX_CODEX_DIAGNOSTIC_BYTES) {
        throw new SafeStructuredAgentError(
          "output-invalid",
          "Codex structured stream contains a malformed top-level error",
        );
      }
      topLevelErrorSeen = true;
      continue;
    }
    if (event.type === "turn.failed") {
      const error = plainRecord(event.error);
      if (!threadStarted || !turnStarted || !error || !boundedCodexDiagnostic(error.message)) {
        throw new SafeStructuredAgentError(
          "output-invalid",
          "Codex structured stream has a malformed failed turn",
        );
      }
      failedTerminalSeen = true;
      terminalSeen = true;
      continue;
    }
    throw new SafeStructuredAgentError(
      "output-invalid",
      `Codex structured stream contains unsupported event ${event.type}`,
    );
  }
  if (failedTerminalSeen) {
    throw new SafeStructuredAgentError(
      "process-failed",
      "Codex structured stream reported an unsuccessful turn",
    );
  }
  if (!terminalSeen || message === undefined) {
    if (topLevelErrorSeen) {
      throw new SafeStructuredAgentError(
        "process-failed",
        "Codex structured stream reported an unsuccessful turn",
      );
    }
    throw new SafeStructuredAgentError(
      "output-invalid",
      "Codex structured stream has no completed terminal turn",
    );
  }
  return message;
}

/**
 * Copilot's `--output-format json` emits JSONL. Treat its result event as the
 * terminal owner and never scrape diagnostic/tool output as a model response.
 */
export function parseSafeStructuredCopilotJsonl(stdout: string): string {
  let message: string | undefined;
  let terminalSeen = false;
  for (const [index, rawLine] of stdout.split("\n").entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      throw new SafeStructuredAgentError(
        "output-invalid",
        `Copilot structured stream line ${index + 1} is not valid JSON`,
      );
    }
    const event = plainRecord(decoded);
    if (!event || typeof event.type !== "string") {
      throw new SafeStructuredAgentError(
        "output-invalid",
        `Copilot structured stream line ${index + 1} is not a protocol event`,
      );
    }
    if (terminalSeen) {
      throw new SafeStructuredAgentError(
        "output-invalid",
        "Copilot structured stream emitted events after its terminal result",
      );
    }
    if (event.type === "session.start" || event.type === "session.started"
      || event.type === "session.tools_updated") {
      if (!plainRecord(event.data)) {
        throw new SafeStructuredAgentError(
          "output-invalid",
          `Copilot structured stream ${event.type} event is malformed`,
        );
      }
      continue;
    }
    if (event.type === "assistant.message") {
      const data = plainRecord(event.data);
      if (message !== undefined || !data || typeof data.content !== "string"
        || data.content.length === 0 || data.content.includes("\0")) {
        throw new SafeStructuredAgentError(
          "output-invalid",
          "Copilot structured stream must contain exactly one Agent message",
        );
      }
      message = data.content;
      continue;
    }
    if (event.type.startsWith("tool.")) {
      throw new SafeStructuredAgentError(
        "output-invalid",
        "Copilot structured planning invoked a tool outside its semantic response contract",
      );
    }
    if (event.type === "result") {
      if (message === undefined || event.exitCode !== 0
        || typeof event.sessionId !== "string" || event.sessionId.length === 0) {
        throw new SafeStructuredAgentError(
          event.exitCode === 0 ? "output-invalid" : "process-failed",
          "Copilot structured stream has a malformed terminal result",
        );
      }
      terminalSeen = true;
      continue;
    }
    throw new SafeStructuredAgentError(
      "output-invalid",
      `Copilot structured stream contains unsupported event ${event.type}`,
    );
  }
  if (!terminalSeen || message === undefined) {
    throw new SafeStructuredAgentError(
      "output-invalid",
      "Copilot structured stream has no completed terminal result",
    );
  }
  return message;
}

function parseSafeStructuredPlainResponse(stdout: string): string {
  const text = stdout.trim();
  if (!text || text.includes("\0")) {
    throw new SafeStructuredAgentError(
      "output-invalid",
      "Generic structured Agent response is malformed",
    );
  }
  return text;
}

interface ValidatedSafeStructuredAgentImage {
  readonly label: string;
  readonly mediaType: SafeStructuredAgentImage["mediaType"];
  readonly bytes: Buffer;
}

function validateSafeStructuredAgentImages(
  images: readonly SafeStructuredAgentImage[],
): readonly ValidatedSafeStructuredAgentImage[] {
  if (images.length === 0) return Object.freeze([]);
  if (images.length > MAX_IMAGE_COUNT) {
    throw new SafeStructuredAgentError("output-invalid", "Structured Agent accepts at most 2 images");
  }
  const validated: ValidatedSafeStructuredAgentImage[] = [];
  let totalImageBytes = 0;
  for (const image of images) {
    if (!image.label || image.label.includes("\0") || Buffer.byteLength(image.label, "utf8") > 256) {
      throw new SafeStructuredAgentError("output-invalid", "Structured Agent image label is invalid");
    }
    if (image.mediaType !== "image/png" && image.mediaType !== "image/jpeg") {
      throw new SafeStructuredAgentError("output-invalid", "Structured Agent image media type is invalid");
    }
    if (!image.data || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) {
      throw new SafeStructuredAgentError("output-invalid", "Structured Agent image payload is invalid");
    }
    let decoded: Buffer;
    try {
      decoded = Buffer.from(image.data, "base64");
    } catch {
      throw new SafeStructuredAgentError("output-invalid", "Structured Agent image payload is invalid");
    }
    if (decoded.length === 0 || decoded.toString("base64") !== image.data) {
      throw new SafeStructuredAgentError("output-invalid", "Structured Agent image payload is invalid");
    }
    if (image.mediaType === "image/png" && (decoded.length < PNG_SIGNATURE.length
      || !decoded.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))) {
      throw new SafeStructuredAgentError("output-invalid", "Structured Agent image has an invalid PNG signature");
    }
    if (image.mediaType === "image/jpeg" && (decoded.length < 5
      || decoded[0] !== 0xff || decoded[1] !== 0xd8 || decoded[2] !== 0xff
      || decoded[decoded.length - 2] !== 0xff || decoded[decoded.length - 1] !== 0xd9)) {
      throw new SafeStructuredAgentError("output-invalid", "Structured Agent image has invalid JPEG magic bytes");
    }
    if (decoded.length > MAX_IMAGE_BYTES) {
      throw new SafeStructuredAgentError("output-invalid", "Structured Agent image exceeds the 8 MiB byte limit");
    }
    totalImageBytes += decoded.length;
    if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new SafeStructuredAgentError("output-invalid", "Structured Agent images exceed the 12 MiB total byte limit");
    }
    validated.push(Object.freeze({
      label: image.label,
      mediaType: image.mediaType,
      bytes: decoded,
    }));
  }
  return Object.freeze(validated);
}

function safeStructuredAgentStdin(
  request: SafeStructuredAgentRequest,
  images: readonly ValidatedSafeStructuredAgentImage[],
): string {
  if (images.length === 0) return request.message;
  const content: Array<Record<string, unknown>> = [{ type: "text", text: request.message }];
  for (const image of images) {
    content.push(
      { type: "text", text: `Image evidence: ${image.label}` },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: image.mediaType,
          data: image.bytes.toString("base64"),
        },
      },
    );
  }
  return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
}

function materializeCodexImageEvidence(
  scratch: string,
  images: readonly ValidatedSafeStructuredAgentImage[],
): readonly string[] {
  return Object.freeze(images.map((image, index) => {
    const extension = image.mediaType === "image/png" ? "png" : "jpg";
    const path = join(scratch, `${IMAGE_EVIDENCE_FILENAME_PREFIX}-${index + 1}.${extension}`);
    try {
      writeFileSync(path, image.bytes, { mode: 0o600, flag: "wx" });
    } catch (error) {
      throw new SafeStructuredAgentError(
        "output-invalid",
        "Codex image evidence could not be confined to the per-run scratch directory",
        error,
      );
    }
    return path;
  }));
}

const UPSTREAM_UNAVAILABLE_PATTERN =
  /internal server error|service unavailable|temporarily unavailable|overloaded/i;
const NON_RETRYABLE_REMOTE_FAILURE_PATTERN =
  /bad request|invalid[_ -]?request|unauthorized|forbidden|not found|unprocessable|invalid.{0,32}(?:schema|parameter)|(?:schema|parameter).{0,32}(?:invalid|unsupported)|unsupported.{0,32}(?:feature|model|parameter|schema|tool)|does not support|not supported/i;
const QUOTA_EXHAUSTED_PATTERN =
  /(?:当前)?无可用\s*token\s*额度|token\s*额度(?:已)?(?:耗尽|用尽|不足)|insufficient quota|quota (?:is )?(?:exhausted|depleted)|(?:token|account|usage).{0,32}quota.{0,32}(?:exhausted|depleted|unavailable)|(?:hit|reached|exceeded)(?:\s+\w+){0,3}\s+usage limit|usage limit.{0,80}(?:purchase more credits|try again)/i;
const RATE_LIMITED_PATTERN =
  /too many requests|rate[ -]?limit(?:ed|ing)?/i;

function explicitRemoteHttpStatuses(evidence: readonly string[]): readonly number[] {
  const statuses: number[] = [];
  for (const value of evidence) {
    const located: Array<{ index: number; status: number }> = [];
    const patterns = [
      /\bhttp(?:\/[0-9.]+)?(?:\s+status(?:[_ -]?code)?\s*[:=]?)?\s+([1-5][0-9]{2})\b/gi,
      /\b(?:response\s+)?status(?:[_ -]?code)?\s*[:=]?\s*([1-5][0-9]{2})\b/gi,
      /\b(?:api|remote|request|response|upstream)\s+(?:error|failed)(?:\s+with)?\s*[:=]?\s*([1-5][0-9]{2})\b/gi,
    ];
    for (const pattern of patterns) {
      for (const match of value.matchAll(pattern)) {
        located.push({ index: match.index, status: Number(match[1]) });
      }
    }
    located.sort((left, right) => left.index - right.index);
    statuses.push(...located.map((item) => item.status));
  }
  return Object.freeze(statuses);
}

function classifyRemoteFailureEvidence(
  evidence: readonly string[],
): SafeStructuredAgentFailureDetails | null {
  const statuses = explicitRemoteHttpStatuses(evidence);
  const httpStatus = statuses.at(-1);
  const joined = evidence.join("\n");
  if ((statuses.includes(429) || httpStatus === undefined) && QUOTA_EXHAUSTED_PATTERN.test(joined)) {
    return Object.freeze({
      reasonCode: "quota-exhausted",
      ...(statuses.includes(429) ? { httpStatus: 429 } : {}),
      retryable: false,
    });
  }
  if (httpStatus === 429 || (httpStatus === undefined && RATE_LIMITED_PATTERN.test(joined))) {
    return Object.freeze({
      reasonCode: "rate-limited",
      ...(httpStatus === undefined ? {} : { httpStatus }),
      retryable: true,
    });
  }
  if ((httpStatus !== undefined && httpStatus >= 500)
    || (httpStatus === undefined && UPSTREAM_UNAVAILABLE_PATTERN.test(joined))) {
    return Object.freeze({
      reasonCode: "upstream-unavailable",
      ...(httpStatus === undefined ? {} : { httpStatus }),
      retryable: true,
    });
  }
  if ((httpStatus !== undefined && httpStatus >= 400)
    || (httpStatus === undefined && NON_RETRYABLE_REMOTE_FAILURE_PATTERN.test(joined))) {
    return Object.freeze({
      reasonCode: "request-rejected",
      ...(httpStatus === undefined ? {} : { httpStatus }),
      retryable: false,
    });
  }
  return null;
}

function classifyFailureEvidenceWithTerminalPrecedence(
  evidence: readonly string[],
): SafeStructuredAgentFailureDetails | null {
  return classifyRemoteFailureEvidence(evidence);
}

function boundedCodexDiagnostic(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= MAX_CODEX_DIAGNOSTIC_BYTES;
}

function classifyCodexRemoteFailure(
  stdout: string,
  allowWebSearch: boolean,
): SafeStructuredAgentFailureDetails | null {
  try {
    parseSafeStructuredCodexJsonl(stdout, { allowWebSearch });
    return null;
  } catch (error) {
    if (!(error instanceof SafeStructuredAgentError) || error.code !== "process-failed") {
      return null;
    }
  }
  const evidence: string[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      return null;
    }
    const event = plainRecord(decoded);
    if (!event || typeof event.type !== "string") return null;
    if (event.type === "error") {
      if (boundedCodexDiagnostic(event.message)) evidence.push(event.message);
      continue;
    }
    if (event.type === "turn.failed") {
      const error = plainRecord(event.error);
      return boundedCodexDiagnostic(error?.message)
        ? classifyFailureEvidenceWithTerminalPrecedence([error.message])
        : null;
    }
  }
  return classifyFailureEvidenceWithTerminalPrecedence(evidence);
}

function classifyClaudeCompatibleRemoteFailure(
  stdout: string,
  stderr: string | undefined,
): SafeStructuredAgentFailureDetails | null {
  const terminals: Record<string, unknown>[] = [];
  const diagnosticLines: string[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      diagnosticLines.push(line);
      continue;
    }
    const event = plainRecord(decoded);
    if (event?.type === "result") terminals.push(event);
  }
  if (terminals.some((terminal) => (
    terminal.is_error === false && terminal.subtype === "success"
  ))) return null;
  const failedTerminals = terminals.filter((terminal) => (
    terminal.is_error === true
    || (typeof terminal.subtype === "string" && terminal.subtype.startsWith("error"))
  ));
  if (terminals.length > 0 && failedTerminals.length === 0) return null;
  const evidence = failedTerminals.flatMap((terminal) => [
    ...(Array.isArray(terminal.errors) ? terminal.errors : []),
    terminal.result,
  ]).filter((value): value is string => typeof value === "string");
  if (failedTerminals.length > 0) {
    return classifyFailureEvidenceWithTerminalPrecedence(evidence);
  }
  const diagnosticEvidence = [diagnosticLines.join("\n"), stderr ?? ""];
  return classifyFailureEvidenceWithTerminalPrecedence(diagnosticEvidence);
}

function classifyRemoteFailure(
  providerId: string,
  stdout: string,
  stderr: string | undefined,
  allowWebSearch: boolean,
): SafeStructuredAgentFailureDetails | null {
  return providerId === "codex"
    ? classifyCodexRemoteFailure(stdout, allowWebSearch)
    : classifyClaudeCompatibleRemoteFailure(stdout, stderr);
}

function remoteFailureError(details: SafeStructuredAgentFailureDetails): SafeStructuredAgentError {
  return details.reasonCode === "quota-exhausted"
    ? new SafeStructuredAgentError(
        "quota-exhausted",
        "Structured Agent provider quota is exhausted",
        undefined,
        details,
      )
    : new SafeStructuredAgentError(
        "process-failed",
        "Structured Agent remote request failed",
        undefined,
        details,
      );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Structured Agent turn aborted", "AbortError");
}

async function waitForRemoteRetry(
  signal: AbortSignal,
  deadlineMs: number,
  attempt: number,
): Promise<void> {
  if (signal.aborted) throw abortReason(signal);
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    throw new SafeStructuredAgentError("timed-out", "Structured Agent exceeded its wall-clock limit");
  }
  const delayMs = Math.min(50 * (2 ** attempt), remainingMs);
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export async function runSafeStructuredAgent(
  request: SafeStructuredAgentRequest,
  options: SafeStructuredAgentOptions = {},
): Promise<SafeStructuredAgentResult> {
  if (request.signal.aborted) throw abortReason(request.signal);
  const provider = getProvider(request.command);
  const canonicalCommand = provider === undefined
    ? false
    : request.command === provider.id || request.command === provider.command;
  if (!provider || !canonicalCommand) {
    throw new SafeStructuredAgentError(
      "provider-unavailable",
      "Structured output accepts only canonical registered provider CLI entries, not executable paths or wrappers",
    );
  }
  const providerId = provider.id;
  if (!request.systemPrompt || !request.message || !Number.isSafeInteger(request.maxOutputBytes)
    || request.maxOutputBytes < 1) {
    throw new SafeStructuredAgentError("output-invalid", "Structured Agent request is invalid");
  }
  if (request.systemPrompt.includes("\0") || Buffer.byteLength(request.systemPrompt, "utf8") > MAX_SYSTEM_PROMPT_BYTES) {
    throw new SafeStructuredAgentError("output-invalid", "Structured Agent system prompt exceeds the 64 KiB byte limit");
  }
  if (request.message.includes("\0") || Buffer.byteLength(request.message, "utf8") > MAX_MESSAGE_BYTES) {
    throw new SafeStructuredAgentError("output-invalid", "Structured Agent message exceeds the 512 KiB byte limit");
  }
  if (request.allowWebSearch !== undefined && typeof request.allowWebSearch !== "boolean") {
    throw new SafeStructuredAgentError("output-invalid", "Structured Agent Web Search capability flag is invalid");
  }
  if (request.remoteRetryMode !== undefined
    && request.remoteRetryMode !== "transport-owned"
    && request.remoteRetryMode !== "caller-owned") {
    throw new SafeStructuredAgentError("output-invalid", "Structured Agent remote retry ownership is invalid");
  }
  if (request.allowWebSearch !== undefined && providerId !== "codex") {
    throw new SafeStructuredAgentError(
      "provider-unavailable",
      `${provider.label} structured planning cannot enable Codex Web Search`,
    );
  }
  const images = validateSafeStructuredAgentImages(request.images ?? []);
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const providerExecutable = providerId === "claude"
    ? (options.resolveClaudeExecutable ?? resolveTrustedClaudeExecutable)()
    : providerId === "codebuddy"
      ? (options.resolveCodeBuddyExecutable ?? resolveTrustedCodeBuddyExecutable)()
      : providerId === "codex"
        ? options.resolveCodexExecutable?.()
          ?? (options.resolveRegisteredExecutable === undefined
            ? resolveTrustedCodexNativeExecutable()
            : options.resolveRegisteredExecutable(provider.command))
      : (options.resolveRegisteredExecutable ?? resolveRegisteredProviderExecutable)(provider.command);
  const environment = safeStructuredAgentEnvironment(request.env, providerId);
  if (providerId !== "claude" && providerId !== "codebuddy" && providerId !== "codex"
    && images.length > 0) {
    throw new SafeStructuredAgentError(
      "provider-unavailable",
      `${provider.label} structured planning does not accept inline image evidence`,
    );
  }
  if (request.outputSchema !== undefined && providerId !== "codex") {
    throw new SafeStructuredAgentError(
      "provider-unavailable",
      `${provider.label} structured planning does not support a final-output schema`,
    );
  }
  if (request.outputSchema !== undefined) {
    const outputSchema = plainRecord(request.outputSchema);
    if (outputSchema === undefined) {
      throw new SafeStructuredAgentError(
        "output-invalid",
        "Codex final-output schema must be a plain JSON object",
      );
    }
    validateCodexStrictOutputSchema(outputSchema);
  }
  let structuredCwd = request.cwd;
  if (providerId !== "claude" && providerId !== "codebuddy") {
    structuredCwd = exactEmptyStructuredScratch(request.cwd);
  }
  const codexImagePaths = providerId === "codex"
    ? materializeCodexImageEvidence(structuredCwd, images)
    : [];
  let outputSchemaPath: string | undefined;
  if (request.outputSchema !== undefined) {
    let serializedSchema: string | undefined;
    try {
      serializedSchema = JSON.stringify(request.outputSchema);
    } catch (error) {
      throw new SafeStructuredAgentError(
        "output-invalid",
        "Codex final-output schema is not JSON-serializable",
        error,
      );
    }
    if (!serializedSchema
      || Buffer.byteLength(serializedSchema, "utf8") > MAX_OUTPUT_SCHEMA_BYTES) {
      throw new SafeStructuredAgentError(
        "output-invalid",
        "Codex final-output schema exceeds the 64 KiB byte limit",
      );
    }
    outputSchemaPath = join(structuredCwd, OUTPUT_SCHEMA_FILENAME);
    try {
      writeFileSync(outputSchemaPath, serializedSchema, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      throw new SafeStructuredAgentError(
        "output-invalid",
        "Codex final-output schema could not be confined to the per-run scratch directory",
        error,
      );
    }
  }
  const genericInvocation = providerId === "claude" || providerId === "codebuddy"
      ? undefined
    : providerId === "codex"
      ? {
          args: safeStructuredCodexArgs(
            request.model,
            outputSchemaPath,
            codexImagePaths,
            request.allowWebSearch === true,
          ),
          stdin: safeStructuredGenericPrompt(request.systemPrompt, request.message, images),
        }
      : safeStructuredGenericInvocation(provider, request);
  const stdin = genericInvocation?.stdin ?? safeStructuredAgentStdin(request, images);
  if (Buffer.byteLength(stdin, "utf8") > MAX_STDIN_BYTES) {
    throw new SafeStructuredAgentError("output-invalid", "Structured Agent stdin exceeds the 16 MiB byte limit");
  }
  const requiresOuterConfinement = providerId !== "claude"
    && providerId !== "codebuddy";
  if (requiresOuterConfinement && (options.platform ?? process.platform) !== "darwin") {
    throw new SafeStructuredAgentError(
      "provider-unavailable",
      "Registered structured Agent outer filesystem confinement requires macOS Seatbelt and is unavailable on this platform",
    );
  }
  const sandboxExecutable = requiresOuterConfinement
    ? (options.resolveSandboxExecutable ?? resolveSeatbeltExecutable)()
    : undefined;
  const sandboxProfile = requiresOuterConfinement
    ? buildSafeStructuredGenericSeatbeltProfile({
        providerId,
        executable: providerExecutable,
        scratch: structuredCwd,
      })
    : undefined;
  if (requiresOuterConfinement) {
    environment.TMPDIR = structuredCwd;
    environment.TMP = structuredCwd;
    environment.TEMP = structuredCwd;
  }
  const command = sandboxExecutable ?? providerExecutable;
  const providerArgs = providerId === "claude"
    ? safeStructuredClaudeArgs(
        request.systemPrompt,
        request.model,
        request.images?.length ? "stream-json" : "text",
      )
    : providerId === "codebuddy"
      ? safeStructuredCodeBuddyArgs(
          request.systemPrompt,
          request.model,
          request.images?.length ? "stream-json" : "text",
        )
      : genericInvocation!.args;
  const args = sandboxProfile === undefined
    ? providerArgs
    : ["-p", sandboxProfile, providerExecutable, ...providerArgs];
  const spawner = (options.createSpawner ?? ((input) => new NodeSpawner(input)))({
    timeoutMs,
    stdoutLimitBytes: request.maxOutputBytes,
    stderrLimitBytes: options.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT_BYTES,
    killDelayMs: 500,
    inheritEnvironment: false,
  });
  const attempts = (providerId === "codebuddy" || providerId === "codex")
      && request.remoteRetryMode !== "caller-owned"
    ? 3
    : 1;
  const deadlineMs = Date.now() + timeoutMs;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const attemptTimeoutMs = attempt === 0 ? timeoutMs : deadlineMs - Date.now();
    if (attemptTimeoutMs <= 0) {
      throw new SafeStructuredAgentError("timed-out", "Structured Agent exceeded its wall-clock limit");
    }
    let result: Awaited<ReturnType<ProcessSpawner["run"]>>;
    try {
      result = await spawner.run({
        command,
        args,
        cwd: structuredCwd,
        stdin,
        timeoutMs: attemptTimeoutMs,
        signal: request.signal,
        env: environment,
      });
    } catch (error) {
      if (request.signal.aborted) throw abortReason(request.signal);
      if (error instanceof AgentOutputLimitError
        || (error && typeof error === "object" && Reflect.get(error, "code") === "AGENT_OUTPUT_LIMIT")) {
        throw new SafeStructuredAgentError("output-limit", "Structured Agent stdout exceeded its byte limit", error);
      }
      if (error instanceof Error && /timed out/i.test(error.message)) {
        throw new SafeStructuredAgentError("timed-out", "Structured Agent exceeded its wall-clock limit", error);
      }
      throw new SafeStructuredAgentError("process-failed", "Structured Agent process failed", error);
    }
    if (request.signal.aborted) throw abortReason(request.signal);
    const remoteFailure = classifyRemoteFailure(
      providerId,
      result.stdout,
      result.stderr,
      request.allowWebSearch === true,
    );
    if (!Number.isSafeInteger(result.exitCode) || result.exitCode !== 0) {
      if (attempt + 1 < attempts && remoteFailure?.retryable === true) {
        await waitForRemoteRetry(request.signal, deadlineMs, attempt);
        continue;
      }
      if (remoteFailure !== null) throw remoteFailureError(remoteFailure);
      throw new SafeStructuredAgentError("process-failed", "Structured Agent process did not exit successfully");
    }
    const bytes = Buffer.byteLength(result.stdout, "utf8");
    if (bytes === 0) {
      throw new SafeStructuredAgentError("output-invalid", "Structured Agent returned an empty response");
    }
    if (bytes > request.maxOutputBytes) {
      throw new SafeStructuredAgentError("output-limit", "Structured Agent stdout exceeded its byte limit");
    }
    try {
      const text = providerId === "codex"
        ? parseSafeStructuredCodexJsonl(result.stdout, {
            allowWebSearch: request.allowWebSearch === true,
          })
        : providerId === "copilot"
          ? parseSafeStructuredCopilotJsonl(result.stdout)
        : providerId === "codebuddy" || request.images?.length
          ? parseSafeStructuredClaudeStream(result.stdout)
          : providerId === "claude"
            ? result.stdout
            : parseSafeStructuredPlainResponse(result.stdout);
      return Object.freeze({ providerId, text });
    } catch (error) {
      if (request.signal.aborted) throw abortReason(request.signal);
      if (attempt + 1 < attempts && remoteFailure?.retryable === true) {
        await waitForRemoteRetry(request.signal, deadlineMs, attempt);
        continue;
      }
      if (remoteFailure !== null) throw remoteFailureError(remoteFailure);
      throw error;
    }
  }
  throw new SafeStructuredAgentError("process-failed", "Structured Agent retry budget was exhausted");
}
