import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { detectLoginWall, looksLikeLoginWall, capturePage, captureCurrentPage, writePagesManifest, sharinganReviewReference, upsertPage, captureUrlKey, readCapturedPages, pageDir, type CaptureStep, type CapturedPage } from "../src/sharingan-capture.ts";
import { SharinganSession, type DomNode } from "../src/sharingan-browser.ts";
import { findChrome } from "../src/capture-cover.ts";

const VALID_SOURCE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");

function writeValidRenderMap(path: string): void {
  writeFileSync(path, JSON.stringify({
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 900 },
    elements: [{ selector: "body", tag: "body", text: "", box: { x: 0, y: 0, w: 1440, h: 900 }, style: {} }],
  }));
}

test("upsertPage dedups by normalized URL — re-capturing a page updates it, never duplicates", () => {
  const mk = (url: string, title: string): CapturedPage => ({ url, title, screenshots: {}, dom: "", styles: "", assets: "", links: [] });
  const pages: CapturedPage[] = [];
  upsertPage(pages, mk("https://x.com/home", "A"));
  upsertPage(pages, mk("https://x.com/home", "B")); // same url → replace
  upsertPage(pages, mk("https://x.com/home/", "C")); // trailing slash → same key
  upsertPage(pages, mk("https://x.com/home#frag", "D")); // fragment → same key
  assert.equal(pages.length, 1, "the same URL collapses to a single entry");
  assert.equal(pages[0]!.title, "D", "the latest capture wins");
  upsertPage(pages, mk("https://x.com/about", "E")); // different path → new entry
  assert.equal(pages.length, 2);
});

test("captureUrlKey strips a plain anchor + trailing slash, but keeps hash-ROUTES distinct", () => {
  assert.equal(captureUrlKey("https://x.com/a/"), captureUrlKey("https://x.com/a"));
  assert.equal(captureUrlKey("https://x.com/a#b"), captureUrlKey("https://x.com/a")); // plain anchor stripped
  assert.notEqual(captureUrlKey("https://x.com/a"), captureUrlKey("https://x.com/b"));
  // hash-routed SPA pages must NOT collapse — they're distinct views, not on-page anchors.
  assert.notEqual(captureUrlKey("https://x.com/#/products"), captureUrlKey("https://x.com/#/about"));
  assert.notEqual(captureUrlKey("https://x.com/#!/x"), captureUrlKey("https://x.com/#!/y"));
});

test("readCapturedPages round-trips requested and final page identities written by writePagesManifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "sgpg-"));
  const pages: CapturedPage[] = [{ requestedUrl: "https://x.com/home", url: "https://x.com/home/", title: "H", screenshots: { desktop: ".sharingan/x/shot.png" }, dom: ".sharingan/x/dom.json", styles: ".sharingan/x/styles.json", assets: ".sharingan/x/assets.json", links: ["https://x.com/a"] }];
  writePagesManifest(dir, "https://x.com/home/", pages, "https://x.com/home");
  const back = readCapturedPages(dir);
  assert.equal(back.length, 1);
  assert.equal(back[0]!.requestedUrl, "https://x.com/home");
  assert.equal(back[0]!.url, "https://x.com/home/");
  assert.deepEqual(back[0]!.links, ["https://x.com/a"]);
  assert.deepEqual(readCapturedPages(mkdtempSync(join(tmpdir(), "empty-"))), [], "no manifest → empty");
});

