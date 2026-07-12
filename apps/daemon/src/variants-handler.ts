/**
 * Variant branches. Prototype keeps the active branch at the project root and
 * snapshots inactive branches under <projectDir>/.variants/<id>/. Standard keeps
 * the first branch at the project root and backs additional branches with git
 * worktrees under <dataDir>/worktrees/<projectId>/<variantId>/.
 */

import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, sendError, readJsonBody } from "./http-util.ts";
import { projectDir } from "./serve-static.ts";
import type { AppDeps } from "./app.ts";
import type { Variant } from "../../../packages/core/src/index.ts";
import { planVariantFanout } from "./variant-fanout.ts";
import {
  createStandardVariantWorktree,
  createStandardVariantWorktreeFromCommit,
  isStandardRootVariant,
  removeStandardVariantWorktree,
  standardVariantArtifactDir,
  variantRuntimeKey,
} from "./variant-workspaces.ts";
import { RuntimeScopeUnavailableError } from "./runtime-supervisor.ts";
import { withStandardSourceMutationLock } from "./standard-run-transaction.ts";
import { restorePrototypeVersionSnapshot } from "./prototype-version-snapshot.ts";

// Daemon-internal entries that are never part of a branch's artifact.
const SKIP = new Set([".variants", ".refs", ".versions", ".cover.png", "node_modules", ".git", ".dev"]);
const VARIANT_BODY_MAX_BYTES = 4 * 1024 * 1024;

function snapDir(dataDir: string, projectId: string, variantId: string): string {
  return join(projectDir(dataDir, projectId), ".variants", variantId);
}

function withVariantMutation<T>(
  deps: AppDeps,
  projectId: string,
  variantId: string,
  start: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (deps.runtimeSupervisor) {
    return deps.runtimeSupervisor.trackOperation({ projectId, variantId }, start);
  }
  return start(new AbortController().signal);
}

