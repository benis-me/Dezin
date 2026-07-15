/**
 * Per-run artifact snapshots (version history). Prototype runs write
 * `.versions/<runId>.html`; Standard runs use the persisted git commit hash.
 */

import { existsSync } from "node:fs";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { contentTypeFor, send, sendJson, sendError } from "./http-util.ts";
import { injectRuntimeProbe, injectSelectBridge, projectDir, safeJoin, serveFileFromBase } from "./serve-static.ts";
import type { AppDeps, DevServerLease } from "./app.ts";
import { captureCoverUrl } from "./capture-cover.ts";
import { ensureDevServer } from "./project-runtime.ts";
import { issuePreviewBridgeCapability, requirePreviewLease } from "./preview-lease.ts";
import {
  activeArtifactDir,
  diffStandardArtifactDirFromCommit,
  restoreStandardArtifactDirFromCommit,
  standardVariantArtifactDir,
  standardVersionArtifactDir,
  versionRuntimeKey,
} from "./variant-workspaces.ts";
import {
  assertStandardRunSourceClean,
  standardSourceMutationKey,
  withStandardSourceMutationLock,
} from "./standard-run-transaction.ts";
import type { Project, Run } from "../../../packages/core/src/index.ts";
import {
  clonePrototypeVersionFiles,
  isPrototypeVersionRenderAssetFile,
  isPrototypeVersionRenderAssetPath,
  prototypeVersionAssetManifest,
  prototypeVersionFilesDir,
  prototypeVersionHtmlPath,
  restorePrototypeVersionSnapshot,
  rewritePrototypeVersionAssetUrls,
  rewritePrototypeVersionCssAssetUrls,
} from "./prototype-version-snapshot.ts";

type DiffLine = { t: "ctx" | "add" | "del"; text: string };
const MAX_EXACT_DIFF_CELLS = 1_000_000;

function rawTextDiffLines(before: string, after: string): DiffLine[] {
  if (before === after) return [];
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > MAX_EXACT_DIFF_CELLS) {
    return [
      ...a.map((text): DiffLine => ({ t: "del", text })),
      ...b.map((text): DiffLine => ({ t: "add", text })),
    ];
  }
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ t: "ctx", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      lines.push({ t: "del", text: a[i++]! });
    } else {
      lines.push({ t: "add", text: b[j++]! });
    }
  }
  while (i < a.length) lines.push({ t: "del", text: a[i++]! });
  while (j < b.length) lines.push({ t: "add", text: b[j++]! });
  return lines;
}

function projectRun(deps: AppDeps, projectId: string, runId: string): { project: Project; run: Run } | null {
  const project = deps.store.getProject(projectId);
  const run = deps.store.getRun(runId);
  if (!project || !run || run.projectId !== projectId) return null;
  return { project, run };
}

function stripUnavailableVisualEvidence(findings: Run["findings"]): Run["findings"] {
  return findings.map((finding) => {
    const { screenshotPath: _screenshotPath, screenshotUrl: _screenshotUrl, ...rest } = finding;
    return {
      ...rest,
      reviewSummary: finding.reviewSummary
        ? `${finding.reviewSummary} Historical screenshot evidence is unavailable for this restored identity.`
        : undefined,
    };
  });
}

async function cloneRestoredEvidence(
  deps: AppDeps,
  projectId: string,
  sourceRunId: string,
  restoredRunId: string,
  findings: Run["findings"],
): Promise<{ findings: Run["findings"]; copied: boolean }> {
  const sourceDir = join(deps.dataDir, "version-evidence", projectId, sourceRunId, "visual");
  if (!existsSync(sourceDir)) return { findings: stripUnavailableVisualEvidence(findings), copied: false };
  const restoredDir = join(deps.dataDir, "version-evidence", projectId, restoredRunId, "visual");
  await cp(sourceDir, restoredDir, { recursive: true, force: false, errorOnExist: false });
  const sourcePrefix = `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(sourceRunId)}/evidence/`;
  const restoredPrefix = `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(restoredRunId)}/evidence/`;
  return {
    copied: true,
    findings: findings.map((finding) => {
      if (!finding.screenshotUrl?.includes(sourcePrefix)) {
        const { screenshotPath: _screenshotPath, screenshotUrl: _screenshotUrl, ...rest } = finding;
        return rest;
      }
      return {
        ...finding,
        screenshotPath: undefined,
        screenshotUrl: finding.screenshotUrl.replace(sourcePrefix, restoredPrefix),
      };
    }),
  };
}

