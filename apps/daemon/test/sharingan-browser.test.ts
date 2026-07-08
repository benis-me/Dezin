import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { SharinganSession, sharinganLaunchOptions, applyStealth } from "../src/sharingan-browser.ts";
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

test("sharinganLaunchOptions strips the automation tells", () => {
  const opts = sharinganLaunchOptions("/path/to/chrome", { userDataDir: "/tmp/p", headless: false });
  assert.deepEqual(opts.ignoreDefaultArgs, ["--enable-automation"]);
  assert.ok(opts.args.includes("--disable-blink-features=AutomationControlled"), "disables the AutomationControlled blink feature");
  assert.ok(!opts.args.includes("--enable-automation"), "never re-adds --enable-automation");
  assert.equal(opts.executablePath, "/path/to/chrome");
  assert.equal(opts.userDataDir, "/tmp/p");
});

test("applyStealth sets a non-headless UA and registers a webdriver spoof", async () => {
  const calls: { ua?: string; docHooks: number } = { docHooks: 0 };
  const fakePage = {
    setUserAgent: async (ua: string) => { calls.ua = ua; },
    evaluateOnNewDocument: async () => { calls.docHooks += 1; },
  };
  await applyStealth(fakePage, "Mozilla/5.0 (Macintosh) Chrome/126.0.0.0 Safari/537.36");
  assert.equal(calls.ua, "Mozilla/5.0 (Macintosh) Chrome/126.0.0.0 Safari/537.36");
  assert.ok(!/Headless/i.test(calls.ua ?? ""), "UA has no Headless marker");
  assert.equal(calls.docHooks, 1, "registered exactly one new-document hook (the webdriver spoof)");
});

test("a stealth session reports no webdriver flag and no Headless UA to page scripts", { skip: !findChrome() && "no Chrome" }, async () => {
  const html = `<!doctype html><html><body><h1 id="w"></h1>
<script>document.getElementById('w').textContent = 'wd=' + String(navigator.webdriver) + ' headless=' + /Headless/i.test(navigator.userAgent);</script>
</body></html>`;
  const fx = await fixtureServer(html);
  const dir = mkdtempSync(join(tmpdir(), "shar-stealth-"));
  const s = await SharinganSession.open(fx.url, { userDataDir: dir, headless: true });
  try {
    const dom = await s.readDom(50);
    const marker = dom.find((n) => n.tag === "h1")?.text ?? "";
    assert.match(marker, /wd=(false|undefined)/, "navigator.webdriver is not true");
    assert.match(marker, /headless=false/, "userAgent has no Headless marker");
  } finally {
    await s.close();
    await fx.close();
  }
});

test("navigate settles until images finish loading before returning", { skip: !findChrome() && "no Chrome" }, async () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const server = createServer((req, res) => {
    if (req.url === "/slow.png") { setTimeout(() => { res.writeHead(200, { "content-type": "image/png" }); res.end(png); }, 1200); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<!doctype html><html><body><h1 id="h">WAIT</h1><img src="/slow.png" onload="m()" onerror="m()"><script>function m(){document.getElementById("h").textContent="READY"}</script></body></html>');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const s = await SharinganSession.open(url, { userDataDir: mkdtempSync(join(tmpdir(), "shar-settle-")), headless: true });
  try {
    const dom = await s.readDom(50);
    const h1 = dom.find((n) => n.tag === "h1")?.text ?? "";
    assert.equal(h1, "READY", "navigate waited for the slow image to load/settle before returning");
  } finally {
    await s.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
