/**
 * Sharingan capture HTTP surface: start a capture, poll its status, or stream its
 * progress via SSE. This owns the in-memory capture registry (per project id) and
 * the session lifecycle (open -> capture -> pause-for-login -> close). Login
 * handling PAUSES (phase "login-required") and never bypasses auth.
 */

import { join, sep } from "node:path";
import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SharinganSession, SHARINGAN_PAGE_BUDGET } from "./sharingan-browser.ts";
import { capturePage, captureCurrentPage, writePagesManifest, upsertPage, readCapturedPages, type CaptureStep, type CapturedPage } from "./sharingan-capture.ts";
import { projectDir, safeJoin } from "./serve-static.ts";
import { sendJson, readJsonBody } from "./http-util.ts";

type Phase = "idle" | "capturing" | "login-required" | "captured" | "error" | "probing";
interface Capture {
  phase: Phase;
  steps: CaptureStep[];
  pages: CapturedPage[];
  session?: SharinganSession;
  listeners: Set<ServerResponse>;
  url?: string;
  error?: string;
  probeTimer?: ReturnType<typeof setTimeout>;
  keepForProbe?: boolean;
}

/** Idle-release window for a lazily-opened (or build-reused) probe session. */
export const SHARINGAN_PROBE_IDLE_MS = 300_000;

const captures = new Map<string, Capture>();

function get(id: string): Capture {
  let c = captures.get(id);
  if (!c) { c = { phase: "idle", steps: [], pages: [], listeners: new Set() }; captures.set(id, c); }
  return c;
}

function emit(c: Capture, step: CaptureStep): void {
  c.steps.push(step);
  const line = `data: ${JSON.stringify(step)}\n\n`;
  for (const res of c.listeners) res.write(line);
}

function armProbeIdle(id: string): void {
  const c = get(id);
  if (c.probeTimer) clearTimeout(c.probeTimer);
  c.probeTimer = setTimeout(() => { void releaseProbeSession(id); }, SHARINGAN_PROBE_IDLE_MS);
  c.probeTimer.unref?.();
}

/** Close and clear an idle (or explicitly released) probe session, restoring phase "captured". */
async function releaseProbeSession(id: string): Promise<void> {
  const c = get(id);
  if (c.probeTimer) { clearTimeout(c.probeTimer); c.probeTimer = undefined; }
  if (c.phase !== "probing") return;
  const s = c.session; c.session = undefined; c.phase = "captured";
  if (s) await s.close().catch(() => {});
}

/**
 * Lazily open (or reuse) the live probe session the build Agent drives to explore + capture
 * key pages. Opens ON `c.url` (the entry sourceUrl) so the session's origin matches the entry
 * capture's origin, which `discoverLinks` filters against. Refuses while the entry capture is
 * mid-flight ("capturing"/"login-required") — those phases mean a headful browser is already
 * live for that id, and opening a second one would orphan it. Every call resets the idle timer.
 */
export async function ensureProbeSession(
  id: string,
  dataDir: string,
  open: (url: string, opts: { userDataDir?: string; headless?: boolean }) => Promise<SharinganSession> = SharinganSession.open,
): Promise<SharinganSession> {
  const c = get(id);
  if (c.phase === "capturing" || c.phase === "login-required") throw new Error("capture in progress");
  // Seed from the on-disk manifest so re-captures dedup against what's already there (e.g. after a
  // daemon restart, when the in-memory page list is empty but the entry page is on disk).
  if (!c.pages.length) c.pages = readCapturedPages(projectDir(dataDir, id));
  if (!c.session) {
    const profileDir = join(dataDir, ".sharingan-profile");
    c.session = await open(c.url ?? "about:blank", { userDataDir: profileDir, headless: process.env.DEZIN_SHARINGAN_HEADLESS === "1" });
    c.phase = "probing";
  }
  armProbeIdle(id);
  return c.session;
}

/** Finalize a successful capture: persist the manifest, then either KEEP the session open for the
 *  build Agent to reuse as a probe (phase "probing", idle-released) or close it (phase "captured").
 *  Keeping it open avoids reopening Chrome mid-build and preserves the just-authenticated session. */
