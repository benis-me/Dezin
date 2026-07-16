/**
 * Screenshot a self-contained prototype HTML into a PNG cover.
 *
 * When running inside the Electron desktop app (DEZIN_ELECTRON + an IPC channel), the
 * capture is delegated to Electron's own Chromium via a hidden window — no external
 * Chrome, no puppeteer process. Otherwise (dev/headless) it falls back to the system
 * Chrome via puppeteer-core. Best-effort failures return false; explicit cancellation rejects
 * with AbortError so the owning Run can stop promptly.
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import puppeteer, {
  type BrowserContext,
  type CDPSession,
  type Frame,
  type Page,
  type Protocol,
} from "puppeteer-core";

const CHROME_PATHS = [
  process.env.DEZIN_CHROME ?? "",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
];

export const COVER_CAPTURE_SETTLE_MS = 2500;
export const CAPTURE_LAUNCH_TIMEOUT_MS = 30_000;
export const CAPTURE_PROTOCOL_TIMEOUT_MS = 15_000;
export const CAPTURE_OPERATION_TIMEOUT_MS = 50_000;
export const ARTIFACT_FRAME_APPLY_TIMEOUT_MS = 2_000;
const CAPTURE_CLOSE_TIMEOUT_MS = 1_000;
const ARTIFACT_FRAME_REJECTION_REASONS = [
  "invalid-frame",
  "render-frame-unavailable",
  "invalid-frame-id",
  "invalid-initial-state",
  "invalid-fixture",
  "unsafe-background",
  "frame-too-large",
  "frame-event-unavailable",
] as const;

export type CaptureNetworkPolicy = "http-preview" | "file-cover";

function loopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function captureRequestAllowed(
  targetUrl: string,
  requestUrl: string,
  policy: CaptureNetworkPolicy,
): boolean {
  let target: URL;
  let request: URL;
  try {
    target = new URL(targetUrl);
    request = new URL(requestUrl);
  } catch {
    return false;
  }
  if (policy === "http-preview") {
    if (
      !["http:", "https:"].includes(target.protocol)
      || !loopbackHostname(target.hostname)
      || target.username.length > 0
      || target.password.length > 0
    ) {
      return false;
    }
    if (["data:", "about:"].includes(request.protocol)) return true;
    if (request.protocol === "blob:") return request.origin === target.origin;
    return ["http:", "https:"].includes(request.protocol) && request.origin === target.origin;
  }
  if (target.protocol !== "file:") return false;
  if (["data:", "about:"].includes(request.protocol)) return true;
  if (request.protocol === "blob:") return request.origin === "null";
  return request.protocol === "file:" && request.href === target.href;
}

export async function installCaptureRequestPolicy(
  page: Page,
  targetUrl: string,
  policy: CaptureNetworkPolicy,
  signal?: AbortSignal,
): Promise<void> {
  const installing = page.setRequestInterception(true);
  if (signal) await awaitCaptureStep(installing, signal);
  else await installing;
  page.on("request", (request) => {
    if (captureRequestAllowed(targetUrl, request.url(), policy)) {
      void request.continue().catch(() => {});
    } else {
      void request.abort("blockedbyclient").catch(() => {});
    }
  });
}

function exactCaptureDocument(targetUrl: string, currentUrl: string): boolean {
  try {
    return new URL(currentUrl).href === new URL(targetUrl).href;
  } catch {
    return false;
  }
}

interface CaptureBoundaryMonitor {
  unsafe(): boolean;
  dispose(): void;
}

function installCaptureNavigationBoundary(page: Page, targetUrl: string): CaptureBoundaryMonitor {
  const mainFrame = page.mainFrame();
  let unsafe = false;
  let reachedTarget = false;
  const onFrameNavigated = (frame: Frame): void => {
    if (frame !== mainFrame) return;
    const currentUrl = frame.url();
    if (!reachedTarget && currentUrl === "about:blank") return;
    if (exactCaptureDocument(targetUrl, currentUrl)) {
      reachedTarget = true;
      return;
    }
    unsafe = true;
    void page.close({ runBeforeUnload: false }).catch(() => {});
  };
  page.on("framenavigated", onFrameNavigated);
  return {
    unsafe: () => unsafe || !reachedTarget || !exactCaptureDocument(targetUrl, page.url()),
    dispose: () => page.off("framenavigated", onFrameNavigated),
  };
}

async function installCaptureTargetBoundary(
  context: BrowserContext,
  primarySession: CDPSession,
  signal: AbortSignal,
): Promise<CaptureBoundaryMonitor> {
  const contextId = context.id;
  if (!contextId) throw new Error("capture browser context has no isolation identifier");
  const { targetInfo: primaryTargetInfo } = await awaitCaptureStep(
    primarySession.send("Target.getTargetInfo"),
    signal,
  );
  const browserSession = await awaitCaptureStep(
    context.browser().target().createCDPSession(),
    signal,
  );
  let unsafe = false;
  const pendingClosures = new Set<Promise<void>>();
  const trackClosure = (operation: Promise<void>): void => {
    const tracked = operation.catch(() => {}).finally(() => pendingClosures.delete(tracked));
    pendingClosures.add(tracked);
  };
  const onAttachedTarget = (event: Protocol.Target.AttachedToTargetEvent): void => {
    if (
      event.targetInfo.targetId === primaryTargetInfo.targetId
      || event.targetInfo.browserContextId !== contextId
    ) {
      return;
    }
    trackClosure(browserSession.send("Target.closeTarget", {
      targetId: event.targetInfo.targetId,
    }).then(({ success }) => {
      if (!success) unsafe = true;
    }).catch(() => {
      unsafe = true;
    }));
  };
  browserSession.on("Target.attachedToTarget", onAttachedTarget);
  try {
    await awaitCaptureStep(browserSession.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [
        { type: "page", exclude: false },
        { type: "worker", exclude: false },
        { type: "shared_worker", exclude: false },
        { type: "service_worker", exclude: false },
        { type: "worklet", exclude: false },
        { type: "shared_storage_worklet", exclude: false },
        { type: "auction_worklet", exclude: false },
        { type: "iframe", exclude: false },
        { type: "prerender", exclude: false },
        { type: "portal", exclude: false },
        { type: "webview", exclude: false },
        { exclude: true },
      ],
    }), signal);
  } catch (error) {
    browserSession.off("Target.attachedToTarget", onAttachedTarget);
    await browserSession.detach().catch(() => {});
    throw error;
  }
  return {
    unsafe: () => unsafe,
    dispose() {
      browserSession.off("Target.attachedToTarget", onAttachedTarget);
      for (const closure of pendingClosures) void closure;
      void browserSession.detach().catch(() => {});
    },
  };
}

async function installCaptureExecutionBoundary(page: Page, signal: AbortSignal): Promise<CDPSession> {
  const session = await awaitCaptureStep(page.createCDPSession(), signal);
  try {
    await awaitCaptureStep(page.setBypassServiceWorker(true), signal);
    await awaitCaptureStep(session.send("Network.enable"), signal);
    await awaitCaptureStep(session.send("Network.setBlockedURLs", {
      urls: ["ws://*", "wss://*"],
    }), signal);
    await awaitCaptureStep(page.evaluateOnNewDocument(() => {
      const scope = globalThis as typeof globalThis & Record<string, unknown>;
      const blocked = function BlockedCaptureChannel(): never {
        throw new DOMException("This browser capability is disabled during capture", "SecurityError");
      };
      for (const name of [
        "WebSocket",
        "WebTransport",
        "Worker",
        "SharedWorker",
        "RTCPeerConnection",
        "webkitRTCPeerConnection",
      ]) {
        try {
          Object.defineProperty(scope, name, {
            configurable: false,
            enumerable: false,
            value: blocked,
            writable: false,
          });
        } catch {
          // The target boundary still terminates a channel whose global cannot be replaced.
        }
      }
      try {
        Object.defineProperty(scope, "open", {
          configurable: false,
          value: () => null,
          writable: false,
        });
      } catch {
        // The CDP target boundary remains the fail-closed fallback.
      }
      try {
        const serviceWorker = (navigator as Navigator & { serviceWorker?: object }).serviceWorker;
        if (serviceWorker) {
          const blockedRegistration = () => Promise.reject(
            new DOMException("Service workers are disabled during capture", "SecurityError"),
          );
          const descriptor = {
            configurable: false,
            value: blockedRegistration,
            writable: false,
          };
          Object.defineProperty(serviceWorker, "register", descriptor);
          Object.defineProperty(Object.getPrototypeOf(serviceWorker), "register", descriptor);
        }
      } catch {
        // setBypassServiceWorker and the CDP target boundary remain active.
      }
    }), signal);
    return session;
  } catch (error) {
    await session.detach().catch(() => {});
    throw error;
  }
}

export function captureOperationSignal(signal?: AbortSignal, timeoutMs = CAPTURE_OPERATION_TIMEOUT_MS): AbortSignal {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs >= 60_000) {
    throw new Error("capture operation timeout is invalid");
  }
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

export function captureLaunchOptions(
  executablePath: string,
  signal: AbortSignal,
): NonNullable<Parameters<typeof puppeteer.launch>[0]> {
  return {
    executablePath,
    headless: true,
    args: ["--hide-scrollbars"],
    timeout: CAPTURE_LAUNCH_TIMEOUT_MS,
    protocolTimeout: CAPTURE_PROTOCOL_TIMEOUT_MS,
    signal,
  };
}

interface ClosableBrowser {
  close(): Promise<void>;
  process?(): { kill(signal?: NodeJS.Signals | number): boolean } | null;
}

function captureAbortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException("capture aborted", "AbortError");
}

export function awaitCaptureBrowserLaunch<T extends ClosableBrowser>(
  launch: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const closeLateBrowser = (browser: T): void => { void closeCaptureBrowser(browser).catch(() => {}); };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(captureAbortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    launch.then((browser) => {
      if (settled) {
        closeLateBrowser(browser);
        return;
      }
      settled = true;
      cleanup();
      resolve(browser);
    }, (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    if (signal.aborted) onAbort();
  });
}

export async function launchCaptureBrowserWithRetry<T extends ClosableBrowser>(
  launch: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    signal.throwIfAborted();
    try {
      return await awaitCaptureBrowserLaunch(Promise.resolve().then(launch), signal);
    } catch (error) {
      if (signal.aborted) throw captureAbortReason(signal);
      failure = error;
    }
  }
  throw failure instanceof Error ? failure : new Error("Chromium capture launch failed");
}

export interface CaptureViewport {
  width: number;
  height: number;
}

export interface ArtifactRenderFrameCommand {
  frameId: string;
  frameAttemptId?: string;
  initialState?: string;
  fixture?: unknown;
  background?: string;
}

export interface ArtifactThumbnailCaptureFrame extends CaptureViewport, ArtifactRenderFrameCommand {}

export type ArtifactThumbnailCapture = (
  url: string,
  outPath: string,
  frame: ArtifactThumbnailCaptureFrame,
  signal?: AbortSignal,
) => Promise<boolean>;

export function findChrome(): string | null {
  return CHROME_PATHS.find((p) => p && existsSync(p)) ?? null;
}

// ── Electron path (preferred when bundled) ────────────────────────────────────
interface CaptureResultMsg {
  type: "capture-result";
  id: number;
  ok: boolean;
}

interface PendingCapture {
  finish(ok: boolean): void;
}

let ipcSeq = 0;
const pending = new Map<number, PendingCapture>();
let ipcWired = false;

function coverCaptureAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  const error = new Error(reason instanceof Error ? reason.message : "cover capture aborted");
  error.name = "AbortError";
  return error;
}

function sendCaptureIpc(message: { type: "capture"; id: number; htmlPath: string; outPath: string } | { type: "capture-cancel"; id: number }): boolean {
  if (typeof process.send !== "function") return false;
  try {
    process.send(message);
    return true;
  } catch {
    return false;
  }
}

function wireIpc(): void {
  if (ipcWired || typeof process.send !== "function") return;
  ipcWired = true;
  process.on("message", (msg: unknown) => {
    const m = msg as CaptureResultMsg;
    if (m && m.type === "capture-result") pending.get(m.id)?.finish(Boolean(m.ok));
  });
}

export function captureViaElectron(htmlPath: string, outPath: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    if (typeof process.send !== "function") return resolve(false);
    if (signal?.aborted) return reject(coverCaptureAbortError(signal));
    wireIpc();
    const id = ++ipcSeq;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (pending.get(id) === entry) pending.delete(id);
    };
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ok);
    };
    const onAbort = (): void => {
      if (settled || !signal) return;
      settled = true;
      cleanup();
      sendCaptureIpc({ type: "capture-cancel", id });
      reject(coverCaptureAbortError(signal));
    };
    const entry: PendingCapture = { finish };

    pending.set(id, entry);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      if (settled) return;
      sendCaptureIpc({ type: "capture-cancel", id });
      finish(false);
    }, 15000);
    timer.unref?.();
    if (!sendCaptureIpc({ type: "capture", id, htmlPath, outPath })) finish(false);
  });
}

// ── Puppeteer fallback ────────────────────────────────────────────────────────
function checkedViewport(viewport: CaptureViewport): CaptureViewport {
  if (
    !Number.isSafeInteger(viewport.width)
    || !Number.isSafeInteger(viewport.height)
    || viewport.width < 1
    || viewport.height < 1
    || viewport.width > 16_384
    || viewport.height > 16_384
    || viewport.width * viewport.height > 64 * 1024 * 1024
  ) {
    throw new Error("capture viewport dimensions are invalid");
  }
  return { width: viewport.width, height: viewport.height };
}

function awaitCaptureStep<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(captureAbortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then((value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }, (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    if (signal.aborted) onAbort();
  });
}

async function closeCaptureBrowser(
  browser: ClosableBrowser,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let closeFailed = false;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, CAPTURE_CLOSE_TIMEOUT_MS);
  });
  await Promise.race([browser.close().catch(() => { closeFailed = true; }), timeout]);
  clearTimeout(timer);
  if (timedOut || closeFailed) {
    try {
      browser.process?.()?.kill("SIGKILL");
    } catch {
      // The process may already have exited after close rejected.
    }
  }
}

export function artifactPreviewBridgeNonce(targetUrl: string): string {
  let fragment = "";
  try {
    fragment = new URL(targetUrl).hash;
  } catch {
    throw new Error("artifact thumbnail preview URL is invalid");
  }
  const match = /^#dezin-bridge=([a-zA-Z0-9_-]{43})$/.exec(fragment);
  if (!match) throw new Error("artifact thumbnail preview is missing its exact bridge capability");
  return match[1]!;
}

export function artifactFrameRejectionReason(reason: unknown): string {
  return typeof reason === "string"
    && (ARTIFACT_FRAME_REJECTION_REASONS as readonly string[]).includes(reason)
    ? reason
    : "frame rejected";
}

export async function applyArtifactThumbnailFrame(
  page: Page,
  targetUrl: string,
  frame: ArtifactRenderFrameCommand,
  signal: AbortSignal,
): Promise<void> {
  const nonce = artifactPreviewBridgeNonce(targetUrl);
  const result = await awaitCaptureStep(page.evaluate(async (request) => {
    return await new Promise<{ ok: true } | { ok: false; reason: string }>((resolve) => {
      const browser = globalThis as unknown as {
        MessageChannel: new () => {
          port1: {
            onmessage: ((event: { data: unknown }) => void) | null;
            close(): void;
            postMessage(message: unknown): void;
            start(): void;
          };
          port2: unknown;
        };
        clearTimeout(timer: number): void;
        document: { documentElement: { getAttribute(name: string): string | null } };
        postMessage(message: unknown, targetOrigin: string, transfer: unknown[]): void;
        setTimeout(handler: () => void, timeoutMs: number): number;
      };
      const channel = new browser.MessageChannel();
      let settled = false;
      const finish = (value: { ok: true } | { ok: false; reason: string }): void => {
        if (settled) return;
        settled = true;
        browser.clearTimeout(timer);
        channel.port1.onmessage = null;
        channel.port1.close();
        resolve(value);
      };
      const timer = browser.setTimeout(
        () => finish({ ok: false, reason: "frame acknowledgement timed out" }),
        request.timeoutMs,
      );
      channel.port1.onmessage = (event) => {
        const message = event.data as Record<string, unknown> | null;
        if (
          !message
          || message.source !== "dezin"
          || message.protocol !== 1
          || message.nonce !== request.nonce
        ) return;
        if (message.type === "bridge-ready") {
          channel.port1.postMessage({
            source: "dezin-parent",
            type: "set-frame",
            protocol: 1,
            nonce: request.nonce,
            frameId: request.frameId,
            ...(request.frameAttemptId === undefined ? {} : { frameAttemptId: request.frameAttemptId }),
            ...(request.initialState === undefined ? {} : { initialState: request.initialState }),
            ...(request.fixture === undefined ? {} : { fixture: request.fixture }),
            ...(request.background === undefined ? {} : { background: request.background }),
          });
          return;
        }
        if (message.type === "frame-rejected" && message.frameId === request.frameId) {
          finish({
            ok: false,
            reason: typeof message.reason === "string"
              && (request.rejectionReasons as readonly string[]).includes(message.reason)
              ? message.reason
              : "frame rejected",
          });
          return;
        }
        if (message.type === "frame-applied" && message.frameId === request.frameId) {
          const appliedFrameId = browser.document.documentElement.getAttribute("data-dezin-frame-id");
          if (appliedFrameId !== request.frameId) {
            finish({ ok: false, reason: "frame acknowledgement did not update the render document" });
            return;
          }
          finish({ ok: true });
        }
      };
      channel.port1.start();
      browser.postMessage({
        source: "dezin-parent",
        type: "bridge-init",
        protocol: 1,
        nonce: request.nonce,
      }, "*", [channel.port2]);
    });
  }, {
    nonce,
    frameId: frame.frameId,
    ...(frame.frameAttemptId === undefined ? {} : { frameAttemptId: frame.frameAttemptId }),
    ...(frame.initialState === undefined ? {} : { initialState: frame.initialState }),
    ...(frame.fixture === undefined ? {} : { fixture: frame.fixture }),
    ...(frame.background === undefined ? {} : { background: frame.background }),
    rejectionReasons: [...ARTIFACT_FRAME_REJECTION_REASONS],
    timeoutMs: ARTIFACT_FRAME_APPLY_TIMEOUT_MS,
  }), signal);
  if (!result.ok) {
    const reason = result.reason === "frame acknowledgement timed out"
      || result.reason === "frame acknowledgement did not update the render document"
      ? result.reason
      : artifactFrameRejectionReason(result.reason);
    throw new Error(`artifact thumbnail render frame was not applied: ${reason}`);
  }
}

async function attestArtifactThumbnailFrame(
  page: Page,
  frame: Pick<ArtifactThumbnailCaptureFrame, "frameId" | "background">,
  signal: AbortSignal,
): Promise<void> {
  const result = await awaitCaptureStep(page.evaluate((request) => {
    type BrowserStyle = {
      background: string;
      getPropertyPriority(name: string): string;
      getPropertyValue(name: string): string;
      setProperty(name: string, value: string, priority?: string): void;
    };
    type BrowserElement = { remove(): void; style: BrowserStyle };
    const browser = globalThis as unknown as {
      __DEZIN_RENDER_FRAME__?: Record<string, unknown> | null;
      document: {
        body: BrowserElement | null;
        createElement(tagName: string): BrowserElement;
        documentElement: BrowserElement & {
          appendChild(element: BrowserElement): unknown;
          getAttribute(name: string): string | null;
        };
      };
      getComputedStyle(element: BrowserElement): { getPropertyValue(name: string): string };
    };
    const applied = browser.__DEZIN_RENDER_FRAME__;
    if (
      !applied
      || applied.frameId !== request.frameId
      || browser.document.documentElement.getAttribute("data-dezin-frame-id") !== request.frameId
    ) {
      return { ok: false, reason: "render frame identity drifted before capture" } as const;
    }
    const expectsBackground = Object.prototype.hasOwnProperty.call(request, "background");
    if (expectsBackground !== Object.prototype.hasOwnProperty.call(applied, "background")) {
      return { ok: false, reason: "render frame background presence drifted before capture" } as const;
    }
    if (expectsBackground) {
      if (applied.background !== request.background) {
        return { ok: false, reason: "render frame background value drifted before capture" } as const;
      }
      const root = browser.document.documentElement;
      const body = browser.document.body;
      const deterministicStyle = (element: BrowserElement): boolean => {
        const computed = browser.getComputedStyle(element);
        return styleIsDeterministic(element.style)
          && computed.getPropertyValue("transition-property") === "none"
          && computed.getPropertyValue("animation-name") === "none";
      };
      const styleIsDeterministic = (style: BrowserStyle): boolean => (
        style.getPropertyPriority("transition") === "important"
        && style.getPropertyPriority("animation") === "important"
      );
      const backgroundProperties = [
        "background-color",
        "background-image",
        "background-position",
        "background-size",
        "background-repeat",
        "background-attachment",
        "background-origin",
        "background-clip",
      ];
      const expectedBackground = (value: string): { inline: string; values: string[] } => {
        const probe = browser.document.createElement("div");
        probe.style.setProperty("all", "initial", "important");
        probe.style.setProperty("background", value, "important");
        root.appendChild(probe);
        try {
          const computed = browser.getComputedStyle(probe);
          return {
            inline: probe.style.background,
            values: backgroundProperties.map((property) => computed.getPropertyValue(property)),
          };
        } finally {
          probe.remove();
        }
      };
      const computedMatches = (
        element: BrowserElement,
        expected: { inline: string; values: string[] },
      ): boolean => {
        const computed = browser.getComputedStyle(element);
        return backgroundProperties.every((property, index) => (
          computed.getPropertyValue(property) === expected.values[index]
        ));
      };
      const rootExpected = expectedBackground(request.background!);
      const bodyExpected = expectedBackground("transparent");
      if (
        !rootExpected.inline
        || root.style.background !== rootExpected.inline
        || root.style.getPropertyPriority("background") !== "important"
        || !deterministicStyle(root)
        || !computedMatches(root, rootExpected)
        || (body !== null && body.style.background !== bodyExpected.inline)
        || (body !== null && body.style.getPropertyPriority("background") !== "important")
        || (body !== null && !deterministicStyle(body))
        || (body !== null && !computedMatches(body, bodyExpected))
      ) {
        return { ok: false, reason: "render frame background was not painted at capture time" } as const;
      }
      /*
       * The requested background owns the root canvas. The body remains transparent so
       * semi-transparent colors and gradients are not composited twice.
       */
      if (
        root.style.getPropertyValue("transition") === ""
        || root.style.getPropertyValue("animation") === ""
        || (body !== null && body.style.getPropertyValue("transition") === "")
        || (body !== null && body.style.getPropertyValue("animation") === "")
      ) {
        return { ok: false, reason: "render frame motion suppression was not installed" } as const;
      }
    }
    return { ok: true } as const;
  }, {
    frameId: frame.frameId,
    ...(frame.background === undefined ? {} : { background: frame.background }),
  }), signal);
  if (!result.ok) throw new Error(`artifact thumbnail render frame attestation failed: ${result.reason}`);
}

