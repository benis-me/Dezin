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

test("updateMessage replaces a message's content in place (not a new row)", () => {
  const s = freshStore();
  const p = s.createProject({ name: "P" });
  const c = s.createConversation(p.id, "Chat");
  const m = s.addMessage(c.id, "system", JSON.stringify({ research: { status: "running", activities: [] } }));
  s.updateMessage(m.id, JSON.stringify({ research: { status: "running", activities: [{ kind: "search", text: "x", track: "product" }] } }));
  const msgs = s.listMessages(c.id);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0]!.content, /"text":"x"/);
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

test("Store configures a busy timeout for concurrent sqlite writers", () => {
  const s = freshStore();
  const row = s.db.prepare("PRAGMA busy_timeout").get() as Record<string, unknown>;
  assert.equal(Number(Object.values(row)[0]), 5000);
  s.close();
});

test("markInterruptedRuns only sweeps runs owned by this daemon", () => {
  const s = freshStore();
  const p = s.createProject({ name: "P" });
  const c = s.createConversation(p.id);
  const own = s.createRun(p.id, c.id, undefined, undefined, "daemon-a");
  const other = s.createRun(p.id, c.id, undefined, undefined, "daemon-b");
  s.updateRun(own.id, { status: "running" });
  s.updateRun(other.id, { status: "running" });

  assert.equal(s.markInterruptedRuns("daemon-a"), 1);
  assert.equal(s.getRun(own.id)?.status, "cancelled");
  assert.equal(s.getRun(other.id)?.status, "running");
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

test("updateRun persists final quality findings", () => {
  const s = freshStore();
  const p = s.createProject({ name: "P" });
  const c = s.createConversation(p.id);
  const r = s.createRun(p.id, c.id);
  s.updateRun(r.id, {
    status: "succeeded",
    score: 94,
    lintPassed: true,
    findings: [{ severity: "P2", id: "raw-hex", message: "2 raw hex values outside :root.", fix: "Move colours into tokens." }],
  });

  const run = s.getRun(r.id)!;
  assert.equal(run.findings.length, 1);
  assert.equal(run.findings[0]?.id, "raw-hex");
  assert.equal(s.listRuns(p.id)[0]?.findings[0]?.message, "2 raw hex values outside :root.");
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
  assert.equal(d.visualQaEnabled, false);
  assert.equal(d.visualQaAgentCommand, "");
  assert.equal(d.visualQaModel, "");
  assert.equal(d.researchAgentCommand, "");
  assert.equal(d.researchModel, "");
  assert.equal(d.autoImproveEnabled, true);
  assert.equal(d.autoImproveMaxRounds, 8);
  assert.equal(d.videoModel, "");

  const u = s.updateSettings({
    agentCommand: "codex",
    model: "o3",
    customInstructions: "be terse",
    videoModel: "sora",
    visualQaEnabled: true,
    visualQaAgentCommand: "codebuddy",
    visualQaModel: "hunyuan",
    researchAgentCommand: "codex",
    researchModel: "o4",
    autoImproveEnabled: false,
    autoImproveMaxRounds: 5,
  });
  assert.equal(u.agentCommand, "codex");
  assert.equal(u.model, "o3");
  assert.equal(s.getSettings().customInstructions, "be terse");
  assert.equal(s.getSettings().videoModel, "sora");
  assert.equal(s.getSettings().visualQaEnabled, true);
  assert.equal(s.getSettings().visualQaAgentCommand, "codebuddy");
  assert.equal(s.getSettings().visualQaModel, "hunyuan");
  assert.equal(s.getSettings().researchAgentCommand, "codex");
  assert.equal(s.getSettings().researchModel, "o4");
  assert.equal(s.getSettings().autoImproveEnabled, false);
  assert.equal(s.getSettings().autoImproveMaxRounds, 5);

  // a partial update only changes the given fields
  s.updateSettings({ model: "o4" });
  const after = s.getSettings();
  assert.equal(after.model, "o4");
  assert.equal(after.agentCommand, "codex");
  assert.equal(after.customInstructions, "be terse");
  assert.equal(after.videoModel, "sora");
  assert.equal(after.visualQaEnabled, true);
  assert.equal(after.visualQaAgentCommand, "codebuddy");
  assert.equal(after.visualQaModel, "hunyuan");
  assert.equal(after.autoImproveEnabled, false);
  assert.equal(after.autoImproveMaxRounds, 5);
  s.close();
});

test("autoFixLiveRuntimeErrors round-trips through settings", () => {
  const s = freshStore();
  assert.equal(s.getSettings().autoFixLiveRuntimeErrors, false);
  s.updateSettings({ autoFixLiveRuntimeErrors: true });
  assert.equal(s.getSettings().autoFixLiveRuntimeErrors, true);
  s.close();
});

test("moodboards persist nodes, assets, and messages", () => {
  const s = freshStore();
  const board = s.createMoodboard({ name: "Launch references" });
  assert.equal(board.id, "id-1");
  assert.equal(s.listMoodboards().length, 1);

  const asset = s.createMoodboardAsset(board.id, {
    kind: "image",
    fileName: "hero.png",
    mimeType: "image/png",
    width: 1200,
    height: 800,
    source: "upload",
  });
  assert.equal(asset.boardId, board.id);
  assert.equal(s.getMoodboard(board.id)?.coverAssetId, asset.id);

  const nodes = s.replaceMoodboardNodes(board.id, [
    { type: "section", x: 0, y: 0, width: 400, height: 260, data: { title: "Direction" } },
    {
      type: "image-generator",
      x: 16,
      y: 24,
      width: 360,
      height: 240,
      zIndex: 1,
      data: { generatorPrompt: "Soft studio references", generatorStatus: "ready" },
    },
    { type: "image", x: 24, y: 48, width: 320, height: 213, zIndex: 2, data: { assetId: asset.id } },
  ]);
  assert.equal(nodes.length, 3);
  assert.equal(nodes[0]?.type, "section");
  assert.equal(nodes[1]?.type, "image-generator");
  assert.equal(nodes[1]?.data.generatorStatus, "ready");
  assert.equal(nodes[2]?.data.assetId, asset.id);

  const msg = s.addMoodboardMessage(board.id, "user", "Collect softer references");
  assert.equal(msg.content, "Collect softer references");
  assert.equal(s.listMoodboardMessages(board.id).length, 1);
  assert.equal(s.listMoodboardConversations(board.id).length, 1);

  s.setMoodboardArchived(board.id, true);
  assert.ok(s.getMoodboard(board.id)?.archivedAt);
  s.deleteMoodboard(board.id);
  assert.equal(s.getMoodboard(board.id), null);
  assert.equal(s.listMoodboardNodes(board.id).length, 0);
  s.close();
});

test("custom effects persist editable code, parameters, and presets", () => {
  const s = freshStore();
  const effect = s.createEffect({
    name: "Glass ribbon",
    code: "function renderEffect(ctx, params) { ctx.clearRect(0, 0, params.width, params.height); }",
    parameters: [{ id: "strength", label: "Strength", type: "number", min: 0, max: 1, step: 0.01, defaultValue: 0.5 }],
    presets: [{ id: "default", name: "Default", values: { strength: 0.5 } }],
  });

  assert.equal(effect.id, "id-1");
  assert.equal(effect.origin, "custom");
  assert.equal(s.listEffects().length, 1);
  assert.equal(s.getEffect(effect.id)?.parameters[0]?.id, "strength");

  const updated = s.updateEffect(effect.id, {
    name: "Glass ribbon v2",
    code: "function renderEffect(ctx, params) { ctx.fillRect(0, 0, params.width, params.height); }",
    presets: [
      { id: "default", name: "Default", values: { strength: 0.5 } },
      { id: "dense", name: "Dense", values: { strength: 0.9 } },
    ],
  });
  assert.equal(updated.name, "Glass ribbon v2");
  assert.equal(updated.presets.length, 2);
  assert.ok(updated.updatedAt > effect.updatedAt);

  s.deleteEffect(effect.id);
  assert.equal(s.getEffect(effect.id), null);
  s.close();
});

test("moodboard conversations isolate messages per board conversation", () => {
  const s = freshStore();
  const board = s.createMoodboard({ name: "Material board" });
  const first = s.ensureMoodboardConversation(board.id);
  const second = s.createMoodboardConversation(board.id, "Alternate direction");

  s.addMoodboardMessage(board.id, "user", "Explore warm references", first.id);
  s.addMoodboardMessage(board.id, "assistant", "Use amber lighting.", first.id);
  s.addMoodboardMessage(board.id, "user", "Explore cooler references", second.id);

  assert.deepEqual(
    s.listMoodboardMessages(board.id, first.id).map((message) => message.content),
    ["Explore warm references", "Use amber lighting."],
  );
  assert.deepEqual(
    s.listMoodboardMessages(board.id, second.id).map((message) => message.content),
    ["Explore cooler references"],
  );
  assert.deepEqual(
    s.listMoodboardConversations(board.id).map((conversation) => [conversation.title, conversation.turns]),
    [
      ["Conversation 1", 1],
      ["Alternate direction", 1],
    ],
  );
  assert.throws(() => s.addMoodboardMessage(board.id, "user", "wrong board", "missing"), /moodboard conversation not found/);
  s.close();
});

test("updateRun throws on unknown id", () => {
  const s = freshStore();
  assert.throws(() => s.updateRun("nope", { status: "failed" }), /run not found/);
  s.close();
});

test("quality ignores: add, list, and remove persist per project", () => {
  const s = freshStore();
  const p = s.createProject({ name: "P" });
  const a = s.addQualityIgnore(p.id, "low-contrast", "p.muted");
  s.addQualityIgnore(p.id, "cream-palette", null);
  const list = s.listQualityIgnores(p.id);
  assert.equal(list.length, 2);
  assert.ok(list.some((i) => i.ruleId === "low-contrast" && i.selector === "p.muted"));
  assert.ok(list.some((i) => i.ruleId === "cream-palette" && i.selector === null));
  s.removeQualityIgnore(a.id);
  const after = s.listQualityIgnores(p.id);
  assert.equal(after.length, 1);
  assert.equal(after[0]!.ruleId, "cream-palette");
});
