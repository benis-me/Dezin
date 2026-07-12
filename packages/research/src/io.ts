/**
 * Filesystem access for the research/ directory. The daemon uses these to write the
 * brief it distilled, to detect whether research exists, and to read the research
 * back as context for the build phase.
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import {
  ASSETS_DIRNAME,
  assetsDir,
  briefPath,
  chosenPath,
  directionPath,
  directionsDir,
  isSafeDirectionSlug,
  reportPath,
  researchDir,
  sourcesPath,
  VISUAL_DIRNAME,
  visualAssetsDir,
  visualDir,
  visualMoodboardPointerPath,
  visualReportPath,
  visualSourcesPath,
} from "./convention.ts";
import { buildBriefMarkdown, parseBriefMarkdown } from "./brief.ts";
import { parseSources, serializeSources } from "./sources.ts";
import type { ResearchBrief, ResearchSource } from "./types.ts";

export type ResearchBundleArea = "product" | "visual" | "directions";

export interface ResearchBundleIssue {
  area: ResearchBundleArea;
  code: string;
  message: string;
  path?: string;
}

export interface ResearchBundleValidation {
  complete: boolean;
  issues: ResearchBundleIssue[];
}

const MIN_REPORT_CHARS = 80;
const MIN_DIRECTION_CHARS = 120;
const IMAGE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);

function meaningfulReport(markdown: string | null): boolean {
  return (markdown?.trim().length ?? 0) >= MIN_REPORT_CHARS;
}

function meaningfulDirection(markdown: string): boolean {
  const trimmed = markdown.trim();
  const contentLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const hasSection = (name: string): boolean =>
    new RegExp(`(?:^|\\n)(?:#{1,6}\\s+${name}\\s*$|${name}\\s*:)`, "im").test(trimmed);
  return (
    trimmed.length >= MIN_DIRECTION_CHARS &&
    contentLines.length >= 3 &&
    hasSection("Concept") &&
    hasSection("Structure") &&
    hasSection("Distinctive move")
  );
}

function isWebUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function hasImageSignature(bytes: Buffer, extension: string): boolean {
  if (extension === ".svg") return /<svg(?:\s|>)/i.test(bytes.subarray(0, 1024).toString("utf8"));
  if (extension === ".png") return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (extension === ".jpg" || extension === ".jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (extension === ".gif") return bytes.subarray(0, 4).toString("ascii") === "GIF8";
  if (extension === ".webp") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (extension === ".bmp") return bytes.subarray(0, 2).toString("ascii") === "BM";
  if (extension === ".ico") return bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0;
  if (extension === ".avif") return bytes.subarray(4, 8).toString("ascii") === "ftyp" && /avi[fs]/.test(bytes.subarray(8, 16).toString("ascii"));
  return false;
}

async function invalidImageAssets(projectDir: string, assets: string[], requireImages: boolean): Promise<Set<string>> {
  const invalid = new Set<string>();
  await Promise.all(
    assets.map(async (asset) => {
      const extension = extname(asset).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(extension)) {
        if (requireImages) invalid.add(asset);
        return;
      }
      try {
        if (!hasImageSignature(await readFile(join(researchDir(projectDir), asset)), extension)) invalid.add(asset);
      } catch {
        invalid.add(asset);
      }
    }),
  );
  return invalid;
}

function validateTrack(input: {
  area: "product" | "visual";
  report: string | null;
  sources: ResearchSource[];
  assets: string[];
  invalidAssets: Set<string>;
}): ResearchBundleIssue[] {
  const { area, report, sources, assets, invalidAssets } = input;
  const label = area === "product" ? "Product" : "Visual";
  const issues: ResearchBundleIssue[] = [];
  if (!report) {
    issues.push({ area, code: `${area}-report-missing`, message: `${label} research report is missing.` });
  } else if (!meaningfulReport(report)) {
    issues.push({ area, code: `${area}-report-thin`, message: `${label} research report is too short to ground a build.` });
  }
  if (!sources.length) {
    issues.push({ area, code: `${area}-sources-missing`, message: `${label} research sources are missing or invalid.` });
  }
  for (const source of sources) {
    if (!source.takeaways.some((takeaway) => takeaway.trim())) {
      issues.push({
        area,
        code: `${area}-source-takeaways-missing`,
        message: `${label} source ${source.id} has no evidence takeaway.`,
        path: source.id,
      });
    }
    if (source.kind !== "asset" && !isWebUrl(source.url)) {
      issues.push({
        area,
        code: `${area}-source-provenance-missing`,
        message: `${label} source ${source.id} has no valid http(s) provenance URL.`,
        path: source.id,
      });
    }
    if (area === "product" && source.authority !== "primary" && source.authority !== "secondary") {
      issues.push({
        area,
        code: "product-source-authority-unknown",
        message: `Product source ${source.id} must declare primary or secondary authority.`,
        path: source.id,
      });
    }
    if (area === "visual" && source.assets.length > 0 && source.reached !== true) {
      issues.push({
        area,
        code: "visual-source-unreached",
        message: `Visual source ${source.id} has local imagery but is not marked reached.`,
        path: source.id,
      });
    }
    if (report && !report.toLowerCase().includes(source.id.toLowerCase())) {
      issues.push({
        area,
        code: `${area}-report-citation-missing`,
        message: `${label} report does not cite source id ${source.id}.`,
        path: source.id,
      });
    }
  }
  if (!assets.length) {
    issues.push({ area, code: `${area}-assets-missing`, message: `${label} research has no local reference assets.` });
  }
  for (const asset of invalidAssets) {
    issues.push({
      area,
      code: `${area}-asset-invalid`,
      message: `${label} asset is not a valid local image: ${asset}.`,
      path: asset,
    });
  }

  const available = new Map(
    assets.map((asset) => [area === "visual" ? asset.replace(/^visual\//, "") : asset, asset] as const),
  );
  const referenced = new Set(sources.flatMap((source) => source.assets));
  for (const asset of referenced) {
    if (!available.has(asset)) {
      issues.push({
        area,
        code: `${area}-asset-missing`,
        message: `${label} source references a local asset that does not exist: ${asset}.`,
        path: asset,
      });
    }
  }
  for (const [asset, path] of available) {
    if (referenced.has(asset)) continue;
    issues.push({
      area,
      code: `${area}-assets-unreferenced`,
      message: `${label} local asset is not linked from any source: ${path}.`,
      path: asset,
    });
  }
  return issues;
}

/** True when a research report has been produced for this project. */
export function researchExists(projectDir: string): boolean {
  return existsSync(reportPath(projectDir));
}

