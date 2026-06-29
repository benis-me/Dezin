/**
 * Load craft rule sections by slug from content/craft, concatenated for prompt
 * injection. A skill opts into the sections it needs; missing slugs are silently
 * dropped (forward-compatible).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export function defaultCraftDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "content", "craft");
}

/** Concatenate the requested craft sections under `### <slug>` headers. "" if none resolve. */
export function loadCraftSections(slugs: string[], dir: string = defaultCraftDir()): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const slug of slugs) {
    if (!SLUG_RE.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    const file = join(dir, `${slug}.md`);
    if (!existsSync(file)) continue;
    const body = readFileSync(file, "utf8").trim();
    if (body) parts.push(`### ${slug}\n\n${body}`);
  }
  return parts.join("\n\n---\n\n");
}
