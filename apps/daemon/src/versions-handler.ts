/**
 * Per-run artifact snapshots (version history). Each successful run writes
 * `.versions/<runId>.html`; these endpoints serve a snapshot for preview and
 * restore one back to the live index.html.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { sendJson, sendError } from "./http-util.ts";
import { projectDir } from "./serve-static.ts";
import type { AppDeps } from "./app.ts";
import { captureCover } from "./capture-cover.ts";

function snapshotPath(deps: AppDeps, projectId: string, runId: string): string {
  // runId is path-segment-safe (a UUID); guard against traversal anyway.
  const safe = runId.replace(/[^a-zA-Z0-9-]/g, "");
  return join(projectDir(deps.dataDir, projectId), ".versions", `${safe}.html`);
}

export async function handleGetVersion(res: ServerResponse, params: Record<string, string>, deps: AppDeps): Promise<void> {
  if (!deps.store.getProject(params.id!)) return sendError(res, 404, "project not found");
  const file = snapshotPath(deps, params.id!, params.runId!);
  if (!existsSync(file)) return sendError(res, 404, "no snapshot for this run");
  const html = await readFile(file, "utf8");
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "sandbox allow-scripts allow-downloads;",
  });
  res.end(html);
}

export async function handleRestoreVersion(res: ServerResponse, params: Record<string, string>, deps: AppDeps): Promise<void> {
  if (!deps.store.getProject(params.id!)) return sendError(res, 404, "project not found");
  const file = snapshotPath(deps, params.id!, params.runId!);
  if (!existsSync(file)) return sendError(res, 404, "no snapshot for this run");
  const html = await readFile(file, "utf8");
  await writeFile(join(projectDir(deps.dataDir, params.id!), "index.html"), html, "utf8");
  sendJson(res, 200, { ok: true });
}

export async function handleSetVersionCover(res: ServerResponse, params: Record<string, string>, deps: AppDeps): Promise<void> {
  if (!deps.store.getProject(params.id!)) return sendError(res, 404, "project not found");
  const file = snapshotPath(deps, params.id!, params.runId!);
  if (!existsSync(file)) return sendError(res, 404, "no snapshot for this run");
  const outPath = join(projectDir(deps.dataDir, params.id!), ".cover.png");
  const captured = await (deps.captureCover ?? captureCover)(file, outPath);
  sendJson(res, 200, { captured });
}
