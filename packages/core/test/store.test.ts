import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Store, type StoreClock } from "../src/store.ts";
import { asProject } from "../src/store-codecs.ts";

function fakeClock(): StoreClock {
  let time = 1_000;
  let id = 0;
  return {
    now: () => ++time,
    id: () => `id-${++id}`,
  };
}

function freshStore(): Store {
  return new Store(":memory:", fakeClock());
}

test("SQLite schema has no retired Design proposal, task, run, artifact, or variant families", () => {
  const store = freshStore();
  const tables = new Set((store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  ).all() as Array<{ name: string }>).map((row) => row.name));
  for (const retired of [
    "artifacts",
    "artifact_revisions",
    "artifact_tracks",
    "context_packs",
    "conversations",
    "generation_plans",
    "generation_tasks",
    "messages",
    "runs",
    "variants",
    "workspace_artifacts",
    "workspace_proposals",
  ]) {
    assert.equal(tables.has(retired), false, `${retired} must not survive the rebuild`);
  }
  for (const retained of [
    "projects",
    "project_workspaces",
    "resources",
    "resource_revisions",
    "workspace_snapshots",
    "moodboards",
    "custom_effects",
    "settings",
  ]) assert.equal(tables.has(retained), true);
  store.close();
});

test("Project codec and CRUD accept Sharingan identities only", () => {
  const store = freshStore();
  assert.throws(
    () => (store.createProject as (input: unknown) => unknown)({ name: "ordinary" }),
    /Sharingan Projects only/,
  );
  const project = store.createProject({
    name: " Capture ",
    sharingan: true,
    sourceUrl: "https://example.com",
  });
  assert.deepEqual(project, {
    id: "id-1",
    name: "Capture",
    mode: "standard",
    sharingan: true,
    sourceUrl: "https://example.com/",
    createdAt: 1_001,
    updatedAt: 1_001,
    archivedAt: null,
  });
  assert.deepEqual(asProject({
    id: "p1",
    name: "Clone",
    mode: "standard",
    sharingan: 1,
    source_url: "https://source.test/",
    created_at: 1,
    updated_at: 2,
    archived_at: null,
  }).sourceUrl, "https://source.test/");
  assert.equal(store.updateProject(project.id, { name: "Capture renamed" }).name, "Capture renamed");
  assert.notEqual(store.setArchived(project.id, true)?.archivedAt, null);
  store.deleteProject(project.id);
  assert.deepEqual(store.listProjects(), []);
  store.close();
});

