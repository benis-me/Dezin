/**
 * Scoped-variant fan-out — distilled from impeccable's "generate variations, keep one".
 *
 * Dezin already has variants (git worktrees / prototype snapshots) and per-variant runs;
 * the fan-out is the missing orchestration: fork N variants from the current state so the
 * SAME scoped edit can be generated as N independent variations to compare side by side.
 * This module is the PURE planner (count clamping + labels); the handler creates the
 * variants and the web runs the brief into each.
 */

export interface VariantFanoutPlan {
  count: number;
  variants: Array<{ name: string; label: string }>;
}

const LABELS = ["A", "B", "C", "D"];

/** Validate + clamp the requested variation count and name each variation. 2–4 variations. */
export function planVariantFanout(count: number): VariantFanoutPlan {
  const n = Math.max(2, Math.min(LABELS.length, Math.floor(Number(count)) || 3));
  return {
    count: n,
    variants: Array.from({ length: n }, (_, i) => ({ name: `Variation ${LABELS[i]}`, label: LABELS[i]! })),
  };
}
