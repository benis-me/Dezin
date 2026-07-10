import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { agentSpawnEnv } from "../../../packages/agent/src/index.ts";
import type { RuntimeSupervisor } from "./runtime-supervisor.ts";

const GIT_IDENTITY = ["-c", "user.name=Dezin", "-c", "user.email=dezin@local"];

export interface StandardRunTransactionDeps {
  dataDir: string;
  runtimeSupervisor?: RuntimeSupervisor;
  promotionCheckpoint?: (phase: "after-validation" | "after-ref-advance") => void | Promise<void>;
}

export interface BeginStandardRunTransactionInput {
  projectId: string;
  variantId: string;
  runId: string;
  sourceDir: string;
}

export interface StandardRunTransaction {
  readonly dir: string;
  readonly sourceHead: string;
  readonly head: string;
  commit(message: string): Promise<string>;
  restoreBest(commit: string): Promise<void>;
  publish(): Promise<string>;
  rollback(): Promise<void>;
  dispose(): Promise<void>;
}

export class StandardRunSourceDirtyError extends Error {
  readonly sourceDir: string;

  constructor(sourceDir: string) {
    super("Standard Run cannot start while the selected variant has uncommitted changes. Commit or remove them, then retry.");
    this.name = "StandardRunSourceDirtyError";
    this.sourceDir = sourceDir;
  }
}

export class StandardRunPublishConflictError extends Error {
  readonly recoveryBranch: string;

  constructor(recoveryBranch: string) {
    super(`Standard Run was not published because the selected variant changed concurrently. Agent changes remain on ${recoveryBranch}.`);
    this.name = "StandardRunPublishConflictError";
    this.recoveryBranch = recoveryBranch;
  }
}

function safeGitComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

export function standardRunBranchName(runId: string): string {
  return `dezin/run/${safeGitComponent(runId)}`;
}

export function standardRunWorktreeDir(dataDir: string, projectId: string, runId: string): string {
  return join(dataDir, "run-worktrees", safeGitComponent(projectId), safeGitComponent(runId));
}

function captureGit(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: agentSpawnEnv() });
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (out += chunk));
    child.stderr?.on("data", (chunk: string) => (out += chunk));
    child.on("error", (error) => resolve({ code: 1, out: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await captureGit(cwd, args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.out.trim() || `exit ${result.code}`}`);
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await captureGit(cwd, args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.out.trim() || `exit ${result.code}`}`);
  return result.out.trim();
}

async function sourceStatus(sourceDir: string): Promise<string> {
  return gitOutput(sourceDir, ["status", "--porcelain=v1", "--untracked-files=all"]);
}

const sourcePromotionTails = new Map<string, Promise<void>>();

async function withSourcePromotionLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = sourcePromotionTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = previous.then(() => gate);
  sourcePromotionTails.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (sourcePromotionTails.get(key) === tail) sourcePromotionTails.delete(key);
  }
}

