/**
 * Screenshot a self-contained prototype HTML into a PNG cover.
 *
 * When running inside the Electron desktop app (DEZIN_ELECTRON + an IPC channel), the
 * capture is delegated to Electron's own Chromium via a hidden window — no external
 * Chrome, no puppeteer process. Otherwise (dev/headless) it falls back to the system
 * Chrome via puppeteer-core. Best-effort: returns false (never throws) on failure.
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";

const CHROME_PATHS = [
  process.env.DEZIN_CHROME ?? "",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
];

export function findChrome(): string | null {
  return CHROME_PATHS.find((p) => p && existsSync(p)) ?? null;
}

// ── Electron path (preferred when bundled) ────────────────────────────────────
interface CaptureResultMsg {
  type: "capture-result";
  id: number;
  ok: boolean;
}
let ipcSeq = 0;
const pending = new Map<number, (ok: boolean) => void>();
let ipcWired = false;

function wireIpc(): void {
  if (ipcWired || typeof process.send !== "function") return;
  ipcWired = true;
  process.on("message", (msg: unknown) => {
    const m = msg as CaptureResultMsg;
    if (m && m.type === "capture-result" && pending.has(m.id)) {
      pending.get(m.id)!(Boolean(m.ok));
      pending.delete(m.id);
    }
  });
}

function captureViaElectron(htmlPath: string, outPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof process.send !== "function") return resolve(false);
    wireIpc();
    const id = ++ipcSeq;
    const timer = setTimeout(() => {
      if (pending.delete(id)) resolve(false);
    }, 15000);
    pending.set(id, (ok) => {
      clearTimeout(timer);
      resolve(ok);
    });
    process.send({ type: "capture", id, htmlPath, outPath });
  });
}

// ── Puppeteer fallback ────────────────────────────────────────────────────────
async function captureTargetViaPuppeteer(targetUrl: string, outPath: string): Promise<boolean> {
  const executablePath = findChrome();
  if (!executablePath) return false;
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--hide-scrollbars"] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 12000 });
    await new Promise((r) => setTimeout(r, 400)); // let fonts + first paint settle
    await page.screenshot({ path: outPath as `${string}.png`, type: "png", clip: { x: 0, y: 0, width: 1280, height: 800 } });
    return true;
  } catch {
    return false;
  } finally {
    await browser?.close().catch(() => {});
  }
}

function captureViaPuppeteer(htmlPath: string, outPath: string): Promise<boolean> {
  return captureTargetViaPuppeteer(pathToFileURL(htmlPath).href, outPath);
}

export async function captureCover(htmlPath: string, outPath: string): Promise<boolean> {
  if (!existsSync(htmlPath)) return false;
  if (process.env.DEZIN_ELECTRON && typeof process.send === "function") {
    if (await captureViaElectron(htmlPath, outPath)) return true;
    // fall through to puppeteer if the Electron capture failed
  }
  return captureViaPuppeteer(htmlPath, outPath);
}

export async function captureCoverUrl(url: string, outPath: string): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return false;
  return captureTargetViaPuppeteer(url, outPath);
}
