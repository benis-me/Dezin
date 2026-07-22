import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { agentSpawnEnv } from "../../../packages/agent/src/index.ts";
import {
  LegacyWorkspaceSeedDriftError,
  type LegacyGitSnapshot,
  type LegacyWorkspaceSeed,
  type Store,
  type WorkspaceBundle,
  type WorkspaceBundleReadMode,
} from "../../../packages/core/src/index.ts";
import { projectDir } from "./serve-static.ts";

export interface WorkspaceMigrationDeps {
  store: Store;
  dataDir: string;
}

export interface WorkspaceMigrationOptions {
  afterVerification?: (seed: LegacyWorkspaceSeed, attempt: number) => void | Promise<void>;
  readMode?: WorkspaceBundleReadMode;
}

export type EnsureStandardProjectWorkspaceResult =
  | ({ status: "ready" } & WorkspaceBundle)
  | {
    status: "unsupported";
    code: "workspace_requires_standard_project";
    projectId: string;
    projectMode: "prototype";
  };

const MAX_SEED_ATTEMPTS = 3;
const FULL_GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LEGACY_GIT_REF = /^[0-9a-f]{7,64}$/i;

function readOnlyGitEnv(): Record<string, string | undefined> {
  const inherited = agentSpawnEnv();
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (!key.toUpperCase().startsWith("GIT_")) env[key] = value;
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function captureReadOnlyGit(root: string, args: readonly string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      "git",
      ["--no-optional-locks", "--no-replace-objects", "--no-lazy-fetch", "-C", root, ...args],
      { stdio: ["ignore", "pipe", "pipe"], env: readOnlyGitEnv() },
    );
    let stdout = "";
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.resume();
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 1, stdout: "" });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: stdout.trim() });
    });
  });
}

async function readableProjectGitRoot(root: string): Promise<boolean> {
  if (!existsSync(root)) return false;
  try {
    const gitDirectory = await lstat(join(root, ".git"));
    if (gitDirectory.isSymbolicLink() || !gitDirectory.isDirectory()) return false;
  } catch {
    return false;
  }
  const topLevel = await captureReadOnlyGit(root, ["rev-parse", "--show-toplevel"]);
  if (topLevel.code !== 0 || !topLevel.stdout) return false;
  try {
    return await realpath(topLevel.stdout) === await realpath(root);
  } catch {
    return false;
  }
}

async function verifyLegacyRunSnapshot(root: string, commitHash: string | null): Promise<LegacyGitSnapshot> {
  if (commitHash === null || !LEGACY_GIT_REF.test(commitHash)) return { status: "unavailable" };
  const commit = await captureReadOnlyGit(root, ["rev-parse", "--verify", "--end-of-options", `${commitHash}^{commit}`]);
  const resolvedCommit = commit.stdout.toLowerCase();
  if (commit.code !== 0
    || !FULL_GIT_OID.test(resolvedCommit)
    || !resolvedCommit.startsWith(commitHash.toLowerCase())) {
    return { status: "unavailable" };
  }
  const readableCommit = await captureReadOnlyGit(root, ["cat-file", "-e", "--", `${resolvedCommit}^{commit}`]);
  if (readableCommit.code !== 0) return { status: "unavailable" };
  const tree = await captureReadOnlyGit(root, ["rev-parse", "--verify", "--end-of-options", `${resolvedCommit}^{tree}`]);
  const sourceTreeHash = tree.stdout.toLowerCase();
  if (tree.code !== 0 || !FULL_GIT_OID.test(sourceTreeHash) || sourceTreeHash.length !== resolvedCommit.length) {
    return { status: "unavailable" };
  }
  const readableTree = await captureReadOnlyGit(root, ["cat-file", "-e", "--", `${sourceTreeHash}^{tree}`]);
  if (readableTree.code !== 0) return { status: "unavailable" };
  return {
    status: "verified",
    sourceCommitHash: resolvedCommit,
    sourceTreeHash,
    artifactRoot: ".",
  };
}

function isSqliteBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("errcode" in error)) return false;
  const errcode = (error as { errcode?: unknown }).errcode;
  return typeof errcode === "number" && (errcode & 0xff) === 5;
}

export async function ensureStandardProjectWorkspace(
  deps: WorkspaceMigrationDeps,
  projectId: string,
  options: WorkspaceMigrationOptions = {},
): Promise<EnsureStandardProjectWorkspaceResult> {
  const readMode = options.readMode ?? "compact";
  for (let attempt = 1; attempt <= MAX_SEED_ATTEMPTS; attempt += 1) {
    try {
      const migrationRead = deps.store.workspace.readWorkspaceForLegacyMigration(projectId, readMode);
      const existing = migrationRead?.bundle ?? null;
      if (existing?.workspace.mode === "prototype") {
        return {
          status: "unsupported",
          code: "workspace_requires_standard_project",
          projectId,
          projectMode: "prototype",
        };
      }
      if (existing?.artifacts.some((artifact) => artifact.legacyWrapped)) {
        return { status: "ready", ...existing };
      }
      if (existing !== null && migrationRead?.canonicalEmptyFoundation === false) {
        return { status: "ready", ...existing };
      }
      const facts = deps.store.workspace.readLegacyStandardWorkspaceFacts(projectId);
      if (facts.project.mode !== "standard") {
        return {
          status: "unsupported",
          code: "workspace_requires_standard_project",
          projectId,
          projectMode: "prototype",
        };
      }
      const root = projectDir(deps.dataDir, projectId);
      const readableRoot = await readableProjectGitRoot(root);
      const successfulRuns: LegacyWorkspaceSeed["successfulRuns"] = [];
      for (const run of facts.successfulRuns) {
        successfulRuns.push({
          ...run,
          gitSnapshot: readableRoot
            ? await verifyLegacyRunSnapshot(root, run.commitHash)
            : { status: "unavailable" },
        });
      }
      const seed: LegacyWorkspaceSeed = {
        version: 1,
        project: { ...facts.project, mode: "standard" },
        variants: facts.variants,
        successfulRuns,
      };
      await options.afterVerification?.(seed, attempt);
      const bundle = deps.store.workspace.ensureLegacyStandardWorkspace(seed, readMode);
      return { status: "ready", ...bundle };
    } catch (error) {
      if (attempt < MAX_SEED_ATTEMPTS && (error instanceof LegacyWorkspaceSeedDriftError || isSqliteBusy(error))) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("legacy Workspace migration retry budget was exhausted");
}
