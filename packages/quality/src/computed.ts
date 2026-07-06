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
import { chromaSpread, compositeOver, contrastRatio, parseColor, relativeLuminance, rgbToHsl } from "./color.ts";
import { letterSpacingToEm } from "./css.ts";

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

/** Adjacent heading levels closer than this size ratio read as a flat hierarchy. */
export const MIN_TYPE_SCALE_RATIO = 1.2;
/** Reading measure ceiling; ~0.5×font-size approximates one `ch`. */
export const MAX_LINE_LENGTH_CH = 80;
export const CH_PER_FONT_PX = 0.5;
/** Monotonous spacing: one value covering ≥ dominance share of ≥ sample vertical spacings. */
export const MONOTONOUS_DOMINANCE = 0.85;
export const MONOTONOUS_MIN_SAMPLES = 12;
/** Cream/sand page background: light, warm-hued, and tinted (not pure white, not saturated). */
export const CREAM_MIN_L = 0.85;
export const CREAM_MIN_S = 0.08;
export const CREAM_MAX_S = 0.6;
export const CREAM_MIN_H = 30;
export const CREAM_MAX_H = 100;
/** Saturated violet/purple display text — the hue band + saturation floor of the AI palette tell. */
export const PURPLE_MIN_H = 255;
export const PURPLE_MAX_H = 320;
export const PURPLE_MIN_S = 0.25;
/** Display letter-spacing floor (em); tighter than this and glyphs touch. */
export const TRACKING_FLOOR_EM = -0.05;
/** dark-glow: a dark surface (luminance below) wearing a chromatic shadow with a big blur. */
export const DARK_BG_LUM = 0.15;
export const GLOW_CHROMA = 40;
export const GLOW_BLUR_PX = 12;

/** Design-system color drift: only chromatic colors count, and a token match is within this RGB distance. */
export const DRIFT_MIN_CHROMA = 24;
export const DRIFT_MATCH_DISTANCE = 16;

/** Generic font keywords that are never "drift" — they're the fallback tail of any stack. */
const GENERIC_FONTS = new Set([
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "system-ui",
  "sans-serif",
  "serif",
  "monospace",
  "-apple-system",
  "blinkmacsystemfont",
  "cursive",
  "fantasy",
  "math",
  "emoji",
  "inherit",
  "initial",
  "unset",
]);

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
  /** Card-like box (has a visible border or box-shadow) — for the nested-card check. Eval-computed. */
  cardLike?: boolean;
  /** Contains an <svg>/icon descendant — for the icon-tile-above-heading check. Eval-computed. */
  hasIconChild?: boolean;
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
  /** The page's computed background (body, else html) — for the cream/sand-surface check. */
  pageBackground?: string;
  /** The page's own declared design tokens (font families + resolved palette colors), read from
   *  :root — for drift detection: a rendered font/color outside the declared set is drift. */
  designTokens?: { fonts: string[]; colors: Array<{ r: number; g: number; b: number }> };
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

/** line-length — running text set wider than the reading-measure ceiling. */
function checkLineLength(el: ComputedElement): Finding[] {
  if (!isTextBearing(el) || el.text.trim().length < 80) return [];
  if (/^h[1-6]$/.test(el.tag)) return []; // headings legitimately span wide
  const fs = el.style.fontSizePx;
  if (fs === undefined || fs > 24) return [];
  const ch = el.rect.width / (fs * CH_PER_FONT_PX);
  if (ch <= MAX_LINE_LENGTH_CH) return [];
  return [
    {
      severity: "P2",
      id: "line-length",
      message: `${el.selector} runs ~${Math.round(ch)}ch wide — past the ~${MAX_LINE_LENGTH_CH}ch comfort ceiling for reading.`,
      fix: "Cap the measure with max-width (~65–75ch / ~40rem) on running text.",
      selector: el.selector,
    },
  ];
}

