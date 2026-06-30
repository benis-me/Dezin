import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp } from "../src/index.ts";

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

test("export returns a zip of the project's artifact files", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "P" });
    const dir = join(dataDir, "projects", project.id);
    mkdirSync(join(dir, "assets"), { recursive: true });
    mkdirSync(join(dir, ".refs"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<h1>hello</h1>");
    writeFileSync(join(dir, "assets", "style.css"), ":root{--accent:#2563eb}");
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
    assert.equal(entries.length, 2);
    const index = entries.find((e) => e.path === "index.html");
    const css = entries.find((e) => e.path === "assets/style.css");
    assert.equal(index?.data.toString("utf8"), "<h1>hello</h1>");
    assert.equal(css?.data.toString("utf8"), ":root{--accent:#2563eb}");
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
    writeFileSync(join(dir, "index.html"), "<h1>hello</h1>");
    writeFileSync(join(dir, "assets", "style.css"), ":root{--accent:#2563eb}");
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
    assert.deepEqual(manifest.project, {
      name: "P",
      skillId: "frontend-design",
      designSystemId: "modern-minimal",
      mode: "prototype",
    });
    assert.equal(manifest.conversations?.[0]?.title, "Chat");
    assert.equal(manifest.conversations?.[0]?.messages?.[0]?.content, "make a hero");
    assert.equal(entries.find((e) => e.path === "source/index.html")?.data.toString("utf8"), "<h1>hello</h1>");
    assert.equal(entries.find((e) => e.path === "source/assets/style.css")?.data.toString("utf8"), ":root{--accent:#2563eb}");
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
    writeFileSync(join(dir, "index.html"), "<main>import me</main>");
    writeFileSync(join(dir, "assets", "style.css"), "main{display:grid}");
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
