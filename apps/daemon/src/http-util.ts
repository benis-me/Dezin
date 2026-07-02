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

export async function readJsonBody(req: IncomingMessage, max = MAX_BODY): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > max) throw new HttpError(413, "request body too large");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
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
export async function readRawBody(req: IncomingMessage, max = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > max) throw new HttpError(413, "request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
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
