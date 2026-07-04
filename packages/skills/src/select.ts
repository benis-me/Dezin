/**
 * Deterministic skill selection from a brief. This seeds — and is the fallback for —
 * the agent's own choice during the intake phase. Skills are no longer forced at the
 * composer; the brief routes itself. See docs/DESIGN-PROCESS.md.
 */

import type { SkillInfo } from "./types.ts";

export interface RankedSkill {
  skill: SkillInfo;
  score: number;
}

const STOP = new Set([
  "the", "a", "an", "for", "of", "and", "to", "with", "my", "our", "your", "in", "on",
  "page", "site", "app", "me", "please", "build", "make", "design", "create",
]);

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => !STOP.has(t));
}

/**
 * Score how well a skill fits a brief. Multi-word trigger phrases are the strongest
 * signal; name/id and description overlap add light weight.
 */
export function scoreSkill(brief: string, skill: SkillInfo): number {
  const text = brief.toLowerCase();
  const briefTokens = new Set(tokens(brief));
  let score = 0;

  for (const trigger of skill.triggers) {
    const phrase = trigger.toLowerCase().trim();
    if (phrase && text.includes(phrase)) score += 8 * phrase.split(/\s+/).length;
  }
  for (const token of new Set([...tokens(skill.name), ...tokens(skill.id.replace(/-/g, " "))])) {
    if (briefTokens.has(token)) score += 3;
  }
  let descHits = 0;
  for (const token of new Set(tokens(skill.description))) {
    if (briefTokens.has(token)) descHits += 1;
  }
  score += Math.min(descHits, 3);
  return score;
}

/** Rank skills by fit, strongest first; ties break by id for stability. */
export function rankSkills(brief: string, skills: SkillInfo[]): RankedSkill[] {
  return skills
    .map((skill) => ({ skill, score: scoreSkill(brief, skill) }))
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));
}

/** The best-fitting skill, or null when nothing in the catalog matches the brief. */
export function selectSkill(brief: string, skills: SkillInfo[]): SkillInfo | null {
  const [top] = rankSkills(brief, skills);
  return top && top.score > 0 ? top.skill : null;
}
