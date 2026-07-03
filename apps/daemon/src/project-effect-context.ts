import type { Store } from "../../../packages/core/src/index.ts";
import { buildEffectAgentContext, getBuiltInEffect, type EffectDefinition } from "../../../packages/effects/src/index.ts";

export interface ProjectEffectRef {
  id: string;
  name?: string;
}

export interface ProjectEffectContext {
  promptBlock: string;
  labels: ProjectEffectRef[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeProjectEffectRefs(value: unknown): ProjectEffectRef[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const refs: ProjectEffectRef[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const id = stringValue(record?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    refs.push({ id, name: stringValue(record?.name) || undefined });
    if (refs.length >= 5) break;
  }
  return refs;
}

export function effectReferenceLine(refs: ProjectEffectRef[]): string {
  if (!refs.length) return "";
  return `\n\nEffect references (available to the Agent at run time): ${refs
    .map((ref) => `${ref.name?.trim() || "Untitled effect"} (${ref.id})`)
    .join(", ")}`;
}

export function appendEffectReferenceLine(brief: string, refs: ProjectEffectRef[]): string {
  if (!refs.length || /Effect references/i.test(brief)) return brief;
  return `${brief}${effectReferenceLine(refs)}`;
}

function shouldOfferEffectLookup(request: string): boolean {
  return /\b(effect|effects|shader|shaders|texture|grain|glass|water|dither|dithering|halftone|gradient|noise|rays|smoke|metaballs|liquid|paper)\b|效果|着色器|纹理|颗粒|玻璃|水波|渐变/.test(
    request.toLowerCase(),
  );
}

export function buildProjectEffectContext(input: {
  store: Store;
  refs: ProjectEffectRef[];
  request: string;
  origin: string;
}): ProjectEffectContext {
  const labels: ProjectEffectRef[] = [];
  const blocks: string[] = [];
  const skipped: ProjectEffectRef[] = [];

  for (const ref of input.refs) {
    const effect = getBuiltInEffect(ref.id) ?? input.store.getEffect(ref.id) ?? null;
    if (!effect) {
      skipped.push(ref);
      continue;
    }
    labels.push({ id: effect.id, name: effect.name });
    blocks.push(buildEffectAgentContext(effect as EffectDefinition));
  }

  const origin = input.origin.replace(/\/+$/, "");
  const discovery = [
    "## Effects Lookup",
    "If the user's request calls for reusable visual effects that were not explicitly selected, query the Effects library instead of guessing or asking for the full list.",
    `Search: GET ${origin}/api/effects?query=<short-effect-query>`,
    `Read: GET ${origin}/api/effects/:id`,
    "Use the x-dezin-daemon-token header with DEZIN_DAEMON_TOKEN when that environment variable is present.",
  ].join("\n");

  if (!blocks.length) return { labels: [], promptBlock: shouldOfferEffectLookup(input.request) ? discovery : "" };

  return {
    labels,
    promptBlock: [
      "## Referenced Effects",
      "The user selected Effects for this run. Treat them as reusable visual effect implementations, parameter schemas, and visual references for the artifact you are editing.",
      `Latest user request: ${input.request}`,
      "",
      blocks.join("\n\n---\n\n"),
      skipped.length ? `\nSkipped missing effects: ${skipped.map((ref) => ref.id).join(", ")}` : "",
      "",
      discovery,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
