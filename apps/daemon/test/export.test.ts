import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, truncateSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { Store } from "../../../packages/core/src/index.ts";
import { ProcessGroupCleanupError } from "../../../packages/agent/src/index.ts";
import { createApp, createRuntimeSupervisor, type AppDeps } from "../src/index.ts";
import {
  BoundedJsonWriter,
  ExportBudget,
  MAX_EXPORT_ENTRIES,
  MAX_EXPORT_FILE_BYTES,
  MAX_EXPORT_TOTAL_BYTES,
  MAX_PROJECT_ARCHIVE_UNCOMPRESSED_BYTES,
  assertManifestStorageWithinLimit,
  reapExportTempAfterCleanupFailure,
  walkFiles,
} from "../src/export-handler.ts";
import { createZip } from "../src/zip.ts";

interface Ctx {
  base: string;
  dataDir: string;
  store: Store;
  runtimeSupervisor: ReturnType<typeof createRuntimeSupervisor>;
}

async function withServer(fn: (ctx: Ctx) => Promise<void>, extraDeps: Partial<AppDeps> = {}): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-export-"));
  const store = new Store(":memory:");
  const runtimeSupervisor = extraDeps.runtimeSupervisor ?? createRuntimeSupervisor({ store, dataDir });
  const server = createApp({ ...extraDeps, store, dataDir, runtimeSupervisor });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn({ base: `http://127.0.0.1:${port}`, dataDir, store, runtimeSupervisor });
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
}

function readZip(zip: Buffer): Array<{ path: string; data: Buffer }> {
  const out: Array<{ path: string; data: Buffer }> = [];
  const eocd = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50);
  const count = zip.readUInt16LE(eocd + 10);
  let central = zip.readUInt32LE(eocd + 16);
  for (let index = 0; index < count; index++) {
    assert.equal(zip.readUInt32LE(central), 0x02014b50);
    const method = zip.readUInt16LE(central + 10);
    const compSize = zip.readUInt32LE(central + 20);
    const nameLen = zip.readUInt16LE(central + 28);
    const extraLen = zip.readUInt16LE(central + 30);
    const commentLen = zip.readUInt16LE(central + 32);
    const localOffset = zip.readUInt32LE(central + 42);
    const path = zip.toString("utf8", central + 46, central + 46 + nameLen);
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const raw = zip.subarray(start, start + compSize);
    out.push({ path, data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw) });
    central += 46 + nameLen + extraLen + commentLen;
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

