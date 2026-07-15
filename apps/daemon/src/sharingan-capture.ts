import { mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { SharinganSession, VIEWPORTS, type DomNode, type DomTreeNode } from "./sharingan-browser.ts";

export interface CaptureStep { at: number; kind: "navigate" | "screenshot" | "render-map" | "dom" | "styles" | "links" | "assets" | "login-required" | "done"; text: string; shot?: string }
export interface CapturedPage { url: string; requestedUrl?: string; title: string; screenshots: Record<string, string>; dom: string; styles: string; assets: string; links: string[]; renderMap?: string }
export const SHARINGAN_CAPTURE_SCHEMA_VERSION = 2;

const LOGIN_URL_RE = /\/(login|signin|sign-in|auth|account)(\/|\?|$)/i;
const AUTH_REDIRECT_URL_RE = /\/(oauth2?|authorize|sso|saml)(\/|\?|$)/i;

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

export function detectLoginWall(input: { status: number; requestedUrl?: string; finalUrl: string; hasPasswordField: boolean; textLength: number; dom?: DomNode[] }): boolean {
  let crossOriginRedirect = false;
  if (input.requestedUrl) {
    try { crossOriginRedirect = new URL(input.requestedUrl).origin !== new URL(input.finalUrl).origin; } catch { /* invalid URLs fail later */ }
  }
  if (input.status === 401 || input.status === 403) return true;
  if (LOGIN_URL_RE.test(input.finalUrl)) return true;
  if (crossOriginRedirect && AUTH_REDIRECT_URL_RE.test(input.finalUrl)) return true;
  if (input.hasPasswordField && (input.textLength < 80 || crossOriginRedirect)) return true;
  if (input.dom && looksLikeLoginWall(input.dom)) return true;
  return false;
}

function redirectIdentity(url: URL): string {
  const pathname = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, "");
  const routeHash = /^#[!/]/.test(url.hash) ? url.hash : "";
  return `${url.origin}${pathname}${url.search}${routeHash}`;
}

/** Only URL-canonical redirects may retain one source identity: same origin and the same path,
 * query, and SPA route after ignoring a trailing slash or an ordinary on-page anchor. */
export function isAllowedCaptureRedirect(requestedUrl: string, finalUrl: string): boolean {
  try {
    const requested = new URL(requestedUrl);
    const final = new URL(finalUrl);
    if (!/^https?:$/.test(requested.protocol) || !/^https?:$/.test(final.protocol)) return false;
    if (requested.origin !== final.origin) return false;
    return redirectIdentity(requested) === redirectIdentity(final);
  } catch {
    return false;
  }
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

  step("render-map", "Reading browser-measured render map");
  const renderMapRel = join(rel, "render-map.json");
  writeFileSync(join(projectDir, renderMapRel), JSON.stringify(await session.readRenderMap(), null, 0));

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
  return { url, title, screenshots, dom: domRel, styles: styleRel, assets: assetRel, renderMap: renderMapRel, links };
}

const SHARINGAN_DERIVED_PATHS = [
  join(".sharingan", "source-scaffold"),
  join(".sharingan", "region-plan.json"),
  join(".sharingan", "region-build.json"),
  join(".sharingan", "region-work"),
  join("src", "sharingan-regions"),
] as const;

/** Remove build artifacts derived from an older raw capture. Call only after the replacement raw
 * capture has completed successfully, so capture failures preserve the last usable derivatives. */
export function invalidateSharinganDerivedArtifacts(projectDir: string): void {
  for (const derivedPath of SHARINGAN_DERIVED_PATHS) {
    rmSync(join(projectDir, derivedPath), { recursive: true, force: true });
  }
}

