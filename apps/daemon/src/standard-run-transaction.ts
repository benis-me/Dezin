import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { agentSpawnEnv } from "../../../packages/agent/src/index.ts";
import type { RuntimeSupervisor } from "./runtime-supervisor.ts";

const GIT_IDENTITY = ["-c", "user.name=Dezin", "-c", "user.email=dezin@local"];
export const STANDARD_RUNTIME_PATHS = [".cover.png", ".visual-qa", ".refs"] as const;
const STANDARD_RUNTIME_EXCLUDES = ["/.cover.png", "/.visual-qa/", "/.refs/"] as const;

export interface StandardRunTransactionDeps {
  dataDir: string;
  runtimeSupervisor?: RuntimeSupervisor;
  promotionCheckpoint?: (phase: "after-validation" | "before-promotion" | "after-ref-advance") => void | Promise<void>;
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
  preserveRecovery(): Promise<string>;
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
  const result = await captureGit(sourceDir, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (result.code !== 0) throw new Error(`git status failed: ${result.out.trim() || `exit ${result.code}`}`);
  return result.out.replace(/\r?\n$/, "");
}

function isStandardRuntimePath(path: string): boolean {
  const normalized = path.replace(/^"|"$/g, "").replace(/\\/g, "/");
  return STANDARD_RUNTIME_PATHS.some((reserved) => normalized === reserved || normalized.startsWith(`${reserved}/`));
}

function nullSeparatedPaths(output: string): string[] {
  return output
    .split("\0")
    .map((path) => path.replace(/\\/g, "/").replace(/\/$/, ""))
    .filter(Boolean);
}

/**
 * Find paths that a target tree would overwrite even though normal `git status` reports a
 * clean source. Ignored, untracked files are user-owned (typically local credentials or build
 * inputs), so a mechanical publish/restore must never replace them silently.
 */
export async function standardIgnoredPathCollisions(
  sourceDir: string,
  targetCommit: string,
  options: { excludeRuntimePaths?: boolean } = {},
): Promise<string[]> {
  const [treeResult, ignoredResult] = await Promise.all([
    captureGit(sourceDir, ["ls-tree", "-r", "--name-only", "-z", targetCommit]),
    captureGit(sourceDir, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]),
  ]);
  if (treeResult.code !== 0) throw new Error(`git ls-tree failed: ${treeResult.out.trim() || `exit ${treeResult.code}`}`);
  if (ignoredResult.code !== 0) throw new Error(`git ls-files ignored failed: ${ignoredResult.out.trim() || `exit ${ignoredResult.code}`}`);

  const targetPaths = nullSeparatedPaths(treeResult.out).filter(
    (path) => !options.excludeRuntimePaths || !isStandardRuntimePath(path),
  );
  const ignoredPaths = nullSeparatedPaths(ignoredResult.out);
  const collisions = new Set<string>();
  for (const ignored of ignoredPaths) {
    for (const target of targetPaths) {
      if (ignored === target || ignored.startsWith(`${target}/`) || target.startsWith(`${ignored}/`)) {
        collisions.add(ignored);
        break;
      }
    }
  }
  return [...collisions].sort();
}

export async function standardCommitRuntimePaths(sourceDir: string, targetCommit: string): Promise<string[]> {
  const result = await captureGit(sourceDir, ["ls-tree", "-r", "--name-only", "-z", targetCommit]);
  if (result.code !== 0) throw new Error(`git ls-tree failed: ${result.out.trim() || `exit ${result.code}`}`);
  return nullSeparatedPaths(result.out).filter(isStandardRuntimePath);
}

async function prepareStandardRuntimeSidecars(sourceDir: string): Promise<void> {
  const commonGitDir = resolve(sourceDir, await gitOutput(sourceDir, ["rev-parse", "--git-common-dir"]));
  const excludePath = join(commonGitDir, "info", "exclude");
  await mkdir(dirname(excludePath), { recursive: true });
  const existing = await readFile(excludePath, "utf8").catch(() => "");
  const missing = STANDARD_RUNTIME_EXCLUDES.filter((pattern) => !existing.split(/\r?\n/).includes(pattern));
  if (missing.length) {
    const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
    await writeFile(excludePath, `${existing}${prefix}${missing.join("\n")}\n`, "utf8");
  }

  const status = await sourceStatus(sourceDir);
  const nonRuntimeChange = status
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).split(" -> ").at(-1)?.trim() ?? "")
    .find((path) => !isStandardRuntimePath(path));
  if (nonRuntimeChange) throw new StandardRunSourceDirtyError(sourceDir);

  const tracked = await gitOutput(sourceDir, ["ls-files", "--", ...STANDARD_RUNTIME_PATHS]);
  if (!tracked) return;
  const emptyHooksDir = join(commonGitDir, "dezin-empty-hooks");
  await mkdir(emptyHooksDir, { recursive: true });
  try {
    await git(sourceDir, ["rm", "-r", "-f", "--cached", "--ignore-unmatch", "--", ...STANDARD_RUNTIME_PATHS]);
    await git(sourceDir, [
      ...GIT_IDENTITY,
      "-c",
      "commit.gpgSign=false",
      "-c",
      `core.hooksPath=${emptyHooksDir}`,
      "commit",
      "-q",
      "-m",
      "Dezin: untrack runtime sidecars",
    ]);
  } catch (error) {
    // `git rm --cached` deliberately leaves sidecar bytes in place. Restore only their index
    // entries so a failed mechanical migration cannot strand staged deletions.
    await captureGit(sourceDir, ["reset", "-q", "HEAD", "--", ...STANDARD_RUNTIME_PATHS]);
    throw error;
  }
}