test("project deletion owns an import immediately after row creation and removes late Runs and files", async () => {
  let ctxStore!: Store;
  let ctxDataDir = "";
  let importedProjectId = "";
  let lateRunId = "";
  let importEntered!: () => void;
  const entered = new Promise<void>((resolve) => { importEntered = resolve; });
  let releaseImport!: () => void;
  const release = new Promise<void>((resolve) => { releaseImport = resolve; });

  await withServer(
    async ({ base, dataDir, store }) => {
      ctxStore = store;
      ctxDataDir = dataDir;
      const archive = createZip([
        {
          path: "dezin-project.json",
          data: JSON.stringify({
            format: "dezin-project",
            version: 2,
            project: { id: "old-project", name: "Interrupted import", mode: "prototype" },
          }),
        },
        { path: "source/index.html", data: "<main>imported</main>" },
      ]);
      const importing = fetch(`${base}/api/projects/import`, {
        method: "POST",
        headers: { "content-type": "application/zip" },
        body: archive,
      });
      await entered;

      let deletionSettled = false;
      const deleting = fetch(`${base}/api/projects/${importedProjectId}`, { method: "DELETE" }).then((response) => {
        deletionSettled = true;
        return response;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(deletionSettled, false, "DELETE waits for the registered import continuation");

      releaseImport();
      const [deleted] = await Promise.all([deleting, importing.catch(() => null)]);
      assert.equal(deleted.status, 204);
      assert.equal(store.getProject(importedProjectId), null);
      assert.equal(store.listVariants(importedProjectId).length, 0);
      assert.equal(store.listRuns(importedProjectId).length, 0);
      assert.equal(store.getRun(lateRunId), null);
      assert.equal(existsSync(join(dataDir, "projects", importedProjectId)), false);
      assert.equal(existsSync(join(dataDir, ".runs", `${lateRunId}.jsonl`)), false);
      assert.equal(existsSync(join(dataDir, ".runs", lateRunId)), false);
    },
    {
      importProjectCreated: async (projectId) => {
        importedProjectId = projectId;
        importEntered();
        await release;
        // Model a continuation that finishes one mutation batch after observing cancellation.
        const variant = ctxStore.createVariant(projectId, "Late variant");
        const conversation = ctxStore.createConversation(projectId, "Late conversation");
        const run = ctxStore.createRun(projectId, conversation.id, variant.id);
        lateRunId = run.id;
        const projectRoot = join(ctxDataDir, "projects", projectId);
        mkdirSync(join(projectRoot, ".variants", variant.id), { recursive: true });
        writeFileSync(join(projectRoot, ".variants", variant.id, "late.html"), "late");
        mkdirSync(join(ctxDataDir, ".runs", run.id), { recursive: true });
        writeFileSync(join(ctxDataDir, ".runs", `${run.id}.jsonl`), "late log\n");
        writeFileSync(join(ctxDataDir, ".runs", run.id, "bundle.txt"), "late bundle");
      },
    },
  );
});

test("variant deletion owns an imported variant through the full import continuation", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const targetBundleFillers = Array.from({ length: 1_000 }, (_, index) => ({
      path: `runs/old-target-run/fillers/file-${index}.txt`,
      data: `target-${index}`,
    }));
    const archive = createZip([
      {
        path: "dezin-project.json",
        data: JSON.stringify({
          format: "dezin-project",
          version: 2,
          project: { id: "old-project", name: "Variant import race", mode: "prototype" },
          variants: [
            { id: "old-main", name: "Main", active: true },
            { id: "old-target", name: "Target", active: false },
          ],
          conversations: [{
            id: "old-conversation",
            title: "Imported conversation",
            messages: [
              { id: "old-user", role: "user", content: "import this" },
              { id: "old-assistant", role: "assistant", content: "imported" },
            ],
          }],
          runs: [
            {
              id: "old-target-run",
              conversationId: "old-conversation",
              variantId: "old-target",
              userMessageId: "old-user",
              assistantMessageId: "old-assistant",
              status: "succeeded",
            },
            {
              id: "old-main-run",
              conversationId: "old-conversation",
              variantId: "old-main",
              userMessageId: "old-user",
              assistantMessageId: "old-assistant",
              status: "succeeded",
            },
          ],
        }),
      },
      { path: "source/index.html", data: "<main>importing</main>" },
      { path: "variants/old-target/index.html", data: "<main>must not return after deletion</main>" },
      { path: "versions/old-main-run.html", data: "<main>keep main version</main>" },
      { path: "versions/old-target-run.html", data: "<main>remove target version</main>" },
      { path: "runs/old-main-run.jsonl", data: '{"runId":"old-main-run"}\n' },
      { path: "runs/old-target-run.jsonl", data: '{"runId":"old-target-run"}\n' },
      { path: "runs/old-main-run/bundle.txt", data: "keep main bundle" },
      { path: "runs/old-target-run/bundle.txt", data: "remove target bundle" },
      ...targetBundleFillers,
    ]);

    let importSettled = false;
    const importing = fetch(`${base}/api/projects/import`, {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: archive,
    }).then((response) => {
      importSettled = true;
      return response;
    }, (error: unknown) => {
      importSettled = true;
      throw error;
    });

    let importedProjectId = "";
    let mainVariantId = "";
    let targetVariantId = "";
    let mainRunId = "";
    let targetRunId = "";
    for (let attempt = 0; attempt < 4_000; attempt++) {
      const importedProject = store.listProjects().find((project) => project.name === "Variant import race");
      if (importedProject) {
        importedProjectId = importedProject.id;
        const variants = store.listVariants(importedProject.id);
        mainVariantId = variants.find((variant) => variant.name === "Main")?.id ?? "";
        targetVariantId = variants.find((variant) => variant.name === "Target")?.id ?? "";
        const runs = store.listRuns(importedProject.id);
        mainRunId = runs.find((run) => run.variantId === mainVariantId)?.id ?? "";
        targetRunId = runs.find((run) => run.variantId === targetVariantId)?.id ?? "";
      }
      const mainBundle = mainRunId ? join(dataDir, ".runs", mainRunId, "bundle.txt") : "";
      const targetBundle = targetRunId ? join(dataDir, ".runs", targetRunId, "bundle.txt") : "";
      if (mainBundle && targetBundle && existsSync(mainBundle) && existsSync(targetBundle)) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    assert.ok(importedProjectId && mainVariantId && targetVariantId && mainRunId && targetRunId, "both imported Runs become visible during import");
    assert.equal(importSettled, false, "the fixture keeps the import continuation in flight");
    const root = join(dataDir, "projects", importedProjectId);
    const targetPaths = [
      join(root, ".variants", targetVariantId),
      join(root, ".versions", `${targetRunId.replace(/[^a-zA-Z0-9-]/g, "")}.html`),
      join(dataDir, ".runs", `${targetRunId}.jsonl`),
      join(dataDir, ".runs", targetRunId),
    ];
    const retainedPaths = [
      join(root, "index.html"),
      join(root, ".versions", `${mainRunId.replace(/[^a-zA-Z0-9-]/g, "")}.html`),
      join(dataDir, ".runs", `${mainRunId}.jsonl`),
      join(dataDir, ".runs", mainRunId, "bundle.txt"),
    ];
    assert.ok(targetPaths.every(existsSync), "the fixture materializes every target-owned artifact before deletion");
    assert.ok(retainedPaths.every(existsSync), "the fixture materializes unrelated main artifacts before deletion");

    const deleting = fetch(`${base}/api/projects/${importedProjectId}/variants/${targetVariantId}`, { method: "DELETE" });
    const [deleted, imported] = await Promise.all([deleting, importing]);

    assert.equal(imported.status, 201, "variant deletion waits without aborting the project import");
    assert.equal(deleted.status, 200);
    assert.equal(store.getVariant(targetVariantId), null);
    assert.equal(store.getRun(targetRunId), null);
    assert.ok(targetPaths.every((path) => !existsSync(path)), "target rows, snapshot, version, log, and bundle are removed");
    assert.ok(store.getProject(importedProjectId));
    assert.ok(store.getVariant(mainVariantId));
    assert.ok(store.getRun(mainRunId));
    assert.ok(retainedPaths.every(existsSync), "the root and unrelated main Run artifacts remain intact");
  });
});

