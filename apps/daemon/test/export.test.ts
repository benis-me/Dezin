import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
    writeFileSync(join(dir, "index.html"), "<h1>hello</h1>");
    writeFileSync(join(dir, "assets", "style.css"), ":root{--accent:#2563eb}");

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