/** ai-purple-text — saturated violet/purple on display type: the textbook AI palette tell. */
function checkAiPurpleText(el: ComputedElement): Finding[] {
  if (!isTextBearing(el)) return [];
  const fs = el.style.fontSizePx;
  const isDisplay = /^h[1-3]$/.test(el.tag) || (fs !== undefined && fs >= 20);
  if (!isDisplay) return [];
  const c = parseColor(el.style.color);
  if (!c || c.a < 0.5) return [];
  const { h, s } = rgbToHsl(c);
  if (h >= PURPLE_MIN_H && h <= PURPLE_MAX_H && s >= PURPLE_MIN_S) {
    return [
      {
        severity: "P1",
        id: "ai-purple-text",
        message: `Display text in ${el.selector} is saturated violet/purple (hue ~${Math.round(h)}) — the textbook AI palette tell.`,
        fix: "Bind the design system's foreground/accent tokens; reserve one deliberate accent instead of violet display type.",
        selector: el.selector,
      },
    ];
  }
  return [];
}

/** extreme-negative-tracking — display letter-spacing so tight glyphs touch. */
function checkExtremeNegativeTracking(el: ComputedElement): Finding[] {
  if (!isTextBearing(el)) return [];
  const fs = el.style.fontSizePx;
  const isDisplay = /^h[1-3]$/.test(el.tag) || (fs !== undefined && fs >= 24);
  if (!isDisplay || !el.style.letterSpacing) return [];
  const { em } = letterSpacingToEm(el.style.letterSpacing, fs ?? null);
  if (em === null || em >= TRACKING_FLOOR_EM) return [];
  return [
    {
      severity: "P2",
      id: "extreme-negative-tracking",
      message: `${el.selector} sets letter-spacing ${em.toFixed(3)}em — tighter than the ${TRACKING_FLOOR_EM}em floor; glyphs start to touch.`,
      fix: "Ease display tracking to no tighter than -0.04em.",
      selector: el.selector,
    },
  ];
}

/** Largest blur radius (px) declared in a box-shadow string (the 3rd length of each layer). */
function shadowBlurPx(shadow: string): number {
  const noColor = shadow.replace(/rgba?\([^)]+\)|#[0-9a-f]+/gi, " ");
  const nums = (noColor.match(/-?\d*\.?\d+px/g) ?? []).map((s) => Math.abs(parseFloat(s)));
  return nums.length >= 3 ? nums[2]! : 0;
}

/** dark-glow — a chromatic neon glow on a dark surface. */
function checkDarkGlow(el: ComputedElement): Finding[] {
  const bg = parseColor(el.style.backgroundColor);
  if (!bg || bg.a < 1 || relativeLuminance(bg) > DARK_BG_LUM) return [];
  const shadow = el.style.boxShadow;
  if (!shadow || shadow === "none") return [];
  const colorMatch = /rgba?\([^)]+\)/.exec(shadow);
  const sc = colorMatch ? parseColor(colorMatch[0]) : null;
  if (!sc || sc.a === 0 || chromaSpread(sc) < GLOW_CHROMA) return [];
  const blur = shadowBlurPx(shadow);
  if (blur < GLOW_BLUR_PX) return [];
  return [
    {
      severity: "P2",
      id: "dark-glow",
      message: `${el.selector} wears a chromatic neon glow (~${Math.round(blur)}px blur) on a dark surface — a stock AI flourish.`,
      fix: "Replace the colored glow with a hairline border or a restrained neutral shadow.",
      selector: el.selector,
    },
  ];
}

/** flat-type-hierarchy — adjacent heading levels too close in size to establish rank. */
function checkFlatTypeHierarchy(elements: ComputedElement[]): Finding[] {
  const sizeByLevel = new Map<number, number>();
  for (const el of elements) {
    const m = /^h([1-6])$/.exec(el.tag);
    if (!m || !isTextBearing(el)) continue;
    const fs = el.style.fontSizePx;
    if (fs === undefined) continue;
    const level = parseInt(m[1]!, 10);
    sizeByLevel.set(level, Math.max(sizeByLevel.get(level) ?? 0, fs));
  }
  const levels = [...sizeByLevel.keys()].sort((a, b) => a - b);
  for (let i = 0; i + 1 < levels.length; i++) {
    const a = sizeByLevel.get(levels[i]!)!;
    const b = sizeByLevel.get(levels[i + 1]!)!;
    const bigger = Math.max(a, b);
    const smaller = Math.min(a, b);
    if (smaller > 0 && bigger / smaller < MIN_TYPE_SCALE_RATIO) {
      return [
        {
          severity: "P2",
          id: "flat-type-hierarchy",
          message: `h${levels[i]} and h${levels[i + 1]} are nearly the same size (${bigger}px vs ${smaller}px) — the type hierarchy reads flat.`,
          fix: "Open the scale: give each level a clear step (≥1.25×), or drop an unused level.",
        },
      ];
    }
  }
  return [];
}

