import {
  containsEphemeralRemoteResourceBytes,
  type FigmaVariablesResult,
} from "./figma-import-normalizer.ts";
import { inspectBoundedPngImage } from "../bounded-png.ts";
import { sanitizeFigmaPng } from "./figma-png.ts";
import { isSafeFigmaApiNodeId } from "./figma-url.ts";

const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_RENDER_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_RENDER_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_RENDER_PIXELS = 64_000_000;
const DEFAULT_RENDER_MAP_TIMEOUT_MS = 60_000;
const MAX_RETRY_AFTER_MS = 5_000;
const MAX_RENDER_NODES = 12;
const MAX_RENDER_CONCURRENCY = 3;

interface FigmaRequestCredential {
  token: string;
}

interface FigmaRequestBase {
  fileKey: string;
  credential: FigmaRequestCredential;
  signal?: AbortSignal;
}

export interface FigmaNodeRender {
  nodeId: string;
  png: Buffer;
  width: number;
  height: number;
}

export interface FigmaNodeRenderResult {
  renders: FigmaNodeRender[];
  unavailableNodeIds: string[];
}

export interface FigmaRestClient {
  getMetadata(input: FigmaRequestBase): Promise<unknown>;
  getFileVersion(input: FigmaRequestBase & {
    version: string;
    nodeIds: readonly string[];
    depth: number;
    branchData?: boolean;
  }): Promise<unknown>;
  getLocalVariables(input: FigmaRequestBase): Promise<FigmaVariablesResult>;
  getNodeRenders?(input: FigmaRequestBase & {
    version: string;
    nodeIds: readonly string[];
  }): Promise<FigmaNodeRenderResult>;
}

export class FigmaRestError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "FigmaRestError";
    this.status = status;
  }
}

export interface CreateFigmaRestClientOptions {
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  maxResponseBytes?: number;
  maxRenderBytes?: number;
  maxTotalRenderBytes?: number;
  maxTotalRenderPixels?: number;
  requestTimeoutMs?: number;
  renderMapTimeoutMs?: number;
}

function safeFileKey(value: string): string {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(value)) throw new FigmaRestError("Figma file identity is invalid");
  return value;
}

function safeNodeId(value: string): string {
  if (!isSafeFigmaApiNodeId(value)) {
    throw new FigmaRestError("Figma render Node identity is invalid");
  }
  return value;
}

function safeVersion(value: string): string {
  if (!value.trim() || value !== value.trim() || Buffer.byteLength(value, "utf8") > 256) {
    throw new FigmaRestError("Figma render Version is invalid");
  }
  return value;
}

function credentialCanaries(token: string): Buffer[] {
  const encoded = Buffer.from(token).toString("base64");
  return [...new Set([token, encoded, encodeURIComponent(token), encodeURIComponent(encoded)])]
    .map((canary) => Buffer.from(canary));
}

function containsCredentialCanary(value: string | Buffer, token: string): boolean {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  return credentialCanaries(token).some((canary) => bytes.includes(canary));
}

function safeRenderUrl(value: unknown, token: string): URL {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 8_192
    || containsCredentialCanary(value, token)) {
    throw new FigmaRestError("Figma render URL is invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FigmaRestError("Figma render URL is invalid");
  }
  const host = url.hostname.toLowerCase();
  const allowedHost = host === "s3-alpha-sig.figma.com"
    || host === "figma-alpha-api.s3.us-west-2.amazonaws.com"
    || host === "figma-alpha-api.s3.amazonaws.com"
    || host === "figmausercontent.com"
    || host.endsWith(".figmausercontent.com");
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !allowedHost) {
    throw new FigmaRestError("Figma render URL is invalid");
  }
  return url;
}

function retryAfterMilliseconds(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  const parsedDate = Date.parse(value);
  const raw = Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1_000
    : Number.isFinite(parsedDate) ? Math.max(0, parsedDate - now) : null;
  return raw === null ? null : Math.max(0, Math.ceil(raw));
}

