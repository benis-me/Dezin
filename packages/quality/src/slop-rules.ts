/**
 * Single source of truth for the anti-AI-slop rule corpus.
 *
 * These rule lists are the single source of truth shared by the prompt-injected
 * craft doc and the linter, so the two cannot drift: the markdown tables in the
 * craft doc are generated from these constants, making them guaranteed identical.
 */

/** Solid-accent indigo tells. The textbook "designed by an LLM" signal. */
export const AI_DEFAULT_INDIGO: readonly string[] = [
  "#6366f1",
  "#4f46e5",
  "#4338ca",
  "#3730a3",
  "#8b5cf6",
  "#7c3aed",
  "#a855f7",
];

/** Full Tailwind violet + indigo ramps, used for gradient detection. */
export const PURPLE_HEXES: readonly string[] = [
  // violet/purple ramp
  "#a855f7", "#9333ea", "#7c3aed", "#6d28d9", "#581c87",
  "#8b5cf6", "#a78bfa", "#c4b5fd", "#ddd6fe", "#ede9fe",
  // indigo ramp
  "#6366f1", "#4f46e5", "#4338ca", "#3730a3", "#312e81",
  "#818cf8", "#a5b4fc", "#c7d2fe", "#e0e7ff", "#eef2ff",
];

/** Blue + sky hexes for the "trust" gradient (blue→cyan) that contains no indigo. */
export const TRUST_GRADIENT_BLUE_HEXES: readonly string[] = [
  "#3b82f6", "#2563eb", "#1d4ed8", "#60a5fa", "#93c5fd",
  "#0ea5e9", "#0284c7", "#38bdf8", "#7dd3fc",
];

/** Cyan hexes for the other end of the blue→cyan trust gradient. */
export const TRUST_GRADIENT_CYAN_HEXES: readonly string[] = [
  "#06b6d4", "#0891b2", "#22d3ee", "#67e8f9", "#a5f3fc",
];

/** Emoji used as decorative feature icons — only slop in a structural context. */
export const SLOP_EMOJI: readonly string[] = [
  "✨", "🚀", "🎯", "⚡", "🔥", "💡", "📈", "🎨", "🛡️",
  "🌟", "💪", "🎉", "👋", "🙌", "✅", "⭐", "🏆",
];

/** Fabricated marketing metrics with no source. */
export const INVENTED_METRIC_PATTERNS: readonly RegExp[] = [
  /\b10×\s+(faster|better|easier)\b/i,
  /\b10x\s+(faster|better|easier)\b/i,
  /\b100×\s+(faster|better)\b/i,
  /\b99\.\d+%\s+uptime\b/i,
  /\bzero[- ]downtime\b/i,
  /\b3×\s+more\s+(productive|efficient)\b/i,
  /\b3x\s+more\s+(productive|efficient)\b/i,
];

/** Placeholder / filler copy that should never ship. */
export const FILLER_PATTERNS: readonly RegExp[] = [
  /\bfeature\s+(one|two|three|1|2|3)\b/i,
  /\blorem\s+ipsum\b/i,
  /\bdolor\s+sit\s+amet\b/i,
  /\bplaceholder\s+text\b/i,
  /\bsample\s+content\b/i,
];

/** Fragile external placeholder image CDNs. */
export const EXTERNAL_IMAGE_HOSTS: readonly string[] = [
  "images.unsplash.com",
  "placehold.co",
  "placekitten.com",
  "via.placeholder.com",
  "picsum.photos",
  "loremflickr.com",
];

/**
 * Overused sans fonts hardcoded on a display element (h1/h2/h3 or a display class).
 * Matches a font-family declaration inside a display selector's rule body.
 */
export const DISPLAY_SANS_RE =
  /(?:h1|h2|h3|\.h-?(?:hero|xl|lg|md))[^{}]*\{[^}]*font-family\s*:\s*["']?(?:Inter|Roboto|Arial|-apple-system|system-ui|SF\s+Pro)\b/i;

/** Selectors that count as a "pure global theme scope" for the indigo escape hatch. */
export const GLOBAL_THEME_SELECTOR_RE =
  /^(?::root|html|body|\[data-theme[^\]]*\]|\[data-color-scheme[^\]]*\]|\[data-mode[^\]]*\])$/;

/** Root font size used to convert px/rem letter-spacing into em for the ALL-CAPS check. */
export const ROOT_FONT_PX = 16;

/** Required tracking floor for ALL-CAPS text, in em (Bringhurst §3.2.7). */
export const ALL_CAPS_TRACKING_FLOOR_EM = 0.06;