test("shutdown aborts a partial import body before it can create a late project", async () => {
  await withServer(async ({ base, store, runtimeSupervisor }) => {
    const archive = createZip([
      {
        path: "dezin-project.json",
        data: JSON.stringify({
          format: "dezin-project",
          version: 2,
          project: { id: "late-project", name: "Late import", mode: "prototype" },
        }),
      },
      { path: "source/index.html", data: "<main>late</main>" },
    ]);
    const url = new URL("/api/projects/import", base);
    let upload!: ReturnType<typeof request>;
    const uploadDone = new Promise<void>((resolve) => {
      upload = request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: { "content-type": "application/zip", "content-length": String(archive.length) },
        },
        (response) => {
          response.resume();
          response.once("end", resolve);
        },
      );
      upload.once("error", () => resolve());
    });

    const midpoint = Math.max(1, Math.floor(archive.length / 2));
    upload.write(archive.subarray(0, midpoint));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtimeSupervisor.shutdown();
    upload.end(archive.subarray(midpoint));
    await Promise.race([uploadDone, new Promise((resolve) => setTimeout(resolve, 250))]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(store.listProjects(), [], "a request that outlives shutdown cannot create a project row");
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

test("ExportBudget applies one shared entry, file, and total budget", () => {
  const entries = new ExportBudget();
  for (let index = 0; index < MAX_EXPORT_ENTRIES; index++) entries.reserve(`file-${index}`, 0);
  assert.throws(() => entries.reserve("overflow", 0), /more than 10,000 entries/);

  const file = new ExportBudget();
  assert.throws(() => file.reserve("huge.bin", MAX_EXPORT_FILE_BYTES + 1), /exceeds 64 MiB/);

  const total = new ExportBudget();
  for (let index = 0; index < 8; index++) total.reserve(`part-${index}`, MAX_EXPORT_FILE_BYTES);
  assert.equal(MAX_EXPORT_FILE_BYTES * 8, MAX_EXPORT_TOTAL_BYTES);
  assert.throws(() => total.reserve("one-more-byte", 1), /exceeds 512 MiB/);
});

test("BoundedJsonWriter encodes incrementally and rejects before crossing its byte ceiling", () => {
  const value = { text: "界\n\"quoted\"🙂", list: [1, true, null], nested: { ok: "yes" } };
  const writer = new BoundedJsonWriter(512, "manifest.json");
  writer.value(value);
  assert.deepEqual(JSON.parse(writer.finish()), value);

  const limited = new BoundedJsonWriter(128, "manifest.json");
  assert.throws(() => limited.value({ content: "\u0001".repeat(1_000) }), /manifest\.json.*128 bytes/);
});

test("BoundedJsonWriter yields so a request abort can interrupt a large manifest string", async () => {
  const writer = new BoundedJsonWriter(4 * 1024 * 1024, "manifest.json");
  const controller = new AbortController();
  const encoding = writer.valueAsync({ content: "x".repeat(2 * 1024 * 1024) }, controller.signal);
  setImmediate(() => controller.abort(new Error("stop manifest encoding")));
  await assert.rejects(encoding, /stop manifest encoding/);
});

test("manifest storage preflight rejects a large SQLite message without materializing it", async () => {
  const store = new Store(":memory:");
  const project = store.createProject({ name: "Manifest budget" });
  const conversation = store.createConversation(project.id);
  store.db.prepare(
    "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', zeroblob(?), ?)",
  ).run("oversized-message", conversation.id, 4_096, Date.now());

  await assert.rejects(assertManifestStorageWithinLimit(store, project.id, 1_024), /manifest.*storage/i);
  store.close();
});

test("failed process-group cleanup reaps its temp file after the group is gone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-export-reaper-"));
  const path = join(dir, "pending.bundle");
  writeFileSync(path, "partial");
  let resolveGone!: () => void;
  const whenGone = new Promise<void>((resolve) => { resolveGone = resolve; });
  const reaping = reapExportTempAfterCleanupFailure(path, new ProcessGroupCleanupError("git bundle", whenGone));

  await Promise.resolve();
  assert.equal(existsSync(path), true, "the writer may still own the path before group exit");
  resolveGone();
  await reaping;
  assert.equal(existsSync(path), false);
});