test("Sharingan Workspace resource revisions publish through immutable snapshots", () => {
  const store = freshStore();
  const project = store.createProject({
    name: "Capture workspace",
    sharingan: true,
    sourceUrl: "https://example.com/capture",
  });
  const foundation = store.workspace.ensureSharinganWorkspaceFoundation(project.id);
  assert.deepEqual(store.workspace.ensureSharinganWorkspaceFoundation(project.id), foundation);
  assert.equal(store.workspace.getGraph(project.id).revision, 0);
  assert.deepEqual(store.workspace.listResources(project.id), []);
  assert.deepEqual(store.workspace.listResources("missing-project"), []);
  assert.deepEqual(store.workspace.listSnapshots("missing-project"), []);
  assert.throws(() => store.workspace.ensureSharinganWorkspaceFoundation("missing-project"), /requires one active Sharingan Project/);
  assert.throws(() => store.workspace.listResourceRevisions(project.id, "missing-resource"), /was not found/);
  assert.throws(() => store.workspace.createResourceForProject(project.id, {
    kind: "sharingan-capture",
    title: "Stale graph",
    defaultPinPolicy: "pin-current",
    baseGraphRevision: foundation.graphRevision + 1,
    expectedSnapshotId: foundation.activeSnapshotId,
  }), /Revision conflict/);
  assert.throws(() => store.workspace.createResourceForProject(project.id, {
    kind: "sharingan-capture",
    title: "Stale snapshot",
    defaultPinPolicy: "pin-current",
    baseGraphRevision: foundation.graphRevision,
    expectedSnapshotId: "snapshot-stale",
  }), /active-snapshot conflict/);

  const created = store.workspace.createResourceForProject(project.id, {
    kind: "sharingan-capture",
    title: "Primary capture",
    defaultPinPolicy: "pin-current",
    baseGraphRevision: foundation.graphRevision,
    expectedSnapshotId: foundation.activeSnapshotId,
  });
  assert.equal(created.graph.revision, 1);
  assert.equal(created.graph.nodes[0]?.resourceId, created.resource.id);
  assert.equal(created.snapshot.provenance.kind, "graph-command");
  assert.deepEqual(store.workspace.listResources(project.id), [created.resource]);
  assert.throws(() => store.workspace.createResourceForProject(project.id, {
    kind: "sharingan-capture",
    title: "Duplicate capture",
    defaultPinPolicy: "pin-current",
    baseGraphRevision: created.graph.revision,
    expectedSnapshotId: created.snapshot.id,
  }), /already owns a capture Resource/);

  const checksumOne = "a".repeat(64);
  const revisionOne = store.workspace.createResourceRevisionCandidateForProject(project.id, created.resource.id, {
    revisionId: "revision-one",
    parentRevisionId: null,
    manifestPath: "captures/revision-one/manifest.json",
    summary: "Initial immutable capture",
    metadata: { width: 1440, height: 900 },
    checksum: checksumOne,
    provenance: { source: "browser-capture" },
  });
  assert.equal(revisionOne.sequence, 1);
  assert.throws(() => store.workspace.createResourceRevisionCandidateForProject(project.id, created.resource.id, {
    revisionId: revisionOne.id,
    parentRevisionId: null,
    manifestPath: "captures/collision/manifest.json",
    summary: "Identity collision",
    metadata: {},
    checksum: "d".repeat(64),
    provenance: {},
  }), /identity collision/);
  assert.equal(store.workspace.getResourceRevisionForProject(project.id, created.resource.id, "missing"), null);
  assert.throws(() => store.workspace.publishResourceRevisionForProject(
    project.id,
    created.resource.id,
    "missing-revision",
    {
      expectedHeadRevisionId: null,
      expectedSnapshotId: created.snapshot.id,
      reason: "Missing revision",
    },
  ), /Revision was not found/);
  assert.equal(
    store.workspace.getResourceRevisionViewFactsForProject(project.id, created.resource.id, revisionOne.id)?.snapshotId,
    created.snapshot.id,
  );
  const snapshotOne = store.workspace.publishResourceRevisionForProject(
    project.id,
    created.resource.id,
    revisionOne.id,
    {
      expectedHeadRevisionId: null,
      expectedSnapshotId: created.snapshot.id,
      reason: "Publish first capture",
    },
  );
  assert.equal(snapshotOne.resourceRevisions[created.resource.id], revisionOne.id);
  assert.equal(snapshotOne.provenance.kind, "resource-publication");
  assert.equal(store.workspace.getResourceForProject(project.id, created.resource.id)?.headRevisionId, revisionOne.id);

  const revisionTwo = store.workspace.createResourceRevisionCandidateForProject(project.id, created.resource.id, {
    revisionId: "revision-two",
    parentRevisionId: revisionOne.id,
    manifestPath: "captures/revision-two/manifest.json",
    summary: "Updated immutable capture",
    metadata: { width: 1440, height: 900, pageCount: 2 },
    checksum: "b".repeat(64),
    provenance: { source: "browser-capture", parent: revisionOne.id },
  });
  assert.throws(() => store.workspace.publishResourceRevisionForProject(
    project.id,
    created.resource.id,
    revisionTwo.id,
    {
      expectedHeadRevisionId: revisionOne.id,
      expectedSnapshotId: created.snapshot.id,
      reason: "Stale Snapshot",
    },
  ), /active-snapshot conflict/);
  const snapshotTwo = store.workspace.publishResourceRevisionForProject(
    project.id,
    created.resource.id,
    revisionTwo.id,
    {
      expectedHeadRevisionId: revisionOne.id,
      expectedSnapshotId: snapshotOne.id,
      reason: "Publish second capture",
    },
  );
  assert.deepEqual(
    store.workspace.listResourceRevisions(project.id, created.resource.id).map((revision) => revision.id),
    [revisionOne.id, revisionTwo.id],
  );
  assert.deepEqual(
    store.workspace.listSnapshots(project.id).map((snapshot) => snapshot.sequence),
    [1, 2, 3, 4],
  );
  assert.equal(snapshotTwo.parentSnapshotId, snapshotOne.id);
  assert.equal(snapshotTwo.resourceRevisions[created.resource.id], revisionTwo.id);

  const foreign = store.createProject({
    name: "Foreign capture",
    sharingan: true,
    sourceUrl: "https://example.com/foreign",
  });
  store.workspace.ensureSharinganWorkspaceFoundation(foreign.id);
  assert.throws(
    () => store.workspace.getResourceForProject(foreign.id, created.resource.id),
    /belongs to another Project/,
  );
  assert.throws(
    () => store.workspace.createResourceRevisionCandidateForProject(project.id, created.resource.id, {
      revisionId: "revision-stale",
      parentRevisionId: revisionOne.id,
      manifestPath: "captures/stale/manifest.json",
      summary: "Stale candidate",
      metadata: {},
      checksum: "c".repeat(64),
      provenance: {},
    }),
    /resource-head conflict/,
  );
  store.close();
});

