/**
 * Dezin anti-AI-slop artifact linter.
 *
 * A deterministic, deliberately "greppy" checker tuned to Dezin's neutral-grayscale,
 * borders-over-shadows taste. Findings are {severity, id, message, fix, snippet}.
 *
 * Severity tiers:
 *   P0 — must-fix regression (the seven cardinal sins + Dezin extensions)
 *   P1 — should-fix
 *   P2 — nice-to-fix
 */

import type { Finding, LintOptions } from "./types.ts";
import {
  AI_DEFAULT_INDIGO,
  PURPLE_HEXES,
  TRUST_GRADIENT_BLUE_HEXES,
  TRUST_GRADIENT_CYAN_HEXES,
  SLOP_EMOJI,
  INVENTED_METRIC_PATTERNS,
  FILLER_PATTERNS,
  EXTERNAL_IMAGE_HOSTS,
  DISPLAY_SANS_RE,
  ALL_CAPS_TRACKING_FLOOR_EM,
  ACCENT_OVERUSE_CAP,
  MAX_RADIUS_PX,
  GLOBAL_THEME_SELECTOR_RE,
} from "./slop-rules.ts";
import {
  escapeRe,
  iterateRules,
  parseCustomProps,
  readProp,
  extractStyleBlocks,
  buildResolvedThemes,
  resolveVar,
  letterSpacingToEm,
  fontSizeToPx,
} from "./css.ts";

function checkEmptyArtifact(html: string): Finding[] {
  const trimmed = html.trim();
  if (!trimmed) {
    return [{
      severity: "P0",
      id: "empty-artifact",
      message: "Artifact is empty.",
      fix: "Return a complete HTML artifact with visible content instead of an empty file.",
      snippet: "",
    }];
  }

  const body = trimmed.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? trimmed;
  const content = body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const hasRenderableMedia = /<(?:canvas|embed|iframe|img|object|svg|video)\b/i.test(content);
  const visibleText = content
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!hasRenderableMedia && visibleText.length === 0) {
    return [{
      severity: "P0",
      id: "empty-artifact",
      message: "Artifact body has no visible content.",
      fix: "Render visible product content in the artifact body before marking the run complete.",
      snippet: trimmed.slice(0, 120),
    }];
  }
  return [];
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function toHexByte(n: number): string {
  return clampByte(n).toString(16).padStart(2, "0");
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
}

function normalizeHex(hex: string): string {
  const lower = hex.toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(lower)) {
    return `#${lower[1]}${lower[1]}${lower[2]}${lower[2]}${lower[3]}${lower[3]}`;
  }
  return lower;
}

function parseCssNumber(raw: string, percentScale = 1): number {
  const value = parseFloat(raw);
  return raw.trim().endsWith("%") ? (value / 100) * percentScale : value;
}

function hslToHex(h: number, s: number, l: number): string {
  const hue = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return rgbToHex(channel(hue + 1 / 3) * 255, channel(hue) * 255, channel(hue - 1 / 3) * 255);
}