async function releaseStandardPreview(deps: AppDeps, projectId: string, variantId: string): Promise<void> {
  if (deps.releaseDevServer) {
    await deps.releaseDevServer(variantRuntimeKey(projectId, variantId));
    return;
  }
  await deps.previewLeaseManager?.stopScope({ projectId, variantId });
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

export async function handleCreateVariant(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
  signal?: AbortSignal,
): Promise<void> {
  const id = params.id!;
  const project = deps.store.getProject(id);
  if (!project) return sendError(res, 404, "project not found");
  const body = (await readJsonBody(req, VARIANT_BODY_MAX_BYTES, signal)) as { name?: string } | null;
  signal?.throwIfAborted();
  const initialActive = deps.store.ensureMainVariant(id);
  const n = deps.store.listVariants(id).length + 1;
  const v = deps.store.createVariant(id, body?.name?.trim() || `Variant ${n}`);
  let mutationLease: { release: () => void } | undefined;

  try {
    mutationLease = deps.runtimeSupervisor?.acquireOperationLease({ projectId: id, variantId: v.id });
    const create = () => withVariantMutation(deps, id, v.id, async (variantSignal) => {
      variantSignal.throwIfAborted();
      const active = project.mode === "prototype"
        ? deps.store.listVariants(id).find((candidate) => candidate.active) ?? deps.store.ensureMainVariant(id)
        : initialActive;
      if (project.mode === "standard") {
        await createStandardVariantWorktree(deps, id, active.id, v.id);
      } else {
        const root = projectDir(deps.dataDir, id);
        // Forking: save the current branch, then the new branch starts as a copy of root.
        await snapshot(root, snapDir(deps.dataDir, id, active.id));
      }
      await deps.variantMutationCheckpoint?.(id, v.id, "created", variantSignal);
      variantSignal.throwIfAborted();
      if (project.mode === "standard") await releaseStandardPreview(deps, id, active.id);
      deps.store.setActiveVariant(id, v.id);
    });
    if (project.mode === "prototype") await withStandardSourceMutationLock(`prototype:${id}`, create);
    else await create();
    sendJson(res, 200, deps.store.listVariants(id));
  } catch (err) {
    await deps.variantMutationCheckpoint?.(id, v.id, "before-rollback");
    if (project.mode === "standard") await removeStandardVariantWorktree(deps, id, v.id).catch(() => {});
    deps.store.deleteVariant(v.id);
    sendError(res, 409, err instanceof Error ? err.message : "could not create variant");
  } finally {
    mutationLease?.release();
  }
}

/**
 * Scoped-variant fan-out: fork N variants from the current state so the same scoped edit can be
 * generated as N independent variations. Does NOT activate any — the web runs the brief into each
 * returned variant (existing per-variant run path) and compares via the variant switcher.
 */
export async function handleVariantFanout(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
  signal?: AbortSignal,
): Promise<void> {
  const id = params.id!;
  const project = deps.store.getProject(id);
  if (!project) return sendError(res, 404, "project not found");
  const body = (await readJsonBody(req, VARIANT_BODY_MAX_BYTES, signal)) as { count?: number } | null;
  const plan = planVariantFanout(body?.count ?? 3);
  const active = deps.store.ensureMainVariant(id);
  const created: Array<{ variant: Variant; lease?: { release: () => void }; completed: boolean }> = [];
  let failed: (typeof created)[number] | undefined;
  let targetScopedCancellation = false;
  const mutate = async (): Promise<void> => {
    try {
      for (const spec of plan.variants) {
        signal?.throwIfAborted();
        const variant = deps.store.createVariant(id, spec.name);
        const record: (typeof created)[number] = { variant, completed: false };
        created.push(record);
        let variantSignal: AbortSignal | undefined;
        try {
          record.lease = deps.runtimeSupervisor?.acquireOperationLease({ projectId: id, variantId: variant.id });
          await withVariantMutation(deps, id, variant.id, async (operationSignal) => {
            variantSignal = operationSignal;
            operationSignal.throwIfAborted();
            if (project.mode === "standard") {
              await createStandardVariantWorktree(deps, id, active.id, variant.id);
            } else {
              // Seed the new prototype variant with a copy of the current root so activating it later
              // (to run a variation into it) restores that content instead of a blank snapshot.
              await snapshot(projectDir(deps.dataDir, id), snapDir(deps.dataDir, id, variant.id));
            }
            await deps.variantMutationCheckpoint?.(id, variant.id, "created", operationSignal);
            operationSignal.throwIfAborted();
          });
          record.completed = true;
        } catch (err) {
          failed = record;
          targetScopedCancellation = signal?.aborted !== true
            && (variantSignal?.aborted === true || err instanceof RuntimeScopeUnavailableError);
          throw err;
        }
      }
    } catch (err) {
      const rollback = targetScopedCancellation && failed ? [failed] : created;
      for (const record of rollback) {
        await deps.variantMutationCheckpoint?.(id, record.variant.id, "before-rollback");
        if (project.mode === "standard") {
          await removeStandardVariantWorktree(deps, id, record.variant.id).catch(() => {});
        } else {
          await rm(snapDir(deps.dataDir, id, record.variant.id), { recursive: true, force: true }).catch(() => {});
        }
        deps.store.deleteVariant(record.variant.id);
      }
      throw err;
    }
  };
  try {
    if (project.mode === "prototype") await withStandardSourceMutationLock(`prototype:${id}`, mutate);
    else await mutate();
    sendJson(res, 200, { plan, created: created.map(({ variant }) => variant.id), variants: deps.store.listVariants(id) });
  } catch (err) {
    sendError(res, 409, err instanceof Error ? err.message : "could not create the variant fan-out");
  } finally {
    for (const record of created) record.lease?.release();
  }
}

function versionSnapshotPath(dataDir: string, projectId: string, runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9-]/g, "");
  return join(projectDir(dataDir, projectId), ".versions", `${safe}.html`);
}

