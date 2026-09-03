import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { join } from "node:path";
import { dedupModels, type AgentRunner } from "@dezin/agent";
import type { Settings } from "@dezin/core";
import type { AppDeps } from "../app.ts";
import { HttpError, readJsonBody, sendJson } from "../http-util.ts";
import { SharinganSession } from "../sharingan-browser.ts";
import { defaultRegistry } from "@dezin/design";
import { getDesignProject, type DesignProjectMetadata } from "./design-project-store.ts";
import {
  buildDesignMainSystemPrompt,
  cancelDesignGlobalJob,
  startDesignMainTurn,
  type DesignMainDispatch,
} from "./design-global-agents.ts";
import {
  buildDesignImplementationExportSystemPrompt,
  createProductionDesignImplementationExportAdapter,
  startDesignImplementationExport,
  type StartDesignImplementationExportInput,
} from "./design-implementation-export.ts";
import {
  buildDesignNodeAnalysisSystemPrompt,
  buildDesignNodeSystemPrompt,
  cancelDesignNodeTurn,
  createProductionDesignAnalysisRunner,
  createProductionDesignNodeRunner,
  productionDesignAgentEnvironment,
  startDesignNodeTurn,
  type DesignSystemContextInput,
} from "./design-node-agent.ts";
import { runDesignNodeRuntimeGate } from "./design-node-runtime-gate.ts";
import {
  DESIGN_WEB_RESOURCE_CSP_SOURCE,
  designSystemWebFonts,
  loadDesignIconSets,
  type DesignWebResourcesInput,
} from "./design-web-resources.ts";
import {
  designAgentProviderId,
  DesignAgentConfinementError,
  DesignAgentProviderUnsupportedError,
} from "./design-agent-confinement.ts";
import { createZip } from "../zip.ts";
import {
  activateDesignMainSession,
  buildDesignVersionExportBundle,
  buildPortableDesignVersionHtml,
  createDesignMainSession,
  deleteDesignMainSession,
  getDesignAssetManifest,
  getDesignCanvas,
  getDesignJob,
  getDesignJobByReceiptKey,
  getDesignThread,
  importDesignCanvasAssetBatch,
  listDesignAssets,
  listDesignJobs,
  listDesignMainSessions,
  listDesignVersions,
  mutateDesignCanvas,
  renameDesignMainSession,
  redoDesignCanvas,
  resolveDesignAssetFile,
  resolveDesignVersionPreview,
  resolvePinnedDesignAssetFile,
  storeDesignAsset,
  type DesignJobTerminalReceiptPolicy,
  undoDesignCanvas,
  MAX_DESIGN_ASSET_BATCH_BYTES,
  MAX_DESIGN_ASSET_BATCH_ITEMS,
  MAX_DESIGN_ASSET_BYTES,
} from "./design-storage.ts";
import {
  DESIGN_GENERATIVE_NODE_KINDS,
  type DesignCanvasIntent,
  type DesignJob,
  type DesignNodeGeometry,
  type DesignNodeKind,
} from "./design-types.ts";

/** Fontsource CSS and fonts are the only remote sources a preview may load, and only when Settings allow them. */
function webResourceCspSources(webResources: boolean): string {
  return webResources ? ` ${DESIGN_WEB_RESOURCE_CSP_SOURCE}` : "";
}

const previewCsp = (webResources: boolean): string => [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  `style-src 'unsafe-inline'${webResourceCspSources(webResources)}`,
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  `font-src 'self' data: blob:${webResourceCspSources(webResources)}`,
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "sandbox allow-scripts",
].join("; ");

const embeddedPreviewCsp = (webResources: boolean): string => [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  `style-src 'unsafe-inline'${webResourceCspSources(webResources)}`,
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  `font-src 'self' data: blob:${webResourceCspSources(webResources)}`,
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "sandbox allow-scripts",
].join("; ");

/**
 * Injected into the sandboxed exact-Version document. One private MessagePort
 * carries: right-click / annotate-click element descriptions, Escape, and the
 * document's natural size; the parent can only toggle annotate mode over it.
 */
const EMBEDDED_PREVIEW_BRIDGE = Buffer.from(
  [
    '<script data-dezin-embedded-preview-bridge>(()=>{const apply=Reflect.apply;',
    'const prevent=Event.prototype.preventDefault,stop=Event.prototype.stopImmediatePropagation;',
    'const portPost=MessagePort.prototype.postMessage,portStart=MessagePort.prototype.start;',
    'const parentPost=parent.postMessage,bytes=new Uint8Array(32);crypto.getRandomValues(bytes);',
    'let binary="";for(const byte of bytes)binary+=String.fromCharCode(byte);',
    'const nonce=btoa(binary).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/g,"");',
    'const channel=new MessageChannel();apply(portStart,channel.port1,[]);',
    'const post=(message)=>apply(portPost,channel.port1,[Object.assign({source:"dezin",nonce,protocol:1},message)]);',
    'const clean=(value,maximum)=>String(value||"").replace(/\\s+/g," ").trim().slice(0,maximum);',
    'const escapeCss=(value)=>globalThis.CSS&&typeof globalThis.CSS.escape==="function"?globalThis.CSS.escape(value):String(value).replace(/[^a-zA-Z0-9_-]/g,"\\\\$&");',
    'const segment=(element)=>{const tag=element.tagName.toLowerCase();const parent=element.parentElement;if(!parent)return tag;',
    'const siblings=Array.from(parent.children).filter((candidate)=>candidate.tagName===element.tagName);return siblings.length>1?`${tag}:nth-of-type(${siblings.indexOf(element)+1})`:tag;};',
    'const describe=(target,clientX,clientY)=>{',
    'const stable=target.id?`#${escapeCss(target.id)}`:target.getAttribute("data-dezin-id")?`[data-dezin-id="${String(target.getAttribute("data-dezin-id")).replace(/["\\\\]/g,"\\\\$&")}"]`:target.getAttribute("data-testid")?`[data-testid="${String(target.getAttribute("data-testid")).replace(/["\\\\]/g,"\\\\$&")}"]`:null;',
    'const parts=[];let cursor=target;while(cursor&&cursor!==document.documentElement&&parts.length<6){parts.unshift(segment(cursor));cursor=cursor.parentElement;}',
    'const selector=clean(stable||parts.join(" > "),1024)||target.tagName.toLowerCase();',
    'const path=[];cursor=target;while(cursor&&cursor!==document.documentElement&&path.length<6){const classes=Array.from(cursor.classList||[]).slice(0,2).map(escapeCss);path.unshift(cursor.tagName.toLowerCase()+(cursor.id?`#${escapeCss(cursor.id)}`:classes.length?`.${classes.join(".")}`:""));cursor=cursor.parentElement;}',
    'const rect=target.getBoundingClientRect();',
    'return {type:"embedded-preview-context-menu",clientX,clientY,tagName:target.tagName.toLowerCase(),selector,targetPath:clean(path.join(" > "),1024)||selector,nearbyText:clean(target.innerText||target.textContent,512),rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}};};',
    'const targetAt=(event)=>event.target instanceof Element&&event.target!==highlight?event.target:document.elementFromPoint(event.clientX,event.clientY);',
    'addEventListener("contextmenu",(event)=>{if(!event.isTrusted)return;apply(prevent,event,[]);apply(stop,event,[]);',
    'const target=targetAt(event);if(target)post(describe(target,event.clientX,event.clientY));},true);',
    // Annotate mode: hover outline + click-to-describe, toggled by the parent.
    'let annotating=false;const highlight=document.createElement("div");highlight.setAttribute("data-dezin-annotate-highlight","");',
    'highlight.style.cssText="position:fixed;z-index:2147483647;pointer-events:none;border:1.5px solid #0d99ff;background:rgba(13,153,255,.07);border-radius:2px;box-sizing:border-box;display:none;transition:top 60ms,left 60ms,width 60ms,height 60ms";',
    'const hideHighlight=()=>{highlight.style.display="none";};',
    'const moveHighlight=(target)=>{if(!target||target===highlight||target===document.documentElement||target===document.body){hideHighlight();return;}const rect=target.getBoundingClientRect();highlight.style.display="block";highlight.style.left=rect.left+"px";highlight.style.top=rect.top+"px";highlight.style.width=rect.width+"px";highlight.style.height=rect.height+"px";};',
    'const setAnnotating=(enabled)=>{annotating=!!enabled;document.documentElement.style.cursor=annotating?"crosshair":"";if(annotating){if(!highlight.isConnected)(document.body||document.documentElement).appendChild(highlight);}else hideHighlight();};',
    'addEventListener("mousemove",(event)=>{if(annotating)moveHighlight(targetAt(event));},true);',
    'addEventListener("mouseleave",()=>{if(annotating)hideHighlight();},true);',
    'addEventListener("scroll",()=>{if(annotating)hideHighlight();},true);',
    'addEventListener("click",(event)=>{if(!annotating||!event.isTrusted)return;apply(prevent,event,[]);apply(stop,event,[]);',
    'const target=targetAt(event);if(target)post(describe(target,event.clientX,event.clientY));},true);',
    'addEventListener("keydown",(event)=>{if(event.isTrusted&&event.key==="Escape")post({type:"embedded-preview-escape"});},true);',
    'channel.port1.onmessage=(event)=>{const data=event.data;if(!data||data.source!=="dezin-parent"||data.nonce!==nonce||data.protocol!==1)return;if(data.type==="annotate-mode")setAnnotating(data.enabled===true);};',
    // Natural document size so the Canvas can fit the Node frame to its content.
    'let lastLayout="",layoutFrame=0;const reportLayout=()=>{if(layoutFrame)return;layoutFrame=requestAnimationFrame(()=>{layoutFrame=0;',
    'const root=document.documentElement,body=document.body;const width=root.clientWidth||innerWidth;const height=Math.max(root.scrollHeight,body?body.scrollHeight:0,root.clientHeight);',
    'const key=width+"x"+height;if(!width||!height||key===lastLayout)return;lastLayout=key;post({type:"embedded-preview-layout",width,height});});};',
    'addEventListener("load",reportLayout);addEventListener("resize",reportLayout);',
    'if(typeof ResizeObserver==="function"){const observer=new ResizeObserver(reportLayout);observer.observe(document.documentElement);if(document.body)observer.observe(document.body);}',
    'if(document.readyState==="complete")reportLayout();',
    'apply(parentPost,parent,[{source:"dezin",type:"embedded-preview-context-menu-ready",',
    'nonce,protocol:1},"*",[channel.port2]]);})();</script>',
  ].join(""),
  "utf8",
);

