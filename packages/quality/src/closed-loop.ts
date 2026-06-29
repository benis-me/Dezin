/**
 * The lint → repair closed loop.
 *
 * Computes anti-slop findings after each artifact and feeds the highest-priority
 * (P0) block back as the next turn, so the quality loop actually loops.
 *
 * The loop is transport-agnostic: you provide a `reviseArtifact` callback that
 * takes the `<artifact-lint>` block and returns the agent's revised HTML. In the
 * daemon this wraps a real agent turn; in tests it's a pure function. That keeps
 * the quality kernel free of any process/IO dependency.
 */

import type { Finding, LintOptions, Severity } from "./types.ts";
import { lintArtifact, hasFindings } from "./lint-artifact.ts";
import { renderFindingsForAgent } from "./render-findings.ts";

/** Produce a revised artifact given the `<artifact-lint>` feedback block. */
export type ReviseArtifact = (
  lintBlock: string,
  context: { round: number; previousHtml: string; findings: Finding[] },
) => Promise<string> | string;

export interface ClosedLoopOptions extends LintOptions {
  /** Max repair rounds after the initial lint. Default 2. */
  maxRounds?: number;
  /** Which severities trigger a repair round. Default ["P0"]. */
  blockOn?: readonly Severity[];
}

export interface RepairRound {
  round: number;
  /** Findings that triggered this round. */
  triggeringFindings: Finding[];
  /** HTML produced by the revise callback this round. */
  html: string;
}

export interface ClosedLoopResult {
  /** Final artifact HTML (best available — last revision, or the input if clean). */
  html: string;
  /** Number of repair rounds actually run. */
  rounds: number;
  /** Findings remaining on the final artifact. */
  findings: Finding[];
  /** True if the final artifact has no blocking findings. */
  passed: boolean;
  /** Per-round history for debugging/telemetry. */
  history: RepairRound[];
}

/**
 * Lint `initialHtml`; while it has blocking findings and rounds remain, feed the
 * `<artifact-lint>` block to `reviseArtifact` and re-lint the result.
 */
export async function lintAndRepair(
  initialHtml: string,
  reviseArtifact: ReviseArtifact,
  options: ClosedLoopOptions = {},
): Promise<ClosedLoopResult> {
  const maxRounds = options.maxRounds ?? 2;
  const blockOn = options.blockOn ?? (["P0"] as const);

  let html = initialHtml;
  let findings = lintArtifact(html, options);
  const history: RepairRound[] = [];
  let round = 0;

  while (round < maxRounds && hasFindings(findings, blockOn as readonly string[])) {
    const lintBlock = renderFindingsForAgent(findings);
    if (!lintBlock) break;
    round += 1;
    const revised = await reviseArtifact(lintBlock, {
      round,
      previousHtml: html,
      findings,
    });
    history.push({ round, triggeringFindings: findings, html: revised });
    html = revised;
    findings = lintArtifact(html, options);
  }

  return {
    html,
    rounds: round,
    findings,
    passed: !hasFindings(findings, blockOn as readonly string[]),
    history,
  };
}
