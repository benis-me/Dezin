import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp } from "../src/index.ts";
import { MAX_PROJECT_ARCHIVE_UNCOMPRESSED_BYTES } from "../src/export-handler.ts";

interface Ctx {
  base: string;
  dataDir: string;
  store: Store;
}

async function withServer(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-export-"));
  const store = new Store(":memory:");
  const server = createApp({ store, dataDir });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn({ base: `http://127.0.0.1:${port}`, dataDir, store });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
}

function readZip(zip: Buffer): Array<{ path: string; data: Buffer }> {
  const out: Array<{ path: string; data: Buffer }> = [];
  let o = 0;
  while (o + 4 <= zip.length && zip.readUInt32LE(o) === 0x04034b50) {
    const compSize = zip.readUInt32LE(o + 18);
    const nameLen = zip.readUInt16LE(o + 26);
    const extraLen = zip.readUInt16LE(o + 28);
    const path = zip.toString("utf8", o + 30, o + 30 + nameLen);
    const start = o + 30 + nameLen + extraLen;
    out.push({ path, data: inflateRawSync(zip.subarray(start, start + compSize)) });
    o = start + compSize;
  }
  return out;
}

function zipEntry(path: string, data: Buffer, uncompressedSize = data.length): Buffer {
  const name = Buffer.from(path, "utf8");
  const compressed = deflateRawSync(data);
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(uncompressedSize, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  name.copy(local, 30);
  return Buffer.concat([local, compressed]);
}

test("export returns a zip of the project's artifact files", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "P" });
    const dir = join(dataDir, "projects", project.id);
    mkdirSync(join(dir, "assets"), { recursive: true });
    mkdirSync(join(dir, ".refs"), { recursive: true });
    mkdirSync(join(dir, ".git"), { recursive: true });
    mkdirSync(join(dir, ".vite"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<h1>hello</h1>");
    writeFileSync(join(dir, "assets", "style.css"), ":root{--accent:#2563eb}");
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    writeFileSync(join(dir, ".env.example"), "PUBLIC_API_URL=\n");
    writeFileSync(join(dir, ".env"), "SECRET=do-not-export\n");
    writeFileSync(join(dir, ".git", "config"), "[remote]\n");
    writeFileSync(join(dir, ".vite", "cache"), "cache");
    writeFileSync(join(dir, ".refs", "reference.txt"), "ref-data");
    writeFileSync(join(dir, ".cover.png"), Buffer.from([1, 2, 3]));

    const res = await fetch(`${base}/api/projects/${project.id}/export`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/zip");
    assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename=/);

    const zip = Buffer.from(await res.arrayBuffer());
    assert.ok(zip.length > 0);
    assert.equal(zip.readUInt32LE(0), 0x04034b50, "is a PK zip");
    const entries = readZip(zip);
    assert.equal(entries.length, 4);
    const index = entries.find((e) => e.path === "index.html");
    const css = entries.find((e) => e.path === "assets/style.css");
    assert.equal(index?.data.toString("utf8"), "<h1>hello</h1>");
    assert.equal(css?.data.toString("utf8"), ":root{--accent:#2563eb}");
    assert.equal(entries.find((e) => e.path === ".gitignore")?.data.toString("utf8"), "node_modules\n");
    assert.equal(entries.find((e) => e.path === ".env.example")?.data.toString("utf8"), "PUBLIC_API_URL=\n");
    assert.equal(entries.find((e) => e.path === ".env"), undefined);
    assert.equal(entries.find((e) => e.path === ".git/config"), undefined);
    assert.equal(entries.find((e) => e.path === ".vite/cache"), undefined);
  });
});

