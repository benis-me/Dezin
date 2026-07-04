/**
 * Lazy filesystem loader for skills. Scans <dir>/<id>/SKILL.md, parses the flat
 * frontmatter, returns SkillInfo[]. No DB, no watching — re-scan on demand. A
 * SKILL.md loader.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillInfo, SkillMode } from "./types.ts";
import { parseFrontmatter, type FrontmatterValue } from "./frontmatter.ts";

const MODES = new Set<SkillMode>(["prototype", "design-system", "document", "deck", "utility"]);

function asString(v: FrontmatterValue | undefined, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function asArray(v: FrontmatterValue | undefined): string[] {
  return Array.isArray(v) ? v : [];
}
function asBool(v: FrontmatterValue | undefined, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function asMode(v: FrontmatterValue | undefined): SkillMode {
  const s = asString(v, "prototype");
  return MODES.has(s as SkillMode) ? (s as SkillMode) : "prototype";
}

export function toSkillInfo(id: string, data: Record<string, FrontmatterValue>, body: string): SkillInfo {
  return {
    id,
    name: asString(data.name, id),
    description: asString(data.description),
    mode: asMode(data.mode),
    craft: asArray(data.craft),
    triggers: asArray(data.triggers),
    libraries: asArray(data.libraries),
    designSystem: asBool(data.designSystem, true),
    body,
  };
}

/**
 * Resolve the bundled content/skills directory relative to this package.
 *
 * PACKAGING REQUIREMENT: skills are read from the real filesystem — both here (readdirSync)
 * and by the spawned BYOK agent, which is handed absolute SKILL.md paths and reads them with
 * its own fs, NOT through Electron's asar shim. So when the desktop app is packaged, this
 * directory MUST live on disk unpacked. In electron-builder terms add
 * `"asarUnpack": ["content/skills/**"]` (or ship `content/` outside the asar). Inside an asar
 * archive `readdirSync` returns empty for the child and loadSkills() silently yields [].
 */
export function defaultSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "content", "skills");
}

export function loadSkills(dir: string = defaultSkillsDir()): SkillInfo[] {
  if (!existsSync(dir)) return [];
  const skills: SkillInfo[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, "SKILL.md");
    if (!existsSync(file)) continue;
    const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
    skills.push(toSkillInfo(entry.name, data, body));
  }
  skills.sort((a, b) => a.id.localeCompare(b.id));
  return skills;
}

export function findSkill(skills: SkillInfo[], id: string): SkillInfo | null {
  return skills.find((s) => s.id === id) ?? null;
}
