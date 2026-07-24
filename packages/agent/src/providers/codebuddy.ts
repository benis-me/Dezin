import { spawn } from "node:child_process";
import { writeFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ClaudeCodeRunner } from "../claude-runner.ts";
import { abortError } from "../types.ts";
import { terminateOwnedProcessGroup } from "../process-group.ts";
import { runCapture, dedupModels, agentSpawnEnv } from "./cli.ts";
import type {
  AgentProvider,
  AgentReadiness,
  AgentReadinessProbeOptions,
} from "./types.ts";

const CODEBUDDY_READINESS_TIMEOUT_MS = 8_000;
const CODEBUDDY_READINESS_OUTPUT_LIMIT_BYTES = 64 * 1024;
const AUTHENTICATION_REQUIRED_REASON = "Sign in to CodeBuddy, then rescan agents.";
const VERIFICATION_REQUIRED_REASON = "CodeBuddy sign-in couldn't be verified. Rescan agents to try again.";
const VERIFICATION_TIMEOUT_REASON = "CodeBuddy sign-in check timed out. Rescan agents to try again.";
const VERIFICATION_OUTPUT_REASON = "CodeBuddy sign-in check produced invalid output. Rescan agents to try again.";
const HOST_LOGIN_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "USER",
  "SHELL",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "TERM",
  "NO_COLOR",
  "IMPECCABLE_HOOK_DISABLED",
  "IMPECCABLE_HOOK_QUIET",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
] as const;

type JsonRecord = Record<string, unknown>;

function codeBuddyHostLoginEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const source = agentSpawnEnv(extra);
  const environment: NodeJS.ProcessEnv = {};
  for (const key of HOST_LOGIN_ENVIRONMENT_KEYS) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return environment;
}

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null ? value as JsonRecord : null;
}

function exactAuthenticationRequired(message: JsonRecord): boolean {
  const error = record(message.error);
  const data = record(error?.data);
  return error?.code === -32000
    && error.message === "Authentication required"
    && data?.category === "auth";
}

/**
 * CodeBuddy's ACP session handshake validates restored authentication before any prompt can run.
 * This is intentionally narrower than its interactive TUI: no login flow, user-info request,
 * model prompt, tool capability, or persisted session is involved.
 */
export function probeCodeBuddyReadiness(
  command: string,
  options: AgentReadinessProbeOptions = {},
): Promise<AgentReadiness> {
  const timeoutMs = options.timeoutMs ?? CODEBUDDY_READINESS_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve({ status: "verification-required", reason: VERIFICATION_TIMEOUT_REASON });
  }
  if (options.signal?.aborted) return Promise.reject(abortError());

  return new Promise<AgentReadiness>((resolve, reject) => {
    const environment = codeBuddyHostLoginEnvironment({ TERM: "dumb", NO_COLOR: "1" });
    let child;
    try {
      child = spawn(command, ["--acp", "--no-session-persistence"], {
        cwd: options.cwd ?? tmpdir(),
        stdio: ["pipe", "pipe", "pipe"],
        env: environment,
        detached: process.platform !== "win32",
        shell: process.platform === "win32",
        windowsHide: true,
      });
    } catch {
      resolve({ status: "verification-required", reason: VERIFICATION_REQUIRED_REASON });
      return;
    }

    const decoder = new StringDecoder("utf8");
    let buffered = "";
    let seenBytes = 0;
    let settled = false;
    let sessionRequestSent = false;
    let termination: Promise<void> | null = null;

    const signalChild = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // The process already exited.
      }
    };
    const childAlive = (): boolean => {
      if (!child.pid || process.platform === "win32") {
        return child.exitCode === null && child.signalCode === null;
      }
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    };
    const terminate = (): Promise<void> => {
      termination ??= terminateOwnedProcessGroup({
        label: "CodeBuddy readiness probe",
        signal: signalChild,
        isAlive: childAlive,
        termGraceMs: 250,
        killGraceMs: 1_000,
      });
      return termination;
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (result: AgentReadiness, error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void terminate().then(
        () => {
          if (error) reject(error);
          else resolve(result);
        },
        reject,
      );
    };
    const failClosed = (reason = VERIFICATION_REQUIRED_REASON): void => {
      finish({ status: "verification-required", reason });
    };
    const onAbort = (): void => {
      finish({ status: "verification-required", reason: VERIFICATION_REQUIRED_REASON }, abortError());
    };
    const timer = setTimeout(() => failClosed(VERIFICATION_TIMEOUT_REASON), timeoutMs);
    timer.unref?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const writeMessage = (message: JsonRecord): boolean => {
      if (settled || child.stdin.destroyed) return false;
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
        return true;
      } catch {
        failClosed();
        return false;
      }
    };
    const handleMessage = (message: JsonRecord): void => {
      if (message.id === 1) {
        if (message.error !== undefined || record(message.result) === null || sessionRequestSent) {
          failClosed();
          return;
        }
        sessionRequestSent = writeMessage({
          jsonrpc: "2.0",
          id: 2,
          method: "session/new",
          params: {
            cwd: options.cwd ?? tmpdir(),
            mcpServers: [],
          },
        });
        return;
      }
      if (message.id !== 2) return;
      if (exactAuthenticationRequired(message)) {
        finish({ status: "authentication-required", reason: AUTHENTICATION_REQUIRED_REASON });
        return;
      }
      const result = record(message.result);
      if (message.error === undefined && typeof result?.sessionId === "string" && result.sessionId.length > 0) {
        finish({ status: "ready" });
        return;
      }
      failClosed();
    };
    const handleLine = (line: string): void => {
      if (!line.trim() || settled) return;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      const message = record(value);
      if (message) handleMessage(message);
    };
    const appendOutput = (raw: Buffer | Uint8Array): void => {
      if (settled) return;
      const chunk = Buffer.from(raw);
      seenBytes += chunk.length;
      if (seenBytes > CODEBUDDY_READINESS_OUTPUT_LIMIT_BYTES) {
        failClosed(VERIFICATION_OUTPUT_REASON);
        return;
      }
      buffered += decoder.write(chunk);
      let newline: number;
      while (!settled && (newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        handleLine(line);
      }
    };

    child.stdout.on("data", appendOutput);
    child.stderr.on("data", (raw: Buffer | Uint8Array) => {
      if (settled) return;
      seenBytes += Buffer.byteLength(raw);
      if (seenBytes > CODEBUDDY_READINESS_OUTPUT_LIMIT_BYTES) failClosed(VERIFICATION_OUTPUT_REASON);
    });
    child.stdin.on("error", () => {
      if (!settled) failClosed();
    });
    child.on("error", () => {
      if (!settled) failClosed();
    });
    child.on("close", () => {
      if (settled) return;
      const tail = decoder.end();
      if (tail) buffered += tail;
      if (buffered) handleLine(buffered);
      if (!settled) failClosed();
    });

    writeMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: {
            readTextFile: false,
            writeTextFile: false,
          },
          terminal: false,
        },
        clientInfo: {
          name: "dezin-readiness-probe",
          version: "1",
        },
      },
    });
  });
}

