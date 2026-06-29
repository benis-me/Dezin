/**
 * ClaudeCodeRunner — drives the real `claude` CLI as an AgentRunner.
 *
 * The process spawn is isolated behind a ProcessSpawner interface so the runner's
 * argument/stdin assembly + output handling are unit-testable with a fake child
 * process (no `claude` on PATH required). NodeSpawner is the real implementation.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRunner, AgentTurnInput, AgentTurnResult } from "./types.ts";
import { abortError } from "./types.ts";
import { parseClaudeStream, parseClaudeLine } from "./claude-stream.ts";
import { agentSpawnEnv } from "./providers/cli.ts";

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
  /** Called with each stdout chunk as it arrives (for live streaming). */
  onStdout?: (chunk: string) => void;
  /** Abort to terminate the child (a user "Stop"). */
  signal?: AbortSignal;
}

export interface SpawnOutput {
  stdout: string;
  stderr?: string;
  exitCode: number;
}

export interface ProcessSpawner {
  run(input: SpawnInput): Promise<SpawnOutput>;
}

/** Real spawner backed by node:child_process. */
export class NodeSpawner implements ProcessSpawner {
  run(input: SpawnInput): Promise<SpawnOutput> {
    return new Promise<SpawnOutput>((resolve, reject) => {
      const env = agentSpawnEnv();
      if (input.signal?.aborted) return reject(abortError());
      const child = spawn(input.command, input.args, { cwd: input.cwd, stdio: ["pipe", "pipe", "pipe"], env });
      let stdout = "";
      let stderr = "";
      const onAbort = (): void => {
        child.kill("SIGTERM");
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      const cleanup = (): void => input.signal?.removeEventListener("abort", onAbort);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d: string) => {
        stdout += d;
        input.onStdout?.(d);
      });
      child.stderr.on("data", (d: string) => (stderr += d));
      child.on("error", (e) => {
        cleanup();
        reject(e);
      });
      child.on("close", (code) => {
        cleanup();
        if (input.signal?.aborted) return reject(abortError());
        resolve({ stdout, stderr, exitCode: code ?? 0 });
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
}

export class ClaudeCodeRunner implements AgentRunner {
  readonly id = "claude-code";
  /** The CLI command this runner spawns (inspectable for tests/diagnostics). */
  readonly command: string;
  /** The model override, if any. */
  readonly model: string | undefined;
  private opts: ClaudeCodeRunnerOptions;

  constructor(opts: ClaudeCodeRunnerOptions = {}) {
    this.opts = opts;
    this.command = opts.command ?? "claude";
    this.model = opts.model;
  }

  buildArgs(systemPrompt: string): string[] {
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

    // Buffer stdout into whole lines and surface each as live activity as it streams.
    let buffer = "";
    const onStdout = input.onActivity
      ? (chunk: string): void => {
          buffer += chunk;
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            for (const ev of parseClaudeLine(line)) input.onActivity!(ev);
          }
        }
      : undefined;

    const { stdout } = await spawner.run({
      command,
      args: this.buildArgs(input.systemPrompt),
      cwd: input.projectDir,
      stdin,
      onStdout,
      signal: input.signal,
    });

    const parsed = parseClaudeStream(stdout);

    // The artifact is whatever the agent wrote to disk in its cwd.
    let artifactHtml = "";
    try {
      artifactHtml = await readFile(join(input.projectDir, artifactPath), "utf8");
    } catch {
      artifactHtml = ""; // agent wrote nothing (or a different file) — surface empty
    }

    return { text: parsed.text, artifactHtml, artifactPath };
  }
}
