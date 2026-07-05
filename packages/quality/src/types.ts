/**
 * Shared types for the Dezin quality kernel.
 */

export type Severity = "P0" | "P1" | "P2";

export interface Finding {
  /** Severity tier. P0 = must-fix regression, P1 = should-fix, P2 = nice-to-fix. */
  severity: Severity;
  /** Stable rule id, e.g. "ai-default-indigo". */
  id: string;
  /** Human/agent-facing description of what's wrong. */
  message: string;
  /** Concrete instruction on how to fix it. */
  fix: string;
  /** Optional offending source excerpt. */
  snippet?: string;
  /** Optional CSS selector the finding targets — for precise, checkable repair instructions. */
  selector?: string;
}

export interface LintOptions {
  /** Artifact runtime mode. Prototype checks assume a single sandboxed HTML file; standard checks scan source files. */
  mode?: "prototype" | "standard";
  /** Treat the artifact as a slide deck (enables deck-only checks). Default false. */
  isDeck?: boolean;
  /**
   * Max allowed `var(--accent)` uses in the rendered body before flagging
   * accent-overuse. Defaults to 3 (neutral-grayscale taste).
   */
  accentOveruseCap?: number;
  /**
   * Border-radius (px) above which a non-pill radius is flagged as oversized.
   * Default 28 (cards/menus shouldn't exceed this; pills 999/50% are exempt).
   */
  maxRadiusPx?: number;
  /**
   * Extra hex values to hard-ban as a solid accent (e.g. a strict grayscale
   * project that forbids any chroma). Matched like AI_DEFAULT_INDIGO.
   */
  bannedAccentHexes?: string[];
  /** Disable the Dezin-specific extensions (shadow-card, gradient-text, oversized-radius). */
  disableDezinRules?: boolean;
}