/** monotonous-spacing — one vertical spacing value dominates, so the layout has no rhythm. */
function checkMonotonousSpacing(elements: ComputedElement[]): Finding[] {
  const values: number[] = [];
  for (const el of elements) {
    for (const v of [el.style.paddingTopPx, el.style.paddingBottomPx, el.style.marginTopPx, el.style.marginBottomPx]) {
      if (typeof v === "number" && v > 0) values.push(Math.round(v));
    }
  }
  if (values.length < MONOTONOUS_MIN_SAMPLES) return [];
  const freq = new Map<number, number>();
  for (const v of values) freq.set(v, (freq.get(v) ?? 0) + 1);
  const top = Math.max(...freq.values());
  if (top / values.length < MONOTONOUS_DOMINANCE) return [];
  return [
    {
      severity: "P2",
      id: "monotonous-spacing",
      message: `One spacing value covers ${Math.round((100 * top) / values.length)}% of the vertical spacing — the layout has little rhythm.`,
      fix: "Vary spacing on a scale (e.g. 16 / 24 / 40 / 64) so grouping and emphasis read.",
    },
  ];
}

/** cream-palette — the warm cream/sand page surface that reads as the 2026 AI default. */
function checkCreamPalette(_elements: ComputedElement[], ctx: ComputedContext): Finding[] {
  const bg = parseColor(ctx.pageBackground);
  if (!bg || bg.a < 1) return [];
  const { h, s, l } = rgbToHsl(bg);
  if (l > CREAM_MIN_L && s >= CREAM_MIN_S && s <= CREAM_MAX_S && h >= CREAM_MIN_H && h <= CREAM_MAX_H) {
    return [
      {
        severity: "P2",
        id: "cream-palette",
        message: `The page background is a warm cream/sand (hsl ~${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%) — the saturated AI default for "tasteful" surfaces.`,
        fix: "Use a true off-white (chroma 0), a committed brand color, or a clearly brand-owned tinted neutral instead.",
      },
    ];
  }
  return [];
}

function rectArea(r: ComputedRect): number {
  return r.width * r.height;
}

/** inner sits within outer (2px slack for sub-pixel rounding). */
function rectContains(outer: ComputedRect, inner: ComputedRect): boolean {
  return (
    inner.x >= outer.x - 2 &&
    inner.y >= outer.y - 2 &&
    inner.x + inner.width <= outer.x + outer.width + 2 &&
    inner.y + inner.height <= outer.y + outer.height + 2
  );
}

function horizontallyOverlaps(a: ComputedRect, b: ComputedRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width;
}

/** nested-cards — a card-like box contained inside a larger card-like box. */
function checkNestedCards(elements: ComputedElement[]): Finding[] {
  const cards = elements.filter((e) => e.style.cardLike && e.rect.width >= 80 && e.rect.height >= 40);
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const inner of cards) {
    for (const outer of cards) {
      if (outer === inner) continue;
      if (rectArea(outer.rect) > rectArea(inner.rect) * 1.2 && rectContains(outer.rect, inner.rect)) {
        if (!seen.has(inner.selector)) {
          seen.add(inner.selector);
          out.push({
            severity: "P2",
            id: "nested-cards",
            message: `${inner.selector} is a card nested inside another card — nested cards are the lazy answer.`,
            fix: "Flatten it: drop the outer card's chrome (border/shadow/background) and let one surface carry the group.",
            selector: inner.selector,
          });
        }
        break;
      }
    }
  }
  return out;
}