export async function capturePage(
  session: SharinganSession,
  projectDir: string,
  url: string,
  onStep: (s: CaptureStep) => void,
  options: { reuseCurrentNavigation?: boolean } = {},
): Promise<{ page: CapturedPage | null; loginRequired: boolean }> {
  const step = (kind: CaptureStep["kind"], text: string) => onStep({ at: Date.now(), kind, text });
  step("navigate", `Navigating to ${url}`);
  const cachedNavigation = options.reuseCurrentNavigation ? session.navigationFor?.(url) : null;
  let reusableNavigation = false;
  if (cachedNavigation && cachedNavigation.status > 0) {
    try {
      const protocol = new URL(cachedNavigation.finalUrl).protocol;
      reusableNavigation = protocol === "http:" || protocol === "https:";
    } catch {
      reusableNavigation = false;
    }
  }
  const nav = reusableNavigation ? cachedNavigation! : await session.navigate(url);
  const assertNavigationIdentity = (): void => {
    const currentUrl = session.currentUrl?.();
    if (currentUrl && currentUrl !== nav.finalUrl) {
      throw new Error(`Sharingan capture refused a page that changed after navigation from ${nav.finalUrl} to ${currentUrl}.`);
    }
  };
  assertNavigationIdentity();
  const dom = await session.readDom(400);
  const hasPasswordField = await session.hasPasswordField();
  const textLength = dom.reduce((a, n) => a + n.text.length, 0);
  if (detectLoginWall({ status: nav.status, requestedUrl: url, finalUrl: nav.finalUrl, hasPasswordField, textLength, dom })) {
    step("login-required", `This page needs a login (${nav.finalUrl}). Sign in, then continue.`);
    return { page: null, loginRequired: true };
  }
  let requested: URL;
  let final: URL;
  try {
    requested = new URL(url);
    final = new URL(nav.finalUrl);
  } catch {
    throw new Error(`Sharingan capture refused an invalid redirect from ${url} to ${nav.finalUrl}.`);
  }
  if (requested.origin !== final.origin) {
    throw new Error(`Sharingan capture refused a cross-origin redirect from ${url} to ${nav.finalUrl}.`);
  }
  if (!isAllowedCaptureRedirect(url, nav.finalUrl)) {
    throw new Error(`Sharingan capture refused a non-canonical redirect from ${url} to ${nav.finalUrl}.`);
  }
  assertNavigationIdentity();
  const page = { ...(await captureCurrentPage(session, projectDir, nav.finalUrl, onStep)), requestedUrl: url };
  // A fresh entry capture makes every scaffold/region artifact derived from the previous raw
  // evidence stale. Delete them only after captureCurrentPage has completed successfully, so a
  // failed re-capture never destroys the last usable build inputs.
  invalidateSharinganDerivedArtifacts(projectDir);
  return { page, loginRequired: false };
}

export function writePagesManifest(projectDir: string, sourceUrl: string, pages: CapturedPage[], requestedSourceUrl = sourceUrl): void {
  mkdirSync(join(projectDir, ".sharingan"), { recursive: true });
  const manifest = {
    schemaVersion: SHARINGAN_CAPTURE_SCHEMA_VERSION,
    requestedSourceUrl,
    sourceUrl,
    pages: pages.map((p) => ({
      requestedUrl: p.requestedUrl
        ?? (captureUrlKey(p.url) === captureUrlKey(sourceUrl) && isAllowedCaptureRedirect(requestedSourceUrl, p.url) ? requestedSourceUrl : p.url),
      url: p.url,
      title: p.title,
      screenshots: p.screenshots,
      dom: p.dom,
      styles: p.styles,
      assets: p.assets,
      renderMap: p.renderMap,
      links: p.links,
    })),
  };
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

/** Read the entry source URL without loading the capture into live browser state. Probe sessions use
 * this after daemon restart so secondary-page captures cannot replace or impersonate the entry. */
export function readCapturedSourceUrl(projectDir: string): string | undefined {
  const manifestPath = join(projectDir, ".sharingan", "pages.json");
  if (!existsSync(manifestPath)) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { sourceUrl?: unknown };
    return typeof manifest?.sourceUrl === "string" && manifest.sourceUrl.trim() ? manifest.sourceUrl.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Read the originally requested entry URL. New manifests retain this beside the real final URL;
 * legacy manifests fall back to sourceUrl because they predate redirect identity tracking. */
export function readCapturedRequestedSourceUrl(projectDir: string): string | undefined {
  const manifestPath = join(projectDir, ".sharingan", "pages.json");
  if (!existsSync(manifestPath)) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { requestedSourceUrl?: unknown; sourceUrl?: unknown };
    const requested = typeof manifest?.requestedSourceUrl === "string" ? manifest.requestedSourceUrl.trim() : "";
    if (requested) return requested;
    return typeof manifest?.sourceUrl === "string" && manifest.sourceUrl.trim() ? manifest.sourceUrl.trim() : undefined;
  } catch {
    return undefined;
  }
}

function projectArtifactPath(projectDir: string, artifactPath: unknown): string | undefined {
  if (typeof artifactPath !== "string" || artifactPath.length === 0) return undefined;
  const projectRoot = resolve(projectDir);
  const candidate = resolve(projectRoot, artifactPath);
  const lexicalRelative = relative(projectRoot, candidate);
  if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) return undefined;
  if (!existsSync(candidate)) return undefined;
  try {
    const realRoot = realpathSync(projectRoot);
    const realCandidate = realpathSync(candidate);
    const realRelative = relative(realRoot, realCandidate);
    if (realRelative === ".." || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) return undefined;
  } catch {
    return undefined;
  }
  return candidate;
}