/** Create research/, research/assets/, research/directions/. Idempotent. */
export async function ensureResearchScaffold(projectDir: string): Promise<void> {
  await mkdir(assetsDir(projectDir), { recursive: true });
  await mkdir(directionsDir(projectDir), { recursive: true });
}

/** Remove generated Research outputs while preserving the distilled brief itself. */
export async function resetResearchBundle(projectDir: string): Promise<void> {
  await Promise.all([
    rm(reportPath(projectDir), { force: true }),
    rm(sourcesPath(projectDir), { force: true }),
    rm(assetsDir(projectDir), { recursive: true, force: true }),
    rm(directionsDir(projectDir), { recursive: true, force: true }),
    rm(chosenPath(projectDir), { force: true }),
    rm(visualDir(projectDir), { recursive: true, force: true }),
  ]);
}

export async function writeBrief(projectDir: string, brief: ResearchBrief): Promise<void> {
  await mkdir(researchDir(projectDir), { recursive: true });
  await writeFile(briefPath(projectDir), buildBriefMarkdown(brief), "utf8");
}

export async function readBrief(projectDir: string): Promise<ResearchBrief | null> {
  const text = await readText(briefPath(projectDir));
  return text === null ? null : parseBriefMarkdown(text);
}

export async function writeSources(projectDir: string, sources: ResearchSource[]): Promise<void> {
  await mkdir(researchDir(projectDir), { recursive: true });
  await writeFile(sourcesPath(projectDir), serializeSources(sources), "utf8");
}

export async function readSources(projectDir: string): Promise<ResearchSource[]> {
  return parseSources(await readText(sourcesPath(projectDir)));
}