async function recordRestoredRun(
  deps: AppDeps,
  found: { project: Project; run: Run },
  targetVariantId: string,
  commitHash?: string,
): Promise<{ run: Run; findings: Run["findings"]; evidenceCopied: boolean }> {
  const restored = deps.store.createImportedRun(found.project.id, found.run.conversationId, {
    variantId: targetVariantId,
    userMessageId: found.run.userMessageId,
    assistantMessageId: found.run.assistantMessageId,
    commitHash: commitHash ?? null,
    // Prepared rows are deliberately non-current until the caller has also persisted every
    // mode-specific snapshot/commit identity and can atomically mark the row succeeded.
    status: "failed",
    repairRounds: found.run.repairRounds,
    lintPassed: found.run.lintPassed,
    score: found.run.score,
    findings: [],
    finishedAt: Date.now(),
    model: found.run.model,
    agentCommand: found.run.agentCommand,
    skillId: found.run.skillId,
  });
  try {
    const evidence = await cloneRestoredEvidence(deps, found.project.id, found.run.id, restored.id, found.run.findings);
    return { run: restored, findings: evidence.findings, evidenceCopied: evidence.copied };
  } catch {
    return { run: restored, findings: stripUnavailableVisualEvidence(found.run.findings), evidenceCopied: false };
  }
}

function versionPreviewPath(projectId: string, runId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(runId)}`;
}

function daemonRequestOrigin(req: IncomingMessage): string | null {
  const port = req.socket.localPort;
  const address = req.socket.localAddress;
  if (!port || !address) return null;
  const normalized = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  const host = normalized.includes(":") ? `[${normalized}]` : normalized;
  return `http://${host}:${port}`;
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
  const file = prototypeVersionHtmlPath(deps.dataDir, params.id!, params.runId!);
  if (!existsSync(file)) return sendError(res, 404, "no snapshot for this run");
  const snapshot = rewritePrototypeVersionAssetUrls(await readFile(file, "utf8"), found.project.id, found.run.id);
  const html = injectRuntimeProbe(injectSelectBridge(snapshot));
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "sandbox allow-scripts allow-downloads;",
  });
  res.end(html);
}

export async function handleGetVersionSource(res: ServerResponse, params: Record<string, string>, deps: AppDeps): Promise<void> {
  const found = projectRun(deps, params.id!, params.runId!);
  if (!found) return sendError(res, 404, "project not found");
  if (found.project.mode === "standard") return sendError(res, 400, "saved Standard source files are not available through this endpoint");
  const file = prototypeVersionHtmlPath(deps.dataDir, found.project.id, found.run.id);
  if (!existsSync(file)) return sendError(res, 404, "no snapshot for this run");
  try {
    return send(res, 200, await readFile(file, "utf8"), "text/plain; charset=utf-8");
  } catch {
    return sendError(res, 404, "no snapshot for this run");
  }
}

