/**
 * Sharingan capture HTTP surface: start a capture, poll its status, or stream its
 * progress via SSE. This owns the in-memory capture registry (per project id) and
 * the session lifecycle (open -> capture -> pause-for-login -> close). Login
 * handling PAUSES (phase "login-required") and never bypasses auth.
 */

import { createHash } from "node:crypto";
import { join, sep } from "node:path";
import { createReadStream, existsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SharinganSession, SHARINGAN_PAGE_BUDGET } from "./sharingan-browser.ts";
import { capturePage, captureCurrentPage, writePagesManifest, upsertPage, readCapturedPages, captureUrlKey, type CaptureStep, type CapturedPage } from "./sharingan-capture.ts";
import { projectDir, safeJoin } from "./serve-static.ts";
import { sendJson, readJsonBody } from "./http-util.ts";

type Phase = "idle" | "capturing" | "login-required" | "captured" | "error" | "probing" | "cancelled";
interface Capture {
  generation: number;
  released: boolean;
  phase: Phase;
  steps: CaptureStep[];
  pages: CapturedPage[];
  session?: SharinganSession;
  opening?: Promise<SharinganSession>;
  operations: Set<CaptureOperation>;
  listeners: Set<ServerResponse>;
  url?: string;
  error?: string;
  probeTimer?: ReturnType<typeof setTimeout>;
  keepForProbe?: boolean;
  /** Run-scoped Standard transactions redirect every capture/probe write here. */
  artifactDir?: string;
  profileDir?: string;
  profileCleanup?: { dataDir: string; scope: "capture" | "project" };
}

interface CaptureOperation {
  controller: AbortController;
  promise: Promise<unknown>;
  /** Safe to detach only while an opener has not yielded a session that could write project data. */
  detachIfStuck: boolean;
}

export type SharinganOpen = (
  url: string,
  opts: { userDataDir?: string; headless?: boolean; signal?: AbortSignal },
) => Promise<SharinganSession>;

/** Idle-release window for a lazily-opened (or build-reused) probe session. */
export const SHARINGAN_PROBE_IDLE_MS = 300_000;
export const SHARINGAN_RELEASE_GRACE_MS = 250;
export const SHARINGAN_STEP_LIMIT = 500;

const captures = new Map<string, Capture>();
let nextCaptureGeneration = 1;
const SHARINGAN_RUN_CAPTURE_SEPARATOR = "--run-";

/** Test-only observability for proving read-only status requests do not allocate capture ownership. */
export function sharinganCaptureRegistrySizeForTests(): number {
  return captures.size;
}

function get(id: string): Capture {
  let c = captures.get(id);
  if (!c) {
    c = {
      generation: nextCaptureGeneration++,
      released: false,
      phase: "idle",
      steps: [],
      pages: [],
      listeners: new Set(),
      operations: new Set(),
    };
    captures.set(id, c);
  }
  return c;
}

function captureArtifactDir(id: string, dataDir: string): string {
  return captures.get(id)?.artifactDir ?? projectDir(dataDir, id);
}

function sharinganProfileDir(id: string, dataDir: string): string {
  const owner = sharinganProfileOwnerDir(sharinganProjectCaptureId(id), dataDir);
  const scope = createHash("sha256").update(id).digest("hex");
  return join(owner, scope);
}

function sharinganProjectCaptureId(id: string): string {
  const separator = id.indexOf(SHARINGAN_RUN_CAPTURE_SEPARATOR);
  return separator > 0 ? id.slice(0, separator) : id;
}

function sharinganProfileOwnerDir(projectId: string, dataDir: string): string {
  const owner = createHash("sha256").update(projectId).digest("hex");
  return join(dataDir, ".sharingan-profiles", owner);
}

function isSharinganRunCaptureId(id: string): boolean {
  return id.indexOf(SHARINGAN_RUN_CAPTURE_SEPARATOR) > 0;
}

export async function removeSharinganProfile(id: string, dataDir: string): Promise<void> {
  await rm(sharinganProfileDir(id, dataDir), { recursive: true, force: true });
}

export async function removeSharinganProjectProfiles(projectId: string, dataDir: string): Promise<void> {
  await rm(sharinganProfileOwnerDir(projectId, dataDir), { recursive: true, force: true });
}

function requestProfileCleanup(c: Capture, dataDir: string, scope: "capture" | "project"): void {
  if (!c.profileCleanup || scope === "project") c.profileCleanup = { dataDir, scope };
}