export async function writeReport(projectDir: string, markdown: string): Promise<void> {
  await mkdir(researchDir(projectDir), { recursive: true });
  await writeFile(reportPath(projectDir), markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf8");
}

export async function readReport(projectDir: string): Promise<string | null> {
  return readText(reportPath(projectDir));
}

/** Relative asset paths (research/assets/*) that actually exist on disk. */
export async function listAssets(projectDir: string): Promise<string[]> {
  try {
    const entries = await readdir(assetsDir(projectDir), { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => `${ASSETS_DIRNAME}/${e.name}`);
  } catch {
    return [];
  }
}

/** Candidate direction slugs + raw markdown, for the direction gate. */
export async function listDirections(projectDir: string): Promise<Array<{ slug: string; markdown: string }>> {
  let slugs: string[];
  try {
    const entries = await readdir(directionsDir(projectDir), { withFileTypes: true });
    slugs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
  const out: Array<{ slug: string; markdown: string }> = [];
  for (const slug of slugs) {
    const markdown = await readText(directionPath(projectDir, slug));
    if (markdown !== null) out.push({ slug, markdown });
  }
  return out;
}

/** Read one safe candidate direction, or null when it is not a readable candidate on disk. */
export async function readCandidateDirection(projectDir: string, slug: string): Promise<string | null> {
  const normalized = slug.trim();
  if (!isSafeDirectionSlug(normalized)) return null;
  const markdown = await readText(directionPath(projectDir, normalized));
  return markdown?.trim() ? markdown : null;
}

/** Record the candidate direction the user picked at the gate (overwrites any prior pick). */
export async function writeChosenDirection(projectDir: string, slug: string): Promise<void> {
  const normalized = slug.trim();
  if (!isSafeDirectionSlug(normalized)) {
    throw new Error("Direction slug must name a safe candidate direction.");
  }
  if (!(await readCandidateDirection(projectDir, normalized))) {
    throw new Error("Selected candidate direction does not exist or could not be read.");
  }
  await mkdir(researchDir(projectDir), { recursive: true });
  await writeFile(chosenPath(projectDir), `${normalized}\n`, "utf8");
}

/** The slug the user picked at the gate, or null if none has been chosen yet. */
export async function readChosenDirection(projectDir: string): Promise<string | null> {
  const text = await readText(chosenPath(projectDir));
  const slug = text?.trim();
  return slug ? slug : null;
}

/** True when a visual research report has been produced for this project. */
export function visualResearchExists(projectDir: string): boolean {
  return existsSync(visualReportPath(projectDir));
}

export async function readVisualReport(projectDir: string): Promise<string | null> {
  return readText(visualReportPath(projectDir));
}

export async function readVisualSources(projectDir: string): Promise<ResearchSource[]> {
  // Visual sources are image-centric; tolerate a missing title (synthesize a label) so an image's
  // provenance (url/platform/designer) isn't silently dropped by the strict product-source parser.
  return parseSources(await readText(visualSourcesPath(projectDir)), { synthesizeTitle: true });
}

/** Relative asset paths (visual/assets/*) that actually exist on disk. */
export async function listVisualAssets(projectDir: string): Promise<string[]> {
  try {
    const entries = await readdir(visualAssetsDir(projectDir), { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => `${VISUAL_DIRNAME}/${ASSETS_DIRNAME}/${e.name}`).sort();
  } catch {
    return [];
  }
}

export async function readVisualMoodboardId(projectDir: string): Promise<string | null> {
  const raw = await readText(visualMoodboardPointerPath(projectDir));
  if (!raw) return null;
  try {
    const id = (JSON.parse(raw) as { boardId?: unknown }).boardId;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

export async function writeVisualMoodboardId(projectDir: string, boardId: string): Promise<void> {
  await mkdir(visualDir(projectDir), { recursive: true });
  await writeFile(visualMoodboardPointerPath(projectDir), `${JSON.stringify({ boardId }, null, 2)}\n`, "utf8");
}

/**
 * A compact research context block to prepend to the build phase's brief, so the
 * high-fidelity turn is grounded in the discovery it just did.
 */
export async function buildResearchContext(projectDir: string, chosenDirectionSlug?: string): Promise<string | null> {
  const report = await readReport(projectDir);
  const visualReport = await readVisualReport(projectDir);
  if (!report && !visualReport) return null;
  const assets = await listAssets(projectDir);
  const researchRel = basename(researchDir(projectDir)); // ".research" — the REAL on-disk dir (not "research")
  // The opening line asserts a *product* report exists — only true when one was actually
  // produced. A visual-only project (no product `report`) gets a visual-appropriate line
  // instead, so the build phase isn't told a product report exists when it doesn't.
  const parts = [
    report
      ? `A research report has been produced in \`${researchRel}/\`. It is authoritative — build on it, do not re-research.`
      : `Visual research has been produced in \`${researchRel}/${VISUAL_DIRNAME}/\`. It is authoritative for visual direction — build on it, do not re-research.`,
  ];
  if (assets.length) {
    parts.push(`Reference imagery is available locally: ${assets.map((a) => `\`${join(researchRel, a)}\``).join(", ")}.`);
  }
  if (chosenDirectionSlug) {
    const chosen = await readText(directionPath(projectDir, chosenDirectionSlug));
    if (chosen) parts.push(`## Chosen direction — build THIS one\n\n${chosen.trim()}`);
  }
  if (report) parts.push(`## Research report\n\n${report.trim()}`);
  if (visualReport) parts.push(`## Visual research (design-site inspiration)\n\n${visualReport.trim()}`);
  const visualAssets = await listVisualAssets(projectDir);
  if (visualAssets.length) {
    parts.push(
      `Reference screenshots are on disk: ${visualAssets.map((a) => `\`${join(researchRel, a)}\``).join(", ")}. Before you design, OPEN and study EACH of them with your file tools — they are PRIMARY visual evidence for the look, not decoration. Do not design from the text alone.`,
    );
  }
  return parts.join("\n\n");
}

/** Validate that Research produced enough evidence and direction detail to ground a build. */
export async function validateResearchBundle(projectDir: string): Promise<ResearchBundleValidation> {
  const [report, sources, assets, visualReport, visualSources, visualAssets, directions] = await Promise.all([
    readReport(projectDir),
    readSources(projectDir),
    listAssets(projectDir),
    readVisualReport(projectDir),
    readVisualSources(projectDir),
    listVisualAssets(projectDir),
    listDirections(projectDir),
  ]);
  const [invalidProductAssets, invalidVisualAssets] = await Promise.all([
    invalidImageAssets(projectDir, assets, true),
    invalidImageAssets(projectDir, visualAssets, true),
  ]);
  const issues = [
    ...validateTrack({ area: "product", report, sources, assets, invalidAssets: invalidProductAssets }),
    ...validateTrack({ area: "visual", report: visualReport, sources: visualSources, assets: visualAssets, invalidAssets: invalidVisualAssets }),
  ];

  const sourceIds = new Set<string>();
  for (const [area, trackSources] of [["product", sources], ["visual", visualSources]] as const) {
    for (const source of trackSources) {
      const key = source.id.trim().toLowerCase();
      if (sourceIds.has(key)) {
        issues.push({
          area,
          code: `${area}-source-id-duplicate`,
          message: `${area === "product" ? "Product" : "Visual"} source id is duplicated: ${source.id}.`,
          path: source.id,
        });
      } else {
        sourceIds.add(key);
      }
    }
  }

  const safeDirections = directions.filter((direction) => {
    if (isSafeDirectionSlug(direction.slug)) return true;
    issues.push({
      area: "directions",
      code: "direction-slug-unsafe",
      message: `Direction directory must use a safe kebab-case slug: ${direction.slug}.`,
      path: direction.slug,
    });
    return false;
  });
  for (const direction of safeDirections) {
    if (!meaningfulDirection(direction.markdown)) {
      issues.push({
        area: "directions",
        code: "direction-structure-missing",
        message: `Direction ${direction.slug} needs explicit Concept, Structure, and Distinctive move sections.`,
        path: direction.slug,
      });
    }
  }
  const meaningfulCount = safeDirections.filter((direction) => meaningfulDirection(direction.markdown)).length;
  if (meaningfulCount < 2 || meaningfulCount > 3) {
    issues.push({
      area: "directions",
      code: "directions-count",
      message: `Research must produce 2–3 meaningful directions; found ${meaningfulCount}.`,
    });
  }

  return { complete: issues.length === 0, issues };
}

/** True when at least one candidate direction dir exists on disk. */
export function directionsExist(projectDir: string): boolean {
  try {
    return readdirSync(directionsDir(projectDir), { withFileTypes: true }).some((e) => e.isDirectory());
  } catch {
    return false;
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
