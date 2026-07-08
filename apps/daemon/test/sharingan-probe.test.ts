import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp } from "../src/index.ts";
import { findChrome } from "../src/capture-cover.ts";
import { ensureProbeSession, startCapture } from "../src/sharingan-handler.ts";
import { projectDir } from "../src/serve-static.ts";
import { SHARINGAN_PAGE_BUDGET } from "../src/sharingan-browser.ts";

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

test("POST /capture writes the page into the bundle + pages.json, and refuses beyond budget", { skip: !findChrome() && "no Chrome" }, async () => {
  const fixture = createServer((_r, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>T</title><h1>Acme</h1><p>" + "w ".repeat(60) + "</p>"); });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const target = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
  const store = new Store(":memory:");
  const dataDir = mkdtempSync(join(tmpdir(), "shar-cap-"));
  const project = store.createProject({ name: "clone", mode: "standard", sharingan: true, sourceUrl: target });
  const app = createApp({ store, dataDir });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const id = project.id;
  try {
    await fetch(`${base}/api/sharingan/${id}/navigate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: target }) });
    const cap = await fetch(`${base}/api/sharingan/${id}/capture`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    assert.equal(cap.status, 200);
    const page = (await cap.json()) as { url: string; screenshots: Record<string, string>; skipped?: string };
    assert.ok(page.screenshots?.desktop, "returned a captured page with screenshots");
    assert.ok(existsSync(join(projectDir(dataDir, id), ".sharingan", "pages.json")), "wrote the pages.json manifest");
    // status now reports the captured page
    const status = (await (await fetch(`${base}/api/sharingan/${id}/status`)).json()) as { pages: unknown[] };
    assert.equal(status.pages.length, 1);

    // Re-capturing the SAME url dedups — pages stays at 1 (the fix for duplicate manifest entries).
    await fetch(`${base}/api/sharingan/${id}/capture`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    const afterDup = (await (await fetch(`${base}/api/sharingan/${id}/status`)).json()) as { pages: unknown[] };
    assert.equal(afterDup.pages.length, 1, "re-capturing the same URL updates in place, never duplicates");

    // Capture DISTINCT urls up to the budget, then assert the next one is skipped rather than erroring.
    for (let i = afterDup.pages.length; i < SHARINGAN_PAGE_BUDGET; i++) {
      const r = await fetch(`${base}/api/sharingan/${id}/capture`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: `${target}p${i}` }) });
      assert.equal(r.status, 200);
    }
    const overBudget = await fetch(`${base}/api/sharingan/${id}/capture`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: `${target}pX` }) });
    assert.equal(overBudget.status, 200);
    const skipped = (await overBudget.json()) as { skipped?: string; budget?: number };
    assert.equal(skipped.skipped, "budget", "refuses to capture beyond the page budget");
    assert.equal(skipped.budget, SHARINGAN_PAGE_BUDGET);
    const finalStatus = (await (await fetch(`${base}/api/sharingan/${id}/status`)).json()) as { pages: unknown[] };
    assert.equal(finalStatus.pages.length, SHARINGAN_PAGE_BUDGET, "budget caps pages.length, does not exceed it");
  } finally {
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