async function copyRunReferences(sourceDir: string, transactionDir: string): Promise<void> {
  const source = join(sourceDir, ".refs");
  if (!existsSync(source)) return;
  const target = join(transactionDir, ".refs");
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    await copyFile(join(source, entry.name), join(target, entry.name));
  }
}

const sourceMutationTails = new Map<string, Promise<void>>();

export interface StandardSourceMutationLease {
  release(): void;
}

/** Acquire one source-mutation turn without forcing the protected work into a callback. */
export async function acquireStandardSourceMutationLock(key: string): Promise<StandardSourceMutationLease> {
  const previous = sourceMutationTails.get(key) ?? Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    releaseGate = resolveGate;
  });
  const tail = previous.then(() => gate);
  sourceMutationTails.set(key, tail);
  await previous;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      releaseGate();
      if (sourceMutationTails.get(key) === tail) sourceMutationTails.delete(key);
    },
  };
}

/** Serialize every Git mutation of one published Standard artifact (Run publish, Restore, etc.). */
export async function withStandardSourceMutationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const lease = await acquireStandardSourceMutationLock(key);
  try {
    return await operation();
  } finally {
    lease.release();
  }
}

export async function standardSourceMutationKey(sourceDir: string): Promise<string> {
  const [commonGitDir, sourceRef] = await Promise.all([
    gitOutput(sourceDir, ["rev-parse", "--git-common-dir"]),
    gitOutput(sourceDir, ["symbolic-ref", "-q", "HEAD"]),
  ]);
  return `${resolve(sourceDir, commonGitDir)}:${sourceRef}`;
}

