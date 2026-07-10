/**
 * Per-run artifact snapshots (version history). Prototype runs write
 * `.versions/<runId>.html`; Standard runs use the persisted git commit hash.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { sendJson, sendError } from "./http-util.ts";
import { injectSelectBridge, projectDir } from "./serve-static.ts";
import type { AppDeps, DevServerLease } from "./app.ts";
import { captureCover, captureCoverUrl } from "./capture-cover.ts";
import { ensureDevServer } from "./project-runtime.ts";
import {
  activeArtifactDir,
  diffStandardArtifactDirFromCommit,
  resetStandardArtifactDirToCommit,
  standardVersionArtifactDir,
  versionRuntimeKey,
} from "./variant-workspaces.ts";
import type { Project, Run } from "../../../packages/core/src/index.ts";

type DiffLine = { t: "ctx" | "add" | "del"; text: string };

function snapshotPath(deps: AppDeps, projectId: string, runId: string): string {
  // runId is path-segment-safe (a UUID); guard against traversal anyway.
  const safe = runId.replace(/[^a-zA-Z0-9-]/g, "");
  return join(projectDir(deps.dataDir, projectId), ".versions", `${safe}.html`);
}

function projectRun(deps: AppDeps, projectId: string, runId: string): { project: Project; run: Run } | null {
  const project = deps.store.getProject(projectId);
  const run = deps.store.getRun(runId);
  if (!project || !run || run.projectId !== projectId) return null;
  return { project, run };
}

function versionPreviewPath(projectId: string, runId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(runId)}`;
}

async function standardVersionPreviewLease(deps: AppDeps, project: Project, run: Run, signal?: AbortSignal): Promise<DevServerLease> {
  if (!run.commitHash) throw new Error("no snapshot for this run");
  const dir = await standardVersionArtifactDir(deps, project.id, run.id, run.commitHash);
  return (deps.ensureDevServer ?? ensureDevServer)(
    project.id,
    dir,
    versionRuntimeKey(project.id, run.id),
    signal,
    deps.previewLeaseManager,
  );
}

function gitDiffLines(text: string): DiffLine[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) return { t: "add", text: line.slice(1) };
      if (line.startsWith("-") && !line.startsWith("---")) return { t: "del", text: line.slice(1) };
      return { t: "ctx", text: line };
    });
}

export async function handleGetVersion(res: ServerResponse, params: Record<string, string>, deps: AppDeps): Promise<void> {
  const found = projectRun(deps, params.id!, params.runId!);
  if (!found) return sendError(res, 404, "project not found");
  if (found.project.mode === "standard") {
    try {
      const lease = await standardVersionPreviewLease(deps, found.project, found.run);
      res.writeHead(302, { location: lease.url });
      res.end();
      await lease.release?.();
    } catch (err) {
      sendError(res, err instanceof Error && err.message === "no snapshot for this run" ? 404 : 409, err instanceof Error ? err.message : "version unavailable");
    }
    return;
  }
  const file = snapshotPath(deps, params.id!, params.runId!);
  if (!existsSync(file)) return sendError(res, 404, "no snapshot for this run");
  const html = injectSelectBridge(await readFile(file, "utf8"));
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "sandbox allow-scripts allow-downloads;",
  });
  res.end(html);
}

export async function handleGetVersionPreviewUrl(
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
  signal?: AbortSignal,
): Promise<void> {
  const found = projectRun(deps, params.id!, params.runId!);
  if (!found) return sendError(res, 404, "project not found");
  if (found.project.mode === "standard") {
    try {
      const lease = await standardVersionPreviewLease(deps, found.project, found.run, signal);
      sendJson(res, 200, {
        url: lease.url,
        mode: "standard",
        leaseId: lease.leaseId,
        expiresAt: lease.expiresAt,
      });
    } catch (err) {
      sendError(res, err instanceof Error && err.message === "no snapshot for this run" ? 404 : 409, err instanceof Error ? err.message : "version unavailable");
    }
    return;
  }
  const file = snapshotPath(deps, params.id!, params.runId!);
  if (!existsSync(file)) return sendError(res, 404, "no snapshot for this run");
  sendJson(res, 200, { url: versionPreviewPath(found.project.id, found.run.id), mode: "prototype" });
}

export async function handleGetVersionDiff(res: ServerResponse, params: Record<string, string>, deps: AppDeps): Promise<void> {
  const found = projectRun(deps, params.id!, params.runId!);
  if (!found) return sendError(res, 404, "project not found");
  if (found.project.mode !== "standard") return sendError(res, 400, "version diff is only available for standard projects");
  if (!found.run.commitHash) return sendError(res, 404, "no snapshot for this run");
  try {
    const dir = await activeArtifactDir(deps, found.project);
    const diff = await diffStandardArtifactDirFromCommit(dir, found.run.commitHash);
    sendJson(res, 200, gitDiffLines(diff));
  } catch (err) {
    sendError(res, 409, err instanceof Error ? err.message : "version diff unavailable");
  }
}

export async function handleRestoreVersion(res: ServerResponse, params: Record<string, string>, deps: AppDeps): Promise<void> {
  const found = projectRun(deps, params.id!, params.runId!);
  if (!found) return sendError(res, 404, "project not found");
  if (found.project.mode === "standard") {
    if (!found.run.commitHash) return sendError(res, 404, "no snapshot for this run");
    try {
      await resetStandardArtifactDirToCommit(await activeArtifactDir(deps, found.project), found.run.commitHash);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendError(res, 409, err instanceof Error ? err.message : "version restore failed");
    }
    return;
  }
  const file = snapshotPath(deps, params.id!, params.runId!);
  if (!existsSync(file)) return sendError(res, 404, "no snapshot for this run");
  const html = await readFile(file, "utf8");
  await writeFile(join(projectDir(deps.dataDir, params.id!), "index.html"), html, "utf8");
  sendJson(res, 200, { ok: true });
}

export async function handleSetVersionCover(
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
  signal?: AbortSignal,
): Promise<void> {
  const found = projectRun(deps, params.id!, params.runId!);
  if (!found) return sendError(res, 404, "project not found");
  const outPath = join(projectDir(deps.dataDir, params.id!), ".cover.png");
  if (found.project.mode === "standard") {
    let lease: DevServerLease | undefined;
    try {
      lease = await standardVersionPreviewLease(deps, found.project, found.run, signal);
      signal?.throwIfAborted();
      const captured = await (deps.captureCoverUrl ?? captureCoverUrl)(lease.url, outPath, signal);
      sendJson(res, 200, { captured });
    } catch (err) {
      sendError(res, err instanceof Error && err.message === "no snapshot for this run" ? 404 : 409, err instanceof Error ? err.message : "cover capture failed");
    } finally {
      await lease?.release?.();
    }
    return;
  }
  const file = snapshotPath(deps, params.id!, params.runId!);
  if (!existsSync(file)) return sendError(res, 404, "no snapshot for this run");
  const captured = await (deps.captureCover ?? captureCover)(file, outPath);
  sendJson(res, 200, { captured });
}
