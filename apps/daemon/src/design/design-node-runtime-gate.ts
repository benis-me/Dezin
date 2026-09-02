import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import puppeteer from "puppeteer-core";

import { findDesignExportChrome } from "./design-export-visual-gate.ts";

export interface DesignNodeRuntimeGateResult {
  viewports: number;
  meaningfulElements: number;
}

export interface DesignNodeRuntimeAssetDescriptor {
  assetId: string;
  stagingPath: string;
  mimeType: string;
  checksum: string;
  bytes: number;
  ownerNodeIds: readonly string[];
}

export type DesignNodeRuntimeGateRunner = (input: {
  html: string;
  signal: AbortSignal;
  assets: readonly DesignNodeRuntimeAssetDescriptor[];
}) => Promise<DesignNodeRuntimeGateResult>;

export class DesignNodeRuntimeGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignNodeRuntimeGateError";
  }
}

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
] as const;

/**
 * Turn a raw browser failure into one sentence a designer (or the repairing
 * Agent) can act on. The raw text stays in parentheses so nothing is hidden.
 */
export function describeRuntimeFailure(kind: "blocked-request" | "runtime-error", raw: string): string {
  const detail = raw.trim();
  if (kind === "blocked-request") {
    return `a network request was blocked; generated HTML must keep every resource inline or bound to a dezin-asset:// id (${detail})`;
  }
  if (/texImage2D|getImageData|toDataURL|toBlob|tainted|cross-origin/i.test(detail)) {
    return `a cross-origin image was blocked by the preview sandbox; add crossorigin="anonymous" to every <img> that canvas or WebGL reads (${detail})`;
  }
  if (/is not defined|Cannot read propert|is not a function|Unexpected token|SyntaxError/i.test(detail)) {
    return `a script error stopped rendering; fix the inline JavaScript (${detail})`;
  }
  return `the page reported a runtime error (${detail})`;
}

