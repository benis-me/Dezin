import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import puppeteer from "puppeteer-core";

import { createProviderFetch } from "../provider-fetch.ts";
import { findDesignExportChrome } from "./design-export-visual-gate.ts";
import { isDesignWebResourceUrl } from "./design-web-resources.ts";

export interface DesignNodeRuntimeGateScreenshot {
  viewport: "desktop" | "mobile";
  width: number;
  height: number;
  png: Buffer;
}

export interface DesignNodeRuntimeGateResult {
  viewports: number;
  meaningfulElements: number;
  /** Bounded full-page captures, present only when screenshots were requested. */
  screenshots?: DesignNodeRuntimeGateScreenshot[];
  /** Non-fatal observations (for example web fonts unreachable offline). */
  warnings?: string[];
}

export interface DesignNodeRuntimeGateOptions {
  /** Let the page load Fontsource CSS and font files from jsDelivr. */
  webResources?: boolean;
  /** Deterministic quality lint (contrast, filler copy, default font, overlapping text) after the hard checks. */
  lint?: boolean;
  /** Capture one bounded full-page PNG per viewport for the visual review turn. */
  screenshots?: boolean;
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
  options?: DesignNodeRuntimeGateOptions;
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
const MAX_SCREENSHOT_HEIGHT = 4000;
const WEB_RESOURCE_SETTLE_MS = 6_000;

/**
 * Objective quality lint evaluated in the rendered page. Every finding is one
 * sentence the Agent can act on; the worst offenders come first.
 */
const QUALITY_LINT_SCRIPT = `(() => {
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden"
      && Number(style.opacity) > 0 && rect.width > 1 && rect.height > 1;
  };
  const probe = document.createElement("canvas");
  probe.width = probe.height = 1;
  const context = probe.getContext("2d", { willReadFrequently: true });
  const parseColor = (value) => {
    if (!context || !value) return null;
    if (value === "transparent") return [0, 0, 0, 0];
    try {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "#000";
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const data = context.getImageData(0, 0, 1, 1).data;
      return [data[0], data[1], data[2], data[3] / 255];
    } catch {
      return null;
    }
  };
  const channel = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const luminance = (rgb) => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  const blend = (top, bottom) => {
    const a = top[3];
    return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
  };
  const contrast = (a, b) => {
    const l1 = luminance(a);
    const l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const backgroundBehind = (element) => {
    const layers = [];
    let node = element;
    while (node && node.nodeType === 1) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== "none" || style.mixBlendMode !== "normal") return null;
      const color = parseColor(style.backgroundColor);
      if (color === null) return null;
      if (color[3] > 0) layers.push(color);
      if (color[3] >= 1) break;
      node = node.parentElement;
    }
    let result = [255, 255, 255, 1];
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      result = layers[index][3] >= 1 ? layers[index] : blend(layers[index], result);
    }
    return result;
  };
  const ownText = (element) => [...element.childNodes]
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent)
    .join(" ")
    .replace(/\\s+/g, " ")
    .trim();
  const skipped = new Set(["script", "style", "noscript", "template", "svg", "path", "option"]);
  const textElements = [];
  for (const element of document.body.querySelectorAll("*")) {
    if (skipped.has(element.tagName.toLowerCase()) || !visible(element)) continue;
    const text = ownText(element);
    if (text.length >= 3) textElements.push({ element, text });
  }
  const findings = [];
  const bodyText = (document.body.innerText || "").replace(/\\s+/g, " ");
  const filler = /lorem ipsum|dolor sit amet|placeholder text|your text here|insert (?:text|copy|title|content) here|\\[insert |sample text here/i.exec(bodyText);
  if (filler) findings.push('placeholder copy "' + filler[0] + '" is still in the document; write the real content');
  const bodyFont = getComputedStyle(document.body).fontFamily.trim();
  if (!bodyFont || /^"?times/i.test(bodyFont) || /^serif$/i.test(bodyFont)) {
    findings.push("body text falls back to the browser default font (" + (bodyFont || "unset") + "); declare the design's font stack on body");
  }
  const contrastIssues = [];
  for (const { element, text } of textElements.slice(0, 600)) {
    if (element.closest("[disabled], [aria-disabled='true'], [aria-hidden='true'], input, select, textarea, [contenteditable]")) continue;
    const style = getComputedStyle(element);
    if (style.webkitTextFillColor && parseColor(style.webkitTextFillColor)?.[3] === 0) continue;
    const foreground = parseColor(style.color);
    if (foreground === null || foreground[3] === 0) continue;
    const background = backgroundBehind(element);
    if (background === null) continue;
    const ratio = contrast(foreground[3] < 1 ? blend(foreground, background) : foreground, background);
    const size = parseFloat(style.fontSize);
    const weight = parseInt(style.fontWeight, 10) || 400;
    const needed = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
    if (ratio + 0.05 < needed) {
      contrastIssues.push({
        ratio,
        needed,
        text: text.slice(0, 40),
        color: style.color,
        background: "rgb(" + background.slice(0, 3).map(Math.round).join(", ") + ")",
        size: Math.round(size),
      });
    }
  }
  contrastIssues.sort((left, right) => left.ratio - right.ratio);
  for (const issue of contrastIssues.slice(0, 2)) {
    findings.push('text "' + issue.text + '" has ' + issue.ratio.toFixed(2) + ":1 contrast (" + issue.color + " on " + issue.background + ", " + issue.size + "px); WCAG AA needs " + issue.needed + ":1");
  }
  const boxes = textElements
    .filter(({ element }) => !element.closest("[aria-hidden='true']"))
    .slice(0, 400)
    .map(({ element, text }) => ({ element, text, rect: element.getBoundingClientRect() }));
  let overlaps = 0;
  let example = "";
  for (let i = 0; i < boxes.length && overlaps < 5; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
      const width = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
      const height = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
      if (width <= 2 || height <= 2) continue;
      const smaller = Math.min(a.rect.width * a.rect.height, b.rect.width * b.rect.height);
      if (smaller > 0 && (width * height) / smaller > 0.35) {
        overlaps += 1;
        if (!example) example = '"' + a.text.slice(0, 30) + '" and "' + b.text.slice(0, 30) + '"';
      }
    }
  }
  if (overlaps > 0) findings.push(overlaps + " pair(s) of text elements overlap (for example " + example + "); fix the layout so text never collides");
  return findings;
})()`;

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
const WEB_RESOURCE_URL_IN_HTML = /https:\/\/cdn\.jsdelivr\.net\/fontsource\/[^\s"'<>)]+/g;
const WEB_RESOURCE_PROBE_TIMEOUT_MS = 5_000;
const MAX_WEB_RESOURCE_PROBES = 12;

/**
 * Chrome reports a missing Fontsource file as an opaque-response block whose
 * timing varies with the CDN, so the daemon asks jsDelivr directly: a 404 is
 * the design's fault and repairable, an unreachable network is only a warning.
 */
async function probeWebResources(html: string, signal: AbortSignal, warnings: string[]): Promise<void> {
  const urls = [...new Set([...html.matchAll(WEB_RESOURCE_URL_IN_HTML)].map((match) => match[0]))]
    .filter(isDesignWebResourceUrl)
    .slice(0, MAX_WEB_RESOURCE_PROBES);
  const missing: string[] = [];
  const probe = createProviderFetch();
  await Promise.all(urls.map(async (url) => {
    try {
      const response = await probe(url, {
        method: "HEAD",
        signal: AbortSignal.any([signal, AbortSignal.timeout(WEB_RESOURCE_PROBE_TIMEOUT_MS)]),
      });
      if (response.status === 404 || response.status === 410) missing.push(`${response.status} ${url}`);
    } catch (error) {
      signal.throwIfAborted();
      warnings.push(`web resource unreachable (${error instanceof Error ? error.message : String(error)}): ${url}; the fallback font stack was rendered`);
    }
  }));
  if (missing.length > 0) {
    throw new DesignNodeRuntimeGateError(`Node runtime gate failed: a web resource does not exist (${missing[0]}); use a Fontsource id and file that exist, or remove the link`);
  }
}

export const runDesignNodeRuntimeGate: DesignNodeRuntimeGateRunner = async ({ html, signal, assets: descriptors, options = {} }) => {
  signal.throwIfAborted();
  const assets = exactRuntimeAssets(descriptors);
  const screenshots: DesignNodeRuntimeGateScreenshot[] = [];
  const warnings: string[] = [];
  if (options.webResources) await probeWebResources(html, signal, warnings);
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
      const webResourceErrors: string[] = [];
      const pendingRequests = new Set<Promise<void>>();
      const openWebResources = new Set<string>();
      const onPageError = (event: unknown): void => {
        runtimeErrors.push(event instanceof Error ? event.message : String(event));
      };
      const onConsole = (message: { type(): string; text(): string }) => {
        // Web-resource failures are reported precisely by onResponse/onRequestFailed.
        if (message.type() === "error" && !isDesignWebResourceUrl(message.text().match(/https?:\/\/\S+/)?.[0] ?? "")) {
          runtimeErrors.push(message.text());
        }
      };
      const onResponse = (response: { url(): string; status(): number }): void => {
        openWebResources.delete(response.url());
        if (isDesignWebResourceUrl(response.url()) && response.status() >= 400) {
          webResourceErrors.push(`${response.status()} ${response.url()}`);
        }
      };
      const onRequestFailed = (request: { url(): string; failure(): { errorText: string } | null }): void => {
        openWebResources.delete(request.url());
        if (!isDesignWebResourceUrl(request.url())) return;
        const reason = request.failure()?.errorText ?? "network failure";
        // Being offline is not the design's fault; a missing Fontsource file (Chrome
        // surfaces the 404 as ERR_BLOCKED_BY_ORB) is, and the Agent must fix it.
        if (/ERR_(?:INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION_|TIMED_OUT|ADDRESS_UNREACHABLE|NETWORK_CHANGED|PROXY_|SSL_|CERT_|NETWORK_ACCESS_DENIED)/.test(reason)) {
          warnings.push(`web resource unreachable (${reason}): ${request.url()}; the fallback font stack was rendered`);
          return;
        }
        webResourceErrors.push(`${reason} ${request.url()}`);
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
          if (options.webResources && isDesignWebResourceUrl(url)) {
            openWebResources.add(url);
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
      page.on("response", onResponse);
      page.on("requestfailed", onRequestFailed);
      try {
        await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });
        await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 8_000 });
        while (pendingRequests.size > 0) await Promise.allSettled([...pendingRequests]);
        if (openWebResources.size > 0 || webResourceErrors.length > 0 || warnings.length > 0) {
          // Fontsource CSS and font files arrive over the network: wait until every
          // continued request has a response or a failure, then let fonts settle.
          const settleUntil = Date.now() + WEB_RESOURCE_SETTLE_MS;
          while (openWebResources.size > 0 && Date.now() < settleUntil) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          await page.waitForNetworkIdle({ idleTime: 400, timeout: Math.max(1, settleUntil - Date.now()) }).catch(() => {});
          await Promise.race([
            page.evaluate("document.fonts.ready.then(() => true)"),
            new Promise((resolve) => setTimeout(resolve, 3_000)),
          ]).catch(() => {});
        }
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
        if (webResourceErrors.length > 0) {
          throw new DesignNodeRuntimeGateError(`Node runtime gate failed at ${viewport.name}: a web resource could not be loaded (${webResourceErrors[0]}); use a Fontsource id and file that exist, or remove the link`);
        }
        if (options.lint) {
          const findings = await page.evaluate(QUALITY_LINT_SCRIPT) as string[];
          if (findings.length > 0) {
            throw new DesignNodeRuntimeGateError(`Quality lint failed at ${viewport.name}: ${findings.slice(0, 3).join("; ")}`);
          }
        }
        if (options.screenshots) {
          const documentHeight = await page.evaluate(
            "Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))",
          ) as number;
          const height = Math.min(Math.max(viewport.height, Number.isFinite(documentHeight) ? documentHeight : 0), MAX_SCREENSHOT_HEIGHT);
          if (height !== viewport.height) {
            await page.setViewport({ width: viewport.width, height, deviceScaleFactor: 1 });
          }
          const png = await page.screenshot({ type: "png" });
          screenshots.push({ viewport: viewport.name, width: viewport.width, height, png: Buffer.from(png) });
        }
      } finally {
        page.off("pageerror", onPageError);
        page.off("console", onConsole);
        page.off("request", onRequest);
        page.off("response", onResponse);
        page.off("requestfailed", onRequestFailed);
      }
    }
    return {
      viewports: VIEWPORTS.length,
      meaningfulElements,
      ...(options.screenshots ? { screenshots } : {}),
      ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
    };
  } finally {
    signal.removeEventListener("abort", abort);
    await browser.close().catch(() => {});
  }
};
