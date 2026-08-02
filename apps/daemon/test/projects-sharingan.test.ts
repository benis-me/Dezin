import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp } from "../src/index.ts";
import type { SharinganBootstrapPort } from "../src/sharingan-bootstrap.ts";

function noopSharinganBootstrap(): SharinganBootstrapPort {
  return {
    async register() {
      return {} as never;
    },
    async ensure() {
      return {} as never;
    },
    async getState() {
      return null;
    },
    async cancel() {},
    resume() {},
    async remove() {},
  };
}

function startApp(options: { sharinganBootstrap?: SharinganBootstrapPort } = {}) {
  const store = new Store(":memory:");
  const dataDir = mkdtempSync(join(tmpdir(), "shar-proj-"));
  const app = createApp({
    store,
    dataDir,
    ...(options.sharinganBootstrap === undefined
      ? {}
      : { sharinganBootstrap: options.sharinganBootstrap }),
  });
  return { store, app, dataDir };
}

test("POST /api/projects persists Sharingan source identity without retired Project fields", async () => {
  const { store, app } = startApp({ sharinganBootstrap: noopSharinganBootstrap() });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "clone", sharingan: true, sourceUrl: "https://example.test/" }),
    });
    assert.equal(res.status, 201);
    const proj = (await res.json()) as Record<string, unknown>;
    assert.equal(proj.sharingan, true);
    assert.equal(proj.sourceUrl, "https://example.test/");
    assert.equal("mode" in proj, false);
    assert.equal("designSystemId" in proj, false);
    assert.equal("skillId" in proj, false);
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
    store.close();
  }
});

test("POST /api/projects rejects Sharingan before creation when capture service is unavailable", async () => {
  const { store, app, dataDir } = startApp();
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "must-not-exist",
        sharingan: true,
        sourceUrl: "https://example.test/",
      }),
    });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), {
      error: "Sharingan capture service is unavailable",
      code: "SHARINGAN_BOOTSTRAP_UNAVAILABLE",
    });
    assert.deepEqual(store.listProjects(), [], "the unavailable service must not create a Project row");
    const projectsDirectory = join(dataDir, "projects");
    assert.equal(
      existsSync(projectsDirectory) ? readdirSync(projectsDirectory).length : 0,
      0,
      "the unavailable service must not create a Project directory",
    );
    assert.equal(
      existsSync(join(dataDir, "sharingan-bootstrap")),
      false,
      "the unavailable service must not create bootstrap recovery state",
    );
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
    store.close();
  }
});

test("POST /api/projects rejects sharingan without a valid http(s) sourceUrl", async () => {
  const { store, app } = startApp();
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "clone", sharingan: true }),
    });
    assert.equal(res.status, 400);
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
    store.close();
  }
});

test("POST /api/projects creates a blank Design Canvas Project", async () => {
  const { store, app } = startApp();
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "normal" }),
    });
    assert.equal(res.status, 201);
    const proj = (await res.json()) as { sharingan: boolean; sourceUrl?: string };
    assert.equal(proj.sharingan, false);
    assert.equal(proj.sourceUrl, undefined);
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
    store.close();
  }
});