test("full export includes project metadata, conversations, and source files", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "P", skillId: "frontend-design", designSystemId: "modern-minimal", mode: "prototype" });
    const conv = store.createConversation(project.id, "Chat");
    store.addMessage(conv.id, "user", "make a hero");
    store.addMessage(conv.id, "assistant", "done");
    const dir = join(dataDir, "projects", project.id);
    mkdirSync(join(dir, "assets"), { recursive: true });
    mkdirSync(join(dir, ".refs"), { recursive: true });
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<h1>hello</h1>");
    writeFileSync(join(dir, "assets", "style.css"), ":root{--accent:#2563eb}");
    writeFileSync(join(dir, ".gitignore"), "dist\n");
    writeFileSync(join(dir, ".env.example"), "PUBLIC_API_URL=\n");
    writeFileSync(join(dir, ".env"), "SECRET=do-not-export\n");
    writeFileSync(join(dir, ".git", "config"), "[remote]\n");
    writeFileSync(join(dir, ".refs", "reference.txt"), "ref-data");
    writeFileSync(join(dir, ".cover.png"), Buffer.from([1, 2, 3]));

    const res = await fetch(`${base}/api/projects/${project.id}/export?scope=full`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition") ?? "", /dezin-full-project-/);

    const entries = readZip(Buffer.from(await res.arrayBuffer()));
    const manifest = JSON.parse(entries.find((e) => e.path === "dezin-project.json")?.data.toString("utf8") ?? "{}") as {
      format?: string;
      project?: { name?: string; skillId?: string; designSystemId?: string; mode?: string };
      conversations?: Array<{ title?: string; messages?: Array<{ role?: string; content?: string }> }>;
    };
    assert.equal(manifest.format, "dezin-project");
    assert.deepEqual(
      {
        name: manifest.project?.name,
        skillId: manifest.project?.skillId,
        designSystemId: manifest.project?.designSystemId,
        mode: manifest.project?.mode,
      },
      {
        name: "P",
        skillId: "frontend-design",
        designSystemId: "modern-minimal",
        mode: "prototype",
      },
    );
    assert.equal(manifest.conversations?.[0]?.title, "Chat");
    assert.equal(manifest.conversations?.[0]?.messages?.[0]?.content, "make a hero");
    assert.equal(entries.find((e) => e.path === "source/index.html")?.data.toString("utf8"), "<h1>hello</h1>");
    assert.equal(entries.find((e) => e.path === "source/assets/style.css")?.data.toString("utf8"), ":root{--accent:#2563eb}");
    assert.equal(entries.find((e) => e.path === "source/.gitignore")?.data.toString("utf8"), "dist\n");
    assert.equal(entries.find((e) => e.path === "source/.env.example")?.data.toString("utf8"), "PUBLIC_API_URL=\n");
    assert.equal(entries.find((e) => e.path === "source/.env"), undefined);
    assert.equal(entries.find((e) => e.path === "source/.git/config"), undefined);
    assert.equal(entries.find((e) => e.path === "refs/reference.txt")?.data.toString("utf8"), "ref-data");
    assert.deepEqual([...entries.find((e) => e.path === "cover.png")!.data], [1, 2, 3]);
  });
});