test("export walking checks cancellation between directory entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-export-walk-abort-"));
  for (let index = 0; index < 20; index++) writeFileSync(join(dir, `file-${index}.txt`), "x");
  let checks = 0;
  const signal = {
    throwIfAborted() {
      checks += 1;
      if (checks === 5) throw new Error("cancel export walk");
    },
  } as AbortSignal;

  await assert.rejects(walkFiles(dir, dir, [], { signal }), /cancel export walk/);
  assert.equal(checks, 5);
});

test("export rejects a file over 64 MiB with 413 before download headers", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Oversized" });
    const dir = join(dataDir, "projects", project.id);
    mkdirSync(dir, { recursive: true });
    const huge = join(dir, "huge.bin");
    writeFileSync(huge, "");
    truncateSync(huge, MAX_EXPORT_FILE_BYTES + 1);

    const response = await fetch(`${base}/api/projects/${project.id}/export`);
    assert.equal(response.status, 413);
    assert.equal(response.headers.get("content-disposition"), null);
    assert.match(((await response.json()) as { error?: string }).error ?? "", /64 MiB/);
  });
});

test("export rejects more than 10,000 combined entries before writing archive headers", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Too many" });
    const dir = join(dataDir, "projects", project.id);
    mkdirSync(dir, { recursive: true });
    for (let index = 0; index <= MAX_EXPORT_ENTRIES; index++) writeFileSync(join(dir, `f-${index}.txt`), "");

    const response = await fetch(`${base}/api/projects/${project.id}/export`);
    assert.equal(response.status, 413);
    assert.equal(response.headers.get("content-disposition"), null);
    assert.match(((await response.json()) as { error?: string }).error ?? "", /too many|10,000/i);
  });
});