export async function handleGetVersionFile(
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const found = projectRun(deps, params.id!, params.runId!);
  if (!found || found.project.mode === "standard") return sendError(res, 404, "version file not found");
  const root = prototypeVersionFilesDir(deps.dataDir, found.project.id, found.run.id);
  if (!existsSync(root)) return sendError(res, 404, "version file not found");
  const rel = params.rest ?? "";
  if (!safeJoin(root, rel)) return sendError(res, 400, "invalid path");
  if (!isPrototypeVersionRenderAssetPath(rel)) return sendError(res, 404, "version file not found");
  if (!await isPrototypeVersionRenderAssetFile(root, rel)) return sendError(res, 404, "version file not found");
  res.setHeader("access-control-allow-origin", "*");
  if (rel.toLowerCase().endsWith(".css")) {
    const target = safeJoin(root, rel)!;
    try {
      return send(
        res,
        200,
        rewritePrototypeVersionCssAssetUrls(await readFile(target, "utf8"), found.project.id, found.run.id),
        contentTypeFor(target),
      );
    } catch {
      return sendError(res, 404, "version file not found");
    }
  }
  return serveFileFromBase(res, root, rel);
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
      const lease = requirePreviewLease(
        await standardVersionPreviewLease(deps, found.project, found.run, signal),
        "version preview runtime",
      );
      sendJson(res, 200, {
        url: lease.url,
        mode: "standard",
        leaseId: lease.leaseId,
        bridgeNonce: lease.bridgeNonce,
        expiresAt: lease.expiresAt,
      });
    } catch (err) {
      sendError(res, err instanceof Error && err.message === "no snapshot for this run" ? 404 : 409, err instanceof Error ? err.message : "version unavailable");
    }
    return;
  }
  const file = prototypeVersionHtmlPath(deps.dataDir, params.id!, params.runId!);
  if (!existsSync(file)) return sendError(res, 404, "no snapshot for this run");
  sendJson(res, 200, {
    ...issuePreviewBridgeCapability(versionPreviewPath(found.project.id, found.run.id)),
    mode: "prototype",
  });
}

