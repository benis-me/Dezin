/**
 * Serve the built web app (apps/web/dist) from the daemon, with a SPA fallback to
 * index.html. Lets the daemon be a single same-origin server for UI + API + preview
 * (used by the Electron shell, and any plain-browser prod run). Dev still uses Vite.
 *
 * The daemon bearer token reaches the page as an HttpOnly cookie set on the HTML
 * response, never as a JavaScript-readable global, so an XSS in the UI cannot
 * read it. Fetches from the page carry the cookie automatically; the daemon
 * accepts it only for same-origin requests (see security.ts).
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import { send, sendError, contentTypeFor } from "./http-util.ts";
import { DAEMON_TOKEN_COOKIE } from "./security.ts";

export function defaultWebDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
}

export function daemonTokenCookie(token: string): string {
  // Not `Secure`: the daemon is plain http on the loopback interface.
  return `${DAEMON_TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`;
}

export async function serveWeb(res: ServerResponse, webDir: string, pathname: string, options: { daemonToken?: string } = {}): Promise<void> {
  const base = resolve(webDir);
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = resolve(base, rel);
  // Real asset (in-bounds + exists) → serve it; otherwise SPA-fallback to index.html.
  const inBounds = target === base || target.startsWith(base + sep);
  const file = inBounds && existsSync(target) ? target : join(base, "index.html");
  try {
    const contentType = contentTypeFor(file);
    const body = await readFile(file);
    const token = options.daemonToken?.trim() ?? "";
    if (token && contentType.startsWith("text/html")) {
      res.setHeader("set-cookie", daemonTokenCookie(token));
      res.setHeader("cache-control", "no-store");
    }
    send(res, 200, body, contentType);
  } catch {
    sendError(res, 404, "not found");
  }
}
