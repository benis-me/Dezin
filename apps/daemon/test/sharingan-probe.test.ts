import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp } from "../src/index.ts";
import { findChrome } from "../src/capture-cover.ts";

test("POST /navigate lazily opens a probe session and returns status", { skip: !findChrome() && "no Chrome" }, async () => {
  const fixture = createServer((_r, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>T</title><h1>Acme</h1>"); });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const target = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
  const store = new Store(":memory:");
  const dataDir = mkdtempSync(join(tmpdir(), "shar-nav-"));
  const project = store.createProject({ name: "clone", mode: "standard", sharingan: true, sourceUrl: target });
  const app = createApp({ store, dataDir });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/api/sharingan/${project.id}/navigate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: target }) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: number; finalUrl: string };
    assert.equal(body.status, 200);
    assert.ok(body.finalUrl.startsWith("http://127.0.0.1"));
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
    store.close();
    // The probe session is left open by design (Task 2: idle-released, not request-scoped) and
    // its browser tab holds a live keep-alive socket to `fixture`. http.Server#close()'s callback
    // only fires once every open socket ends, so without forcing it here `fixture.close()` blocks
    // for however long that idle socket takes to reclaim (empirically ~1-2 minutes) instead of
    // returning immediately.
    fixture.closeAllConnections();
    await new Promise<void>((r) => fixture.close(() => r()));
  }
});
