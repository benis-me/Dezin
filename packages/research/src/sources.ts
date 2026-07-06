/** Parse, validate, and serialize research/sources.json. Pure, tolerant of junk. */

import type { ResearchSource, SourceKind } from "./types.ts";

const KINDS: readonly SourceKind[] = ["competitor", "inspiration", "article", "data", "asset"];

/** Low-authority hosts (SEO/content mills, AI-listicle mills) dropped at parse time. */
export const JUNK_DOMAINS: readonly string[] = [
  "medium.com", "quora.com", "slideshare.net", "scribd.com", "coursehero.com",
  "geeksforgeeks.org", "w3schools.com", "tutorialspoint.com", "javatpoint.com",
];

function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Coerce one raw entry into a ResearchSource, or null if it lacks the essentials. */
export function normalizeSource(value: unknown, index = 0, opts: { synthesizeTitle?: boolean } = {}): ResearchSource | null {
  if (!isRecord(value)) return null;
  let title = typeof value.title === "string" ? value.title.trim() : "";
  if (!title && opts.synthesizeTitle) {
    // Visual/image references are identified by their image + url/platform/designer; a title is
    // optional there, so synthesize a display label rather than dropping the image's provenance.
    const d = typeof value.designer === "string" ? value.designer.trim() : "";
    const p = typeof value.platform === "string" ? value.platform.trim() : "";
    const u = typeof value.url === "string" ? value.url.trim() : "";
    title = [d, p].filter(Boolean).join(" · ") || u || "Visual reference";
  }
  if (!title) return null;
  const kind: SourceKind = KINDS.includes(value.kind as SourceKind) ? (value.kind as SourceKind) : "inspiration";
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : `source-${index + 1}`;
  const source: ResearchSource = {
    id,
    kind,
    title,
    takeaways: strArray(value.takeaways),
    assets: strArray(value.assets),
  };
  if (typeof value.url === "string" && value.url.trim()) source.url = value.url.trim();
  if (typeof value.capturedAt === "string" && value.capturedAt.trim()) source.capturedAt = value.capturedAt.trim();
  const host = hostOf(source.url);
  if (host && JUNK_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return null;
  const authorityRaw = value.authority;
  source.authority = authorityRaw === "primary" || authorityRaw === "secondary" ? authorityRaw : "unknown";
  const platform = typeof value.platform === "string" ? value.platform.trim() : "";
  if (platform) source.platform = platform;
  const designer = typeof value.designer === "string" ? value.designer.trim() : "";
  if (designer) source.designer = designer;
  if (typeof value.reached === "boolean") source.reached = value.reached;
  return source;
}

/** Parse sources.json text into a validated ResearchSource[]. Never throws. */
export function parseSources(text: string | null | undefined, opts: { synthesizeTitle?: boolean } = {}): ResearchSource[] {
  if (!text || !text.trim()) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => normalizeSource(item, index, opts)).filter((s): s is ResearchSource => s !== null);
}

/** Serialize sources to pretty JSON text. */
export function serializeSources(sources: ResearchSource[]): string {
  return `${JSON.stringify(sources, null, 2)}\n`;
}

/** Every relative asset path referenced across all sources (deduped). */
export function collectSourceAssets(sources: ResearchSource[]): string[] {
  return Array.from(new Set(sources.flatMap((s) => s.assets)));
}
