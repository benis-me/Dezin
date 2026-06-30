import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp, matchPath, safeJoin } from "../src/index.ts";
import { injectSelectBridge } from "../src/serve-static.ts";

interface Ctx {
  base: string;
  dataDir: string;
  store: Store;
}

async function withServer(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-test-"));
  const store = new Store(":memory:");
  const server = createApp({ store, dataDir, version: "9.9.9" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn({ base: `http://127.0.0.1:${port}`, dataDir, store });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
}

test("GET /api/health", async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, version: "9.9.9" });
  });
});

test("project CRUD over HTTP", async () => {
  await withServer(async ({ base }) => {
    // empty list
    assert.deepEqual(await (await fetch(`${base}/api/projects`)).json(), []);

    // create
    const created = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Landing", designSystemId: "modern-minimal" }),
    });
    assert.equal(created.status, 201);
    const project = (await created.json()) as { id: string; name: string; designSystemId: string };
    assert.equal(project.name, "Landing");
    assert.equal(project.designSystemId, "modern-minimal");

    // get
    const got = await fetch(`${base}/api/projects/${project.id}`);
    assert.equal(got.status, 200);
    assert.equal(((await got.json()) as { id: string }).id, project.id);

    // patch
    const patched = await fetch(`${base}/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Landing v2", skillId: "frontend-design" }),
    });
    const pj = (await patched.json()) as { name: string; skillId: string };
    assert.equal(pj.name, "Landing v2");
    assert.equal(pj.skillId, "frontend-design");

    // list has one
    assert.equal(((await (await fetch(`${base}/api/projects`)).json()) as unknown[]).length, 1);

    // delete (idempotent 204)
    const del = await fetch(`${base}/api/projects/${project.id}`, { method: "DELETE" });
    assert.equal(del.status, 204);
    assert.equal((await fetch(`${base}/api/projects/${project.id}`)).status, 404);
  });
});

test("POST /api/projects/:id/title updates a project name with a generated title", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-title-test-"));
  const store = new Store(":memory:");
  const server = createApp({
    store,
    dataDir,
    titleGenerator: async (input) => (input.brief.includes("pricing") ? "Pricing Control Room" : "Untitled"),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    const project = store.createProject({ name: "A dashboard for pricing experiments" });
    const res = await fetch(`${base}/api/projects/${project.id}/title`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brief: "A dashboard for pricing experiments" }),
    });

    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { name: string }).name, "Pricing Control Room");
    assert.equal(store.getProject(project.id)?.name, "Pricing Control Room");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});

test("conversations under a project", async () => {
  await withServer(async ({ base }) => {
    const project = (await (
      await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "P" }),
      })
    ).json()) as { id: string };

    const conv = await fetch(`${base}/api/projects/${project.id}/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Chat" }),
    });
    assert.equal(conv.status, 201);
    const list = (await (await fetch(`${base}/api/projects/${project.id}/conversations`)).json()) as unknown[];
    assert.equal(list.length, 1);

    // conversations for unknown project → 404
    assert.equal((await fetch(`${base}/api/projects/nope/conversations`)).status, 404);
  });
});

test("validation + routing errors", async () => {
  await withServer(async ({ base }) => {
    // missing name → 400
    const bad = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(bad.status, 400);
    const malformed = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    // unknown route → 404
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
    // wrong method on a known path → 405
    assert.equal((await fetch(`${base}/api/health`, { method: "POST" })).status, 405);
  });
});

test("capture handoff is only cleared by explicit consume", async () => {
  await withServer(async ({ base }) => {
    const post = await fetch(`${base}/api/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ images: [{ name: "shot.png", base64: "abcd" }], note: "brief", source: "extension" }),
    });
    assert.equal(post.status, 200);

    const peek1 = (await (await fetch(`${base}/api/capture`)).json()) as { images: unknown[]; note: string };
    const peek2 = (await (await fetch(`${base}/api/capture`)).json()) as { images: unknown[]; note: string };
    assert.equal(peek1.images.length, 1);
    assert.equal(peek2.images.length, 1);

    const consumed = (await (
      await fetch(`${base}/api/capture/consume`, { method: "POST" })
    ).json()) as { images: unknown[]; note: string };
    assert.equal(consumed.images.length, 1);
    assert.equal(consumed.note, "brief");

    const empty = (await (
      await fetch(`${base}/api/capture/consume`, { method: "POST" })
    ).json()) as { images: unknown[] };
    assert.equal(empty.images.length, 0);
  });
});

test("static artifact serving from the project dir", async () => {
  await withServer(async ({ base, dataDir }) => {
    const id = "proj-1";
    mkdirSync(join(dataDir, "projects", id), { recursive: true });
    writeFileSync(join(dataDir, "projects", id, "index.html"), "<h1>hello</h1>");

    // explicit file — served HTML includes the original markup + the picker bridge
    const r1 = await fetch(`${base}/projects/${id}/preview/index.html`);
    assert.equal(r1.status, 200);
    assert.match(r1.headers.get("content-type") ?? "", /text\/html/);
    const body1 = await r1.text();
    assert.ok(body1.includes("<h1>hello</h1>"));
    assert.ok(body1.includes("data-dezin-bridge"), "preview HTML should carry the element-picker bridge");

    // empty rest → index.html
    const r2 = await fetch(`${base}/projects/${id}/preview/`);
    assert.equal(r2.status, 200);
    assert.ok((await r2.text()).includes("<h1>hello</h1>"));

    // missing file → 404
    assert.equal((await fetch(`${base}/projects/${id}/preview/missing.html`)).status, 404);
  });
});

test("matchPath: params and trailing wildcard", () => {
  assert.deepEqual(matchPath("/api/projects/:id", "/api/projects/abc"), { params: { id: "abc" } });
  assert.equal(matchPath("/api/projects/:id", "/api/projects/abc/x"), null);
  assert.deepEqual(matchPath("/projects/:id/preview/*rest", "/projects/p/preview/a/b.html"), {
    params: { id: "p", rest: "a/b.html" },
  });
  assert.deepEqual(matchPath("/projects/:id/preview/*rest", "/projects/p/preview/"), {
    params: { id: "p", rest: "" },
  });
});

test("safeJoin blocks path traversal", () => {
  const root = "/data/projects/p";
  assert.equal(safeJoin(root, "index.html"), "/data/projects/p/index.html");
  assert.equal(safeJoin(root, "../../etc/passwd"), null);
  assert.equal(safeJoin(root, "a/../b.css"), "/data/projects/p/b.css");
});

test("picker bridge reports stable precise selectors", () => {
  const html = injectSelectBridge("<body><section data-dezin-id=\"hero\"><h1>Title</h1></section></body>");
  assert.match(html, /data-dezin-id/);
  assert.match(html, /nth-of-type/);
  assert.match(html, /styles:styles\(el\)/);
});
