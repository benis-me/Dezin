/**
 * Brand import — turn a few brand inputs (name, accent, fonts, vibe) into a valid
 * Dezin design system: tokens.css + a 9-section DESIGN.md + manifest. Deterministic
 * (no agent, no network), so the wizard is instant. The neutral ramp is a tasteful,
 * lint-safe default; the brand's accent + type are what make each one distinct.
 */

export interface BrandInput {
  name: string;
  /** Accent colour, hex (with or without #). */
  accent: string;
  displayFont?: string;
  bodyFont?: string;
  /** One-line description of the brand's feel. */
  vibe?: string;
  category?: string;
}

export interface GeneratedBrand {
  id: string;
  name: string;
  category: string;
  summary: string;
  designMd: string;
  tokensCss: string;
  manifest: Record<string, unknown>;
}

export function slugifyBrand(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "brand"
  );
}

export function isHexColor(s: string): boolean {
  return /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(s.trim());
}

function normalizeHex(s: string): string {
  let h = s.trim().replace(/^#/, "").toLowerCase();
  if (h.length === 3) h = h.replace(/(.)/g, "$1$1");
  return `#${h}`;
}

/** Pick a readable foreground (near-black or white) for text on the accent. */
function accentForeground(hex: string): string {
  const h = normalizeHex(hex).slice(1);
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? "#0a0a0a" : "#ffffff";
}

function tokens(accent: string, accentFg: string, display: string, body: string): string {
  return `:root {
  --bg: #ffffff;
  --surface: #fafafa;
  --surface-2: #f4f4f5;
  --fg: #111111;
  --fg-2: #52525b;
  --muted: #71717a;
  --border: #e4e4e7;
  --border-strong: #d4d4d8;

  --accent: ${accent};
  --accent-fg: ${accentFg};

  --success: #16a34a;
  --warn: #b45309;
  --danger: #dc2626;

  --font-display: "${display}", ui-sans-serif, system-ui, sans-serif;
  --font-body: "${body}", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;

  --space-1: 4px; --space-2: 8px; --space-3: 12px;
  --space-4: 16px; --space-6: 24px; --space-8: 32px; --space-12: 48px;

  --radius-sm: 6px; --radius: 8px; --radius-lg: 12px; --radius-pill: 999px;

  --container-max: 1120px;
  --motion-fast: 150ms;
  --ease-out: cubic-bezier(0.25, 1, 0.5, 1);
}
[data-theme="dark"] {
  --bg: #0a0a0a;
  --surface: #131316;
  --surface-2: #1c1c20;
  --fg: #fafafa;
  --fg-2: #a1a1aa;
  --muted: #8b8b94;
  --border: rgba(255,255,255,0.10);
  --border-strong: rgba(255,255,255,0.16);
  --accent: ${accent};
}`;
}

function designMd(name: string, category: string, accent: string, display: string, body: string, vibe: string): string {
  return `# ${name}

> Category: ${category}

## 1. Visual Theme & Atmosphere

${vibe} The system leans neutral-first: a near-white canvas (\`--bg\`), graphite text (\`--fg\`), and a single brand accent (\`${accent}\`) used sparingly for the one action that matters. Restraint is the brand — the surface is calm so the accent reads as intent, not decoration.

## 2. Color Palette & Roles

- Surfaces: \`--bg\` / \`--surface\` / \`--surface-2\` carry ~90% of the page.
- Text: \`--fg\` for primary, \`--fg-2\` and \`--muted\` for secondary and hint text.
- Accent: \`${accent}\` (\`--accent\`) for the primary CTA and at most one focal highlight. Text on it uses \`--accent-fg\`.
- Borders over shadows: separate with \`--border\` / \`--border-strong\`, not drop shadows.
- Reserve \`--success\` / \`--warn\` / \`--danger\` for status only — never as decoration.

## 3. Typography Rules

- Display: **${display}** for headlines — tight tracking, balanced wrapping.
- Body: **${body}** at a comfortable measure (~65ch), 1.5 line-height.
- One type family for chrome; mono (\`--font-mono\`) only for code or tabular data.
- Establish a clear scale (display → h2 → body → caption); never more than three sizes in a single block.

## 4. Component Stylings

- Buttons: solid accent for primary, bordered/ghost for secondary; tactile press on \`:active\`.
- Inputs: \`--border\` at rest, \`--accent\` ring on focus, clear invalid state.
- Cards: \`--border\` + \`--surface\`, no shadow unless elevation is real.
- Corners: \`--radius\` (8px) for controls and cards; \`--radius-pill\` only for pills/avatars.

## 5. Layout Principles

- Centered container at \`--container-max\` (1120px) with generous gutters.
- CSS grid for structure; an 8px spacing rhythm (\`--space-*\`).
- Strong vertical hierarchy: one \`<h1>\`, then sections that breathe.

## 6. Depth & Elevation

- Flat by default. Hierarchy comes from spacing, weight, and borders.
- When a shadow is justified (overlays, menus), keep it soft and tinted to the background — never pure black.

## 7. Do's and Don'ts

- Do keep the accent to one or two appearances per view.
- Do bind every colour to a token with \`var()\`; no raw hex outside \`:root\`.
- Don't add gradients-as-decoration, glassmorphism, or emoji-as-icons.
- Don't invent metrics ("10x faster") — write real, specific copy.

## 8. Responsive Behavior

- Mobile-first; stack to a single column under 768px.
- Use \`min-h-[100dvh]\` for full-height heros (no iOS jump).
- Touch targets ≥ 44px; never hide primary actions behind hover.

## 9. Agent Prompt Guide

Build ${name} artifacts neutral-first: paste the \`:root\` token block, then reference everything with \`var()\`. Use \`${accent}\` as the single accent on the primary action. Headlines in ${display}, body in ${body}. Borders over shadows, real copy over filler, full interaction states, and \`prefers-reduced-motion\` respected.`;
}

export function buildBrandSystem(input: BrandInput): GeneratedBrand {
  const name = input.name.trim() || "Custom Brand";
  const id = slugifyBrand(name);
  const accent = normalizeHex(isHexColor(input.accent) ? input.accent : "#2563eb");
  const accentFg = accentForeground(accent);
  const display = (input.displayFont || "Inter").trim();
  const body = (input.bodyFont || display).trim();
  const category = (input.category || "Custom").trim();
  const vibe = (input.vibe || "").trim() || `A clean, modern ${name} brand system.`;
  const summary = vibe.length > 120 ? `${vibe.slice(0, 117)}…` : vibe;

  return {
    id,
    name,
    category,
    summary,
    tokensCss: tokens(accent, accentFg, display, body),
    designMd: designMd(name, category, accent, display, body, vibe),
    manifest: {
      name,
      category,
      summary,
      craft: { applies: ["typography", "color", "anti-ai-slop", "state-coverage"], suggested: ["accessibility-baseline"] },
    },
  };
}
