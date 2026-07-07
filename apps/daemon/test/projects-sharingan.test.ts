import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp } from "../src/index.ts";

function startApp() {
  const store = new Store(":memory:");
  const dataDir = mkdtempSync(join(tmpdir(), "shar-proj-"));
  const app = createApp({ store, dataDir, standardProjectSetup: async () => {} });
  return { store, app };
}

test("POST /api/projects persists sharingan + sourceUrl and forces standard mode", async () => {
  const { store, app } = startApp();
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "clone", mode: "prototype", sharingan: true, sourceUrl: "https://example.test/" }),
    });
    assert.equal(res.status, 201);
    const proj = (await res.json()) as { sharingan: boolean; sourceUrl?: string; mode: string };
    assert.equal(proj.sharingan, true);
    assert.equal(proj.sourceUrl, "https://example.test/");
    assert.equal(proj.mode, "standard", "sharingan forces standard even when prototype was requested");
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

test("POST /api/projects still creates a normal (non-sharingan) project", async () => {
  const { store, app } = startApp();
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "normal", mode: "standard" }),
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
