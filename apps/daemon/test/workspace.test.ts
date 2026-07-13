import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../../../packages/core/src/index.ts";
import { ensureStandardProjectWorkspace } from "../src/workspace-migration.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function captureGit(root: string): Record<string, string> {
  return {
    head: readFileSync(join(root, ".git", "HEAD"), "utf8"),
    index: readFileSync(join(root, ".git", "index")).toString("base64"),
    branch: git(root, ["branch", "--show-current"]),
    refs: git(root, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    status: git(root, ["status", "--porcelain=v2", "--untracked-files=all"]),
    worktrees: git(root, ["worktree", "list", "--porcelain"]),
    source: readFileSync(join(root, "index.html"), "utf8"),
  };
}

test("Standard workspace migration verifies Git without changing Git or legacy rows", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-workspace-migration-"));
  const store = new Store(join(dataDir, "store.db"));
  const project = store.createProject({ name: "Legacy Standard", mode: "standard" });
  const conversation = store.createConversation(project.id, "Legacy");
  const variant = store.createVariant(project.id, "Main");
  store.setActiveVariant(project.id, variant.id);
  const root = join(dataDir, "projects", project.id);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "index.html"), "<main>Legacy</main>\n");
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Dezin Test"]);
  git(root, ["config", "user.email", "dezin@example.test"]);
  git(root, ["add", "index.html"]);
  git(root, ["commit", "-m", "legacy snapshot"]);
  const commitHash = git(root, ["rev-parse", "HEAD"]);
  const run = store.createImportedRun(project.id, conversation.id, {
    variantId: variant.id,
    status: "succeeded",
    commitHash,
    createdAt: 100,
    finishedAt: 101,
    lintPassed: true,
    score: 100,
  });
  writeFileSync(join(root, "staged.txt"), "staged change\n");
  git(root, ["add", "staged.txt"]);
  writeFileSync(join(root, "index.html"), "<main>Unstaged legacy edit</main>\n");
  const legacyBefore = {
    project: store.db.prepare("SELECT * FROM projects WHERE id = ?").get(project.id),
    variants: store.db.prepare("SELECT * FROM variants WHERE project_id = ? ORDER BY id").all(project.id),
    runs: store.db.prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY id").all(project.id),
  };
  const gitBefore = captureGit(root);

  const first = await ensureStandardProjectWorkspace({ store, dataDir }, project.id);
  const second = await ensureStandardProjectWorkspace({ store, dataDir }, project.id);

  assert.equal(first.status, "ready");
  assert.deepEqual(second, first);
  if (first.status !== "ready") assert.fail("expected ready Workspace");
  assert.deepEqual(first.artifacts.map((artifact) => [artifact.legacyWrapped, artifact.sourceRoot]), [[true, "."]]);
  assert.deepEqual(first.revisions.map((revision) => revision.legacyRunId), [run.id]);
  assert.deepEqual(captureGit(root), gitBefore);
  assert.deepEqual({
    project: store.db.prepare("SELECT * FROM projects WHERE id = ?").get(project.id),
    variants: store.db.prepare("SELECT * FROM variants WHERE project_id = ? ORDER BY id").all(project.id),
    runs: store.db.prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY id").all(project.id),
  }, legacyBefore);
  assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
  store.close();
});