const designCoverCaptures = new Map<string, Promise<Buffer>>();
let designCoverCaptureQueue = Promise.resolve();

function queuedDesignCoverCapture(task: () => Promise<Buffer>): Promise<Buffer> {
  // ponytail: one browser capture at a time; use a small worker pool if the gallery grows past dozens of projects.
  const capture = designCoverCaptureQueue.then(task, task);
  designCoverCaptureQueue = capture.then(() => undefined, () => undefined);
  return capture;
}

function sendDesignCover(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  contentType: "image/png" | "image/svg+xml",
): void {
  const checksum = createHash("sha256").update(body).digest("hex");
  const etag = `"sha256-${checksum}"`;
  const headers = {
    "content-type": contentType,
    "content-length": String(body.length),
    "cache-control": "public, max-age=31536000, immutable",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "x-content-type-options": "nosniff",
    // Public, immutable bytes: let the opaque-origin preview sandbox read pixels.
    "access-control-allow-origin": "*",
    etag,
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://127.0.0.1");
}

export function trustedDesignPreviewOrigin(socket: {
  localAddress?: string;
  localPort?: number;
}): string {
  if (!Number.isSafeInteger(socket.localPort) || socket.localPort! < 1 || socket.localPort! > 65_535
    || typeof socket.localAddress !== "string" || !socket.localAddress) {
    throw new TypeError("Design Export request socket address is unavailable");
  }
  let address = socket.localAddress;
  if (address.startsWith("::ffff:") && isIP(address.slice(7)) === 4) address = address.slice(7);
  if (address === "0.0.0.0" || address === "::") address = "127.0.0.1";
  const family = isIP(address);
  if (family === 0) throw new TypeError("Design Export request socket address is invalid");
  const host = family === 6 ? `[${address}]` : address;
  return new URL(`http://${host}:${socket.localPort}`).origin;
}

function exactRecord(value: unknown, label: string, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, `${label} must be an object`);
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).find((key) => !allowed.includes(key));
  if (extra) throw new HttpError(400, `${label} contains unexpected field: ${extra}`);
  return record;
}

function productionDesignRunner(input: {
  deps: AppDeps;
  projectId: string;
  settings: Settings;
  agentCommand: string;
  model: string | null;
  artifactOutput: boolean;
}): AgentRunner {
  try {
    const confinement = { dataDir: input.deps.dataDir, projectId: input.projectId };
    // A null effective model is intentional (for example after switching away
    // from the configured provider), so remove the settings fallback before
    // constructing the confined runner.
    const runnerSettings = input.model === null ? { ...input.settings, model: "" } : input.settings;
    const override = { agentCommand: input.agentCommand, model: input.model ?? undefined };
    return input.artifactOutput
      ? createProductionDesignNodeRunner(runnerSettings, confinement, override)
      : createProductionDesignAnalysisRunner(runnerSettings, confinement, override);
  } catch (error) {
    if (error instanceof DesignAgentProviderUnsupportedError
      || error instanceof DesignAgentConfinementError) {
      throw new HttpError(400, error.message);
    }
    throw error;
  }
}

function implementationExportStartInput(input: {
  deps: AppDeps;
  projectId: string;
  settings: Settings;
  agentCommand: string;
  model: string | null;
  sourcePreviewOrigin: string;
}): Omit<StartDesignImplementationExportInput, "canvasRevision"> {
  const brief = "Reimplement every selected Canvas Version as one coherent production application.";
  if (input.deps.designRunner) {
    return {
      dataDir: input.deps.dataDir,
      projectId: input.projectId,
      runner: input.deps.designRunner,
      sourcePreviewOrigin: input.sourcePreviewOrigin,
      systemPrompt: buildDesignImplementationExportSystemPrompt({ settings: input.settings, brief }),
      env: productionDesignAgentEnvironment(input.settings, input.agentCommand, input.deps.security?.token),
      model: input.model,
    };
  }
  try {
    return createProductionDesignImplementationExportAdapter({
      dataDir: input.deps.dataDir,
      projectId: input.projectId,
      settings: input.settings,
      agentCommand: input.agentCommand,
      model: input.model,
      sourcePreviewOrigin: input.sourcePreviewOrigin,
      brief,
      token: input.deps.security?.token,
    });
  } catch (error) {
    if (error instanceof DesignAgentProviderUnsupportedError
      || error instanceof DesignAgentConfinementError) {
      throw new HttpError(400, error.message);
    }
    throw error;
  }
}

function boundedString(value: unknown, label: string, maximum: number, optional = false): string | undefined {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maximum) {
    throw new HttpError(400, `${label} is invalid`);
  }
  return value.trim();
}

/** Undefined inherits Settings; null explicitly requests the provider's default model. */
function optionalDesignModel(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  const model = boundedString(value, "model", 512)!;
  if (dedupModels([model]).length !== 1) throw new HttpError(400, "model is invalid");
  return model;
}

function effectiveDesignAgent(
  settings: Settings,
  override: { agentCommand?: string; model?: string | null },
): { agentCommand: string; model: string | null } {
  const settingsAgentCommand = settings.agentCommand.trim() || "claude";
  const agentCommand = (override.agentCommand ?? settingsAgentCommand).trim() || "claude";
  const settingsModel = settings.model.trim();
  const model = override.model !== undefined
    ? override.model
    : (agentCommand === settingsAgentCommand ? settingsModel || null : null);
  if (model !== null && dedupModels([model]).length !== 1) throw new HttpError(400, "model is invalid");
  return {
    agentCommand,
    model,
  };
}

