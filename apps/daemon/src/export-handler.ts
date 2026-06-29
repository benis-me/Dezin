/**
 * GET /api/projects/:id/export — zip the project's on-disk artifact folder and
 * return it as a download. Uses the dependency-free zip writer.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { ServerResponse } from "node:http";
import { sendError } from "./http-util.ts";
import { createZip, type ZipEntry } from "./zip.ts";
import type { AppDeps } from "./app.ts";
import { activeArtifactDir } from "./variant-workspaces.ts";

export interface FileRef {
  rel: string;
  abs: string;
}

// Dependency/build output dirs are never part of the design source.
const IGNORE_DIRS = new Set(["node_modules", "dist", "build", ".git"]);

export async function walkFiles(root: string, dir: string = root, out: FileRef[] = []): Promise<FileRef[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue; // skip internal dirs (.versions) + host noise (.impeccable)
    if (e.isDirectory() && IGNORE_DIRS.has(e.name)) continue; // skip node_modules / build output
    const abs = join(dir, e.name);
    if (e.isDirectory()) await walkFiles(root, abs, out);
    else if (e.isFile()) out.push({ rel: relative(root, abs).split(sep).join("/"), abs });
  }
  return out;
}

export async function handleExport(
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const id = params.id!;
  const project = deps.store.getProject(id);
  if (!project) return sendError(res, 404, "project not found");

  const dir = await activeArtifactDir(deps, project);
  const files = await walkFiles(dir);
  if (files.length === 0) return sendError(res, 404, "no artifacts to export");

  const entries: ZipEntry[] = await Promise.all(
    files.map(async (f) => ({ path: f.rel, data: await readFile(f.abs) })),
  );
  const zip = createZip(entries);

  res.writeHead(200, {
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="dezin-project-${id}.zip"`,
    "content-length": String(zip.length),
  });
  res.end(zip);
}
