import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import * as coverCapture from "../src/capture-cover.ts";
import { injectRuntimeProbe } from "../src/serve-static.ts";

const { COVER_CAPTURE_SETTLE_MS } = coverCapture;
const TEST_BRIDGE_NONCE = "a".repeat(43);

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

function firstPngPixel(bytes: Buffer): readonly [number, number, number, number] {
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  let offset = 8;
  let width = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = payload.readUInt32BE(0);
      bitDepth = payload[8]!;
      colorType = payload[9]!;
    } else if (type === "IDAT") {
      idat.push(payload);
    } else if (type === "IEND") {
      break;
    }
    offset += length + 12;
  }
  assert.ok(width > 0);
  assert.equal(bitDepth, 8);
  assert.ok(colorType === 6 || colorType === 2, `unexpected PNG color type ${colorType}`);
  const channels = colorType === 6 ? 4 : 3;
  const inflated = inflateSync(Buffer.concat(idat));
  assert.ok(inflated.length >= 1 + width * channels);
  const filter = inflated[0]!;
  const row = Buffer.alloc(width * channels);
  for (let index = 0; index < row.length; index += 1) {
    const encoded = inflated[index + 1]!;
    const left = index >= channels ? row[index - channels]! : 0;
    let decoded = encoded;
    if (filter === 1) decoded = encoded + left;
    else if (filter === 2) decoded = encoded;
    else if (filter === 3) decoded = encoded + Math.floor(left / 2);
    else if (filter === 4) decoded = encoded + paeth(left, 0, 0);
    else assert.equal(filter, 0, `unsupported PNG filter ${filter}`);
    row[index] = decoded & 0xff;
  }
  return [row[0]!, row[1]!, row[2]!, colorType === 6 ? row[3]! : 255] as const;
}
const captureViaElectron = (coverCapture as typeof coverCapture & {
  captureViaElectron?: (htmlPath: string, outPath: string, signal?: AbortSignal) => Promise<boolean>;
}).captureViaElectron;
type CapturePolicy = "http-preview" | "file-cover";
type Closable = {
  close(): Promise<void>;
  process?(): { kill(signal?: NodeJS.Signals | number): boolean } | null;
};
const captureSecurity = coverCapture as typeof coverCapture & {
  CAPTURE_OPERATION_TIMEOUT_MS?: number;
  CAPTURE_LAUNCH_TIMEOUT_MS?: number;
  CAPTURE_PROTOCOL_TIMEOUT_MS?: number;
  captureRequestAllowed?: (targetUrl: string, requestUrl: string, policy: CapturePolicy) => boolean;
  captureLaunchOptions?: (executablePath: string, signal: AbortSignal) => {
    args?: string[];
    ignoreDefaultArgs?: boolean | string[];
    timeout?: number;
    protocolTimeout?: number;
    signal?: AbortSignal;
  };
  captureOperationSignal?: (signal?: AbortSignal, timeoutMs?: number) => AbortSignal;
  artifactPreviewBridgeNonce?: (targetUrl: string) => string;
  artifactFrameRejectionReason?: (reason: unknown) => string;
  awaitCaptureBrowserLaunch?: <T extends Closable>(launch: Promise<T>, signal: AbortSignal) => Promise<T>;
  launchCaptureBrowserWithRetry?: <T extends Closable>(
    launch: () => Promise<T>,
    signal: AbortSignal,
  ) => Promise<T>;
  installCaptureRequestPolicy?: (
    page: {
      setRequestInterception(enabled: boolean): Promise<void>;
      on(event: "request", listener: (request: {
        url(): string;
        continue(): Promise<void>;
        abort(reason: "blockedbyclient"): Promise<void>;
      }) => void): void;
    },
    targetUrl: string,
    policy: CapturePolicy,
    signal?: AbortSignal,
  ) => Promise<void>;
};

test("artifact thumbnail capture accepts only an exact preview bridge capability fragment", () => {
  const bridgeNonce = captureSecurity.artifactPreviewBridgeNonce;
  assert.equal(typeof bridgeNonce, "function");
  if (!bridgeNonce) return;
  const exact = `http://127.0.0.1:4173/preview#dezin-bridge=${TEST_BRIDGE_NONCE}`;
  assert.equal(bridgeNonce(exact), TEST_BRIDGE_NONCE);
  for (const invalid of [
    "http://127.0.0.1:4173/preview",
    "http://127.0.0.1:4173/preview#dezin-bridge=short",
    `${exact}&extra=1`,
    `${exact}#dezin-bridge=${TEST_BRIDGE_NONCE}`,
  ]) {
    assert.throws(() => bridgeNonce(invalid), /bridge capability/);
  }
});