async function finishCapturedSession(id: string, dataDir: string, c: Capture, page: CapturedPage | null): Promise<void> {
  if (page) { upsertPage(c.pages, page); writePagesManifest(projectDir(dataDir, id), c.url ?? page.url, c.pages); }
  if (c.keepForProbe && c.session) {
    c.phase = "probing";
    armProbeIdle(id);
  } else {
    await c.session?.close();
    c.session = undefined;
    c.phase = "captured";
  }
}

export async function startCapture(
  id: string,
  url: string,
  dataDir: string,
  profileDir: string,
  open: (url: string, opts: { userDataDir?: string; headless?: boolean }) => Promise<SharinganSession> = SharinganSession.open,
): Promise<void> {
  const c = get(id);
  // Refuse re-entry whenever a session is live: "capturing" (guards concurrent starts,
  // including the open() await window), "login-required" (a headful browser is paused
  // open for user sign-in), and "probing" (a lazily-opened probe session is live) —
  // re-opening in any of these would orphan the existing session and its
  // persistent-profile lock.
  if (c.phase === "capturing" || c.phase === "login-required" || c.phase === "probing") return;
  c.phase = "capturing"; c.steps = []; c.pages = []; c.error = undefined;
  try {
    const session = await open(url, { userDataDir: profileDir, headless: process.env.DEZIN_SHARINGAN_HEADLESS === "1" });
    c.session = session;
    c.url = url;
    const { page, loginRequired } = await capturePage(session, projectDir(dataDir, id), url, (s) => emit(c, s));
    if (loginRequired) { c.phase = "login-required"; return; }
    await finishCapturedSession(id, dataDir, c, page);
  } catch (err) {
    // Capture threw after open() launched a browser holding the persistent-profile lock.
    // Close it so it cannot leak (and free the lock), then mark the terminal phase.
    if (c.session) { await c.session.close().catch(() => {}); c.session = undefined; }
    c.error = err instanceof Error ? err.message : "capture failed";
    emit(c, { at: Date.now(), kind: "done", text: `Capture failed: ${c.error}` });
    c.phase = "error";
  }
}

export function capturedPageCount(id: string): number {
  return get(id).pages.length;
}

/**
 * Kick the entry capture (if idle, or retrying after a prior error) and await it through to a
 * terminal phase, so the build can gate on the clone actually being captured. Waits through
 * "login-required" (the user signs in via the Phase-3 tab + Continue) but is bounded by
 * `maxWaitMs` so a stalled login can't hang the build forever — on timeout it returns the
 * current (non-terminal) phase and the caller proceeds best-effort.
 */
export async function ensureCaptured(
  id: string,
  dataDir: string,
  url: string,
  opts: { maxWaitMs?: number; pollMs?: number; keepSessionForProbe?: boolean; open?: (url: string, o: { userDataDir?: string; headless?: boolean }) => Promise<SharinganSession> } = {},
): Promise<Phase> {
  const maxWaitMs = opts.maxWaitMs ?? 300_000;
  const pollMs = opts.pollMs ?? 500;
  const c = get(id);
  if (opts.keepSessionForProbe) c.keepForProbe = true;
  if (c.phase === "captured") return c.phase;
  // Kick the entry capture if nothing is in flight (idle, or retry after a prior error).
  if (c.phase === "idle" || c.phase === "error") {
    const profileDir = join(dataDir, ".sharingan-profile");
    void startCapture(id, url, dataDir, profileDir, opts.open);
  }
  // Poll until a terminal phase, waiting through "login-required" (the user signs in via the
  // tab + Continue). Time out (don't hang) so the build proceeds best-effort even if login stalls.
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const phase = get(id).phase;
    // "probing" is a terminal SUCCESS here: the entry capture finished and its session was kept open
    // for the Agent to reuse (keepSessionForProbe). The build can proceed.
    if (phase === "captured" || phase === "error" || phase === "probing") return phase;
    if (Date.now() >= deadline) return phase;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export async function handleSharinganStart(req: IncomingMessage, res: ServerResponse, id: string, dataDir: string): Promise<void> {
  const body = (await readJsonBody(req)) as { url?: string };
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) { sendJson(res, 400, { error: "a valid http(s) url is required" }); return; }
  const profileDir = join(dataDir, ".sharingan-profile");
  void startCapture(id, url, dataDir, profileDir);
  sendJson(res, 200, { ok: true });
}

/**
 * Resume a capture that paused at a login wall. Re-runs `capturePage` on the SAME,
 * now-authenticated session (the user signed in via the visible Chrome window while
 * phase stayed "login-required"). A no-op unless that exact pause state is present —
 * called with a stale/wrong id, or before/after the pause, it does nothing.
 */
