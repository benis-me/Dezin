import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { detectLoginWall, looksLikeLoginWall, capturePage, captureCurrentPage, writePagesManifest, sharinganReviewReference } from "../src/sharingan-capture.ts";
import { SharinganSession, type DomNode } from "../src/sharingan-browser.ts";
import { findChrome } from "../src/capture-cover.ts";

test("detectLoginWall flags 401, auth redirects, and password-only shells", () => {
  assert.equal(detectLoginWall({ status: 401, finalUrl: "https://x/y", hasPasswordField: false, textLength: 500 }), true);
  assert.equal(detectLoginWall({ status: 200, finalUrl: "https://x/login?next=/app", hasPasswordField: false, textLength: 500 }), true);
  assert.equal(detectLoginWall({ status: 200, finalUrl: "https://x/", hasPasswordField: true, textLength: 30 }), true);
  assert.equal(detectLoginWall({ status: 200, finalUrl: "https://x/", hasPasswordField: false, textLength: 2000 }), false);
});

const node = (tag: string, text: string): DomNode => ({ tag, classes: "", text, box: { x: 0, y: 0, w: 10, h: 10 } });

// Shaped after the real tapnow OAuth wall the demo captured: "登录或注册" + provider buttons, little else.
const OAUTH_WALL: DomNode[] = [
  node("h1", "登录或注册"),
  node("button", "使用 Google 继续"),
  node("button", "使用手机号继续"),
  node("a", "使用邮箱登录"),
  node("p", "登录即代表你同意服务条款"),
];

const CONTENT_PAGE: DomNode[] = [
  node("h1", "Acme Analytics"),
  node("p", "The fastest way to understand your product usage across every channel and team."),
  node("a", "Pricing"),
  node("a", "Log in"), // a login LINK in the nav — must NOT trip the heuristic
  ...Array.from({ length: 40 }, (_, i) => node("p", `Feature paragraph number ${i} describing real product value at length.`)),
];

test("looksLikeLoginWall flags an OAuth-dominated low-content page but not a content page with a login link", () => {
  assert.equal(looksLikeLoginWall(OAUTH_WALL), true);
  assert.equal(looksLikeLoginWall(CONTENT_PAGE), false);
  assert.equal(looksLikeLoginWall([]), false);
});

test("detectLoginWall folds in the OAuth content heuristic via the dom field", () => {
  assert.equal(detectLoginWall({ status: 200, finalUrl: "https://app.x/home", hasPasswordField: false, textLength: 40, dom: OAUTH_WALL }), true);
  assert.equal(detectLoginWall({ status: 200, finalUrl: "https://app.x/home", hasPasswordField: false, textLength: 4000, dom: CONTENT_PAGE }), false);
  // Existing 4-field callers (no dom) still behave exactly as before.
  assert.equal(detectLoginWall({ status: 200, finalUrl: "https://x/", hasPasswordField: false, textLength: 2000 }), false);
});

test("looksLikeLoginWall does not flag short landing/waitlist pages that only repeat Sign up / Log in", () => {
  const WAITLIST: DomNode[] = [
    node("h1", "Join the waitlist"),
    node("button", "Sign up free"),
    node("p", "Already have an account? Log in"),
    node("a", "Sign in"),
    node("p", "Sign up in seconds — no credit card required"),
  ];
  assert.equal(looksLikeLoginWall(WAITLIST), false);
});

test("looksLikeLoginWall still flags an OAuth wall wrapped in a busier shell (footer/cookie chrome)", () => {
  const busy: DomNode[] = [
    node("h1", "登录或注册"),
    node("button", "使用微信登录"),
    ...Array.from({ length: 60 }, (_, i) => node("a", `Footer link ${i}`)),
  ];
  assert.equal(looksLikeLoginWall(busy), true);
});

test("looksLikeLoginWall does not flag a large content page that merely offers social sign-in", () => {
  const big: DomNode[] = [
    node("button", "Sign in with Google"),
    ...Array.from({ length: 220 }, (_, i) => node("p", `Article paragraph ${i} with real content.`)),
  ];
  assert.equal(looksLikeLoginWall(big), false);
});

