/**
 * ClaudeCodeRunner — drives the real `claude` CLI as an AgentRunner.
 *
 * The process spawn is isolated behind a ProcessSpawner interface so the runner's
 * argument/stdin assembly + output handling are unit-testable with a fake child
 * process (no `claude` on PATH required). NodeSpawner is the real implementation.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { AgentRunner, AgentTurnInput, AgentTurnResult } from "./types.ts";
import { abortError } from "./types.ts";
import { parseClaudeStream, parseClaudeLine } from "./claude-stream.ts";
import { agentSpawnEnv } from "./providers/cli.ts";
import { assertSuccessfulExit, readArtifactSnapshot, readUpdatedArtifactHtml } from "./runner-utils.ts";
import { BoundedTextBuffer } from "./bounded-text-buffer.ts";
import { terminateOwnedProcessGroup } from "./process-group.ts";

/**
 * A compact transcript of earlier turns, prepended to a turn's message so the agent has the
 * conversation's context (not just the artifact on disk). Bounded to the most recent turns
 * within a char budget so long chats don't blow up the prompt.
 */
export function historyPreamble(history?: { role: string; content: string }[]): string {
  if (!history?.length) return "";
  const picked: string[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0 && used < 8000; i--) {
    const m = history[i]!;
    const who = m.role === "assistant" ? "Assistant" : "You";
    const content = m.content.length > 1500 ? `${m.content.slice(0, 1500)}…` : m.content;
    const line = `${who}: ${content}`;
    picked.unshift(line);
    used += line.length;
  }
  return `## Conversation so far\n\nThis continues an existing conversation. Earlier turns, oldest first:\n\n${picked.join("\n\n")}\n\n--- Current request ---\n\n`;
}

export interface SpawnInput {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  /** Optional wall-clock timeout for this spawned turn. Defaults to NodeSpawner's timeout. */
  timeoutMs?: number;
  /** Called with each stdout chunk as it arrives (for live streaming). */
  onStdout?: (chunk: string) => void;
  /** Abort to terminate the child (a user "Stop"). */
  signal?: AbortSignal;
  /** Extra environment variables for the spawned process. */
  env?: NodeJS.ProcessEnv;
}

export interface SpawnOutput {
  stdout: string;
  stderr?: string;
  exitCode: number;
}

export interface ProcessSpawner {
  run(input: SpawnInput): Promise<SpawnOutput>;
}

export interface NodeSpawnerOptions {
  /** Max wall-clock runtime per process. Default 20 minutes. Set <=0 to disable. */
  timeoutMs?: number;
  /** Delay between SIGTERM and SIGKILL during abort/timeout. Default 2 seconds. */
  killDelayMs?: number;
  /** Hard structured/full stdout ceiling. Default 32 MiB. */
  stdoutLimitBytes?: number;
  /** Retained stderr tail. Default 1 MiB. */
  stderrLimitBytes?: number;
  /**
   * Whether to merge the daemon's ambient environment into the child. Defaults
   * to true for existing coding-agent runs. Security-sensitive transports set
   * this to false and provide an exact, allowlisted SpawnInput.env instead.
   */
  inheritEnvironment?: boolean;
}

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_KILL_DELAY_MS = 2000;
export const AGENT_STDOUT_LIMIT_BYTES = 32 * 1024 * 1024;
export const AGENT_STDERR_LIMIT_BYTES = 1024 * 1024;

export class AgentOutputLimitError extends Error {
  readonly code = "AGENT_OUTPUT_LIMIT";

  constructor(limitBytes: number) {
    super(`Agent stdout exceeded the ${limitBytes}-byte limit`);
    this.name = "AgentOutputLimitError";
  }
}

/** Real spawner backed by node:child_process. */
export class NodeSpawner implements ProcessSpawner {
  private options: NodeSpawnerOptions;

  constructor(options: NodeSpawnerOptions = {}) {
    this.options = options;
  }