async function captureTargetViaPuppeteer(
  targetUrl: string,
  outPath: string,
  viewport: CaptureViewport,
  policy: CaptureNetworkPolicy,
  signal?: AbortSignal,
  artifactFrame?: Pick<ArtifactThumbnailCaptureFrame, "frameId" | "background">,
): Promise<boolean> {
  const frame = checkedViewport(viewport);
  const executablePath = findChrome();
  if (!executablePath || signal?.aborted || !captureRequestAllowed(targetUrl, targetUrl, policy)) return false;
  const operationSignal = captureOperationSignal(signal);
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  let securitySession: CDPSession | undefined;
  let navigationBoundary: CaptureBoundaryMonitor | undefined;
  let targetBoundary: CaptureBoundaryMonitor | undefined;
  let closing: Promise<void> | undefined;
  const closeBrowser = (): Promise<void> => {
    if (!browser) return Promise.resolve();
    closing ??= closeCaptureBrowser(browser);
    return closing;
  };
  const closeOnAbort = (): void => { void closeBrowser(); };
  operationSignal.addEventListener("abort", closeOnAbort, { once: true });
  try {
    browser = await launchCaptureBrowserWithRetry(
      () => puppeteer.launch(captureLaunchOptions(executablePath, operationSignal)),
      operationSignal,
    );
    operationSignal.throwIfAborted();
    const context = await awaitCaptureStep(browser.createBrowserContext(), operationSignal);
    const page = await awaitCaptureStep(context.newPage(), operationSignal);
    navigationBoundary = installCaptureNavigationBoundary(page, targetUrl);
    securitySession = await installCaptureExecutionBoundary(page, operationSignal);
    targetBoundary = await installCaptureTargetBoundary(
      context,
      securitySession,
      operationSignal,
    );
    await installCaptureRequestPolicy(page, targetUrl, policy, operationSignal);
    await awaitCaptureStep(page.setViewport({ ...frame, deviceScaleFactor: 1 }), operationSignal);
    await awaitCaptureStep(page.goto(targetUrl, { waitUntil: "load", timeout: 12000 }), operationSignal);
    if (navigationBoundary.unsafe() || targetBoundary.unsafe()) {
      throw new Error("capture target escaped its isolated browser boundary");
    }
    if (artifactFrame) {
      await applyArtifactThumbnailFrame(page, targetUrl, artifactFrame, operationSignal);
      operationSignal.throwIfAborted();
      if (navigationBoundary.unsafe() || targetBoundary.unsafe()) {
        throw new Error("capture target escaped its isolated browser boundary");
      }
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(captureAbortReason(operationSignal));
      };
      const timer = setTimeout(() => {
        operationSignal.removeEventListener("abort", onAbort);
        resolve();
      }, COVER_CAPTURE_SETTLE_MS);
      operationSignal.addEventListener("abort", onAbort, { once: true });
      if (operationSignal.aborted) onAbort();
    }); // let fonts, first paint, and intro motion settle
    operationSignal.throwIfAborted();
    if (artifactFrame) {
      await attestArtifactThumbnailFrame(page, artifactFrame, operationSignal);
    }
    if (navigationBoundary.unsafe() || targetBoundary.unsafe()) {
      throw new Error("capture target escaped its isolated browser boundary");
    }
    await awaitCaptureStep(
      page.screenshot({
        path: outPath as `${string}.png`,
        type: "png",
        clip: { x: 0, y: 0, ...frame },
        ...(artifactFrame?.background === undefined ? {} : { omitBackground: true }),
      }),
      operationSignal,
    );
    return true;
  } catch {
    if (signal?.aborted) throw coverCaptureAbortError(signal);
    return false;
  } finally {
    navigationBoundary?.dispose();
    targetBoundary?.dispose();
    await securitySession?.detach().catch(() => {});
    operationSignal.removeEventListener("abort", closeOnAbort);
    await closeBrowser();
  }
}