test("writePagesManifest safely upgrades a legacy entry before appending a secondary capture", () => {
  const dir = mkdtempSync(join(tmpdir(), "shar-legacy-upgrade-"));
  const sourceUrl = "https://x.test/entry";
  const entryRel = join(".sharingan", "legacy-entry");
  mkdirSync(join(dir, entryRel), { recursive: true });
  writeFileSync(join(dir, entryRel, "shot.png"), VALID_SOURCE_PNG);
  writeValidRenderMap(join(dir, entryRel, "render-map.json"));
  const pages: CapturedPage[] = [
    {
      url: sourceUrl,
      title: "Legacy entry",
      screenshots: { desktop: join(entryRel, "shot.png") },
      dom: join(entryRel, "dom.json"),
      styles: join(entryRel, "styles.json"),
      assets: join(entryRel, "assets.json"),
      renderMap: join(entryRel, "render-map.json"),
      links: [],
    },
    { url: "https://x.test/secondary", title: "Secondary", screenshots: {}, dom: "", styles: "", assets: "", links: [] },
  ];

  writePagesManifest(dir, sourceUrl, pages, sourceUrl);

  const manifest = JSON.parse(readFileSync(join(dir, ".sharingan", "pages.json"), "utf8")) as {
    pages?: Array<{ requestedUrl?: string; url?: string }>;
  };
  assert.equal(manifest.pages?.[0]?.requestedUrl, sourceUrl, "the legacy entry gains the original requested identity");
  assert.equal(manifest.pages?.[1]?.requestedUrl, "https://x.test/secondary", "an unknown legacy secondary page is honestly self-identified");
  assert.ok(sharinganReviewReference(dir), "upgrading the manifest cannot invalidate the existing entry evidence");
});

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

test("detectLoginWall recognizes a cross-origin OAuth authorize redirect before the strict origin gate", () => {
  assert.equal(detectLoginWall({
    status: 200,
    requestedUrl: "https://app.x.test/workspace",
    finalUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=abc",
    hasPasswordField: false,
    textLength: 480,
    dom: [node("h1", "Sign in"), node("button", "Next"), node("a", "Sign-in options")],
  }), true);
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
    assert.ok(page!.screenshots.desktop && !page!.screenshots.mobile, "captures the desktop full-page shot only (mobile dropped)");
    const styles = JSON.parse(readFileSync(join(projectDir, page!.styles), "utf8"));
    assert.ok(Array.isArray(styles.colors));
    assert.ok(steps.includes("screenshot") && steps.includes("styles") && steps.includes("done"));
  } finally {
    await s.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

function fakeCaptureSession(options: { screenshotError?: Error; finalUrl?: string; status?: number; dom?: DomNode[] } = {}): SharinganSession {
  return {
    navigate: async (url: string) => ({ status: options.status ?? 200, finalUrl: options.finalUrl ?? url }),
    readDom: async () => options.dom ?? [node("main", "Captured entry page with enough source content")],
    hasPasswordField: async () => false,
    setViewport: async () => {},
    settle: async () => {},
    screenshot: async () => {
      if (options.screenshotError) throw options.screenshotError;
      return Buffer.from("png");
    },
    readRenderMap: async () => ({ viewport: { width: 1440, height: 900 }, document: { width: 1440, height: 900 }, elements: [] }),
    readDomTree: async () => [],
    styleTokens: async () => ({ colors: [], fontFamilies: [], fontSizes: [], radii: [], shadows: [] }),
    assets: async () => [],
    fetchAsset: async () => null,
    discoverLinks: async () => [],
  } as unknown as SharinganSession;
}

test("capturePage rejects a cross-origin redirect before writing source evidence", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "shar-cross-origin-redirect-"));

  await assert.rejects(
    capturePage(
      fakeCaptureSession({ finalUrl: "https://evil.test/products/" }),
      projectDir,
      "https://x.test/products",
      () => {},
    ),
    /cross-origin redirect/i,
  );

  assert.equal(existsSync(join(projectDir, ".sharingan")), false, "redirected pixels are never written under the requested source identity");
});

test("capturePage rejects a same-origin redirect that changes the requested resource identity", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "shar-noncanonical-redirect-"));

  await assert.rejects(
    capturePage(
      fakeCaptureSession({ finalUrl: "https://x.test/dashboard" }),
      projectDir,
      "https://x.test/products",
      () => {},
    ),
    /non-canonical redirect/i,
  );

  assert.equal(existsSync(join(projectDir, ".sharingan")), false);
});