function normalizedHexes(value: string): Set<string> {
  const out = new Set<string>();
  for (const match of value.matchAll(/#[0-9a-f]{3,8}\b/gi)) {
    const raw = match[0];
    if (raw.length === 4 || raw.length === 7) out.add(normalizeHex(raw));
  }
  for (const match of value.matchAll(/rgba?\(\s*([0-9.]+%?)\s*(?:,|\s)\s*([0-9.]+%?)\s*(?:,|\s)\s*([0-9.]+%?)/gi)) {
    out.add(rgbToHex(parseCssNumber(match[1] ?? "0", 255), parseCssNumber(match[2] ?? "0", 255), parseCssNumber(match[3] ?? "0", 255)));
  }
  for (const match of value.matchAll(/hsla?\(\s*([0-9.]+)(?:deg)?\s*(?:,|\s)\s*([0-9.]+%)\s*(?:,|\s)\s*([0-9.]+%)/gi)) {
    out.add(hslToHex(parseFloat(match[1] ?? "0"), parseCssNumber(match[2] ?? "0%"), parseCssNumber(match[3] ?? "0%")));
  }
  return out;
}

function hueInRange(hue: number, min: number, max: number): boolean {
  const h = ((hue % 360) + 360) % 360;
  return min <= max ? h >= min && h <= max : h >= min || h <= max;
}

function oklchFamilyInValue(value: string, family: "blue" | "cyan" | "purple"): boolean {
  for (const match of value.matchAll(/oklch\(\s*([0-9.]+%?)\s+([0-9.]+)\s+([0-9.]+)/gi)) {
    const lightness = parseCssNumber(match[1] ?? "0%", 1);
    const chroma = parseFloat(match[2] ?? "0");
    const hue = parseFloat(match[3] ?? "0");
    if (lightness < 0.25 || lightness > 0.85 || chroma < 0.08) continue;
    if (family === "purple" && hueInRange(hue, 260, 315)) return true;
    if (family === "blue" && hueInRange(hue, 235, 270)) return true;
    if (family === "cyan" && hueInRange(hue, 190, 235)) return true;
  }
  return false;
}

function hslFamilyInValue(value: string, family: "blue" | "cyan" | "purple"): boolean {
  for (const match of value.matchAll(/hsla?\(\s*([0-9.]+)(?:deg)?\s*(?:,|\s)\s*([0-9.]+%)\s*(?:,|\s)\s*([0-9.]+%)/gi)) {
    const hue = parseFloat(match[1] ?? "0");
    const saturation = parseCssNumber(match[2] ?? "0%");
    const lightness = parseCssNumber(match[3] ?? "0%");
    if (saturation < 0.35 || lightness < 0.25 || lightness > 0.85) continue;
    if (family === "purple" && hueInRange(hue, 235, 315)) return true;
    if (family === "blue" && hueInRange(hue, 210, 265)) return true;
    if (family === "cyan" && hueInRange(hue, 175, 210)) return true;
  }
  return false;
}

function colorInValue(value: string, hexes: readonly string[], family?: "blue" | "cyan" | "purple"): boolean {
  const wanted = new Set(hexes.map((hex) => normalizeHex(hex)));
  for (const hex of normalizedHexes(value)) {
    if (wanted.has(hex)) return true;
  }
  return family ? hslFamilyInValue(value, family) || oklchFamilyInValue(value, family) : false;
}

/**
 * Remove `:root`/html/body/[data-theme] token blocks whose ONLY indigo-carrying
 * declaration is `--accent` — an intentional accent passes the indigo ban, but
 * indigo laundered through any other token name or a component selector still fires.
 */
function stripTokenBlocks(css: string): string {
  return css.replace(/([^{}]+)\{([^{}]*)\}/g, (full, sel: string, body: string) => {
    const selectors = sel.split(",").map((s) => s.trim()).filter(Boolean);
    const isGlobal =
      selectors.length > 0 && selectors.every((s) => GLOBAL_THEME_SELECTOR_RE.test(s));
    if (!isGlobal) return full;
    const props = parseCustomProps(body);
    if (props.size === 0) return full;
    for (const [name, value] of props) {
      if (name === "--accent") continue;
      // A non-accent token laundering indigo → keep the rule visible to the scan.
      if (colorInValue(value, AI_DEFAULT_INDIGO, "purple")) return full;
    }
    return ""; // intentional accent only → safe to strip from the indigo scan
  });
}

function checkIndigo(html: string, banned: readonly string[]): Finding[] {
  // Strip intentional :root token blocks from the CSS, then scan the stripped CSS
  // plus everything outside <style> (inline styles, attributes, text). Operating on
  // extracted CSS keeps selectors clean so the global-theme-scope test is accurate.
  const css = extractStyleBlocks(html);
  const nonStyle = html.replace(/<style[\s\S]*?<\/style>/gi, " ");
  const scan = `${stripTokenBlocks(css)}\n${nonStyle}`;
  const all = [...AI_DEFAULT_INDIGO, ...banned];
  const tailwindClass = scan.match(/\b(?:bg|border|decoration|from|outline|ring|text|to|via)-(?:indigo|purple|violet)-(?:50|[1-9]00|950)\b/i)?.[0];
  const matchedHex = all.find((hex) => new RegExp(escapeRe(hex), "i").test(scan));
  if (tailwindClass || colorInValue(scan, all, "purple")) {
    return [{
      severity: "P0",
      id: "ai-default-indigo",
      message: `Default AI-tell indigo "${matchedHex ?? tailwindClass ?? "equivalent color"}" used as a solid color outside the :root --accent token.`,
      fix: "Use the active design system's --accent. If you truly want this hue, declare it only as :root{ --accent: … }.",
      snippet: matchedHex ?? tailwindClass ?? "indigo equivalent",
    }];
  }
  return [];
}

function eachGradient(html: string): string[] {
  const out: string[] = [];
  const re = /\b(?:linear|radial|conic)-gradient\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < html.length && depth > 0) {
      const ch = html[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      i += 1;
    }
    if (depth === 0) {
      out.push(html.slice(m.index, i));
      re.lastIndex = i;
    }
  }
  return out;
}

function checkPurpleGradient(html: string): Finding[] {
  for (const grad of eachGradient(html)) {
    if (colorInValue(grad, PURPLE_HEXES, "purple") || /\b(indigo|purple|violet)\b/i.test(grad)) {
      return [{
        severity: "P0",
        id: "purple-gradient",
        message: "Purple/violet gradient — the canonical AI 'trust' hero treatment.",
        fix: "Replace with a flat surface and intentional typography, or a single brand-token tint.",
        snippet: grad.slice(0, 120),
      }];
    }
  }
  return [];
}

function checkTrustGradient(html: string): Finding[] {
  for (const grad of eachGradient(html)) {
    const hasBlue = colorInValue(grad, TRUST_GRADIENT_BLUE_HEXES, "blue") || /\bblue\b/i.test(grad);
    const hasCyan = colorInValue(grad, TRUST_GRADIENT_CYAN_HEXES, "cyan") || /\bcyan\b/i.test(grad);
    if (hasBlue && hasCyan) {
      return [{
        severity: "P0",
        id: "trust-gradient",
        message: "Blue→cyan 'trust' gradient — another stock AI hero treatment.",
        fix: "Drop the gradient; a flat surface + one accent reads as designed, not generated.",
        snippet: grad.slice(0, 120),
      }];
    }
  }
  return [];
}

function checkEmojiIcons(html: string): Finding[] {
  for (const emoji of SLOP_EMOJI) {
    const re = new RegExp(
      `<(?:h[1-6]|button|li|span class="[^"]*icon[^"]*")[^>]*>[^<]*${escapeRe(emoji)}`,
      "i",
    );
    if (re.test(html)) {
      return [{
        severity: "P0",
        id: "emoji-icon",
        message: `Emoji "${emoji}" used as a feature/heading icon.`,
        fix: "Use a 1.6–1.8px-stroke monoline SVG (e.g. Lucide) with currentColor.",
        snippet: emoji,
      }];
    }
  }
  return [];
}

function checkLeftAccentCard(html: string): Finding[] {
  for (const rule of iterateRules(extractStyleBlocks(html))) {
    const borderLeft = readProp(rule.body, "border-left");
    const radius = readProp(rule.body, "border-radius");
    if (borderLeft && /\b\d+px\b[^;]*\bsolid\b/i.test(borderLeft) && radius && /^[1-9]/.test(radius.trim())) {
      return [{
        severity: "P0",
        id: "left-accent-card",
        message: "Rounded card with a colored left-border accent — the canonical 'AI dashboard tile'.",
        fix: "Drop either the radius or the left-border. Differentiate cards with weight/spacing instead.",
        snippet: rule.selector,
      }];
    }
  }
  return [];
}

function checkSansDisplay(html: string): Finding[] {
  const m = html.match(DISPLAY_SANS_RE);
  if (m) {
    return [{
      severity: "P0",
      id: "sans-display",
      message: "Overused system/sans font hardcoded on a display element (h1/h2/h3).",
      fix: "Use var(--font-display) from the active design system, not a literal Inter/Roboto/system-ui.",
      snippet: m[0].slice(0, 120),
    }];
  }
  return [];
}

function checkRegexList(html: string, patterns: readonly RegExp[], finding: Omit<Finding, "snippet">): Finding[] {
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return [{ ...finding, snippet: m[0] }];
  }
  return [];
}

function checkScrollIntoView(html: string): Finding[] {
  if (/\.scrollIntoView\s*\(/.test(html)) {
    return [{
      severity: "P0",
      id: "scroll-into-view",
      message: "scrollIntoView() will hijack the sandboxed preview iframe's scroll position.",
      fix: "Remove it; scroll the artifact's own container, not the document.",
    }];
  }
  return [];
}

function checkAllCapsTracking(html: string): Finding[] {
  const css = extractStyleBlocks(html);
  if (!css) return [];
  const themes = buildResolvedThemes(css);
  const themeMaps = [...themes.values()];
  const findings: Finding[] = [];
  for (const rule of iterateRules(css)) {
    const tt = readProp(rule.body, "text-transform");
    if (!tt || !/uppercase/i.test(tt)) continue;
    const lsRaw = readProp(rule.body, "letter-spacing");
    const fsRaw = readProp(rule.body, "font-size");
    let failingTheme = false;
    for (const tokens of themeMaps.length ? themeMaps : [new Map<string, string>()]) {
      const ls = lsRaw ? resolveVar(lsRaw, tokens) : undefined;
      const fsPx = fontSizeToPx(fsRaw, tokens);
      if (!ls) { failingTheme = true; break; }
      const { em } = letterSpacingToEm(ls, fsPx);
      if (em === null || em < ALL_CAPS_TRACKING_FLOOR_EM - 1e-9) { failingTheme = true; break; }
    }
    if (failingTheme) {
      findings.push({
        severity: "P1",
        id: "all-caps-no-tracking",
        message: `ALL-CAPS text ("${rule.selector}") without ≥${ALL_CAPS_TRACKING_FLOOR_EM}em letter-spacing.`,
        fix: `Add letter-spacing: ${ALL_CAPS_TRACKING_FLOOR_EM}em–0.1em. Uppercase always needs tracking (Bringhurst §3.2.7).`,
        snippet: rule.selector,
      });
    }
  }
  return findings;
}

function checkExternalImages(html: string): Finding[] {
  for (const host of EXTERNAL_IMAGE_HOSTS) {
    const re = new RegExp(`<img[^>]+src=["']https?:\\/\\/(?:[^"'>]*\\.)?${escapeRe(host)}`, "i");
    if (re.test(html)) {
      return [{
        severity: "P1",
        id: "external-image",
        message: `External placeholder image CDN (${host}) — fragile and obviously templated.`,
        fix: "Use a local placeholder asset.",
        snippet: host,
      }];
    }
  }
  return [];
}

function checkRawHex(html: string): Finding[] {
  const css = extractStyleBlocks(html);
  // Remove :root{...} blocks; count raw hex elsewhere in the first style surface.
  const withoutRoot = css.replace(/:root[^{]*\{[^}]*\}/gi, "");
  const hexes = withoutRoot.match(/#[0-9a-f]{6}\b/gi) ?? [];
  if (hexes.length > 12) {
    return [{
      severity: "P1",
      id: "raw-hex",
      message: `${hexes.length} raw hex values outside :root — design tokens were not honoured.`,
      fix: "Move colors into :root tokens and reference them with var().",
    }];
  }
  return [];
}

function checkAccentOveruse(html: string, cap: number): Finding[] {
  // Count accent uses in the rendered body only (outside <style>), matching the
  // craft rule's "visible uses per screen" intent.
  const body = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  const count = (body.match(/var\(\s*--accent\b/gi) ?? []).length;
  if (count > cap) {
    return [{
      severity: "P1",
      id: "accent-overuse",
      message: `--accent used ${count} times in the rendered body (cap ${cap}).`,
      fix: `Cap the accent at ${cap} visible uses per screen; let neutrals carry the rest.`,
    }];
  }
  return [];
}

function checkMissingAnchors(html: string): Finding[] {
  const sections = html.match(/<section\b[^>]*>/gi) ?? [];
  const missing = sections.filter((s) => !/data-dezin-id|data-screen-label/.test(s));
  if (missing.length > 0) {
    return [{
      severity: "P2",
      id: "missing-section-anchor",
      message: `${missing.length} <section> without data-dezin-id — comment/critique tools can't target it.`,
      fix: "Add a data-dezin-id to each top-level section.",
      snippet: missing[0],
    }];
  }
  return [];
}

// ── Dezin-specific extensions (aligned to the fork's stated taste) ───────────

function checkShadowCards(html: string): Finding[] {
  for (const rule of iterateRules(extractStyleBlocks(html))) {
    if (!/card/i.test(rule.selector)) continue;
    if (/menu|dropdown|modal|dialog|popover|tooltip|overlay/i.test(rule.selector)) continue;
    const hasShadow = /box-shadow\s*:/i.test(rule.body) && !/box-shadow\s*:\s*none/i.test(rule.body);
    const hasBorder = /border(?:-(?:top|right|bottom|left))?\s*:\s*[^;]*\b(?:solid|1px|2px|var\()/i.test(rule.body);
    if (hasShadow && !hasBorder) {
      return [{
        severity: "P1",
        id: "dezin-shadow-card",
        message: `Card "${rule.selector}" uses box-shadow with no border — Dezin prefers borders over shadows.`,
        fix: "Replace the shadow with a 1px hairline border (var(--border)); reserve shadows for overlays.",
        snippet: rule.selector,
      }];
    }
  }
  return [];
}

function checkGradientText(html: string): Finding[] {
  const css = extractStyleBlocks(html);
  for (const rule of iterateRules(css)) {
    const clip = readProp(rule.body, "-webkit-background-clip") ?? readProp(rule.body, "background-clip");
    if (clip && /text/i.test(clip) && /gradient/i.test(rule.body)) {
      return [{
        severity: "P1",
        id: "dezin-gradient-text",
        message: `Gradient-clipped text ("${rule.selector}") — a stock AI flourish.`,
        fix: "Use a solid foreground color; let typography and spacing create emphasis.",
        snippet: rule.selector,
      }];
    }
  }
  return [];
}

function checkOversizedRadius(html: string, maxPx: number): Finding[] {
  const css = extractStyleBlocks(html);
  const re = /border-radius\s*:\s*(\d+)px/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const px = parseInt(m[1] ?? "0", 10);
    if (px > maxPx && px < 999) {
      return [{
        severity: "P2",
        id: "dezin-oversized-radius",
        message: `border-radius ${px}px exceeds the Dezin cap (${maxPx}px) and isn't a pill.`,
        fix: `Use a token from the radius scale (≤${maxPx}px) or a full pill (999px) for chips.`,
        snippet: m[0],
      }];
    }
  }
  return [];
}

function checkDeck(html: string, isDeck: boolean): Finding[] {
  if (!isDeck) return [];
  const slides = html.match(/<section\b[^>]*class="[^"]*\bslide\b[^"]*"[^>]*>/gi) ?? [];
  const themeless = slides.filter((s) => !/\btheme-[a-z0-9-]+/i.test(s));
  if (themeless.length > 0) {
    return [{
      severity: "P0",
      id: "slide-theme-missing",
      message: `${themeless.length} .slide without a theme- class.`,
      fix: "Give every slide exactly one theme class for consistent deck styling.",
      snippet: themeless[0],
    }];
  }
  return [];
}

// ── Typography + accessibility craft (enforces the prompt-injected craft docs) ──

function checkJustify(html: string): Finding[] {
  const m = html.match(/text-align\s*:\s*justify/i);
  if (m) {
    return [{
      severity: "P1",
      id: "text-justify",
      message: "text-align: justify creates rivers on the web (typography craft: never justify).",
      fix: "Use text-align: left (or start). Justification belongs to print with hyphenation, not the web.",
      snippet: m[0],
    }];
  }
  return [];
}

function checkMultipleH1(html: string): Finding[] {
  const count = (html.match(/<h1[\s>]/gi) ?? []).length;
  if (count > 1) {
    return [{
      severity: "P1",
      id: "multiple-h1",
      message: `${count} <h1> elements — there should be exactly one top-level heading (a11y baseline).`,
      fix: "Demote the extra <h1>s to <h2>/<h3> so the document has a single, recoverable heading spine.",
    }];
  }
  return [];
}

function checkDivButton(html: string): Finding[] {
  // Native <button>/<a> over div-with-onClick. A div/span carrying onclick but no
  // role= is the canonical inaccessible "fake button".
  const re = /<(?:div|span)\b[^>]*\bonclick\s*=[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (!/\brole\s*=/.test(m[0])) {
      return [{
        severity: "P1",
        id: "div-as-button",
        message: "Clickable <div>/<span> with onclick but no role — use a native <button> (a11y baseline).",
        fix: "Replace with <button>, or at minimum add role=\"button\", tabindex=\"0\", and key handlers.",
        snippet: m[0].slice(0, 120),
      }];
    }
  }
  return [];
}

function checkPositiveTabindex(html: string): Finding[] {
  const m = html.match(/tabindex\s*=\s*["']?[1-9]/i);
  if (m) {
    return [{
      severity: "P2",
      id: "positive-tabindex",
      message: "Positive tabindex overrides natural focus order (a11y baseline: never use a positive tabindex).",
      fix: "Use tabindex=\"0\" / \"-1\" only; fix order by reordering the DOM, not the tab index.",
      snippet: m[0],
    }];
  }
  return [];
}

function checkReducedMotion(html: string): Finding[] {
  const css = extractStyleBlocks(html);
  if (!css) return [];
  // Only DECORATIVE motion counts — a named @keyframes animation. Bare hover
  // `transition:` is too common to flag and isn't what the discipline targets.
  const hasDecorativeMotion = /@keyframes\b/i.test(css) || /\banimation(?:-name)?\s*:/i.test(css);
  if (!hasDecorativeMotion) return [];
  if (/prefers-reduced-motion/i.test(html)) return [];
  return [{
    severity: "P2",
    id: "no-reduced-motion",
    message: "Decorative motion (@keyframes/animation) with no prefers-reduced-motion guard.",
    fix: "Wrap or neutralise non-essential motion in @media (prefers-reduced-motion: reduce) { … } — it's mandatory (animation-discipline).",
  }];
}

function checkDarkPureBlack(html: string): Finding[] {
  const css = extractStyleBlocks(html);
  if (!css) return [];
  const darkBodies: string[] = [];
  const selRe = /(?:\[data-theme="dark"\]|\.dark)(?![\w-])[^{]*\{([^}]*)\}/gi;
  let m: RegExpExecArray | null;
  while ((m = selRe.exec(css)) !== null) darkBodies.push(m[1] ?? "");
  // Best-effort for @media (prefers-color-scheme: dark): scan a bounded window.
  const mediaIdx = css.search(/@media[^{]*prefers-color-scheme:\s*dark/i);
  if (mediaIdx >= 0) darkBodies.push(css.slice(mediaIdx, mediaIdx + 500));

  for (const body of darkBodies) {
    if (/background[^;:]*:\s*(?:#000\b|#000000\b)/i.test(body)) {
      return [{
        severity: "P2",
        id: "dark-pure-black",
        message: "Dark theme uses a pure-black background (color craft: dark is never pure #000).",
        fix: "Use a near-black like #0a0a0a / oklch(0.16 …) so surfaces have depth and hairlines read.",
        snippet: "#000",
      }];
    }
    if (/:\s*(?:#fff\b|#ffffff\b)/i.test(body)) {
      return [{
        severity: "P2",
        id: "dark-pure-black",
        message: "Dark theme uses pure white (color craft: dark is never pure #fff).",
        fix: "Use a near-white like #f2f2f2 for text to avoid glare on a dark surface.",
        snippet: "#fff",
      }];
    }
  }
  return [];
}

/**
 * Bounce/overshoot easing — a cubic-bezier whose control points under- or overshoot
 * (y1 < 0 or y2 > 1). Read from SOURCE, not computed style: the visual-QA capture
 * freezes `transition`/`animation` to stabilise the screenshot, which erases the
 * declared curve, so declared easing must be linted from the artifact text.
 */
function checkBounceEasing(html: string): Finding[] {
  const re = /cubic-bezier\(\s*[-\d.]+\s*,\s*(-?[\d.]+)\s*,\s*[-\d.]+\s*,\s*(-?[\d.]+)\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const y1 = parseFloat(m[1] ?? "0");
    const y2 = parseFloat(m[2] ?? "0");
    if (y1 < 0 || y2 > 1) {
      return [
        {
          severity: "P2",
          id: "bounce-easing",
          message: "Bounce/overshoot easing (a cubic-bezier that under- or overshoots) — feels dated and tacky.",
          fix: "Use an exponential ease-out like cubic-bezier(0.22, 1, 0.36, 1); avoid bounce/elastic curves.",
          snippet: m[0],
        },
      ];
    }
  }
  return [];
}

const SEVERITY_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2 };

/**
 * Lint a single HTML artifact for anti-AI-slop and design-token issues.
 * Findings are returned sorted P0-first. Pure function — no I/O.
 */
export function lintArtifact(html: string, options: LintOptions = {}): Finding[] {
  const accentCap = options.accentOveruseCap ?? ACCENT_OVERUSE_CAP;
  const maxRadius = options.maxRadiusPx ?? MAX_RADIUS_PX;
  const banned = options.bannedAccentHexes ?? [];
  const prototypeOnly = (options.mode ?? "prototype") !== "standard";

  const findings: Finding[] = [
    ...(prototypeOnly ? checkEmptyArtifact(html) : []),
    ...checkIndigo(html, banned),
    ...checkPurpleGradient(html),
    ...checkTrustGradient(html),
    ...checkEmojiIcons(html),
    ...checkLeftAccentCard(html),
    ...checkSansDisplay(html),
    ...checkRegexList(html, INVENTED_METRIC_PATTERNS, {
      severity: "P0",
      id: "invented-metric",
      message: "Fabricated metric (e.g. '10× faster', '99.9% uptime') with no source.",
      fix: "Pull a real number from a source, or use a clearly-labelled placeholder.",
    }),
    ...checkRegexList(html, FILLER_PATTERNS, {
      severity: "P0",
      id: "filler-copy",
      message: "Filler/placeholder copy (lorem ipsum, 'feature one/two/three').",
      fix: "Write real copy. An empty section is a composition problem, not a word-inventing one.",
    }),
    ...(prototypeOnly ? checkScrollIntoView(html) : []),
    ...checkDeck(html, options.isDeck ?? false),
    ...checkAllCapsTracking(html),
    ...checkJustify(html),
    ...checkMultipleH1(html),
    ...checkDivButton(html),
    ...checkPositiveTabindex(html),
    ...checkReducedMotion(html),
    ...checkDarkPureBlack(html),
    ...checkBounceEasing(html),
    ...checkExternalImages(html),
    ...checkRawHex(html),
    ...checkAccentOveruse(html, accentCap),
    ...checkMissingAnchors(html),
    ...(options.disableDezinRules ? [] : [
      ...checkShadowCards(html),
      ...checkGradientText(html),
      ...checkOversizedRadius(html, maxRadius),
    ]),
  ];

  return findings.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
}

/** Convenience: true if the artifact has at least one finding of the given severities. */
export function hasFindings(findings: Finding[], severities: readonly string[] = ["P0"]): boolean {
  return findings.some((f) => severities.includes(f.severity));
}
