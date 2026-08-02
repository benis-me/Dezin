import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, relative, resolve, sep } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import puppeteer, {
  type Browser,
  type BrowserContext,
  type Page,
} from "puppeteer-core";
import type {
  DesignExportManifest,
  DesignFrozenContext,
} from "./design-types.ts";

export const DESIGN_EXPORT_VISUAL_THRESHOLDS = Object.freeze({
  meanAbsoluteError: 0.04,
  changedPixelRatio: 0.12,
  meanSsim: 0.95,
  p05Ssim: 0.6,
  minimumSsim: 0.5,
});

export interface DesignExportVisualMetrics {
  meanAbsoluteError: number;
  changedPixelRatio: number;
  meanSsim: number;
  p05Ssim: number;
  minimumSsim: number;
}

export interface DesignExportScreenshotComparison {
  passed: boolean;
  metrics: DesignExportVisualMetrics;
  diffPng: Buffer;
}

export const DESIGN_EXPORT_VISUAL_PROTOCOL = "dezin-design-export-visual-v1" as const;
export const DESIGN_EXPORT_VISUAL_VIEWPORTS = Object.freeze([
  Object.freeze({ name: "desktop", width: 1280, height: 800 }),
  Object.freeze({ name: "mobile", width: 390, height: 844 }),
] as const);

const MAX_VISUAL_CASES = 128;
const MAX_VISUAL_EVIDENCE_BYTES = 64 * 1024 * 1024;
const SAFE_EVIDENCE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NAVIGATION_TIMEOUT_MS = 12_000;
const SETTLE_TIMEOUT_MS = 8_000;
const SESSION_CLOSE_TIMEOUT_MS = 5_000;
const DESIGN_EXPORT_CHROME_PATHS = [
  process.env.DEZIN_CHROME ?? "",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
];
const OUTPUT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export interface DesignExportVisualCaptureInput {
  sourceUrl: string;
  outputUrl: string;
  nodeId: string;
  viewport: (typeof DESIGN_EXPORT_VISUAL_VIEWPORTS)[number];
  signal: AbortSignal;
}

export interface DesignExportVisualCapture {
  sourcePng: Buffer;
  outputPng: Buffer;
  markerNodeIds: string[];
  markerVisible: boolean;
  blockedRequests: string[];
}

export interface DesignExportVisualCaptureSession {
  browserVersion: string;
  outputOrigin: string;
  capture(input: DesignExportVisualCaptureInput): Promise<DesignExportVisualCapture>;
  close(): Promise<void>;
}

export interface DesignExportVisualGateInput {
  stagingDir: string;
  exportId: string;
  sourcePreviewOrigin: string;
  context: DesignFrozenContext;
  signal: AbortSignal;
}

export interface DesignExportVisualGateResult {
  visualValidation: DesignExportManifest["visualValidation"];
  receiptChecksum: string;
}

export type DesignExportVisualGateRunner = (
  input: DesignExportVisualGateInput,
) => Promise<DesignExportVisualGateResult>;

interface DesignExportVisualGateDependencies {
  openCaptureSession?: (input: {
    distDir: string;
    sourcePreviewOrigin: string;
    signal: AbortSignal;
  }) => Promise<DesignExportVisualCaptureSession>;
  now?: () => number;
}

