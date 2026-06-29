import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type StoreClock } from "../src/store.ts";

/** Deterministic clock so tests don't depend on wall time / random uuids. */
function fakeClock(): StoreClock {
  let t = 1_000;
  let n = 0;
  return {
    now: () => (t += 1),
    id: () => `id-${++n}`,
  };
}

function freshStore(): Store {
  return new Store(":memory:", fakeClock());
}

test("project CRUD round-trips", () => {
  const s = freshStore();
  const p = s.createProject({ name: "Landing", designSystemId: "modern-minimal" });
  assert.equal(p.id, "id-1");
  assert.equal(p.name, "Landing");
  assert.equal(p.designSystemId, "modern-minimal");
  assert.equal(p.skillId, null);

  assert.deepEqual(s.getProject(p.id), p);
  assert.equal(s.listProjects().length, 1);

  const updated = s.updateProject(p.id, { name: "Landing v2", skillId: "frontend-design" });
  assert.equal(updated.name, "Landing v2");
  assert.equal(updated.skillId, "frontend-design");
  assert.ok(updated.updatedAt > p.updatedAt);

  s.deleteProject(p.id);
  assert.equal(s.getProject(p.id), null);
  assert.equal(s.listProjects().length, 0);
  s.close();
});

test("conversations + messages preserve order", () => {
  const s = freshStore();
  const p = s.createProject({ name: "P" });
  const c = s.createConversation(p.id, "Chat");
  assert.equal(c.projectId, p.id);

  s.addMessage(c.id, "user", "make me a pricing page");
  s.addMessage(c.id, "assistant", "on it");
  const msgs = s.listMessages(c.id);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0]?.role, "user");
  assert.equal(msgs[1]?.content, "on it");
  assert.deepEqual(
    s.listConversations(p.id).map((x) => x.id),
    [c.id],
  );
  s.close();
});

test("run lifecycle: pending → running → succeeded", () => {
  const s = freshStore();
  const p = s.createProject({ name: "P" });
  const c = s.createConversation(p.id);
  const run = s.createRun(p.id, c.id);
  assert.equal(run.status, "pending");
  assert.equal(run.lintPassed, false);
  assert.equal(run.finishedAt, null);

  s.updateRun(run.id, { status: "running" });
  assert.equal(s.getRun(run.id)?.status, "running");

  const done = s.updateRun(run.id, {
    status: "succeeded",
    repairRounds: 1,
    lintPassed: true,
    finishedAt: 9_999,
  });
  assert.equal(done.status, "succeeded");
  assert.equal(done.repairRounds, 1);
  assert.equal(done.lintPassed, true);
  assert.equal(done.finishedAt, 9_999);
  assert.equal(done.score, null);
  s.close();
});

test("Store migrates a pre-existing runs table that lacks the score column", () => {
  const file = join(mkdtempSync(join(tmpdir(), "dezin-mig-")), "old.db");
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, skill_id TEXT, design_system_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL, status TEXT NOT NULL, repair_rounds INTEGER NOT NULL DEFAULT 0, lint_passed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, finished_at INTEGER);
  `);
  old.close();

  const s = new Store(file); // constructor runs the migration
  const p = s.createProject({ name: "P" });
  const c = s.createConversation(p.id);
  const r = s.createRun(p.id, c.id);
  const done = s.updateRun(r.id, { status: "succeeded", score: 88 });
  assert.equal(done.score, 88);
  s.close();
});

test("updateRun persists a quality score; listRuns is newest-first", () => {
  const s = freshStore();
  const p = s.createProject({ name: "P" });
  const c = s.createConversation(p.id);
  const r1 = s.createRun(p.id, c.id);
  s.updateRun(r1.id, { status: "succeeded", score: 92, lintPassed: true });
  const r2 = s.createRun(p.id, c.id);
  s.updateRun(r2.id, { status: "succeeded", score: 100 });

  assert.equal(s.getRun(r1.id)?.score, 92);
  const runs = s.listRuns(p.id);
  assert.equal(runs.length, 2);
  assert.equal(runs[0]?.id, r2.id); // newest first
  assert.equal(runs[0]?.score, 100);
  assert.equal(runs[1]?.score, 92);
  s.close();
});

test("artifacts record per project, newest first", () => {
  const s = freshStore();
  const p = s.createProject({ name: "P" });
  s.recordArtifact(p.id, "index.html", true);
  s.recordArtifact(p.id, "about.html", false);
  const arts = s.listArtifacts(p.id);
  assert.equal(arts.length, 2);
  assert.equal(arts[0]?.path, "about.html"); // newest first
  assert.equal(arts[0]?.lintPassed, false);
  assert.equal(arts[1]?.lintPassed, true);
  s.close();
});

test("foreign key cascade deletes children with the project", () => {
  const s = freshStore();
  const p = s.createProject({ name: "P" });
  const c = s.createConversation(p.id);
  s.addMessage(c.id, "user", "hi");
  s.createRun(p.id, c.id);
  s.recordArtifact(p.id, "index.html", true);

  s.deleteProject(p.id);
  assert.equal(s.listConversations(p.id).length, 0);
  assert.equal(s.listMessages(c.id).length, 0);
  assert.equal(s.listArtifacts(p.id).length, 0);
  s.close();
});

test("listMessages keeps insertion order when created_at ties (rowid tiebreak)", () => {
  // ids that sort OPPOSITE to insertion order — only a rowid tiebreak yields insertion order.
  let n = 0;
  const s = new Store(":memory:", { now: () => 1000, id: () => `z-${(1000 - ++n).toString().padStart(4, "0")}` });
  const p = s.createProject({ name: "P" });
  const c = s.createConversation(p.id);
  ["a", "b", "c"].forEach((t) => s.addMessage(c.id, "user", t));
  assert.deepEqual(
    s.listMessages(c.id).map((m) => m.content),
    ["a", "b", "c"],
  );
  s.close();
});

test("settings: defaults, round-trip, and partial merge", () => {
  const s = freshStore();
  const d = s.getSettings();
  assert.equal(d.agentCommand, "claude");
  assert.equal(d.defaultDesignSystemId, "modern-minimal");
  assert.equal(d.model, "");

  const u = s.updateSettings({ agentCommand: "codex", model: "o3", customInstructions: "be terse" });
  assert.equal(u.agentCommand, "codex");
  assert.equal(u.model, "o3");
  assert.equal(s.getSettings().customInstructions, "be terse");

  // a partial update only changes the given fields
  s.updateSettings({ model: "o4" });
  const after = s.getSettings();
  assert.equal(after.model, "o4");
  assert.equal(after.agentCommand, "codex");
  assert.equal(after.customInstructions, "be terse");
  s.close();
});

test("updateRun throws on unknown id", () => {
  const s = freshStore();
  assert.throws(() => s.updateRun("nope", { status: "failed" }), /run not found/);
  s.close();
});
