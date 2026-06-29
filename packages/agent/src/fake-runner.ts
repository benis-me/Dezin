/**
 * A deterministic runner for tests and offline development. It returns a queued
 * sequence of artifacts (one per turn), so you can simulate "sloppy first draft,
 * then a clean repair" and exercise the whole generation + closed-loop path with
 * no `claude` CLI, no network, no filesystem.
 */

import type { AgentRunner, AgentTurnInput, AgentTurnResult } from "./types.ts";

export interface FakeRunnerOptions {
  /** Artifacts returned in order, one per runTurn() call. The last one repeats. */
  artifacts: string[];
  /** Optional narration per turn. */
  texts?: string[];
}

export class FakeRunner implements AgentRunner {
  readonly id = "fake";
  private artifacts: string[];
  private texts: string[];
  private call = 0;
  /** Every input this runner received — handy for asserting the loop fed back the lint block. */
  readonly calls: AgentTurnInput[] = [];

  constructor(opts: FakeRunnerOptions) {
    if (opts.artifacts.length === 0) throw new Error("FakeRunner needs at least one artifact");
    this.artifacts = opts.artifacts;
    this.texts = opts.texts ?? [];
  }

  runTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    this.calls.push(input);
    const i = Math.min(this.call, this.artifacts.length - 1);
    this.call += 1;
    return Promise.resolve({
      text: this.texts[i] ?? `turn ${this.call}`,
      artifactHtml: this.artifacts[i]!,
      artifactPath: "index.html",
    });
  }
}
