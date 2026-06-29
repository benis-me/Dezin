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
import { parseClaudeStream, parseClaudeLine } from "./claude-stream.ts";

export interface SpawnInput {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  /** Called with each stdout chunk as it arrives (for live streaming). */
  onStdout?: (chunk: string) => void;
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
      // Generation runs in a clean room: Dezin has its own anti-slop quality kernel,
      // so the host's design hooks must not second-guess the agent mid-build. We
      // disable the impeccable design hook (env override it honors) and silence
      // CLAUDE.md auto-discovery so the agent isn't steered by host repo context.
      const env = {
        ...process.env,
        IMPECCABLE_HOOK_DISABLED: "1",
        IMPECCABLE_HOOK_QUIET: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      };
      const child = spawn(input.command, input.args, { cwd: input.cwd, stdio: ["pipe", "pipe", "pipe"], env });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d: string) => {
        stdout += d;
        input.onStdout?.(d);
      });
      child.stderr.on("data", (d: string) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
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

    // One stream-json user turn on stdin (avoids argv length limits for the message).
    const stdin = JSON.stringify({ type: "user", message: { role: "user", content: input.message } }) + "\n";

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
