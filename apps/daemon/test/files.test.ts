import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp } from "../src/index.ts";
import { templateDir } from "../src/project-runtime.ts";

interface Ctx {
  base: string;
  dataDir: string;
  store: Store;
}

async function withServer(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-files-"));
  const store = new Store(":memory:");
  const server = createApp({
    store,
    dataDir,
    standardProjectSetup: async (_projectId, dir) => {
      await cp(templateDir(), dir, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: dir });
    },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn({ base: `http://127.0.0.1:${port}`, dataDir, store });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
}

async function waitForFile(path: string, timeoutMs = 1500): Promise<void> {
  const started = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - started > timeoutMs) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("GET /api/projects/:id/files lists the project's files with sizes", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "P" });
    const dir = join(dataDir, "projects", project.id);
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<h1>hello</h1>");
    writeFileSync(join(dir, "assets", "style.css"), ":root{}");

    const res = await fetch(`${base}/api/projects/${project.id}/files`);
    assert.equal(res.status, 200);
    const files = (await res.json()) as Array<{ path: string; size: number }>;
    assert.deepEqual(
      files.map((f) => f.path),
      ["assets/style.css", "index.html"], // sorted
    );
    const html = files.find((f) => f.path === "index.html");
    assert.ok(html && html.size > 0, "index.html has a non-zero size");
  });
});

test("GET /api/projects/:id/files returns [] before any run", async () => {
  await withServer(async ({ base, store }) => {
    const project = store.createProject({ name: "Empty" });
    const res = await fetch(`${base}/api/projects/${project.id}/files`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });
});

test("GET /api/projects/:id/files 404s for an unknown project", async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/projects/nope/files`);
    assert.equal(res.status, 404);
  });
});

test("standard mode: POST /api/projects scaffolds a Vite project + git, reports setup", async () => {
  await withServer(async ({ base, dataDir }) => {
    const res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Std", mode: "standard" }),
    });
    assert.equal(res.status, 201);
    const project = (await res.json()) as { id: string; mode: string };
    assert.equal(project.mode, "standard");

    // the template was copied into the project dir (scaffold runs synchronously up to install)
    const dir = join(dataDir, "projects", project.id);
    await waitForFile(join(dir, "src", "App.jsx"));
    assert.ok(existsSync(join(dir, "package.json")), "package.json scaffolded");
    assert.ok(existsSync(join(dir, "src", "App.jsx")), "App.jsx scaffolded");
    const viteConfig = readFileSync(join(dir, "vite.config.js"), "utf8");
    assert.match(viteConfig, /data-dezin-id/);
    assert.match(viteConfig, /nth-of-type/);
    assert.match(viteConfig, /styles:styles\(el\)/);
    assert.match(viteConfig, /borderWidth:s\.borderWidth/);
    assert.match(viteConfig, /focus-target/);

    const setup = (await (await fetch(`${base}/api/projects/${project.id}/setup`)).json()) as { phase: string; logs?: Array<{ message: string }> };
    assert.ok(["scaffolding", "installing", "ready", "error"].includes(setup.phase));
    assert.ok(Array.isArray(setup.logs));
  });
});

test("POST /api/projects/:id/refs saves a ref under .refs, hidden from Files", async () => {
  await withServer(async ({ base, store }) => {
    const project = store.createProject({ name: "P" });
    const res = await fetch(`${base}/api/projects/${project.id}/refs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "../weird name.png", contentBase64: Buffer.from("img").toString("base64") }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { name: string; path: string };
    assert.equal(body.path, ".refs/weird_name.png"); // sanitized + namespaced

    // .refs is excluded from the Files listing
    const files = (await (await fetch(`${base}/api/projects/${project.id}/files`)).json()) as Array<{ path: string }>;
    assert.ok(!files.some((f) => f.path.includes(".refs")), ".refs is hidden from Files");
  });
});
