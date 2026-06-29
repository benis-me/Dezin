/** Shared helpers for reading a design system's tokens.css and scoping it live. */

export interface Token {
  name: string;
  value: string;
}

/** Pull `--name: value;` pairs from the :root block. */
export function parseTokens(css: string): Token[] {
  const root = css.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  const out: Token[] = [];
  for (const m of root.matchAll(/--([\w-]+):\s*([^;]+);/g)) out.push({ name: m[1]!, value: m[2]!.trim() });
  return out;
}

export const isColor = (v: string): boolean => /^#|^oklch\(|^rgb|^hsl/i.test(v);

/** Scope a system's :root block to a `.<scope>` class so previews render in the brand. */
export function scopedTokens(css: string, scope: string): string {
  const root = css.match(/:root\s*\{[^}]*\}/)?.[0] ?? "";
  return root.replace(/:root/, `.${scope}`);
}

/** A safe CSS-class scope id derived from a design-system id. */
export function tokenScope(id: string): string {
  return `ds-canvas-${id.replace(/[^a-z0-9-]/gi, "")}`;
}

function accentFg(hex: string): string {
  const h = hex.replace(/^#/, "");
  if (h.length < 6) return "#ffffff";
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? "#0a0a0a" : "#ffffff";
}

/**
 * A client-side :root token block for live-previewing a brand-in-progress (mirrors
 * the daemon's buildBrandSystem so the new-system preview matches what gets created).
 */
export function previewTokensCss({ accent, display, body }: { accent: string; display: string; body: string }): string {
  const a = accent.startsWith("#") ? accent : `#${accent}`;
  const d = display.trim() || "Inter";
  const b = (body || display).trim() || "Inter";
  return `:root {
  --bg: #ffffff; --surface: #fafafa; --surface-2: #f4f4f5;
  --fg: #111111; --fg-2: #52525b; --muted: #71717a;
  --border: #e4e4e7; --border-strong: #d4d4d8;
  --accent: ${a}; --accent-fg: ${accentFg(a)};
  --success: #16a34a; --warn: #b45309; --danger: #dc2626;
  --font-display: "${d}", ui-sans-serif, system-ui, sans-serif;
  --font-body: "${b}", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-6: 24px; --space-8: 32px;
  --radius-sm: 6px; --radius: 8px; --radius-lg: 12px; --radius-pill: 999px;
}`;
}

const px = (v?: string): number => (v ? parseFloat(v) : NaN);

/** Group tokens into the buckets a spec view shows. */
export function groupTokens(css: string) {
  const tokens = parseTokens(css);
  const by = (pred: (t: Token) => boolean) => tokens.filter(pred);
  const find = (n: string) => tokens.find((t) => t.name === n)?.value;
  const fontName = (n: string) => (find(n) ?? "").replace(/["']/g, "").split(",")[0]?.trim();

  return {
    tokens,
    find,
    colors: by((t) => isColor(t.value)),
    spacing: by((t) => /^space(-|$)/.test(t.name) && !Number.isNaN(px(t.value))).sort((a, b) => px(a.value) - px(b.value)),
    radii: by((t) => /^radius(-|$)/.test(t.name)),
    fonts: {
      display: fontName("font-display"),
      body: fontName("font-body"),
      mono: fontName("font-mono"),
    },
  };
}
