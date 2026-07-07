import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { SharinganSession } from "../src/sharingan-browser.ts";
import { findChrome } from "../src/capture-cover.ts";

const FIXTURE = `<!doctype html><html><head><style>:root{--x:0}body{font-family:Inter,sans-serif;color:#111}h1{font-size:40px}.btn{background:#2563eb;border-radius:8px;box-shadow:0 1px 2px rgba(0,0,0,.1)}</style></head>
<body><h1>Acme</h1><p>Real copy that describes the product in a sentence or two.</p><a class="btn" href="/pricing">Pricing</a><a href="https://external.example/x">Ext</a></body></html>`;

function fixtureServer(html: string): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(html); });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

test("SharinganSession captures screenshot, DOM, style tokens, and same-origin links", { skip: !findChrome() && "no Chrome" }, async () => {
  const fx = await fixtureServer(FIXTURE);
  const dir = mkdtempSync(join(tmpdir(), "shar-"));
  const s = await SharinganSession.open(fx.url, { userDataDir: dir, headless: true });
  try {
    const shot = await s.screenshot({ fullPage: true });
    assert.ok(shot.length > 100, "screenshot has bytes");
    const dom = await s.readDom(200);
    assert.ok(dom.some((n) => n.tag === "h1" && n.text.includes("Acme")));
    const tokens = await s.styleTokens();
    assert.ok(tokens.colors.length > 0 && tokens.fontFamilies.length > 0);
    const links = await s.discoverLinks();
    assert.ok(links.some((l) => l.endsWith("/pricing")), "same-origin link found");
    assert.ok(!links.some((l) => l.includes("external.example")), "cross-origin link excluded");
  } finally {
    await s.close();
    await fx.close();
  }
});