async function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function boundedBytes(response: Response, limit: number, signal?: AbortSignal): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    throw new FigmaRestError("Figma response exceeds the byte budget", response.status);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const read = reader.read();
      const next = signal === undefined ? await read : await withAbort(read, signal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new FigmaRestError("Figma response exceeds the byte budget", response.status);
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (signal?.aborted) void reader.cancel(signal.reason).catch(() => {});
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // An abort races the outstanding read. Cancellation above owns releasing it.
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function json(response: Response, limit: number, signal?: AbortSignal): Promise<unknown> {
  const bytes = await boundedBytes(response, limit, signal);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new FigmaRestError("Figma returned invalid JSON", response.status);
  }
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

export function createFigmaRestClient(options: CreateFigmaRestClientOptions = {}): FigmaRestClient {
  const fetcher = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxRenderBytes = options.maxRenderBytes ?? DEFAULT_MAX_RENDER_BYTES;
  const maxTotalRenderBytes = options.maxTotalRenderBytes ?? DEFAULT_MAX_TOTAL_RENDER_BYTES;
  const maxTotalRenderPixels = options.maxTotalRenderPixels ?? DEFAULT_MAX_TOTAL_RENDER_PIXELS;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const renderMapTimeoutMs = options.renderMapTimeoutMs ?? DEFAULT_RENDER_MAP_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 64 * 1024 * 1024) {
    throw new FigmaRestError("Figma response byte budget is invalid");
  }
  if (!Number.isSafeInteger(maxRenderBytes) || maxRenderBytes < 33 || maxRenderBytes > 32 * 1024 * 1024) {
    throw new FigmaRestError("Figma render byte budget is invalid");
  }
  if (!Number.isSafeInteger(maxTotalRenderBytes) || maxTotalRenderBytes < 33
    || maxTotalRenderBytes > 64 * 1024 * 1024) {
    throw new FigmaRestError("Figma render total byte budget is invalid");
  }
  if (!Number.isSafeInteger(maxTotalRenderPixels) || maxTotalRenderPixels < 1
    || maxTotalRenderPixels > 128_000_000) {
    throw new FigmaRestError("Figma render total pixel budget is invalid");
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 120_000) {
    throw new FigmaRestError("Figma request timeout is invalid");
  }
  if (!Number.isSafeInteger(renderMapTimeoutMs) || renderMapTimeoutMs < 1 || renderMapTimeoutMs > 120_000) {
    throw new FigmaRestError("Figma render map timeout is invalid");
  }
  const base = "https://api.figma.com/v1";

  const request = async (
    operation: string,
    url: URL,
    credential: FigmaRequestCredential,
    signal?: AbortSignal,
    unavailableStatuses: readonly number[] = [],
    timeoutMs = requestTimeoutMs,
  ): Promise<unknown | { unavailable: 403 | 404 }> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const timeoutController = new AbortController();
      const timeout = setTimeout(() => {
        const error = new Error(`Figma ${operation} timed out`);
        error.name = "TimeoutError";
        timeoutController.abort(error);
      }, timeoutMs);
      const timeoutSignal = timeoutController.signal;
      const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
      try {
        let response: Response;
        try {
          response = await withAbort(Promise.resolve(fetcher(url, {
            method: "GET",
            redirect: "error",
            headers: { "x-figma-token": credential.token, accept: "application/json" },
            signal: requestSignal,
          })), requestSignal);
        } catch (error) {
          if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
          if (timeoutSignal.aborted) throw new FigmaRestError(`Figma ${operation} timed out`);
          if (error instanceof Error && error.name === "AbortError") throw error;
          throw new FigmaRestError(`Figma ${operation} request failed`);
        }
        if (response.status === 429 && attempt === 0) {
          const wait = retryAfterMilliseconds(response.headers.get("retry-after"));
          await response.body?.cancel().catch(() => {});
          if (wait === null || wait > MAX_RETRY_AFTER_MS) {
            throw new FigmaRestError(`Figma ${operation} is rate limited; retry later`, 429);
          }
          await sleep(wait, signal);
          continue;
        }
        if (unavailableStatuses.includes(response.status)) {
          await response.body?.cancel().catch(() => {});
          return { unavailable: response.status as 403 | 404 };
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new FigmaRestError(`Figma ${operation} failed with HTTP ${response.status}`, response.status);
        }
        try {
          return await withAbort(json(response, maxResponseBytes, requestSignal), requestSignal);
        } catch (error) {
          if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
          if (timeoutSignal.aborted) throw new FigmaRestError(`Figma ${operation} timed out`);
          throw error;
        }
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new FigmaRestError(`Figma ${operation} remained rate limited`, 429);
  };

  const downloadRender = async (
    url: URL,
    credential: FigmaRequestCredential,
    signal?: AbortSignal,
  ): Promise<{ png: Buffer; width: number; height: number }> => {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => {
      const error = new Error("Figma render download timed out");
      error.name = "TimeoutError";
      timeoutController.abort(error);
    }, requestTimeoutMs);
    const timeoutSignal = timeoutController.signal;
    const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
    try {
      let response: Response;
      try {
        response = await withAbort(Promise.resolve(fetcher(url, {
          method: "GET",
          redirect: "error",
          headers: { accept: "image/png" },
          signal: requestSignal,
        })), requestSignal);
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
        if (timeoutSignal.aborted) throw new FigmaRestError("Figma render download timed out");
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw new FigmaRestError("Figma render download failed");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new FigmaRestError(`Figma render download failed with HTTP ${response.status}`, response.status);
      }
      if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "image/png") {
        await response.body?.cancel().catch(() => {});
        throw new FigmaRestError("Figma render content type is invalid", response.status);
      }
      const downloaded = await withAbort(boundedBytes(response, maxRenderBytes, requestSignal), requestSignal);
      if (containsCredentialCanary(downloaded, credential.token)) {
        throw new FigmaRestError("Figma render contained credential material and was rejected");
      }
      let sanitized: ReturnType<typeof sanitizeFigmaPng>;
      try {
        sanitized = sanitizeFigmaPng(downloaded);
      } catch (error) {
        throw new FigmaRestError(error instanceof Error ? error.message : "Figma render is not a valid PNG");
      }
      try {
        await inspectBoundedPngImage(sanitized.bytes, requestSignal);
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
        throw new FigmaRestError(error instanceof Error ? error.message : "Figma render pixels are invalid");
      }
      if (containsCredentialCanary(sanitized.bytes, credential.token)
        || containsEphemeralRemoteResourceBytes(sanitized.bytes)) {
        throw new FigmaRestError("Figma render contained unsafe embedded data and was rejected");
      }
      return { png: sanitized.bytes, width: sanitized.width, height: sanitized.height };
    } finally {
      clearTimeout(timeout);
    }
  };

  return {
    async getMetadata(input) {
      const url = new URL(`${base}/files/${encodeURIComponent(safeFileKey(input.fileKey))}/meta`);
      return request("metadata", url, input.credential, input.signal);
    },
    async getFileVersion(input) {
      const key = encodeURIComponent(safeFileKey(input.fileKey));
      const url = new URL(`${base}/files/${key}`);
      if (input.nodeIds.length > 0) url.searchParams.set("ids", input.nodeIds.join(","));
      url.searchParams.set("version", input.version);
      url.searchParams.set("depth", String(input.depth));
      if (input.branchData === true) url.searchParams.set("branch_data", "true");
      return request("file content", url, input.credential, input.signal);
    },
    async getLocalVariables(input) {
      const url = new URL(`${base}/files/${encodeURIComponent(safeFileKey(input.fileKey))}/variables/local`);
      const result = await request("Variables", url, input.credential, input.signal, [403, 404]);
      if (result && typeof result === "object" && "unavailable" in result) {
        const status = result.unavailable;
        if (status !== 403 && status !== 404) {
          throw new FigmaRestError("Figma Variables availability status is invalid");
        }
        return { kind: "unavailable", status, reason: `Figma Variables are unavailable (HTTP ${status}).` };
      }
      return { kind: "available", body: result };
    },
    async getNodeRenders(input) {
      if (input.nodeIds.length < 1 || input.nodeIds.length > MAX_RENDER_NODES) {
        throw new FigmaRestError("Figma render Node count is invalid");
      }
      const ids = input.nodeIds.map(safeNodeId);
      if (new Set(ids).size !== ids.length) throw new FigmaRestError("Figma render Node identities are duplicated");
      const key = encodeURIComponent(safeFileKey(input.fileKey));
      const url = new URL(`${base}/images/${key}`);
      url.searchParams.set("ids", ids.join(","));
      url.searchParams.set("version", safeVersion(input.version));
      url.searchParams.set("format", "png");
      url.searchParams.set("scale", "1");
      url.searchParams.set("contents_only", "true");
      url.searchParams.set("use_absolute_bounds", "true");
      const result = await request("render map", url, input.credential, input.signal, [], renderMapTimeoutMs);
      if (result === null || typeof result !== "object" || Array.isArray(result)
        || (result as Record<string, unknown>).images === null
        || typeof (result as Record<string, unknown>).images !== "object"
        || Array.isArray((result as Record<string, unknown>).images)) {
        throw new FigmaRestError("Figma render map is invalid");
      }
      const images = (result as Record<string, unknown>).images as Record<string, unknown>;
      const renders: FigmaNodeRender[] = [];
      const unavailableNodeIds: string[] = [];
      let totalRenderBytes = 0;
      let totalRenderPixels = 0;
      const downloadIds: Array<{ nodeId: string; url: URL }> = [];
      for (const id of ids) {
        if (!Object.hasOwn(images, id)) throw new FigmaRestError("Figma render map is incomplete");
        const value = images[id];
        if (value === null) {
          unavailableNodeIds.push(id);
          continue;
        }
        downloadIds.push({ nodeId: id, url: safeRenderUrl(value, input.credential.token) });
      }
      const batchController = new AbortController();
      let batchFailed = false;
      let batchFailure: unknown;
      const failBatch = (error: unknown) => {
        if (batchFailed) return;
        batchFailed = true;
        batchFailure = error;
        batchController.abort(error);
      };
      const batchTimeout = setTimeout(() => {
        failBatch(new FigmaRestError("Figma render batch timed out"));
      }, Math.min(60_000, requestTimeoutMs * 2));
      const batchSignal = input.signal === undefined
        ? batchController.signal
        : AbortSignal.any([input.signal, batchController.signal]);
      let cursor = 0;
      const completed = new Map<string, FigmaNodeRender>();
      try {
        const worker = async () => {
          try {
            while (!batchFailed) {
              const index = cursor;
              cursor += 1;
              const item = downloadIds[index];
              if (!item) return;
              const rendered = await downloadRender(item.url, input.credential, batchSignal);
              totalRenderBytes += rendered.png.length;
              totalRenderPixels += rendered.width * rendered.height;
              if (totalRenderBytes > maxTotalRenderBytes) {
                failBatch(new FigmaRestError("Figma renders exceed the total byte budget"));
                return;
              }
              if (totalRenderPixels > maxTotalRenderPixels) {
                failBatch(new FigmaRestError("Figma renders exceed the total pixel budget"));
                return;
              }
              completed.set(item.nodeId, { nodeId: item.nodeId, ...rendered });
            }
          } catch (error) {
            failBatch(error);
          }
        };
        await Promise.allSettled(Array.from(
          { length: Math.min(MAX_RENDER_CONCURRENCY, downloadIds.length) },
          () => worker(),
        ));
      } finally {
        clearTimeout(batchTimeout);
      }
      if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("Aborted", "AbortError");
      if (batchFailed) throw batchFailure;
      for (const id of ids) {
        const rendered = completed.get(id);
        if (rendered) renders.push(rendered);
      }
      return { renders, unavailableNodeIds };
    },
  };
}