test("Prototype workspace migration is typed unsupported and changes no Workspace state", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-workspace-prototype-"));
  const store = new Store(join(dataDir, "store.db"));
  const project = store.createProject({ name: "Prototype", mode: "prototype" });
  store.workspace.ensureWorkspaceRecord(project.id);
  const before = {
    workspace: store.db.prepare("SELECT * FROM project_workspaces WHERE project_id = ?").get(project.id),
    graphs: store.db.prepare("SELECT * FROM workspace_graph_revisions ORDER BY revision").all(),
    snapshots: store.db.prepare("SELECT * FROM workspace_snapshots ORDER BY sequence").all(),
    artifacts: store.db.prepare("SELECT * FROM workspace_artifacts").all(),
  };
  let verified = 0;
  const result = await ensureStandardProjectWorkspace({ store, dataDir }, project.id, {
    afterVerification: () => { verified += 1; },
  });
  assert.deepEqual(result, {
    status: "unsupported",
    code: "workspace_requires_standard_project",
    projectId: project.id,
    projectMode: "prototype",
  });
  assert.equal(verified, 0);
  assert.deepEqual({
    workspace: store.db.prepare("SELECT * FROM project_workspaces WHERE project_id = ?").get(project.id),
    graphs: store.db.prepare("SELECT * FROM workspace_graph_revisions ORDER BY revision").all(),
    snapshots: store.db.prepare("SELECT * FROM workspace_snapshots ORDER BY sequence").all(),
    artifacts: store.db.prepare("SELECT * FROM workspace_artifacts").all(),
  }, before);
  store.close();
});

test("completed migration returns before Git verification even when the repository disappears", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-workspace-bypass-"));
  const store = new Store(join(dataDir, "store.db"));
  const project = store.createProject({ name: "Bypass", mode: "standard" });
  const root = join(dataDir, "projects", project.id);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "index.html"), "<main>Bypass</main>\n");
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Dezin Test"]);
  git(root, ["config", "user.email", "dezin@example.test"]);
  git(root, ["add", "index.html"]);
  git(root, ["commit", "-m", "snapshot"]);
  const first = await ensureStandardProjectWorkspace({ store, dataDir }, project.id);
  renameSync(join(root, ".git"), join(root, ".git-gone"));
  const second = await ensureStandardProjectWorkspace({ store, dataDir }, project.id, {
    afterVerification: () => { throw new Error("Git verification was not bypassed"); },
  });
  assert.deepEqual(second, first);
  store.close();
});

test("a partial raw marker fails closed before Git verification", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-workspace-partial-marker-"));
  const store = new Store(join(dataDir, "store.db"));
  const project = store.createProject({ name: "Partial marker", mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);
  store.db.prepare(
    `INSERT INTO workspace_artifacts (
       id, workspace_id, kind, name, source_root, legacy_wrapped,
       active_track_id, archived_at, created_at, updated_at
     ) VALUES ('partial-wrapper', ?, 'page', 'Partial', '.', 1, NULL, NULL, 10, 10)`,
  ).run(foundation.id);
  let verificationReached = false;

  await assert.rejects(
    ensureStandardProjectWorkspace({ store, dataDir }, project.id, {
      afterVerification: () => { verificationReached = true; },
    }),
    /completed legacy Workspace migration is invalid/i,
  );
  assert.equal(verificationReached, false);
  assert.equal(store.workspace.getWorkspace(project.id)?.graphRevision, 0);
  assert.equal(store.workspace.listArtifacts(project.id).length, 1);
  store.close();
});