test("capturePage writes screenshots + dom + styles into .sharingan and reports steps", { skip: !findChrome() && "no Chrome" }, async () => {
  const html = `<!doctype html><html><head><title>Home</title><style>h1{font-size:40px;color:#111}</style></head><body><h1>Acme</h1><p>${"word ".repeat(60)}</p></body></html>`;
  const server = createServer((_r, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(html); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const projectDir = mkdtempSync(join(tmpdir(), "shar-proj-"));
  const profile = mkdtempSync(join(tmpdir(), "shar-prof-"));
  const s = await SharinganSession.open(url, { userDataDir: profile, headless: true });
  const steps: string[] = [];
  try {
    const { page, loginRequired } = await capturePage(s, projectDir, url, (st) => steps.push(st.kind));
    assert.equal(loginRequired, false);
    assert.ok(page, "captured a page");
    assert.ok(existsSync(join(projectDir, ".sharingan")), ".sharingan dir created");
    assert.ok(Object.keys(page!.screenshots).length >= 2, "screenshot per viewport");
    const styles = JSON.parse(readFileSync(join(projectDir, page!.styles), "utf8"));
    assert.ok(Array.isArray(styles.colors));
    assert.ok(steps.includes("screenshot") && steps.includes("styles") && steps.includes("done"));
  } finally {
    await s.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("captureCurrentPage captures the current page without navigating + records links", { skip: !findChrome() && "no Chrome" }, async () => {
  const fixture = createServer((_r, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end('<!doctype html><title>T</title><h1>Acme</h1><p>' + "w ".repeat(40) + '</p><a href="/pricing">Pricing</a>'); });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
  const dir = mkdtempSync(join(tmpdir(), "shar-cur-"));
  const session = await SharinganSession.open(url, { userDataDir: mkdtempSync(join(tmpdir(), "shar-cur-prof-")), headless: true });
  try {
    const page = await captureCurrentPage(session, dir, url, () => {});
    assert.ok(page.screenshots.desktop, "wrote a desktop screenshot path");
    assert.ok(page.links.some((l) => l.endsWith("/pricing")), "recorded the same-origin link");
    assert.ok(existsSync(join(dir, page.screenshots.desktop)), "the screenshot file exists");
  } finally {
    await session.close();
    await new Promise<void>((r) => fixture.close(() => r()));
  }
});

test("captureCurrentPage writes an asset inventory + per-node DOM styles", { skip: !findChrome() && "no Chrome" }, async () => {
  const html = `<!doctype html><html><head><style>
    #row{display:flex;justify-content:center;gap:12px}
    h1{font-size:40px;color:rgb(17,17,17)}
    .hero{background-image:url("/img/hero.png")}
  </style></head><body>
    <div id="row"><h1>Acme</h1></div>
    <img src="/img/logo.png" alt="Acme logo" width="120" height="40">
    <div class="hero" style="width:200px;height:80px">bg</div>
  </body></html>`;
  const fixture = createServer((_r, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(html); });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
  const dir = mkdtempSync(join(tmpdir(), "shar-rich-"));
  const session = await SharinganSession.open(url, { userDataDir: mkdtempSync(join(tmpdir(), "shar-rich-prof-")), headless: true });
  try {
    const page = await captureCurrentPage(session, dir, url, () => {});
    // Asset inventory
    assert.ok(page.assets, "CapturedPage.assets path is set");
    const assets = JSON.parse(readFileSync(join(dir, page.assets), "utf8")) as Array<{ url: string; kind: string; alt?: string }>;
    assert.ok(assets.some((a) => a.kind === "img" && a.url.endsWith("/img/logo.png") && a.alt === "Acme logo"), "captured the <img> with alt");
    assert.ok(assets.some((a) => a.kind === "background" && a.url.endsWith("/img/hero.png")), "captured the CSS background-image");
    // Per-node styles (dom.json is now a nested tree — flatten before searching)
    const tree = JSON.parse(readFileSync(join(dir, page.dom), "utf8")) as Array<{ tag: string; style?: Record<string, string>; children: any[] }>;
    const flatten = (nodes: typeof tree): typeof tree => nodes.flatMap((n) => [n, ...flatten((n.children ?? []) as typeof tree)]);
    const dom = flatten(tree);
    const row = dom.find((n) => n.style?.display === "flex");
    assert.ok(row && row.style?.justifyContent === "center", "flex container carries computed display + justifyContent");
    const h1 = dom.find((n) => n.tag === "h1");
    assert.equal(h1?.style?.fontSize, "40px", "h1 carries its computed font size");
  } finally {
    await session.close();
    await new Promise<void>((r) => fixture.close(() => r()));
  }
});

test("captureCurrentPage writes a NESTED dom tree with fuller per-node styles", { skip: !findChrome() && "no Chrome" }, async () => {
  const html = `<!doctype html><html><head><style>
    #row{display:flex;justify-content:center;gap:12px;width:400px}
    h1{font-size:40px;color:rgb(17,17,17);text-align:center}
  </style></head><body><div id="row"><h1>Acme</h1><p>hello</p></div></body></html>`;
  const fixture = createServer((_r, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(html); });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
  const dir = mkdtempSync(join(tmpdir(), "shar-tree-"));
  const session = await SharinganSession.open(url, { userDataDir: mkdtempSync(join(tmpdir(), "shar-tree-prof-")), headless: true });
  try {
    const page = await captureCurrentPage(session, dir, url, () => {});
    const tree = JSON.parse(readFileSync(join(dir, page.dom), "utf8")) as Array<{ tag: string; children: any[]; style: Record<string, string> }>;
    // Root is <body>, with the #row div nested under it, and h1/p nested under that.
    assert.equal(tree.length, 1);
    assert.equal(tree[0]!.tag, "body");
    const row = tree[0]!.children.find((n: any) => n.style?.display === "flex");
    assert.ok(row, "flex row is a nested child of body");
    assert.equal(row.style.justifyContent, "center");
    assert.ok(row.style.width, "fuller styles: width is captured");
    const h1 = row.children.find((n: any) => n.tag === "h1");
    assert.ok(h1 && h1.style.textAlign === "center" && h1.text.includes("Acme"), "h1 nested under row with textAlign + text");
  } finally {
    await session.close();
    await new Promise<void>((r) => fixture.close(() => r()));
  }
});

test("captureCurrentPage downloads real images into public/_assets and rewrites assets.json local paths", { skip: !findChrome() && "no Chrome" }, async () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"); // minimal PNG signature bytes
  const fixture = createServer((req, res) => {
    if (req.url === "/logo.png") { res.writeHead(200, { "content-type": "image/png" }); res.end(png); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<!doctype html><html><body><h1>Acme</h1><img src="/logo.png" alt="logo" width="80" height="40"></body></html>');
  });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
  const dir = mkdtempSync(join(tmpdir(), "shar-img-"));
  const session = await SharinganSession.open(url, { userDataDir: mkdtempSync(join(tmpdir(), "shar-img-prof-")), headless: true });
  try {
    const page = await captureCurrentPage(session, dir, url, () => {});
    const assets = JSON.parse(readFileSync(join(dir, page.assets), "utf8")) as Array<{ url: string; kind: string; local?: string }>;
    const logo = assets.find((a) => a.url.endsWith("/logo.png"));
    assert.ok(logo?.local && logo.local.startsWith("/_assets/"), "logo asset gained a local /_assets/ path");
    assert.ok(existsSync(join(dir, "public", logo!.local!.replace(/^\//, ""))), "the image file was written under public/_assets");
  } finally {
    await session.close();
    await new Promise<void>((r) => fixture.close(() => r()));
  }
});

test("sharinganReviewReference resolves the entry screenshot + an asset summary from the bundle", () => {
  const dir = mkdtempSync(join(tmpdir(), "shar-ref-"));
  const pageRel = join(".sharingan", "home-abcd1234");
  mkdirSync(join(dir, pageRel), { recursive: true });
  writeFileSync(join(dir, pageRel, "shot-desktop.png"), "png");
  writeFileSync(join(dir, pageRel, "assets.json"), JSON.stringify([{ url: "https://x/a.png", kind: "img", alt: "logo" }, { url: "https://x/b.png", kind: "background" }]));
  writeFileSync(join(dir, ".sharingan", "pages.json"), JSON.stringify({
    sourceUrl: "https://x/",
    pages: [{ url: "https://x/", title: "Home", screenshots: { desktop: join(pageRel, "shot-desktop.png"), mobile: join(pageRel, "shot-mobile.png") }, dom: join(pageRel, "dom.json"), styles: join(pageRel, "styles.json"), assets: join(pageRel, "assets.json"), links: [] }],
  }));
  const ref = sharinganReviewReference(dir);
  assert.ok(ref, "returns a reference");
  assert.equal(ref!.screenshotPath, join(dir, pageRel, "shot-desktop.png"), "absolute path to the entry desktop screenshot");
  assert.match(ref!.assetsSummary ?? "", /2 image/);
  // No bundle -> undefined.
  assert.equal(sharinganReviewReference(mkdtempSync(join(tmpdir(), "shar-empty-"))), undefined);
});

test("sharinganReviewReference returns undefined for a malformed (null) manifest instead of throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "shar-nullref-"));
  mkdirSync(join(dir, ".sharingan"), { recursive: true });
  writeFileSync(join(dir, ".sharingan", "pages.json"), "null");
  assert.equal(sharinganReviewReference(dir), undefined);
});
