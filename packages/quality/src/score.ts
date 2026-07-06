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

export interface ScoreTrend {
  latest: number | null;
  previous: number | null;
  delta: number | null;
  direction: "up" | "down" | "flat" | "none";
  average: number | null;
  count: number;
}

/** Summarize a project's recent quality scores (MOST-RECENT FIRST) into a trend. */
export function scoreTrend(scores: readonly number[]): ScoreTrend {
  const count = scores.length;
  if (count === 0) return { latest: null, previous: null, delta: null, direction: "none", average: null, count: 0 };
  const latest = scores[0]!;
  const previous = count > 1 ? scores[1]! : null;
  const delta = previous === null ? null : latest - previous;
  const direction = delta === null ? "none" : delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const average = Math.round(scores.reduce((s, n) => s + n, 0) / count);
  return { latest, previous, delta, direction, average, count };
}