test("capturePage accepts a same-origin canonical redirect and labels evidence with its real final URL", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "shar-canonical-redirect-"));
  const requestedUrl = "https://x.test/products?view=grid#details";
  const finalUrl = "https://x.test/products/?view=grid";

  const { page, loginRequired } = await capturePage(
    fakeCaptureSession({ finalUrl }),
    projectDir,
    requestedUrl,
    () => {},
  );

  assert.equal(loginRequired, false);
  assert.equal(page?.url, finalUrl, "pixels, DOM, and render-map use the browser's final URL identity");
  assert.equal(page?.requestedUrl, requestedUrl, "the capture retains the user-requested source identity for verification");
  assert.match(page?.dom ?? "", new RegExp(pageDir(finalUrl).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("capturePage retries an unusable navigation cached by browser startup", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "shar-retry-open-navigation-"));
  let navigations = 0;
  const session = {
    ...fakeCaptureSession(),
    navigationFor: () => ({ status: 0, finalUrl: "about:blank" }),
    navigate: async (url: string) => {
      navigations += 1;
      return { status: 200, finalUrl: url };
    },
  } as unknown as SharinganSession;

  const result = await capturePage(session, projectDir, "https://x.test/", () => {}, {
    reuseCurrentNavigation: true,
  });

  assert.equal(navigations, 1, "a failed startup navigation gets one explicit retry");
  assert.equal(result.page?.url, "https://x.test/");
});

test("capturePage refuses to label evidence after the browser drifts from the attested final URL", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "shar-navigation-drift-"));
  const session = {
    ...fakeCaptureSession(),
    currentUrl: () => "https://x.test/changed",
  } as unknown as SharinganSession;

  await assert.rejects(
    capturePage(session, projectDir, "https://x.test/", () => {}),
    /changed after navigation|navigation identity/i,
  );
  assert.equal(existsSync(join(projectDir, ".sharingan")), false);
});

test("capturePage preserves a login wall reached through a redirect instead of treating it as source evidence", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "shar-login-redirect-"));

  const result = await capturePage(
    fakeCaptureSession({ status: 401, finalUrl: "https://login.vendor.test/session" }),
    projectDir,
    "https://x.test/products",
    () => {},
  );

  assert.equal(result.loginRequired, true);
  assert.equal(result.page, null);
  assert.equal(existsSync(join(projectDir, ".sharingan")), false);
});

function seedDerivedSharinganArtifacts(projectDir: string): string[] {
  const staleFiles = [
    join(".sharingan", "source-scaffold", "index.html"),
    join(".sharingan", "region-plan.json"),
    join(".sharingan", "region-build.json"),
    join(".sharingan", "region-work", "state.json"),
    join("src", "sharingan-regions", "Hero.tsx"),
  ];
  for (const rel of staleFiles) {
    mkdirSync(join(projectDir, rel, ".."), { recursive: true });
    writeFileSync(join(projectDir, rel), "stale");
  }
  return staleFiles;
}

test("capturePage invalidates stale Sharingan derivatives after a successful entry recapture", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "shar-recapture-derived-"));
  const staleFiles = seedDerivedSharinganArtifacts(projectDir);

  const result = await capturePage(fakeCaptureSession(), projectDir, "https://x.test/", () => {});

  assert.ok(result.page);
  for (const rel of staleFiles) assert.equal(existsSync(join(projectDir, rel)), false, `${rel} is invalidated`);
});

test("capturePage preserves Sharingan derivatives when entry recapture fails", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "shar-recapture-failed-"));
  const staleFiles = seedDerivedSharinganArtifacts(projectDir);

  await assert.rejects(
    capturePage(fakeCaptureSession({ screenshotError: new Error("capture failed") }), projectDir, "https://x.test/", () => {}),
    /capture failed/,
  );

  for (const rel of staleFiles) assert.equal(existsSync(join(projectDir, rel)), true, `${rel} remains after a failed capture`);
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

