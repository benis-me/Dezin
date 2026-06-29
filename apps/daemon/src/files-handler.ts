/**
 * GET /api/projects/:id/files — list the project's on-disk artifact files as
 * [{path, size}] (sorted). Backs the workspace Files tab.
 */

import { stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { sendJson, sendError } from "./http-util.ts";
import { projectDir } from "./serve-static.ts";
import { walkFiles } from "./export-handler.ts";
import type { AppDeps } from "./app.ts";

export async function handleListFiles(
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const id = params.id!;
  if (!deps.store.getProject(id)) return sendError(res, 404, "project not found");

  const files = await walkFiles(projectDir(deps.dataDir, id));
  const out = await Promise.all(files.map(async (f) => ({ path: f.rel, size: (await stat(f.abs)).size })));
  out.sort((a, b) => a.path.localeCompare(b.path));
  sendJson(res, 200, out);
}
