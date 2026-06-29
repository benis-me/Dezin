/**
 * GET /api/projects/:id/files — list the project's on-disk artifact files as
 * [{path, size}] (sorted). Backs the workspace Files tab.
 */

import { stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { sendJson, sendError } from "./http-util.ts";
import { walkFiles } from "./export-handler.ts";
import type { AppDeps } from "./app.ts";
import { activeArtifactDir } from "./variant-workspaces.ts";

export async function handleListFiles(
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const id = params.id!;
  const project = deps.store.getProject(id);
  if (!project) return sendError(res, 404, "project not found");

  const files = await walkFiles(await activeArtifactDir(deps, project));
  const out = await Promise.all(files.map(async (f) => ({ path: f.rel, size: (await stat(f.abs)).size })));
  out.sort((a, b) => a.path.localeCompare(b.path));
  sendJson(res, 200, out);
}
