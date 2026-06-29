/**
 * POST /api/projects/:id/refs — upload a reference file (image or text) the agent
 * can use as context. Stored under the project's hidden `.refs/` dir (excluded from
 * Files/Export); the run brief points the agent at `./.refs/<name>`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson, sendError } from "./http-util.ts";
import { projectDir } from "./serve-static.ts";
import type { AppDeps } from "./app.ts";

interface RefBody {
  name?: string;
  contentBase64?: string;
}

/** Keep only a safe basename — strip paths and unusual chars to block traversal. */
function safeName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "ref";
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "ref";
}

export async function handleUploadRef(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  if (!deps.store.getProject(params.id!)) return sendError(res, 404, "project not found");
  const body = (await readJsonBody(req)) as RefBody;
  if (typeof body.name !== "string" || !body.name) return sendError(res, 400, "name is required");
  if (typeof body.contentBase64 !== "string") return sendError(res, 400, "contentBase64 is required");

  const name = safeName(body.name);
  const dir = join(projectDir(deps.dataDir, params.id!), ".refs");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), Buffer.from(body.contentBase64, "base64"));
  sendJson(res, 200, { name, path: `.refs/${name}` });
}
