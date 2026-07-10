import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { agentSpawnEnv } from "../../../packages/agent/src/index.ts";
import type { Project } from "../../../packages/core/src/index.ts";
import type { AppDeps } from "./app.ts";
import { gitCommit } from "./project-runtime.ts";
import { projectDir, safeJoin } from "./serve-static.ts";
import type { RuntimeScope } from "./runtime-supervisor.ts";

export function standardWorktreeDir(dataDir: string, projectId: string, variantId: string): string {
  return join(dataDir, "worktrees", projectId, variantId);
}

export function standardVersionWorktreeDir(dataDir: string, projectId: string, runId: string): string {
  return join(dataDir, "version-worktrees", projectId, runId);
}

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

function rootVariantId(deps: AppDeps, projectId: string): string {
  const main = deps.store.ensureMainVariant(projectId);
  return deps.store.listVariants(projectId)[0]?.id ?? main.id;
}

function withRuntimeOperation<T>(deps: AppDeps, scope: RuntimeScope, start: () => Promise<T>): Promise<T> {
  return deps.runtimeSupervisor
    ? deps.runtimeSupervisor.trackOperation(scope, start)
    : start();
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
  if (branchExists) await git(root, ["worktree", "add", dir, branch]);
  else await git(root, ["worktree", "add", "-b", branch, dir, "HEAD"]);
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
    await git(root, ["worktree", "add", "-b", branch, dir, commit]);
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
    await git(root, ["worktree", "add", "-b", branch, dir, commit]);
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
      if (currentCommit === targetCommit) return dir;
      const removed = await captureGit(root, ["worktree", "remove", "--force", dir]);
      if (removed.code !== 0) await rm(dir, { recursive: true, force: true });
    }

    await rm(dir, { recursive: true, force: true });
    await mkdir(dirname(dir), { recursive: true });
    await captureGit(root, ["worktree", "prune"]);
    await git(root, ["worktree", "add", "--detach", dir, targetCommit]);
    return dir;
  });
}

export async function diffStandardArtifactDirFromCommit(dir: string, commit: string): Promise<string> {
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error("run has no valid commit snapshot");
  return gitOutput(dir, ["diff", "--no-color", commit, "--", "."]);
}

export async function resetStandardArtifactDirToCommit(dir: string, commit: string): Promise<void> {
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error("run has no valid commit snapshot");
  await git(dir, ["reset", "--hard", commit]);
}

export async function removeStandardVariantWorktree(deps: AppDeps, projectId: string, variantId: string): Promise<void> {
  const root = projectDir(deps.dataDir, projectId);
  const dir = standardWorktreeDir(deps.dataDir, projectId, variantId);
  if (existsSync(dir)) {
    const res = await captureGit(root, ["worktree", "remove", "--force", dir]);
    if (res.code !== 0) await rm(dir, { recursive: true, force: true });
  }
  await captureGit(root, ["branch", "-D", variantBranchName(variantId)]);
  await captureGit(root, ["worktree", "prune"]);
}

export async function removeStandardVersionWorktree(deps: AppDeps, projectId: string, runId: string): Promise<void> {
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