function nulPaths(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

async function syncPublishedCheckout(
  input: BeginStandardRunTransactionInput,
  sourceHead: string,
  sourceRef: string,
  targetHead: string,
): Promise<void> {
  // Publication is already durable at this point. Every synchronization action below is
  // best-effort and may only touch a path that still byte-matches the expected old checkout.
  const currentRef = await gitOutput(input.sourceDir, ["symbolic-ref", "-q", "HEAD"]).catch(() => "");
  if (currentRef !== sourceRef) return;
  const indexUnchanged = await captureGit(input.sourceDir, ["diff", "--cached", "--quiet", sourceHead, "--"]);
  if (indexUnchanged.code !== 0) return;

  const [changedOutput, deletedOutput] = await Promise.all([
    gitOutput(input.sourceDir, ["diff", "--name-only", "-z", "--no-renames", "--diff-filter=ACMRT", sourceHead, targetHead, "--"]),
    gitOutput(input.sourceDir, ["diff", "--name-only", "-z", "--no-renames", "--diff-filter=D", sourceHead, targetHead, "--"]),
  ]);
  const changed = nulPaths(changedOutput);
  const deleted = nulPaths(deletedOutput);
  const safeChanged: string[] = [];
  const safeDeleted: string[] = [];

  for (const path of changed) {
    const existedAtSource = (await captureGit(input.sourceDir, ["cat-file", "-e", `${sourceHead}:${path}`])).code === 0;
    if (!existedAtSource) {
      if (!existsSync(join(input.sourceDir, path))) safeChanged.push(path);
      continue;
    }
    if ((await captureGit(input.sourceDir, ["diff-files", "--quiet", "--", path])).code === 0) safeChanged.push(path);
  }
  for (const path of deleted) {
    if ((await captureGit(input.sourceDir, ["diff-files", "--quiet", "--", path])).code === 0) safeDeleted.push(path);
  }

  if ((await captureGit(input.sourceDir, ["read-tree", targetHead])).code !== 0) return;
  for (const path of safeChanged) await captureGit(input.sourceDir, ["checkout-index", "-f", "--", path]);
  for (const path of safeDeleted) await rm(join(input.sourceDir, path), { recursive: true, force: true }).catch(() => {});
}

export async function assertStandardRunSourceClean(sourceDir: string): Promise<void> {
  if (!existsSync(join(sourceDir, ".git"))) throw new Error("standard project is not a git repository yet");
  if (await sourceStatus(sourceDir)) throw new StandardRunSourceDirtyError(sourceDir);
}

async function removeWorktree(repositoryDir: string, dir: string): Promise<void> {
  if (existsSync(join(repositoryDir, ".git"))) {
    const removed = await captureGit(repositoryDir, ["worktree", "remove", "--force", dir]);
    if (removed.code !== 0) await rm(dir, { recursive: true, force: true });
    await captureGit(repositoryDir, ["worktree", "prune"]);
    return;
  }
  await rm(dir, { recursive: true, force: true });
}

async function deleteBranch(repositoryDir: string, branch: string): Promise<void> {
  if (!existsSync(join(repositoryDir, ".git"))) return;
  await captureGit(repositoryDir, ["branch", "-D", branch]);
}

export async function removeStandardRunTransaction(
  dataDir: string,
  projectId: string,
  runId: string,
  options: { preserveBranch?: boolean } = {},
): Promise<void> {
  const repositoryDir = join(dataDir, "projects", safeGitComponent(projectId));
  const dir = standardRunWorktreeDir(dataDir, projectId, runId);
  await removeWorktree(repositoryDir, dir);
  if (!options.preserveBranch) await deleteBranch(repositoryDir, standardRunBranchName(runId));
}

export async function beginStandardRunTransaction(
  deps: StandardRunTransactionDeps,
  input: BeginStandardRunTransactionInput,
): Promise<StandardRunTransaction> {
  await assertStandardRunSourceClean(input.sourceDir);
  const sourceHead = await gitOutput(input.sourceDir, ["rev-parse", "HEAD"]);
  const sourceRef = await gitOutput(input.sourceDir, ["symbolic-ref", "-q", "HEAD"]);
  const commonGitDir = await gitOutput(input.sourceDir, ["rev-parse", "--git-common-dir"]);
  const promotionKey = `${resolve(input.sourceDir, commonGitDir)}:${sourceRef}`;
  const branch = standardRunBranchName(input.runId);
  const dir = standardRunWorktreeDir(deps.dataDir, input.projectId, input.runId);
  const lease = deps.runtimeSupervisor?.acquireOperationLease({
    projectId: input.projectId,
    variantId: input.variantId,
    runId: input.runId,
  });

  try {
    // A Run id is unique, but cleaning a stale interrupted attempt makes creation idempotent.
    await removeWorktree(input.sourceDir, dir);
    await deleteBranch(input.sourceDir, branch);
    await mkdir(dirname(dir), { recursive: true });
    await assertStandardRunSourceClean(input.sourceDir);
    const currentHead = await gitOutput(input.sourceDir, ["rev-parse", "HEAD"]);
    const currentRef = await gitOutput(input.sourceDir, ["symbolic-ref", "-q", "HEAD"]);
    if (currentHead !== sourceHead || currentRef !== sourceRef) throw new StandardRunSourceDirtyError(input.sourceDir);
    await git(input.sourceDir, ["worktree", "add", "-b", branch, dir, sourceHead]);
  } catch (error) {
    try {
      await removeWorktree(input.sourceDir, dir).catch(() => {});
      await deleteBranch(input.sourceDir, branch).catch(() => {});
    } finally {
      lease?.release();
    }
    throw error;
  }

  let head = sourceHead;
  let disposed = false;
  let published = false;
  let preserveBranch = false;

  const ensureOpen = (): void => {
    if (disposed) throw new Error("Standard Run transaction is already disposed");
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    try {
      await removeWorktree(input.sourceDir, dir);
      if (!preserveBranch) await deleteBranch(input.sourceDir, branch);
    } finally {
      lease?.release();
    }
  };

  const commit = async (message: string): Promise<string> => {
    ensureOpen();
    await git(dir, ["add", "-A"]);
    const staged = await captureGit(dir, ["diff", "--cached", "--quiet"]);
    if (staged.code === 0) throw new Error("The selected Agent did not leave any project changes to save.");
    if (staged.code !== 1) throw new Error(`git diff --cached --quiet failed: ${staged.out.trim() || `exit ${staged.code}`}`);
    await git(dir, [...GIT_IDENTITY, "commit", "-q", "-m", message.replace(/\s+/g, " ").slice(0, 72) || "Dezin update"]);
    head = await gitOutput(dir, ["rev-parse", "HEAD"]);
    return head;
  };

  const restoreBest = async (commitHash: string): Promise<void> => {
    ensureOpen();
    if (!/^[0-9a-f]{7,40}$/i.test(commitHash)) throw new Error("run has no valid commit snapshot");
    await git(dir, ["checkout", commitHash, "--", "."]);
    const added = await gitOutput(dir, ["diff", "--no-renames", "--name-only", "--diff-filter=A", commitHash, "HEAD"]);
    for (const path of added.split("\n").map((value) => value.trim()).filter(Boolean)) {
      await git(dir, ["rm", "-f", "--", path]);
    }
    head = await commit(`Best-scoring version (${commitHash.slice(0, 8)})`);
  };

  return {
    dir,
    sourceHead,
    get head() {
      return head;
    },
    commit,
    restoreBest,
    async publish(): Promise<string> {
      ensureOpen();
      return withSourcePromotionLock(promotionKey, async () => {
        const failConflict = (): never => {
          preserveBranch = true;
          throw new StandardRunPublishConflictError(branch);
        };
        const validateExpectedSource = async (): Promise<void> => {
          const [currentHead, currentRef, status, transactionStatus] = await Promise.all([
            gitOutput(input.sourceDir, ["rev-parse", "HEAD"]),
            gitOutput(input.sourceDir, ["symbolic-ref", "-q", "HEAD"]),
            sourceStatus(input.sourceDir),
            sourceStatus(dir),
          ]);
          if (currentHead !== sourceHead || currentRef !== sourceRef || status || transactionStatus) failConflict();
        };

        await validateExpectedSource();
        await deps.promotionCheckpoint?.("after-validation");
        await validateExpectedSource();
        // Preview preparation may create a Dezin-owned commit in this isolated worktree.
        head = await gitOutput(dir, ["rev-parse", "HEAD"]);
        const advanced = await captureGit(input.sourceDir, ["update-ref", sourceRef, head, sourceHead]);
        if (advanced.code !== 0) failConflict();

        // The exact commit is now published. Nothing after this line may downgrade the
        // transaction to a conflict. Checkout synchronization is deliberately best-effort
        // and only writes paths that still match the expected old checkout.
        published = true;
        await Promise.resolve().then(() => deps.promotionCheckpoint?.("after-ref-advance")).catch(() => {});
        await syncPublishedCheckout(input, sourceHead, sourceRef, head).catch(() => {});
        return head;
      });
    },
    async rollback(): Promise<void> {
      if (published) throw new Error("Published Standard Run transaction cannot be rolled back");
      await dispose();
    },
    dispose,
  };
}