test("migration retries a whole seed after verified legacy rows drift", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-workspace-drift-"));
  const store = new Store(join(dataDir, "store.db"));
  const project = store.createProject({ name: "Drift retry", mode: "standard" });
  const conversation = store.createConversation(project.id, "Drift");
  const variant = store.createVariant(project.id, "Before");
  const root = join(dataDir, "projects", project.id);
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Dezin Test"]);
  git(root, ["config", "user.email", "dezin@example.test"]);
  writeFileSync(join(root, "index.html"), "commit A\n");
  git(root, ["add", "index.html"]);
  git(root, ["commit", "-m", "commit A"]);
  const commitA = git(root, ["rev-parse", "HEAD"]);
  writeFileSync(join(root, "index.html"), "commit B\n");
  git(root, ["add", "index.html"]);
  git(root, ["commit", "-m", "commit B"]);
  const commitB = git(root, ["rev-parse", "HEAD"]);
  const treeB = git(root, ["rev-parse", `${commitB}^{tree}`]);
  const run = store.createImportedRun(project.id, conversation.id, {
    variantId: variant.id,
    status: "succeeded",
    commitHash: commitA,
    createdAt: 10,
    finishedAt: 11,
  });
  let attempts = 0;
  const verifiedCommits: string[] = [];
  const result = await ensureStandardProjectWorkspace({ store, dataDir }, project.id, {
    afterVerification: (seed, attempt) => {
      attempts = attempt;
      const snapshot = seed.successfulRuns.find((candidate) => candidate.id === run.id)?.gitSnapshot;
      if (snapshot?.status === "verified") verifiedCommits.push(snapshot.sourceCommitHash);
      if (attempt === 1) {
        store.renameVariant(variant.id, "After");
        store.db.prepare("UPDATE runs SET commit_hash = ? WHERE id = ?").run(commitB, run.id);
      }
    },
  });
  assert.equal(result.status, "ready");
  assert.equal(attempts, 2);
  if (result.status !== "ready") assert.fail("expected ready Workspace");
  assert.deepEqual(verifiedCommits, [commitA, commitB]);
  assert.equal(result.tracks.find((track) => track.legacyVariantId === variant.id)?.name, "After");
  assert.equal(result.revisions[0]?.legacyRunId, run.id);
  assert.equal(result.revisions[0]?.sourceCommitHash, commitB);
  assert.equal(result.revisions[0]?.sourceTreeHash, treeB);
  assert.equal(result.snapshots.length, 2);
  assert.equal(result.artifacts.length, 1);
  store.close();
});

test("migration publishes valid successful Runs and omits only Runs whose Git objects are missing", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-workspace-mixed-runs-"));
  const store = new Store(join(dataDir, "store.db"));
  const project = store.createProject({ name: "Mixed Git objects", mode: "standard" });
  const conversation = store.createConversation(project.id, "Mixed");
  const variant = store.createVariant(project.id, "Main");
  const root = join(dataDir, "projects", project.id);
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Dezin Test"]);
  git(root, ["config", "user.email", "dezin@example.test"]);
  writeFileSync(join(root, "index.html"), "available\n");
  git(root, ["add", "index.html"]);
  git(root, ["commit", "-m", "available"]);
  const availableCommit = git(root, ["rev-parse", "HEAD"]);
  const availableRun = store.createImportedRun(project.id, conversation.id, {
    variantId: variant.id,
    status: "succeeded",
    commitHash: availableCommit,
    createdAt: 10,
    finishedAt: 11,
  });
  const missingRun = store.createImportedRun(project.id, conversation.id, {
    variantId: variant.id,
    status: "succeeded",
    commitHash: "f".repeat(40),
    createdAt: 12,
    finishedAt: 13,
  });

  const result = await ensureStandardProjectWorkspace({ store, dataDir }, project.id);

  assert.equal(result.status, "ready");
  if (result.status !== "ready") assert.fail("expected ready Workspace");
  assert.deepEqual(result.revisions.map((revision) => revision.legacyRunId), [availableRun.id]);
  assert.equal(result.revisions[0]?.sourceCommitHash, availableCommit);
  assert.ok(!result.revisions.some((revision) => revision.legacyRunId === missingRun.id));
  store.close();
});