test("captureCurrentPage writes a render map with browser-measured boxes and styles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shar-render-map-"));
  const steps: CaptureStep[] = [];
  const session = {
    setViewport: async () => {},
    settle: async () => {},
    screenshot: async () => Buffer.from("png"),
    readDomTree: async () => [
      { tag: "body", classes: "", text: "", box: { x: 0, y: 0, w: 1440, h: 900 }, style: {}, children: [] },
    ],
    readRenderMap: async () => ({
      viewport: { width: 1440, height: 900 },
      document: { width: 1440, height: 1200 },
      elements: [
        {
          selector: "h1.hero",
          tag: "h1",
          text: "Acme",
          box: { x: 80, y: 120, w: 520, h: 72 },
          style: { fontSize: "64px", fontWeight: "700", color: "rgb(17, 17, 17)", backgroundColor: "rgba(0, 0, 0, 0)" },
        },
      ],
    }),
    styleTokens: async () => ({ colors: [], fontFamilies: [], fontSizes: [], radii: [], shadows: [] }),
    assets: async () => [],
    fetchAsset: async () => null,
    discoverLinks: async () => [],
  } as unknown as SharinganSession;

  const page = await captureCurrentPage(session, dir, "https://x.test/", (s) => steps.push(s));
  assert.ok(page.renderMap, "CapturedPage carries the render-map path");
  assert.ok(existsSync(join(dir, page.renderMap)), "render-map.json is written");
  const renderMap = JSON.parse(readFileSync(join(dir, page.renderMap), "utf8")) as {
    viewport: { width: number; height: number };
    document: { width: number; height: number };
    elements: Array<{ selector: string; box: { x: number; y: number; w: number; h: number }; style: Record<string, string> }>;
  };
  assert.deepEqual(renderMap.viewport, { width: 1440, height: 900 });
  assert.equal(renderMap.document.height, 1200);
  assert.equal(renderMap.elements[0]!.selector, "h1.hero");
  assert.equal(renderMap.elements[0]!.box.y, 120);
  assert.equal(renderMap.elements[0]!.style.fontSize, "64px");
  assert.ok(steps.some((s) => s.kind === "render-map"), "capture emits a render-map step");
});

