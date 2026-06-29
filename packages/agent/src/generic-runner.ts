/**
 * GenericCliRunner — drives non-Claude coding-agent CLIs (codex, gemini,
 * cursor-agent, aider, opencode, …) as an AgentRunner.
 *
 * Every coding agent shares the same contract Dezin needs: given a system prompt
 * and a message, edit files in the cwd. Only the invocation differs. This runner
 * captures that: it spawns `<command> <args(prompt)>` in the project dir, lets the
 * agent write the artifact to disk, then reads it back — exactly like
 * ClaudeCodeRunner, minus the Claude-specific stream-json parsing. The assistant
 * text is a trimmed tail of stdout (no fine-grained tool activity, since these
 * CLIs don't emit a structured stream Dezin understands).
 *
 * Most of these CLIs have no `--append-system-prompt`, so the system prompt is
 * prepended to the message. Invocations are best-effort per each CLI's documented
 * headless/non-interactive flags; the spawn is injectable so they stay testable.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRunner, AgentTurnInput, AgentTurnResult } from "./types.ts";
import { NodeSpawner, type ProcessSpawner } from "./claude-runner.ts";

export interface GenericAgentConfig {
  /** Build the full argv given the optional model and the combined prompt. */
  buildArgs: (model: string | undefined, prompt: string) => string[];
  /** Deliver the prompt on stdin instead of argv (buildArgs then receives ""). */
  viaStdin?: boolean;
}

// Per-CLI invocations now live with their providers (src/providers/*.ts); the back-compat
// GENERIC_AGENTS map is derived there from the registry.

export interface GenericCliRunnerOptions {
  id?: string;
  command: string;
  model?: string;
  config: GenericAgentConfig;
  spawner?: ProcessSpawner;
  artifactPath?: string;
}

export class GenericCliRunner implements AgentRunner {
  readonly id: string;
  readonly command: string;
  readonly model: string | undefined;
  private opts: GenericCliRunnerOptions;

  constructor(opts: GenericCliRunnerOptions) {
    this.opts = opts;
    this.id = opts.id ?? opts.command;
    this.command = opts.command;
    this.model = opts.model;
  }

  /** The argv this runner spawns for a given combined prompt (inspectable for tests). */
  buildArgs(prompt: string): string[] {
    return this.opts.config.buildArgs(this.model, this.opts.config.viaStdin ? "" : prompt);
  }

  async runTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    const artifactPath = this.opts.artifactPath ?? "index.html";
    const spawner = this.opts.spawner ?? new NodeSpawner();
    const prompt = `${input.systemPrompt}\n\n--- TASK ---\n\n${input.message}`;
    input.onActivity?.({ kind: "tool", name: this.command, summary: `Generating with ${this.command}…` });

    const { stdout } = await spawner.run({
      command: this.command,
      args: this.buildArgs(prompt),
      cwd: input.projectDir,
      stdin: this.opts.config.viaStdin ? prompt : "",
    });

    let artifactHtml = "";
    try {
      artifactHtml = await readFile(join(input.projectDir, artifactPath), "utf8");
    } catch {
      artifactHtml = "";
    }

    // No structured stream — surface a trimmed tail of stdout as the assistant text.
    const text = stdout.trim().split("\n").slice(-12).join("\n").slice(0, 2000);
    return { text, artifactHtml, artifactPath };
  }
}