function retryDesignAgent(
  settings: Settings,
  failedJob: DesignJob,
  body: Record<string, unknown>,
): { agentCommand: string; model: string | null } {
  const explicitAgentCommand = boundedString(body.agentCommand, "agentCommand", 512, true);
  const explicitModel = optionalDesignModel(body.model);
  const current = effectiveDesignAgent(settings, { agentCommand: explicitAgentCommand });
  const providerCompatible = designAgentProviderId(current.agentCommand) === failedJob.runnerId;
  return {
    agentCommand: current.agentCommand,
    model: body.model !== undefined
      ? explicitModel ?? null
      : providerCompatible
        ? failedJob.model
        : explicitAgentCommand === undefined
          ? current.model
          : null,
  };
}

function superviseDesignExecution(
  deps: AppDeps,
  projectId: string,
  execution: { job: DesignJob; completion: Promise<DesignJob> },
): void {
  deps.runtimeSupervisor!.superviseDetachedOperation(
    { projectId },
    execution.completion,
    () => execution.job.kind === "node-generation" || execution.job.kind === "node-analysis"
      ? cancelDesignNodeTurn(deps.dataDir, projectId, execution.job.id)
      : cancelDesignGlobalJob(deps.dataDir, projectId, execution.job.id),
  );
}

function sendImmutableHtml(req: IncomingMessage, res: ServerResponse, html: Buffer, checksum: string, webResources: boolean): void {
  const etag = `"sha256-${checksum}"`;
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(html.length),
    "cache-control": "public, max-age=31536000, immutable",
    etag,
    "content-security-policy": previewCsp(webResources),
    "x-content-type-options": "nosniff",
    "x-dns-prefetch-control": "off",
    "referrer-policy": "no-referrer",
  };
  if (req.headers["if-none-match"] === etag) {
    const { "content-length": _length, ...notModifiedHeaders } = headers;
    res.writeHead(304, notModifiedHeaders);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : html);
}

function instrumentEmbeddedPreview(html: Buffer): Buffer {
  const source = html.toString("latin1");
  const doctype = /^\uFEFF?\s*<!doctype\s+html\s*>/i.exec(source);
  const insertionIndex = doctype !== null ? doctype.index + doctype[0].length : 0;
  return Buffer.concat([
    html.subarray(0, insertionIndex),
    EMBEDDED_PREVIEW_BRIDGE,
    html.subarray(insertionIndex),
  ]);
}

function sendEmbeddedPreviewHtml(req: IncomingMessage, res: ServerResponse, html: Buffer, webResources: boolean): void {
  const checksum = createHash("sha256").update(html).digest("hex");
  const etag = `"sha256-${checksum}"`;
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(html.length),
    "cache-control": "private, no-cache",
    etag,
    "content-security-policy": embeddedPreviewCsp(webResources),
    "x-content-type-options": "nosniff",
    "x-dns-prefetch-control": "off",
    "referrer-policy": "no-referrer",
  };
  if (req.headers["if-none-match"] === etag) {
    const { "content-length": _length, ...notModifiedHeaders } = headers;
    res.writeHead(304, notModifiedHeaders);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : html);
}

function sendPortablePreviewHtml(
  req: IncomingMessage,
  res: ServerResponse,
  html: Buffer,
  checksum: string,
  fileName: string,
): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(html.length),
    "content-disposition": contentDisposition(fileName),
    "cache-control": "private, no-store",
    etag: `"sha256-${checksum}"`,
    "x-content-type-options": "nosniff",
    "x-dns-prefetch-control": "off",
    "referrer-policy": "no-referrer",
  });
  res.end(req.method === "HEAD" ? undefined : html);
}

function activeDocument(mimeType: string): boolean {
  return mimeType === "text/html" || mimeType === "application/xhtml+xml" || mimeType === "image/svg+xml"
    || mimeType === "application/pdf" || mimeType.endsWith("+xml") || mimeType === "application/xml";
}

function inlineAsset(mimeType: string): boolean {
  return (mimeType.startsWith("image/") && mimeType !== "image/svg+xml")
    || mimeType.startsWith("video/") || mimeType.startsWith("audio/") || mimeType.startsWith("font/")
    || (mimeType.startsWith("text/") && mimeType !== "text/html")
    || [
      "application/pdf",
      "application/font-woff",
      "application/font-woff2",
      "application/vnd.ms-fontobject",
    ].includes(mimeType);
}