export async function handleForkMessage(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
  signal?: AbortSignal,
): Promise<void> {
  const id = params.id!;
  const messageId = params.messageId!;
  const project = deps.store.getProject(id);
  if (!project) return sendError(res, 404, "project not found");

  const message = deps.store.getMessage(messageId);
  const conversation = message ? deps.store.getConversation(message.conversationId) : null;
  if (!message || !conversation || conversation.projectId !== id) return sendError(res, 404, "message not found");
  if (message.role !== "assistant") return sendError(res, 400, "only assistant messages can be forked");

  const run = deps.store.findSucceededRunForAssistantMessage(message.id);
  if (!run || run.projectId !== id) return sendError(res, 409, "no completed design snapshot for this message");

  const body = (await readJsonBody(req, VARIANT_BODY_MAX_BYTES, signal)) as { name?: string } | null;
  signal?.throwIfAborted();
  const name = body?.name?.trim() || `Fork ${deps.store.listVariants(id).length + 1}`;
  const variant = deps.store.createVariant(id, name);
  let prototypeRollback: {
    root: string;
    activeSnapshot: string;
    rootMutationStarted: boolean;
  } | undefined;
  let mutationLease: { release: () => void } | undefined;
  let prototypeAssetsRestored: boolean | undefined;
  let activeVariantId: string | undefined;
  let prototypeRollbackHandled = false;

  const rollbackPrototypeMutation = async (): Promise<void> => {
    if (prototypeRollback?.rootMutationStarted) {
      await deps.prototypeMessageForkCheckpoint?.(id, variant.id, "before-rollback");
      await restore(prototypeRollback.activeSnapshot, prototypeRollback.root);
    }
    if (activeVariantId && deps.store.getVariant(activeVariantId)) deps.store.setActiveVariant(id, activeVariantId);
    await Promise.all([
      prototypeRollback
        ? rm(prototypeRollback.activeSnapshot, { recursive: true, force: true })
        : Promise.resolve(),
      rm(snapDir(deps.dataDir, id, variant.id), { recursive: true, force: true }),
    ]);
    prototypeRollbackHandled = true;
  };

  try {
    mutationLease = deps.runtimeSupervisor?.acquireOperationLease({ projectId: id, variantId: variant.id });
    const performFork = () => withVariantMutation(deps, id, variant.id, async (variantSignal) => {
      variantSignal.throwIfAborted();
      const active = deps.store.listVariants(id).find((candidate) => candidate.active) ?? deps.store.ensureMainVariant(id);
      activeVariantId = active.id;
      if (project.mode === "standard") {
        if (!run.commitHash) throw new Error("this Standard run has no commit snapshot");
        await createStandardVariantWorktreeFromCommit(deps, id, variant.id, run.commitHash);
        await releaseStandardPreview(deps, id, active.id);
      } else {
        const versionFile = versionSnapshotPath(deps.dataDir, id, run.id);
        if (!existsSync(versionFile)) throw new Error("this run has no version snapshot");
        const root = projectDir(deps.dataDir, id);
        const activeSnapshot = snapDir(deps.dataDir, id, active.id);
        prototypeRollback = { root, activeSnapshot, rootMutationStarted: false };
        await snapshot(root, activeSnapshot);
        await deps.prototypeMessageForkCheckpoint?.(id, variant.id, "before-root-overwrite", variantSignal);
        variantSignal.throwIfAborted();
        prototypeRollback.rootMutationStarted = true;
        prototypeAssetsRestored = await restorePrototypeVersionSnapshot({
          dataDir: deps.dataDir,
          projectId: id,
          sourceRunId: run.id,
          projectRoot: root,
          html: await readFile(versionFile, "utf8"),
        });
        if (!prototypeAssetsRestored) {
          throw new Error("this legacy snapshot has no captured local asset bundle and cannot be forked safely");
        }
        await deps.prototypeMessageForkCheckpoint?.(id, variant.id, "after-root-overwrite", variantSignal);
      }

      variantSignal.throwIfAborted();
      const createdConversation = deps.store.createConversation(id, name);
      for (const prior of deps.store.listMessagesThrough(conversation.id, message.id)) {
        deps.store.addMessage(createdConversation.id, prior.role, prior.content);
      }
      deps.store.setActiveVariant(id, variant.id);
      return createdConversation;
    });
    // Prototype variants share one mutable root directory. Serialize snapshot, overwrite,
    // transcript creation, and active-identity switch as one project transaction.
    const forkConversation = project.mode === "prototype"
      ? await withStandardSourceMutationLock(`prototype:${id}`, async () => {
          try {
            return await performFork();
          } catch (error) {
            try {
              await rollbackPrototypeMutation();
            } catch (rollbackError) {
              throw new AggregateError([error, rollbackError], "Prototype message fork failed and its root rollback also failed");
            }
            throw error;
          }
        })
      : await performFork();
    sendJson(res, 200, {
      conversationId: forkConversation.id,
      variantId: variant.id,
      variants: deps.store.listVariants(id),
      ...(prototypeAssetsRestored !== undefined ? { assetsRestored: prototypeAssetsRestored } : {}),
    });
  } catch (err) {
    let rollbackError: unknown;
    if (project.mode === "standard") await removeStandardVariantWorktree(deps, id, variant.id).catch(() => {});
    else if (!prototypeRollbackHandled) {
      try {
        await withStandardSourceMutationLock(`prototype:${id}`, rollbackPrototypeMutation);
      } catch (restoreError) {
        rollbackError = restoreError;
      }
    }
    deps.store.deleteVariant(variant.id);
    const responseError = rollbackError ?? err;
    sendError(
      res,
      rollbackError ? 500 : 409,
      responseError instanceof Error ? responseError.message : "could not fork from this message",
    );
  } finally {
    mutationLease?.release();
  }
}

