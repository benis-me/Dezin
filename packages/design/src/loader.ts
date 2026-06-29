/**
 * Lazy filesystem loader for design systems, mirroring @dezin/skills. Scans
 * <dir>/<id>/{DESIGN.md, tokens.css, manifest.json?} and returns DesignSystem[].
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DesignSystem, DesignSystemCraft } from "./types.ts";

const DEFAULT_CRAFT: DesignSystemCraft = { applies: ["typography", "color", "anti-ai-slop"] };

function firstHeading(md: string): string | null {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1]!.trim() : null;
}

export function defaultDesignDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "content", "design-systems");
}

/** Where user-imported brand systems live, under the daemon's data dir. */
export function userDesignDir(dataDir: string): string {
  return join(dataDir, "design-systems");
}

export function loadDesignSystems(dir: string = defaultDesignDir()): DesignSystem[] {
  if (!existsSync(dir)) return [];
  const out: DesignSystem[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const base = join(dir, entry.name);
    const mdPath = join(base, "DESIGN.md");
    if (!existsSync(mdPath)) continue;

    const designMd = readFileSync(mdPath, "utf8");
    const tokensPath = join(base, "tokens.css");
    const tokensCss = existsSync(tokensPath) ? readFileSync(tokensPath, "utf8") : "";

    let manifest: Record<string, unknown> = {};
    const manPath = join(base, "manifest.json");
    if (existsSync(manPath)) {
      try {
        manifest = JSON.parse(readFileSync(manPath, "utf8")) as Record<string, unknown>;
      } catch {
        manifest = {};
      }
    }

    out.push({
      id: entry.name,
      name: typeof manifest.name === "string" ? manifest.name : (firstHeading(designMd) ?? entry.name),
      category: typeof manifest.category === "string" ? manifest.category : "Uncategorized",
      summary: typeof manifest.summary === "string" ? manifest.summary : "",
      designMd,
      tokensCss,
      craft: (manifest.craft as DesignSystemCraft | undefined) ?? DEFAULT_CRAFT,
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}
