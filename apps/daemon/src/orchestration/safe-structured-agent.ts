import {
  AgentOutputLimitError,
  getProvider,
  NodeSpawner,
  type AgentProvider,
  type NodeSpawnerOptions,
  type ProcessSpawner,
} from "../../../../packages/agent/src/index.ts";
import { accessSync, constants, readdirSync, realpathSync, statSync } from "node:fs";
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
const MAX_STDIN_BYTES = 16 * 1024 * 1024;
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
  readonly systemPrompt: string;
  readonly message: string;
  /** Inline image evidence delivered through Claude's stream-json user content. */
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

function assertEmptyStructuredScratch(cwd: string): void {
  try {
    const exact = realpathSync(cwd);
    if (!statSync(exact).isDirectory() || readdirSync(exact).length !== 0) {
      throw new Error("not an empty directory");
    }
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
  return [
    "(version 1)",
    "(allow default)",
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
  const environment: NodeJS.ProcessEnv = {
    HOME: homedir(),
    PATH: safeRegisteredSearchDirectories().join(delimiter),
    TMPDIR: tmpdir(),
    TERM: "dumb",
    NO_COLOR: "1",
    IMPECCABLE_HOOK_DISABLED: "1",
    IMPECCABLE_HOOK_QUIET: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DEZIN_DAEMON_TOKEN: undefined,
  };
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

export function safeStructuredCodexArgs(model?: string): string[] {
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
    ...(model ? ["--model", model] : []),
    "-",
  ];
}

function safeStructuredGenericPrompt(systemPrompt: string, message: string): string {
  return [
    systemPrompt,
    "--- DEZIN STRUCTURED REQUEST ---",
    message,
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
 * complete turn and return only its single completed Agent message.
 */
export function parseSafeStructuredCodexJsonl(stdout: string): string {
  let threadStarted = false;
  let turnStarted = false;
  let terminalSeen = false;
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
      if (!turnStarted || !item || typeof item.type !== "string") {
        throw new SafeStructuredAgentError(
          "output-invalid",
          `Codex structured stream ${event.type} event is malformed`,
        );
      }
      if (event.type === "item.completed" && item.type === "agent_message") {
        if (message !== undefined || typeof item.text !== "string"
          || item.text.length === 0 || item.text.includes("\0")) {
          throw new SafeStructuredAgentError(
            "output-invalid",
            "Codex structured stream must contain exactly one completed Agent message",
          );
        }
        message = item.text;
      }
      continue;
    }
    if (event.type === "turn.completed") {
      if (!threadStarted || !turnStarted || message === undefined) {
        throw new SafeStructuredAgentError(
          "output-invalid",
          "Codex structured stream has an incomplete terminal turn",
        );
      }
      terminalSeen = true;
      continue;
    }
    if (event.type === "turn.failed" || event.type === "error") {
      throw new SafeStructuredAgentError(
        "process-failed",
        "Codex structured stream reported an unsuccessful turn",
      );
    }
    throw new SafeStructuredAgentError(
      "output-invalid",
      `Codex structured stream contains unsupported event ${event.type}`,
    );
  }
  if (!terminalSeen || message === undefined) {
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

function safeStructuredAgentStdin(request: SafeStructuredAgentRequest): string {
  const images = request.images ?? [];
  if (images.length === 0) return request.message;
  if (images.length > MAX_IMAGE_COUNT) {
    throw new SafeStructuredAgentError("output-invalid", "Structured Agent accepts at most 2 images");
  }
  const content: Array<Record<string, unknown>> = [{ type: "text", text: request.message }];
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
    content.push(
      { type: "text", text: `Image evidence: ${image.label}` },
      {
        type: "image",
        source: { type: "base64", media_type: image.mediaType, data: image.data },
      },
    );
  }
  return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
}

const UPSTREAM_UNAVAILABLE_PATTERN =
  /\b(?:500|502|503|504)\b|internal server error|service unavailable|temporarily unavailable|overloaded/i;
const NON_RETRYABLE_REMOTE_FAILURE_PATTERN =
  /\b(?:400|401|402|403|404|405|406|407|408|409|410|411|412|413|414|415|416|417|418|421|422|423|424|425|426|428|431|451)\b|bad request|unauthorized|forbidden|not found|unprocessable/i;
const QUOTA_EXHAUSTED_PATTERN =
  /(?:当前)?无可用\s*token\s*额度|token\s*额度(?:已)?(?:耗尽|用尽|不足)|insufficient quota|quota (?:is )?(?:exhausted|depleted)|(?:token|account|usage).{0,32}quota.{0,32}(?:exhausted|depleted|unavailable)/i;
const RATE_LIMITED_PATTERN =
  /\b429\b|too many requests|rate[ -]?limit(?:ed|ing)?/i;

function remoteHttpStatus(evidence: readonly string[]): number | undefined {
  for (const value of evidence) {
    const match = /\b(429|500|502|503|504)\b/.exec(value);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function classifyRemoteFailureEvidence(
  evidence: readonly string[],
): SafeStructuredAgentFailureDetails | null {
  const httpStatus = remoteHttpStatus(evidence);
  const hasRateLimitStatus = evidence.some((value) => /\b429\b/.test(value));
  const joined = evidence.join("\n");
  if (hasRateLimitStatus && QUOTA_EXHAUSTED_PATTERN.test(joined)) {
    return Object.freeze({
      reasonCode: "quota-exhausted",
      httpStatus: 429,
      retryable: false,
    });
  }
  if (hasRateLimitStatus || RATE_LIMITED_PATTERN.test(joined)) {
    return Object.freeze({
      reasonCode: "rate-limited",
      ...(hasRateLimitStatus ? { httpStatus: 429 } : httpStatus === undefined ? {} : { httpStatus }),
      retryable: true,
    });
  }
  if (UPSTREAM_UNAVAILABLE_PATTERN.test(joined)) {
    return Object.freeze({
      reasonCode: "upstream-unavailable",
      ...(httpStatus === undefined ? {} : { httpStatus }),
      retryable: true,
    });
  }
  return null;
}

function classifyRemoteFailure(
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
  const classified = classifyRemoteFailureEvidence(evidence);
  if (classified?.reasonCode === "quota-exhausted") return classified;
  if (evidence.some((value) => (
    NON_RETRYABLE_REMOTE_FAILURE_PATTERN.test(value)
  ))) return null;
  if (failedTerminals.length > 0) return classified;
  const diagnosticEvidence = [diagnosticLines.join("\n"), stderr ?? ""];
  const diagnosticClassification = classifyRemoteFailureEvidence(diagnosticEvidence);
  if (diagnosticClassification?.reasonCode === "quota-exhausted") return diagnosticClassification;
  if (diagnosticEvidence.some((value) => NON_RETRYABLE_REMOTE_FAILURE_PATTERN.test(value))) return null;
  return diagnosticClassification;
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

async function waitForCodeBuddyRetry(
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
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const providerExecutable = providerId === "claude"
    ? (options.resolveClaudeExecutable ?? resolveTrustedClaudeExecutable)()
    : providerId === "codebuddy"
      ? (options.resolveCodeBuddyExecutable ?? resolveTrustedCodeBuddyExecutable)()
      : (options.resolveRegisteredExecutable ?? resolveRegisteredProviderExecutable)(provider.command);
  const environment = safeStructuredAgentEnvironment(request.env, providerId);
  if (providerId !== "claude" && providerId !== "codebuddy"
    && (request.images?.length ?? 0) > 0) {
    throw new SafeStructuredAgentError(
      "provider-unavailable",
      `${provider.label} structured planning does not accept inline image evidence`,
    );
  }
  if (providerId !== "claude" && providerId !== "codebuddy") {
    assertEmptyStructuredScratch(request.cwd);
  }
  const genericInvocation = providerId === "claude" || providerId === "codebuddy"
    ? undefined
    : providerId === "codex"
      ? {
          args: safeStructuredCodexArgs(request.model),
          stdin: safeStructuredGenericPrompt(request.systemPrompt, request.message),
        }
      : safeStructuredGenericInvocation(provider, request);
  const stdin = genericInvocation?.stdin ?? safeStructuredAgentStdin(request);
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
        scratch: request.cwd,
      })
    : undefined;
  if (requiresOuterConfinement) {
    environment.TMPDIR = request.cwd;
    environment.TMP = request.cwd;
    environment.TEMP = request.cwd;
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
  const attempts = providerId === "codebuddy" ? 3 : 1;
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
        cwd: request.cwd,
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
    const remoteFailure = classifyRemoteFailure(result.stdout, result.stderr);
    if (!Number.isSafeInteger(result.exitCode) || result.exitCode !== 0) {
      if (attempt + 1 < attempts && remoteFailure?.retryable === true) {
        await waitForCodeBuddyRetry(request.signal, deadlineMs, attempt);
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
        ? parseSafeStructuredCodexJsonl(result.stdout)
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
        await waitForCodeBuddyRetry(request.signal, deadlineMs, attempt);
        continue;
      }
      if (remoteFailure !== null) throw remoteFailureError(remoteFailure);
      throw error;
    }
  }
  throw new SafeStructuredAgentError("process-failed", "Structured Agent retry budget was exhausted");
}
