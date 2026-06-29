/**
 * Catalog endpoints for the web pickers + the design-systems gallery. The LIST
 * stays light (no full DESIGN.md/tokens) but carries a 4-color `swatch` for
 * previews; a per-id DETAIL endpoint returns the full DESIGN.md + tokens.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  defaultRegistry,
  buildBrandSystem,
  isHexColor,
  userDesignDir,
  BUNDLED_DESIGN_SYSTEMS,
  type DesignSystemCraft,
} from "../../../packages/design/src/index.ts";

const BUILT_IN_IDS = new Set(BUNDLED_DESIGN_SYSTEMS.map((s) => s.id));
import { loadSkills, type SkillInfo } from "../../../packages/skills/src/index.ts";
import { readJsonBody, sendJson, sendError } from "./http-util.ts";
import type { AppDeps } from "./app.ts";

let cachedSkills: SkillInfo[] | null = null;
function skills(): SkillInfo[] {
  if (!cachedSkills) cachedSkills = loadSkills();
  return cachedSkills;
}

interface Swatch {
  bg: string;
  surface: string;
  fg: string;
  accent: string;
}

/** Pull the four headline tokens from a tokens.css :root block. */
function parseSwatch(tokensCss: string): Swatch {
  const read = (name: string): string => {
    const m = tokensCss.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
    return (m?.[1] ?? "").trim();
  };
  return { bg: read("bg"), surface: read("surface"), fg: read("fg"), accent: read("accent") };
}

export function handleListDesignSystems(res: ServerResponse, deps: AppDeps): void {
  const registry = deps.designRegistry ?? defaultRegistry();
  const list = registry.list().map((s) => ({
    id: s.id,
    name: s.name,
    category: s.category,
    summary: s.summary,
    swatch: parseSwatch(s.tokensCss),
    origin: BUILT_IN_IDS.has(s.id) ? "built-in" : "custom",
  }));
  sendJson(res, 200, list);
}

export function handleGetDesignSystem(res: ServerResponse, params: Record<string, string>, deps: AppDeps): void {
  const registry = deps.designRegistry ?? defaultRegistry();
  const s = registry.get(params.id!);
  if (!s) return sendError(res, 404, "design system not found");
  sendJson(res, 200, {
    id: s.id,
    name: s.name,
    category: s.category,
    summary: s.summary,
    swatch: parseSwatch(s.tokensCss),
    designMd: s.designMd,
    tokensCss: s.tokensCss,
  });
}

/** POST /api/design-systems/import — generate a brand system from a few inputs, persist it, register it. */
export async function handleImportBrand(req: IncomingMessage, res: ServerResponse, deps: AppDeps): Promise<void> {
  const body = (await readJsonBody(req)) as
    | { name?: string; accent?: string; displayFont?: string; bodyFont?: string; vibe?: string; category?: string }
    | null;
  if (!body || typeof body !== "object") return sendError(res, 400, "body must be an object");
  if (typeof body.name !== "string" || body.name.trim().length === 0) return sendError(res, 400, "name is required");
  if (typeof body.accent !== "string" || !isHexColor(body.accent)) return sendError(res, 400, "accent must be a hex colour");

  const registry = deps.designRegistry ?? defaultRegistry();
  const brand = buildBrandSystem({
    name: body.name,
    accent: body.accent,
    displayFont: body.displayFont,
    bodyFont: body.bodyFont,
    vibe: body.vibe,
    category: body.category,
  });
  if (registry.has(brand.id)) return sendError(res, 409, `a design system named "${brand.name}" already exists`);

  // Persist to the user design dir so it survives restarts, then register live.
  const dir = join(userDesignDir(deps.dataDir), brand.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "DESIGN.md"), brand.designMd, "utf8");
  await writeFile(join(dir, "tokens.css"), brand.tokensCss, "utf8");
  await writeFile(join(dir, "manifest.json"), JSON.stringify(brand.manifest, null, 2), "utf8");
  registry.register({
    id: brand.id,
    name: brand.name,
    category: brand.category,
    summary: brand.summary,
    designMd: brand.designMd,
    tokensCss: brand.tokensCss,
    craft: (brand.manifest.craft as DesignSystemCraft | undefined) ?? { applies: ["typography", "color", "anti-ai-slop"] },
  });

  sendJson(res, 201, { id: brand.id, name: brand.name, category: brand.category, summary: brand.summary, swatch: parseSwatch(brand.tokensCss), origin: "custom" });
}

export function handleListSkills(res: ServerResponse): void {
  const list = skills().map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    mode: s.mode,
    triggers: s.triggers,
    designSystem: s.designSystem,
  }));
  sendJson(res, 200, list);
}