const ASSET_ID = /^asset-[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_MIME_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;

function exactRuntimeAssets(
  descriptors: readonly DesignNodeRuntimeAssetDescriptor[],
): Map<string, DesignNodeRuntimeAssetDescriptor> {
  const assets = new Map<string, DesignNodeRuntimeAssetDescriptor>();
  for (const descriptor of descriptors) {
    if (!ASSET_ID.test(descriptor.assetId) || typeof descriptor.stagingPath !== "string"
      || descriptor.stagingPath.length === 0 || descriptor.mimeType.length > 120
      || !SAFE_MIME_TYPE.test(descriptor.mimeType)
      || !SHA256.test(descriptor.checksum) || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1
      || !Array.isArray(descriptor.ownerNodeIds) || descriptor.ownerNodeIds.length === 0
      || descriptor.ownerNodeIds.some((nodeId) => !SAFE_NODE_ID.test(nodeId))
      || new Set(descriptor.ownerNodeIds).size !== descriptor.ownerNodeIds.length) {
      throw new DesignNodeRuntimeGateError("Node runtime gate received an invalid frozen Asset descriptor");
    }
    const prior = assets.get(descriptor.assetId);
    if (prior !== undefined) {
      throw new DesignNodeRuntimeGateError(`Node runtime gate received duplicate frozen Asset descriptor: ${descriptor.assetId}`);
    }
    assets.set(descriptor.assetId, descriptor);
  }
  return assets;
}

async function readExactRuntimeAsset(descriptor: DesignNodeRuntimeAssetDescriptor): Promise<Buffer> {
  const handle = await open(descriptor.stagingPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const openedBefore = await handle.stat();
    const pathBefore = await lstat(descriptor.stagingPath);
    if (!openedBefore.isFile() || !pathBefore.isFile() || pathBefore.isSymbolicLink()
      || openedBefore.dev !== pathBefore.dev || openedBefore.ino !== pathBefore.ino
      || openedBefore.size !== descriptor.bytes || pathBefore.size !== descriptor.bytes) {
      throw new DesignNodeRuntimeGateError(`Frozen Asset payload changed after materialization: ${descriptor.assetId}`);
    }
    const bytes = await handle.readFile();
    const openedAfter = await handle.stat();
    const pathAfter = await lstat(descriptor.stagingPath);
    if (!pathAfter.isFile() || pathAfter.isSymbolicLink()
      || openedAfter.dev !== openedBefore.dev || openedAfter.ino !== openedBefore.ino
      || pathAfter.dev !== openedBefore.dev || pathAfter.ino !== openedBefore.ino
      || openedAfter.size !== descriptor.bytes || pathAfter.size !== descriptor.bytes) {
      throw new DesignNodeRuntimeGateError(`Frozen Asset payload changed while it was read: ${descriptor.assetId}`);
    }
    if (bytes.byteLength !== descriptor.bytes
      || createHash("sha256").update(bytes).digest("hex") !== descriptor.checksum) {
      throw new DesignNodeRuntimeGateError(`Frozen Asset payload checksum mismatch: ${descriptor.assetId}`);
    }
    return bytes;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * A deliberately small pre-publication browser gate. Generated Node HTML is
 * synchronous and network-free by contract. DOMContentLoaded plus completion
 * of the exact intercepted requests is the stable observation point.
 */
export const runDesignNodeRuntimeGate: DesignNodeRuntimeGateRunner = async ({ html, signal, assets: descriptors }) => {
  signal.throwIfAborted();
  const assets = exactRuntimeAssets(descriptors);
  const assetBytes = new Map<string, Promise<Buffer>>();
  const executablePath = findDesignExportChrome();
  if (!executablePath) throw new DesignNodeRuntimeGateError("Node runtime gate requires Chrome");
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    protocolTimeout: 15_000,
    args: [
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--no-first-run",
      "--no-sandbox",
    ],
  });
  const abort = () => { void browser.close().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  let meaningfulElements = 0;
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    for (const viewport of VIEWPORTS) {
      signal.throwIfAborted();
      const runtimeErrors: string[] = [];
      const blockedRequests: string[] = [];
      const pendingRequests = new Set<Promise<void>>();
      const onPageError = (event: unknown): void => {
        runtimeErrors.push(event instanceof Error ? event.message : String(event));
      };
      const onConsole = (message: { type(): string; text(): string }) => {
        if (message.type() === "error") runtimeErrors.push(message.text());
      };
      const onRequest = (request: {
        url(): string;
        continue(): Promise<void>;
        abort(errorCode?: "blockedbyclient" | "failed"): Promise<void>;
        respond(response: { status: number; contentType: string; body: Buffer }): Promise<void>;
      }): void => {
        const operation = (async () => {
          const url = request.url();
          if (url === "about:blank" || url.startsWith("data:") || url.startsWith("blob:")) {
            await request.continue();
            return;
          }
          const assetId = /^dezin-asset:\/\/(asset-[a-f0-9]{32})$/.exec(url)?.[1];
          if (assetId !== undefined) {
            const asset = assets.get(assetId);
            if (asset === undefined) {
              blockedRequests.push(`unknown frozen Asset: ${url}`);
              await request.abort("blockedbyclient");
              return;
            }
            try {
              let bytes = assetBytes.get(assetId);
              if (bytes === undefined) {
                bytes = readExactRuntimeAsset(asset);
                assetBytes.set(assetId, bytes);
              }
              await request.respond({ status: 200, contentType: asset.mimeType, body: await bytes });
            } catch (error) {
              blockedRequests.push(error instanceof Error ? error.message : String(error));
              await request.abort("failed").catch(() => {});
            }
            return;
          }
          blockedRequests.push(`blocked external request: ${url}`);
          await request.abort("blockedbyclient");
        })().catch(async (error) => {
          blockedRequests.push(error instanceof Error ? error.message : String(error));
          await request.abort("failed").catch(() => {});
        });
        pendingRequests.add(operation);
        void operation.then(() => pendingRequests.delete(operation));
      };
      page.on("pageerror", onPageError);
      page.on("console", onConsole);
      page.on("request", onRequest);
      try {
        await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });
        await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 8_000 });
        while (pendingRequests.size > 0) await Promise.allSettled([...pendingRequests]);
        try {
          await page.waitForFunction(`(() => [...document.images].filter((image) => {
            const style = getComputedStyle(image);
            const rect = image.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden"
              && Number(style.opacity) > 0 && rect.width > 1 && rect.height > 1;
          }).every((image) => image.complete))()`, { timeout: 2_000 });
        } catch {
          runtimeErrors.push("visible image loading did not complete");
        }
        const snapshot = await page.evaluate(`(() => {
          const visible = (element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden"
              && Number(style.opacity) > 0 && rect.width > 1 && rect.height > 1;
          };
          const body = document.body;
          const descendants = [...body.querySelectorAll("*")];
          const meaningful = descendants.filter((element) => {
            if (!visible(element)) return false;
            const tag = element.tagName.toLowerCase();
            if (["main", "article", "section", "header", "footer", "nav", "img", "svg", "canvas", "video"].includes(tag)) return true;
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return rect.width * rect.height >= 256
              && (style.backgroundColor !== "rgba(0, 0, 0, 0)" || style.backgroundImage !== "none"
                || parseFloat(style.borderTopWidth) > 0);
          });
          const bodyText = (body.innerText || "").replace(/\\s+/g, " ").trim();
          const unnamed = [];
          const interactive = descendants.filter((element) =>
            element.matches("button, a[href], input, select, textarea, [role=button], [role=link], [role=switch], [role=checkbox], [role=radio], [role=tab]")
              && visible(element));
          for (const element of interactive) {
            const labelledBy = element.getAttribute("aria-labelledby");
            const referenced = labelledBy ? labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ") : "";
            const labels = "labels" in element && element.labels
              ? [...element.labels].map((label) => label.textContent || "").join(" ")
              : "";
            const name = [element.getAttribute("aria-label"), referenced, labels, element.textContent,
              element.getAttribute("title"), element.getAttribute("alt"), element.getAttribute("placeholder")]
              .filter(Boolean).join(" ").trim();
            if (!name) unnamed.push(element.tagName.toLowerCase());
          }
          const imagesWithoutAlt = descendants.filter((element) => element instanceof HTMLImageElement
            && visible(element) && !element.hasAttribute("alt") && element.getAttribute("role") !== "presentation").length;
          const imagesWithoutPixels = descendants.filter((element) => element instanceof HTMLImageElement
            && visible(element) && element.complete && element.naturalWidth === 0).length;
          return {
            bodyTextBytes: new TextEncoder().encode(bodyText).byteLength,
            meaningful: meaningful.length,
            unnamed,
            imagesWithoutAlt,
            imagesWithoutPixels,
            overflow: Math.max(document.documentElement.scrollWidth, body.scrollWidth) - innerWidth,
          };
        })()`) as {
          bodyTextBytes: number;
          meaningful: number;
          unnamed: string[];
          imagesWithoutAlt: number;
          imagesWithoutPixels: number;
          overflow: number;
        };
        meaningfulElements = Math.max(meaningfulElements, snapshot.meaningful);
        if (blockedRequests.length > 0) {
          throw new DesignNodeRuntimeGateError(`Node runtime gate failed at ${viewport.name}: ${describeRuntimeFailure("blocked-request", blockedRequests[0]!)}`);
        }
        if (runtimeErrors.length > 0) {
          throw new DesignNodeRuntimeGateError(`Node runtime gate failed at ${viewport.name}: ${describeRuntimeFailure("runtime-error", runtimeErrors[0]!)}`);
        }
        if (snapshot.bodyTextBytes === 0 && snapshot.meaningful === 0) {
          throw new DesignNodeRuntimeGateError(`Node runtime gate failed at ${viewport.name}: rendered output is blank`);
        }
        if (snapshot.overflow > 2) {
          throw new DesignNodeRuntimeGateError(`Node runtime gate failed at ${viewport.name}: document overflows horizontally by ${Math.ceil(snapshot.overflow)}px`);
        }
        if (snapshot.unnamed.length > 0 || snapshot.imagesWithoutAlt > 0) {
          const detail = snapshot.unnamed.length > 0
            ? `${snapshot.unnamed.length} visible interactive element(s) have no accessible name`
            : `${snapshot.imagesWithoutAlt} visible image(s) have no alt text`;
          throw new DesignNodeRuntimeGateError(`Node runtime gate failed at ${viewport.name}: ${detail}`);
        }
        if (snapshot.imagesWithoutPixels > 0) {
          throw new DesignNodeRuntimeGateError(`Node runtime gate failed at ${viewport.name}: ${snapshot.imagesWithoutPixels} visible image(s) failed to load`);
        }
      } finally {
        page.off("pageerror", onPageError);
        page.off("console", onConsole);
        page.off("request", onRequest);
      }
    }
    return { viewports: VIEWPORTS.length, meaningfulElements };
  } finally {
    signal.removeEventListener("abort", abort);
    await browser.close().catch(() => {});
  }
};
