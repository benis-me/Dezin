/**
 * Persistent false-positive suppression. The per-run give-up guard stops the loop
 * re-sending a finding within one run; this is the complementary ACROSS-run list —
 * a finding the user has judged a false positive stays suppressed on future runs.
 */

import type { Finding } from "./types.ts";

export interface QualityIgnore {
  /** The rule id to suppress (e.g. "low-contrast"). */
  ruleId: string;
  /** A specific element to scope the suppression to; null/empty = the whole rule. */
  selector?: string | null;
}

/** Drop findings the user has marked as false positives. Pure. */
export function applyIgnores(findings: Finding[], ignores: QualityIgnore[]): Finding[] {
  if (!ignores.length) return findings;
  return findings.filter(
    (f) => !ignores.some((ig) => ig.ruleId === f.id && (ig.selector == null || ig.selector === "" || ig.selector === f.selector)),
  );
}