/** icon-tile-stack — a small rounded icon tile stacked directly above a heading. */
function checkIconTileStack(elements: ComputedElement[]): Finding[] {
  const headings = elements.filter((e) => /^h[1-6]$/.test(e.tag));
  const out: Finding[] = [];
  for (const el of elements) {
    if (!el.style.hasIconChild) continue;
    const { width: w, height: h } = el.rect;
    if (w < 32 || w > 128 || h < 32 || h > 128) continue;
    const aspect = w / h;
    if (aspect < 0.7 || aspect > 1.4) continue;
    if ((parseFloat(el.style.borderRadius ?? "0") || 0) <= 0) continue;
    const tileBottom = el.rect.y + h;
    const below = headings.find((hd) => hd.rect.y >= tileBottom - 6 && hd.rect.y <= tileBottom + 32 && horizontallyOverlaps(el.rect, hd.rect));
    if (below) {
      out.push({
        severity: "P2",
        id: "icon-tile-stack",
        message: `${el.selector} is a rounded icon tile stacked above a heading — the universal AI feature-card template.`,
        fix: "Drop the tile: set the icon inline with the heading, or remove the boxed background entirely.",
        selector: el.selector,
      });
    }
  }
  return out;
}

/** The first family in a font stack, unquoted and lowercased. */
function primaryFamily(fontFamily: string): string {
  return (fontFamily.split(",")[0] ?? "").replace(/["']/g, "").trim().toLowerCase();
}

/** design-system-font — a rendered typeface outside the page's own declared --font-* families. */
function checkDesignSystemFont(el: ComputedElement, ctx: ComputedContext): Finding[] {
  const tokens = ctx.designTokens;
  if (!tokens || !isTextBearing(el) || !el.style.fontFamily) return [];
  const fam = primaryFamily(el.style.fontFamily);
  if (!fam || GENERIC_FONTS.has(fam) || tokens.fonts.includes(fam)) return [];
  return [
    {
      severity: "P2",
      id: "design-system-font",
      message: `${el.selector} uses "${fam}" — not one of the design system's declared font families.`,
      fix: `Bind a declared token family (${tokens.fonts.join(", ") || "the --font-* tokens"}); don't introduce a new typeface.`,
      selector: el.selector,
    },
  ];
}

function colorDistance(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

/** design-system-color — a chromatic rendered color that matches no palette token. */
function checkDesignSystemColor(el: ComputedElement, ctx: ComputedContext): Finding[] {
  const tokens = ctx.designTokens;
  if (!tokens || tokens.colors.length === 0 || !isTextBearing(el)) return [];
  const c = parseColor(el.style.color);
  if (!c || c.a < 1 || chromaSpread(c) < DRIFT_MIN_CHROMA) return []; // neutrals aren't palette colors
  const nearest = Math.min(...tokens.colors.map((t) => colorDistance(c, t)));
  if (nearest <= DRIFT_MATCH_DISTANCE) return [];
  return [
    {
      severity: "P2",
      id: "design-system-color",
      message: `${el.selector} uses a chromatic color that matches no palette token (nearest is ~${Math.round(nearest)} off in RGB).`,
      fix: "Bind a palette token (--accent / --fg / --success…) instead of hardcoding a new hue.",
      selector: el.selector,
    },
  ];
}

/** Per-element checks, each pure: (element) -> findings. */
const ELEMENT_CHECKS: ReadonlyArray<(el: ComputedElement, ctx: ComputedContext) => Finding[]> = [
  checkTinyText,
  checkLowContrast,
  checkGrayOnColor,
  checkTightLeading,
  checkLineLength,
  checkAiPurpleText,
  checkExtremeNegativeTracking,
  checkDarkGlow,
  checkDesignSystemFont,
  checkDesignSystemColor,
];

/** Whole-document checks that need every element at once (outline order, repetition). */
const DOCUMENT_CHECKS: ReadonlyArray<(els: ComputedElement[], ctx: ComputedContext) => Finding[]> = [
  checkSkippedHeading,
  checkFlatTypeHierarchy,
  checkMonotonousSpacing,
  checkCreamPalette,
  checkNestedCards,
  checkIconTileStack,
];

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