export async function continueCapture(id: string, dataDir: string): Promise<void> {
  const c = get(id);
  if (c.phase !== "login-required" || !c.session || !c.url) return;
  c.phase = "capturing";
  try {
    const { page, loginRequired } = await capturePage(c.session, projectDir(dataDir, id), c.url, (s) => emit(c, s));
    if (loginRequired) { c.phase = "login-required"; return; }
    await finishCapturedSession(id, dataDir, c, page);
  } catch (err) {
    if (c.session) { await c.session.close().catch(() => {}); c.session = undefined; }
    c.error = err instanceof Error ? err.message : "capture failed";
    emit(c, { at: Date.now(), kind: "done", text: `Capture failed: ${c.error}` });
    c.phase = "error";
  }
}

export function handleSharinganContinue(res: ServerResponse, id: string, dataDir: string): void {
  void continueCapture(id, dataDir);
  sendJson(res, 200, { ok: true });
}

export function handleSharinganFocus(res: ServerResponse, id: string): void {
  const c = get(id);
  void c.session?.bringToFront();
  sendJson(res, 200, { ok: true });
}

/** Drive the (lazily-opened, idle-released) probe session to a URL. Emits a "navigate" step so the Phase-3 tab shows the Agent's activity. */
export async function handleSharinganNavigate(req: IncomingMessage, res: ServerResponse, id: string, dataDir: string): Promise<void> {
  const body = (await readJsonBody(req)) as { url?: string };
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) { sendJson(res, 400, { error: "a valid http(s) url is required" }); return; }
  try {
    const session = await ensureProbeSession(id, dataDir);
    const c = get(id);
    emit(c, { at: Date.now(), kind: "navigate", text: `Agent navigating to ${url}` });
    const nav = await session.navigate(url);
    sendJson(res, 200, nav);
  } catch (err) {
    sendJson(res, 409, { error: err instanceof Error ? err.message : "navigate failed" });
  }
}

/**
 * Capture the CURRENT probe-session page into the bundle (optionally navigating to
 * `body.url` first), enforcing the Phase-4 page budget so the Agent's exploration can't
 * grow the bundle unbounded. Over budget is a 200 `{ skipped: "budget" }`, not an error —
 * the Agent should treat it as "stop capturing," not a failure to retry.
 */
export async function handleSharinganCapture(req: IncomingMessage, res: ServerResponse, id: string, dataDir: string): Promise<void> {
  const c = get(id);
  if (c.pages.length >= SHARINGAN_PAGE_BUDGET) { sendJson(res, 200, { skipped: "budget", budget: SHARINGAN_PAGE_BUDGET }); return; }
  const body = (await readJsonBody(req)) as { url?: string };
  try {
    const session = await ensureProbeSession(id, dataDir);
    if (typeof body.url === "string" && /^https?:\/\//i.test(body.url)) {
      emit(c, { at: Date.now(), kind: "navigate", text: `Agent navigating to ${body.url}` });
      await session.navigate(body.url.trim());
    }
    const page = await captureCurrentPage(session, projectDir(dataDir, id), session.currentUrl(), (s) => emit(c, s));
    upsertPage(c.pages, page); // dedup by URL — re-capturing the same page updates it, never appends a dup
    writePagesManifest(projectDir(dataDir, id), c.url ?? page.url, c.pages);
    armProbeIdle(id);
    sendJson(res, 200, page);
  } catch (err) {
    sendJson(res, 409, { error: err instanceof Error ? err.message : "capture failed" });
  }
}

/**
 * Ensure the probe session, emit a step (so the Phase-3 tab shows the Agent's activity), run
 * `fn` against it, and normalize success/failure into a discriminated result the callers below
 * turn into `200`/`409` responses.
 */
async function withProbe<T>(
  id: string,
  dataDir: string,
  kind: CaptureStep["kind"],
  text: string,
  fn: (s: SharinganSession) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    const s = await ensureProbeSession(id, dataDir);
    emit(get(id), { at: Date.now(), kind, text });
    return { ok: true, value: await fn(s) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "probe failed" };
  }
}

