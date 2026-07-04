/** Build and parse research/brief.md (frontmatter + prose). Pure. */

import { parseFrontmatter, renderFrontmatter, type FrontmatterValue } from "./frontmatter.ts";
import type { ResearchBrief } from "./types.ts";

function asString(v: FrontmatterValue | undefined, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function asArray(v: FrontmatterValue | undefined): string[] {
  return Array.isArray(v) ? v : typeof v === "string" && v.trim() ? [v.trim()] : [];
}

/** Serialize a brief to markdown with a `---` frontmatter block + prose body. */
export function buildBriefMarkdown(brief: ResearchBrief): string {
  const data: Record<string, FrontmatterValue> = {
    what: brief.what,
    audience: brief.audience,
    goals: brief.goals,
    tone: brief.tone,
    mustHave: brief.mustHave,
    mustAvoid: brief.mustAvoid,
    references: brief.references,
  };
  if (brief.skill) data.skill = brief.skill;
  return `${renderFrontmatter(data)}\n\n${brief.body.trim()}\n`;
}

/** Parse a brief.md back into a ResearchBrief. Missing fields default to empty. */
export function parseBriefMarkdown(markdown: string): ResearchBrief {
  const { data, body } = parseFrontmatter(markdown);
  return {
    what: asString(data.what),
    audience: asString(data.audience),
    goals: asArray(data.goals),
    tone: asArray(data.tone),
    mustHave: asArray(data.mustHave),
    mustAvoid: asArray(data.mustAvoid),
    references: asArray(data.references),
    skill: typeof data.skill === "string" ? data.skill : undefined,
    body,
  };
}
