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
