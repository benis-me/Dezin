import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rm, stat, utimes } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { agentSpawnEnv } from "../../../packages/agent/src/index.ts";
import type { Project } from "../../../packages/core/src/index.ts";
import type { AppDeps } from "./app.ts";
import { gitCommit } from "./project-runtime.ts";
import { projectDir, safeJoin } from "./serve-static.ts";
import type { RuntimeScope } from "./runtime-supervisor.ts";
import { previewLeaseManager } from "./preview-lease.ts";
import { STANDARD_RUNTIME_PATHS, standardIgnoredPathCollisions } from "./standard-run-transaction.ts";

const GIT_IDENTITY = ["-c", "user.name=Dezin", "-c", "user.email=dezin@local"];

export function standardWorktreeDir(dataDir: string, projectId: string, variantId: string): string {
  return join(dataDir, "worktrees", projectId, variantId);
}

export function standardVersionWorktreeDir(dataDir: string, projectId: string, runId: string): string {
  return join(dataDir, "version-worktrees", projectId, runId);
}

const MAX_STANDARD_VERSION_WORKTREES_PER_PROJECT = 8;
const MAX_STANDARD_VERSION_WORKTREES_GLOBAL = 24;

export function variantRuntimeKey(projectId: string, variantId: string): string {
  return `${projectId}:${variantId}`;
}

export function versionRuntimeKey(projectId: string, runId: string): string {
  return `${projectId}:version:${runId}`;
}

function variantBranchName(variantId: string): string {
  return `dezin/variant/${variantId}`;
}

