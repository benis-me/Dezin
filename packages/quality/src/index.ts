/**
 * @dezin/quality — the anti-AI-slop quality kernel.
 *
 * - lintArtifact: deterministic P0/P1/P2 checker (ported + Dezin-tuned).
 * - renderFindingsForAgent: the `<artifact-lint>` self-correction block.
 * - lintAndRepair: the lint→repair closed loop.
 * - slop-rules: the single source of truth (indigo/emoji/gradient/metric lists).
 */

export type { Finding, Severity, LintOptions } from "./types.ts";
export { lintArtifact, hasFindings } from "./lint-artifact.ts";
export {
  detectComputedFindings,
  MIN_BODY_FONT_PX,
  type ComputedElement,
  type ComputedStyle,
  type ComputedRect,
  type ComputedContext,
} from "./computed.ts";
export { lintScore, scoreGrade } from "./score.ts";
export { renderFindingsForAgent } from "./render-findings.ts";
export {
  lintAndRepair,
  type ReviseArtifact,
  type ClosedLoopOptions,
  type ClosedLoopResult,
  type RepairRound,
} from "./closed-loop.ts";
export * as slopRules from "./slop-rules.ts";
