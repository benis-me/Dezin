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
import { chromaSpread, compositeOver, contrastRatio, parseColor } from "./color.ts";

/** Body/readability floor: text below this rendered px is hard to read. */
export const MIN_BODY_FONT_PX = 12;

/** WCAG AA contrast floors: 4.5:1 for normal text, 3:1 for large text. */
export const AA_NORMAL_CONTRAST = 4.5;
export const AA_LARGE_CONTRAST = 3;
/** Below this, text is effectively invisible — escalate the contrast defect to P0. */
export const CONTRAST_INVISIBLE = 2;
/** "Large text" per WCAG: ≥24px, or ≥18.66px when bold (≥700). */
export const LARGE_TEXT_PX = 24;
export const LARGE_BOLD_TEXT_PX = 18.66;
export const BOLD_WEIGHT = 700;
/** Channel-spread thresholds separating neutral gray text from a chromatic surface. */
export const GRAY_MAX_SPREAD = 12;
export const CHROMATIC_MIN_SPREAD = 40;
/** Body copy needs line-height ≥ this ratio; display type above LEADING_DISPLAY_PX is exempt. */
export const MIN_LINE_HEIGHT_RATIO = 1.3;
export const LEADING_DISPLAY_PX = 28;

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
  /** Nearest OPAQUE painted backdrop, resolved by walking ancestors in the browser; the color a
   *  contrast check must judge against. Omitted/translucent when unresolvable (e.g. over an image). */
  effectiveBg?: string;
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

/** WCAG "large text": bigger type clears contrast at a lower ratio. */
function isLargeText(fontSizePx: number, fontWeight: number | undefined): boolean {
  if (fontSizePx >= LARGE_TEXT_PX) return true;
  return fontSizePx >= LARGE_BOLD_TEXT_PX && (fontWeight ?? 400) >= BOLD_WEIGHT;
}

/** low-contrast — text failing the WCAG AA ratio against its resolved opaque backdrop. */
function checkLowContrast(el: ComputedElement): Finding[] {
  if (!isTextBearing(el)) return [];
  const fs = el.style.fontSizePx;
  if (fs === undefined) return [];
  const rawFg = parseColor(el.style.color);
  const bg = parseColor(el.style.effectiveBg);
  // No parseable colors, or no opaque backdrop to judge against → not provable, don't file.
  if (!rawFg || !bg || bg.a < 1) return [];
  const fg = rawFg.a < 1 ? compositeOver(rawFg, bg) : rawFg;
  const ratio = contrastRatio(fg, bg);
  const required = isLargeText(fs, el.style.fontWeight) ? AA_LARGE_CONTRAST : AA_NORMAL_CONTRAST;
  if (ratio >= required) return [];
  const severity = ratio < CONTRAST_INVISIBLE ? "P0" : "P1";
  return [
    {
      severity,
      id: "low-contrast",
      message: `Text in ${el.selector} has ~${ratio.toFixed(1)}:1 contrast against its background — below the WCAG AA ${required}:1 floor.`,
      fix: `Darken the text or lighten the surface to reach at least ${required}:1 (bind the design system's foreground / muted tokens).`,
      selector: el.selector,
    },
  ];
}

/** gray-on-color — neutral gray text on a chromatic surface reads muddy. */
function checkGrayOnColor(el: ComputedElement): Finding[] {
  if (!isTextBearing(el)) return [];
  const fg = parseColor(el.style.color);
  const bg = parseColor(el.style.effectiveBg);
  if (!fg || !bg || bg.a < 1) return [];
  if (chromaSpread(fg) > GRAY_MAX_SPREAD) return []; // text isn't gray
  if (chromaSpread(bg) < CHROMATIC_MIN_SPREAD) return []; // surface isn't chromatic
  return [
    {
      severity: "P2",
      id: "gray-on-color",
      message: `Gray text in ${el.selector} sits on a chromatic surface — it reads washed-out.`,
      fix: "Use a darker or lighter shade of the surface's own hue, or a transparency of the text color, instead of neutral gray.",
      selector: el.selector,
    },
  ];
}

/** tight-leading — body copy with cramped line-height (display type is exempt). */
function checkTightLeading(el: ComputedElement): Finding[] {
  if (!isTextBearing(el) || el.text.trim().length <= 40) return [];
  const fs = el.style.fontSizePx;
  const lh = el.style.lineHeightPx;
  if (fs === undefined || fs > LEADING_DISPLAY_PX) return [];
  if (lh === undefined || lh === null) return []; // `normal` is browser-dependent; don't guess
  const ratio = lh / fs;
  if (ratio >= MIN_LINE_HEIGHT_RATIO) return [];
  return [
    {
      severity: "P2",
      id: "tight-leading",
      message: `Body copy in ${el.selector} has line-height ${ratio.toFixed(2)} — below the ${MIN_LINE_HEIGHT_RATIO} minimum for comfortable reading.`,
      fix: "Raise line-height to ~1.4–1.6 for running text.",
      selector: el.selector,
    },
  ];
}

/** skipped-heading — the heading outline jumps a level (h1 → h3). Document-level. */
function checkSkippedHeading(elements: ComputedElement[]): Finding[] {
  let prev = 0;
  for (const el of elements) {
    const m = /^h([1-6])$/.exec(el.tag);
    if (!m) continue;
    const level = parseInt(m[1]!, 10);
    if (prev && level - prev > 1) {
      return [
        {
          severity: "P2",
          id: "skipped-heading",
          message: `Heading outline jumps from h${prev} to h${level} (${el.selector}) — a level was skipped.`,
          fix: `Use sequential levels (an h${prev + 1} before h${level}); change the size with CSS, not the tag.`,
          selector: el.selector,
        },
      ];
    }
    prev = level;
  }
  return [];
}

/** Per-element checks, each pure: (element) -> findings. */
const ELEMENT_CHECKS: ReadonlyArray<(el: ComputedElement, ctx: ComputedContext) => Finding[]> = [
  checkTinyText,
  checkLowContrast,
  checkGrayOnColor,
  checkTightLeading,
];

/** Whole-document checks that need every element at once (outline order, repetition). */
const DOCUMENT_CHECKS: ReadonlyArray<(els: ComputedElement[], ctx: ComputedContext) => Finding[]> = [checkSkippedHeading];

/**
 * Run every computed-style check over the rendered snapshot and return the union
 * of findings. Order-stable; de-duplication by (id, selector) is the caller's job.
 */
export function detectComputedFindings(elements: ComputedElement[], ctx: ComputedContext = {}): Finding[] {
  const findings: Finding[] = [];
  for (const el of elements) {
    for (const check of ELEMENT_CHECKS) findings.push(...check(el, ctx));
  }
  for (const check of DOCUMENT_CHECKS) findings.push(...check(elements, ctx));
  return findings;
}