function captureGit(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: agentSpawnEnv() });
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (out += d));
    child.stderr?.on("data", (d: string) => (out += d));
    child.on("error", (err) => resolve({ code: 1, out: err.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

async function git(cwd: string, args: string[]): Promise<void> {
  const res = await captureGit(cwd, args);
  if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.out.trim() || "exit " + res.code}`);
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const res = await captureGit(cwd, args);
  if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.out.trim() || "exit " + res.code}`);
  return res.out.trim();
}

async function emptyGitHooksDir(cwd: string): Promise<string> {
  const commonGitDir = resolve(cwd, await gitOutput(cwd, ["rev-parse", "--git-common-dir"]));
  const dir = join(commonGitDir, "dezin-empty-hooks");
  await mkdir(dir, { recursive: true });
  return dir;
}

async function addWorktreeWithoutHooks(root: string, args: string[]): Promise<void> {
  const hooksDir = await emptyGitHooksDir(root);
  await git(root, ["-c", `core.hooksPath=${hooksDir}`, "worktree", "add", ...args]);
}

function rootVariantId(deps: AppDeps, projectId: string): string {
  const main = deps.store.ensureMainVariant(projectId);
  return deps.store.listVariants(projectId)[0]?.id ?? main.id;
}

function withRuntimeOperation<T>(deps: AppDeps, scope: RuntimeScope, start: () => Promise<T>): Promise<T> {
  return deps.runtimeSupervisor
    ? deps.runtimeSupervisor.trackOperation(scope, start)
    : start();
}

async function evictOldStandardVersionWorktrees(deps: AppDeps, projectId: string, keepRunId: string): Promise<void> {
  const root = join(deps.dataDir, "version-worktrees", projectId);
  if (!existsSync(root)) return;
  const candidates = await Promise.all((await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name !== keepRunId)
    .map(async (entry) => ({ runId: entry.name, mtimeMs: (await stat(join(root, entry.name))).mtimeMs })));
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || a.runId.localeCompare(b.runId));
  let total = candidates.length + 1;
  for (const candidate of candidates) {
    if (total <= MAX_STANDARD_VERSION_WORKTREES_PER_PROJECT) break;
    const scope = { projectId, runId: candidate.runId };
    if ((deps.previewLeaseManager ?? previewLeaseManager).hasActiveLease?.(scope)) continue;
    await removeStandardVersionWorktree(deps, projectId, candidate.runId);
    total -= 1;
  }

  const globalRoot = join(deps.dataDir, "version-worktrees");
  const globalCandidates: Array<{ projectId: string; runId: string; mtimeMs: number }> = [];
  for (const projectEntry of await readdir(globalRoot, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;
    const projectRoot = join(globalRoot, projectEntry.name);
    for (const runEntry of await readdir(projectRoot, { withFileTypes: true })) {
      if (!runEntry.isDirectory()) continue;
      globalCandidates.push({
        projectId: projectEntry.name,
        runId: runEntry.name,
        mtimeMs: (await stat(join(projectRoot, runEntry.name))).mtimeMs,
      });
    }
  }
  globalCandidates.sort((a, b) => a.mtimeMs - b.mtimeMs || a.projectId.localeCompare(b.projectId) || a.runId.localeCompare(b.runId));
  let globalTotal = globalCandidates.length;
  for (const candidate of globalCandidates) {
    if (globalTotal <= MAX_STANDARD_VERSION_WORKTREES_GLOBAL) break;
    if (candidate.projectId === projectId && candidate.runId === keepRunId) continue;
    const scope = { projectId: candidate.projectId, runId: candidate.runId };
    if ((deps.previewLeaseManager ?? previewLeaseManager).hasActiveLease?.(scope)) continue;
    await removeStandardVersionWorktree(deps, candidate.projectId, candidate.runId);
    globalTotal -= 1;
  }
}

export function isStandardRootVariant(deps: AppDeps, projectId: string, variantId: string): boolean {
  return rootVariantId(deps, projectId) === variantId;
}

async function ensureStandardWorktree(deps: AppDeps, projectId: string, variantId: string): Promise<string> {
  const dir = standardWorktreeDir(deps.dataDir, projectId, variantId);
  if (existsSync(join(dir, ".git"))) return dir;

  const root = projectDir(deps.dataDir, projectId);
  if (!existsSync(join(root, ".git"))) throw new Error("standard project is not a git repository yet");

  await rm(dir, { recursive: true, force: true });
  await mkdir(dirname(dir), { recursive: true });
  await captureGit(root, ["worktree", "prune"]);

  const branch = variantBranchName(variantId);
  const branchExists = (await captureGit(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
  if (branchExists) await addWorktreeWithoutHooks(root, [dir, branch]);
  else await addWorktreeWithoutHooks(root, ["-b", branch, dir, "HEAD"]);
  return dir;
}

export async function createStandardVariantWorktree(
  deps: AppDeps,
  projectId: string,
  sourceVariantId: string,
  variantId: string,
): Promise<string> {
  return withRuntimeOperation(deps, { projectId, variantId }, async () => {
    const source = await ensureStandardVariantArtifactDir(deps, projectId, sourceVariantId);
    const saved = await gitCommit(source, "Dezin: save variant before fork");
    if (saved.changed && !saved.committed) throw new Error("could not save the current variant before forking");

    const root = projectDir(deps.dataDir, projectId);
    if (!existsSync(join(root, ".git"))) throw new Error("standard project is not a git repository yet");
    const commit = await gitOutput(source, ["rev-parse", "HEAD"]);
    const dir = standardWorktreeDir(deps.dataDir, projectId, variantId);
    const branch = variantBranchName(variantId);

    await rm(dir, { recursive: true, force: true });
    await mkdir(dirname(dir), { recursive: true });
    await captureGit(root, ["worktree", "prune"]);
    await addWorktreeWithoutHooks(root, ["-b", branch, dir, commit]);
    return dir;
  });
}

export async function createStandardVariantWorktreeFromCommit(
  deps: AppDeps,
  projectId: string,
  variantId: string,
  commit: string,
): Promise<string> {
  return withRuntimeOperation(deps, { projectId, variantId }, async () => {
    if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error("run has no valid commit snapshot");
    const root = projectDir(deps.dataDir, projectId);
    if (!existsSync(join(root, ".git"))) throw new Error("standard project is not a git repository yet");
    const dir = standardWorktreeDir(deps.dataDir, projectId, variantId);
    const branch = variantBranchName(variantId);

    await rm(dir, { recursive: true, force: true });
    await mkdir(dirname(dir), { recursive: true });
    await captureGit(root, ["worktree", "prune"]);
    await addWorktreeWithoutHooks(root, ["-b", branch, dir, commit]);
    return dir;
  });
}

export async function standardVersionArtifactDir(deps: AppDeps, projectId: string, runId: string, commit: string): Promise<string> {
  const variantId = deps.store.getRun(runId)?.variantId ?? undefined;
  return withRuntimeOperation(deps, { projectId, variantId, runId }, async () => {
    if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error("run has no valid commit snapshot");
    const root = projectDir(deps.dataDir, projectId);
    if (!existsSync(join(root, ".git"))) throw new Error("standard project is not a git repository yet");
    const dir = standardVersionWorktreeDir(deps.dataDir, projectId, runId);
    const targetCommit = await gitOutput(root, ["rev-parse", commit]);
    if (existsSync(join(dir, ".git"))) {
      const currentCommit = await gitOutput(dir, ["rev-parse", "HEAD"]).catch(() => "");
      if (currentCommit === targetCommit) {
        await git(dir, ["reset", "--hard", targetCommit]);
        await git(dir, ["clean", "-fdx"]);
        const now = new Date();
        await utimes(dir, now, now);
        await evictOldStandardVersionWorktrees(deps, projectId, runId);
        return dir;
      }
      const removed = await captureGit(root, ["worktree", "remove", "--force", dir]);
      if (removed.code !== 0) await rm(dir, { recursive: true, force: true });
    }

    await rm(dir, { recursive: true, force: true });
    await mkdir(dirname(dir), { recursive: true });
    await captureGit(root, ["worktree", "prune"]);
    await addWorktreeWithoutHooks(root, ["--detach", dir, targetCommit]);
    await git(dir, ["reset", "--hard", targetCommit]);
    await git(dir, ["clean", "-fdx"]);
    const [createdCommit, createdStatus] = await Promise.all([
      gitOutput(dir, ["rev-parse", "HEAD"]),
      gitOutput(dir, ["status", "--porcelain", "--untracked-files=all"]),
    ]);
    if (createdCommit !== targetCommit || createdStatus) throw new Error("version worktree did not reproduce the selected snapshot");
    const now = new Date();
    await utimes(dir, now, now);
    await evictOldStandardVersionWorktrees(deps, projectId, runId);
    return dir;
  });
}

export async function diffStandardArtifactDirFromCommit(dir: string, commit: string): Promise<string> {
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error("run has no valid commit snapshot");
  return gitOutput(dir, ["diff", "--no-color", commit, "--", "."]);
}

async function backupStandardRuntimeSidecars(dir: string): Promise<string> {
  const backupDir = await mkdtemp(join(tmpdir(), "dezin-standard-sidecars-"));
  for (const path of STANDARD_RUNTIME_PATHS) {
    const source = join(dir, path);
    if (existsSync(source)) await cp(source, join(backupDir, path), { recursive: true });
  }
  return backupDir;
}

async function restoreStandardRuntimeSidecars(dir: string, backupDir: string): Promise<void> {
  for (const path of STANDARD_RUNTIME_PATHS) {
    const target = join(dir, path);
    await rm(target, { recursive: true, force: true });
    const backup = join(backupDir, path);
    if (existsSync(backup)) await cp(backup, target, { recursive: true });
  }
}

async function commitPreparedRestore(dir: string, message: string): Promise<string> {
  const hooksDir = await emptyGitHooksDir(dir);
  await git(dir, [
    ...GIT_IDENTITY,
    "-c",
    "commit.gpgSign=false",
    "-c",
    `core.hooksPath=${hooksDir}`,
    "commit",
    "-q",
    "-m",
    message,
  ]);
  return gitOutput(dir, ["rev-parse", "HEAD"]);
}

export async function restoreStandardArtifactDirFromCommit(
  dir: string,
  commit: string,
  options: { afterCommit?: (commitHash: string) => void | Promise<void> } = {},
): Promise<string> {
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error("run has no valid commit snapshot");
  const status = await gitOutput(dir, ["status", "--porcelain", "--untracked-files=all"]);
  if (status) throw new Error("current project has uncommitted changes; save or discard them before restoring a version");
  const targetCommit = await gitOutput(dir, ["rev-parse", commit]);
  const currentCommit = await gitOutput(dir, ["rev-parse", "HEAD"]);
  const collisions = await standardIgnoredPathCollisions(dir, targetCommit, { excludeRuntimePaths: true });
  if (collisions.length) {
    throw new Error(`version restore would overwrite ignored local paths: ${collisions.join(", ")}`);
  }
  const sidecarBackupDir = await backupStandardRuntimeSidecars(dir);

  try {
    // Apply the exact tree directly. Unlike `git checkout <tree> -- .`, read-tree does not invoke
    // project checkout hooks that could mutate an otherwise clean mechanical Restore.
    await git(dir, ["read-tree", "--reset", "-u", targetCommit]);
    // Runtime evidence belongs to the live variant rather than a historical source tree. Strip
    // any legacy tracked copies from the target while preserving the current ignored sidecars.
    await git(dir, ["rm", "-r", "-f", "--cached", "--ignore-unmatch", "--", ...STANDARD_RUNTIME_PATHS]);
    await restoreStandardRuntimeSidecars(dir, sidecarBackupDir);
    const expectedTree = await gitOutput(dir, ["write-tree"]);
    const changed = await captureGit(dir, ["diff", "--cached", "--quiet"]);
    if (changed.code === 0) {
      await options.afterCommit?.(currentCommit);
      return currentCommit;
    }
    if (changed.code !== 1) throw new Error(`git diff --cached --quiet failed: ${changed.out.trim() || `exit ${changed.code}`}`);
    // Commit the already-verified index directly. A generic `git add -A` here would re-run clean
    // filters and could silently change the selected snapshot's blobs.
    const restoredCommit = await commitPreparedRestore(dir, `Dezin: restore version ${targetCommit.slice(0, 8)}`);
    const restoredTree = await gitOutput(dir, ["rev-parse", `${restoredCommit}^{tree}`]);
    if (restoredTree !== expectedTree) throw new Error("version restore commit changed the selected snapshot");
    const restoredStatus = await gitOutput(dir, ["status", "--porcelain", "--untracked-files=all"]);
    if (restoredStatus) throw new Error("version restore could not materialize the selected snapshot as a clean worktree");
    await options.afterCommit?.(restoredCommit);
    return restoredCommit;
  } catch (error) {
    // Restore starts only from a verified-clean tree. Reapply the original HEAD tree without
    // moving the branch ref so a hook/disk/commit failure cannot strand staged target bytes.
    const actualHead = await gitOutput(dir, ["rev-parse", "HEAD"]).catch(() => "");
    const refRollback = actualHead && actualHead !== currentCommit
      ? await captureGit(dir, ["update-ref", "HEAD", currentCommit, actualHead])
      : { code: 0, out: "" };
    const rollback = refRollback.code === 0
      ? await captureGit(dir, ["read-tree", "--reset", "-u", currentCommit])
      : refRollback;
    await restoreStandardRuntimeSidecars(dir, sidecarBackupDir).catch(() => {});
    if (rollback.code !== 0) {
      throw new AggregateError(
        [error, new Error(`restore rollback failed: ${rollback.out.trim() || `exit ${rollback.code}`}`)],
        `version restore failed and the original tree could not be reapplied: ${rollback.out.trim() || `exit ${rollback.code}`}`,
      );
    }
    throw error;
  } finally {
    await rm(sidecarBackupDir, { recursive: true, force: true });
  }
}

export async function removeStandardVariantWorktree(deps: AppDeps, projectId: string, variantId: string): Promise<void> {
  const root = projectDir(deps.dataDir, projectId);
  const dir = standardWorktreeDir(deps.dataDir, projectId, variantId);
  if (existsSync(dir)) {
    const res = await captureGit(root, ["worktree", "remove", "--force", dir]);
    if (res.code !== 0) await rm(dir, { recursive: true, force: true });
  }
  const branch = variantBranchName(variantId);
  const removed = await captureGit(root, ["branch", "-D", branch]);
  if (removed.code !== 0) {
    await captureGit(root, ["worktree", "prune"]);
    await captureGit(root, ["branch", "-D", branch]);
  }
  await captureGit(root, ["worktree", "prune"]);
}

export async function removeStandardVersionWorktree(deps: AppDeps, projectId: string, runId: string): Promise<void> {
  await (deps.previewLeaseManager ?? previewLeaseManager).stopScope({ projectId, runId });
  const root = projectDir(deps.dataDir, projectId);
  const dir = standardVersionWorktreeDir(deps.dataDir, projectId, runId);
  if (!existsSync(join(root, ".git"))) {
    await rm(dir, { recursive: true, force: true });
    return;
  }
  if (existsSync(dir)) {
    const removed = await captureGit(root, ["worktree", "remove", "--force", dir]);
    if (removed.code !== 0) await rm(dir, { recursive: true, force: true });
  }
  await captureGit(root, ["worktree", "prune"]);
}

async function ensureStandardVariantArtifactDir(deps: AppDeps, projectId: string, variantId: string): Promise<string> {
  if (isStandardRootVariant(deps, projectId, variantId)) return projectDir(deps.dataDir, projectId);
  return ensureStandardWorktree(deps, projectId, variantId);
}

export async function standardVariantArtifactDir(deps: AppDeps, projectId: string, variantId: string): Promise<string> {
  return withRuntimeOperation(
    deps,
    { projectId, variantId },
    () => ensureStandardVariantArtifactDir(deps, projectId, variantId),
  );
}

export async function activeArtifactDir(deps: AppDeps, project: Project): Promise<string> {
  const main = deps.store.ensureMainVariant(project.id);
  if (project.mode !== "standard") return projectDir(deps.dataDir, project.id);
  const active = deps.store.getActiveVariantId(project.id) ?? main.id;
  return standardVariantArtifactDir(deps, project.id, active);
}

export async function variantArtifactDir(deps: AppDeps, project: Project, variantId: string): Promise<string | null> {
  const variant = deps.store.getVariant(variantId);
  if (!variant || variant.projectId !== project.id) return null;
  if (project.mode === "standard") return standardVariantArtifactDir(deps, project.id, variantId);

  const root = projectDir(deps.dataDir, project.id);
  const active = deps.store.getActiveVariantId(project.id);
  if (variantId === active) return root;
  return safeJoin(root, join(".variants", variantId));
}