test("artifact thumbnail capture does not return attacker-controlled frame rejection text", () => {
  const rejectionReason = captureSecurity.artifactFrameRejectionReason;
  assert.equal(typeof rejectionReason, "function");
  if (!rejectionReason) return;
  assert.equal(rejectionReason("unsafe-background"), "unsafe-background");
  assert.equal(rejectionReason("x".repeat(1_000_000)), "frame rejected");
  assert.equal(rejectionReason({ toString: () => "unsafe-background" }), "frame rejected");
});

test("cover capture waits long enough after page load for intro animations to settle", () => {
  assert.ok(COVER_CAPTURE_SETTLE_MS >= 2500);
});

test("Electron cover IPC removes abort listeners and sends an exact-id cancel on abort", async () => {
  assert.equal(typeof captureViaElectron, "function", "the Electron IPC boundary must be directly testable");
  if (!captureViaElectron) return;

  const descriptor = Object.getOwnPropertyDescriptor(process, "send");
  const sent: Array<{ type?: string; id?: number }> = [];
  Object.defineProperty(process, "send", {
    configurable: true,
    writable: true,
    value: (message: { type?: string; id?: number }) => {
      sent.push(message);
      return true;
    },
  });

  try {
    const completedController = new AbortController();
    const completed = captureViaElectron("/tmp/completed.html", "/tmp/completed.png", completedController.signal);
    const completedRequest = sent.find((message) => message.type === "capture");
    assert.ok(completedRequest?.id);
    process.emit("message", { type: "capture-result", id: completedRequest.id, ok: true });
    assert.equal(await completed, true);

    completedController.abort();
    await Promise.resolve();
    assert.equal(
      sent.some((message) => message.type === "capture-cancel" && message.id === completedRequest.id),
      false,
      "a settled request must have removed its AbortSignal listener",
    );

    const abortedController = new AbortController();
    const aborted = captureViaElectron("/tmp/aborted.html", "/tmp/aborted.png", abortedController.signal);
    const captureRequests = sent.filter((message) => message.type === "capture");
    const abortedRequest = captureRequests.at(-1);
    assert.ok(abortedRequest?.id && abortedRequest.id !== completedRequest.id);

    abortedController.abort();
    await assert.rejects(aborted, (error: unknown) => error instanceof Error && error.name === "AbortError");
    assert.equal(
      sent.filter((message) => message.type === "capture-cancel" && message.id === abortedRequest.id).length,
      1,
      "abort sends exactly one cancel for the matching desktop capture",
    );

    process.emit("message", { type: "capture-result", id: abortedRequest.id, ok: true });
    await Promise.resolve();
  } finally {
    if (descriptor) Object.defineProperty(process, "send", descriptor);
    else Reflect.deleteProperty(process, "send");
  }
});

test("HTTP preview capture allows only the exact loopback lease origin and inert URL schemes", () => {
  const allowed = captureSecurity.captureRequestAllowed;
  assert.equal(typeof allowed, "function");
  if (!allowed) return;
  const target = "http://127.0.0.1:4173/immutable-preview";
  assert.equal(allowed(target, target, "http-preview"), true);
  assert.equal(allowed(target, "http://127.0.0.1:4173/assets/app.js", "http-preview"), true);
  assert.equal(allowed(target, "data:image/png;base64,AA==", "http-preview"), true);
  assert.equal(allowed(target, "blob:http://127.0.0.1:4173/id", "http-preview"), true);
  assert.equal(allowed(target, "blob:https://example.com/id", "http-preview"), false);
  assert.equal(allowed(target, "blob:null/id", "http-preview"), false);
  assert.equal(allowed(target, "about:blank", "http-preview"), true);
  assert.equal(allowed(target, "https://example.com/redirect", "http-preview"), false);
  assert.equal(allowed(target, "http://localhost:4173/alias", "http-preview"), false);
  assert.equal(allowed(target, "http://127.0.0.1:7457/api/projects", "http-preview"), false);
  assert.equal(allowed(target, "http://192.168.1.1/admin", "http-preview"), false);
  assert.equal(allowed("https://example.com/lease", "https://example.com/lease", "http-preview"), false);
});

