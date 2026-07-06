/**
 * Types for the `research/` project convention. See docs/DESIGN-PROCESS.md.
 * Research for design is image + text: a synthesized report plus locally-stored
 * reference imagery, with machine-readable provenance for every claim and asset.
 */

/** What a source is, for provenance and for how the agent should treat it. */
export type SourceKind = "competitor" | "inspiration" | "article" | "data" | "asset";

/** One entry in research/sources.json — a source and what was learned from it. */
export interface ResearchSource {
  /** Stable kebab id, unique within the run. */
  id: string;
  kind: SourceKind;
  title: string;
  /** Absent for user-provided local material. */
  url?: string;
  /** ISO timestamp when captured. */
  capturedAt?: string;
  /** What this source taught us — never empty. */
  takeaways: string[];
  /** Relative paths under research/, e.g. "assets/stripe-pricing.png". */
  assets: string[];
  /** Provenance quality: primary (official/first-party), secondary (reputable), or unknown. */
  authority?: "primary" | "secondary" | "unknown";
  /** Design platform for visual sources (dribbble/behance/awwwards/mobbin/pinterest/other). */
  platform?: string;
  /** Attributed designer/author, when known. */
  designer?: string;
  /** Whether the site was actually reachable (false = cited but blocked/login-walled). */
  reached?: boolean;
}

/** The distilled design brief (research/brief.md) — intake output. */
export interface ResearchBrief {
  /** One line: the thing to design. */
  what: string;
  audience: string;
  goals: string[];
  tone: string[];
  mustHave: string[];
  mustAvoid: string[];
  /** Local paths / urls the user supplied. */
  references: string[];
  /** The skill selected for this brief. */
  skill?: string;
  /** Prose expansion of the brief, in the user's language. */
  body: string;
}

/** A candidate design direction produced after research (research/directions/<slug>/). */
export interface ResearchDirection {
  slug: string;
  title: string;
  /** The concept in a sentence or two. */
  concept: string;
  /** Information architecture — the sections/screens in order. */
  structure: string[];
  /** The single distinctive move that gives this direction soul. */
  distinctiveMove: string;
  rationale?: string;
  /** Optional lo-fi preview asset, relative path under the direction dir. */
  preview?: string;
}