interface DecodedPng {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

async function decodePng(bytes: Buffer): Promise<DecodedPng> {
  const image = await loadImage(bytes);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return {
    width: image.width,
    height: image.height,
    pixels: context.getImageData(0, 0, image.width, image.height).data,
  };
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function luminance(red: number, green: number, blue: number): number {
  return (red * 0.2126) + (green * 0.7152) + (blue * 0.0722);
}

function tileSsim(
  source: Uint8ClampedArray,
  output: Uint8ClampedArray,
  width: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): number {
  let count = 0;
  let sourceMean = 0;
  let outputMean = 0;
  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const index = ((y * width) + x) * 4;
      sourceMean += luminance(source[index]!, source[index + 1]!, source[index + 2]!);
      outputMean += luminance(output[index]!, output[index + 1]!, output[index + 2]!);
      count += 1;
    }
  }
  sourceMean /= count;
  outputMean /= count;
  let sourceVariance = 0;
  let outputVariance = 0;
  let covariance = 0;
  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const index = ((y * width) + x) * 4;
      const sourceDelta = luminance(source[index]!, source[index + 1]!, source[index + 2]!) - sourceMean;
      const outputDelta = luminance(output[index]!, output[index + 1]!, output[index + 2]!) - outputMean;
      sourceVariance += sourceDelta * sourceDelta;
      outputVariance += outputDelta * outputDelta;
      covariance += sourceDelta * outputDelta;
    }
  }
  const divisor = Math.max(1, count - 1);
  sourceVariance /= divisor;
  outputVariance /= divisor;
  covariance /= divisor;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const numerator = ((2 * sourceMean * outputMean) + c1) * ((2 * covariance) + c2);
  const denominator = ((sourceMean ** 2) + (outputMean ** 2) + c1)
    * (sourceVariance + outputVariance + c2);
  return Math.max(-1, Math.min(1, denominator === 0 ? 1 : numerator / denominator));
}

export async function compareDesignExportScreenshots(
  sourcePng: Buffer,
  outputPng: Buffer,
): Promise<DesignExportScreenshotComparison> {
  const [source, output] = await Promise.all([decodePng(sourcePng), decodePng(outputPng)]);
  if (source.width !== output.width || source.height !== output.height) {
    throw new Error(`Visual screenshots differ in dimensions: ${source.width}x${source.height} vs ${output.width}x${output.height}`);
  }
  const pixels = source.width * source.height;
  let absoluteError = 0;
  let changedPixels = 0;
  const diffCanvas = createCanvas(source.width, source.height);
  const diffContext = diffCanvas.getContext("2d");
  const diff = diffContext.createImageData(source.width, source.height);
  for (let index = 0; index < source.pixels.length; index += 4) {
    const red = Math.abs(source.pixels[index]! - output.pixels[index]!);
    const green = Math.abs(source.pixels[index + 1]! - output.pixels[index + 1]!);
    const blue = Math.abs(source.pixels[index + 2]! - output.pixels[index + 2]!);
    absoluteError += red + green + blue;
    if (Math.max(red, green, blue) >= 24) changedPixels += 1;
    const amplified = Math.min(255, Math.max(red, green, blue) * 4);
    diff.data[index] = amplified;
    diff.data[index + 1] = Math.round(amplified * 0.18);
    diff.data[index + 2] = Math.round(amplified * 0.32);
    diff.data[index + 3] = 255;
  }
  diffContext.putImageData(diff, 0, 0);

  const tileScores: number[] = [];
  const tileSize = 32;
  for (let y = 0; y < source.height; y += tileSize) {
    for (let x = 0; x < source.width; x += tileSize) {
      tileScores.push(tileSsim(
        source.pixels,
        output.pixels,
        source.width,
        x,
        y,
        Math.min(source.width, x + tileSize),
        Math.min(source.height, y + tileSize),
      ));
    }
  }
  tileScores.sort((left, right) => left - right);
  const meanSsim = tileScores.reduce((sum, score) => sum + score, 0) / tileScores.length;
  const p05Index = Math.min(tileScores.length - 1, Math.floor(tileScores.length * 0.05));
  const metrics = {
    meanAbsoluteError: rounded(absoluteError / (pixels * 3 * 255)),
    changedPixelRatio: rounded(changedPixels / pixels),
    meanSsim: rounded(meanSsim),
    p05Ssim: rounded(tileScores[p05Index]!),
    minimumSsim: rounded(tileScores[0]!),
  };
  return {
    passed: metrics.meanAbsoluteError <= DESIGN_EXPORT_VISUAL_THRESHOLDS.meanAbsoluteError
      && metrics.changedPixelRatio <= DESIGN_EXPORT_VISUAL_THRESHOLDS.changedPixelRatio
      && metrics.meanSsim >= DESIGN_EXPORT_VISUAL_THRESHOLDS.meanSsim
      && metrics.p05Ssim >= DESIGN_EXPORT_VISUAL_THRESHOLDS.p05Ssim
      && metrics.minimumSsim >= DESIGN_EXPORT_VISUAL_THRESHOLDS.minimumSsim,
    metrics,
    diffPng: diffCanvas.toBuffer("image/png"),
  };
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("Design Export source preview origin is invalid");
  }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password
    || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.origin !== value) {
    throw new TypeError("Design Export source preview origin must be an exact trusted HTTP origin");
  }
  return parsed.origin;
}