export async function assertStandardRunSourceClean(sourceDir: string): Promise<void> {
  if (!existsSync(join(sourceDir, ".git"))) throw new Error("standard project is not a git repository yet");
  await prepareStandardRuntimeSidecars(sourceDir);
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
  const emptyHooksDir = join(resolve(input.sourceDir, commonGitDir), "dezin-empty-hooks");
  await mkdir(emptyHooksDir, { recursive: true });
  const promotionKey = `${resolve(input.sourceDir, commonGitDir)}:${sourceRef}`;
  const branch = standardRunBranchName(input.runId);
  const branchRef = `refs/heads/${branch}`;
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
    await git(input.sourceDir, ["-c", `core.hooksPath=${emptyHooksDir}`, "worktree", "add", "-b", branch, dir, sourceHead]);
    const [createdHead, createdStatus] = await Promise.all([gitOutput(dir, ["rev-parse", "HEAD"]), sourceStatus(dir)]);
    if (createdHead !== sourceHead || createdStatus) throw new Error("Standard Run worktree did not reproduce the source snapshot");
    await copyRunReferences(join(deps.dataDir, "projects", safeGitComponent(input.projectId)), dir);
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

  const commitPreparedIndex = async (message: string): Promise<string> => {
    ensureOpen();
    const staged = await captureGit(dir, ["diff", "--cached", "--quiet"]);
    if (staged.code === 0) throw new Error("The selected Agent did not leave any project changes to save.");
    if (staged.code !== 1) throw new Error(`git diff --cached --quiet failed: ${staged.out.trim() || `exit ${staged.code}`}`);
    await git(dir, [
      ...GIT_IDENTITY,
      "-c",
      "commit.gpgSign=false",
      "-c",
      `core.hooksPath=${emptyHooksDir}`,
      "commit",
      "-q",
      "-m",
      message.replace(/\s+/g, " ").slice(0, 72) || "Dezin update",
    ]);
    head = await gitOutput(dir, ["rev-parse", "HEAD"]);
    return head;
  };

  const commit = async (message: string): Promise<string> => {
    ensureOpen();
    await git(dir, ["add", "-A"]);
    return commitPreparedIndex(message);
  };

  const restoreBest = async (commitHash: string): Promise<void> => {
    ensureOpen();
    if (!/^[0-9a-f]{7,40}$/i.test(commitHash)) throw new Error("run has no valid commit snapshot");
    const previousHead = head;
    try {
      await git(dir, ["read-tree", "--reset", "-u", commitHash]);
      const exact = await captureGit(dir, ["diff", "--cached", "--quiet", commitHash, "--", "."]);
      if (exact.code !== 0) throw new Error("best-scoring version did not reproduce the selected snapshot");
      const expectedTree = await gitOutput(dir, ["write-tree"]);
      await commitPreparedIndex(`Best-scoring version (${commitHash.slice(0, 8)})`);
      const committedTree = await gitOutput(dir, ["rev-parse", "HEAD^{tree}"]);
      if (committedTree !== expectedTree) throw new Error("best-scoring version commit changed the selected snapshot");
      if (await sourceStatus(dir)) throw new Error("best-scoring version could not be materialized as a clean worktree");
    } catch (error) {
      const currentHead = await gitOutput(dir, ["rev-parse", "HEAD"]).catch(() => "");
      if (currentHead && currentHead !== previousHead) await captureGit(dir, ["update-ref", "HEAD", previousHead, currentHead]);
      await captureGit(dir, ["read-tree", "--reset", "-u", previousHead]);
      head = previousHead;
      throw error;
    }
  };

  return {
    dir,
    sourceHead,
    get head() {
      return head;
    },
    commit,
    restoreBest,
    async preserveRecovery(): Promise<string> {
      ensureOpen();
      const candidate = await gitOutput(dir, ["rev-parse", "HEAD"]);
      head = candidate;
      await git(input.sourceDir, ["update-ref", branchRef, candidate]);
      preserveBranch = true;
      return branch;
    },
    async publish(): Promise<string> {
      ensureOpen();
      return withStandardSourceMutationLock(promotionKey, async () => {
        const candidate = await gitOutput(dir, ["rev-parse", "HEAD"]);
        head = candidate;
        const failConflict = async (): Promise<never> => {
          preserveBranch = true;
          // Even a detached/switched/rewound transaction gets one exact recovery ref.
          await git(input.sourceDir, ["update-ref", branchRef, candidate]);
          throw new StandardRunPublishConflictError(branch);
        };
        const validateExpectedSource = async (): Promise<void> => {
          const [currentHead, currentRef, status, transactionStatus, transactionHead, transactionRefResult, branchHeadResult, ancestor, ignoredCollisions, runtimePaths] = await Promise.all([
            gitOutput(input.sourceDir, ["rev-parse", "HEAD"]),
            gitOutput(input.sourceDir, ["symbolic-ref", "-q", "HEAD"]),
            sourceStatus(input.sourceDir),
            sourceStatus(dir),
            gitOutput(dir, ["rev-parse", "HEAD"]),
            captureGit(dir, ["symbolic-ref", "-q", "HEAD"]),
            captureGit(input.sourceDir, ["rev-parse", "--verify", branchRef]),
            captureGit(input.sourceDir, ["merge-base", "--is-ancestor", sourceHead, candidate]),
            standardIgnoredPathCollisions(input.sourceDir, candidate),
            standardCommitRuntimePaths(input.sourceDir, candidate),
          ]);
          const transactionRef = transactionRefResult.code === 0 ? transactionRefResult.out.trim() : "";
          const branchHead = branchHeadResult.code === 0 ? branchHeadResult.out.trim() : "";
          if (
            currentHead !== sourceHead ||
            currentRef !== sourceRef ||
            status ||
            transactionStatus ||
            transactionHead !== candidate ||
            transactionRef !== branchRef ||
            branchHead !== candidate ||
            ancestor.code !== 0 ||
            ignoredCollisions.length > 0 ||
            runtimePaths.length > 0
          ) {
            await failConflict();
          }
        };

        await validateExpectedSource();
        await deps.promotionCheckpoint?.("after-validation");
        await validateExpectedSource();
        await deps.promotionCheckpoint?.("before-promotion");
        await validateExpectedSource();
        // Let Git own ref/index/worktree coordination. Unlike the former application-level
        // path check followed by forced checkout/delete, merge refuses stale/locked/dirty input
        // without force-writing bytes and advances the checked-out source branch as one FF.
        const promotion = await captureGit(input.sourceDir, [
          "-c",
          `core.hooksPath=${emptyHooksDir}`,
          "merge",
          "--ff-only",
          "--no-edit",
          candidate,
        ]);
        const promotedRef = await gitOutput(input.sourceDir, ["rev-parse", sourceRef]).catch(() => "");
        if (promotedRef !== candidate) {
          // Validation proved the source clean immediately before promotion, so any tracked or
          // ordinary untracked residue here belongs to the failed merge. Preserve ignored local
          // files while restoring the exact pre-publish tree.
          await captureGit(input.sourceDir, ["reset", "--hard", sourceHead]);
          await captureGit(input.sourceDir, ["clean", "-fd"]);
          await failConflict();
        }

        // The intended source ref now names the exact candidate. Even if Git surfaced a late
        // operational error after moving it, publication is irreversible and cannot downgrade.
        published = true;
        if (promotion.code !== 0 || (await sourceStatus(input.sourceDir))) {
          await git(input.sourceDir, ["reset", "--hard", candidate]);
          await git(input.sourceDir, ["clean", "-fd"]);
        }
        if ((await gitOutput(input.sourceDir, ["rev-parse", "HEAD"])) !== candidate || (await sourceStatus(input.sourceDir))) {
          throw new Error("Standard Run was published, but the source tree could not be made exact");
        }
        await Promise.resolve().then(() => deps.promotionCheckpoint?.("after-ref-advance")).catch(() => {});
        return candidate;
      });
    },
    async rollback(): Promise<void> {
      if (published) throw new Error("Published Standard Run transaction cannot be rolled back");
      await dispose();
    },
    dispose,
  };
}