async function cleanupReleasedProfile(id: string, c: Capture, profileDir = c.profileDir): Promise<void> {
  const cleanup = c.profileCleanup;
  if (!cleanup) return;
  const projectId = sharinganProjectCaptureId(id);
  if (cleanup.scope === "project") {
    const anotherOwner = [...captures.entries()].some(
      ([captureId, current]) => current !== c && !current.released && sharinganProjectCaptureId(captureId) === projectId,
    );
    if (anotherOwner) return;
    await removeSharinganProjectProfiles(projectId, cleanup.dataDir);
    return;
  }
  if (!profileDir) profileDir = sharinganProfileDir(id, cleanup.dataDir);
  const current = captures.get(id);
  if (current && current !== c && !current.released && current.profileDir === profileDir) return;
  await rm(profileDir, { recursive: true, force: true });
}

export function sharinganRunCaptureId(projectId: string, runId: string): string {
  return `${projectId}${SHARINGAN_RUN_CAPTURE_SEPARATOR}${runId}`;
}

function isActive(id: string, c: Capture, generation: number): boolean {
  return !c.released && c.generation === generation && captures.get(id) === c;
}

function captureScopeAbortError(): Error {
  const error = new Error("capture scope released");
  error.name = "AbortError";
  return error;
}

function retainCaptureOperation<T>(
  c: Capture,
  start: (signal: AbortSignal, operation: CaptureOperation) => Promise<T>,
): Promise<T> {
  if (c.released) return Promise.reject(new Error("capture scope released"));
  const controller = new AbortController();
  let operation!: CaptureOperation;
  const promise = Promise.resolve().then(() => start(controller.signal, operation));
  operation = { controller, promise, detachIfStuck: false };
  c.operations.add(operation);
  void promise.then(
    () => c.operations.delete(operation),
    () => c.operations.delete(operation),
  );
  return promise;
}

/**
 * Atomically transfer ownership of an established session out of a capture scope. Every path
 * that closes `c.session` must claim it first, so release and an in-flight error cannot both
 * close the same (not necessarily idempotent) browser session.
 */
function claimEstablishedSession(c: Capture, expected?: SharinganSession): SharinganSession | undefined {
  const session = c.session;
  if (!session || (expected && session !== expected)) return undefined;
  c.session = undefined;
  return session;
}

function emit(c: Capture, step: CaptureStep): void {
  if (c.released) return;
  c.steps.push(step);
  if (c.steps.length > SHARINGAN_STEP_LIMIT) c.steps.splice(0, c.steps.length - SHARINGAN_STEP_LIMIT);
  const line = `data: ${JSON.stringify(step)}\n\n`;
  for (const res of c.listeners) res.write(line);
}

function signalAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(signal.reason == null ? "operation aborted" : String(signal.reason));
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signalAbortError(signal);
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signalAbortError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function armProbeIdle(id: string): void {
  const c = get(id);
  if (c.released) return;
  if (c.probeTimer) clearTimeout(c.probeTimer);
  c.probeTimer = setTimeout(() => { void releaseProbeSession(id).catch(() => {}); }, SHARINGAN_PROBE_IDLE_MS);
  c.probeTimer.unref?.();
}

/** Close and clear an idle (or explicitly released) probe session, restoring phase "captured". */
function releaseProbeSession(id: string): Promise<void> {
  const c = captures.get(id);
  if (!c) return Promise.resolve();
  return retainCaptureOperation(c, async () => {
    if (c.probeTimer) { clearTimeout(c.probeTimer); c.probeTimer = undefined; }
    if (c.phase !== "probing") return;
    const s = claimEstablishedSession(c); c.phase = "captured";
    if (s) await s.close().catch(() => {});
  });
}

/**
 * Lazily open (or reuse) the live probe session the build Agent drives to explore + capture
 * key pages. Opens ON `c.url` (the entry sourceUrl) so the session's origin matches the entry
 * capture's origin, which `discoverLinks` filters against. Refuses while the entry capture is
 * mid-flight ("capturing"/"login-required") — those phases mean a headful browser is already
 * live for that id, and opening a second one would orphan it. Every call resets the idle timer.
 */