function contentDisposition(name: string): string {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename*=UTF-8''${encoded}`;
}

function rangeFor(value: string | undefined, size: number): { start: number; end: number } | null {
  if (value === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (match[1] === "" && match[2] === "")) throw new HttpError(416, "invalid or multiple byte range");
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new HttpError(416, "invalid byte range");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    throw new HttpError(416, "byte range is not satisfiable");
  }
  return { start, end: Math.min(end, size - 1) };
}

async function sendAsset(
  req: IncomingMessage,
  res: ServerResponse,
  resolved: { path: string; manifest: Awaited<ReturnType<typeof getDesignAssetManifest>> },
): Promise<void> {
  const etag = `"sha256-${resolved.manifest.checksum}"`;
  const baseHeaders: Record<string, string> = {
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=31536000, immutable",
    etag,
    "x-content-type-options": "nosniff",
    "content-type": resolved.manifest.mimeType,
    // Assets are public-read and content-addressed. Without this header the
    // sandboxed (opaque-origin) preview cannot use them in canvas or WebGL.
    "access-control-allow-origin": "*",
  };
  if (!inlineAsset(resolved.manifest.mimeType)) {
    baseHeaders["content-disposition"] = contentDisposition(resolved.manifest.name);
  }
  if (activeDocument(resolved.manifest.mimeType)) {
    baseHeaders["content-security-policy"] = "default-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox";
  }
  if (req.headers["if-none-match"] === etag && req.headers.range === undefined) {
    res.writeHead(304, baseHeaders);
    res.end();
    return;
  }
  let range: { start: number; end: number } | null;
  try {
    range = rangeFor(Array.isArray(req.headers.range) ? req.headers.range[0] : req.headers.range, resolved.manifest.bytes);
  } catch (error) {
    if (error instanceof HttpError && error.status === 416) {
      res.writeHead(416, { ...baseHeaders, "content-range": `bytes */${resolved.manifest.bytes}` });
      res.end();
      return;
    }
    throw error;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? resolved.manifest.bytes - 1;
  const headers = {
    ...baseHeaders,
    "content-length": String(end - start + 1),
    ...(range === null ? {} : { "content-range": `bytes ${start}-${end}/${resolved.manifest.bytes}` }),
  };
  res.writeHead(range === null ? 200 : 206, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(resolved.path, { start, end });
    const done = () => {
      stream.removeListener("error", reject);
      res.removeListener("finish", done);
      res.removeListener("close", done);
      resolve();
    };
    stream.once("error", reject);
    res.once("finish", done);
    res.once("close", done);
    stream.pipe(res);
  });
}

export async function handleGetDesignCanvas(
  _req: IncomingMessage, res: ServerResponse, params: Record<string, string>, deps: AppDeps,
): Promise<void> {
  sendJson(res, 200, await getDesignCanvas(deps.dataDir, params.id!));
}

export async function handleServeDesignCover(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  const [canvas, project] = await Promise.all([
    getDesignCanvas(deps.dataDir, projectId),
    getDesignProject(deps.dataDir, projectId),
  ]);
  if (!project) throw new HttpError(404, "Design Project not found");
  const nodesById = new Map(canvas.nodes.map((node) => [node.id, node]));
  const ordered = canvas.nodeOrder.flatMap((id) => {
    const node = nodesById.get(id);
    return node ? [node] : [];
  });
  const hasPreview = (node: (typeof canvas.nodes)[number]) =>
    node.selectedVersionId !== null || node.currentVersionId !== null;
  const candidate = ordered.find((node) => node.kind === "page" && hasPreview(node))
    ?? ordered.find((node) => DESIGN_GENERATIVE_NODE_KINDS.includes(node.kind as (typeof DESIGN_GENERATIVE_NODE_KINDS)[number]) && hasPreview(node))
    ?? ordered.find((node) => node.kind === "image" && hasPreview(node));
  // No synthetic cover: the web shows its own themed placeholder when this 404s.
  const noCover = () => new HttpError(404, "Design Project has no cover yet");
  if (!candidate) throw noCover();

  const versionId = candidate.selectedVersionId ?? candidate.currentVersionId!;
  let resolved: Awaited<ReturnType<typeof resolveDesignVersionPreview>>;
  try {
    resolved = await resolveDesignVersionPreview(deps.dataDir, projectId, candidate.id, versionId);
  } catch {
    throw noCover();
  }
  if (resolved.kind === "asset") {
    if (resolved.assetManifest.mimeType.startsWith("image/") && resolved.assetManifest.mimeType !== "image/svg+xml") {
      await sendAsset(req, res, { path: resolved.path, manifest: resolved.assetManifest });
      return;
    }
    throw noCover();
  }

  const coverRoot = join(deps.dataDir, "projects", projectId, "design", "cover");
  const coverPath = join(coverRoot, "cover.png");
  const metadataPath = join(coverRoot, "cover.json");
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as { nodeId?: unknown; versionId?: unknown };
    if (metadata.nodeId === candidate.id && metadata.versionId === versionId) {
      const cached = await readFile(coverPath);
      if (cached.length > 0) {
        sendDesignCover(req, res, cached, "image/png");
        return;
      }
    }
  } catch {
    // A cover is disposable derived data; a cache miss or partial write simply regenerates it.
  }

  const key = `${projectId}:${candidate.id}:${versionId}`;
  let capture = designCoverCaptures.get(key);
  if (!capture) {
    capture = queuedDesignCoverCapture(async () => {
      const origin = trustedDesignPreviewOrigin(req.socket);
      const previewUrl = new URL(
        `/api/projects/${encodeURIComponent(projectId)}/design-canvas/nodes/${encodeURIComponent(candidate.id)}/versions/${encodeURIComponent(versionId)}/preview`,
        origin,
      ).href;
      const session = await SharinganSession.open(previewUrl, { headless: true });
      try {
        await session.setViewport({ width: 1200, height: 750, label: "cover" });
        await session.settle(2_500);
        const png = await session.screenshot({ fullPage: false });
        await mkdir(coverRoot, { recursive: true });
        const suffix = randomUUID();
        const temporaryCover = join(coverRoot, `cover-${suffix}.png`);
        const temporaryMetadata = join(coverRoot, `cover-${suffix}.json`);
        try {
          await writeFile(temporaryCover, png, { flag: "wx", mode: 0o600 });
          await rename(temporaryCover, coverPath);
          await writeFile(temporaryMetadata, JSON.stringify({ nodeId: candidate.id, versionId }), { flag: "wx", mode: 0o600 });
          await rename(temporaryMetadata, metadataPath);
        } finally {
          await Promise.all([
            rm(temporaryCover, { force: true }).catch(() => {}),
            rm(temporaryMetadata, { force: true }).catch(() => {}),
          ]);
        }
        return png;
      } finally {
        await session.close();
      }
    });
    designCoverCaptures.set(key, capture);
    void capture.finally(() => designCoverCaptures.delete(key)).catch(() => {});
  }
  let png: Buffer;
  try {
    png = await capture;
  } catch {
    throw noCover();
  }
  sendDesignCover(req, res, png, "image/png");
}

export async function handlePutDesignCanvas(
  req: IncomingMessage, res: ServerResponse, params: Record<string, string>, deps: AppDeps,
): Promise<void> {
  const body = exactRecord(await readJsonBody(req), "Design canvas mutation", ["expectedRevision", "intents"]);
  if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0
    || !Array.isArray(body.intents)) throw new HttpError(400, "Design canvas mutation is invalid");
  sendJson(res, 200, await mutateDesignCanvas(deps.dataDir, params.id!, {
    expectedRevision: body.expectedRevision as number,
    intents: body.intents as DesignCanvasIntent[],
  }));
}

async function historyRequest(req: IncomingMessage): Promise<number> {
  const body = exactRecord(await readJsonBody(req), "Design canvas history request", ["expectedRevision"]);
  if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0) {
    throw new HttpError(400, "expectedRevision is invalid");
  }
  return body.expectedRevision as number;
}

export async function handleUndoDesignCanvas(req: IncomingMessage, res: ServerResponse, p: Record<string, string>, d: AppDeps): Promise<void> {
  sendJson(res, 200, await undoDesignCanvas(d.dataDir, p.id!, await historyRequest(req)));
}

export async function handleRedoDesignCanvas(req: IncomingMessage, res: ServerResponse, p: Record<string, string>, d: AppDeps): Promise<void> {
  sendJson(res, 200, await redoDesignCanvas(d.dataDir, p.id!, await historyRequest(req)));
}

export async function handleListDesignAssets(_req: IncomingMessage, res: ServerResponse, p: Record<string, string>, d: AppDeps): Promise<void> {
  sendJson(res, 200, await listDesignAssets(d.dataDir, p.id!));
}

export async function handleCreateDesignAsset(req: IncomingMessage, res: ServerResponse, p: Record<string, string>, d: AppDeps): Promise<void> {
  const body = exactRecord(
    await readJsonBody(req, Math.ceil(MAX_DESIGN_ASSET_BYTES * 4 / 3) + 1024 * 1024),
    "Design Asset",
    ["name", "mimeType", "base64", "uploadedFileId", "sourceVersion"],
  );
  const name = boundedString(body.name, "Asset name", 240)!;
  const sources = [body.base64 !== undefined, body.uploadedFileId !== undefined, body.sourceVersion !== undefined]
    .filter(Boolean).length;
  if (sources !== 1) throw new HttpError(400, "Provide exactly one Asset source");
  const mimeType = boundedString(body.mimeType, "Asset mimeType", 120, body.sourceVersion !== undefined);
  let sourceVersion: { projectId: string; nodeId: string; versionId: string } | undefined;
  if (body.sourceVersion !== undefined) {
    const source = exactRecord(body.sourceVersion, "sourceVersion", ["projectId", "nodeId", "versionId"]);
    sourceVersion = {
      projectId: boundedString(source.projectId, "Source Project id", 128)!,
      nodeId: boundedString(source.nodeId, "Source Node id", 128)!,
      versionId: boundedString(source.versionId, "Source Version id", 128)!,
    };
  }
  sendJson(res, 201, await storeDesignAsset(d.dataDir, p.id!, {
    name,
    ...(mimeType ? { mimeType } : {}),
    ...(body.base64 === undefined ? {} : { base64: boundedString(body.base64, "Asset base64", Math.ceil(MAX_DESIGN_ASSET_BYTES * 4 / 3) + 4)! }),
    ...(body.uploadedFileId === undefined ? {} : { uploadedFileId: boundedString(body.uploadedFileId, "uploadedFileId", 96)! }),
    ...(sourceVersion ? { sourceVersion } : {}),
  }));
}

function stagedDesignUploadPath(dataDir: string, projectId: string, uploadedFileId: string): string | null {
  const match = /^\.refs\/(design-upload-[a-f0-9-]{36})$/.exec(uploadedFileId);
  return match ? join(dataDir, "projects", projectId, ".refs", match[1]!) : null;
}

export async function handleStageDesignVideo(req: IncomingMessage, res: ServerResponse, p: Record<string, string>, d: AppDeps): Promise<void> {
  await getDesignCanvas(d.dataDir, p.id!);
  const contentType = String(req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
  if (!contentType.startsWith("video/")) throw new HttpError(415, "Design video upload requires a video content type");
  const uploadedFileId = `.refs/design-upload-${randomUUID()}`;
  const path = stagedDesignUploadPath(d.dataDir, p.id!, uploadedFileId)!;
  await mkdir(join(d.dataDir, "projects", p.id!, ".refs"), { recursive: true });
  const handle = await open(path, "wx", 0o600);
  let bytes = 0;
  try {
    for await (const value of req) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      let offset = 0;
      while (offset < chunk.length) {
        const written = await handle.write(chunk, offset, chunk.length - offset, bytes + offset);
        if (written.bytesWritten < 1) throw new HttpError(500, "Design video upload stopped before completion");
        offset += written.bytesWritten;
      }
      bytes += chunk.length;
      if (!Number.isSafeInteger(bytes)) throw new HttpError(413, "Design video is too large for this filesystem");
    }
    if (bytes < 1) throw new HttpError(400, "Design video upload is empty");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(path, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();
  sendJson(res, 201, { uploadedFileId, bytes });
}

export async function handleImportDesignAssets(req: IncomingMessage, res: ServerResponse, p: Record<string, string>, d: AppDeps): Promise<void> {
  const body = exactRecord(
    await readJsonBody(req, Math.ceil(MAX_DESIGN_ASSET_BATCH_BYTES * 4 / 3) + 2 * 1024 * 1024),
    "Design Asset import",
    ["expectedRevision", "items"],
  );
  if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0
    || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > MAX_DESIGN_ASSET_BATCH_ITEMS) {
    throw new HttpError(400, "Design Asset import is invalid");
  }
  const items = body.items.map((value, index) => {
    const item = exactRecord(value, `Design Asset import item ${index}`, ["asset", "binding"]);
    const asset = exactRecord(item.asset, `Design Asset import item ${index}.asset`, [
      "name", "mimeType", "base64", "uploadedFileId", "sourceVersion",
    ]);
    const hasBase64 = asset.base64 !== undefined;
    const hasUploaded = asset.uploadedFileId !== undefined;
    const hasSourceVersion = asset.sourceVersion !== undefined;
    if (Number(hasBase64) + Number(hasUploaded) + Number(hasSourceVersion) !== 1) {
      throw new HttpError(400, `Design Asset import item ${index} must have exactly one source`);
    }
    let sourceVersion: { projectId: string; nodeId: string; versionId: string } | undefined;
    if (hasSourceVersion) {
      const source = exactRecord(asset.sourceVersion, `Design Asset import item ${index}.sourceVersion`, [
        "projectId", "nodeId", "versionId",
      ]);
      sourceVersion = {
        projectId: boundedString(source.projectId, "Source Project id", 128)!,
        nodeId: boundedString(source.nodeId, "Source Node id", 128)!,
        versionId: boundedString(source.versionId, "Source Version id", 128)!,
      };
    }
    const binding = exactRecord(item.binding, `Design Asset import item ${index}.binding`, ["type", "node", "nodeId"]);
    const bindingType = boundedString(binding.type, `Design Asset import item ${index}.binding.type`, 32)!;
    let parsedBinding;
    if (bindingType === "create-node") {
      if (binding.nodeId !== undefined) {
        throw new HttpError(400, `Design Asset import item ${index}.binding.nodeId is only valid for append-version`);
      }
      const node = exactRecord(
        binding.node,
        `Design Asset import item ${index}.binding.node`,
        ["id", "kind", "name", "geometry"],
      );
      let geometry: Partial<DesignNodeGeometry> | undefined;
      if (node.geometry !== undefined) {
        const raw = exactRecord(
          node.geometry,
          `Design Asset import item ${index}.binding.node.geometry`,
          ["x", "y", "width", "height"],
        );
        for (const [key, coordinate] of Object.entries(raw)) {
          if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) {
            throw new HttpError(400, `Design Asset import item ${index}.binding.node.geometry.${key} is invalid`);
          }
        }
        geometry = raw as Partial<DesignNodeGeometry>;
      }
      parsedBinding = {
        type: "create-node" as const,
        node: {
          ...(node.id === undefined ? {} : { id: boundedString(node.id, "Node id", 128)! }),
          kind: boundedString(node.kind, "Node kind", 64)! as DesignNodeKind,
          ...(node.name === undefined ? {} : { name: boundedString(node.name, "Node name", 240)! }),
          ...(geometry === undefined ? {} : { geometry }),
        },
      };
    } else if (bindingType === "append-version") {
      if (binding.node !== undefined) {
        throw new HttpError(400, `Design Asset import item ${index}.binding.node is only valid for create-node`);
      }
      parsedBinding = {
        type: "append-version" as const,
        nodeId: boundedString(binding.nodeId, "Node id", 128)!,
      };
    } else {
      throw new HttpError(400, `Design Asset import item ${index}.binding.type is unsupported`);
    }
    return {
      asset: {
        name: boundedString(asset.name, "Asset name", 240)!,
        ...(asset.mimeType === undefined ? {} : {
          mimeType: boundedString(asset.mimeType, "Asset mimeType", 120)!,
        }),
        ...(hasBase64 ? {
          base64: boundedString(asset.base64, "Asset base64", Math.ceil(MAX_DESIGN_ASSET_BYTES * 4 / 3) + 4)!,
        } : hasUploaded ? {
          uploadedFileId: boundedString(asset.uploadedFileId, "uploadedFileId", 96)!,
        } : { sourceVersion: sourceVersion! }),
      },
      binding: parsedBinding,
    };
  });
  const stagedUploadPaths = items.flatMap((item) => {
    const uploadedFileId = "uploadedFileId" in item.asset ? item.asset.uploadedFileId : undefined;
    if (!uploadedFileId) return [];
    const path = stagedDesignUploadPath(d.dataDir, p.id!, uploadedFileId);
    return path ? [path] : [];
  });
  try {
    const canvas = await importDesignCanvasAssetBatch(d.dataDir, p.id!, {
      expectedRevision: body.expectedRevision as number,
      items,
    });
    sendJson(res, 200, canvas);
  } finally {
    await Promise.all(stagedUploadPaths.map((path) => rm(path, { force: true }).catch(() => {})));
  }
}

export async function handleServeDesignAssetContent(req: IncomingMessage, res: ServerResponse, p: Record<string, string>, d: AppDeps): Promise<void> {
  const manifest = await getDesignAssetManifest(d.dataDir, p.id!, p.assetId!);
  await sendAsset(req, res, await resolveDesignAssetFile(d.dataDir, p.id!, p.assetId!, manifest.fileName));
}

export async function handleServePinnedDesignAsset(req: IncomingMessage, res: ServerResponse, p: Record<string, string>, d: AppDeps): Promise<void> {
  const query = requestUrl(req).searchParams;
  if ([...query.keys()].some((key) => !["nodeId", "versionId", "checksum"].includes(key))
    || query.getAll("nodeId").length !== 1 || query.getAll("versionId").length !== 1 || query.getAll("checksum").length !== 1) {
    throw new HttpError(400, "exact Node Version Asset pin is required");
  }
  const resolved = await resolvePinnedDesignAssetFile(d.dataDir, p.id!, {
    nodeId: query.get("nodeId")!,
    versionId: query.get("versionId")!,
    checksum: query.get("checksum")!,
    assetId: p.assetId!,
    requestedFile: p.rest!,
  });
  await sendAsset(req, res, resolved);
}

export async function handleListDesignVersions(_req: IncomingMessage, res: ServerResponse, p: Record<string, string>, d: AppDeps): Promise<void> {
  sendJson(res, 200, await listDesignVersions(d.dataDir, p.id!, p.nodeId!));
}

export async function handleServeDesignVersionPreview(req: IncomingMessage, res: ServerResponse, p: Record<string, string>, d: AppDeps): Promise<void> {
  const resolved = await resolveDesignVersionPreview(d.dataDir, p.id!, p.nodeId!, p.versionId!);
  if (resolved.kind === "asset") {
    await sendAsset(req, res, { path: resolved.path, manifest: resolved.assetManifest });
    return;
  }
  const html = await readFile(resolved.path);
  if (html.length !== resolved.manifest.bytes
    || createHash("sha256").update(html).digest("hex") !== resolved.manifest.checksum) {
    throw new HttpError(409, "Design Version changed after integrity verification");
  }
  sendImmutableHtml(req, res, html, resolved.manifest.checksum, d.store.getSettings().webResources);
}

export async function handleServeEmbeddedDesignVersionPreview(req: IncomingMessage, res: ServerResponse, p: Record<string, string>, d: AppDeps): Promise<void> {
  const resolved = await resolveDesignVersionPreview(d.dataDir, p.id!, p.nodeId!, p.versionId!);
  if (resolved.kind === "asset") {
    throw new HttpError(415, "Embedded preview requires an HTML Design Version");
  }
  const html = await readFile(resolved.path);
  if (html.length !== resolved.manifest.bytes
    || createHash("sha256").update(html).digest("hex") !== resolved.manifest.checksum) {
    throw new HttpError(409, "Design Version changed after integrity verification");
  }
  sendEmbeddedPreviewHtml(req, res, instrumentEmbeddedPreview(html), d.store.getSettings().webResources);
}

export async function handleDownloadPortableDesignVersionPreview(req: IncomingMessage, res: ServerResponse, p: Record<string, string>, d: AppDeps): Promise<void> {
  const portable = await buildPortableDesignVersionHtml(d.dataDir, p.id!, p.nodeId!, p.versionId!);
  sendPortablePreviewHtml(req, res, portable.html, portable.checksum, `dezin-preview-${p.versionId!}.html`);
}

export async function handleDownloadDesignVersionExportBundle(req: IncomingMessage, res: ServerResponse, p: Record<string, string>, d: AppDeps): Promise<void> {
  const bundle = await buildDesignVersionExportBundle(d.dataDir, p.id!, p.nodeId!, p.versionId!);
  const zip = createZip(bundle.files.map((file) => ({ path: file.path, data: file.bytes })));
  res.writeHead(200, {
    "content-type": "application/zip",
    "content-length": String(zip.length),
    "content-disposition": contentDisposition(`dezin-export-${p.versionId!}.zip`),
    "cache-control": "private, no-store",
    etag: `"sha256-${bundle.checksum}"`,
    "x-content-type-options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : zip);
}

export async function handleGetMainDesignThread(_req: IncomingMessage, res: ServerResponse, p: Record<string, string>, d: AppDeps): Promise<void> {
  sendJson(res, 200, await getDesignThread(d.dataDir, p.id!, { type: "main" }));
}

export async function handleListMainDesignSessions(_req: IncomingMessage, res: ServerResponse, p: Record<string, string>, d: AppDeps): Promise<void> {
  sendJson(res, 200, await listDesignMainSessions(d.dataDir, p.id!));
}

export async function handleCreateMainDesignSession(_req: IncomingMessage, res: ServerResponse, p: Record<string, string>, d: AppDeps): Promise<void> {
  sendJson(res, 201, await createDesignMainSession(d.dataDir, p.id!));
}

export async function handleActivateMainDesignSession(_req: IncomingMessage, res: ServerResponse, p: Record<string, string>, d: AppDeps): Promise<void> {
  sendJson(res, 200, await activateDesignMainSession(d.dataDir, p.id!, p.sessionId!));
}

export async function handleRenameMainDesignSession(req: IncomingMessage, res: ServerResponse, p: Record<string, string>, d: AppDeps): Promise<void> {
  const body = exactRecord(await readJsonBody(req), "Main Agent session", ["title"]);
  const title = body.title === null ? null : boundedString(body.title, "Main Agent session title", 160)!;
  sendJson(res, 200, await renameDesignMainSession(d.dataDir, p.id!, p.sessionId!, title));
}

export async function handleDeleteMainDesignSession(_req: IncomingMessage, res: ServerResponse, p: Record<string, string>, d: AppDeps): Promise<void> {
  sendJson(res, 200, await deleteDesignMainSession(d.dataDir, p.id!, p.sessionId!));
}

export async function handleGetNodeDesignThread(_req: IncomingMessage, res: ServerResponse, p: Record<string, string>, d: AppDeps): Promise<void> {
  sendJson(res, 200, await getDesignThread(d.dataDir, p.id!, { type: "node", nodeId: p.nodeId! }));
}

/** The design system a Project's Agents design inside: its pick, else the registry default. */
function projectDesignSystem(d: AppDeps, project: DesignProjectMetadata | null): DesignSystemContextInput | null {
  const registry = d.designRegistry ?? defaultRegistry();
  const system = (project?.designSystemId ? registry.get(project.designSystemId) : null) ?? registry.default();
  if (!system) return null;
  return { id: system.id, name: system.name, summary: system.summary, designMd: system.designMd, tokensCss: system.tokensCss };
}

/**
 * Web resources for one Node turn: the design system's Fontsource ids plus the
 * cached icon catalogs. Null when Settings keep generation fully offline.
 */
async function designWebResources(
  d: AppDeps,
  settings: Settings,
  designSystem: DesignSystemContextInput | null,
): Promise<DesignWebResourcesInput | null> {
  if (!settings.webResources) return null;
  return {
    fonts: designSystem ? designSystemWebFonts(designSystem.tokensCss) : [],
    iconSets: await loadDesignIconSets(d.dataDir, d.designRunner === undefined ? {} : { sets: [] }),
  };
}

function designQuality(settings: Settings): { lint: boolean; visualReview: boolean } {
  return { lint: settings.qualityLint, visualReview: settings.visualReview };
}

export async function handleDesignNodeTurn(req: IncomingMessage, res: ServerResponse, p: Record<string, string>, d: AppDeps): Promise<void> {
  const body = exactRecord(await readJsonBody(req), "Node Agent turn", [
    "message", "context", "agentCommand", "model", "idempotencyKey",
  ]);
  const message = boundedString(body.message, "Node Agent message", 256 * 1024)!;
  let contextNodeIds: string[] = [];
  if (body.context !== undefined) {
    const context = exactRecord(body.context, "Node Agent context", ["nodeIds"]);
    if (!Array.isArray(context.nodeIds) || context.nodeIds.length > 100
      || context.nodeIds.some((value) => typeof value !== "string" || value.length < 1 || value.length > 128)) {
      throw new HttpError(400, "Node Agent context.nodeIds is invalid");
    }
    contextNodeIds = context.nodeIds as string[];
  }
  const canvas = await getDesignCanvas(d.dataDir, p.id!);
  const node = canvas.nodes.find((candidate) => candidate.id === p.nodeId!);
  if (!node) throw new HttpError(404, "Design Node not found");
  if (contextNodeIds.some((nodeId) => !canvas.nodeOrder.includes(nodeId))) {
    throw new HttpError(400, "Node Agent context references a Node outside the canvas");
  }
  const settings = d.store.getSettings();
  const project = await getDesignProject(d.dataDir, p.id!).catch(() => null);
  const designSystem = projectDesignSystem(d, project);
  const webResources = await designWebResources(d, settings, designSystem);
  const execution = effectiveDesignAgent(settings, {
    agentCommand: boundedString(body.agentCommand, "agentCommand", 512, true),
    model: optionalDesignModel(body.model),
  });
  const idempotencyKey = boundedString(body.idempotencyKey, "idempotencyKey", 160, true);
  const generative = (DESIGN_GENERATIVE_NODE_KINDS as readonly string[]).includes(node.kind);
  const runner = d.designRunner ?? productionDesignRunner({
    deps: d,
    projectId: p.id!,
    settings,
    agentCommand: execution.agentCommand,
    model: execution.model,
    artifactOutput: generative,
  });
  const systemPrompt = generative
    ? buildDesignNodeSystemPrompt({ settings, message, node, designSystem, webResources })
    : buildDesignNodeAnalysisSystemPrompt({ settings, message, node });
  const started = await startDesignNodeTurn({
    designSystem,
    webResources,
    quality: designQuality(settings),
    dataDir: d.dataDir,
    projectId: p.id!,
    nodeId: p.nodeId!,
    message,
    runner,
    systemPrompt,
    contextNodeIds,
    idempotencyKey: idempotencyKey ?? null,
    env: productionDesignAgentEnvironment(settings, execution.agentCommand, d.security?.token),
    model: execution.model,
    runtimeGate: d.designRunner === undefined && generative ? runDesignNodeRuntimeGate : undefined,
  });
  if (!started.reused) superviseDesignExecution(d, p.id!, started);
  sendJson(res, started.reused ? 200 : 202, { thread: started.thread, job: started.job, canvas: await getDesignCanvas(d.dataDir, p.id!) });
}

function designAgentTurnBody(
  body: Record<string, unknown>,
  label: string,
): {
  message: string;
  contextNodeIds: string[];
  agentCommand?: string;
  model?: string | null;
  idempotencyKey?: string;
} {
  const message = boundedString(body.message, `${label} message`, 256 * 1024)!;
  let contextNodeIds: string[] = [];
  if (body.context !== undefined) {
    const context = exactRecord(body.context, `${label} context`, ["nodeIds"]);
    if (!Array.isArray(context.nodeIds) || context.nodeIds.length > 100
      || context.nodeIds.some((value) => typeof value !== "string" || value.length < 1 || value.length > 128)) {
      throw new HttpError(400, `${label} context.nodeIds is invalid`);
    }
    contextNodeIds = context.nodeIds as string[];
  }
  return {
    message,
    contextNodeIds,
    agentCommand: boundedString(body.agentCommand, "agentCommand", 512, true),
    model: optionalDesignModel(body.model),
    idempotencyKey: boundedString(body.idempotencyKey, "idempotencyKey", 160, true),
  };
}

export interface StartDesignMainAgentRequest {
  message: string;
  contextNodeIds: string[];
  agentCommand?: string;
  model?: string | null;
  idempotencyKey?: string | null;
  terminalReceiptPolicy?: DesignJobTerminalReceiptPolicy;
}

export async function startDesignMainAgentTurn(
  d: AppDeps,
  projectId: string,
  parsed: StartDesignMainAgentRequest,
) {
  const settings = d.store.getSettings();
  const project = await getDesignProject(d.dataDir, projectId).catch(() => null);
  const designSystem = projectDesignSystem(d, project);
  const webResources = await designWebResources(d, settings, designSystem);
  const execution = effectiveDesignAgent(settings, {
    agentCommand: parsed.agentCommand,
    model: parsed.model,
  });
  const mainRunner = d.designRunner ?? productionDesignRunner({
    deps: d,
    projectId,
    settings,
    agentCommand: execution.agentCommand,
    model: execution.model,
    artifactOutput: false,
  });
  const dispatchNode = async (
    dispatch: DesignMainDispatch,
    parentJobId: string,
    idempotencyKey?: string | null,
  ) => {
    const canvas = await getDesignCanvas(d.dataDir, projectId);
    const node = canvas.nodes.find((candidate) => candidate.id === dispatch.nodeId);
    if (!node) throw new HttpError(409, `Main Agent dispatch target ${dispatch.nodeId} no longer exists`);
    const generative = (DESIGN_GENERATIVE_NODE_KINDS as readonly string[]).includes(node.kind);
    const runner = d.designRunner ?? productionDesignRunner({
      deps: d,
      projectId,
      settings,
      agentCommand: execution.agentCommand,
      model: execution.model,
      artifactOutput: generative,
    });
    const systemPrompt = generative
      ? buildDesignNodeSystemPrompt({ settings, message: dispatch.message, node, designSystem, webResources })
      : buildDesignNodeAnalysisSystemPrompt({ settings, message: dispatch.message, node });
    const child = await startDesignNodeTurn({
      designSystem,
      webResources,
      quality: designQuality(settings),
      dataDir: d.dataDir,
      projectId,
      nodeId: dispatch.nodeId,
      message: dispatch.message,
      runner,
      systemPrompt,
      contextNodeIds: dispatch.contextNodeIds,
      idempotencyKey: idempotencyKey ?? null,
      parentJobId,
      env: productionDesignAgentEnvironment(settings, execution.agentCommand, d.security?.token),
      model: execution.model,
      runtimeGate: d.designRunner === undefined && generative ? runDesignNodeRuntimeGate : undefined,
    });
    if (!child.reused) superviseDesignExecution(d, projectId, child);
    return child.job;
  };
  const started = await startDesignMainTurn({
    designSystem,
    dataDir: d.dataDir,
    projectId,
    message: parsed.message,
    runner: mainRunner,
    systemPrompt: buildDesignMainSystemPrompt({ projectName: project?.name, designSystem, customInstructions: settings.customInstructions }),
    promptIdentity: buildDesignMainSystemPrompt(),
    contextNodeIds: parsed.contextNodeIds,
    idempotencyKey: parsed.idempotencyKey ?? null,
    terminalReceiptPolicy: parsed.terminalReceiptPolicy,
    env: productionDesignAgentEnvironment(settings, execution.agentCommand, d.security?.token),
    model: execution.model,
    dispatchNode,
  });
  if (!started.reused) superviseDesignExecution(d, projectId, started);
  return started;
}

export async function handleDesignMainTurn(
  req: IncomingMessage,
  res: ServerResponse,
  p: Record<string, string>,
  d: AppDeps,
): Promise<void> {
  const body = exactRecord(await readJsonBody(req), "Main Agent turn", [
    "message", "context", "agentCommand", "model", "idempotencyKey",
  ]);
  const started = await startDesignMainAgentTurn(
    d,
    p.id!,
    designAgentTurnBody(body, "Main Agent"),
  );
  sendJson(res, started.reused ? 200 : 202, {
    thread: started.thread,
    job: started.job,
    canvas: await getDesignCanvas(d.dataDir, p.id!),
  });
}

export async function handleStartDesignImplementationExport(
  req: IncomingMessage,
  res: ServerResponse,
  p: Record<string, string>,
  d: AppDeps,
): Promise<void> {
  const body = exactRecord(await readJsonBody(req), "Implementation export", [
    "canvasRevision", "agentCommand", "model",
  ]);
  if (!Number.isSafeInteger(body.canvasRevision) || (body.canvasRevision as number) < 0) {
    throw new HttpError(400, "Implementation export canvasRevision is invalid");
  }
  const canvas = await getDesignCanvas(d.dataDir, p.id!);
  if (canvas.revision !== body.canvasRevision) {
    throw new HttpError(409, `Implementation export requires current Canvas revision ${canvas.revision}`);
  }
  const designNodes = canvas.nodes.filter((node) =>
    (DESIGN_GENERATIVE_NODE_KINDS as readonly string[]).includes(node.kind));
  if (designNodes.length === 0) throw new HttpError(409, "Generate at least one design Node before export");
  const missing = designNodes.filter((node) => (node.selectedVersionId ?? node.currentVersionId) === null);
  if (missing.length > 0) {
    throw new HttpError(409, `Generate every design Node before export. Missing: ${missing.map((node) => node.name).join(", ")}`);
  }
  const generating = designNodes.filter((node) =>
    node.activeJobId !== null || ["queued", "generating", "validating"].includes(node.state));
  if (generating.length > 0) {
    throw new HttpError(409, `Wait for Node generation to finish before exporting: ${generating.map((node) => node.name).join(", ")}`);
  }
  const settings = d.store.getSettings();
  const execution = effectiveDesignAgent(settings, {
    agentCommand: boundedString(body.agentCommand, "agentCommand", 512, true),
    model: optionalDesignModel(body.model),
  });
  const started = await startDesignImplementationExport({
    ...implementationExportStartInput({
      deps: d,
      projectId: p.id!,
      settings,
      agentCommand: execution.agentCommand,
      model: execution.model,
      sourcePreviewOrigin: trustedDesignPreviewOrigin(req.socket),
    }),
    canvasRevision: body.canvasRevision as number,
  });
  superviseDesignExecution(d, p.id!, started);
  sendJson(res, 202, { exportId: started.exportId, job: started.job });
}

export async function handleListDesignJobs(_req: IncomingMessage, res: ServerResponse, p: Record<string, string>, d: AppDeps): Promise<void> {
  sendJson(res, 200, await listDesignJobs(d.dataDir, p.id!));
}

export async function handleCancelDesignJob(_req: IncomingMessage, res: ServerResponse, p: Record<string, string>, d: AppDeps): Promise<void> {
  const job = await getDesignJob(d.dataDir, p.id!, p.jobId!);
  sendJson(res, 200, job.kind === "node-generation" || job.kind === "node-analysis"
    ? await cancelDesignNodeTurn(d.dataDir, p.id!, p.jobId!)
    : await cancelDesignGlobalJob(d.dataDir, p.id!, p.jobId!));
}

export async function handleRetryDesignJob(
  req: IncomingMessage,
  res: ServerResponse,
  p: Record<string, string>,
  d: AppDeps,
): Promise<void> {
  const body = exactRecord(await readJsonBody(req), "Design Job retry", ["agentCommand", "model"]);
  const failedJob = await getDesignJob(d.dataDir, p.id!, p.jobId!);
  if (failedJob.status !== "failed") throw new HttpError(409, "Only a failed Design Job can be retried");
  const settings = d.store.getSettings();
  const project = await getDesignProject(d.dataDir, p.id!).catch(() => null);
  const designSystem = projectDesignSystem(d, project);
  const webResources = await designWebResources(d, settings, designSystem);
  const execution = retryDesignAgent(settings, failedJob, body);
  const retryKey = `retry-${failedJob.id}`;

  // A failed Job has at most one successor. Replaying the Retry after that
  // successor already exists returns it in whatever state it reached, instead
  // of re-deriving a request hash that legitimately drifts once it publishes.
  const nodeScoped = failedJob.kind === "node-generation" || failedJob.kind === "node-analysis";
  if (!nodeScoped || failedJob.nodeId !== null) {
    const priorRetry = await getDesignJobByReceiptKey(d.dataDir, p.id!, {
      kind: failedJob.kind,
      nodeId: nodeScoped ? failedJob.nodeId : null,
      idempotencyKey: retryKey,
    });
    if (priorRetry !== null) {
      if (failedJob.kind === "implementation-export") {
        sendJson(res, 200, { retryOfJobId: failedJob.id, exportId: priorRetry.job.exportId, job: priorRetry.job });
        return;
      }
      const scope = failedJob.kind === "main-agent"
        ? { type: "main" as const }
        : { type: "node" as const, nodeId: failedJob.nodeId! };
      sendJson(res, 200, {
        retryOfJobId: failedJob.id,
        thread: await getDesignThread(d.dataDir, p.id!, scope),
        job: priorRetry.job,
        canvas: await getDesignCanvas(d.dataDir, p.id!),
      });
      return;
    }
  }

  if (failedJob.kind === "node-generation" || failedJob.kind === "node-analysis") {
    if (failedJob.nodeId === null) throw new HttpError(409, "Failed Node Job lost its target authority");
    const canvas = await getDesignCanvas(d.dataDir, p.id!);
    const node = canvas.nodes.find((candidate) => candidate.id === failedJob.nodeId);
    if (!node) throw new HttpError(409, "Failed Node Job target no longer exists");
    const priorThread = await getDesignThread(d.dataDir, p.id!, { type: "node", nodeId: node.id });
    const originalMessage = priorThread.messages.find((message) =>
      message.jobId === failedJob.id && message.role === "user")?.content;
    if (!originalMessage) throw new HttpError(409, "Failed Node Job original request is unavailable");
    const generative = (DESIGN_GENERATIVE_NODE_KINDS as readonly string[]).includes(node.kind);
    const retryRunner = d.designRunner ?? productionDesignRunner({
      deps: d,
      projectId: p.id!,
      settings,
      agentCommand: execution.agentCommand,
      model: execution.model,
      artifactOutput: generative,
    });
    const systemPrompt = generative
      ? buildDesignNodeSystemPrompt({ settings, message: originalMessage, node, designSystem, webResources })
      : buildDesignNodeAnalysisSystemPrompt({ settings, message: originalMessage, node });
    const started = await startDesignNodeTurn({
      designSystem,
      webResources,
      quality: designQuality(settings),
      dataDir: d.dataDir,
      projectId: p.id!,
      nodeId: node.id,
      message: originalMessage,
      runner: retryRunner,
      systemPrompt,
      idempotencyKey: retryKey,
      parentJobId: failedJob.parentJobId,
      env: productionDesignAgentEnvironment(settings, execution.agentCommand, d.security?.token),
      model: execution.model,
      runtimeGate: d.designRunner === undefined && generative ? runDesignNodeRuntimeGate : undefined,
    });
    if (!started.reused) superviseDesignExecution(d, p.id!, started);
    sendJson(res, started.reused ? 200 : 202, {
      retryOfJobId: failedJob.id,
      thread: started.thread,
      job: started.job,
      canvas: await getDesignCanvas(d.dataDir, p.id!),
    });
    return;
  }

  if (failedJob.kind === "main-agent") {
    const priorThread = await getDesignThread(d.dataDir, p.id!, { type: "main" });
    const originalMessage = priorThread.messages.find((message) =>
      message.jobId === failedJob.id && message.role === "user")?.content;
    if (!originalMessage) throw new HttpError(409, "Failed Main Agent Job original request is unavailable");
    const mainRunner = d.designRunner ?? productionDesignRunner({
      deps: d,
      projectId: p.id!,
      settings,
      agentCommand: execution.agentCommand,
      model: execution.model,
      artifactOutput: false,
    });
    const dispatchNode = async (
      dispatch: DesignMainDispatch,
      parentJobId: string,
      idempotencyKey?: string | null,
    ) => {
      const canvas = await getDesignCanvas(d.dataDir, p.id!);
      const node = canvas.nodes.find((candidate) => candidate.id === dispatch.nodeId);
      if (!node) throw new HttpError(409, `Main Agent dispatch target ${dispatch.nodeId} no longer exists`);
      const generative = (DESIGN_GENERATIVE_NODE_KINDS as readonly string[]).includes(node.kind);
      const childRunner = d.designRunner ?? productionDesignRunner({
        deps: d,
        projectId: p.id!,
        settings,
        agentCommand: execution.agentCommand,
        model: execution.model,
        artifactOutput: generative,
      });
      const systemPrompt = generative
        ? buildDesignNodeSystemPrompt({ settings, message: dispatch.message, node, designSystem, webResources })
        : buildDesignNodeAnalysisSystemPrompt({ settings, message: dispatch.message, node });
      const child = await startDesignNodeTurn({
        designSystem,
        webResources,
        quality: designQuality(settings),
        dataDir: d.dataDir,
        projectId: p.id!,
        nodeId: node.id,
        message: dispatch.message,
        runner: childRunner,
        systemPrompt,
        contextNodeIds: dispatch.contextNodeIds,
        idempotencyKey: idempotencyKey ?? null,
        parentJobId,
        env: productionDesignAgentEnvironment(settings, execution.agentCommand, d.security?.token),
        model: execution.model,
        runtimeGate: d.designRunner === undefined && generative ? runDesignNodeRuntimeGate : undefined,
      });
      if (!child.reused) superviseDesignExecution(d, p.id!, child);
      return child.job;
    };
    const started = await startDesignMainTurn({
      designSystem,
      dataDir: d.dataDir,
      projectId: p.id!,
      message: originalMessage,
      runner: mainRunner,
      systemPrompt: buildDesignMainSystemPrompt({ projectName: project?.name, designSystem, customInstructions: settings.customInstructions }),
    promptIdentity: buildDesignMainSystemPrompt(),
      idempotencyKey: retryKey,
      env: productionDesignAgentEnvironment(settings, execution.agentCommand, d.security?.token),
      model: execution.model,
      dispatchNode,
    });
    if (!started.reused) superviseDesignExecution(d, p.id!, started);
    sendJson(res, started.reused ? 200 : 202, {
      retryOfJobId: failedJob.id,
      thread: started.thread,
      job: started.job,
      canvas: await getDesignCanvas(d.dataDir, p.id!),
    });
    return;
  }

  const canvas = await getDesignCanvas(d.dataDir, p.id!);
  if (failedJob.canvasRevision === null || canvas.revision !== failedJob.canvasRevision) {
    throw new HttpError(409, `Failed Export is bound to Canvas revision ${failedJob.canvasRevision ?? "unknown"}; current revision is ${canvas.revision}`);
  }
  const started = await startDesignImplementationExport({
    ...implementationExportStartInput({
      deps: d,
      projectId: p.id!,
      settings,
      agentCommand: execution.agentCommand,
      model: execution.model,
      sourcePreviewOrigin: trustedDesignPreviewOrigin(req.socket),
    }),
    canvasRevision: canvas.revision,
    idempotencyKey: retryKey,
  });
  if (!started.reused) superviseDesignExecution(d, p.id!, started);
  sendJson(res, started.reused ? 200 : 202, {
    retryOfJobId: failedJob.id,
    exportId: started.exportId,
    job: started.job,
  });
}