/** Read up to 400 visible DOM nodes (tag/role/classes/text/box) from the live probe page. */
export async function handleSharinganReadDom(res: ServerResponse, id: string, dataDir: string): Promise<void> {
  const r = await withProbe(id, dataDir, "dom", "Agent reading DOM", (s) => s.readDom(400));
  r.ok ? sendJson(res, 200, r.value) : sendJson(res, 409, { error: r.error });
}

/** Read the computed-style tokens (colors/fonts/sizes/radii/shadows) of the live probe page. */
export async function handleSharinganComputedStyles(res: ServerResponse, id: string, dataDir: string): Promise<void> {
  const r = await withProbe(id, dataDir, "styles", "Agent reading styles", (s) => s.styleTokens());
  r.ok ? sendJson(res, 200, r.value) : sendJson(res, 409, { error: r.error });
}

/** List same-origin links discovered on the live probe page. */
export async function handleSharinganLinks(res: ServerResponse, id: string, dataDir: string): Promise<void> {
  const r = await withProbe(id, dataDir, "links", "Agent listing links", (s) => s.discoverLinks());
  r.ok ? sendJson(res, 200, r.value) : sendJson(res, 409, { error: r.error });
}

/** Click a selector on the live probe page. */
export async function handleSharinganClick(req: IncomingMessage, res: ServerResponse, id: string, dataDir: string): Promise<void> {
  const body = (await readJsonBody(req)) as { selector?: string };
  const selector = typeof body.selector === "string" ? body.selector : "";
  if (!selector) { sendJson(res, 400, { error: "selector required" }); return; }
  const r = await withProbe(id, dataDir, "navigate", `Agent clicking ${selector}`, (s) => s.click(selector));
  r.ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 409, { error: r.error });
}

/** Scroll the live probe page to a Y offset. */
export async function handleSharinganScroll(req: IncomingMessage, res: ServerResponse, id: string, dataDir: string): Promise<void> {
  const body = (await readJsonBody(req)) as { y?: number };
  const y = typeof body.y === "number" ? body.y : 0;
  const r = await withProbe(id, dataDir, "navigate", `Agent scrolling to ${y}`, (s) => s.scroll(y));
  r.ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 409, { error: r.error });
}

export function handleSharinganStatus(res: ServerResponse, id: string): void {
  const c = get(id);
  sendJson(res, 200, { phase: c.phase, steps: c.steps.length, pages: c.pages.map((p) => ({ url: p.url, title: p.title, screenshots: p.screenshots })), error: c.error });
}

/**
 * Serve a captured-page screenshot PNG. `relPath` is PROJECT-DIR-relative (e.g.
 * ".sharingan/home/shot-desktop.png"), matching exactly what `capturePage` stores in
 * `CapturedPage.screenshots` — not `.sharingan`-relative. Still contains reads to
 * `<projectDir>/.sharingan/` (not the whole project dir) so `/shot` can't serve arbitrary
 * project files. Rejects path traversal / escapes (400) and missing files (404).
 */
export function handleSharinganShot(res: ServerResponse, id: string, relPath: string, dataDir: string): void {
  const base = projectDir(dataDir, id);
  const shotRoot = join(base, ".sharingan");
  const abs = safeJoin(base, relPath);
  if (!abs || !(abs === shotRoot || abs.startsWith(shotRoot + sep))) { sendJson(res, 400, { error: "bad path" }); return; }
  if (!existsSync(abs) || !statSync(abs).isFile()) { sendJson(res, 404, { error: "not found" }); return; }
  res.writeHead(200, { "content-type": "image/png", "cache-control": "no-cache" });
  createReadStream(abs).pipe(res);
}

/**
 * Close every live session in the capture registry (entry captures and probe sessions alike).
 * Called on daemon shutdown so a shutdown/crash can't orphan a headful Chrome holding the
 * persistent-profile lock, which would block the next clone from opening. Best-effort: never
 * throws, so it's safe to call unconditionally from the shutdown path.
 */
export async function closeAllSharinganSessions(): Promise<void> {
  for (const c of captures.values()) {
    if (c.probeTimer) { clearTimeout(c.probeTimer); c.probeTimer = undefined; }
    const s = c.session;
    c.session = undefined;
    if (s) await s.close().catch(() => {});
  }
}

export function handleSharinganEvents(res: ServerResponse, id: string): void {
  const c = get(id);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  for (const s of c.steps) res.write(`data: ${JSON.stringify(s)}\n\n`);
  c.listeners.add(res);
  res.on("close", () => c.listeners.delete(res));
}
