import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SharinganSession, VIEWPORTS, type DomNode, type DomTreeNode } from "./sharingan-browser.ts";

export interface CaptureStep { at: number; kind: "navigate" | "screenshot" | "dom" | "styles" | "links" | "assets" | "login-required" | "done"; text: string; shot?: string }
export interface CapturedPage { url: string; title: string; screenshots: Record<string, string>; dom: string; styles: string; assets: string; links: string[] }

const LOGIN_URL_RE = /\/(login|signin|sign-in|auth|account)(\/|\?|$)/i;

const OAUTH_BTN = /(continue|sign ?in|log ?in|signup|sign ?up) with (google|apple|github|facebook|microsoft|x|twitter)|使用\s*[^ ]{0,8}(继续|登录)|以\s*[^ ]{0,8}(继续|登录)/i;

/** A page that IS a login/OAuth screen (little else on it), not a content page that merely links to
 *  login. Anchored on an OAuth/social provider BUTTON ("continue with Google", "使用微信登录") — the one
 *  unambiguous signal a plain nav "Log in" link never produces — and gated by a node cap so a large
 *  content page that just embeds a social sign-in in its header is not mistaken for a login wall.
 *  Password-form login walls are handled separately by detectLoginWall's password-field heuristic;
 *  a bare keyword page (a landing/waitlist page repeating "Sign up"/"Log in") is deliberately NOT
 *  flagged, to avoid false positives on that common clone target. */
export function looksLikeLoginWall(dom: DomNode[]): boolean {
  if (!dom.length) return false;
  const hasOauthBtn = dom.some((n) => OAUTH_BTN.test(n.text));
  // <= 200 nodes keeps a busy-but-real login wall (footer nav, cookie banner, ToS) in scope while
  // excluding full content pages (hundreds+ of nodes) that merely offer a social sign-in.
  return hasOauthBtn && dom.length <= 200;
}

export function detectLoginWall(input: { status: number; finalUrl: string; hasPasswordField: boolean; textLength: number; dom?: DomNode[] }): boolean {
  if (input.status === 401 || input.status === 403) return true;
  if (LOGIN_URL_RE.test(input.finalUrl)) return true;
  if (input.hasPasswordField && input.textLength < 80) return true;
  if (input.dom && looksLikeLoginWall(input.dom)) return true;
  return false;
}

function firstText(nodes: DomTreeNode[], tag: string): string | undefined {
  for (const n of nodes) {
    if (n.tag === tag && n.text) return n.text;
    const found = firstText(n.children, tag);
    if (found) return found;
  }
  return undefined;
}

