/**
 * Small, dependency-free CSS helpers for the linter. These intentionally do NOT
 * build a full CSS AST — the original lint-artifact.ts is deliberately "greppy".
 * We parse just enough to (a) strip global token blocks for the indigo escape
 * hatch and (b) resolve var() tokens across theme scopes for the ALL-CAPS check.
 */

import { GLOBAL_THEME_SELECTOR_RE, ROOT_FONT_PX } from "./slop-rules.ts";

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface CssRule {
  /** Raw selector text (may be a comma list). */
  selector: string;
  /** Individual trimmed selectors. */
  selectors: string[];
  /** Raw declaration block body (between the braces). */
  body: string;
}

/** Iterate top-level `selector { body }` rules. Ignores at-rules' nesting depth crudely. */
export function iterateRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const selector = (m[1] ?? "").trim();
    const body = m[2] ?? "";
    if (!selector || selector.startsWith("@")) continue;
    const selectors = selector.split(",").map((s) => s.trim()).filter(Boolean);
    rules.push({ selector, selectors, body });
  }
  return rules;
}

/** Extract all `<style>...</style>` contents concatenated. */
export function extractStyleBlocks(html: string): string {
  const blocks: string[] = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) blocks.push(m[1] ?? "");
  return blocks.join("\n");
}

/** Parse `--name: value;` custom-property declarations from a rule body. */
export function parseCustomProps(body: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    map.set((m[1] ?? "").toLowerCase(), (m[2] ?? "").trim());
  }
  return map;
}

/** Read a single property's value from a rule body (last wins, like the cascade). */
export function readProp(body: string, prop: string): string | undefined {
  const re = new RegExp(`(?:^|;|\\{)\\s*${escapeRe(prop)}\\s*:\\s*([^;}]+)`, "gi");
  let value: string | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) value = (m[1] ?? "").trim();
  return value;
}

/** True if every selector in the list is a pure global theme scope (:root, html, [data-theme=...]). */
export function isGlobalThemeScope(rule: CssRule): boolean {
  return rule.selectors.length > 0 && rule.selectors.every((s) => GLOBAL_THEME_SELECTOR_RE.test(s));
}

/**
 * Build per-theme custom-property maps. The base scope (:root/html/body) is the
 * default theme; each distinct [data-theme=x] / .dark-style block layered on top
 * becomes an additional named theme that inherits from base.
 */
export function buildResolvedThemes(css: string): Map<string, Map<string, string>> {
  const base = new Map<string, string>();
  const themes = new Map<string, Map<string, string>>();
  for (const rule of iterateRules(css)) {
    const props = parseCustomProps(rule.body);
    if (props.size === 0) continue;
    const isBase = rule.selectors.some((s) => /^(?::root|html|body)$/.test(s));
    if (isBase) {
      for (const [k, v] of props) base.set(k, v);
    } else if (rule.selectors.some((s) => /\[data-theme|\.dark|\[data-mode|\[data-color-scheme/.test(s))) {
      const label = rule.selector;
      const t = themes.get(label) ?? new Map<string, string>();
      for (const [k, v] of props) t.set(k, v);
      themes.set(label, t);
    }
  }
  const resolved = new Map<string, Map<string, string>>();
  resolved.set(":base", base);
  for (const [label, t] of themes) {
    const merged = new Map(base);
    for (const [k, v] of t) merged.set(k, v);
    resolved.set(label, merged);
  }
  return resolved;
}

/** Resolve a value that may be `var(--x)` / `var(--x, fallback)` against a token map. */
export function resolveVar(value: string, tokens: Map<string, string>, depth = 0): string {
  if (depth > 10) return value;
  const m = value.match(/^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]+))?\)$/i);
  if (!m) return value.trim();
  const name = (m[1] ?? "").toLowerCase();
  const fallback = m[2];
  const hit = tokens.get(name);
  if (hit !== undefined) return resolveVar(hit.trim(), tokens, depth + 1);
  if (fallback !== undefined) return resolveVar(fallback.trim(), tokens, depth + 1);
  return value.trim();
}

export interface LengthEm {
  /** Length expressed in em relative to the element's own font-size, or null if unresolvable. */
  em: number | null;
}

/**
 * Convert a letter-spacing value to em, given a resolved font-size (px).
 * Returns { em: null } when the unit needs a font-size we don't have.
 */
export function letterSpacingToEm(raw: string, fontSizePx: number | null): LengthEm {
  const v = raw.trim().toLowerCase();
  if (v === "normal" || v === "0") return { em: 0 };
  const m = v.match(/^(-?\d*\.?\d+)(px|rem|em)$/);
  if (!m) return { em: null };
  const n = parseFloat(m[1] ?? "0");
  const unit = m[2];
  if (unit === "em") return { em: n };
  const px = unit === "rem" ? n * ROOT_FONT_PX : n;
  if (fontSizePx && fontSizePx > 0) return { em: px / fontSizePx };
  // No font-size: 0.06em at the ~16px root ≈ ~0.96px, so treat ≥1px as passing.
  return { em: px >= 1 ? 0.0625 : px / ROOT_FONT_PX };
}

/** Resolve a font-size value to px against a token map. Returns null if unresolvable. */
export function fontSizeToPx(raw: string | undefined, tokens: Map<string, string>): number | null {
  if (!raw) return null;
  const v = resolveVar(raw.trim(), tokens).toLowerCase();
  const m = v.match(/^(-?\d*\.?\d+)(px|rem)$/);
  if (!m) return null;
  const n = parseFloat(m[1] ?? "0");
  return m[2] === "rem" ? n * ROOT_FONT_PX : n;
}