test("two Store connections converge on one legacy wrapper and one set of aliases", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-workspace-concurrent-"));
  const database = join(dataDir, "store.db");
  const firstStore = new Store(database);
  const project = firstStore.createProject({ name: "Concurrent", mode: "standard" });
  const conversation = firstStore.createConversation(project.id, "Concurrent");
  const variant = firstStore.createVariant(project.id, "Main");
  const root = join(dataDir, "projects", project.id);
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Dezin Test"]);
  git(root, ["config", "user.email", "dezin@example.test"]);
  writeFileSync(join(root, "index.html"), "concurrent\n");
  git(root, ["add", "index.html"]);
  git(root, ["commit", "-m", "concurrent"]);
  const run = firstStore.createImportedRun(project.id, conversation.id, {
    variantId: variant.id,
    status: "succeeded",
    commitHash: git(root, ["rev-parse", "HEAD"]),
    createdAt: 10,
    finishedAt: 11,
  });
  const secondStore = new Store(database);

  const [first, second] = await Promise.all([
    ensureStandardProjectWorkspace({ store: firstStore, dataDir }, project.id),
    ensureStandardProjectWorkspace({ store: secondStore, dataDir }, project.id),
  ]);

  assert.equal(first.status, "ready");
  assert.equal(second.status, "ready");
  assert.deepEqual(second, first);
  assert.equal((firstStore.db.prepare(
    "SELECT COUNT(*) AS count FROM workspace_artifacts WHERE legacy_wrapped = 1",
  ).get() as { count: number }).count, 1);
  assert.deepEqual((firstStore.db.prepare(
    `SELECT legacy_variant_id, COUNT(*) AS count
     FROM artifact_tracks WHERE legacy_variant_id IS NOT NULL
     GROUP BY legacy_variant_id`,
  ).all() as Array<{ legacy_variant_id: string; count: number }>).map((row) => [row.legacy_variant_id, row.count]), [
    [variant.id, 1],
  ]);
  assert.deepEqual((firstStore.db.prepare(
    `SELECT legacy_run_id, COUNT(*) AS count
     FROM artifact_revisions WHERE legacy_run_id IS NOT NULL
     GROUP BY legacy_run_id`,
  ).all() as Array<{ legacy_run_id: string; count: number }>).map((row) => [row.legacy_run_id, row.count]), [
    [run.id, 1],
  ]);
  assert.deepEqual(firstStore.db.prepare("PRAGMA foreign_key_check").all(), []);
  secondStore.close();
  firstStore.close();
});

