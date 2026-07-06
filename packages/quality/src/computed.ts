/**
 * Computed-style detector — the browser-internal half of the quality kernel.
 *
 * Where lint-artifact.ts reads the HTML *source* (string/regex), these checks run
 * over a serializable snapshot of the RENDERED page: each visible element's
 * computed style + geometry, as gathered by the headless-Chrome pass in
 * apps/daemon/src/visual-qa.ts. That is the only way to catch defects that only
 * exist after the cascade resolves — contrast, line-height, type-scale ratios,
 * nested cards, monotonous spacing — which source regex fundamentally cannot see.
 *
 * The checks are PURE functions over the snapshot so they unit-test without a
 * browser: feed a fake ComputedElement[], assert the findings.
 */

import type { Finding } from "./types.ts";

/** Body/readability floor: text below this rendered px is hard to read. */
export const MIN_BODY_FONT_PX = 12;

/** A rendered element's box, in CSS px, relative to the viewport. */
export interface ComputedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The subset of `getComputedStyle` each check needs, resolved to convenient units
 * in the browser (lengths already in px as numbers; colors as the browser's
 * normalized `rgb()/rgba()` strings). Every field is optional so the snapshot can
 * populate only what it cheaply can, and checks defend against missing data.
 */
export interface ComputedStyle {
  color?: string;
  backgroundColor?: string;
  backgroundImage?: string;
  fontSizePx?: number;
  fontFamily?: string;
  fontWeight?: number;
  lineHeightPx?: number | null;
  letterSpacing?: string;
  textTransform?: string;
  borderRadius?: string;
  boxShadow?: string;
  transition?: string;
  animation?: string;
  /** Longhand paddings/margins in px, for spacing-rhythm and cramped-padding checks. */
  paddingTopPx?: number;
  paddingRightPx?: number;
  paddingBottomPx?: number;
  paddingLeftPx?: number;
  marginTopPx?: number;
  marginBottomPx?: number;
}

/** One visible rendered element, distilled for the pure checks. */
export interface ComputedElement {
  selector: string;
  tag: string;
  text: string;
  rect: ComputedRect;
  style: ComputedStyle;
}

/** Optional context that tightens some checks (design-system drift, provider tells). */
export interface ComputedContext {
  /** Provider id that generated this run (e.g. "claude", "codex", "gemini"), for model-fingerprint rules. */
  provider?: string;
}

/** An element carries real, readable copy (not a decorative/empty node). */
function isTextBearing(el: ComputedElement): boolean {
  return el.text.trim().length >= 3;
}

/** tiny-text — body copy rendered below the readability floor. */
function checkTinyText(el: ComputedElement): Finding[] {
  const fs = el.style.fontSizePx;
  if (fs === undefined || fs >= MIN_BODY_FONT_PX) return [];
  if (!isTextBearing(el)) return [];
  return [
    {
      severity: "P2",
      id: "tiny-text",
      message: `Text in ${el.selector} renders at ${fs}px — below the ${MIN_BODY_FONT_PX}px readability floor.`,
      fix: `Raise it to at least ${MIN_BODY_FONT_PX}px (bind a body/caption token); reserve sub-12px only for non-essential microlabels.`,
      selector: el.selector,
    },
  ];
}

/** Per-element checks, each pure: (element) -> findings. */
const ELEMENT_CHECKS: ReadonlyArray<(el: ComputedElement, ctx: ComputedContext) => Finding[]> = [checkTinyText];

/**
 * Run every computed-style check over the rendered snapshot and return the union
 * of findings. Order-stable; de-duplication by (id, selector) is the caller's job.
 */
export function detectComputedFindings(elements: ComputedElement[], ctx: ComputedContext = {}): Finding[] {
  const findings: Finding[] = [];
  for (const el of elements) {
    for (const check of ELEMENT_CHECKS) findings.push(...check(el, ctx));
  }
  return findings;
}