async function writeEvidenceFile(
  validationRoot: string,
  relativePath: string,
  bytes: Buffer,
): Promise<{ path: string; checksum: string; bytes: number }> {
  const absolutePath = join(validationRoot, ...relativePath.split("/"));
  await mkdir(join(absolutePath, ".."), { recursive: true, mode: 0o700 });
  await writeFile(absolutePath, bytes, { flag: "wx", mode: 0o400 });
  return {
    path: `validation/visual/${relativePath}`,
    checksum: sha256(bytes),
    bytes: bytes.length,
  };
}

function metricsSummary(metrics: DesignExportVisualMetrics): string {
  return `MAE ${metrics.meanAbsoluteError.toFixed(4)}, changed ${(metrics.changedPixelRatio * 100).toFixed(2)}%, SSIM ${metrics.meanSsim.toFixed(4)}, p05 ${metrics.p05Ssim.toFixed(4)}, min ${metrics.minimumSsim.toFixed(4)}`;
}

export class DesignExportVisualGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignExportVisualGateError";
  }
}

export async function runDesignExportVisualGate(
  input: DesignExportVisualGateInput,
  dependencies: DesignExportVisualGateDependencies = {},
): Promise<DesignExportVisualGateResult> {
  input.signal.throwIfAborted();
  const sourcePreviewOrigin = exactOrigin(input.sourcePreviewOrigin);
  const generativeNodes = input.context.nodes.filter((node) => node.selectedVersionId !== null
    && node.selectedVersionChecksum !== null
    && ["component", "page", "design-system", "research", "design-tokens", "design-document", "layout", "knowledge"].includes(node.kind));
  const caseCount = generativeNodes.length * DESIGN_EXPORT_VISUAL_VIEWPORTS.length;
  if (generativeNodes.length === 0 || caseCount > MAX_VISUAL_CASES) {
    throw new DesignExportVisualGateError(`Visual gate requires 1-${MAX_VISUAL_CASES / DESIGN_EXPORT_VISUAL_VIEWPORTS.length} selected generative Nodes`);
  }
  const unsafeNode = generativeNodes.find((node) => !SAFE_EVIDENCE_SEGMENT.test(node.id)
    || !SAFE_EVIDENCE_SEGMENT.test(node.selectedVersionId!));
  if (unsafeNode) throw new DesignExportVisualGateError(`Visual gate received an unsafe Node or Version identity: ${unsafeNode.id}`);

  const validationRoot = join(input.stagingDir, "validation", "visual");
  await rm(validationRoot, { recursive: true, force: true });
  await mkdir(validationRoot, { recursive: true, mode: 0o700 });
  let session: DesignExportVisualCaptureSession | undefined;
  try {
    try {
      const openCaptureSession = dependencies.openCaptureSession ?? openPuppeteerCaptureSession;
      session = await openCaptureSession({
        distDir: join(input.stagingDir, "dist"),
        sourcePreviewOrigin,
        signal: input.signal,
      });
      const cases: Array<Record<string, unknown>> = [];
      let evidenceBytes = 0;
      for (const node of generativeNodes) {
        for (const viewport of DESIGN_EXPORT_VISUAL_VIEWPORTS) {
          input.signal.throwIfAborted();
          const sourcePath = `/api/projects/${encodeURIComponent(input.context.projectId)}/design-canvas/nodes/${encodeURIComponent(node.id)}/versions/${encodeURIComponent(node.selectedVersionId!)}/preview/`;
          const outputRoute = `/?dezin-node=${encodeURIComponent(node.id)}`;
          let captured: DesignExportVisualCapture;
          try {
            captured = await session.capture({
              sourceUrl: `${sourcePreviewOrigin}${sourcePath}`,
              outputUrl: `${session.outputOrigin}${outputRoute}`,
              nodeId: node.id,
              viewport,
              signal: input.signal,
            });
          } catch (error) {
            if (input.signal.aborted) throw error;
            const detail = error instanceof Error ? error.message : String(error);
            throw new DesignExportVisualGateError(`Visual gate failed for ${node.name} (${node.id}) at ${viewport.name} ${viewport.width}x${viewport.height}: ${detail}`);
          }
          if (captured.blockedRequests.length > 0) {
            throw new DesignExportVisualGateError(`Visual gate failed for ${node.name} (${node.id}) at ${viewport.name} ${viewport.width}x${viewport.height}: blocked external request ${captured.blockedRequests[0]}`);
          }
          if (captured.markerNodeIds.length !== 1 || captured.markerNodeIds[0] !== node.id || !captured.markerVisible) {
            throw new DesignExportVisualGateError(`Visual gate failed for ${node.name} (${node.id}) at ${viewport.name} ${viewport.width}x${viewport.height}: expected exactly one visible data-dezin-export-node-id marker for ${node.id}`);
          }
          const comparison = await compareDesignExportScreenshots(captured.sourcePng, captured.outputPng);
          if (!comparison.passed) {
            throw new DesignExportVisualGateError(`Visual gate failed for ${node.name} (${node.id}) at ${viewport.name} ${viewport.width}x${viewport.height}: ${metricsSummary(comparison.metrics)}`);
          }
          const prefix = `${node.id}/${viewport.name}`;
          const [sourceEvidence, outputEvidence, diffEvidence] = await Promise.all([
            writeEvidenceFile(validationRoot, `${prefix}-source.png`, captured.sourcePng),
            writeEvidenceFile(validationRoot, `${prefix}-output.png`, captured.outputPng),
            writeEvidenceFile(validationRoot, `${prefix}-diff.png`, comparison.diffPng),
          ]);
          evidenceBytes += sourceEvidence.bytes + outputEvidence.bytes + diffEvidence.bytes;
          if (evidenceBytes > MAX_VISUAL_EVIDENCE_BYTES) {
            throw new DesignExportVisualGateError(`Visual gate evidence exceeds ${MAX_VISUAL_EVIDENCE_BYTES} bytes`);
          }
          cases.push({
            nodeId: node.id,
            nodeName: node.name,
            nodeKind: node.kind,
            versionId: node.selectedVersionId,
            versionChecksum: node.selectedVersionChecksum,
            sourcePath,
            outputRoute,
            viewport,
            metrics: comparison.metrics,
            passed: true,
            evidence: { source: sourceEvidence, output: outputEvidence, diff: diffEvidence },
          });
        }
      }
      input.signal.throwIfAborted();
      const receipt = {
        schemaVersion: 1,
        protocol: DESIGN_EXPORT_VISUAL_PROTOCOL,
        projectId: input.context.projectId,
        exportId: input.exportId,
        canvasRevision: input.context.canvasRevision,
        contextHash: input.context.checksum,
        browserVersion: session.browserVersion,
        capturePolicy: {
          deviceScaleFactor: 1,
          colorScheme: "light",
          reducedMotion: true,
          locale: "en-US",
          timezone: "UTC",
          network: "phase-isolated-source-preview-or-export-loopback-only",
          viewports: DESIGN_EXPORT_VISUAL_VIEWPORTS,
        },
        thresholds: DESIGN_EXPORT_VISUAL_THRESHOLDS,
        cases,
        passed: true,
        createdAt: (dependencies.now ?? Date.now)(),
      };
      const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
      const receiptPath = "validation/visual/receipt.json";
      await writeFile(join(input.stagingDir, receiptPath), receiptBytes, { flag: "wx", mode: 0o400 });
      const receiptChecksum = sha256(await readFile(join(input.stagingDir, receiptPath)));
      return {
        visualValidation: {
          protocol: DESIGN_EXPORT_VISUAL_PROTOCOL,
          receiptPath,
          receiptChecksum,
          caseCount,
          passed: true,
        },
        receiptChecksum,
      };
    } finally {
      await session?.close();
    }
  } catch (error) {
    await rm(validationRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export function findDesignExportChrome(): string | null {
  return DESIGN_EXPORT_CHROME_PATHS.find((path) => path.length > 0 && existsSync(path)) ?? null;
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException("Design Export visual gate aborted", "AbortError");
}

function timeoutError(label: string, timeoutMs: number): Error {
  const error = new Error(`${label} timed out after ${timeoutMs}ms`);
  error.name = "TimeoutError";
  return error;
}

function boundedOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolveValue, rejectValue) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => rejectValue(abortReason(signal)));
    const timer = setTimeout(() => finish(() => rejectValue(timeoutError(label, timeoutMs))), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolveValue(value)),
      (error) => finish(() => rejectValue(error)),
    );
    if (signal.aborted) onAbort();
  });
}

