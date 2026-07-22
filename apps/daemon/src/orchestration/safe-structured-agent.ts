import {
  AgentOutputLimitError,
  NodeSpawner,
  type NodeSpawnerOptions,
  type ProcessSpawner,
} from "../../../../packages/agent/src/index.ts";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
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
const SAFE_REQUEST_ENVIRONMENT_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);
const SAFE_AMBIENT_ENVIRONMENT_KEYS = ["LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "USER"] as const;

export type SafeStructuredAgentErrorCode =
  | "provider-unavailable"
  | "process-failed"
  | "timed-out"
  | "output-limit"
  | "output-invalid";

export class SafeStructuredAgentError extends Error {
  readonly code: SafeStructuredAgentErrorCode;

  constructor(code: SafeStructuredAgentErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "SafeStructuredAgentError";
    this.code = code;
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
  readonly providerId: "claude";
  readonly text: string;
}

export interface SafeStructuredAgentOptions {
  readonly createSpawner?: (options: NodeSpawnerOptions) => ProcessSpawner;
  /** Test seam; production always resolves the official CLI from fixed install roots. */
  readonly resolveClaudeExecutable?: () => string;
  readonly stderrLimitBytes?: number;
}

function safeEnvironmentValue(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_ENVIRONMENT_VALUE_BYTES) {
    throw new SafeStructuredAgentError("output-invalid", `${label} is invalid`);
  }
  return value;
}

function safeClaudeSearchDirectories(): string[] {
  const home = homedir();
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
  for (const directory of safeClaudeSearchDirectories()) {
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

function safeStructuredAgentEnvironment(extra: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: homedir(),
    PATH: safeClaudeSearchDirectories().join(delimiter),
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
    if (!SAFE_REQUEST_ENVIRONMENT_KEYS.has(key)) {
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

/**
 * Claude is currently the only installed coding CLI with a hard, inspectable
 * no-tools mode. Other coding CLIs are deliberately rejected here: a read-only
 * cwd or prompt instruction does not stop them from reading unrelated files or
 * invoking shell/network tools.
 */
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

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Structured Agent turn aborted", "AbortError");
}

export async function runSafeStructuredAgent(
  request: SafeStructuredAgentRequest,
  options: SafeStructuredAgentOptions = {},
): Promise<SafeStructuredAgentResult> {
  if (request.signal.aborted) throw abortReason(request.signal);
  if (request.command !== "claude") {
    throw new SafeStructuredAgentError(
      "provider-unavailable",
      "The hard no-tools structured-output transport accepts only the built-in Claude CLI entry, not executable paths or wrappers",
    );
  }
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
  const command = (options.resolveClaudeExecutable ?? resolveTrustedClaudeExecutable)();
  const environment = safeStructuredAgentEnvironment(request.env);
  const stdin = safeStructuredAgentStdin(request);
  if (Buffer.byteLength(stdin, "utf8") > MAX_STDIN_BYTES) {
    throw new SafeStructuredAgentError("output-invalid", "Structured Agent stdin exceeds the 16 MiB byte limit");
  }
  const spawner = (options.createSpawner ?? ((input) => new NodeSpawner(input)))({
    timeoutMs,
    stdoutLimitBytes: request.maxOutputBytes,
    stderrLimitBytes: options.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT_BYTES,
    killDelayMs: 500,
    inheritEnvironment: false,
  });
  let result: Awaited<ReturnType<ProcessSpawner["run"]>>;
  try {
    result = await spawner.run({
      command,
      args: safeStructuredClaudeArgs(request.systemPrompt, request.model, request.images?.length ? "stream-json" : "text"),
      cwd: request.cwd,
      stdin,
      timeoutMs,
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
  if (!Number.isSafeInteger(result.exitCode) || result.exitCode !== 0) {
    throw new SafeStructuredAgentError("process-failed", "Structured Agent process did not exit successfully");
  }
  const bytes = Buffer.byteLength(result.stdout, "utf8");
  if (bytes === 0) {
    throw new SafeStructuredAgentError("output-invalid", "Structured Agent returned an empty response");
  }
  if (bytes > request.maxOutputBytes) {
    throw new SafeStructuredAgentError("output-limit", "Structured Agent stdout exceeded its byte limit");
  }
  const text = request.images?.length
    ? parseSafeStructuredClaudeStream(result.stdout)
    : result.stdout;
  return Object.freeze({ providerId: "claude", text });
}