export function ensureProbeSession(
  id: string,
  dataDir: string,
  open: SharinganOpen = SharinganSession.open,
): Promise<SharinganSession> {
  const c = get(id);
  if (c.phase === "cancelled") throw new Error("capture cancelled; retry before probing");
  if (c.phase === "capturing" || c.phase === "login-required") throw new Error("capture in progress");
  const generation = c.generation;
  return retainCaptureOperation(c, async (signal, operation) => {
    // Seed from the on-disk manifest so re-captures dedup against what's already there (e.g. after a
    // daemon restart, when the in-memory page list is empty but the entry page is on disk).
    if (!c.pages.length) c.pages = readCapturedPages(captureArtifactDir(id, dataDir));
    if (!c.session) {
      if (!c.opening) {
        const profileDir = sharinganProfileDir(id, dataDir);
        c.profileDir = profileDir;
        let opening!: Promise<SharinganSession>;
        opening = open(c.url ?? "about:blank", {
          userDataDir: profileDir,
          headless: process.env.DEZIN_SHARINGAN_HEADLESS === "1",
          signal,
        }).then(async (session) => {
          if (!isActive(id, c, generation)) {
            await session.close().catch(() => {});
            throw new Error("capture scope released");
          }
          c.session = session;
          c.phase = "probing";
          return session;
        }).finally(async () => {
          if (!isActive(id, c, generation)) await cleanupReleasedProfile(id, c, profileDir).catch(() => {});
          if (c.opening === opening) c.opening = undefined;
        });
        c.opening = opening;
      }
      operation.detachIfStuck = true;
      try {
        await c.opening;
      } finally {
        operation.detachIfStuck = false;
      }
    }
    if (!isActive(id, c, generation) || !c.session) throw new Error("capture scope released");
    armProbeIdle(id);
    return c.session;
  });
}

/** Finalize a successful capture: persist the manifest, then either KEEP the session open for the
 *  build Agent to reuse as a probe (phase "probing", idle-released) or close it (phase "captured").
 *  Keeping it open avoids reopening Chrome mid-build and preserves the just-authenticated session. */
async function finishCapturedSession(id: string, dataDir: string, c: Capture, page: CapturedPage | null): Promise<void> {
  if (page) { upsertPage(c.pages, page); writePagesManifest(captureArtifactDir(id, dataDir), c.url ?? page.url, c.pages); }
  if (c.keepForProbe && c.session) {
    c.phase = "probing";
    armProbeIdle(id);
  } else {
    await claimEstablishedSession(c)?.close();
    c.phase = "captured";
  }
}

