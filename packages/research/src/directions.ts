/** Helpers for the candidate directions produced by the research phase. Pure. */

/** A direction's display title — its first markdown heading, else a fallback. */
export function directionTitle(markdown: string): string {
  const match = markdown.match(/^#\s+(.+?)\s*$/m);
  return match ? match[1]!.trim() : "Untitled direction";
}
