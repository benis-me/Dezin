/**
 * A Dezin design system = the 9-section brand prose (DESIGN.md) + the verbatim
 * token block agents paste into artifacts + which craft rules apply.
 */

export interface DesignSystemCraft {
  /** craft section slugs always injected for this brand, e.g. ["typography","color","anti-ai-slop"]. */
  applies: string[];
  /** craft sections suggested but not forced. */
  suggested?: string[];
  /** craft sections this brand opts out of. */
  exemptions?: string[];
}

export interface DesignSystem {
  id: string;
  name: string;
  category: string;
  /** One-line summary for the picker. */
  summary: string;
  /** The 9-section brand prose the agent reads as authoritative. */
  designMd: string;
  /** The `:root` (+ theme) custom-property block; agents paste this verbatim. */
  tokensCss: string;
  craft: DesignSystemCraft;
}