export function startCapture(
  id: string,
  url: string,
  dataDir: string,
  profileDir: string,
  open: SharinganOpen = SharinganSession.open,
): Promise<void> {
  const c = get(id);
  // Refuse re-entry whenever a session is live: "capturing" (guards concurrent starts,
  // including the open() await window), "login-required" (a headful browser is paused
  // open for user sign-in), and "probing" (a lazily-opened probe session is live) —
  // re-opening in any of these would orphan the existing session and its
  // persistent-profile lock.
  if (c.phase === "capturing" || c.phase === "login-required" || c.phase === "probing") return Promise.resolve();
  // Seed from the on-disk manifest (not []): after a daemon restart the in-memory map is empty, so
  // re-running the entry capture would otherwise clobber pages.json + discard prior probe captures.
  // The entry capture then upserts into this, preserving them.
  c.phase = "capturing"; c.steps = []; c.pages = readCapturedPages(captureArtifactDir(id, dataDir)); c.error = undefined;
  c.profileDir = profileDir;
  const generation = c.generation;
  return retainCaptureOperation(c, async (signal, operation) => {
    let session: SharinganSession | undefined;
    try {
      operation.detachIfStuck = true;
      try {
        session = await open(url, {
          userDataDir: profileDir,
          headless: process.env.DEZIN_SHARINGAN_HEADLESS === "1",
          signal,
        });
      } finally {
        operation.detachIfStuck = false;
      }
      if (!isActive(id, c, generation)) {
        await session.close().catch(() => {});
        await cleanupReleasedProfile(id, c, profileDir).catch(() => {});
        return;
      }
      c.session = session;
      c.url = url;
      const { page, loginRequired } = await capturePage(session, captureArtifactDir(id, dataDir), url, (s) => emit(c, s));
      if (!isActive(id, c, generation)) return;
      if (loginRequired) { c.phase = "login-required"; return; }
      await finishCapturedSession(id, dataDir, c, page);
    } catch (err) {
      // Capture threw after open() launched a browser holding the persistent-profile lock.
      // Close it so it cannot leak (and free the lock), then mark the terminal phase.
      await claimEstablishedSession(c, session)?.close().catch(() => {});
      if (!isActive(id, c, generation)) {
        await cleanupReleasedProfile(id, c, profileDir).catch(() => {});
        return;
      }
      c.error = err instanceof Error ? err.message : "capture failed";
      emit(c, { at: Date.now(), kind: "done", text: `Capture failed: ${c.error}` });
      c.phase = "error";
    }
  });
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
  opts: { signal?: AbortSignal; maxWaitMs?: number; pollMs?: number; keepSessionForProbe?: boolean; artifactDir?: string; open?: SharinganOpen } = {},
): Promise<Phase> {
  throwIfAborted(opts.signal);
  const maxWaitMs = opts.maxWaitMs ?? 300_000;
  const pollMs = opts.pollMs ?? 500;
  const c = get(id);
  if (opts.artifactDir) {
    if (c.artifactDir && c.artifactDir !== opts.artifactDir) throw new Error("capture scope already targets another artifact directory");
    c.artifactDir = opts.artifactDir;
  }
  if (opts.keepSessionForProbe) c.keepForProbe = true;
  if (c.phase === "captured") return c.phase;
  // Kick the entry capture if nothing is in flight (idle, or retry after a prior error).
  if (c.phase === "idle" || c.phase === "error" || c.phase === "cancelled") {
    const profileDir = sharinganProfileDir(id, dataDir);
    void startCapture(id, url, dataDir, profileDir, opts.open);
  }
  // Poll until a terminal phase, waiting through "login-required" (the user signs in via the
  // tab + Continue). Time out (don't hang) so the build proceeds best-effort even if login stalls.
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const phase = get(id).phase;
    // "probing" is a terminal SUCCESS here: the entry capture finished and its session was kept open
    // for the Agent to reuse (keepSessionForProbe). The build can proceed.
    if (phase === "captured" || phase === "error" || phase === "probing" || phase === "cancelled") return phase;
    if (Date.now() >= deadline) return phase;
    await abortableDelay(Math.min(pollMs, Math.max(0, deadline - Date.now())), opts.signal);
  }
}

export async function handleSharinganStart(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  dataDir: string,
  open: SharinganOpen = SharinganSession.open,
  signal?: AbortSignal,
): Promise<void> {
  const body = (await readJsonBody(req, undefined, signal)) as { url?: string };
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) { sendJson(res, 400, { error: "a valid http(s) url is required" }); return; }
  const profileDir = sharinganProfileDir(id, dataDir);
  void startCapture(id, url, dataDir, profileDir, open);
  sendJson(res, 200, { ok: true });
}

/**
 * Resume a capture that paused at a login wall. Re-runs `capturePage` on the SAME,
 * now-authenticated session (the user signed in via the visible Chrome window while
 * phase stayed "login-required"). A no-op unless that exact pause state is present —
 * called with a stale/wrong id, or before/after the pause, it does nothing.
 */
export function continueCapture(id: string, dataDir: string): Promise<void> {
  const c = get(id);
  if (c.phase !== "login-required" || !c.session || !c.url) return Promise.resolve();
  const generation = c.generation;
  const session = c.session;
  const url = c.url;
  c.phase = "capturing";
  return retainCaptureOperation(c, async () => {
    try {
      const { page, loginRequired } = await capturePage(session, captureArtifactDir(id, dataDir), url, (s) => emit(c, s));
      if (!isActive(id, c, generation)) return;
      if (loginRequired) { c.phase = "login-required"; return; }
      await finishCapturedSession(id, dataDir, c, page);
    } catch (err) {
      if (!isActive(id, c, generation)) return;
      await claimEstablishedSession(c, session)?.close().catch(() => {});
      c.error = err instanceof Error ? err.message : "capture failed";
      emit(c, { at: Date.now(), kind: "done", text: `Capture failed: ${c.error}` });
      c.phase = "error";
    }
  });
}

export function handleSharinganContinue(res: ServerResponse, id: string, dataDir: string): void {
  void continueCapture(id, dataDir);
  sendJson(res, 200, { ok: true });
}