test("export rejects a sparse combined payload over 512 MiB before headers", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Too large" });
    const dir = join(dataDir, "projects", project.id);
    mkdirSync(dir, { recursive: true });
    for (let index = 0; index < 8; index++) {
      const part = join(dir, `part-${index}.bin`);
      writeFileSync(part, "");
      truncateSync(part, MAX_EXPORT_FILE_BYTES);
    }
    writeFileSync(join(dir, "overflow.bin"), "x");

    const response = await fetch(`${base}/api/projects/${project.id}/export`);
    assert.equal(response.status, 413);
    assert.equal(response.headers.get("content-disposition"), null);
    assert.match(((await response.json()) as { error?: string }).error ?? "", /512 MiB/);
  });
});

test("aborting a streaming Standard export removes its temporary Git bundle", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Abort export", mode: "standard" });
    store.ensureMainVariant(project.id);
    const dir = join(dataDir, "projects", project.id);
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Dezin Test"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "dezin@example.test"], { cwd: dir });
    writeFileSync(join(dir, "index.html"), "<main>abort me</main>");
    writeFileSync(join(dir, "payload.bin"), Buffer.alloc(2 * 1024 * 1024, 0x5a));
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir });

    const controller = new AbortController();
    const response = await fetch(`${base}/api/projects/${project.id}/export?scope=full`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort(new Error("stop download"));
    await reader.read().catch(() => ({ done: true as const, value: undefined }));

    const exportDir = join(dataDir, ".exports");
    for (let attempt = 0; attempt < 100 && existsSync(exportDir) && readdirSync(exportDir).length > 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(exportDir) ? readdirSync(exportDir).length : 0, 0);
  });
});

test("aborting while the Standard Git bundle command runs kills its process group and leaves no temp file", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX process-group assertion");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Abort Git bundle", mode: "standard" });
    store.ensureMainVariant(project.id);
    const dir = join(dataDir, "projects", project.id);
    mkdirSync(dir, { recursive: true });
    execFileSync(realGit, ["init", "-q"], { cwd: dir });
    execFileSync(realGit, ["config", "user.name", "Dezin Test"], { cwd: dir });
    execFileSync(realGit, ["config", "user.email", "dezin@example.test"], { cwd: dir });
    writeFileSync(join(dir, "index.html"), "<main>wait for bundle</main>");
    execFileSync(realGit, ["add", "."], { cwd: dir });
    execFileSync(realGit, ["commit", "-qm", "fixture"], { cwd: dir });

    const binDir = join(dataDir, "fake-bin");
    const pidPath = join(dataDir, "git-wrapper.pid");
    mkdirSync(binDir, { recursive: true });
    const wrapper = join(binDir, "git");
    writeFileSync(
      wrapper,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"bundle\" ]; then",
        `  echo $$ > ${JSON.stringify(pidPath)}`,
        "  trap '' TERM",
        "  while true; do sleep 1; done",
        "fi",
        `exec ${JSON.stringify(realGit)} \"$@\"`,
        "",
      ].join("\n"),
    );
    chmodSync(wrapper, 0o755);

    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    const controller = new AbortController();
    try {
      const outcome = fetch(`${base}/api/projects/${project.id}/export?scope=full`, { signal: controller.signal })
        .then((response) => ({ response }), (error: unknown) => ({ error }));
      for (let attempt = 0; attempt < 200 && !existsSync(pidPath); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(existsSync(pidPath), true, "the controlled Git bundle command started");
      controller.abort();
      const result = await outcome;
      assert.ok("error" in result && result.error instanceof Error && result.error.name === "AbortError");

      const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
      const exportDir = join(dataDir, ".exports");
      let alive = true;
      for (let attempt = 0; attempt < 300; attempt++) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (error) {
          alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
        }
        const files = existsSync(exportDir) ? readdirSync(exportDir) : [];
        if (!alive && files.length === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(alive, false);
      assert.equal(existsSync(exportDir) ? readdirSync(exportDir).length : 0, 0);
    } finally {
      process.env.PATH = previousPath;
    }
  });
});
