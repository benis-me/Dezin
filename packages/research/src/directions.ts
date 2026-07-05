/** Helpers for the candidate directions produced by the research phase. Pure. */

/** A direction's display title — its first markdown heading, else a fallback. */
export function directionTitle(markdown: string): string {
  const match = markdown.match(/^#\s+(.+?)\s*$/m);
  return match ? match[1]!.trim() : "Untitled direction";
}

/** A direction's one-line blurb — its prose minus heading/markup, collapsed to a single clamped line. */
export function directionBlurb(markdown: string): string {
  const body = markdown
    .replace(/^#\s+.*$/m, "") // drop the title heading
    .replace(/^#{1,6}\s+/gm, "") // drop sub-heading markers, keep their text
    .replace(/[#*`>_~[\]]/g, "") // strip inline markup
    .replace(/\s+/g, " ") // collapse to a single line
    .trim();
  return body.length > 120 ? `${body.slice(0, 120).trimEnd()}…` : body;
}
