/**
 * Pick the highest-scoring version from a list of repair-round snapshots. A repair round can REGRESS
 * the quality score (the stall/give-up guard breaks the loop but leaves the working tree on that worse
 * round), so the build must return the best round it produced — not just the last one.
 *
 * Ties resolve to the LATER round: when the final round already ties the best score, `bestVersion`
 * returns it, so the caller can skip a needless git restore. Returns null for an empty list.
 */
export function bestVersion<T extends { score: number }>(versions: readonly T[]): T | null {
  if (!versions.length) return null;
  return versions.reduce((best, v) => (v.score >= best.score ? v : best));
}