export async function handleActivateVariant(
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
  signal?: AbortSignal,
): Promise<void> {
  const id = params.id!;
  const vid = params.vid!;
  const project = deps.store.getProject(id);
  if (!project || deps.store.getVariant(vid)?.projectId !== id) return sendError(res, 404, "not found");
  signal?.throwIfAborted();
  const active = deps.store.getActiveVariantId(id) ?? deps.store.ensureMainVariant(id).id;
  if (deps.store.findActiveRun(id, active) || deps.store.findActiveRun(id, vid)) {
    return sendError(res, 409, "wait for the active Run to finish before switching branches");
  }
  if (active !== vid && project.mode !== "standard") {
    try {
      await withStandardSourceMutationLock(`prototype:${id}`, async () => {
        const lockedActive = deps.store.getActiveVariantId(id) ?? deps.store.ensureMainVariant(id).id;
        if (lockedActive === vid) return;
        const root = projectDir(deps.dataDir, id);
        const activatedPrototypeSnapshot = snapDir(deps.dataDir, id, vid);
        const previousSnapshot = snapDir(deps.dataDir, id, lockedActive);
        let previousSaved = false;
        let rootMutationStarted = false;
        try {
          await snapshot(root, previousSnapshot);
          previousSaved = true;
          signal?.throwIfAborted();
          rootMutationStarted = true;
          await restore(activatedPrototypeSnapshot, root);
          await deps.prototypeVariantRestored?.(id, vid, signal);
          signal?.throwIfAborted();
          deps.store.setActiveVariant(id, vid);
          await rm(activatedPrototypeSnapshot, { recursive: true, force: true });
        } catch (err) {
          if (rootMutationStarted && previousSaved) await restore(previousSnapshot, root);
          await rm(previousSnapshot, { recursive: true, force: true }).catch(() => {});
          if (signal?.aborted) throw new RuntimeScopeUnavailableError({ projectId: id, variantId: vid });
          throw err;
        }
      });
      sendJson(res, 200, deps.store.listVariants(id));
    } catch (err) {
      sendError(res, 409, err instanceof Error ? err.message : "could not activate variant");
    }
    return;
  }
  if (active !== vid) {
    if (project.mode === "standard") {
      try {
        await standardVariantArtifactDir(deps, id, vid);
      } catch (err) {
        return sendError(res, 409, err instanceof Error ? err.message : "could not activate variant worktree");
      }
    }
    signal?.throwIfAborted();
    if (project.mode === "standard" && active) await releaseStandardPreview(deps, id, active);
    deps.store.setActiveVariant(id, vid);
  }
  sendJson(res, 200, deps.store.listVariants(id));
}

export async function handleRenameVariant(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
  signal?: AbortSignal,
): Promise<void> {
  const id = params.id!;
  const vid = params.vid!;
  if (deps.store.getVariant(vid)?.projectId !== id) return sendError(res, 404, "not found");
  const body = (await readJsonBody(req, VARIANT_BODY_MAX_BYTES, signal)) as { name?: string } | null;
  if (!body?.name?.trim()) return sendError(res, 400, "name is required");
  deps.store.renameVariant(vid, body.name.trim());
  sendJson(res, 200, deps.store.listVariants(id));
}

export async function handleDeleteVariant(res: ServerResponse, params: Record<string, string>, deps: AppDeps): Promise<void> {
  const id = params.id!;
  const vid = params.vid!;
  const project = deps.store.getProject(id);
  if (!project || deps.store.getVariant(vid)?.projectId !== id) return sendError(res, 404, "not found");
  if (deps.store.getActiveVariantId(id) === vid) return sendError(res, 409, "switch to another branch before deleting this one");
  if (deps.store.listVariants(id).length <= 1) return sendError(res, 409, "a project needs at least one branch");
  if (project.mode === "standard" && isStandardRootVariant(deps, id, vid)) {
    return sendError(res, 409, "the root branch cannot be deleted");
  }
  await deps.runtimeSupervisor!.releaseVariant(id, vid);
  sendJson(res, 200, deps.store.listVariants(id));
}