const CT_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg", "image/avif": "avif" };
function assetExt(url: string, contentType: string): string {
  const ct = CT_EXT[contentType.split(";")[0]?.trim() ?? ""];
  if (ct) return ct;
  const m = /\.(png|jpe?g|webp|gif|svg|avif)(?:\?|#|$)/i.exec(url);
  return m ? m[1]!.toLowerCase().replace("jpeg", "jpg") : "png";
}

export function pageDir(url: string): string {
  // NOTE (Phase 4): collision-safe — a short sha1 hash of the FULL url is appended to the
  // human-readable slug, so two distinct URLs that collapse to the same slug (after stripping
  // non-alphanumerics and truncating) still land in distinct dirs. Needed now that /capture
  // can write multiple distinct pages per project instead of just the single entry page.
  const slug = url.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "page";
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}

export async function captureCurrentPage(
  session: SharinganSession,
  projectDir: string,
  url: string,
  onStep: (s: CaptureStep) => void,
): Promise<CapturedPage> {
  const step = (kind: CaptureStep["kind"], text: string, shot?: string) => onStep({ at: Date.now(), kind, text, shot });
  const rel = join(".sharingan", pageDir(url));
  mkdirSync(join(projectDir, rel), { recursive: true });
  // Unique per-capture token so re-capturing the SAME url writes a NEW screenshot file instead of
  // overwriting the previous one — otherwise every earlier work-log record (which stores the shot
  // PATH, served live) would retroactively flip to show the latest shot.
  const token = `${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;

  const screenshots: Record<string, string> = {};
  // Desktop full-page only by default — mobile shots aren't worth the extra capture + settle time.
  for (const v of VIEWPORTS.filter((vp) => vp.label === "desktop")) {
    await session.setViewport(v);
    await session.settle(); // let the viewport reflow + async content settle (network-idle + DOM-stable) before the shot
    const shot = await session.screenshot({ fullPage: true });
    const shotRel = join(rel, `shot-${v.label}-${token}.png`);
    writeFileSync(join(projectDir, shotRel), shot);
    screenshots[v.label] = shotRel;
    step("screenshot", `Captured ${v.label} (${v.width}px)`, shotRel);
  }

  step("dom", "Reading DOM structure");
  const dom = await session.readDomTree();
  const domRel = join(rel, "dom.json");
  writeFileSync(join(projectDir, domRel), JSON.stringify(dom, null, 0));

  step("styles", "Reading computed style tokens");
  const styleRel = join(rel, "styles.json");
  writeFileSync(join(projectDir, styleRel), JSON.stringify(await session.styleTokens(), null, 0));

  step("assets", "Inventorying image assets");
  const assets = await session.assets();
  step("assets", "Downloading source images");
  const publicAssetsDir = join(projectDir, "public", "_assets");
  mkdirSync(publicAssetsDir, { recursive: true });
  for (const a of assets) {
    if (a.kind === "video") continue; // skip heavy video files; posters are inventoried as kind "img"
    const got = await session.fetchAsset(a.url).catch(() => null);
    if (!got) continue;
    const name = `${createHash("sha1").update(a.url).digest("hex").slice(0, 12)}.${assetExt(a.url, got.contentType)}`;
    try {
      writeFileSync(join(publicAssetsDir, name), Buffer.from(got.bytes));
      a.local = `/_assets/${name}`;
    } catch { /* best-effort: leave a.local unset */ }
  }
  const assetRel = join(rel, "assets.json");
  writeFileSync(join(projectDir, assetRel), JSON.stringify(assets, null, 0));

  step("links", "Discovering same-origin links");
  const links = await session.discoverLinks();

  const title = (firstText(dom, "h1") || url).slice(0, 80);
  step("done", "Capture complete");
  return { url, title, screenshots, dom: domRel, styles: styleRel, assets: assetRel, links };
}

export async function capturePage(
  session: SharinganSession,
  projectDir: string,
  url: string,
  onStep: (s: CaptureStep) => void,
): Promise<{ page: CapturedPage | null; loginRequired: boolean }> {
  const step = (kind: CaptureStep["kind"], text: string) => onStep({ at: Date.now(), kind, text });
  step("navigate", `Navigating to ${url}`);
  const nav = await session.navigate(url);
  const dom = await session.readDom(400);
  const hasPasswordField = await session.hasPasswordField();
  const textLength = dom.reduce((a, n) => a + n.text.length, 0);
  if (detectLoginWall({ status: nav.status, finalUrl: nav.finalUrl, hasPasswordField, textLength, dom })) {
    step("login-required", `This page needs a login (${nav.finalUrl}). Sign in, then continue.`);
    return { page: null, loginRequired: true };
  }
  const page = await captureCurrentPage(session, projectDir, url, onStep);
  return { page, loginRequired: false };
}

export function writePagesManifest(projectDir: string, sourceUrl: string, pages: CapturedPage[]): void {
  mkdirSync(join(projectDir, ".sharingan"), { recursive: true });
  const manifest = { sourceUrl, pages: pages.map((p) => ({ url: p.url, title: p.title, screenshots: p.screenshots, dom: p.dom, styles: p.styles, assets: p.assets, links: p.links })) };
  writeFileSync(join(projectDir, ".sharingan", "pages.json"), JSON.stringify(manifest, null, 2));
}

/** Normalize a URL for capture-dedup: drop a trailing slash and a PLAIN on-page anchor (`#section`),
 *  but KEEP a hash-route fragment (`#/products`, `#!/x`) — those are distinct SPA pages, not anchors. */
export function captureUrlKey(url: string): string {
  const isRouteHash = (hash: string) => /^#[!/]/.test(hash);
  try {
    const u = new URL(url);
    if (!isRouteHash(u.hash)) u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url.replace(/#(?![!/]).*$/, "").replace(/\/$/, "");
  }
}

/** Upsert a captured page into the list by normalized URL — replace an existing same-URL entry
 *  (re-capturing a page updates it) instead of appending a duplicate. Mutates + returns `pages`. */
export function upsertPage(pages: CapturedPage[], page: CapturedPage): CapturedPage[] {
  const key = captureUrlKey(page.url);
  const i = pages.findIndex((p) => captureUrlKey(p.url) === key);
  if (i >= 0) pages[i] = page;
  else pages.push(page);
  return pages;
}

/** Read the on-disk capture manifest back into CapturedPage[] (empty if none) — used to seed the
 *  probe session's page list after a daemon restart so re-captures dedup against what's on disk. */
export function readCapturedPages(projectDir: string): CapturedPage[] {
  const manifestPath = join(projectDir, ".sharingan", "pages.json");
  if (!existsSync(manifestPath)) return [];
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { pages?: CapturedPage[] };
    return Array.isArray(manifest.pages) ? manifest.pages : [];
  } catch {
    return [];
  }
}

/** Locate the Sharingan review reference for a project: the entry page's desktop screenshot (absolute
 *  path, so the critic can read it) + a one-line summary of the source's image inventory. Returns
 *  undefined when there is no captured bundle yet. Reads the on-disk `.sharingan/pages.json`. */
export function sharinganReviewReference(projectDir: string): { screenshotPath: string; assetsSummary?: string } | undefined {
  const manifestPath = join(projectDir, ".sharingan", "pages.json");
  if (!existsSync(manifestPath)) return undefined;
  let manifest: { pages?: Array<{ screenshots?: Record<string, string>; assets?: string }> };
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { return undefined; }
  if (!manifest || typeof manifest !== "object") return undefined;
  const entry = manifest.pages?.[0];
  const shotRel = entry?.screenshots?.desktop;
  if (!shotRel) return undefined;
  const screenshotPath = join(projectDir, shotRel);
  if (!existsSync(screenshotPath)) return undefined;
  let assetsSummary: string | undefined;
  if (entry?.assets && existsSync(join(projectDir, entry.assets))) {
    try {
      const assets = JSON.parse(readFileSync(join(projectDir, entry.assets), "utf8")) as Array<{ kind: string; alt?: string; w?: number; h?: number }>;
      const imgs = assets.filter((a) => a.kind === "img" || a.kind === "background");
      const sample = imgs.slice(0, 4).map((a) => `${a.alt || a.kind}${a.w && a.h ? ` (${a.w}x${a.h})` : ""}`).join(", ");
      if (imgs.length) assetsSummary = `${imgs.length} image slot${imgs.length === 1 ? "" : "s"}: ${sample}`;
    } catch { /* ignore a malformed assets.json */ }
  }
  return { screenshotPath, assetsSummary };
}
