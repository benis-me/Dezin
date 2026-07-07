/**
 * Sharingan capture HTTP surface: start a capture, poll its status, or stream its
 * progress via SSE. This owns the in-memory capture registry (per project id) and
 * the session lifecycle (open -> capture -> pause-for-login -> close). Login
 * handling PAUSES (phase "login-required") and never bypasses auth.
 */

import { join, sep } from "node:path";
import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SharinganSession } from "./sharingan-browser.ts";
import { capturePage, type CaptureStep, type CapturedPage } from "./sharingan-capture.ts";
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
}

/** Idle-release window for a lazily-opened probe session (mirrors the dev-server lifecycle). */
const SHARINGAN_PROBE_IDLE_MS = 120_000;

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
  if (!c.session) {
    const profileDir = join(dataDir, ".sharingan-profile");
    c.session = await open(c.url ?? "about:blank", { userDataDir: profileDir, headless: process.env.DEZIN_SHARINGAN_HEADLESS === "1" });
    c.phase = "probing";
  }
  armProbeIdle(id);
  return c.session;
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
    if (page) c.pages.push(page);
    // Set the terminal phase only after the browser is down, so "captured" implies the
    // persistent-profile lock has been released.
    await session.close();
    c.session = undefined;
    c.phase = "captured";
  } catch (err) {
    // Capture threw after open() launched a browser holding the persistent-profile lock.
    // Close it so it cannot leak (and free the lock), then mark the terminal phase.
    if (c.session) { await c.session.close().catch(() => {}); c.session = undefined; }
    c.error = err instanceof Error ? err.message : "capture failed";
    emit(c, { at: Date.now(), kind: "done", text: `Capture failed: ${c.error}` });
    c.phase = "error";
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
    if (page) c.pages.push(page);
    await c.session.close();
    c.session = undefined;
    c.phase = "captured";
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

export function handleSharinganEvents(res: ServerResponse, id: string): void {
  const c = get(id);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  for (const s of c.steps) res.write(`data: ${JSON.stringify(s)}\n\n`);
  c.listeners.add(res);
  res.on("close", () => c.listeners.delete(res));
}