test("Moodboard nodes, edited assets, conversations, and messages round-trip", () => {
  const store = freshStore();
  const board = store.createMoodboard({ name: "References" });
  const asset = store.createMoodboardAsset(board.id, {
    kind: "image",
    fileName: "edited.png",
    mimeType: "image/png",
    width: 320,
    height: 200,
    source: "edited",
  });
  assert.equal(asset.source, "edited");
  const [node] = store.replaceMoodboardNodes(board.id, [{
    type: "image",
    x: 10,
    y: 20,
    width: 100,
    height: 80,
    data: { assetId: asset.id },
  }]);
  assert.equal(node?.data.assetId, asset.id);
  const conversation = store.ensureMoodboardConversation(board.id);
  store.addMoodboardMessage(board.id, "user", "Use this", conversation.id);
  store.addMoodboardMessage(board.id, "assistant", "Got it", conversation.id);
  assert.equal(store.listMoodboardConversations(board.id)[0]?.turns, 1);
  assert.deepEqual(
    store.listMoodboardMessages(board.id, conversation.id).map((message) => message.role),
    ["user", "assistant"],
  );
  store.close();
});

test("Custom effect image parameters and presets round-trip", () => {
  const store = freshStore();
  const effect = store.createEffect({
    name: "Texture",
    parameters: [{ id: "image", label: "Image", type: "image", defaultValue: "" }],
    presets: [{ id: "soft", name: "Soft", values: { image: "asset.png" } }],
  });
  assert.equal(effect.parameters[0]?.type, "image");
  assert.equal(effect.presets[0]?.values.image, "asset.png");
  assert.equal(store.updateEffect(effect.id, { summary: "Updated" }).summary, "Updated");
  store.deleteEffect(effect.id);
  assert.deepEqual(store.listEffects(), []);
  store.close();
});

test("Settings and extension credentials remain independent store domains", () => {
  const store = freshStore();
  assert.equal(store.updateSettings({ model: "test-model", customInstructions: "Keep the craft high." }).model, "test-model");
  assert.equal(store.getSettings().customInstructions, "Keep the craft high.");
  assert.equal(Object.hasOwn(store.getSettings(), "visualQaEnabled"), false);

  const tokenHash = createHash("sha256").update("token").digest("hex");
  const credential = store.createExtensionCredential({
    tokenHash,
    extensionId: "extension.test",
    scopes: ["capture:write", "capture:write"],
  });
  assert.deepEqual(credential.scopes, ["capture:write"]);
  assert.equal(store.touchExtensionCredential(credential.id), true);
  assert.notEqual(store.listExtensionCredentials()[0]?.lastUsedAt, null);
  assert.equal(store.revokeExtensionCredential(credential.id), true);
  assert.deepEqual(store.listExtensionCredentials(), []);
  assert.equal(store.listExtensionCredentials({ includeRevoked: true }).length, 1);
  store.close();
});