export async function handleGetVersionDiff(res: ServerResponse, params: Record<string, string>, deps: AppDeps): Promise<void> {
  const found = projectRun(deps, params.id!, params.runId!);
  if (!found) return sendError(res, 404, "project not found");
  if (found.project.mode !== "standard") {
    const snapshotPath = prototypeVersionHtmlPath(deps.dataDir, found.project.id, found.run.id);
    const livePath = join(projectDir(deps.dataDir, found.project.id), "index.html");
    if (!existsSync(snapshotPath)) return sendError(res, 404, "no snapshot for this run");
    if (!existsSync(livePath)) return sendError(res, 409, "current artifact is unavailable");
    try {
      const liveRoot = projectDir(deps.dataDir, found.project.id);
      const snapshotRoot = prototypeVersionFilesDir(deps.dataDir, found.project.id, found.run.id);
      const [snapshot, live, snapshotAssets, liveAssets] = await Promise.all([
        readFile(snapshotPath, "utf8"),
        readFile(livePath, "utf8"),
        prototypeVersionAssetManifest(snapshotRoot),
        prototypeVersionAssetManifest(liveRoot),
      ]);
      const lines = rawTextDiffLines(snapshot, live);
      const oldAssets = new Map(snapshotAssets.map((asset) => [asset.path, asset]));
      const newAssets = new Map(liveAssets.map((asset) => [asset.path, asset]));
      for (const path of [...new Set([...oldAssets.keys(), ...newAssets.keys()])].sort()) {
        const before = oldAssets.get(path);
        const after = newAssets.get(path);
        if (before?.sha256 === after?.sha256) continue;
        if (before) lines.push({ t: "del", text: `[asset] ${path} ${before.bytes} bytes sha256:${before.sha256.slice(0, 12)}` });
        if (after) lines.push({ t: "add", text: `[asset] ${path} ${after.bytes} bytes sha256:${after.sha256.slice(0, 12)}` });
      }
      return sendJson(res, 200, lines);
    } catch (err) {
      return sendError(res, 409, err instanceof Error ? err.message : "version diff unavailable");
    }
  }
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
  if (found.run.status !== "succeeded") return sendError(res, 409, "only a succeeded version can be restored");
  if (found.project.mode === "standard") {
    const targetVariantId = deps.store.getActiveVariantId(found.project.id) ?? deps.store.ensureMainVariant(found.project.id).id;
    if (deps.store.findActiveRun(found.project.id, targetVariantId)) {
      return sendError(res, 409, "wait for the active Run to finish before restoring a version");
    }
    if (!found.run.commitHash) return sendError(res, 404, "no snapshot for this run");
    try {
      const targetDir = await standardVariantArtifactDir(deps, found.project.id, targetVariantId);
      const mutationKey = await standardSourceMutationKey(targetDir);
      const result = await withStandardSourceMutationLock(mutationKey, async () => {
        await assertStandardRunSourceClean(targetDir);
        let recorded: { ok: true; commitHash: string; runId: string; historyRecorded: true; evidenceCopied: boolean } | undefined;
        const commitHash = await restoreStandardArtifactDirFromCommit(targetDir, found.run.commitHash!, {
          afterCommit: async (restoredCommit) => {
            const restored = await recordRestoredRun(deps, found, targetVariantId, restoredCommit);
          const restoredRun = deps.store.updateRun(restored.run.id, {
            status: "succeeded",
            findings: restored.findings,
            finishedAt: Date.now(),
          });
            recorded = { ok: true, commitHash: restoredCommit, runId: restoredRun.id, historyRecorded: true, evidenceCopied: restored.evidenceCopied };
          },
        });
        if (!recorded) throw new Error(`version restore metadata was not recorded for ${commitHash}`);
        return recorded;
      });
      sendJson(res, 200, result);
    } catch (err) {
      return sendError(res, 409, err instanceof Error ? err.message : "version restore failed");
    }
    return;
  }
  const file = prototypeVersionHtmlPath(deps.dataDir, params.id!, params.runId!);
  if (!existsSync(file)) return sendError(res, 404, "no snapshot for this run");
  const html = await readFile(file, "utf8");
  try {
    const result = await withStandardSourceMutationLock(`prototype:${found.project.id}`, async () => {
      const targetVariantId = deps.store.getActiveVariantId(found.project.id) ?? deps.store.ensureMainVariant(found.project.id).id;
      if (deps.store.findActiveRun(found.project.id, targetVariantId)) {
        throw new Error("wait for the active Run to finish before restoring a version");
      }
      let recorded: { ok: true; runId: string; historyRecorded: true; evidenceCopied: boolean; assetsRestored: boolean } | undefined;
      await restorePrototypeVersionSnapshot({
        dataDir: deps.dataDir,
        projectId: found.project.id,
        sourceRunId: found.run.id,
        projectRoot: projectDir(deps.dataDir, found.project.id),
        html,
        afterRestore: async (assetsRestored) => {
          const restored = await recordRestoredRun(deps, found, targetVariantId);
          await writeFile(prototypeVersionHtmlPath(deps.dataDir, found.project.id, restored.run.id), html, "utf8");
          const assetsCloned = await clonePrototypeVersionFiles({
            dataDir: deps.dataDir,
            projectId: found.project.id,
            sourceRunId: found.run.id,
            restoredRunId: restored.run.id,
          });
          const completeAssets = assetsRestored && assetsCloned;
          const restoredFindings = completeAssets
            ? restored.findings
            : [
                ...restored.findings.filter((finding) => finding.id !== "version-assets-unavailable"),
                {
                  severity: "P1" as const,
                  id: "version-assets-unavailable",
                  message: "This legacy version has no captured local asset bundle, so its historical pixels are incomplete.",
                  fix: "Regenerate or re-import the version with its original images, fonts, and styles before treating it as visually approved.",
                },
              ];
          const restoredRun = deps.store.updateRun(restored.run.id, {
            status: "succeeded",
            findings: restoredFindings,
            lintPassed: completeAssets ? restored.run.lintPassed : false,
            score: completeAssets ? restored.run.score : null,
            finishedAt: Date.now(),
          });
          recorded = {
            ok: true,
            runId: restoredRun.id,
            historyRecorded: true,
            evidenceCopied: restored.evidenceCopied,
            assetsRestored: completeAssets,
          };
        },
      });
      if (!recorded) throw new Error("version restore metadata was not recorded");
      return recorded;
    });
    sendJson(res, 200, result);
  } catch (err) {
    sendError(res, 409, err instanceof Error ? err.message : "version restore failed");
  }
}

export async function handleSetVersionCover(
  req: IncomingMessage,
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
  const file = prototypeVersionHtmlPath(deps.dataDir, params.id!, params.runId!);
  if (!existsSync(file)) return sendError(res, 404, "no snapshot for this run");
  const origin = daemonRequestOrigin(req);
  if (!origin) return sendError(res, 409, "version cover URL unavailable");
  try {
    const url = new URL(versionPreviewPath(found.project.id, found.run.id), origin).href;
    const captured = await (deps.captureCoverUrl ?? captureCoverUrl)(url, outPath, signal);
    sendJson(res, 200, { captured });
  } catch (err) {
    sendError(res, 409, err instanceof Error ? err.message : "cover capture failed");
  }
}