test("import restores a full project zip as a new project", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Imported source", skillId: "frontend-design", designSystemId: "modern-minimal", mode: "prototype" });
    const conv = store.createConversation(project.id, "Imported chat");
    store.addMessage(conv.id, "user", "original ask");
    store.addMessage(conv.id, "assistant", "original answer");
    const dir = join(dataDir, "projects", project.id);
    mkdirSync(join(dir, "assets"), { recursive: true });
    mkdirSync(join(dir, ".refs"), { recursive: true });
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<main>import me</main>");
    writeFileSync(join(dir, "assets", "style.css"), "main{display:grid}");
    writeFileSync(join(dir, ".gitignore"), "dist\n");
    writeFileSync(join(dir, ".env.example"), "PUBLIC_API_URL=\n");
    writeFileSync(join(dir, ".env"), "SECRET=do-not-export\n");
    writeFileSync(join(dir, ".git", "config"), "[remote]\n");
    writeFileSync(join(dir, ".refs", "reference.txt"), "ref-data");
    writeFileSync(join(dir, ".cover.png"), Buffer.from([3, 2, 1]));

    const exported = await fetch(`${base}/api/projects/${project.id}/export?scope=full`);
    assert.equal(exported.status, 200);
    const zip = Buffer.from(await exported.arrayBuffer());
    const importedRes = await fetch(`${base}/api/projects/import`, {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: zip,
    });
    assert.equal(importedRes.status, 201);
    const imported = (await importedRes.json()) as { id: string; name: string; skillId: string | null; designSystemId: string | null; mode: string };
    assert.notEqual(imported.id, project.id);
    assert.equal(imported.name, "Imported source");
    assert.equal(imported.skillId, "frontend-design");
    assert.equal(imported.designSystemId, "modern-minimal");
    assert.equal(imported.mode, "prototype");
    assert.equal(readFileSync(join(dataDir, "projects", imported.id, "index.html"), "utf8"), "<main>import me</main>");
    assert.equal(readFileSync(join(dataDir, "projects", imported.id, "assets", "style.css"), "utf8"), "main{display:grid}");
    assert.equal(readFileSync(join(dataDir, "projects", imported.id, ".gitignore"), "utf8"), "dist\n");
    assert.equal(readFileSync(join(dataDir, "projects", imported.id, ".env.example"), "utf8"), "PUBLIC_API_URL=\n");
    assert.equal(existsSync(join(dataDir, "projects", imported.id, ".env")), false);
    assert.equal(existsSync(join(dataDir, "projects", imported.id, ".git", "config")), false);
    assert.equal(readFileSync(join(dataDir, "projects", imported.id, ".refs", "reference.txt"), "utf8"), "ref-data");
    assert.deepEqual([...readFileSync(join(dataDir, "projects", imported.id, ".cover.png"))], [3, 2, 1]);

    const conversations = store.listConversations(imported.id);
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0]?.title, "Imported chat");
    const messages = store.listMessages(conversations[0]!.id);
    assert.deepEqual(messages.map((m) => [m.role, m.content]), [
      ["user", "original ask"],
      ["assistant", "original answer"],
    ]);
  });
});

test("import rejects zip entries whose declared output exceeds the archive budget", async () => {
  await withServer(async ({ base }) => {
    const bomb = zipEntry("source/big.txt", Buffer.from("x"), MAX_PROJECT_ARCHIVE_UNCOMPRESSED_BYTES + 1);
    const res = await fetch(`${base}/api/projects/import`, {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: bomb,
    });
    assert.equal(res.status, 422);
    assert.match(((await res.json()) as { error?: string }).error ?? "", /archive exceeds decompressed size limit/);
  });
});

