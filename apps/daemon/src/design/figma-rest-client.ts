import type { FigmaVariablesResult } from "./figma-import-normalizer.ts";

const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_RETRY_AFTER_MS = 5_000;

interface FigmaRequestCredential {
  token: string;
}

interface FigmaRequestBase {
  fileKey: string;
  credential: FigmaRequestCredential;
  signal?: AbortSignal;
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
  requestTimeoutMs?: number;
}

function safeFileKey(value: string): string {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(value)) throw new FigmaRestError("Figma file identity is invalid");
  return value;
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

async function boundedBytes(response: Response, limit: number): Promise<Buffer> {
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
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new FigmaRestError("Figma response exceeds the byte budget", response.status);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function json(response: Response, limit: number): Promise<unknown> {
  const bytes = await boundedBytes(response, limit);
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
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 64 * 1024 * 1024) {
    throw new FigmaRestError("Figma response byte budget is invalid");
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 120_000) {
    throw new FigmaRestError("Figma request timeout is invalid");
  }
  const base = "https://api.figma.com/v1";

  const request = async (
    operation: string,
    url: URL,
    credential: FigmaRequestCredential,
    signal?: AbortSignal,
    unavailableStatuses: readonly number[] = [],
  ): Promise<unknown | { unavailable: 403 | 404 }> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const timeoutController = new AbortController();
      const timeout = setTimeout(() => {
        const error = new Error(`Figma ${operation} timed out`);
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
          return await withAbort(json(response, maxResponseBytes), requestSignal);
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
  };
}
