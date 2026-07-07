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
import { ensureProbeSession, startCapture } from "../src/sharingan-handler.ts";

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

test("probe read + interact endpoints operate on the live session", { skip: !findChrome() && "no Chrome" }, async () => {
  const fixture = createServer((_r, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<!doctype html><title>T</title><h1>Acme</h1><a href="/pricing">Pricing</a><button id="b">Go</button>');
  });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const target = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
  const store = new Store(":memory:");
  const dataDir = mkdtempSync(join(tmpdir(), "shar-probe-"));
  const project = store.createProject({ name: "clone", mode: "standard", sharingan: true, sourceUrl: target });
  const app = createApp({ store, dataDir });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const id = project.id;
  try {
    await fetch(`${base}/api/sharingan/${id}/navigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: target }),
    });

    const linksRes = await fetch(`${base}/api/sharingan/${id}/links`);
    assert.equal(linksRes.status, 200);
    const links = (await linksRes.json()) as string[];
    assert.ok(links.some((l) => l.endsWith("/pricing")));

    const domRes = await fetch(`${base}/api/sharingan/${id}/read-dom`);
    assert.equal(domRes.status, 200);
    const dom = (await domRes.json()) as { tag: string }[];
    assert.ok(dom.some((n) => n.tag === "h1"));

    const stylesRes = await fetch(`${base}/api/sharingan/${id}/computed-styles`);
    assert.equal(stylesRes.status, 200);
    const styles = (await stylesRes.json()) as { colors: string[] };
    assert.ok(Array.isArray(styles.colors));

    const click = await fetch(`${base}/api/sharingan/${id}/click`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selector: "#b" }),
    });
    assert.equal(click.status, 200);

    const scroll = await fetch(`${base}/api/sharingan/${id}/scroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ y: 100 }),
    });
    assert.equal(scroll.status, 200);
  } finally {
    // Same rationale as the /navigate test above: the probe session is left open by design
    // (idle-released, not request-scoped) and holds a live keep-alive socket to `fixture`.
    await new Promise<void>((r) => app.close(() => r()));
    store.close();
    fixture.closeAllConnections();
    await new Promise<void>((r) => fixture.close(() => r()));
  }
});

test("POST /start is refused while a probe session is live (no orphaned session)", async () => {
  const id = "probe-guard";
  const dataDir = mkdtempSync(join(tmpdir(), "shar-guard-"));
  let opens = 0;
  const fake = { close: async () => {} } as unknown as import("../src/sharingan-browser.ts").SharinganSession;
  const open = async () => { opens += 1; return fake; };

  // Open a probe session (phase -> "probing", c.session live).
  await ensureProbeSession(id, dataDir, open);
  assert.equal(opens, 1);

  // A concurrent capture start must be refused, NOT open a second browser.
  await startCapture(id, "http://x.test/", dataDir, "/tmp/unused", open);
  assert.equal(opens, 1, "startCapture must not open a second session while probing (would orphan the probe browser)");
});
