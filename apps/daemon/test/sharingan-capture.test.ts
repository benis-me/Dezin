import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { detectLoginWall, looksLikeLoginWall, capturePage, captureCurrentPage } from "../src/sharingan-capture.ts";
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
