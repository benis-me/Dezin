/**
 * Filesystem access for the research/ directory. The daemon uses these to write the
 * brief it distilled, to detect whether research exists, and to read the research
 * back as context for the build phase.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import {
  ASSETS_DIRNAME,
  assetsDir,
  briefPath,
  chosenPath,
  directionPath,
  directionsDir,
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

/** True when a research report has been produced for this project. */
export function researchExists(projectDir: string): boolean {
  return existsSync(reportPath(projectDir));
}

/** Create research/, research/assets/, research/directions/. Idempotent. */
export async function ensureResearchScaffold(projectDir: string): Promise<void> {
  await mkdir(assetsDir(projectDir), { recursive: true });
  await mkdir(directionsDir(projectDir), { recursive: true });
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

/** Record the candidate direction the user picked at the gate (overwrites any prior pick). */
export async function writeChosenDirection(projectDir: string, slug: string): Promise<void> {
  await mkdir(researchDir(projectDir), { recursive: true });
  await writeFile(chosenPath(projectDir), `${slug.trim()}\n`, "utf8");
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
  const parts = [
    `A research report has been produced in \`${basename(researchDir(projectDir))}/\`. It is authoritative — build on it, do not re-research.`,
  ];
  if (assets.length) {
    parts.push(`Reference imagery is available locally: ${assets.map((a) => `\`${join("research", a)}\``).join(", ")}.`);
  }
  if (chosenDirectionSlug) {
    const chosen = await readText(directionPath(projectDir, chosenDirectionSlug));
    if (chosen) parts.push(`## Chosen direction — build THIS one\n\n${chosen.trim()}`);
  }
  if (report) parts.push(`## Research report\n\n${report.trim()}`);
  if (visualReport) parts.push(`## Visual research (design-site inspiration)\n\n${visualReport.trim()}`);
  const visualAssets = await listVisualAssets(projectDir);
  if (visualAssets.length) {
    parts.push(`Visual reference imagery is available locally: ${visualAssets.map((a) => `\`${join("research", a)}\``).join(", ")}. Study these real screenshots as source material.`);
  }
  return parts.join("\n\n");
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