function captureViaPuppeteer(htmlPath: string, outPath: string, signal?: AbortSignal): Promise<boolean> {
  return captureTargetViaPuppeteer(
    pathToFileURL(htmlPath).href,
    outPath,
    { width: 1280, height: 800 },
    "file-cover",
    signal,
  );
}

export async function captureCover(htmlPath: string, outPath: string, signal?: AbortSignal): Promise<boolean> {
  if (!existsSync(htmlPath) || signal?.aborted) return false;
  if (process.env.DEZIN_ELECTRON && typeof process.send === "function") {
    if (await captureViaElectron(htmlPath, outPath, signal)) return true;
    if (signal?.aborted) return false;
    // fall through to puppeteer if the Electron capture failed
  }
  return captureViaPuppeteer(htmlPath, outPath, signal);
}

export async function captureCoverUrl(url: string, outPath: string, signal?: AbortSignal): Promise<boolean> {
  if (!/^https?:\/\//i.test(url) || signal?.aborted) return false;
  return captureTargetViaPuppeteer(url, outPath, { width: 1280, height: 800 }, "http-preview", signal);
}

export async function captureArtifactThumbnail(
  url: string,
  outPath: string,
  frame: ArtifactThumbnailCaptureFrame,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!/^https?:\/\//i.test(url) || signal?.aborted) return false;
  return captureTargetViaPuppeteer(url, outPath, frame, "http-preview", signal, frame);
}
