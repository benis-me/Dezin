import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { AgentRunner } from "../../../../packages/agent/src/index.ts";
import type { Settings } from "../../../../packages/core/src/index.ts";
import type { AppDeps } from "../app.ts";
import { HttpError, readJsonBody, sendJson } from "../http-util.ts";
import {
  buildDesignImplementationExportSystemPrompt,
  buildDesignMainSystemPrompt,
  cancelDesignGlobalJob,
  startDesignImplementationExport,
  startDesignMainTurn,
  type DesignMainDispatch,
} from "./design-global-agents.ts";
import {
  buildDesignNodeAnalysisSystemPrompt,
  buildDesignNodeSystemPrompt,
  cancelDesignNodeTurn,
  createProductionDesignAnalysisRunner,
  createProductionDesignNodeRunner,
  productionDesignAgentEnvironment,
  startDesignNodeTurn,
} from "./design-node-agent.ts";
import { DesignAgentProviderUnsupportedError } from "./design-agent-confinement.ts";
import {
  getDesignAssetManifest,
  getDesignCanvas,
  getDesignJob,
  getDesignThread,
  importDesignCanvasAssetBatch,
  listDesignAssets,
  listDesignJobs,
  listDesignVersions,
  mutateDesignCanvas,
  redoDesignCanvas,
  resolveDesignAssetFile,
  resolveDesignVersionFile,
  resolvePinnedDesignAssetFile,
  storeDesignAsset,
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

const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "navigate-to 'none'",
  "frame-ancestors 'self'",
  "sandbox allow-scripts",
].join("; ");

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
  model?: string;
  artifactOutput: boolean;
}): AgentRunner {
  try {
    const confinement = { dataDir: input.deps.dataDir, projectId: input.projectId };
    const override = { agentCommand: input.agentCommand, model: input.model };
    return input.artifactOutput
      ? createProductionDesignNodeRunner(input.settings, confinement, override)
      : createProductionDesignAnalysisRunner(input.settings, confinement, override);
  } catch (error) {
    if (error instanceof DesignAgentProviderUnsupportedError) {
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

function sendImmutableHtml(req: IncomingMessage, res: ServerResponse, html: Buffer, checksum: string): void {
  const etag = `"sha256-${checksum}"`;
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(html.length),
    "cache-control": "public, max-age=31536000, immutable",
    etag,
    "content-security-policy": PREVIEW_CSP,
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

function activeDocument(mimeType: string): boolean {
  return mimeType === "text/html" || mimeType === "application/xhtml+xml" || mimeType === "image/svg+xml"
    || mimeType === "application/pdf" || mimeType.endsWith("+xml") || mimeType === "application/xml";
}

function inlineAsset(mimeType: string): boolean {
  return ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(mimeType)
    || mimeType.startsWith("video/") || mimeType.startsWith("audio/") || mimeType.startsWith("font/")
    || ["application/font-woff", "application/font-woff2", "application/vnd.ms-fontobject"].includes(mimeType);
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
  const bytes = await readFile(resolved.path);
  if (bytes.length !== resolved.manifest.bytes
    || createHash("sha256").update(bytes).digest("hex") !== resolved.manifest.checksum) {
    throw new HttpError(409, "Design Asset changed after integrity verification");
  }
  const etag = `"sha256-${resolved.manifest.checksum}"`;
  const baseHeaders: Record<string, string> = {
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=31536000, immutable",
    etag,
    "x-content-type-options": "nosniff",
    "content-type": resolved.manifest.mimeType,
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
    range = rangeFor(Array.isArray(req.headers.range) ? req.headers.range[0] : req.headers.range, bytes.length);
  } catch (error) {
    if (error instanceof HttpError && error.status === 416) {
      res.writeHead(416, { ...baseHeaders, "content-range": `bytes */${bytes.length}` });
      res.end();
      return;
    }
    throw error;
  }
  const body = range === null ? bytes : bytes.subarray(range.start, range.end + 1);
  const headers = {
    ...baseHeaders,
    "content-length": String(body.length),
    ...(range === null ? {} : { "content-range": `bytes ${range.start}-${range.end}/${bytes.length}` }),
  };
  res.writeHead(range === null ? 200 : 206, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}

export async function handleGetDesignCanvas(
  _req: IncomingMessage, res: ServerResponse, params: Record<string, string>, deps: AppDeps,
): Promise<void> {
  sendJson(res, 200, await getDesignCanvas(deps.dataDir, params.id!));
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
    const item = exactRecord(value, `Design Asset import item ${index}`, ["asset", "node"]);
    const asset = exactRecord(item.asset, `Design Asset import item ${index}.asset`, [
      "name", "mimeType", "base64", "sourceVersion",
    ]);
    const hasBase64 = asset.base64 !== undefined;
    const hasSourceVersion = asset.sourceVersion !== undefined;
    if (Number(hasBase64) + Number(hasSourceVersion) !== 1) {
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
    const node = exactRecord(item.node, `Design Asset import item ${index}.node`, ["id", "kind", "name", "geometry"]);
    let geometry: Partial<DesignNodeGeometry> | undefined;
    if (node.geometry !== undefined) {
      const raw = exactRecord(node.geometry, `Design Asset import item ${index}.node.geometry`, ["x", "y", "width", "height"]);
      for (const [key, coordinate] of Object.entries(raw)) {
        if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) {
          throw new HttpError(400, `Design Asset import item ${index}.node.geometry.${key} is invalid`);
        }
      }
      geometry = raw as Partial<DesignNodeGeometry>;
    }
    return {
      asset: {
        name: boundedString(asset.name, "Asset name", 240)!,
        ...(asset.mimeType === undefined ? {} : {
          mimeType: boundedString(asset.mimeType, "Asset mimeType", 120)!,
        }),
        ...(hasBase64 ? {
          base64: boundedString(asset.base64, "Asset base64", Math.ceil(MAX_DESIGN_ASSET_BYTES * 4 / 3) + 4)!,
        } : { sourceVersion: sourceVersion! }),
      },
      node: {
        ...(node.id === undefined ? {} : { id: boundedString(node.id, "Node id", 128)! }),
        kind: boundedString(node.kind, "Node kind", 64)! as DesignNodeKind,
        ...(node.name === undefined ? {} : { name: boundedString(node.name, "Node name", 240)! }),
        ...(geometry === undefined ? {} : { geometry }),
      },
    };
  });
  sendJson(res, 200, await importDesignCanvasAssetBatch(d.dataDir, p.id!, {
    expectedRevision: body.expectedRevision as number,
    items,
  }));
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
  const resolved = await resolveDesignVersionFile(d.dataDir, p.id!, p.nodeId!, p.versionId!, "index.html");
  const html = await readFile(resolved.path);
  if (html.length !== resolved.manifest.bytes
    || createHash("sha256").update(html).digest("hex") !== resolved.manifest.checksum) {
    throw new HttpError(409, "Design Version changed after integrity verification");
  }
  sendImmutableHtml(req, res, html, resolved.manifest.checksum);
}

export async function handleGetMainDesignThread(_req: IncomingMessage, res: ServerResponse, p: Record<string, string>, d: AppDeps): Promise<void> {
  sendJson(res, 200, await getDesignThread(d.dataDir, p.id!, { type: "main" }));
}

export async function handleGetNodeDesignThread(_req: IncomingMessage, res: ServerResponse, p: Record<string, string>, d: AppDeps): Promise<void> {
  sendJson(res, 200, await getDesignThread(d.dataDir, p.id!, { type: "node", nodeId: p.nodeId! }));
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
  const agentCommand = (boundedString(body.agentCommand, "agentCommand", 512, true) ?? settings.agentCommand) || "claude";
  const model = boundedString(body.model, "model", 512, true);
  const idempotencyKey = boundedString(body.idempotencyKey, "idempotencyKey", 160, true);
  const generative = (DESIGN_GENERATIVE_NODE_KINDS as readonly string[]).includes(node.kind);
  const runner = d.designRunner ?? productionDesignRunner({
    deps: d,
    projectId: p.id!,
    settings,
    agentCommand,
    model,
    artifactOutput: generative,
  });
  const systemPrompt = generative
    ? buildDesignNodeSystemPrompt({ settings, message, node })
    : buildDesignNodeAnalysisSystemPrompt({ settings, message, node });
  const started = await startDesignNodeTurn({
    dataDir: d.dataDir,
    projectId: p.id!,
    nodeId: p.nodeId!,
    message,
    runner,
    systemPrompt,
    contextNodeIds,
    idempotencyKey: idempotencyKey ?? null,
    env: productionDesignAgentEnvironment(settings, agentCommand, d.security?.token),
    model: model ?? null,
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
  model?: string;
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
    model: boundedString(body.model, "model", 512, true),
    idempotencyKey: boundedString(body.idempotencyKey, "idempotencyKey", 160, true),
  };
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
  const parsed = designAgentTurnBody(body, "Main Agent");
  const canvas = await getDesignCanvas(d.dataDir, p.id!);
  if (parsed.contextNodeIds.some((nodeId) => !canvas.nodeOrder.includes(nodeId))) {
    throw new HttpError(400, "Main Agent context references a Node outside the canvas");
  }
  const settings = d.store.getSettings();
  const agentCommand = (parsed.agentCommand ?? settings.agentCommand) || "claude";
  const mainRunner = d.designRunner ?? productionDesignRunner({
    deps: d,
    projectId: p.id!,
    settings,
    agentCommand,
    model: parsed.model,
    artifactOutput: false,
  });
  const dispatchNode = async (dispatch: DesignMainDispatch, parentJobId: string) => {
    const canvas = await getDesignCanvas(d.dataDir, p.id!);
    const node = canvas.nodes.find((candidate) => candidate.id === dispatch.nodeId);
    if (!node) throw new HttpError(409, `Main Agent dispatch target ${dispatch.nodeId} no longer exists`);
    const generative = (DESIGN_GENERATIVE_NODE_KINDS as readonly string[]).includes(node.kind);
    const runner = d.designRunner ?? productionDesignRunner({
      deps: d,
      projectId: p.id!,
      settings,
      agentCommand,
      model: parsed.model,
      artifactOutput: generative,
    });
    const systemPrompt = generative
      ? buildDesignNodeSystemPrompt({ settings, message: dispatch.message, node })
      : buildDesignNodeAnalysisSystemPrompt({ settings, message: dispatch.message, node });
    const child = await startDesignNodeTurn({
      dataDir: d.dataDir,
      projectId: p.id!,
      nodeId: dispatch.nodeId,
      message: dispatch.message,
      runner,
      systemPrompt,
      contextNodeIds: dispatch.contextNodeIds,
      parentJobId,
      env: productionDesignAgentEnvironment(settings, agentCommand, d.security?.token),
      model: parsed.model ?? null,
    });
    if (!child.reused) superviseDesignExecution(d, p.id!, child);
    return child.job;
  };
  const started = await startDesignMainTurn({
    dataDir: d.dataDir,
    projectId: p.id!,
    message: parsed.message,
    runner: mainRunner,
    systemPrompt: buildDesignMainSystemPrompt(),
    contextNodeIds: parsed.contextNodeIds,
    idempotencyKey: parsed.idempotencyKey ?? null,
    env: productionDesignAgentEnvironment(settings, agentCommand, d.security?.token),
    dispatchNode,
  });
  if (!started.reused) superviseDesignExecution(d, p.id!, started);
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
  const agentCommand = (boundedString(body.agentCommand, "agentCommand", 512, true) ?? settings.agentCommand) || "claude";
  const model = boundedString(body.model, "model", 512, true);
  const runner = d.designRunner ?? productionDesignRunner({
    deps: d,
    projectId: p.id!,
    settings,
    agentCommand,
    model,
    artifactOutput: true,
  });
  const started = await startDesignImplementationExport({
    dataDir: d.dataDir,
    projectId: p.id!,
    canvasRevision: body.canvasRevision as number,
    runner,
    sourcePreviewOrigin: trustedDesignPreviewOrigin(req.socket),
    systemPrompt: buildDesignImplementationExportSystemPrompt({
      settings,
      brief: "Reimplement every selected Canvas Version as one coherent production application.",
    }),
    env: productionDesignAgentEnvironment(settings, agentCommand, d.security?.token),
    model: model ?? null,
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