test("captureCurrentPage writes an asset inventory + per-node DOM styles", { skip: !findChrome() && "no Chrome" }, async () => {
  const html = `<!doctype html><html><head><style>
    #row{display:flex;justify-content:center;gap:12px}
    h1{font-size:40px;color:rgb(17,17,17)}
    .hero{background-image:url("/img/hero.png")}
  </style></head><body>
    <div id="row"><h1>Acme</h1></div>
    <img src="/img/logo.png" alt="Acme logo" width="120" height="40">
    <div class="hero" data-dezin-id="hero-card" style="width:200px;height:80px">bg</div>
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
    const renderMap = JSON.parse(readFileSync(join(dir, page.renderMap!), "utf8")) as {
      elements: Array<{ selector: string; tag: string; currentSrc?: string }>;
    };
    assert.ok(renderMap.elements.some((n) => n.selector === '[data-dezin-id="hero-card"]'), "render map preserves data-dezin-id selectors");
    const img = renderMap.elements.find((n) => n.tag === "img");
    assert.ok(img?.currentSrc?.endsWith("/img/logo.png"), "render map carries the image URL used for local asset matching");
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
  writeFileSync(join(dir, pageRel, "shot-desktop.png"), VALID_SOURCE_PNG);
  writeFileSync(join(dir, pageRel, "assets.json"), JSON.stringify([{ url: "https://x/a.png", kind: "img", alt: "logo" }, { url: "https://x/b.png", kind: "background" }]));
  writeValidRenderMap(join(dir, pageRel, "render-map.json"));
  writeFileSync(join(dir, ".sharingan", "pages.json"), JSON.stringify({
    sourceUrl: "https://x/",
    pages: [{ url: "https://x/", title: "Home", screenshots: { desktop: join(pageRel, "shot-desktop.png"), mobile: join(pageRel, "shot-mobile.png") }, dom: join(pageRel, "dom.json"), styles: join(pageRel, "styles.json"), assets: join(pageRel, "assets.json"), renderMap: join(pageRel, "render-map.json"), links: [] }],
  }));
  const ref = sharinganReviewReference(dir);
  assert.ok(ref, "returns a reference");
  assert.equal(ref!.screenshotPath, join(dir, pageRel, "shot-desktop.png"), "absolute path to the entry desktop screenshot");
  assert.equal(ref!.renderMapPath, join(dir, pageRel, "render-map.json"), "absolute path to the source render map");
  assert.match(ref!.assetsSummary ?? "", /2 image/);
  // No bundle -> undefined.
  assert.equal(sharinganReviewReference(mkdtempSync(join(tmpdir(), "shar-empty-"))), undefined);
});

test("sharinganReviewReference selects the manifest sourceUrl page instead of pages[0]", () => {
  const dir = mkdtempSync(join(tmpdir(), "shar-ref-entry-"));
  const firstRel = join(".sharingan", "first");
  const entryRel = join(".sharingan", "entry");
  mkdirSync(join(dir, firstRel), { recursive: true });
  mkdirSync(join(dir, entryRel), { recursive: true });
  writeFileSync(join(dir, firstRel, "shot.png"), VALID_SOURCE_PNG);
  writeFileSync(join(dir, entryRel, "shot.png"), VALID_SOURCE_PNG);
  writeValidRenderMap(join(dir, firstRel, "render-map.json"));
  writeValidRenderMap(join(dir, entryRel, "render-map.json"));
  writeFileSync(join(dir, ".sharingan", "pages.json"), JSON.stringify({
    requestedSourceUrl: "https://x.test/entry",
    sourceUrl: "https://x.test/entry/",
    pages: [
      { url: "https://x.test/other", screenshots: { desktop: join(firstRel, "shot.png") }, renderMap: join(firstRel, "render-map.json") },
      { requestedUrl: "https://x.test/entry", url: "https://x.test/entry/", screenshots: { desktop: join(entryRel, "shot.png") }, renderMap: join(entryRel, "render-map.json") },
    ],
  }));

  assert.equal(sharinganReviewReference(dir)?.screenshotPath, join(dir, entryRel, "shot.png"));
});

test("sharinganReviewReference rejects a manifest whose requested and final source identities are not a canonical redirect", () => {
  const dir = mkdtempSync(join(tmpdir(), "shar-ref-redirect-contract-"));
  const pageRel = join(".sharingan", "dashboard");
  mkdirSync(join(dir, pageRel), { recursive: true });
  writeFileSync(join(dir, pageRel, "shot.png"), VALID_SOURCE_PNG);
  writeValidRenderMap(join(dir, pageRel, "render-map.json"));
  writeFileSync(join(dir, ".sharingan", "pages.json"), JSON.stringify({
    requestedSourceUrl: "https://x.test/products",
    sourceUrl: "https://x.test/dashboard",
    pages: [{
      requestedUrl: "https://x.test/products",
      url: "https://x.test/dashboard",
      screenshots: { desktop: join(pageRel, "shot.png") },
      renderMap: join(pageRel, "render-map.json"),
    }],
  }));

  assert.equal(sharinganReviewReference(dir), undefined, "tampered redirect identity cannot authorize unrelated pixels as source evidence");
});

test("current-schema Sharingan evidence cannot downgrade itself to legacy by deleting redirect identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "shar-ref-schema-downgrade-"));
  const requestedUrl = "https://x.test/entry";
  const finalUrl = "https://x.test/entry/";
  const pageRel = join(".sharingan", "entry-current");
  mkdirSync(join(dir, pageRel), { recursive: true });
  writeFileSync(join(dir, pageRel, "shot.png"), VALID_SOURCE_PNG);
  writeValidRenderMap(join(dir, pageRel, "render-map.json"));
  writePagesManifest(dir, finalUrl, [{
    requestedUrl,
    url: finalUrl,
    title: "Entry",
    screenshots: { desktop: join(pageRel, "shot.png") },
    dom: join(pageRel, "dom.json"),
    styles: join(pageRel, "styles.json"),
    assets: join(pageRel, "assets.json"),
    renderMap: join(pageRel, "render-map.json"),
    links: [],
  }], requestedUrl);
  const manifestPath = join(dir, ".sharingan", "pages.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    schemaVersion?: number;
    requestedSourceUrl?: string;
    pages: Array<{ requestedUrl?: string }>;
  };
  assert.equal(manifest.schemaVersion, 2);
  assert.ok(sharinganReviewReference(dir, { expectedRequestedUrl: requestedUrl, requireCurrentSchema: true }));

  delete manifest.schemaVersion;
  delete manifest.requestedSourceUrl;
  delete manifest.pages[0]!.requestedUrl;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.equal(
    sharinganReviewReference(dir, { expectedRequestedUrl: requestedUrl, requireCurrentSchema: true }),
    undefined,
    "a fresh run cannot bypass its contract by masquerading as a legacy manifest",
  );
});

test("sharinganReviewReference binds current evidence to the expected project source URL", () => {
  const dir = mkdtempSync(join(tmpdir(), "shar-ref-expected-source-"));
  const pageRel = join(".sharingan", "other-entry");
  mkdirSync(join(dir, pageRel), { recursive: true });
  writeFileSync(join(dir, pageRel, "shot.png"), VALID_SOURCE_PNG);
  writeValidRenderMap(join(dir, pageRel, "render-map.json"));
  writePagesManifest(dir, "https://x.test/other/", [{
    requestedUrl: "https://x.test/other",
    url: "https://x.test/other/",
    title: "Other",
    screenshots: { desktop: join(pageRel, "shot.png") },
    dom: "",
    styles: "",
    assets: "",
    renderMap: join(pageRel, "render-map.json"),
    links: [],
  }], "https://x.test/other");

  assert.equal(
    sharinganReviewReference(dir, { expectedRequestedUrl: "https://x.test/entry", requireCurrentSchema: true }),
    undefined,
  );
});

test("sharinganReviewReference fails closed when sourceUrl has no matching page", () => {
  const dir = mkdtempSync(join(tmpdir(), "shar-ref-missing-entry-"));
  const otherRel = join(".sharingan", "other");
  mkdirSync(join(dir, otherRel), { recursive: true });
  writeFileSync(join(dir, otherRel, "shot.png"), VALID_SOURCE_PNG);
  writeValidRenderMap(join(dir, otherRel, "render-map.json"));
  writeFileSync(join(dir, ".sharingan", "pages.json"), JSON.stringify({
    sourceUrl: "https://x.test/entry",
    pages: [{ url: "https://x.test/other", screenshots: { desktop: join(otherRel, "shot.png") }, renderMap: join(otherRel, "render-map.json") }],
  }));

  assert.equal(sharinganReviewReference(dir), undefined);
});

test("sharinganReviewReference keeps pages[0] compatibility for legacy manifests without sourceUrl", () => {
  const dir = mkdtempSync(join(tmpdir(), "shar-ref-legacy-"));
  const legacyRel = join(".sharingan", "legacy");
  mkdirSync(join(dir, legacyRel), { recursive: true });
  writeFileSync(join(dir, legacyRel, "shot.png"), VALID_SOURCE_PNG);
  writeValidRenderMap(join(dir, legacyRel, "render-map.json"));
  writeFileSync(join(dir, ".sharingan", "pages.json"), JSON.stringify({
    pages: [{ url: "https://x.test/legacy", screenshots: { desktop: join(legacyRel, "shot.png") }, renderMap: join(legacyRel, "render-map.json") }],
  }));

  assert.equal(sharinganReviewReference(dir)?.screenshotPath, join(dir, legacyRel, "shot.png"));
});

test("sharinganReviewReference rejects missing or corrupt source render evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "shar-ref-corrupt-evidence-"));
  const pageRel = join(".sharingan", "entry");
  mkdirSync(join(dir, pageRel), { recursive: true });
  writeFileSync(join(dir, pageRel, "shot.png"), VALID_SOURCE_PNG);
  writeFileSync(join(dir, pageRel, "render-map.json"), "{not-json");
  writeFileSync(join(dir, ".sharingan", "pages.json"), JSON.stringify({
    sourceUrl: "https://x.test/entry",
    pages: [{
      url: "https://x.test/entry",
      screenshots: { desktop: join(pageRel, "shot.png") },
      renderMap: join(pageRel, "render-map.json"),
    }],
  }));

  assert.equal(sharinganReviewReference(dir), undefined, "a corrupt render map cannot become review evidence");
  writeFileSync(join(dir, pageRel, "render-map.json"), JSON.stringify({ viewport: {}, document: {}, elements: "bad" }));
  assert.equal(sharinganReviewReference(dir), undefined, "a structurally invalid render map fails closed");
  writeValidRenderMap(join(dir, pageRel, "render-map.json"));
  writeFileSync(join(dir, pageRel, "shot.png"), "not-a-png");
  assert.equal(sharinganReviewReference(dir), undefined, "a corrupt source screenshot fails closed");
});

test("sharinganReviewReference rejects manifest paths that escape the project", () => {
  const parent = mkdtempSync(join(tmpdir(), "shar-ref-escape-"));
  const dir = join(parent, "project");
  mkdirSync(join(dir, ".sharingan"), { recursive: true });
  writeFileSync(join(parent, "outside.png"), "outside");
  writeFileSync(join(dir, ".sharingan", "pages.json"), JSON.stringify({
    sourceUrl: "https://x.test/",
    pages: [{ url: "https://x.test/", screenshots: { desktop: "../outside.png" } }],
  }));

  assert.equal(sharinganReviewReference(dir), undefined);
});

test("sharinganReviewReference returns undefined for a malformed (null) manifest instead of throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "shar-nullref-"));
  mkdirSync(join(dir, ".sharingan"), { recursive: true });
  writeFileSync(join(dir, ".sharingan", "pages.json"), "null");
  assert.equal(sharinganReviewReference(dir), undefined);
});

test("captureCurrentPage emits one desktop full-page screenshot step carrying its shot path (mobile dropped)", { skip: !findChrome() && "no Chrome" }, async () => {
  const fixture = createServer((_r, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end('<!doctype html><html><body><h1>Acme</h1><p>' + "w ".repeat(40) + '</p></body></html>'); });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
  const dir = mkdtempSync(join(tmpdir(), "shar-shot-"));
  const session = await SharinganSession.open(url, { userDataDir: mkdtempSync(join(tmpdir(), "shar-shot-prof-")), headless: true });
  const steps: CaptureStep[] = [];
  try {
    await captureCurrentPage(session, dir, url, (s) => steps.push(s));
    const shots = steps.filter((s) => s.kind === "screenshot" && s.shot);
    assert.equal(shots.length, 1, "one desktop screenshot step (mobile is not captured by default)");
    assert.match(shots[0]!.shot!, /shot-desktop-[a-z0-9]+\.png$/, "desktop shot path present (unique per-capture filename)");
    assert.ok(!shots.some((s) => /shot-mobile/.test(s.shot!)), "no mobile shot by default");
  } finally {
    await session.close();
    await new Promise<void>((r) => fixture.close(() => r()));
  }
});