function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
});

interface OutputServer {
  origin: string;
  close(): Promise<void>;
}

async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
    server.closeAllConnections();
  });
}

async function openOutputServer(distDir: string, signal: AbortSignal): Promise<OutputServer> {
  signal.throwIfAborted();
  const rootInfo = await lstat(distDir);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Design Export dist output is not a regular directory");
  }
  const root = await realpath(distDir);
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { allow: "GET, HEAD" }).end();
        return;
      }
      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
      } catch {
        response.writeHead(400).end();
        return;
      }
      const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const path = resolve(root, requested);
      if (!isInside(root, path)) {
        response.writeHead(403).end();
        return;
      }
      let bytes: Buffer;
      try {
        const canonical = await realpath(path);
        if (!isInside(root, canonical)) throw new Error("path escaped dist");
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("not a regular file");
        bytes = await readFile(canonical);
      } catch {
        response.writeHead(404, { "cache-control": "no-store" }).end();
        return;
      }
      response.writeHead(200, {
        "content-type": MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
        "content-length": String(bytes.length),
        "cache-control": "no-store",
        "content-security-policy": OUTPUT_CSP,
        "x-content-type-options": "nosniff",
        "x-dns-prefetch-control": "off",
        "referrer-policy": "no-referrer",
      });
      response.end(request.method === "HEAD" ? undefined : bytes);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  const onAbort = (): void => { void closeHttpServer(server); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await boundedOperation(new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", rejectListen);
        resolveListen();
      });
    }), signal, 5_000, "Design Export output server startup");
    const { port } = server.address() as AddressInfo;
    return {
      origin: `http://127.0.0.1:${port}`,
      async close() {
        signal.removeEventListener("abort", onAbort);
        await closeHttpServer(server);
      },
    };
  } catch (error) {
    signal.removeEventListener("abort", onAbort);
    await closeHttpServer(server).catch(() => {});
    throw error;
  }
}