const PNG_SIGNATURE = "89504e470d0a1a0a";
let pngCrcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  pngCrcTable ??= Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    return value >>> 0;
  });
  let value = 0xffffffff;
  for (const byte of bytes) value = pngCrcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function validSourceScreenshot(path: string): boolean {
  try {
    const bytes = readFileSync(path);
    if (bytes.length < 45 || bytes.subarray(0, 8).toString("hex") !== PNG_SIGNATURE) return false;
    let offset = 8;
    let width = 0;
    let height = 0;
    let sawIdat = false;
    let sawIend = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const chunkEnd = offset + 12 + length;
      if (chunkEnd > bytes.length) return false;
      const typeAndData = bytes.subarray(offset + 4, offset + 8 + length);
      const type = typeAndData.subarray(0, 4).toString("ascii");
      if (crc32(typeAndData) !== bytes.readUInt32BE(offset + 8 + length)) return false;
      if (type === "IHDR") {
        if (offset !== 8 || length !== 13) return false;
        width = bytes.readUInt32BE(offset + 8);
        height = bytes.readUInt32BE(offset + 12);
        const bitDepth = bytes[offset + 16];
        const colorType = bytes[offset + 17];
        const compression = bytes[offset + 18];
        const filter = bytes[offset + 19];
        const interlace = bytes[offset + 20];
        if (!width || !height || bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || compression !== 0 || filter !== 0 || interlace !== 0) return false;
      } else if (type === "IDAT") {
        sawIdat = sawIdat || length > 0;
      } else if (type === "IEND") {
        if (length !== 0 || chunkEnd !== bytes.length) return false;
        sawIend = true;
      }
      offset = chunkEnd;
      if (sawIend) break;
    }
    return width > 0 && height > 0 && sawIdat && sawIend;
  } catch {
    return false;
  }
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validRenderMap(path: string): boolean {
  try {
    const map = JSON.parse(readFileSync(path, "utf8")) as {
      viewport?: { width?: unknown; height?: unknown };
      document?: { width?: unknown; height?: unknown };
      elements?: unknown;
    };
    if (!map || typeof map !== "object" || Array.isArray(map)) return false;
    if (!finitePositive(map.viewport?.width) || !finitePositive(map.viewport?.height)) return false;
    if (!finitePositive(map.document?.width) || !finitePositive(map.document?.height)) return false;
    if (!Array.isArray(map.elements) || map.elements.length === 0 || map.elements.length > 700) return false;
    return map.elements.every((element) => {
      if (!element || typeof element !== "object" || Array.isArray(element)) return false;
      const candidate = element as { selector?: unknown; tag?: unknown; box?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown }; style?: unknown };
      return typeof candidate.selector === "string"
        && candidate.selector.length > 0
        && typeof candidate.tag === "string"
        && candidate.tag.length > 0
        && typeof candidate.box?.x === "number"
        && Number.isFinite(candidate.box.x)
        && typeof candidate.box?.y === "number"
        && Number.isFinite(candidate.box.y)
        && finitePositive(candidate.box?.w)
        && finitePositive(candidate.box?.h)
        && !!candidate.style
        && typeof candidate.style === "object"
        && !Array.isArray(candidate.style);
    });
  } catch {
    return false;
  }
}