test("migration retries SQLITE_BUSY raised before seed capture", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-workspace-busy-"));
  const store = new Store(join(dataDir, "store.db"));
  const project = store.createProject({ name: "Busy retry", mode: "standard" });
  const original = store.workspace.getBundleByProjectId.bind(store.workspace);
  let reads = 0;
  store.workspace.getBundleByProjectId = ((projectId: string) => {
    reads += 1;
    if (reads === 1) throw Object.assign(new Error("busy"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
    return original(projectId);
  }) as typeof store.workspace.getBundleByProjectId;
  const result = await ensureStandardProjectWorkspace({ store, dataDir }, project.id);
  assert.equal(result.status, "ready");
  assert.ok(reads >= 2);
  store.close();
});

test("Git verification ignores replace refs and hostile inherited Git selectors", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-workspace-replace-"));
  const store = new Store(join(dataDir, "store.db"));
  const project = store.createProject({ name: "Replace immunity", mode: "standard" });
  const conversation = store.createConversation(project.id, "Git");
  const variant = store.createVariant(project.id, "Main");
  const root = join(dataDir, "projects", project.id);
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Dezin Test"]);
  git(root, ["config", "user.email", "dezin@example.test"]);
  writeFileSync(join(root, "index.html"), "first\n");
  git(root, ["add", "index.html"]);
  git(root, ["commit", "-m", "first"]);
  const originalCommit = git(root, ["rev-parse", "HEAD"]);
  const originalTree = git(root, ["--no-replace-objects", "rev-parse", `${originalCommit}^{tree}`]);
  writeFileSync(join(root, "index.html"), "replacement\n");
  git(root, ["add", "index.html"]);
  git(root, ["commit", "-m", "replacement"]);
  const replacementCommit = git(root, ["rev-parse", "HEAD"]);
  git(root, ["replace", originalCommit, replacementCommit]);
  store.createImportedRun(project.id, conversation.id, {
    variantId: variant.id,
    status: "succeeded",
    commitHash: originalCommit.slice(0, 12),
    createdAt: 10,
    finishedAt: 11,
  });
  const other = mkdtempSync(join(tmpdir(), "dezin-hostile-git-dir-"));
  git(other, ["init", "-b", "main"]);
  const oldGitDir = process.env.GIT_DIR;
  const oldConfigCount = process.env.GIT_CONFIG_COUNT;
  const oldConfigKey0 = process.env.GIT_CONFIG_KEY_0;
  const oldConfigValue0 = process.env.GIT_CONFIG_VALUE_0;
  process.env.GIT_DIR = join(other, ".git");
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "core.worktree";
  process.env.GIT_CONFIG_VALUE_0 = other;
  try {
    const result = await ensureStandardProjectWorkspace({ store, dataDir }, project.id);
    assert.equal(result.status, "ready");
    if (result.status !== "ready") assert.fail("expected ready Workspace");
    assert.equal(result.revisions[0]?.sourceCommitHash, originalCommit);
    assert.equal(result.revisions[0]?.sourceTreeHash, originalTree);
  } finally {
    if (oldGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = oldGitDir;
    if (oldConfigCount === undefined) delete process.env.GIT_CONFIG_COUNT;
    else process.env.GIT_CONFIG_COUNT = oldConfigCount;
    if (oldConfigKey0 === undefined) delete process.env.GIT_CONFIG_KEY_0;
    else process.env.GIT_CONFIG_KEY_0 = oldConfigKey0;
    if (oldConfigValue0 === undefined) delete process.env.GIT_CONFIG_VALUE_0;
    else process.env.GIT_CONFIG_VALUE_0 = oldConfigValue0;
    store.close();
  }
});

test("a project directory nested in a parent repository is not treated as its own Git snapshot", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-workspace-parent-git-"));
  git(dataDir, ["init", "-b", "main"]);
  git(dataDir, ["config", "user.name", "Dezin Test"]);
  git(dataDir, ["config", "user.email", "dezin@example.test"]);
  writeFileSync(join(dataDir, "parent.txt"), "parent\n");
  git(dataDir, ["add", "parent.txt"]);
  git(dataDir, ["commit", "-m", "parent"]);
  const parentCommit = git(dataDir, ["rev-parse", "HEAD"]);
  const store = new Store(join(dataDir, "store.db"));
  const project = store.createProject({ name: "Nested", mode: "standard" });
  const conversation = store.createConversation(project.id, "Nested");
  const variant = store.createVariant(project.id, "Main");
  mkdirSync(join(dataDir, "projects", project.id), { recursive: true });
  store.createImportedRun(project.id, conversation.id, {
    variantId: variant.id,
    status: "succeeded",
    commitHash: parentCommit,
    createdAt: 10,
    finishedAt: 11,
  });
  const result = await ensureStandardProjectWorkspace({ store, dataDir }, project.id);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") assert.fail("expected ready Workspace");
  assert.equal(result.revisions.length, 0);
  store.close();
});

test("a project .git symlink cannot disguise a parent repository as an owned Git root", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-workspace-symlink-git-"));
  git(dataDir, ["init", "-b", "main"]);
  git(dataDir, ["config", "user.name", "Dezin Test"]);
  git(dataDir, ["config", "user.email", "dezin@example.test"]);
  writeFileSync(join(dataDir, "parent.txt"), "parent\n");
  git(dataDir, ["add", "parent.txt"]);
  git(dataDir, ["commit", "-m", "parent"]);
  const parentCommit = git(dataDir, ["rev-parse", "HEAD"]);
  const store = new Store(join(dataDir, "store.db"));
  const project = store.createProject({ name: "Symlinked parent", mode: "standard" });
  const conversation = store.createConversation(project.id, "Nested");
  const variant = store.createVariant(project.id, "Main");
  const root = join(dataDir, "projects", project.id);
  mkdirSync(root, { recursive: true });
  symlinkSync(join(dataDir, ".git"), join(root, ".git"), "dir");
  store.createImportedRun(project.id, conversation.id, {
    variantId: variant.id,
    status: "succeeded",
    commitHash: parentCommit,
    createdAt: 10,
    finishedAt: 11,
  });

  const result = await ensureStandardProjectWorkspace({ store, dataDir }, project.id);

  assert.equal(result.status, "ready");
  if (result.status !== "ready") assert.fail("expected ready Workspace");
  assert.equal(result.revisions.length, 0);
  store.close();
});