function safeRequestLabel(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.slice(0, 512);
  } catch {
    return value.slice(0, 512);
  }
}

function allowedRequest(value: string, activeOrigin: string | null): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (["about:", "blob:", "data:"].includes(parsed.protocol)) return true;
  return activeOrigin !== null
    && (parsed.protocol === "http:" || parsed.protocol === "https:")
    && parsed.origin === activeOrigin;
}

async function closeBrowser(browser: Browser | undefined): Promise<void> {
  if (!browser) return;
  let closed = false;
  await new Promise<void>((resolveClose) => {
    const timer = setTimeout(resolveClose, SESSION_CLOSE_TIMEOUT_MS);
    void browser.close().catch(() => {}).then(() => {
      closed = true;
      clearTimeout(timer);
      resolveClose();
    });
  });
  if (!closed) browser.process()?.kill("SIGKILL");
}

async function configurePage(page: Page): Promise<void> {
  await page.setRequestInterception(true);
  await page.emulateTimezone("UTC");
  await page.emulateMediaFeatures([
    { name: "prefers-color-scheme", value: "light" },
    { name: "prefers-reduced-motion", value: "reduce" },
  ]);
  await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });
  await page.evaluateOnNewDocument(() => {
    const globalValue = globalThis as any;
    const state = globalValue as { __dezinVisualCspViolations?: string[] };
    state.__dezinVisualCspViolations = [];
    globalValue.addEventListener("securitypolicyviolation", (event: any) => {
      state.__dezinVisualCspViolations?.push(event.blockedURI || event.violatedDirective || "unknown");
    });
  });
}