export function handleSharinganFocus(res: ServerResponse, id: string): void {
  const c = get(id);
  const focus = retainCaptureOperation(c, async () => {
    await c.session?.bringToFront();
  });
  void focus.catch(() => {});
  sendJson(res, 200, { ok: true });
}

/** Drive the (lazily-opened, idle-released) probe session to a URL. Emits a "navigate" step so the Phase-3 tab shows the Agent's activity. */
export async function handleSharinganNavigate(req: IncomingMessage, res: ServerResponse, id: string, dataDir: string, signal?: AbortSignal): Promise<void> {
  const body = (await readJsonBody(req, undefined, signal)) as { url?: string };
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
export async function handleSharinganCapture(req: IncomingMessage, res: ServerResponse, id: string, dataDir: string, signal?: AbortSignal): Promise<void> {
  const c = get(id);
  const body = (await readJsonBody(req, undefined, signal)) as { url?: string };
  if (c.pages.length >= SHARINGAN_PAGE_BUDGET) {
    // At budget — but re-capturing an ALREADY-captured URL just UPDATES it (upsert), so don't refuse
    // that; only refuse a capture that would grow the bundle past the budget.
    const target = typeof body.url === "string" && /^https?:\/\//i.test(body.url) ? body.url : undefined;
    const isKnown = target ? c.pages.some((p) => captureUrlKey(p.url) === captureUrlKey(target)) : false;
    if (!isKnown) { sendJson(res, 200, { skipped: "budget", budget: SHARINGAN_PAGE_BUDGET }); return; }
  }
  try {
    const session = await ensureProbeSession(id, dataDir);
    if (typeof body.url === "string" && /^https?:\/\//i.test(body.url)) {
      emit(c, { at: Date.now(), kind: "navigate", text: `Agent navigating to ${body.url}` });
      await session.navigate(body.url.trim());
    }
    const page = await captureCurrentPage(session, captureArtifactDir(id, dataDir), session.currentUrl(), (s) => emit(c, s));
    upsertPage(c.pages, page); // dedup by URL — re-capturing the same page updates it, never appends a dup
    writePagesManifest(captureArtifactDir(id, dataDir), c.url ?? page.url, c.pages);
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
export async function handleSharinganClick(req: IncomingMessage, res: ServerResponse, id: string, dataDir: string, signal?: AbortSignal): Promise<void> {
  const body = (await readJsonBody(req, undefined, signal)) as { selector?: string };
  const selector = typeof body.selector === "string" ? body.selector : "";
  if (!selector) { sendJson(res, 400, { error: "selector required" }); return; }
  const r = await withProbe(id, dataDir, "navigate", `Agent clicking ${selector}`, (s) => s.click(selector));
  r.ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 409, { error: r.error });
}

/** Scroll the live probe page to a Y offset. */
export async function handleSharinganScroll(req: IncomingMessage, res: ServerResponse, id: string, dataDir: string, signal?: AbortSignal): Promise<void> {
  const body = (await readJsonBody(req, undefined, signal)) as { y?: number };
  const y = typeof body.y === "number" ? body.y : 0;
  const r = await withProbe(id, dataDir, "navigate", `Agent scrolling to ${y}`, (s) => s.scroll(y));
  r.ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 409, { error: r.error });
}

export function peekSharinganStatus(id: string, dataDir: string): {
  phase: Phase;
  steps: number;
  pages: Array<Pick<CapturedPage, "url" | "title" | "screenshots">>;
  error?: string;
} {
  const c = captures.get(id);
  let phase = c?.phase ?? "idle";
  let pages = c?.pages ?? [];

  // A daemon restart leaves captured evidence on disk without an in-memory owner. Derive the
  // displayed state from that evidence, but do not allocate or mutate capture ownership just
  // because a client is polling status.
  if (phase === "idle" && !c?.session) {
    const persisted = readCapturedPages(captureArtifactDir(id, dataDir));
    if (persisted.length) {
      phase = "captured";
      pages = persisted;
    }
  }

  return {
    phase,
    steps: c?.steps.length ?? 0,
    pages: pages.map((p) => ({ url: p.url, title: p.title, screenshots: p.screenshots })),
    ...(c?.error ? { error: c.error } : {}),
  };
}

export function handleSharinganStatus(res: ServerResponse, id: string, dataDir: string): void {
  sendJson(res, 200, peekSharinganStatus(id, dataDir));
}

/**
 * Serve a captured-page screenshot PNG. `relPath` is PROJECT-DIR-relative (e.g.
 * ".sharingan/home/shot-desktop.png"), matching exactly what `capturePage` stores in
 * `CapturedPage.screenshots` — not `.sharingan`-relative. Still contains reads to
 * `<projectDir>/.sharingan/` (not the whole project dir) so `/shot` can't serve arbitrary
 * project files. Rejects path traversal / escapes (400) and missing files (404).
 */
export function handleSharinganShot(res: ServerResponse, id: string, relPath: string, dataDir: string): void {
  const base = captureArtifactDir(id, dataDir);
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
export async function releaseSharinganProject(
  id: string,
  options: { dataDir?: string; profileCleanup?: "capture" | "project"; deferProfileCleanup?: boolean } = {},
): Promise<void> {
  const c = captures.get(id);
  if (!c) {
    if (options.dataDir && options.profileCleanup && !options.deferProfileCleanup) {
      if (options.profileCleanup === "project") await removeSharinganProjectProfiles(sharinganProjectCaptureId(id), options.dataDir);
      else await removeSharinganProfile(id, options.dataDir);
    }
    return;
  }
  if (options.dataDir && options.profileCleanup) requestProfileCleanup(c, options.dataDir, options.profileCleanup);
  c.released = true;
  c.generation += 1;
  if (c.probeTimer) { clearTimeout(c.probeTimer); c.probeTimer = undefined; }
  for (const listener of c.listeners) {
    try { listener.end(); } catch { /* best-effort */ }
  }
  c.listeners.clear();
  const s = claimEstablishedSession(c);
  const operations = [...c.operations];
  const reason = captureScopeAbortError();
  for (const operation of operations) operation.controller.abort(reason);
  const requiredSettling = Promise.allSettled([
    ...(s ? [Promise.resolve().then(() => s.close())] : []),
    ...operations.filter((operation) => !operation.detachIfStuck).map((operation) => operation.promise),
  ]);
  const detachable = operations.filter((operation) => operation.detachIfStuck);
  let detachDeadline: ReturnType<typeof setTimeout> | undefined;
  const detachableSettling = detachable.length === 0
    ? Promise.resolve()
    : Promise.race([
        Promise.allSettled(detachable.map((operation) => operation.promise)).then(() => {}),
        new Promise<void>((resolve) => {
          detachDeadline = setTimeout(resolve, SHARINGAN_RELEASE_GRACE_MS);
        }),
      ]);
  await Promise.all([requiredSettling, detachableSettling]);
  if (detachDeadline) clearTimeout(detachDeadline);
  const lateSession = claimEstablishedSession(c);
  if (lateSession && lateSession !== s) await lateSession.close().catch(() => {});
  c.steps.length = 0;
  c.pages = [];
  c.error = undefined;
  c.url = undefined;
  c.opening = undefined;
  c.keepForProbe = undefined;
  c.artifactDir = undefined;
  // Removing the registry entry permits a fresh generation for this id. The released `c` remains
  // a tombstone captured by any in-flight opener, whose isActive() check closes a late session.
  if (captures.get(id) === c) captures.delete(id);
  if (c.profileCleanup && !options.deferProfileCleanup) await cleanupReleasedProfile(id, c).catch(() => {});
}

export async function cancelSharinganProject(id: string, dataDir: string): Promise<void> {
  for (;;) {
    await releaseSharinganProject(id, { dataDir, profileCleanup: "capture" });
    if (!captures.has(id)) break;
  }
  const cancelled = get(id);
  cancelled.phase = "cancelled";
}

export async function handleSharinganCancel(res: ServerResponse, id: string, dataDir: string): Promise<void> {
  await cancelSharinganProject(id, dataDir);
  sendJson(res, 200, { ok: true });
}

export async function closeAllSharinganSessions(dataDir?: string): Promise<void> {
  const ids = [...captures.keys()];
  await Promise.allSettled(ids.map((id) => releaseSharinganProject(
    id,
    dataDir && isSharinganRunCaptureId(id) ? { dataDir, profileCleanup: "capture" } : {},
  )));
}

export function handleSharinganEvents(res: ServerResponse, id: string): void {
  const c = get(id);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  for (const s of c.steps) res.write(`data: ${JSON.stringify(s)}\n\n`);
  c.listeners.add(res);
  res.on("close", () => c.listeners.delete(res));
}
