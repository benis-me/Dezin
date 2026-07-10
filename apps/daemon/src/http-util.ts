/**
 * Tiny HTTP helpers + a path router for the node:http daemon. No framework.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

export function send(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  contentType: string,
): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}

const MAX_BODY = 4 * 1024 * 1024;

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function isHttpError(value: unknown): value is HttpError {
  return value instanceof HttpError;
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("request body aborted");
  error.name = "AbortError";
  return error;
}

function collectBody(req: IncomingMessage, max: number, signal?: AbortSignal): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const cleanup = (): void => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("aborted", onAborted);
      signal?.removeEventListener("abort", onSignalAbort);
    };
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > max) {
        finish(new HttpError(413, "request body too large"));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => finish();
    const onError = (error: Error): void => finish(error);
    const onAborted = (): void => finish(abortError(signal));
    const onSignalAbort = (): void => {
      finish(abortError(signal));
      req.destroy();
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
    signal?.addEventListener("abort", onSignalAbort, { once: true });
    if (signal?.aborted) onSignalAbort();
  });
}

export async function readJsonBody(req: IncomingMessage, max = MAX_BODY, signal?: AbortSignal): Promise<unknown> {
  const raw = (await collectBody(req, max, signal)).toString("utf8").trim();
  if (!raw) return {};
  const contentType = req.headers["content-type"];
  const mediaType = (Array.isArray(contentType) ? contentType[0] : contentType)?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
    throw new HttpError(415, "content-type must be application/json");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

/** Read a raw binary request body (for file uploads). Allows larger payloads than JSON. */
export function readRawBody(req: IncomingMessage, max = 64 * 1024 * 1024, signal?: AbortSignal): Promise<Buffer> {
  return collectBody(req, max, signal);
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
};

export function contentTypeFor(pathname: string): string {
  const dot = pathname.lastIndexOf(".");
  const ext = dot >= 0 ? pathname.slice(dot).toLowerCase() : "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export interface RouteMatch {
  params: Record<string, string>;
}

/**
 * Match a URL path against a pattern. Pattern segments may be literals, `:param`,
 * or a trailing `*rest` that captures the remainder (decoded, slash-joined).
 * Returns params or null.
 */
export function matchPath(pattern: string, path: string): RouteMatch | null {
  const pp = pattern.split("/").filter((s) => s !== "");
  const up = path.split("/").filter((s) => s !== "");
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    const seg = pp[i]!;
    if (seg.startsWith("*")) {
      params[seg.slice(1) || "rest"] = up.slice(i).map(decodeURIComponent).join("/");
      return { params };
    }
    if (up[i] === undefined) return null;
    if (seg.startsWith(":")) {
      params[seg.slice(1)] = decodeURIComponent(up[i]!);
    } else if (seg !== up[i]) {
      return null;
    }
  }
  return up.length === pp.length ? { params } : null;
}