async function settlePage(page: Page, signal: AbortSignal): Promise<void> {
  await boundedOperation(page.waitForNetworkIdle({ idleTime: 400, timeout: SETTLE_TIMEOUT_MS }), signal, SETTLE_TIMEOUT_MS + 500, "Visual network settle");
  await boundedOperation(page.addStyleTag({ content: `
    *,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}
    html{scroll-behavior:auto!important}::-webkit-scrollbar{display:none!important}
  ` }).then(() => undefined), signal, 2_000, "Visual animation suppression");
  await boundedOperation(page.evaluate(async () => {
    const globalValue = globalThis as any;
    const documentValue = globalValue.document;
    await documentValue.fonts?.ready;
    await Promise.all(Array.from(documentValue.images as any[]).map(async (image: any) => {
      if (image.complete) {
        await image.decode().catch(() => {});
        return;
      }
      await new Promise<void>((resolveImage) => {
        image.addEventListener("load", () => resolveImage(), { once: true });
        image.addEventListener("error", () => resolveImage(), { once: true });
      });
    }));
    globalValue.scrollTo(0, 0);
    await new Promise<void>((resolveFrame) => globalValue.requestAnimationFrame(() => globalValue.requestAnimationFrame(() => resolveFrame())));
  }), signal, SETTLE_TIMEOUT_MS, "Visual DOM settle");
}

async function pagePolicyViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const state = globalThis as any as { __dezinVisualCspViolations?: string[] };
    return [...(state.__dezinVisualCspViolations ?? [])];
  });
}

async function captureUrl(
  page: Page,
  url: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const response = await boundedOperation(
    page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }),
    signal,
    NAVIGATION_TIMEOUT_MS + 500,
    "Visual navigation",
  );
  if (!response || response.status() < 200 || response.status() >= 300) {
    throw new Error(`visual route returned HTTP ${response?.status() ?? 0}`);
  }
  const actual = new URL(page.url());
  const expected = new URL(url);
  if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.search !== expected.search) {
    throw new Error(`visual route navigated away to ${safeRequestLabel(actual.href)}`);
  }
  await settlePage(page, signal);
  return Buffer.from(await boundedOperation(
    page.screenshot({ type: "png", fullPage: false }),
    signal,
    8_000,
    "Visual screenshot",
  ));
}