test("full import/export v2 migrates variants, runs, artifacts, run logs, and version snapshots", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Stateful project", skillId: "frontend-design", designSystemId: "modern-minimal", mode: "prototype" });
    const main = store.ensureMainVariant(project.id);
    const alt = store.createVariant(project.id, "Alt direction");
    store.setActiveVariant(project.id, alt.id);

    const conv = store.createConversation(project.id, "Build log");
    const user = store.addMessage(conv.id, "user", "make it precise");
    const assistant = store.addMessage(conv.id, "assistant", "final summary");
    const run = store.createRun(project.id, conv.id, alt.id, user.id);
    store.updateRun(run.id, {
      status: "succeeded",
      repairRounds: 1,
      lintPassed: true,
      score: 87,
      findings: [{ severity: "P1", id: "geometry-overflow", message: "Hero clips", fix: "Constrain the hero width" }],
      assistantMessageId: assistant.id,
      finishedAt: 2222,
    });
    store.recordArtifact(project.id, "index.html", true);

    const dir = join(dataDir, "projects", project.id);
    mkdirSync(join(dir, ".variants", main.id), { recursive: true });
    mkdirSync(join(dir, ".versions"), { recursive: true });
    mkdirSync(join(dataDir, ".runs"), { recursive: true });
    mkdirSync(join(dataDir, ".runs", run.id, "moodboards", "boards", "board-1", "asset-files"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<main>active variant</main>");
    writeFileSync(join(dir, ".variants", main.id, "index.html"), "<main>main variant</main>");
    writeFileSync(join(dir, ".versions", `${run.id}.html`), "<main>version snapshot</main>");
    writeFileSync(
      join(dataDir, ".runs", `${run.id}.jsonl`),
      `${JSON.stringify({ type: "run-start", runId: run.id, conversationId: conv.id, seq: 1 })}\n${JSON.stringify({ type: "run-done", runId: run.id, seq: 2 })}\n`,
    );
    writeFileSync(
      join(dataDir, ".runs", run.id, "moodboards", "manifest.json"),
      JSON.stringify({ format: "dezin-moodboard-run-bundle", runId: run.id, boards: [{ id: "board-1" }] }),
    );
    writeFileSync(
      join(dataDir, ".runs", run.id, "moodboards", "boards", "board-1", "nodes.json"),
      JSON.stringify([{ type: "note", data: { content: "portable board snapshot" } }]),
    );
    writeFileSync(
      join(dataDir, ".runs", run.id, "moodboards", "boards", "board-1", "asset-files.json"),
      JSON.stringify([
        {
          id: "asset-1",
          path: join(dataDir, ".runs", run.id, "moodboards", "boards", "board-1", "asset-files", "asset-1.png"),
          sourcePath: join(dataDir, "moodboards", "board-1", "assets", "asset-1.png"),
          snapshotPath: "boards/board-1/asset-files/asset-1.png",
        },
      ]),
    );
    writeFileSync(join(dataDir, ".runs", run.id, "moodboards", "boards", "board-1", "asset-files", "asset-1.png"), "png");

    const exported = await fetch(`${base}/api/projects/${project.id}/export?scope=full`);
    assert.equal(exported.status, 200);
    const exportedZip = Buffer.from(await exported.arrayBuffer());
    const exportedEntries = readZip(exportedZip);
    const manifest = JSON.parse(exportedEntries.find((e) => e.path === "dezin-project.json")?.data.toString("utf8") ?? "{}") as {
      version?: number;
      variants?: Array<{ id?: string; name?: string; active?: boolean }>;
      runs?: Array<{ id?: string; status?: string; score?: number; variantId?: string; userMessageId?: string; assistantMessageId?: string }>;
      artifacts?: Array<{ path?: string; lintPassed?: boolean; createdAt?: number }>;
    };
    assert.equal(manifest.version, 2);
    assert.deepEqual(manifest.variants?.map((v) => [v.name, v.active]), [
      ["Main", false],
      ["Alt direction", true],
    ]);
    assert.equal(manifest.runs?.[0]?.status, "succeeded");
    assert.equal(manifest.runs?.[0]?.score, 87);
    assert.equal(manifest.runs?.[0]?.variantId, alt.id);
    assert.equal(manifest.runs?.[0]?.userMessageId, user.id);
    assert.equal(manifest.runs?.[0]?.assistantMessageId, assistant.id);
    assert.deepEqual(manifest.artifacts, [{ path: "index.html", lintPassed: true, createdAt: manifest.artifacts?.[0]?.createdAt }]);
    assert.equal(exportedEntries.find((e) => e.path === `variants/${main.id}/index.html`)?.data.toString("utf8"), "<main>main variant</main>");
    assert.equal(exportedEntries.find((e) => e.path === `versions/${run.id}.html`)?.data.toString("utf8"), "<main>version snapshot</main>");
    assert.match(exportedEntries.find((e) => e.path === `runs/${run.id}.jsonl`)?.data.toString("utf8") ?? "", /run-start/);
    assert.match(exportedEntries.find((e) => e.path === `runs/${run.id}/moodboards/manifest.json`)?.data.toString("utf8") ?? "", /dezin-moodboard-run-bundle/);
    assert.match(exportedEntries.find((e) => e.path === `runs/${run.id}/moodboards/boards/board-1/nodes.json`)?.data.toString("utf8") ?? "", /portable board snapshot/);
    assert.equal(exportedEntries.find((e) => e.path === `runs/${run.id}/moodboards/boards/board-1/asset-files/asset-1.png`)?.data.toString("utf8"), "png");

    const imported = await fetch(`${base}/api/projects/import`, {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: exportedZip,
    });
    assert.equal(imported.status, 201);
    const importedProject = (await imported.json()) as { id: string };
    const importedVariants = store.listVariants(importedProject.id);
    assert.deepEqual(importedVariants.map((v) => [v.name, v.active]), [
      ["Main", false],
      ["Alt direction", true],
    ]);
    assert.equal(readFileSync(join(dataDir, "projects", importedProject.id, "index.html"), "utf8"), "<main>active variant</main>");
    assert.equal(readFileSync(join(dataDir, "projects", importedProject.id, ".variants", importedVariants[0]!.id, "index.html"), "utf8"), "<main>main variant</main>");

    const importedConversations = store.listConversations(importedProject.id);
    const importedMessages = store.listMessages(importedConversations[0]!.id);
    const importedRuns = store.listRuns(importedProject.id);
    assert.equal(importedRuns.length, 1);
    assert.equal(importedRuns[0]!.conversationId, importedConversations[0]!.id);
    assert.equal(importedRuns[0]!.variantId, importedVariants[1]!.id);
    assert.equal(importedRuns[0]!.userMessageId, importedMessages[0]!.id);
    assert.equal(importedRuns[0]!.assistantMessageId, importedMessages[1]!.id);
    assert.equal(importedRuns[0]!.score, 87);
    assert.equal(importedRuns[0]!.findings[0]?.id, "geometry-overflow");
    assert.deepEqual(store.listArtifacts(importedProject.id).map((a) => [a.path, a.lintPassed]), [["index.html", true]]);
    const importedDir = join(dataDir, "projects", importedProject.id);
    assert.equal(readFileSync(join(importedDir, ".versions", `${importedRuns[0]!.id}.html`), "utf8"), "<main>version snapshot</main>");
    const importedLog = readFileSync(join(dataDir, ".runs", `${importedRuns[0]!.id}.jsonl`), "utf8");
    assert.match(importedLog, new RegExp(importedRuns[0]!.id));
    assert.doesNotMatch(importedLog, new RegExp(run.id));
    const importedBundle = JSON.parse(readFileSync(join(dataDir, ".runs", importedRuns[0]!.id, "moodboards", "manifest.json"), "utf8")) as { runId?: string };
    assert.equal(importedBundle.runId, importedRuns[0]!.id);
    assert.match(readFileSync(join(dataDir, ".runs", importedRuns[0]!.id, "moodboards", "boards", "board-1", "nodes.json"), "utf8"), /portable board snapshot/);
    const importedAssetFiles = JSON.parse(readFileSync(join(dataDir, ".runs", importedRuns[0]!.id, "moodboards", "boards", "board-1", "asset-files.json"), "utf8")) as Array<{ path?: string }>;
    assert.equal(importedAssetFiles[0]?.path, join(dataDir, ".runs", importedRuns[0]!.id, "moodboards", "boards", "board-1", "asset-files", "asset-1.png"));
    assert.equal(readFileSync(importedAssetFiles[0]!.path!, "utf8"), "png");
  });
});

test("export 404s for a project with no artifacts", async () => {
  await withServer(async ({ base, store }) => {
    const project = store.createProject({ name: "Empty" });
    assert.equal((await fetch(`${base}/api/projects/${project.id}/export`)).status, 404);
  });
});

test("export 404s for an unknown project", async () => {
  await withServer(async ({ base }) => {
    assert.equal((await fetch(`${base}/api/projects/nope/export`)).status, 404);
  });
});
