/**
 * Sharingan capture HTTP surface: start a capture, poll its status, or stream its
 * progress via SSE. This owns the in-memory capture registry (per project id) and
 * the session lifecycle (open -> capture -> pause-for-login -> close). Login
 * handling PAUSES (phase "login-required") and never bypasses auth.
 */

import { join } from "node:path";
import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SharinganSession } from "./sharingan-browser.ts";
import { capturePage, type CaptureStep, type CapturedPage } from "./sharingan-capture.ts";
import { projectDir } from "./serve-static.ts";
import { sendJson, readJsonBody } from "./http-util.ts";

type Phase = "idle" | "capturing" | "login-required" | "captured" | "error";
interface Capture { phase: Phase; steps: CaptureStep[]; pages: CapturedPage[]; session?: SharinganSession; listeners: Set<ServerResponse>; url?: string; error?: string }

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

export async function startCapture(
  id: string,
  url: string,
  dataDir: string,
  profileDir: string,
  open: (url: string, opts: { userDataDir?: string; headless?: boolean }) => Promise<SharinganSession> = SharinganSession.open,
): Promise<void> {
  const c = get(id);
  // Refuse re-entry whenever a session is live: "capturing" (guards concurrent starts,
  // including the open() await window) and "login-required" (a headful browser is paused
  // open for user sign-in — re-opening would orphan it and its persistent-profile lock).
  if (c.phase === "capturing" || c.phase === "login-required") return;
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

export function handleSharinganStatus(res: ServerResponse, id: string): void {
  const c = get(id);
  sendJson(res, 200, { phase: c.phase, steps: c.steps.length, pages: c.pages.map((p) => ({ url: p.url, title: p.title, screenshots: p.screenshots })), error: c.error });
}

/** Serve a captured-page screenshot PNG from `<projectDir>/.sharingan/<relPath>`. Rejects path traversal (400) and missing files (404). */
export function handleSharinganShot(res: ServerResponse, id: string, relPath: string, dataDir: string): void {
  const rel = relPath.replace(/^[/\\]+/, "");
  if (rel.includes("..") || rel.includes("\0")) { sendJson(res, 400, { error: "bad path" }); return; }
  const abs = join(projectDir(dataDir, id), ".sharingan", rel);
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
