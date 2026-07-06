/**
 * Dependency-free color math for the computed-style detector: parse the browser's
 * normalized color strings, composite alpha, and compute WCAG contrast. Kept
 * separate from css.ts (which parses CSS *source*); this operates on already-
 * computed colors, mostly `rgb()/rgba()` as Chrome reports them.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Parse rgb()/rgba() (comma or space/slash syntax), #hex, and the `transparent` keyword. */
export function parseColor(input: string | undefined): Rgba | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1]!;
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: 1,
    };
  }

  const rgb = s.match(/^rgba?\(([^)]+)\)$/);
  if (rgb) {
    // Accept "r, g, b" / "r, g, b, a" / "r g b" / "r g b / a".
    const parts = rgb[1]!.replace(/\//g, " ").split(/[\s,]+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 3) return null;
    const r = parseFloat(parts[0]!);
    const g = parseFloat(parts[1]!);
    const b = parseFloat(parts[2]!);
    const a = parts[3] !== undefined ? parseFloat(parts[3]!) : 1;
    if ([r, g, b, a].some((n) => Number.isNaN(n))) return null;
    return { r, g, b, a };
  }
  return null;
}

/** WCAG relative luminance (sRGB), 0 (black) → 1 (white). */
export function relativeLuminance(c: { r: number; g: number; b: number }): number {
  const lin = (v: number) => {
    const cs = v / 255;
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG contrast ratio between two opaque colors (order-independent), 1 → 21. */
export function contrastRatio(fg: { r: number; g: number; b: number }, bg: { r: number; g: number; b: number }): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Alpha-composite a (possibly translucent) foreground over an opaque background. */
export function compositeOver(fg: Rgba, bg: { r: number; g: number; b: number }): { r: number; g: number; b: number } {
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  };
}

/** max−min channel spread — a cheap "how chromatic": 0 for pure gray, large for saturated color. */
export function chromaSpread(c: { r: number; g: number; b: number }): number {
  return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
}
