/**
 * Serve the built web app (apps/web/dist) from the daemon, with a SPA fallback to
 * index.html. Lets the daemon be a single same-origin server for UI + API + preview
 * (used by the Electron shell, and any plain-browser prod run). Dev still uses Vite.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import { send, sendError, contentTypeFor } from "./http-util.ts";

export function defaultWebDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
}

function injectDaemonToken(html: string, token: string): string {
  if (!token) return html;
  const script = `<script>window.__DEZIN_DAEMON_TOKEN__=${JSON.stringify(token).replace(/</g, "\\u003c")};</script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (head) => `${head}${script}`);
  return `${script}${html}`;
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
    send(res, 200, contentType.startsWith("text/html") ? injectDaemonToken(body.toString("utf8"), options.daemonToken ?? "") : body, contentType);
  } catch {
    sendError(res, 404, "not found");
  }
}
