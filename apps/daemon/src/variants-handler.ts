/**
 * Variant branches. The ACTIVE branch's files live at the project root, so the whole
 * serve/run/export pipeline is unchanged. Inactive branches are snapshotted under
 * <projectDir>/.variants/<id>/. Only switch/create/delete move file trees.
 */

import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, sendError, readJsonBody } from "./http-util.ts";
import { projectDir } from "./serve-static.ts";
import type { AppDeps } from "./app.ts";

// Daemon-internal entries that are never part of a branch's artifact.
const SKIP = new Set([".variants", ".refs", ".versions", ".cover.png", "node_modules", ".git", ".dev"]);

function snapDir(dataDir: string, projectId: string, variantId: string): string {
  return join(projectDir(dataDir, projectId), ".variants", variantId);
}

async function artifactEntries(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((e) => !SKIP.has(e));
}

async function snapshot(rootDir: string, dest: string): Promise<void> {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  for (const e of await artifactEntries(rootDir)) await cp(join(rootDir, e), join(dest, e), { recursive: true });
}

async function restore(src: string, rootDir: string): Promise<void> {
  for (const e of await artifactEntries(rootDir)) await rm(join(rootDir, e), { recursive: true, force: true });
  for (const e of await artifactEntries(src)) await cp(join(src, e), join(rootDir, e), { recursive: true });
}

export function handleListVariants(res: ServerResponse, params: Record<string, string>, deps: AppDeps): void {
  const id = params.id!;
  if (!deps.store.getProject(id)) return sendError(res, 404, "project not found");
  deps.store.ensureMainVariant(id);
  sendJson(res, 200, deps.store.listVariants(id));
}

export async function handleCreateVariant(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, deps: AppDeps): Promise<void> {
  const id = params.id!;
  if (!deps.store.getProject(id)) return sendError(res, 404, "project not found");
  const body = (await readJsonBody(req)) as { name?: string } | null;
  const active = deps.store.ensureMainVariant(id);
  const root = projectDir(deps.dataDir, id);
  // Forking: save the current branch, then the new branch starts as a copy of root.
  await snapshot(root, snapDir(deps.dataDir, id, active.id));
  const n = deps.store.listVariants(id).length + 1;
  const v = deps.store.createVariant(id, body?.name?.trim() || `Variant ${n}`);
  deps.store.setActiveVariant(id, v.id);
  sendJson(res, 200, deps.store.listVariants(id));
}

export async function handleActivateVariant(res: ServerResponse, params: Record<string, string>, deps: AppDeps): Promise<void> {
  const id = params.id!;
  const vid = params.vid!;
  if (!deps.store.getProject(id) || deps.store.getVariant(vid)?.projectId !== id) return sendError(res, 404, "not found");
  const active = deps.store.getActiveVariantId(id);
  if (active !== vid) {
    const root = projectDir(deps.dataDir, id);
    if (active) await snapshot(root, snapDir(deps.dataDir, id, active));
    await restore(snapDir(deps.dataDir, id, vid), root);
    await rm(snapDir(deps.dataDir, id, vid), { recursive: true, force: true });
    deps.store.setActiveVariant(id, vid);
  }
  sendJson(res, 200, deps.store.listVariants(id));
}

export async function handleRenameVariant(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, deps: AppDeps): Promise<void> {
  const id = params.id!;
  const vid = params.vid!;
  if (deps.store.getVariant(vid)?.projectId !== id) return sendError(res, 404, "not found");
  const body = (await readJsonBody(req)) as { name?: string } | null;
  if (!body?.name?.trim()) return sendError(res, 400, "name is required");
  deps.store.renameVariant(vid, body.name.trim());
  sendJson(res, 200, deps.store.listVariants(id));
}

export async function handleDeleteVariant(res: ServerResponse, params: Record<string, string>, deps: AppDeps): Promise<void> {
  const id = params.id!;
  const vid = params.vid!;
  if (deps.store.getVariant(vid)?.projectId !== id) return sendError(res, 404, "not found");
  if (deps.store.getActiveVariantId(id) === vid) return sendError(res, 409, "switch to another branch before deleting this one");
  if (deps.store.listVariants(id).length <= 1) return sendError(res, 409, "a project needs at least one branch");
  await rm(snapDir(deps.dataDir, id, vid), { recursive: true, force: true });
  deps.store.deleteVariant(vid);
  sendJson(res, 200, deps.store.listVariants(id));
}