async function openPuppeteerCaptureSession(input: {
  distDir: string;
  sourcePreviewOrigin: string;
  signal: AbortSignal;
}): Promise<DesignExportVisualCaptureSession> {
  input.signal.throwIfAborted();
  const executablePath = findDesignExportChrome();
  if (!executablePath) throw new Error("Chrome not found (required for Design Export visual validation)");
  const outputServer = await openOutputServer(input.distDir, input.signal);
  let browser: Browser | undefined;
  let browserContext: BrowserContext | undefined;
  let page: Page | undefined;
  let closePromise: Promise<void> | undefined;
  let closeOnAbort: (() => void) | undefined;
  try {
    const launchPromise = puppeteer.launch({
      executablePath,
      headless: true,
      timeout: 30_000,
      defaultViewport: null,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-features=Translate,BackForwardCache,NetworkPrediction,SpeculationRulesPrefetch,Prerender2",
        "--disable-sync",
        "--force-color-profile=srgb",
        "--font-render-hinting=none",
        "--hide-scrollbars",
        "--lang=en-US",
        "--metrics-recording-only",
        "--no-first-run",
      ],
    });
    try {
      browser = await boundedOperation(launchPromise, input.signal, 30_500, "Design Export Chrome launch");
    } catch (error) {
      void launchPromise.then((lateBrowser) => closeBrowser(lateBrowser)).catch(() => {});
      throw error;
    }
    browserContext = await boundedOperation(browser.createBrowserContext(), input.signal, 5_000, "Design Export browser context");
    page = await boundedOperation(browserContext.newPage(), input.signal, 5_000, "Design Export browser page");
    await configurePage(page);
    let activeOrigin: string | null = null;
    const blockedRequests = new Set<string>();
    page.on("request", (request) => {
      const url = request.url();
      if (allowedRequest(url, activeOrigin)) {
        void request.continue().catch(() => {});
      } else {
        blockedRequests.add(safeRequestLabel(url));
        void request.abort("blockedbyclient").catch(() => {});
      }
    });
    page.on("popup", (popup) => {
      if (!popup) return;
      blockedRequests.add(`popup:${safeRequestLabel(popup.url())}`);
      void popup.close().catch(() => {});
    });

    const close = (): Promise<void> => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        if (closeOnAbort) input.signal.removeEventListener("abort", closeOnAbort);
        await browserContext?.close().catch(() => {});
        await closeBrowser(browser);
        await outputServer.close().catch(() => {});
      })();
      return closePromise;
    };
    closeOnAbort = () => { void close(); };
    input.signal.addEventListener("abort", closeOnAbort, { once: true });
    const browserVersion = await browser.version();
    return {
      browserVersion,
      outputOrigin: outputServer.origin,
      async capture(captureInput) {
        captureInput.signal.throwIfAborted();
        if (new URL(captureInput.sourceUrl).origin !== input.sourcePreviewOrigin
          || new URL(captureInput.outputUrl).origin !== outputServer.origin) {
          throw new Error("visual route origin escaped its phase boundary");
        }
        blockedRequests.clear();
        await page!.setViewport({
          width: captureInput.viewport.width,
          height: captureInput.viewport.height,
          deviceScaleFactor: 1,
          isMobile: captureInput.viewport.name === "mobile",
          hasTouch: captureInput.viewport.name === "mobile",
        });
        activeOrigin = new URL(captureInput.sourceUrl).origin;
        const sourcePng = await captureUrl(page!, captureInput.sourceUrl, captureInput.signal);
        const sourceViolations = await pagePolicyViolations(page!);
        for (const violation of sourceViolations) blockedRequests.add(safeRequestLabel(violation));
        if (blockedRequests.size > 0) throw new Error(`blocked external request ${[...blockedRequests][0]}`);
        activeOrigin = new URL(captureInput.outputUrl).origin;
        const outputPng = await captureUrl(page!, captureInput.outputUrl, captureInput.signal);
        const outputViolations = await pagePolicyViolations(page!);
        for (const violation of outputViolations) blockedRequests.add(safeRequestLabel(violation));
        const marker = await page!.evaluate((expectedNodeId: string) => {
          const globalValue = globalThis as any;
          const elements = Array.from(globalValue.document.querySelectorAll("[data-dezin-export-node-id]")) as any[];
          const expected = elements.length === 1 && elements[0]?.dataset.dezinExportNodeId === expectedNodeId
            ? elements[0]
            : null;
          if (!expected) return { ids: elements.map((element) => element.dataset.dezinExportNodeId ?? ""), visible: false };
          const style = globalValue.getComputedStyle(expected);
          const rect = expected.getBoundingClientRect();
          const visible = expected.isConnected && style.display !== "none" && style.visibility !== "hidden"
            && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0
            && rect.right > 0 && rect.bottom > 0 && rect.left < globalValue.innerWidth && rect.top < globalValue.innerHeight;
          return { ids: [expectedNodeId], visible };
        }, captureInput.nodeId);
        return {
          sourcePng,
          outputPng,
          markerNodeIds: marker.ids,
          markerVisible: marker.visible,
          blockedRequests: [...blockedRequests],
        };
      },
      close,
    };
  } catch (error) {
    if (closeOnAbort) input.signal.removeEventListener("abort", closeOnAbort);
    await browserContext?.close().catch(() => {});
    await closeBrowser(browser);
    await outputServer.close().catch(() => {});
    throw error;
  }
}