/** Older/region builds list models in `--help` ("Currently supported: (id, …)"). */
async function modelsFromHelp(command: string, signal?: AbortSignal): Promise<string[]> {
  for (const args of [["--help"], ["-p", "--help"]]) {
    const r = await runCapture(command, args, 4000, signal);
    const m = r && /Currently supported:\s*\(([^)]+)\)/i.exec(r.out);
    if (m && m[1]) {
      const ids = dedupModels(m[1].split(",").map((s) => s.trim()));
      if (ids.length) return ids;
    }
  }
  return [];
}

// Current CodeBuddy (2.109+) hides its account model list behind the interactive
// `/model list` TUI — no headless flag exposes it. The only way to read it is to drive a
// real PTY: shell out to `expect` in a throwaway dir, dismiss the trust prompt, type
// `/model list`, and scrape the rendered screen. (Adapted from the vibeos provider scanner.)
// Slow (~35s: session boot + render), so it only runs on an explicit rescan.
const EXPECT_SCRIPT = (bin: string, dir: string): string => `
set stty_init "rows 70 columns 220"
log_user 1
cd ${dir}
spawn ${bin}
set timeout 8
expect { timeout {} eof {} }
send "\\r"
set timeout 6
expect { timeout {} eof {} }
send "/model list"
set timeout 3
expect { timeout {} eof {} }
send "\\r"
set timeout 8
expect { timeout {} eof {} }
send "\\r"
set timeout 6
expect { timeout {} eof {} }
send "\\003"
set timeout 2
expect { timeout {} eof {} }
exit 0
`;

/** Pull model ids out of the de-ANSI'd `/model list` screen. Entries carry the id in
 *  parens; UI words like (escape)/(light) lack a version digit, so a digit is required. */
function parseModelScreen(raw: string): string[] {
  const text = raw
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "") // CSI escapes
    .replace(/\x1b\][^\x07]*\x07/g, "") // OSC sequences
    .replace(/\x1b[()][AB0]/g, "") // charset selects
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0e-\x1f]/g, "");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/\(([a-z0-9][a-z0-9._-]*)\)/gi)) {
    const id = m[1]!.trim();
    if (/\d/.test(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

async function scrapeModelList(
  command: string,
  timeoutMs = 55_000,
  signal?: AbortSignal,
): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "dezin-cb-models-"));
  const scriptPath = join(dir, "scrape.exp");
  await writeFile(scriptPath, EXPECT_SCRIPT(command, dir));
  try {
    const out = (await runCapture("expect", [scriptPath], timeoutMs, signal))?.out ?? "";
    // The trust prompt echoes the working-dir name in parens; drop it.
    const dirName = dir.split(/[\\/]/).pop() ?? "";
    return dedupModels(parseModelScreen(out)).filter((id) => id !== dirName);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** CodeBuddy — a Claude-Code fork (reuses ClaudeCodeRunner). Models come from `--help` when
 *  it lists them; otherwise, on an explicit rescan, from a PTY scrape of `/model list`. */
export const codebuddyProvider: AgentProvider = {
  id: "codebuddy",
  command: "codebuddy",
  label: "CodeBuddy",
  seedModels: ["claude-opus-4.8", "claude-sonnet-4.6", "claude-haiku-4.5"],
  fastModel: "claude-haiku-4.5",
  async discoverModels(command, deep, signal) {
    const fromHelp = await modelsFromHelp(command, signal);
    if (fromHelp.length) return fromHelp;
    if (deep) return scrapeModelList(command, 55_000, signal);
    return [];
  },
  probeReadiness: probeCodeBuddyReadiness,
  createRunner: ({ command, model, enforceArtifactUpdate, spawner, buildArgs }) =>
    new ClaudeCodeRunner({ command, model, enforceArtifactUpdate, spawner, buildArgs }),
  oneShotArgs: (model, prompt) => ["-p", prompt, "--permission-mode", "bypassPermissions", ...(model ? ["--model", model] : [])],
};
