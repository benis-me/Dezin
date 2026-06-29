/**
 * Turn lint findings into a single 0–100 quality score — the measurable half of
 * the anti-slop kernel. Dezin both enforces (the closed loop) and quantifies
 * (this), so quality is a number you can regress on.
 */

import type { Finding } from "./types.ts";

/** Penalty weights per severity. P0s dominate; P2s are a nudge. */
const WEIGHT: Record<string, number> = { P0: 25, P1: 8, P2: 3 };

/** 0–100, where 100 is clean. Each finding subtracts its severity weight. */
export function lintScore(findings: readonly Finding[]): number {
  const penalty = findings.reduce((sum, f) => sum + (WEIGHT[f.severity] ?? 0), 0);
  return Math.max(0, Math.min(100, Math.round(100 - penalty)));
}

/** A letter grade for display. */
export function scoreGrade(score: number): "A" | "B" | "C" | "D" | "F" {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}