test("file cover capture permits only its exact file plus inert in-document resources", () => {
  const allowed = captureSecurity.captureRequestAllowed;
  assert.equal(typeof allowed, "function");
  if (!allowed) return;
  const target = "file:///tmp/dezin-cover/index.html";
  assert.equal(allowed(target, target, "file-cover"), true);
  assert.equal(allowed(target, "data:text/css,body{}", "file-cover"), true);
  assert.equal(allowed(target, "blob:null/local-id", "file-cover"), true);
  assert.equal(allowed(target, "blob:https://example.com/foreign-id", "file-cover"), false);
  assert.equal(allowed(target, "file:///tmp/dezin-cover/secret.txt", "file-cover"), false);
  assert.equal(allowed(target, "https://example.com/pixel", "file-cover"), false);
});

test("capture request policy is installed before navigation and blocks disallowed requests", async () => {
  const install = captureSecurity.installCaptureRequestPolicy;
  assert.equal(typeof install, "function");
  if (!install) return;
  let interception = false;
  let listener: ((request: {
    url(): string;
    continue(): Promise<void>;
    abort(reason: "blockedbyclient"): Promise<void>;
  }) => void) | undefined;
  const page = {
    async setRequestInterception(enabled: boolean) { interception = enabled; },
    on(event: "request", value: typeof listener) {
      assert.equal(event, "request");
      listener = value;
    },
  };
  await install(page, "http://127.0.0.1:4173/preview", "http-preview");
  assert.equal(interception, true);
  assert.ok(listener);
  let continued = 0;
  let blocked = 0;
  listener({
    url: () => "http://127.0.0.1:4173/app.js",
    continue: async () => { continued += 1; },
    abort: async () => { blocked += 1; },
  });
  listener({
    url: () => "https://example.com/tracker.js",
    continue: async () => { continued += 1; },
    abort: async () => { blocked += 1; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(continued, 1);
  assert.equal(blocked, 1);
});

test("capture request policy installation is interrupted by the operation deadline", async () => {
  const install = captureSecurity.installCaptureRequestPolicy;
  assert.equal(typeof install, "function");
  if (!install) return;
  const controller = new AbortController();
  const never = new Promise<void>(() => {});
  const pending = install({
    setRequestInterception: () => never,
    on() {},
  }, "http://127.0.0.1:4173/preview", "http-preview", controller.signal);
  controller.abort(new DOMException("capture deadline", "AbortError"));
  await assert.rejects(
    Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("policy install ignored abort")), 50)),
    ]),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("Chromium launch keeps the sandbox and has explicit bounded timeouts and cancellation", async () => {
  const launchOptions = captureSecurity.captureLaunchOptions;
  const operationSignal = captureSecurity.captureOperationSignal;
  assert.equal(typeof launchOptions, "function");
  assert.equal(typeof operationSignal, "function");
  const launchTimeoutMs = captureSecurity.CAPTURE_LAUNCH_TIMEOUT_MS ?? 0;
  const operationTimeoutMs = captureSecurity.CAPTURE_OPERATION_TIMEOUT_MS ?? Infinity;
  assert.ok(launchTimeoutMs >= 30_000, "cold Chromium starts retain a bounded contention margin");
  assert.ok((captureSecurity.CAPTURE_PROTOCOL_TIMEOUT_MS ?? Infinity) > 0);
  assert.ok(operationTimeoutMs < 60_000);
  assert.ok(
    operationTimeoutMs >= launchTimeoutMs + 20_000,
    "the operation deadline leaves bounded time for navigation, frame apply, settling, and screenshot after launch",
  );
  if (!launchOptions || !operationSignal) return;

  const controller = new AbortController();
  const signal = operationSignal(controller.signal, 20);
  const options = launchOptions("/Applications/Google Chrome", signal);
  assert.equal(options.signal, signal);
  assert.equal(options.ignoreDefaultArgs, undefined, "capture uses Puppeteer's default popup policy unchanged");
  assert.equal(options.args?.includes("--no-sandbox"), false);
  assert.ok((options.timeout ?? Infinity) > 0 && (options.timeout ?? Infinity) < 60_000);
  assert.ok((options.protocolTimeout ?? Infinity) > 0 && (options.protocolTimeout ?? Infinity) < 60_000);
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  assert.equal(signal.aborted, true, "the whole capture operation has a hard deadline");
});

test("aborting during Chromium launch rejects promptly and closes a late browser", async () => {
  const awaitLaunch = captureSecurity.awaitCaptureBrowserLaunch;
  assert.equal(typeof awaitLaunch, "function");
  if (!awaitLaunch) return;
  let resolveLaunch!: (browser: Closable) => void;
  const launch = new Promise<Closable>((resolve) => { resolveLaunch = resolve; });
  let closes = 0;
  const controller = new AbortController();
  const pending = awaitLaunch(launch, controller.signal);
  controller.abort(new DOMException("capture cancelled", "AbortError"));
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  resolveLaunch({ close: async () => { closes += 1; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closes, 1);
});

test("Chromium launch retries one transient process exit inside the same operation deadline", async () => {
  const launchWithRetry = captureSecurity.launchCaptureBrowserWithRetry;
  assert.equal(typeof launchWithRetry, "function");
  if (!launchWithRetry) return;
  const browser: Closable = { close: async () => {} };
  const controller = new AbortController();
  let attempts = 0;
  const launched = await launchWithRetry(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("Chrome exited before DevTools was ready");
    return browser;
  }, controller.signal);
  assert.equal(launched, browser);
  assert.equal(attempts, 2);
});

test("Chromium launch cancellation never retries", async () => {
  const launchWithRetry = captureSecurity.launchCaptureBrowserWithRetry;
  assert.equal(typeof launchWithRetry, "function");
  if (!launchWithRetry) return;
  const controller = new AbortController();
  let attempts = 0;
  await assert.rejects(launchWithRetry(async () => {
    attempts += 1;
    controller.abort(new DOMException("capture cancelled", "AbortError"));
    throw new Error("launch interrupted");
  }, controller.signal), (error: unknown) => error instanceof Error && error.name === "AbortError");
  assert.equal(attempts, 1);
});

test("late Chromium cleanup is bounded and force-kills a browser whose close stalls", async () => {
  const awaitLaunch = captureSecurity.awaitCaptureBrowserLaunch;
  assert.equal(typeof awaitLaunch, "function");
  if (!awaitLaunch) return;
  let resolveLaunch!: (browser: Closable) => void;
  const launch = new Promise<Closable>((resolve) => { resolveLaunch = resolve; });
  let kills = 0;
  const controller = new AbortController();
  const pending = awaitLaunch(launch, controller.signal);
  controller.abort(new DOMException("capture cancelled", "AbortError"));
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  resolveLaunch({
    close: () => new Promise<void>(() => {}),
    process: () => ({
      kill(signal) {
        assert.equal(signal, "SIGKILL");
        kills += 1;
        return true;
      },
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(kills, 1);
});

test("late Chromium cleanup force-kills a browser whose graceful close rejects", async () => {
  const awaitLaunch = captureSecurity.awaitCaptureBrowserLaunch;
  assert.equal(typeof awaitLaunch, "function");
  if (!awaitLaunch) return;
  let resolveLaunch!: (browser: Closable) => void;
  const launch = new Promise<Closable>((resolve) => { resolveLaunch = resolve; });
  let kills = 0;
  const controller = new AbortController();
  const pending = awaitLaunch(launch, controller.signal);
  controller.abort(new DOMException("capture cancelled", "AbortError"));
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  resolveLaunch({
    close: async () => { throw new Error("close failed"); },
    process: () => ({
      kill(signal) {
        assert.equal(signal, "SIGKILL");
        kills += 1;
        return true;
      },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(kills, 1);
});

test("real Chromium capture blocks service-worker, worker, WebSocket, and popup escape channels", async (context) => {
  if (!coverCapture.findChrome()) {
    context.skip("system Chrome is unavailable");
    return;
  }
  const hits = { ran: 0, worker: 0, sharedWorker: 0, serviceWorker: 0, popup: 0, websocket: 0 };
  let port = 0;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://capture.test").pathname;
    if (path === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(injectRuntimeProbe(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:red!important;transition:background 10s linear}</style><body>capture boundary<script>
        try { new Worker('/worker.js'); } catch {}
        try { new SharedWorker('/shared-worker.js'); } catch {}
        try { new WebSocket('ws://127.0.0.1:${port}/socket'); } catch {}
        try { navigator.serviceWorker.register('/sw.js').catch(() => {}); } catch {}
        try {
          ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker, '/sw.js').catch(() => {});
        } catch {}
        try { window.open('/popup', '_blank'); } catch {}
        const popupLink = document.createElement('a');
        popupLink.href = '/popup';
        popupLink.target = '_blank';
        document.body.append(popupLink);
        popupLink.click();
        fetch('/ran').catch(() => {});
      </script></body>`));
      return;
    }
    if (path === "/ran") {
      hits.ran += 1;
      response.statusCode = 204;
      response.end();
      return;
    }
    if (path === "/worker.js") hits.worker += 1;
    else if (path === "/shared-worker.js") hits.sharedWorker += 1;
    else if (path === "/sw.js") {
      hits.serviceWorker += 1;
      response.setHeader("service-worker-allowed", "/");
    } else if (path === "/popup") {
      hits.popup += 1;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<!doctype html><title>popup</title>");
      return;
    }
    response.setHeader("content-type", "text/javascript; charset=utf-8");
    response.end("globalThis.captureEscape = true;");
  });
  server.on("upgrade", (_request, socket) => {
    hits.websocket += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  const root = mkdtempSync(join(tmpdir(), "dezin-capture-boundary-"));
  const outPath = join(root, "capture.png");
  try {
    const captured = await coverCapture.captureArtifactThumbnail(
      `http://127.0.0.1:${port}/#dezin-bridge=${TEST_BRIDGE_NONCE}`,
      outPath,
      { width: 64, height: 64, frameId: "desktop", background: "#123456" },
    );
    assert.equal(captured, true, `capture boundary failed with requests ${JSON.stringify(hits)}`);
    assert.equal(existsSync(outPath), true);
    assert.deepEqual(firstPngPixel(readFileSync(outPath)), [18, 52, 86, 255]);
    assert.ok(hits.ran >= 1, "the document script ran inside real Chromium");
    assert.deepEqual(hits, {
      ran: hits.ran,
      worker: 0,
      sharedWorker: 0,
      serviceWorker: 0,
      popup: 0,
      websocket: 0,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("real Chromium artifact capture preserves alpha and paints the required frame background once", async (context) => {
  if (!coverCapture.findChrome()) {
    context.skip("system Chrome is unavailable");
    return;
  }
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(injectRuntimeProbe(
      "<!doctype html><meta charset=\"utf-8\"><style>html,body{margin:0;background:white!important}</style><body>transparent frame preview</body>",
    ));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const root = mkdtempSync(join(tmpdir(), "dezin-capture-transparent-"));
  const outPath = join(root, "capture.png");
  try {
    assert.equal(await coverCapture.captureArtifactThumbnail(
      `http://127.0.0.1:${port}/#dezin-bridge=${TEST_BRIDGE_NONCE}`,
      outPath,
      { width: 64, height: 64, frameId: "desktop", background: "rgba(18, 52, 86, 0.5)" },
    ), true);
    assert.deepEqual(firstPngPixel(readFileSync(outPath)), [18, 52, 86, 128]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("real Chromium capture rejects same-origin final page URL drift", async (context) => {
  if (!coverCapture.findChrome()) {
    context.skip("system Chrome is unavailable");
    return;
  }
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://capture.test").pathname;
    if (path === "/lease") {
      response.statusCode = 302;
      response.setHeader("location", "/different-preview");
      response.end();
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>wrong preview</title>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const root = mkdtempSync(join(tmpdir(), "dezin-capture-drift-"));
  const outPath = join(root, "capture.png");
  try {
    assert.equal(await coverCapture.captureArtifactThumbnail(
      `http://127.0.0.1:${port}/lease#dezin-bridge=${TEST_BRIDGE_NONCE}`,
      outPath,
      { width: 64, height: 64, frameId: "desktop" },
    ), false);
    assert.equal(existsSync(outPath), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
