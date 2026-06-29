/**
 * A small library of visual directions, used when a project pins NO brand design
 * system. Each direction is a lightweight, opinionated palette + type stack +
 * posture the agent binds verbatim — removing the model's freedom to improvise
 * color, which is what produces taste.
 */

export interface DirectionPalette {
  bg: string;
  surface: string;
  fg: string;
  muted: string;
  border: string;
  accent: string;
}

export interface Direction {
  id: string;
  name: string;
  palette: DirectionPalette;
  displayFont: string;
  bodyFont: string;
  monoFont: string;
  posture: string[];
}

export const DESIGN_DIRECTIONS: Direction[] = [
  {
    id: "modern-minimal",
    name: "Modern Minimal (Linear / Vercel)",
    palette: {
      bg: "oklch(1 0 0)",
      surface: "oklch(0.985 0 0)",
      fg: "oklch(0.145 0 0)",
      muted: "oklch(0.556 0 0)",
      border: "oklch(0.922 0 0)",
      accent: "oklch(0.58 0.18 255)",
    },
    displayFont: '"Geist", ui-sans-serif, system-ui, sans-serif',
    bodyFont: '"Geist", ui-sans-serif, system-ui, sans-serif',
    monoFont: '"JetBrains Mono", ui-monospace, monospace',
    posture: [
      "Hairline borders only; no shadows except dropdowns/modals",
      "Tight display tracking (-0.02em); tabular numerics",
      "One cobalt accent, used at most twice per screen",
    ],
  },
  {
    id: "editorial",
    name: "Editorial (Monocle / FT)",
    palette: {
      bg: "oklch(0.98 0.006 85)",
      surface: "oklch(0.96 0.008 85)",
      fg: "oklch(0.17 0.01 60)",
      muted: "oklch(0.52 0.01 60)",
      border: "oklch(0.9 0.01 80)",
      accent: "oklch(0.5 0.17 25)",
    },
    displayFont: '"Source Serif 4", Georgia, serif',
    bodyFont: '"Source Serif 4", Georgia, serif',
    monoFont: "ui-monospace, monospace",
    posture: [
      "Dramatic scale jumps (display 3–5× body); 66ch measure",
      "Serif reading type; whitespace as hierarchy",
      "Pull-quotes as interrupts; a single ink-red accent",
    ],
  },
  {
    id: "tech-utility",
    name: "Tech Utility (Datadog / GitHub)",
    palette: {
      bg: "oklch(0.16 0.01 250)",
      surface: "oklch(0.2 0.01 250)",
      fg: "oklch(0.95 0.005 250)",
      muted: "oklch(0.65 0.01 250)",
      border: "oklch(0.3 0.01 250)",
      accent: "oklch(0.7 0.16 145)",
    },
    displayFont: "ui-sans-serif, system-ui, sans-serif",
    bodyFont: "ui-sans-serif, system-ui, sans-serif",
    monoFont: '"JetBrains Mono", ui-monospace, monospace',
    posture: [
      "Dense, information-first; mono for codes and metrics",
      "Dark-native; status colors carry meaning; tabular-nums everywhere",
      "Borders define regions — no decoration",
    ],
  },
  {
    id: "human",
    name: "Human / Approachable (Airbnb / Duolingo)",
    palette: {
      bg: "oklch(1 0 0)",
      surface: "oklch(0.97 0.01 30)",
      fg: "oklch(0.25 0.02 30)",
      muted: "oklch(0.55 0.02 30)",
      border: "oklch(0.9 0.02 30)",
      accent: "oklch(0.62 0.19 20)",
    },
    displayFont: '"Inter", ui-sans-serif, system-ui, sans-serif',
    bodyFont: "ui-sans-serif, system-ui, sans-serif",
    monoFont: "ui-monospace, monospace",
    posture: [
      "Generous radii (12–16px); soft surfaces",
      "A warm coral accent; friendly microcopy",
      "One illustrative or photographic focal point",
    ],
  },
  {
    id: "brutalist",
    name: "Brutalist (Are.na / Yale)",
    palette: {
      bg: "oklch(1 0 0)",
      surface: "oklch(1 0 0)",
      fg: "oklch(0.12 0 0)",
      muted: "oklch(0.4 0 0)",
      border: "oklch(0.12 0 0)",
      accent: "oklch(0.55 0.24 27)",
    },
    displayFont: '"Helvetica Neue", Arial, sans-serif',
    bodyFont: '"Helvetica Neue", Arial, sans-serif',
    monoFont: "ui-monospace, monospace",
    posture: [
      "Hard 1–2px borders, zero radius; raw visible grids",
      "High contrast; one loud accent",
      "No shadows, no gradients",
    ],
  },
];

export function findDirection(id: string): Direction | null {
  return DESIGN_DIRECTIONS.find((d) => d.id === id) ?? null;
}

export function renderDirectionBlock(d: Direction): string {
  const root = [
    ":root {",
    `  --bg: ${d.palette.bg};`,
    `  --surface: ${d.palette.surface};`,
    `  --fg: ${d.palette.fg};`,
    `  --muted: ${d.palette.muted};`,
    `  --border: ${d.palette.border};`,
    `  --accent: ${d.palette.accent};`,
    `  --font-display: ${d.displayFont};`,
    `  --font-body: ${d.bodyFont};`,
    `  --font-mono: ${d.monoFont};`,
    "}",
  ].join("\n");
  return (
    `## Visual direction — ${d.name}\n\n` +
    `No brand design system is active; follow this direction. Paste this \`:root\` verbatim and ` +
    `bind everything with var() — do not invent tokens or write raw hex outside it.\n\n` +
    "```css\n" +
    root +
    "\n```\n\nPosture:\n" +
    d.posture.map((p) => `- ${p}`).join("\n")
  );
}