test("opening a legacy store atomically removes retired Design tables while preserving independent domains", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dezin-current-store-"));
  const path = join(directory, "app.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));

  const original = new Store(path, fakeClock());
  original.updateSettings({ model: "preserved-model", customInstructions: "Preserve me" });
  const board = original.createMoodboard({ name: "Preserved board" });
  original.createEffect({ name: "Preserved effect" });
  const tokenHash = createHash("sha256").update("preserved-token").digest("hex");
  original.createExtensionCredential({
    tokenHash,
    extensionId: "preserved.extension",
    scopes: ["capture:write"],
  });
  const project = original.createProject({
    name: "Preserved Sharingan",
    sharingan: true,
    sourceUrl: "https://example.com/preserved",
  });
  original.workspace.ensureSharinganWorkspaceFoundation(project.id);
  original.close();

  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, project_id TEXT, status TEXT);
    INSERT INTO runs (id, project_id, status) VALUES ('legacy-run', '${project.id}', 'succeeded');
    CREATE TABLE artifacts (id TEXT PRIMARY KEY, project_id TEXT);
    INSERT INTO artifacts (id, project_id) VALUES ('legacy-artifact', '${project.id}');
    CREATE TABLE quality_ignores (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      rule_id TEXT NOT NULL,
      selector TEXT,
      created_at INTEGER NOT NULL
    );
    INSERT INTO quality_ignores (id, project_id, rule_id, selector, created_at)
      VALUES ('legacy-ignore', '${project.id}', 'legacy-rule', '.legacy', 1);
  `);
  legacy.close();

  const rebuilt = new Store(path, fakeClock());
  assert.match(rebuilt.legacyDesignBackupPath ?? "", /\.legacy-design-backup-\d+-\d+\.sqlite$/);
  const backup = new DatabaseSync(rebuilt.legacyDesignBackupPath!, { readOnly: true });
  assert.equal((backup.prepare("SELECT status FROM runs WHERE id = 'legacy-run'").get() as { status: string }).status, "succeeded");
  assert.equal((backup.prepare("SELECT project_id FROM artifacts WHERE id = 'legacy-artifact'").get() as { project_id: string }).project_id, project.id);
  backup.close();
  const tables = new Set((rebuilt.db.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).all() as Array<{ name: string }>).map((row) => row.name));
  assert.equal(tables.size, 16);
  assert.equal(tables.has("runs"), false);
  assert.equal(tables.has("artifacts"), false);
  assert.equal(tables.has("quality_ignores"), false);
  assert.equal(rebuilt.getSettings().model, "preserved-model");
  assert.equal(rebuilt.getSettings().customInstructions, "Preserve me");
  assert.equal(rebuilt.getMoodboard(board.id)?.name, "Preserved board");
  assert.equal(rebuilt.listEffects()[0]?.name, "Preserved effect");
  assert.equal(rebuilt.listExtensionCredentials()[0]?.extensionId, "preserved.extension");
  assert.equal(rebuilt.getProject(project.id)?.sourceUrl, "https://example.com/preserved");
  assert.notEqual(rebuilt.workspace.getWorkspace(project.id), null);
  const revisionColumns = (rebuilt.db.prepare("PRAGMA table_info(resource_revisions)").all() as Array<{ name: string }>)
    .map((row) => row.name);
  const snapshotColumns = (rebuilt.db.prepare("PRAGMA table_info(workspace_snapshots)").all() as Array<{ name: string }>)
    .map((row) => row.name);
  assert.equal(revisionColumns.includes("created_by_run_id"), false);
  assert.equal(snapshotColumns.includes("created_by_run_id"), false);
  rebuilt.close();
});

test("Store configures a bounded busy timeout", () => {
  const store = freshStore();
  const row = store.db.prepare("PRAGMA busy_timeout").get() as Record<string, unknown>;
  assert.equal(Number(Object.values(row)[0]), 5_000);
  store.close();
});

test("settings added after a database was created arrive as additive columns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dezin-store-settings-migration-"));
  const path = join(dir, "app.sqlite");
  try {
    new Store(path).close();
    const raw = new DatabaseSync(path);
    raw.exec("ALTER TABLE settings DROP COLUMN quality_lint");
    raw.exec("ALTER TABLE settings DROP COLUMN visual_review");
    raw.close();
    const store = new Store(path);
    try {
      assert.equal(store.getSettings().qualityLint, true);
      assert.equal(store.getSettings().visualReview, false);
      assert.equal(store.updateSettings({ visualReview: true, qualityLint: false }).visualReview, true);
      assert.equal(store.getSettings().qualityLint, false);
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
