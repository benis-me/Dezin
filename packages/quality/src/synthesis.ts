/**
 * Blind dual-assessment synthesis. The deterministic detector and the independent
 * design-review agent judge the render WITHOUT seeing each other's output (the agent
 * critic is never fed the detector findings). This synthesis step cross-checks them
 * afterwards: an element flagged by BOTH lanes is corroborated — high confidence it's
 * real, not a single-lane false positive. Pure; only annotates, never drops.
 */

import type { Finding } from "./types.ts";

function selectorSet(findings: readonly Finding[]): Set<string> {
  return new Set(findings.map((f) => f.selector).filter((s): s is string => !!s));
}

/** Tag findings whose selector appears in both lanes with `corroborated: true`. */
export function markCorroboration(
  deterministic: Finding[],
  agent: Finding[],
): { deterministic: Finding[]; agent: Finding[] } {
  const det = selectorSet(deterministic);
  const ag = selectorSet(agent);
  const both = new Set([...det].filter((s) => ag.has(s)));
  const tag = (f: Finding): Finding => (f.selector && both.has(f.selector) ? { ...f, corroborated: true } : f);
  return { deterministic: deterministic.map(tag), agent: agent.map(tag) };
}