  run(input: SpawnInput): Promise<SpawnOutput> {
    return new Promise<SpawnOutput>((resolve, reject) => {
      const env = this.options.inheritEnvironment === false
        ? { ...(input.env ?? {}) }
        : agentSpawnEnv(input.env);
      if (input.signal?.aborted) return reject(abortError());
      const child = spawn(input.command, input.args, {
        cwd: input.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env,
        detached: process.platform !== "win32",
        shell: process.platform === "win32",
      });
      const stdoutLimit = this.options.stdoutLimitBytes ?? AGENT_STDOUT_LIMIT_BYTES;
      const stderr = new BoundedTextBuffer(this.options.stderrLimitBytes ?? AGENT_STDERR_LIMIT_BYTES);
      const stdoutChunks: Buffer[] = [];
      const stdoutDecoder = new StringDecoder("utf8");
      let stdoutBytes = 0;
      let timedOut = false;
      let settled = false;
      let outputLimitError: AgentOutputLimitError | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
      let terminationPromise: Promise<void> | null = null;
      const killChild = (signal: NodeJS.Signals): void => {
        try {
          if (child.pid && process.platform !== "win32") {
            process.kill(-child.pid, signal);
          } else {
            child.kill(signal);
          }
        } catch {
          try {
            child.kill(signal);
          } catch {
            /* process already exited */
          }
        }
      };
      const groupAlive = (): boolean => {
        if (!child.pid || process.platform === "win32") return child.exitCode === null && child.signalCode === null;
        try {
          process.kill(-child.pid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "EPERM";
        }
      };
      const terminate = (): Promise<void> => {
        if (terminationPromise) return terminationPromise;
        terminationPromise = terminateOwnedProcessGroup({
          label: input.command,
          signal: killChild,
          isAlive: groupAlive,
          termGraceMs: this.options.killDelayMs ?? DEFAULT_KILL_DELAY_MS,
          killGraceMs: 1_000,
        });
        void terminationPromise.catch(() => {});
        return terminationPromise;
      };
      const onAbort = (): void => { void terminate(); };
      const cleanup = (): void => {
        input.signal?.removeEventListener("abort", onAbort);
        if (timeoutTimer) clearTimeout(timeoutTimer);
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      const timeoutMs = input.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          void terminate();
        }, timeoutMs);
        timeoutTimer.unref?.();
      }
      child.stdout.on("data", (raw: Buffer | Uint8Array) => {
        if (outputLimitError) return;
        const chunk = Buffer.from(raw);
        stdoutBytes += chunk.length;
        if (stdoutBytes > stdoutLimit) {
          outputLimitError = new AgentOutputLimitError(stdoutLimit);
          void terminate();
          return;
        }
        stdoutChunks.push(chunk);
        const decoded = stdoutDecoder.write(chunk);
        if (decoded) input.onStdout?.(decoded);
      });
      child.stderr.on("data", (raw: Buffer | Uint8Array) => stderr.append(raw));
      child.on("error", (e) => {
        if (settled) return;
        settled = true;
        void (async () => {
          let cleanupError: unknown;
          try {
            await terminationPromise;
          } catch (error) {
            cleanupError = error;
          }
          cleanup();
          reject(cleanupError ?? e);
        })();
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        void (async () => {
          let cleanupError: unknown;
          try {
            await terminationPromise;
          } catch (error) {
            cleanupError = error;
          }
          cleanup();
          if (cleanupError) return reject(cleanupError);
          if (!outputLimitError) {
            const decoded = stdoutDecoder.end();
            if (decoded) input.onStdout?.(decoded);
          }
          if (outputLimitError) return reject(outputLimitError);
          if (timedOut) return reject(new Error(`${input.command} timed out after ${timeoutMs}ms`));
          if (input.signal?.aborted) return reject(abortError());
          const stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8");
          // A signal-terminated provider has no numeric exit code. Treat that
          // as failure; mapping null to zero would turn a sandbox crash into a
          // false successful Agent turn.
          resolve({ stdout, stderr: stderr.toString(), exitCode: code ?? 1 });
        })();
      });
      child.stdin.on("error", () => {}); // ignore EPIPE if the child exits early
      child.stdin.write(input.stdin);
      child.stdin.end();
    });
  }
}