/** Locate the Sharingan review reference for a project: the entry page's validated desktop PNG and
 *  validated render map (absolute paths, so the critic can read them) + a one-line summary of the
 *  source's image inventory. Returns undefined unless the evidence chain is complete. */
export function sharinganReviewReference(
  projectDir: string,
  options: { expectedRequestedUrl?: string; requireCurrentSchema?: boolean } = {},
): { screenshotPath: string; renderMapPath: string; assetsSummary?: string } | undefined {
  const manifestPath = projectArtifactPath(projectDir, join(".sharingan", "pages.json"));
  if (!manifestPath) return undefined;
  let manifest: {
    schemaVersion?: unknown;
    requestedSourceUrl?: string;
    sourceUrl?: string;
    pages?: Array<{ requestedUrl?: string; url?: string; screenshots?: Record<string, string>; assets?: string; renderMap?: string }>;
  };
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { return undefined; }
  if (!manifest || typeof manifest !== "object") return undefined;
  const pages = Array.isArray(manifest.pages) ? manifest.pages : [];
  if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== SHARINGAN_CAPTURE_SCHEMA_VERSION) return undefined;
  if (options.requireCurrentSchema && manifest.schemaVersion !== SHARINGAN_CAPTURE_SCHEMA_VERSION) return undefined;
  const hasSourceUrl = Object.prototype.hasOwnProperty.call(manifest, "sourceUrl");
  const hasRequestedSourceUrl = Object.prototype.hasOwnProperty.call(manifest, "requestedSourceUrl");
  if (manifest.schemaVersion === SHARINGAN_CAPTURE_SCHEMA_VERSION && !hasRequestedSourceUrl) return undefined;
  if (hasRequestedSourceUrl) {
    if (
      typeof manifest.requestedSourceUrl !== "string"
      || typeof manifest.sourceUrl !== "string"
      || !isAllowedCaptureRedirect(manifest.requestedSourceUrl, manifest.sourceUrl)
    ) return undefined;
  }
  if (options.expectedRequestedUrl) {
    const claimedRequestedUrl = hasRequestedSourceUrl ? manifest.requestedSourceUrl : manifest.sourceUrl;
    if (typeof claimedRequestedUrl !== "string" || !isAllowedCaptureRedirect(options.expectedRequestedUrl, claimedRequestedUrl)) return undefined;
  }
  const entry = hasSourceUrl
    ? typeof manifest.sourceUrl === "string"
      ? pages.find((page) => typeof page?.url === "string" && captureUrlKey(page.url) === captureUrlKey(manifest.sourceUrl!))
      : undefined
    : pages[0];
  if (hasRequestedSourceUrl && entry?.requestedUrl !== manifest.requestedSourceUrl) return undefined;
  const shotRel = entry?.screenshots?.desktop;
  if (!shotRel) return undefined;
  const screenshotPath = projectArtifactPath(projectDir, shotRel);
  if (!screenshotPath || !validSourceScreenshot(screenshotPath)) return undefined;
  const renderMapPath = projectArtifactPath(projectDir, entry?.renderMap);
  if (!renderMapPath || !validRenderMap(renderMapPath)) return undefined;
  let assetsSummary: string | undefined;
  const assetsPath = projectArtifactPath(projectDir, entry?.assets);
  if (assetsPath) {
    try {
      const assets = JSON.parse(readFileSync(assetsPath, "utf8")) as Array<{ kind: string; alt?: string; w?: number; h?: number }>;
      const imgs = assets.filter((a) => a.kind === "img" || a.kind === "background");
      const sample = imgs.slice(0, 4).map((a) => `${a.alt || a.kind}${a.w && a.h ? ` (${a.w}x${a.h})` : ""}`).join(", ");
      if (imgs.length) assetsSummary = `${imgs.length} image slot${imgs.length === 1 ? "" : "s"}: ${sample}`;
    } catch { /* ignore a malformed assets.json */ }
  }
  return { screenshotPath, assetsSummary, renderMapPath };
}
