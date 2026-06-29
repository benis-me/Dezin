/** The artifact shape a skill produces. */
export type SkillMode = "prototype" | "design-system" | "document" | "deck" | "utility";

export interface SkillInfo {
  /** Folder name under content/skills. */
  id: string;
  name: string;
  description: string;
  mode: SkillMode;
  /** craft section slugs to inject, e.g. ["typography","color","anti-ai-slop"]. */
  craft: string[];
  /** Keyword phrases that hint when this skill applies. */
  triggers: string[];
  /** Optional implementation libraries this skill may choose from. */
  libraries: string[];
  /** Whether this skill consumes an active design system (false = it produces one). */
  designSystem: boolean;
  /** The markdown workflow body after the frontmatter fence. */
  body: string;
}
