/** Parse, validate, and serialize research/sources.json. Pure, tolerant of junk. */

import type { ResearchSource, SourceKind } from "./types.ts";

const KINDS: readonly SourceKind[] = ["competitor", "inspiration", "article", "data", "asset"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Coerce one raw entry into a ResearchSource, or null if it lacks the essentials. */
export function normalizeSource(value: unknown, index = 0): ResearchSource | null {
  if (!isRecord(value)) return null;
  const title = typeof value.title === "string" ? value.title.trim() : "";
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
  return source;
}

/** Parse sources.json text into a validated ResearchSource[]. Never throws. */
export function parseSources(text: string | null | undefined): ResearchSource[] {
  if (!text || !text.trim()) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => normalizeSource(item, index)).filter((s): s is ResearchSource => s !== null);
}

/** Serialize sources to pretty JSON text. */
export function serializeSources(sources: ResearchSource[]): string {
  return `${JSON.stringify(sources, null, 2)}\n`;
}

/** Every relative asset path referenced across all sources (deduped). */
export function collectSourceAssets(sources: ResearchSource[]): string[] {
  return Array.from(new Set(sources.flatMap((s) => s.assets)));
}