export interface ClaudeCodeRunnerOptions {
  /** CLI command, default "claude". */
  command?: string;
  /** Optional model override (--model). */
  model?: string;
  /** Injected spawner (defaults to NodeSpawner); pass a fake in tests. */
  spawner?: ProcessSpawner;
  /** Canonical artifact file the agent writes, default "index.html". */
  artifactPath?: string;
  /** Require the canonical artifact file to change during the turn. */
  enforceArtifactUpdate?: boolean;
  /** Override provider argv while retaining the stream/event/output runner contract. */
  buildArgs?: (systemPrompt: string) => string[];
}

export class ClaudeCodeRunner implements AgentRunner {
  readonly id = "claude-code";
  /** The CLI command this runner spawns (inspectable for tests/diagnostics). */
  readonly command: string;
  /** The model override, if any. */
  readonly model: string | undefined;
  readonly enforceArtifactUpdate: boolean;
  private opts: ClaudeCodeRunnerOptions;

  constructor(opts: ClaudeCodeRunnerOptions = {}) {
    this.opts = opts;
    this.command = opts.command ?? "claude";
    this.model = opts.model;
    this.enforceArtifactUpdate = opts.enforceArtifactUpdate ?? true;
  }

  buildArgs(systemPrompt: string): string[] {
    if (this.opts.buildArgs) return this.opts.buildArgs(systemPrompt);
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--append-system-prompt",
      systemPrompt,
    ];
    if (this.model) args.push("--model", this.model);
    return args;
  }

  async runTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    const command = this.command;
    const artifactPath = this.opts.artifactPath ?? "index.html";
    const spawner = this.opts.spawner ?? new NodeSpawner();

    // One stream-json user turn on stdin (avoids argv length limits for the message). Prior
    // turns are prepended as context so the agent follows the conversation, not just the file.
    const content = historyPreamble(input.history) + input.message;
    const stdin = JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
    const beforeArtifact = await readArtifactSnapshot(input.projectDir, artifactPath);

    // Buffer stdout into whole lines and surface each as live activity as it streams.
    let buffer = "";
    let droppingOversizedLiveLine = false;
    const liveLineLimitBytes = 1024 * 1024;
    const onStdout = input.onActivity
      ? (chunk: string): void => {
          if (droppingOversizedLiveLine) {
            const newline = chunk.indexOf("\n");
            if (newline < 0) return;
            droppingOversizedLiveLine = false;
            chunk = chunk.slice(newline + 1);
          }
          buffer += chunk;
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            for (const ev of parseClaudeLine(line)) input.onActivity!(ev);
          }
          if (Buffer.byteLength(buffer, "utf8") > liveLineLimitBytes) {
            buffer = "";
            droppingOversizedLiveLine = true;
          }
        }
      : undefined;

    const output = await spawner.run({
      command,
      args: this.buildArgs(input.systemPrompt),
      cwd: input.projectDir,
      stdin,
      onStdout,
      signal: input.signal,
      env: input.env,
    });

    assertSuccessfulExit(command, output);
    const parsed = parseClaudeStream(output.stdout);
    if (parsed.isError) {
      throw new Error(`${command} returned an error result${parsed.result ? `: ${parsed.result}` : ""}`);
    }
    const artifactHtml = await readUpdatedArtifactHtml(input.projectDir, artifactPath, beforeArtifact, command, {
      enforceArtifactUpdate: this.enforceArtifactUpdate,
    });

    return { text: parsed.text, artifactHtml, artifactPath };
  }
}
