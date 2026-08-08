import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { parse } from "@babel/parser";
import { transform as transformCss, transformStyleAttribute } from "lightningcss";
import {
  parse as parseHtml,
  type DefaultTreeAdapterTypes,
  type ParserError,
} from "parse5";
import {
  DESIGN_GENERATIVE_NODE_KINDS,
  DESIGN_NODE_KINDS,
  DESIGN_SCHEMA_VERSION,
  type DesignAssetManifest,
  type DesignAssetBundleFile,
  type DesignCanvas,
  type DesignCanvasIntent,
  type DesignCanvasSnapshot,
  type DesignFrozenContext,
  type DesignFrozenAssetPin,
  type DesignJob,
  type DesignJobActivity,
  type DesignJobKind,
  type DesignJobStatus,
  type DesignNode,
  type DesignNodeGeometry,
  type DesignNodeKind,
  type DesignNodeState,
  type DesignProjectFile,
  type DesignThread,
  type DesignThreadMessage,
  type DesignThreadRole,
  type DesignVersionContentKind,
  type DesignVersionManifest,
  type DesignVersionPublicationPhase,
  type DesignVersionPublicationTransaction,
  type DesignViewport,
} from "./design-types.ts";
import { stableStringify } from "../canonical-json.ts";

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_HISTORY = 50;
const MAX_RETIRED_NODE_IDS = 5_000;
export const MAX_DESIGN_ASSET_BYTES = 32 * 1024 * 1024;
export const MAX_DESIGN_ASSET_BATCH_BYTES = 64 * 1024 * 1024;
export const MAX_DESIGN_ASSET_BATCH_ITEMS = 32;
export const MAX_DESIGN_HTML_BYTES = 4 * 1024 * 1024;
const MAX_THREAD_MESSAGES = 2_000;
const MAX_THREAD_CONTENT_BYTES = 256 * 1024;
const MAX_JOB_ACTIVITY = 2_000;
const MAX_ASSET_BUNDLE_FILES = 1_000;
export const MAX_DESIGN_CONTEXT_PAYLOADS = 1_000;
export const MAX_DESIGN_CONTEXT_BYTES = 256 * 1024 * 1024;

const projectLocks = new Map<string, Promise<void>>();

export class DesignStorageError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DesignStorageError";
    this.code = code;
  }
}

export class DesignRevisionConflictError extends DesignStorageError {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super("revision-conflict", `Design canvas revision conflict: expected ${expectedRevision}, current ${actualRevision}`);
    this.name = "DesignRevisionConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

function safeSegment(value: string, label: string): string {
  if (!SAFE_SEGMENT.test(value) || value === "." || value === "..") {
    throw new DesignStorageError("invalid-id", `${label} is invalid`);
  }
  return value;
}

function designRoot(dataDir: string, projectId: string): string {
  return join(dataDir, "projects", safeSegment(projectId, "Project id"), "design");
}

function projectFilePath(root: string): string {
  return join(root, "project.json");
}

function nodeRoot(root: string, nodeId: string): string {
  return join(root, "nodes", safeSegment(nodeId, "Node id"));
}

export function designNodeJobStagingDirectory(
  dataDir: string,
  projectId: string,
  nodeId: string,
  jobId: string,
): string {
  return join(
    nodeRoot(designRoot(dataDir, projectId), nodeId),
    ".pending",
    "jobs",
    safeSegment(jobId, "Job id"),
  );
}

export function designExportStagingDirectory(
  dataDir: string,
  projectId: string,
  exportId: string,
): string {
  return join(designRoot(dataDir, projectId), "exports", ".pending", safeSegment(exportId, "Export id"));
}

export function designExportDirectory(dataDir: string, projectId: string, exportId: string): string {
  return join(designRoot(dataDir, projectId), "exports", safeSegment(exportId, "Export id"));
}

function assetRoot(root: string, assetId: string): string {
  return join(root, "assets", safeSegment(assetId, "Asset id"));
}

function jobFilePath(root: string, jobId: string): string {
  return join(root, "jobs", `${safeSegment(jobId, "Job id")}.json`);
}

function nowValue(now?: number): number {
  const value = now ?? Date.now();
  if (!Number.isSafeInteger(value) || value < 0) throw new DesignStorageError("invalid-time", "Timestamp is invalid");
  return value;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readJson<T>(path: string, label: string): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new DesignStorageError("missing", `${label} is unavailable`, { cause: error });
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new DesignStorageError("corrupt", `${label} is corrupt`, { cause: error });
  }
}

type StoredRecord = Record<string, unknown>;

function storedRecord(value: unknown, label: string, allowed: readonly string[]): StoredRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DesignStorageError("corrupt", `${label} is invalid`);
  }
  const record = value as StoredRecord;
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new DesignStorageError("corrupt", `${label} contains an unexpected field`);
  }
  return record;
}

function validStoredNullableId(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && SAFE_SEGMENT.test(value));
}

function validStoredText(value: unknown, maxBytes: number, options: { nullable?: boolean; empty?: boolean } = {}): boolean {
  if (options.nullable && value === null) return true;
  return typeof value === "string"
    && (options.empty || value.trim().length > 0)
    && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function safeBundlePath(value: unknown, label = "Asset bundle path"): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024
    || value.startsWith("/") || value.includes("\\")) {
    throw new DesignStorageError("corrupt", `${label} is invalid`);
  }
  const parts = value.split("/");
  if (parts.length > 16 || parts.some((part) => part === "." || part === ".." || !SAFE_SEGMENT.test(part))) {
    throw new DesignStorageError("corrupt", `${label} is invalid`);
  }
  return value;
}

function assertStoredBundleFiles(value: unknown, label: string): asserts value is DesignAssetBundleFile[] {
  if (!Array.isArray(value) || value.length > MAX_ASSET_BUNDLE_FILES) {
    throw new DesignStorageError("corrupt", `${label} is invalid`);
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const [index, entry] of value.entries()) {
    const file = storedRecord(entry, `${label} file ${index}`, ["path", "checksum", "bytes"]);
    const path = safeBundlePath(file.path, `${label} file ${index} path`);
    if (paths.has(path) || !SHA256.test(String(file.checksum))
      || !Number.isSafeInteger(file.bytes) || (file.bytes as number) < 1
      || (file.bytes as number) > MAX_DESIGN_ASSET_BYTES) {
      throw new DesignStorageError("corrupt", `${label} file ${index} is invalid`);
    }
    paths.add(path);
    totalBytes += file.bytes as number;
  }
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_DESIGN_CONTEXT_BYTES) {
    throw new DesignStorageError("corrupt", `${label} exceeds its bounded size`);
  }
}

async function writeAtomic(path: string, bytes: string | Uint8Array): Promise<void> {
  const parent = resolve(path, "..");
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  await writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function withProjectLock<T>(
  root: string,
  operation: () => Promise<T>,
  options: { allowPublicationTransactions?: boolean } = {},
): Promise<T> {
  const prior = projectLocks.get(root) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  const tail = prior.then(() => current);
  projectLocks.set(root, tail);
  await prior;
  try {
    if (!options.allowPublicationTransactions) await assertNoDesignVersionPublicationsUnlocked(root);
    return await operation();
  } finally {
    release();
    if (projectLocks.get(root) === tail) projectLocks.delete(root);
  }
}

const defaultViewport = (): DesignViewport => ({ x: 0, y: 0, zoom: 1 });

function defaultGeometry(kind: DesignNodeKind): DesignNodeGeometry {
  if (kind === "page") return { x: 0, y: 0, width: 720, height: 540 };
  if (kind === "component") return { x: 0, y: 0, width: 480, height: 360 };
  if (kind === "image" || kind === "video") return { x: 0, y: 0, width: 420, height: 300 };
  return { x: 0, y: 0, width: 420, height: 280 };
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DesignStorageError("invalid-input", `${label} must be finite`);
  }
  return value;
}

function geometry(value: Partial<DesignNodeGeometry> | undefined, base: DesignNodeGeometry): DesignNodeGeometry {
  const next = {
    x: value?.x === undefined ? base.x : finite(value.x, "Node x"),
    y: value?.y === undefined ? base.y : finite(value.y, "Node y"),
    width: value?.width === undefined ? base.width : finite(value.width, "Node width"),
    height: value?.height === undefined ? base.height : finite(value.height, "Node height"),
  };
  if (next.width < 120 || next.width > 4_096 || next.height < 80 || next.height > 4_096) {
    throw new DesignStorageError("invalid-input", "Node size is outside the supported bounds");
  }
  return next;
}

function viewport(value: DesignViewport): DesignViewport {
  const normalized = {
    x: finite(value?.x, "Viewport x"),
    y: finite(value?.y, "Viewport y"),
    zoom: finite(value?.zoom, "Viewport zoom"),
  };
  if (normalized.zoom < 0.05 || normalized.zoom > 8) {
    throw new DesignStorageError("invalid-input", "Viewport zoom is outside the supported bounds");
  }
  return normalized;
}

function nodeKind(value: unknown): DesignNodeKind {
  if (typeof value !== "string" || !(DESIGN_NODE_KINDS as readonly string[]).includes(value)) {
    throw new DesignStorageError("invalid-input", "Node kind is unsupported");
  }
  return value as DesignNodeKind;
}

function nodeName(value: unknown, kind: DesignNodeKind): string {
  if (value === undefined) return kind.split("-").map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 256) {
    throw new DesignStorageError("invalid-input", "Node name is invalid");
  }
  return value.trim();
}

function cloneNode(node: DesignNode): DesignNode {
  return { ...node, geometry: { ...node.geometry } };
}

function snapshot(project: DesignProjectFile, nodes: Map<string, DesignNode>): DesignCanvasSnapshot {
  return {
    viewport: { ...project.viewport },
    nodeOrder: [...project.nodeOrder],
    nodes: project.nodeOrder.map((id) => cloneNode(nodes.get(id)!)),
  };
}

async function ensureDesignDirectories(root: string): Promise<void> {
  await Promise.all([
    mkdir(join(root, "nodes"), { recursive: true }),
    mkdir(join(root, "assets"), { recursive: true }),
    mkdir(join(root, "agents", "main"), { recursive: true }),
    mkdir(join(root, "agents", "main", "executions"), { recursive: true }),
    mkdir(join(root, "jobs"), { recursive: true }),
    mkdir(join(root, "exports"), { recursive: true }),
    mkdir(join(root, "transactions", "publications"), { recursive: true }),
  ]);
}

async function initializeUnlocked(root: string, projectId: string, now?: number): Promise<DesignCanvas> {
  await ensureDesignDirectories(root);
  if (!(await exists(projectFilePath(root)))) {
    const timestamp = nowValue(now);
    const project: DesignProjectFile = {
      schemaVersion: DESIGN_SCHEMA_VERSION,
      projectId,
      revision: 0,
      viewport: defaultViewport(),
      nodeOrder: [],
      nodes: [],
      retiredNodeIds: [],
      undo: [],
      redo: [],
      turnReceipts: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await writeAtomicJson(projectFilePath(root), project);
  }
  await recoverPendingAssetImportsUnlocked(root);
  return readCanvasUnlocked(root);
}

async function requireInitialized(root: string): Promise<void> {
  if (!(await exists(projectFilePath(root)))) {
    throw new DesignStorageError("not-found", "This Project is not a Design Canvas project");
  }
}

async function readProject(root: string): Promise<DesignProjectFile> {
  const project = await readJson<DesignProjectFile>(projectFilePath(root), "Design project");
  const expectedProjectId = basename(resolve(root, ".."));
  if (project.schemaVersion !== DESIGN_SCHEMA_VERSION || !Number.isSafeInteger(project.revision)
    || project.revision < 0 || !Array.isArray(project.nodeOrder) || !Array.isArray(project.nodes)
    || !Array.isArray(project.retiredNodeIds) || project.retiredNodeIds.length > MAX_RETIRED_NODE_IDS
    || new Set(project.retiredNodeIds).size !== project.retiredNodeIds.length
    || project.retiredNodeIds.some((id) => typeof id !== "string" || !SAFE_SEGMENT.test(id))
    || !Array.isArray(project.undo)
    || !Array.isArray(project.redo) || project.turnReceipts === null
    || typeof project.turnReceipts !== "object" || Array.isArray(project.turnReceipts)
    || project.projectId !== expectedProjectId
    || !validStoredViewport(project.viewport)
    || !validStoredTimestamp(project.createdAt) || !validStoredTimestamp(project.updatedAt)
    || project.nodes.length > 500 || project.undo.length > MAX_HISTORY || project.redo.length > MAX_HISTORY
    || Object.keys(project.turnReceipts).length > 5_000) {
    throw new DesignStorageError("corrupt", "Design project schema is invalid");
  }
  const nodeIds = project.nodes.map((node) => node?.id);
  if (nodeIds.length !== project.nodeOrder.length
    || new Set(nodeIds).size !== nodeIds.length
    || project.nodeOrder.some((id, index) => id !== nodeIds[index] || !SAFE_SEGMENT.test(id))) {
    throw new DesignStorageError("corrupt", "Design project Node authority is inconsistent");
  }
  for (const node of project.nodes) assertStoredNode(node);
  for (const history of [...project.undo, ...project.redo]) assertStoredSnapshot(history);
  for (const [key, receipt] of Object.entries(project.turnReceipts)) {
    if (typeof key !== "string" || key.length < 1 || key.length > 512 || !receipt
      || typeof receipt !== "object" || !SAFE_SEGMENT.test(receipt.jobId)
      || !["node-generation", "node-analysis", "main-agent", "implementation-export"].includes(receipt.kind)
      || (receipt.nodeId !== null && !SAFE_SEGMENT.test(receipt.nodeId))
      || !(receipt.requestHash === undefined || SHA256.test(receipt.requestHash))
      || !(receipt.authorityHash === undefined || SHA256.test(receipt.authorityHash))
      || !(receipt.mainPlanHash === undefined || SHA256.test(receipt.mainPlanHash))
      || !(receipt.mainPlanAppliedRevision === undefined
        || (Number.isSafeInteger(receipt.mainPlanAppliedRevision)
          && receipt.mainPlanAppliedRevision >= 0
          && receipt.mainPlanAppliedRevision <= project.revision))
      || ((receipt.mainPlanHash !== undefined || receipt.mainPlanAppliedRevision !== undefined)
        && receipt.kind !== "main-agent")
      || (receipt.mainPlanAppliedRevision !== undefined && receipt.mainPlanHash === undefined)
      || !validStoredTimestamp(receipt.createdAt)) {
      throw new DesignStorageError("corrupt", "Design project contains an invalid Agent receipt");
    }
  }
  return project;
}

function validStoredTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validStoredViewport(value: unknown): value is DesignViewport {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DesignViewport>;
  return typeof candidate.x === "number" && Number.isFinite(candidate.x)
    && typeof candidate.y === "number" && Number.isFinite(candidate.y)
    && typeof candidate.zoom === "number" && Number.isFinite(candidate.zoom)
    && candidate.zoom >= 0.05 && candidate.zoom <= 8;
}

function assertStoredNode(value: unknown): asserts value is DesignNode {
  if (!value || typeof value !== "object") throw new DesignStorageError("corrupt", "Design project contains an invalid Node");
  const node = value as Partial<DesignNode>;
  const validGeometry = node.geometry && typeof node.geometry === "object"
    && [node.geometry.x, node.geometry.y, node.geometry.width, node.geometry.height]
      .every((part) => typeof part === "number" && Number.isFinite(part))
    && node.geometry.width >= 120 && node.geometry.width <= 4_096
    && node.geometry.height >= 80 && node.geometry.height <= 4_096;
  const validOptionalId = (candidate: unknown) => candidate === null
    || (typeof candidate === "string" && SAFE_SEGMENT.test(candidate));
  if (typeof node.id !== "string" || !SAFE_SEGMENT.test(node.id)
    || typeof node.kind !== "string" || !(DESIGN_NODE_KINDS as readonly string[]).includes(node.kind)
    || typeof node.name !== "string" || !node.name.trim() || Buffer.byteLength(node.name, "utf8") > 256
    || !validGeometry
    || typeof node.state !== "string" || !["empty", "queued", "generating", "validating", "ready", "failed", "cancelled", "superseded"].includes(node.state)
    || !validOptionalId(node.currentVersionId) || !validOptionalId(node.selectedVersionId)
    || !Number.isSafeInteger(node.versionCount) || (node.versionCount as number) < 0
    || !validOptionalId(node.assetId) || !validOptionalId(node.activeJobId)
    || (node.error !== null && (typeof node.error !== "string" || Buffer.byteLength(node.error, "utf8") > 16_384))
    || !validStoredTimestamp(node.createdAt) || !validStoredTimestamp(node.updatedAt)) {
    throw new DesignStorageError("corrupt", "Design project contains an invalid Node record");
  }
  const generative = (DESIGN_GENERATIVE_NODE_KINDS as readonly string[]).includes(node.kind);
  const hasHead = node.currentVersionId !== null;
  if ((generative && node.assetId !== null)
    || (!generative && (
      hasHead !== ((node.versionCount as number) > 0)
      || (hasHead !== (node.assetId !== null))
      || (!hasHead && node.selectedVersionId !== null)
    ))) {
    throw new DesignStorageError("corrupt", "Design project Node payload ownership is inconsistent");
  }
}

function assertStoredSnapshot(value: unknown): asserts value is DesignCanvasSnapshot {
  if (!value || typeof value !== "object") throw new DesignStorageError("corrupt", "Design canvas history is invalid");
  const history = value as Partial<DesignCanvasSnapshot>;
  if (!validStoredViewport(history.viewport) || !Array.isArray(history.nodeOrder) || !Array.isArray(history.nodes)
    || history.nodes.length > 500 || history.nodeOrder.length !== history.nodes.length) {
    throw new DesignStorageError("corrupt", "Design canvas history is invalid");
  }
  for (const node of history.nodes) assertStoredNode(node);
  const ids = history.nodes.map((node) => node.id);
  if (new Set(ids).size !== ids.length || history.nodeOrder.some((id, index) => id !== ids[index])) {
    throw new DesignStorageError("corrupt", "Design canvas history Node order is invalid");
  }
}

function readNodes(project: DesignProjectFile): Map<string, DesignNode> {
  const ids = new Set<string>();
  const nodes = new Map<string, DesignNode>();
  for (const node of project.nodes) {
    if (!node || typeof node.id !== "string") {
      throw new DesignStorageError("corrupt", "Design project contains an invalid Node record");
    }
    const id = node.id;
    safeSegment(id, "Node id");
    if (ids.has(id)) throw new DesignStorageError("corrupt", "Design project contains duplicate Node ids");
    ids.add(id);
    nodes.set(id, cloneNode(node));
  }
  return nodes;
}

function canvas(project: DesignProjectFile, nodes: Map<string, DesignNode>): DesignCanvas {
  return {
    schemaVersion: DESIGN_SCHEMA_VERSION,
    projectId: project.projectId,
    revision: project.revision,
    viewport: { ...project.viewport },
    nodeOrder: [...project.nodeOrder],
    nodes: project.nodeOrder.map((id) => cloneNode(nodes.get(id)!)),
    undoDepth: project.undo.length,
    redoDepth: project.redo.length,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

async function readCanvasUnlocked(root: string): Promise<DesignCanvas> {
  const project = await readProject(root);
  return canvas(project, readNodes(project));
}

export async function initializeDesignProject(dataDir: string, projectId: string, now?: number): Promise<DesignCanvas> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, () => initializeUnlocked(root, projectId, now), {
    allowPublicationTransactions: true,
  });
}

export async function getDesignCanvas(dataDir: string, projectId: string): Promise<DesignCanvas> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    await requireInitialized(root);
    await recoverPendingAssetImportsUnlocked(root);
    return readCanvasUnlocked(root);
  });
}

function retireNodeIdentities(project: DesignProjectFile, candidates: Iterable<string>): void {
  const additions: string[] = [];
  for (const id of candidates) {
    if (!project.retiredNodeIds.includes(id) && !additions.includes(id)) additions.push(id);
  }
  if (project.retiredNodeIds.length + additions.length > MAX_RETIRED_NODE_IDS) {
    throw new DesignStorageError(
      "limit",
      "Design canvas retired Node identity limit reached",
    );
  }
  project.retiredNodeIds.push(...additions);
}

async function addNode(
  dataDir: string,
  projectId: string,
  project: DesignProjectFile,
  nodes: Map<string, DesignNode>,
  intent: Extract<DesignCanvasIntent, { type: "add-node" }>,
  timestamp: number,
  preparedAsset?: DesignAssetManifest,
): Promise<DesignNode> {
  const kind = nodeKind(intent.node?.kind);
  const id = safeSegment(intent.node.id ?? `node-${randomUUID()}`, "Node id");
  if (nodes.has(id) || project.nodeOrder.includes(id) || project.retiredNodeIds.includes(id) || project.nodeOrder.length >= 500) {
    throw new DesignStorageError(
      "conflict",
      nodes.has(id) || project.retiredNodeIds.includes(id)
        ? `Design Node identity ${id} already exists or was retired`
        : "Design canvas Node limit reached",
    );
  }
  const assetId = intent.node.assetId ?? null;
  if (assetId !== null) safeSegment(assetId, "Asset id");
  if (assetId !== null) {
    throw new DesignStorageError(
      "invalid-input",
      "Material Assets must be bound through the atomic Asset import API so v1 cannot be skipped",
    );
  }
  const created: DesignNode = {
    id,
    kind,
    name: nodeName(intent.node.name, kind),
    geometry: geometry(intent.node.geometry, defaultGeometry(kind)),
    state: "empty",
    currentVersionId: null,
    selectedVersionId: null,
    versionCount: 0,
    assetId: null,
    activeJobId: null,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  nodes.set(id, created);
  project.nodeOrder.push(id);
  return created;
}

async function applyIntent(
  dataDir: string,
  projectId: string,
  project: DesignProjectFile,
  nodes: Map<string, DesignNode>,
  intent: DesignCanvasIntent,
  timestamp: number,
  changed: Set<string>,
): Promise<void> {
  if (!intent || typeof intent !== "object") throw new DesignStorageError("invalid-input", "Canvas intent is invalid");
  if (intent.type === "add-node") {
    changed.add((await addNode(dataDir, projectId, project, nodes, intent, timestamp)).id);
    return;
  }
  if (intent.type === "remove-node") {
    const id = safeSegment(intent.nodeId, "Node id");
    const node = nodes.get(id);
    if (!node) throw new DesignStorageError("not-found", `Design Node ${id} was not found`);
    if (node.activeJobId !== null) {
      throw new DesignStorageError("conflict", "Cancel the active scoped Agent Job before removing this Node");
    }
    nodes.delete(id);
    project.nodeOrder = project.nodeOrder.filter((candidate) => candidate !== id);
    retireNodeIdentities(project, [id]);
    return;
  }
  if (intent.type === "set-viewport") {
    project.viewport = viewport(intent.viewport);
    return;
  }
  if (intent.type === "replace-layout") {
    if (!Array.isArray(intent.nodes) || intent.nodes.length > project.nodeOrder.length) {
      throw new DesignStorageError("invalid-input", "Replacement layout is invalid");
    }
    const seen = new Set<string>();
    for (const entry of intent.nodes) {
      const id = safeSegment(entry.nodeId, "Node id");
      if (seen.has(id)) throw new DesignStorageError("invalid-input", "Replacement layout repeats a Node");
      seen.add(id);
      const node = nodes.get(id);
      if (!node) throw new DesignStorageError("not-found", `Design Node ${id} was not found`);
      node.geometry = geometry(entry.geometry, node.geometry);
      node.updatedAt = timestamp;
      changed.add(id);
    }
    return;
  }
  if (intent.type === "update-node") {
    const id = safeSegment(intent.nodeId, "Node id");
    const node = nodes.get(id);
    if (!node) throw new DesignStorageError("not-found", `Design Node ${id} was not found`);
    const patch = intent.patch;
    if (!patch || typeof patch !== "object") throw new DesignStorageError("invalid-input", "Node patch is invalid");
    if (patch.name !== undefined) node.name = nodeName(patch.name, node.kind);
    if (patch.geometry !== undefined) node.geometry = geometry(patch.geometry, node.geometry);
    if (patch.selectedVersionId !== undefined) {
      if (patch.selectedVersionId !== null) {
        safeSegment(patch.selectedVersionId, "Version id");
        const selected = await getDesignVersionUnlocked(designRoot(dataDir, projectId), node.id, patch.selectedVersionId);
        const expectedContentKind: DesignVersionContentKind = (DESIGN_GENERATIVE_NODE_KINDS as readonly string[])
          .includes(node.kind) ? "html" : "asset";
        if (selected.contentKind !== expectedContentKind) {
          throw new DesignStorageError("corrupt", `Design Version ${selected.id} does not match Node kind ${node.kind}`);
        }
      }
      node.selectedVersionId = patch.selectedVersionId;
    }
    node.updatedAt = timestamp;
    changed.add(id);
    return;
  }
  throw new DesignStorageError("invalid-input", "Canvas intent is unsupported");
}

export async function mutateDesignCanvas(
  dataDir: string,
  projectId: string,
  input: {
    expectedRevision: number;
    intents: DesignCanvasIntent[];
    /** Internal Main Agent application receipt committed with the Canvas bytes. */
    mainPlanApplication?: { jobId: string; receiptKey: string; planHash: string };
  },
  now?: number,
): Promise<DesignCanvas> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    await requireInitialized(root);
    await recoverPendingAssetImportsUnlocked(root);
    const project = await readProject(root);
    let mainPlanReceipt: DesignProjectFile["turnReceipts"][string] | null = null;
    if (input.mainPlanApplication !== undefined) {
      const application = input.mainPlanApplication;
      if (!application || typeof application !== "object" || Array.isArray(application)
        || Object.keys(application).some((key) => !["jobId", "receiptKey", "planHash"].includes(key))
        || typeof application.receiptKey !== "string" || !application.receiptKey
        || application.receiptKey.length > 512 || !SHA256.test(application.planHash)) {
        throw new DesignStorageError("invalid-input", "Main Agent plan application receipt is invalid");
      }
      const jobId = safeSegment(application.jobId, "Job id");
      const receipt = project.turnReceipts[application.receiptKey];
      const job = await readJob(root, jobId);
      const execution = await readDesignMainPlanExecutionUnlocked(root, project, application.receiptKey);
      if (!receipt || receipt.kind !== "main-agent" || receipt.nodeId !== null || receipt.jobId !== job.id
        || receipt.authorityHash !== job.contextHash || job.kind !== "main-agent" || job.status !== "running"
        || execution === null || execution.planHash !== application.planHash) {
        throw new DesignStorageError("conflict", "Main Agent plan application requires its active Job authority");
      }
      if (receipt.mainPlanAppliedRevision !== undefined) return canvas(project, readNodes(project));
      mainPlanReceipt = receipt;
    }
    if (!Number.isSafeInteger(input?.expectedRevision) || input.expectedRevision < 0) {
      throw new DesignStorageError("invalid-input", "expectedRevision is invalid");
    }
    if (input.expectedRevision !== project.revision) {
      throw new DesignRevisionConflictError(input.expectedRevision, project.revision);
    }
    if (!Array.isArray(input.intents) || input.intents.length > 100
      || (input.intents.length < 1 && mainPlanReceipt === null)) {
      throw new DesignStorageError("invalid-input", "Canvas mutation must contain 1 to 100 intents");
    }
    const timestamp = nowValue(now);
    const nodes = readNodes(project);
    if (input.intents.length === 0) {
      mainPlanReceipt!.mainPlanAppliedRevision = project.revision;
      project.updatedAt = Math.max(project.updatedAt, timestamp);
      await writeAtomicJson(projectFilePath(root), project);
      return canvas(project, nodes);
    }
    const before = snapshot(project, nodes);
    const changed = new Set<string>();
    for (const intent of input.intents) await applyIntent(dataDir, projectId, project, nodes, intent, timestamp, changed);
    project.nodes = project.nodeOrder.map((id) => cloneNode(nodes.get(id)!));
    if (input.intents.some((intent) => intent.type !== "set-viewport")) {
      project.undo = [...project.undo, before].slice(-MAX_HISTORY);
      project.redo = [];
    }
    project.revision += 1;
    if (mainPlanReceipt !== null) mainPlanReceipt.mainPlanAppliedRevision = project.revision;
    project.updatedAt = Math.max(project.updatedAt, timestamp);
    await writeAtomicJson(projectFilePath(root), project);
    return canvas(project, nodes);
  });
}

async function restoreCanvasHistory(
  dataDir: string,
  projectId: string,
  expectedRevision: number,
  direction: "undo" | "redo",
  now?: number,
): Promise<DesignCanvas> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    await requireInitialized(root);
    const project = await readProject(root);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== project.revision) {
      throw new DesignRevisionConflictError(expectedRevision, project.revision);
    }
    const source = direction === "undo" ? project.undo : project.redo;
    if (source.length === 0) throw new DesignStorageError("conflict", `There is nothing to ${direction}`);
    const currentNodes = readNodes(project);
    const current = snapshot(project, currentNodes);
    const target = source.at(-1)!;
    const targetNodeIds = new Set(target.nodeOrder);
    const activeNodeRemoved = project.nodeOrder.find((id) => (
      currentNodes.get(id)?.activeJobId !== null && !targetNodeIds.has(id)
    ));
    const activeNodeRevived = target.nodes.find((node) => (
      node.activeJobId !== null && !currentNodes.has(node.id)
    ));
    if (activeNodeRemoved || activeNodeRevived) {
      throw new DesignStorageError(
        "conflict",
        "Cancel active scoped Agent Jobs before undoing or redoing a structural Node change",
      );
    }
    // A Node id is also the durable namespace for its immutable Versions and
    // scoped Agent thread. History may restore that same Node, but once any
    // restore removes it from the live Canvas, a later add-node must never
    // alias a fresh Node onto the old on-disk namespace.
    retireNodeIdentities(project, project.nodeOrder.filter((id) => !targetNodeIds.has(id)));
    const restored = new Map(target.nodes.map((snapshotNode) => {
      const currentNode = currentNodes.get(snapshotNode.id);
      if (!currentNode) return [snapshotNode.id, cloneNode(snapshotNode)] as const;
      const generationAuthorityAdvanced = currentNode.currentVersionId !== snapshotNode.currentVersionId;
      return [snapshotNode.id, {
        ...cloneNode(snapshotNode),
        state: currentNode.state,
        currentVersionId: currentNode.currentVersionId,
        selectedVersionId: generationAuthorityAdvanced
          ? currentNode.selectedVersionId
          : snapshotNode.selectedVersionId,
        versionCount: currentNode.versionCount,
        assetId: currentNode.assetId,
        activeJobId: currentNode.activeJobId,
        error: currentNode.error,
        updatedAt: currentNode.updatedAt,
      }] as const;
    }));
    for (const id of target.nodeOrder) {
      if (!restored.get(id)) throw new DesignStorageError("corrupt", "Canvas history snapshot is incomplete");
    }
    // Camera position is a durable user preference, not an undoable document edit.
    // Preserve the live viewport across undo/redo of ordinary Node mutations.
    project.nodeOrder = [...target.nodeOrder];
    project.nodes = project.nodeOrder.map((id) => cloneNode(restored.get(id)!));
    if (direction === "undo") {
      project.undo = project.undo.slice(0, -1);
      project.redo = [...project.redo, current].slice(-MAX_HISTORY);
    } else {
      project.redo = project.redo.slice(0, -1);
      project.undo = [...project.undo, current].slice(-MAX_HISTORY);
    }
    project.revision += 1;
    project.updatedAt = Math.max(project.updatedAt, nowValue(now));
    await writeAtomicJson(projectFilePath(root), project);
    return canvas(project, restored);
  });
}

export function undoDesignCanvas(
  dataDir: string,
  projectId: string,
  expectedRevision: number,
  now?: number,
): Promise<DesignCanvas> {
  return restoreCanvasHistory(dataDir, projectId, expectedRevision, "undo", now);
}

export function redoDesignCanvas(
  dataDir: string,
  projectId: string,
  expectedRevision: number,
  now?: number,
): Promise<DesignCanvas> {
  return restoreCanvasHistory(dataDir, projectId, expectedRevision, "redo", now);
}

function displayAssetName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)
    || Buffer.byteLength(value, "utf8") > 240) {
    throw new DesignStorageError("invalid-input", "Asset name is invalid");
  }
  return value.trim();
}

function mimeType(value: unknown): string {
  if (typeof value !== "string" || value.length > 120
    || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(value)) {
    throw new DesignStorageError("invalid-input", "Asset mimeType is invalid");
  }
  return value.toLowerCase();
}

function extensionFor(name: string, type: string): string {
  const candidate = extname(basename(name)).toLowerCase();
  if (/^\.[a-z0-9]{1,12}$/.test(candidate)) return candidate;
  const known: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "text/markdown": ".md",
  };
  return known[type] ?? ".bin";
}

function strictBase64(value: unknown): Buffer {
  if (typeof value !== "string" || value.length === 0
    || value.length > Math.ceil(MAX_DESIGN_ASSET_BYTES / 3) * 4 + 4
    || value.length % 4 !== 0) {
    throw new DesignStorageError("invalid-input", "Asset base64 is invalid");
  }
  // Do not validate a multi-megabyte payload with a repeated-group RegExp.
  // V8's RegExp engine recursively backtracks that shape and overflows the
  // JavaScript stack for otherwise valid local images around 4 MiB or larger.
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const valid = (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 43
      || code === 47;
    if (!valid) throw new DesignStorageError("invalid-input", "Asset base64 is invalid");
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) {
      throw new DesignStorageError("invalid-input", "Asset base64 is invalid");
    }
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 1 || bytes.length > MAX_DESIGN_ASSET_BYTES || bytes.toString("base64") !== value) {
    throw new DesignStorageError("invalid-input", "Asset base64 is invalid or exceeds the size limit");
  }
  return bytes;
}

function validateAssetSignature(bytes: Buffer, type: string): void {
  const matches = (() => {
    switch (type) {
      case "image/png":
        return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      case "image/jpeg":
        return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      case "image/gif":
        return bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a";
      case "image/webp":
        return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF"
          && bytes.subarray(8, 12).toString("ascii") === "WEBP";
      case "application/pdf":
        return bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-";
      default:
        return true;
    }
  })();
  if (!matches) throw new DesignStorageError("invalid-input", `Asset bytes do not match declared mimeType ${type}`);
}

function matchesMaterialNodeKind(kind: DesignNodeKind, type: string): boolean {
  if (kind === "file") return true;
  if (kind === "image") return type.startsWith("image/");
  if (kind === "video") return type.startsWith("video/");
  if (kind !== "document") return false;
  return type === "application/pdf" || type === "application/rtf" || type === "text/rtf"
    || type.startsWith("text/") || type.includes("document") || type.includes("presentation")
    || type.includes("sheet") || type.includes("wordprocessingml")
    || type.includes("presentationml") || type.includes("spreadsheetml");
}

function uploadedRefName(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith(".refs/")) {
    throw new DesignStorageError("invalid-input", "uploadedFileId must be exactly .refs/<safe basename>");
  }
  const name = value.slice(".refs/".length);
  if (!name || name !== basename(name) || name.length > 80 || !/^[A-Za-z0-9._-]+$/.test(name)
    || value !== `.refs/${name}`) {
    throw new DesignStorageError("invalid-input", "uploadedFileId must be exactly .refs/<safe basename>");
  }
  return name;
}

async function readUploadedRef(dataDir: string, projectId: string, uploadedFileId: unknown): Promise<Buffer> {
  const name = uploadedRefName(uploadedFileId);
  const refsRoot = resolve(dataDir, "projects", safeSegment(projectId, "Project id"), ".refs");
  const path = resolve(refsRoot, name);
  if (path !== join(refsRoot, name) || !path.startsWith(`${refsRoot}${sep}`)) {
    throw new DesignStorageError("invalid-input", "uploadedFileId escapes the Project reference directory");
  }
  let handle;
  try {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    handle = await open(path, flags);
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_DESIGN_ASSET_BYTES) {
      throw new DesignStorageError("invalid-input", "Uploaded reference is not a bounded regular file");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) {
      throw new DesignStorageError("conflict", "Uploaded reference changed while it was being ingested");
    }
    return bytes;
  } catch (error) {
    if (error instanceof DesignStorageError) throw error;
    throw new DesignStorageError("invalid-input", "Uploaded reference is unavailable or unsafe", { cause: error });
  } finally {
    await handle?.close().catch(() => {});
  }
}

function designAssetIdentity(input: {
  checksum: string;
  mimeType: string;
  name: string;
  bundleFiles: DesignAssetBundleFile[];
  sourceVersion: DesignAssetManifest["sourceVersion"] | null;
}): string {
  return JSON.stringify({
    checksum: input.checksum,
    mimeType: input.mimeType,
    name: input.name,
    bundleFiles: input.bundleFiles,
    sourceVersion: input.sourceVersion,
  });
}

function assertStoredAssetManifest(value: unknown, expectedId: string): asserts value is DesignAssetManifest {
  const manifest = storedRecord(value, `Design Asset ${expectedId} manifest`, [
    "schemaVersion", "id", "name", "mimeType", "checksum", "bytes", "fileName", "bundleFiles", "sourceVersion", "createdAt",
  ]);
  assertStoredBundleFiles(manifest.bundleFiles, `Design Asset ${expectedId} bundle`);
  if (manifest.schemaVersion !== DESIGN_SCHEMA_VERSION || manifest.id !== expectedId
    || !SAFE_SEGMENT.test(expectedId)
    || !validStoredText(manifest.name, 256)
    || !validStoredText(manifest.mimeType, 120)
    || !SHA256.test(String(manifest.checksum))
    || !Number.isSafeInteger(manifest.bytes) || (manifest.bytes as number) < 1
    || (manifest.bytes as number) > MAX_DESIGN_ASSET_BYTES
    || typeof manifest.fileName !== "string" || basename(manifest.fileName) !== manifest.fileName
    || !SAFE_SEGMENT.test(manifest.fileName)
    || !validStoredTimestamp(manifest.createdAt)) {
    throw new DesignStorageError("corrupt", `Design Asset ${expectedId} manifest is invalid`);
  }
  let sourceVersion: DesignAssetManifest["sourceVersion"] | null = null;
  if (manifest.sourceVersion !== undefined) {
    const source = storedRecord(manifest.sourceVersion, `Design Asset ${expectedId} sourceVersion`, [
      "projectId", "nodeId", "versionId", "checksum", "assetPins",
    ]);
    if (typeof source.projectId !== "string" || !SAFE_SEGMENT.test(source.projectId)
      || typeof source.nodeId !== "string" || !SAFE_SEGMENT.test(source.nodeId)
      || typeof source.versionId !== "string" || !SAFE_SEGMENT.test(source.versionId)
      || !SHA256.test(String(source.checksum))
      || !Array.isArray(source.assetPins) || source.assetPins.length > MAX_ASSET_BUNDLE_FILES) {
      throw new DesignStorageError("corrupt", `Design Asset ${expectedId} sourceVersion is invalid`);
    }
    const bundleByPath = new Map((manifest.bundleFiles as DesignAssetBundleFile[]).map((file) => [file.path, file]));
    const pinIds = new Set<string>();
    for (const [index, entry] of source.assetPins.entries()) {
      const pin = storedRecord(entry, `Design Asset ${expectedId} source pin ${index}`, [
        "assetId", "checksum", "bytes", "fileName", "bundlePath",
      ]);
      const bundlePath = safeBundlePath(pin.bundlePath, `Design Asset ${expectedId} source pin ${index} path`);
      const bundle = bundleByPath.get(bundlePath);
      if (typeof pin.assetId !== "string" || !/^asset-[a-f0-9]{32}$/.test(pin.assetId)
        || pinIds.has(pin.assetId) || !SHA256.test(String(pin.checksum))
        || !Number.isSafeInteger(pin.bytes) || (pin.bytes as number) < 1
        || typeof pin.fileName !== "string" || basename(pin.fileName) !== pin.fileName
        || !SAFE_SEGMENT.test(pin.fileName)
        || !bundle || bundle.checksum !== pin.checksum || bundle.bytes !== pin.bytes) {
        throw new DesignStorageError("corrupt", `Design Asset ${expectedId} source pin ${index} is invalid`);
      }
      pinIds.add(pin.assetId);
    }
    sourceVersion = {
      projectId: source.projectId as string,
      nodeId: source.nodeId as string,
      versionId: source.versionId as string,
      checksum: source.checksum as string,
      assetPins: source.assetPins.map((entry) => {
        const pin = entry as NonNullable<DesignAssetManifest["sourceVersion"]>["assetPins"][number];
        return {
          assetId: pin.assetId,
          checksum: pin.checksum,
          bytes: pin.bytes,
          fileName: pin.fileName,
          bundlePath: pin.bundlePath,
        };
      }),
    };
  }
  const normalizedBundleFiles = (manifest.bundleFiles as DesignAssetBundleFile[]).map((file) => ({
    path: file.path,
    checksum: file.checksum,
    bytes: file.bytes,
  }));
  const identity = designAssetIdentity({
    checksum: manifest.checksum as string,
    mimeType: manifest.mimeType as string,
    name: manifest.name as string,
    bundleFiles: normalizedBundleFiles,
    sourceVersion,
  });
  const actualId = `asset-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
  if (actualId !== expectedId) {
    throw new DesignStorageError("corrupt", `Design Asset ${expectedId} does not match its content identity`);
  }
}

export interface DesignAssetStoreInput {
  name: string;
  mimeType?: string;
  base64?: string;
  uploadedFileId?: string;
  sourceVersion?: { projectId: string; nodeId: string; versionId: string };
}

export interface DesignCanvasAssetImport {
  asset: DesignAssetStoreInput;
  binding:
    | {
        type: "create-node";
        node: Extract<DesignCanvasIntent, { type: "add-node" }>["node"];
      }
    | { type: "append-version"; nodeId: string };
}

export type DesignAssetImportPhase = "marker" | "assets" | "versions" | "canvas";

export interface DesignAssetImportTestHooks {
  /** Test-only: leave the durable WAL exactly as a process exit would. */
  simulateProcessCrash?: boolean;
  afterPhase?: (phase: DesignAssetImportPhase) => void | Promise<void>;
}

export interface ImportedDesignMaterialVersion {
  canvas: DesignCanvas;
  node: DesignNode;
  version: DesignVersionManifest;
  asset: DesignAssetManifest;
}

type PreparedDesignAsset =
  | { manifest: DesignAssetManifest; target: string; existing: true }
  | {
      manifest: DesignAssetManifest;
      target: string;
      existing: false;
      bytes: Buffer;
      bundlePayloads: Array<{ file: DesignAssetBundleFile; bytes: Buffer }>;
    };

async function prepareDesignAsset(
  dataDir: string,
  projectId: string,
  root: string,
  input: DesignAssetStoreInput,
  now?: number,
): Promise<PreparedDesignAsset> {
    const name = displayAssetName(input?.name);
    const hasBase64 = typeof input?.base64 === "string";
    const hasUploaded = typeof input?.uploadedFileId === "string";
    const hasSourceVersion = input?.sourceVersion !== undefined;
    if (Number(hasBase64) + Number(hasUploaded) + Number(hasSourceVersion) !== 1) {
      throw new DesignStorageError("invalid-input", "Provide exactly one of base64, uploadedFileId, or sourceVersion");
    }
    let sourceVersion: DesignAssetManifest["sourceVersion"];
    let bundlePayloads: Array<{ file: DesignAssetBundleFile; bytes: Buffer }> = [];
    let bytes: Buffer;
    let type: string;
    if (hasSourceVersion) {
      const source = input.sourceVersion;
      if (!source || typeof source !== "object" || Array.isArray(source)
        || Object.keys(source).some((key) => !["projectId", "nodeId", "versionId"].includes(key))) {
        throw new DesignStorageError("invalid-input", "sourceVersion is invalid");
      }
      const sourceProjectId = safeSegment(source.projectId, "Source Project id");
      const sourceNodeId = safeSegment(source.nodeId, "Source Node id");
      const sourceVersionId = safeSegment(source.versionId, "Source Version id");
      // Same-Project imports already hold this Project lock. Re-entering the
      // public read barrier would deadlock; the current lock is the barrier.
      const resolved = sourceProjectId === projectId
        ? await resolveDesignVersionFileUnlocked(root, sourceNodeId, sourceVersionId, "index.html")
        : await resolveDesignVersionFile(dataDir, sourceProjectId, sourceNodeId, sourceVersionId, "index.html");
      bytes = await readFile(resolved.path);
      const copiedChecksum = createHash("sha256").update(bytes).digest("hex");
      if (copiedChecksum !== resolved.manifest.checksum) {
        throw new DesignStorageError("corrupt", "Source Design Version changed while it was being copied");
      }
      const sourcePins: NonNullable<DesignAssetManifest["sourceVersion"]>["assetPins"] = [];
      const seenBundlePaths = new Set<string>();
      for (const pin of resolved.manifest.assetPins) {
        const pinnedManifest = await getDesignAssetManifest(dataDir, sourceProjectId, pin.assetId);
        if (pinnedManifest.checksum !== pin.checksum) {
          throw new DesignStorageError("corrupt", "Source Design Version Asset pin changed while it was being copied");
        }
        const pinned = await resolveDesignAssetFile(dataDir, sourceProjectId, pin.assetId, pinnedManifest.fileName);
        const pinnedBytes = await readFile(pinned.path);
        if (pinnedBytes.length !== pinnedManifest.bytes
          || createHash("sha256").update(pinnedBytes).digest("hex") !== pinnedManifest.checksum) {
          throw new DesignStorageError("corrupt", "Source Design Version Asset changed while it was being copied");
        }
        const bundlePath = safeBundlePath(`bundle/assets/${pin.assetId}/${pinnedManifest.fileName}`);
        if (seenBundlePaths.has(bundlePath)) {
          throw new DesignStorageError("corrupt", "Source Design Version contains duplicate Asset pins");
        }
        seenBundlePaths.add(bundlePath);
        bundlePayloads.push({
          file: { path: bundlePath, checksum: pinnedManifest.checksum, bytes: pinnedManifest.bytes },
          bytes: pinnedBytes,
        });
        for (const nested of pinnedManifest.bundleFiles) {
          const nestedResolved = await resolveDesignAssetBundleFile(
            dataDir,
            sourceProjectId,
            pin.assetId,
            nested.path,
          );
          const nestedBytes = await readFile(nestedResolved.path);
          if (nestedBytes.length !== nested.bytes
            || createHash("sha256").update(nestedBytes).digest("hex") !== nested.checksum) {
            throw new DesignStorageError("corrupt", "Source Design Version bundled Asset changed while it was being copied");
          }
          const nestedPath = safeBundlePath(`bundle/assets/${pin.assetId}/${nested.path}`);
          if (seenBundlePaths.has(nestedPath)) {
            throw new DesignStorageError("corrupt", "Source Design Version contains duplicate bundled Asset paths");
          }
          seenBundlePaths.add(nestedPath);
          bundlePayloads.push({
            file: { path: nestedPath, checksum: nested.checksum, bytes: nested.bytes },
            bytes: nestedBytes,
          });
        }
        const canonical = `/api/projects/${sourceProjectId}/design-canvas/assets/${pin.assetId}/${pinnedManifest.fileName}`
          + `?nodeId=${sourceNodeId}&versionId=${sourceVersionId}&checksum=${pin.checksum}`;
        bytes = Buffer.from(bytes.toString("utf8").replaceAll(canonical, bundlePath), "utf8");
        sourcePins.push({
          assetId: pin.assetId,
          checksum: pin.checksum,
          bytes: pinnedManifest.bytes,
          fileName: pinnedManifest.fileName,
          bundlePath,
        });
      }
      if (bytes.toString("utf8").includes(`/api/projects/${sourceProjectId}/design-canvas/assets/`)) {
        throw new DesignStorageError("corrupt", "Source Design Version contains an unbound Asset reference");
      }
      type = "text/html";
      if (input.mimeType !== undefined && mimeType(input.mimeType) !== type) {
        throw new DesignStorageError("invalid-input", "sourceVersion assets must use text/html");
      }
      sourceVersion = {
        projectId: sourceProjectId,
        nodeId: sourceNodeId,
        versionId: sourceVersionId,
        checksum: resolved.manifest.checksum,
        assetPins: sourcePins,
      };
    } else {
      type = mimeType(input?.mimeType);
      bytes = hasBase64
        ? strictBase64(input.base64)
        : await readUploadedRef(dataDir, projectId, input.uploadedFileId);
    }
    bundlePayloads = bundlePayloads.sort((left, right) => left.file.path.localeCompare(right.file.path));
    const bundleFiles = bundlePayloads.map((payload) => payload.file);
    assertStoredBundleFiles(bundleFiles, "Design Asset bundle");
    if (bytes.length < 1 || bytes.length > MAX_DESIGN_ASSET_BYTES) {
      throw new DesignStorageError("limit", "Design Asset payload exceeds its bounded size");
    }
    validateAssetSignature(bytes, type);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const identity = designAssetIdentity({
      checksum,
      mimeType: type,
      name,
      bundleFiles,
      sourceVersion: sourceVersion ?? null,
    });
    const id = `asset-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
    const target = assetRoot(root, id);
    const manifestPath = join(target, "manifest.json");
    if (await exists(manifestPath)) {
      const existing = await readJson<DesignAssetManifest>(manifestPath, `Design Asset ${id}`);
      assertStoredAssetManifest(existing, id);
      if (existing.checksum === checksum && existing.bytes === bytes.length && existing.mimeType !== type) {
        throw new DesignStorageError(
          "conflict",
          `The same Asset bytes are already stored with mimeType ${existing.mimeType}`,
        );
      }
      if (existing.checksum !== checksum || existing.bytes !== bytes.length) {
        throw new DesignStorageError("corrupt", `Design Asset ${id} does not match its content identity`);
      }
      return { manifest: existing, target, existing: true };
    }
    const timestamp = nowValue(now);
    const fileName = sourceVersion ? "original.html" : `original${extensionFor(name, type)}`;
    const manifest: DesignAssetManifest = {
      schemaVersion: DESIGN_SCHEMA_VERSION,
      id,
      name,
      mimeType: type,
      checksum,
      bytes: bytes.length,
      fileName,
      bundleFiles,
      ...(sourceVersion ? { sourceVersion } : {}),
      createdAt: timestamp,
    };
    return { manifest, target, existing: false, bytes, bundlePayloads };
}

async function persistPreparedDesignAsset(root: string, prepared: PreparedDesignAsset): Promise<boolean> {
    if (prepared.existing) return false;
    const { manifest, target, bytes, bundlePayloads } = prepared;
    const { id, fileName, checksum, mimeType: type } = manifest;
    const manifestPath = join(target, "manifest.json");
    const pendingParent = join(root, "assets", ".pending");
    const pending = join(pendingParent, `${id}.${randomUUID()}`);
    await mkdir(pending, { recursive: true });
    try {
      await writeFile(join(pending, fileName), bytes, { flag: "wx", mode: 0o600 });
      for (const payload of bundlePayloads) {
        const path = join(pending, ...payload.file.path.split("/"));
        await mkdir(resolve(path, ".."), { recursive: true });
        await writeFile(path, payload.bytes, { flag: "wx", mode: 0o600 });
      }
      await writeFile(join(pending, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await rename(pending, target);
    } catch (error) {
      await rm(pending, { recursive: true, force: true }).catch(() => {});
      if (await exists(manifestPath)) {
        const existing = await readJson<DesignAssetManifest>(manifestPath, `Design Asset ${id}`);
        assertStoredAssetManifest(existing, id);
        if (existing.checksum === checksum && existing.bytes === bytes.length && existing.mimeType === type) return false;
        if (existing.checksum === checksum && existing.mimeType !== type) {
          throw new DesignStorageError("conflict", `The same Asset bytes are already stored with mimeType ${existing.mimeType}`);
        }
      }
      throw error;
    }
    return true;
}

async function stagePreparedDesignAsset(directory: string, prepared: PreparedDesignAsset): Promise<void> {
  if (prepared.existing) return;
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(join(directory, prepared.manifest.fileName), prepared.bytes, { flag: "wx", mode: 0o600 });
    for (const payload of prepared.bundlePayloads) {
      const path = join(directory, ...payload.file.path.split("/"));
      await mkdir(resolve(path, ".."), { recursive: true });
      await writeFile(path, payload.bytes, { flag: "wx", mode: 0o600 });
    }
    await writeFile(
      join(directory, "manifest.json"),
      `${JSON.stringify(prepared.manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

interface DesignAssetImportTransactionBinding {
  createdNode: boolean;
  nodeId: string;
  assetId: string;
  previousHeadVersionId: string | null;
  previousSelectedVersionId: string | null;
  previousVersionCount: number;
  previousAssetId: string | null;
  selectedVersionIdAfter: string | null;
  manifest: DesignVersionManifest;
}

interface DesignAssetImportTransaction {
  schemaVersion: typeof DESIGN_SCHEMA_VERSION;
  projectId: string;
  expectedRevision: number;
  nextRevision: number;
  createdAssetIds: string[];
  bindings: DesignAssetImportTransactionBinding[];
  checksum: string;
}

interface DesignAssetImportOutcome {
  canvas: DesignCanvas;
  bindings: Array<{
    node: DesignNode;
    version: DesignVersionManifest;
    asset: DesignAssetManifest;
  }>;
}

function assetImportTransactionsRoot(root: string): string {
  return join(root, "assets", ".transactions");
}

function assetImportTransactionChecksum(
  value: Omit<DesignAssetImportTransaction, "checksum">,
): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function assertAssetImportTransaction(
  value: unknown,
  expectedProjectId: string,
): asserts value is DesignAssetImportTransaction {
  const transaction = storedRecord(value, "Design Asset import transaction", [
    "schemaVersion", "projectId", "expectedRevision", "nextRevision", "createdAssetIds", "bindings", "checksum",
  ]);
  if (transaction.schemaVersion !== DESIGN_SCHEMA_VERSION
    || transaction.projectId !== expectedProjectId || !SAFE_SEGMENT.test(expectedProjectId)
    || !Number.isSafeInteger(transaction.expectedRevision) || (transaction.expectedRevision as number) < 0
    || !Number.isSafeInteger(transaction.nextRevision)
    || transaction.nextRevision !== (transaction.expectedRevision as number) + 1
    || !Array.isArray(transaction.createdAssetIds)
    || transaction.createdAssetIds.length > MAX_DESIGN_ASSET_BATCH_ITEMS
    || !Array.isArray(transaction.bindings)
    || transaction.bindings.length < 1
    || transaction.bindings.length > MAX_DESIGN_ASSET_BATCH_ITEMS
    || typeof transaction.checksum !== "string" || !SHA256.test(transaction.checksum)) {
    throw new DesignStorageError("corrupt", "Design Asset import transaction is invalid");
  }
  const { checksum, ...content } = transaction;
  if (checksum !== assetImportTransactionChecksum(
    content as Omit<DesignAssetImportTransaction, "checksum">,
  )) {
    throw new DesignStorageError("corrupt", "Design Asset import transaction checksum is invalid");
  }
  const assetIds = new Set<string>();
  for (const assetId of transaction.createdAssetIds) {
    if (typeof assetId !== "string" || !SAFE_SEGMENT.test(assetId) || assetIds.has(assetId)) {
      throw new DesignStorageError("corrupt", "Design Asset import transaction Asset identity is invalid");
    }
    assetIds.add(assetId);
  }
  const nodeIds = new Set<string>();
  for (const value of transaction.bindings) {
    const binding = storedRecord(value, "Design Asset import transaction binding", [
      "createdNode", "nodeId", "assetId", "previousHeadVersionId", "previousSelectedVersionId",
      "previousVersionCount", "previousAssetId", "selectedVersionIdAfter", "manifest",
    ]);
    if (typeof binding.nodeId !== "string" || !SAFE_SEGMENT.test(binding.nodeId) || nodeIds.has(binding.nodeId)
      || typeof binding.assetId !== "string" || !/^asset-[a-f0-9]{32}$/.test(binding.assetId)
      || typeof binding.createdNode !== "boolean"
      || !validStoredNullableId(binding.previousHeadVersionId)
      || !validStoredNullableId(binding.previousSelectedVersionId)
      || !Number.isSafeInteger(binding.previousVersionCount) || (binding.previousVersionCount as number) < 0
      || !validStoredNullableId(binding.previousAssetId)
      || !validStoredNullableId(binding.selectedVersionIdAfter)
      || !binding.manifest || typeof binding.manifest !== "object") {
      throw new DesignStorageError("corrupt", "Design Asset import transaction binding is invalid");
    }
    const manifest = binding.manifest as DesignVersionManifest;
    const versionId = (manifest as { id?: unknown }).id;
    if (typeof versionId !== "string") {
      throw new DesignStorageError("corrupt", "Design Asset import transaction Version is invalid");
    }
    assertStoredVersionManifest(manifest, binding.nodeId, versionId);
    if (manifest.contentKind !== "asset" || manifest.assetId !== binding.assetId
      || manifest.canvasRevision !== transaction.expectedRevision || manifest.publicationStatus !== "published"
      || manifest.expectedHeadVersionId !== binding.previousHeadVersionId
      || manifest.sequence !== (binding.previousVersionCount as number) + 1
      || (binding.selectedVersionIdAfter !== manifest.id
        && binding.selectedVersionIdAfter !== binding.previousSelectedVersionId)
      || (binding.createdNode && (
        binding.previousHeadVersionId !== null || binding.previousSelectedVersionId !== null
        || binding.previousVersionCount !== 0 || binding.previousAssetId !== null
        || binding.selectedVersionIdAfter !== manifest.id
      ))) {
      throw new DesignStorageError("corrupt", "Design Asset import transaction Version authority is invalid");
    }
    nodeIds.add(binding.nodeId);
  }
  const validatedBindings = transaction.bindings as DesignAssetImportTransactionBinding[];
  if ([...assetIds].some((assetId) => !validatedBindings.some((binding) => binding.assetId === assetId))) {
    throw new DesignStorageError("corrupt", "Design Asset import transaction contains an unbound Asset");
  }
}

async function verifyMaterialVersionManifestDirectory(
  directory: string,
  expected: DesignVersionManifest,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0]?.isFile() || entries[0].name !== "manifest.json") {
    throw new DesignStorageError("corrupt", `Material Design Version ${expected.id} payload is invalid`);
  }
  const manifest = await readJson<DesignVersionManifest>(
    join(directory, "manifest.json"),
    `Material Design Version ${expected.id}`,
  );
  assertStoredVersionManifest(manifest, expected.nodeId, expected.id);
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) {
    throw new DesignStorageError("corrupt", `Material Design Version ${expected.id} diverges from its WAL`);
  }
}

function assetImportBindingIsCommitted(
  node: DesignNode | undefined,
  binding: DesignAssetImportTransactionBinding,
): boolean {
  return node !== undefined
    && node.currentVersionId === binding.manifest.id
    && node.selectedVersionId === binding.selectedVersionIdAfter
    && node.versionCount === binding.previousVersionCount + 1
    && node.assetId === binding.assetId;
}

function assetImportBindingIsBefore(
  node: DesignNode | undefined,
  binding: DesignAssetImportTransactionBinding,
): boolean {
  if (binding.createdNode) return node === undefined;
  return node !== undefined
    && node.currentVersionId === binding.previousHeadVersionId
    && node.selectedVersionId === binding.previousSelectedVersionId
    && node.versionCount === binding.previousVersionCount
    && node.assetId === binding.previousAssetId;
}

async function recoverPendingAssetImportsUnlocked(root: string): Promise<void> {
  const transactionsRoot = assetImportTransactionsRoot(root);
  if (!(await exists(transactionsRoot))) return;
  const entries = (await readdir(transactionsRoot, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length === 0) return;
  for (const entry of entries) {
    const transactionRoot = join(transactionsRoot, entry.name);
    if (!entry.isDirectory() || !SAFE_SEGMENT.test(entry.name)) {
      throw new DesignStorageError("corrupt", "Design Asset import staging contains an invalid entry");
    }
    const transactionPath = join(transactionRoot, "transaction.json");
    if (!(await exists(transactionPath))) {
      await rm(transactionRoot, { recursive: true, force: true });
      continue;
    }
    const transaction = await readJson<DesignAssetImportTransaction>(transactionPath, "Design Asset import transaction");
    const projectId = basename(resolve(root, ".."));
    assertAssetImportTransaction(transaction, projectId);
    const project = await readProject(root);
    const nodes = readNodes(project);
    const committed = transaction.bindings.every((binding) =>
      assetImportBindingIsCommitted(nodes.get(binding.nodeId), binding));
    if (project.revision === transaction.nextRevision) {
      if (!committed) {
        throw new DesignStorageError("corrupt", "Committed Design Asset import has inconsistent Canvas authority");
      }
      for (const binding of transaction.bindings) {
        const asset = await getDesignAssetManifestUnlocked(root, binding.assetId);
        if (asset.checksum !== binding.manifest.checksum || asset.bytes !== binding.manifest.bytes) {
          throw new DesignStorageError("corrupt", "Committed Design Asset import Asset diverges from its Version");
        }
        await verifyMaterialVersionManifestDirectory(
          versionRoot(root, binding.nodeId, binding.manifest.id),
          binding.manifest,
        );
      }
    } else if (project.revision === transaction.expectedRevision) {
      if (!transaction.bindings.every((binding) =>
        assetImportBindingIsBefore(nodes.get(binding.nodeId), binding))) {
        throw new DesignStorageError("corrupt", "Interrupted Design Asset import lost its prior Canvas authority");
      }
      for (const binding of transaction.bindings) {
        const target = versionRoot(root, binding.nodeId, binding.manifest.id);
        if (await exists(target)) {
          await verifyMaterialVersionManifestDirectory(target, binding.manifest);
          await rm(target, { recursive: true, force: true });
        }
      }
      const referencedAssetIds = new Set(project.nodes.flatMap((node) => node.assetId ? [node.assetId] : []));
      for (const assetId of transaction.createdAssetIds) {
        if (referencedAssetIds.has(assetId)) {
          throw new DesignStorageError("corrupt", "Interrupted Design Asset import Asset became unexpectedly referenced");
        }
        const target = assetRoot(root, assetId);
        if (await exists(target)) {
          const asset = await getDesignAssetManifestUnlocked(root, assetId);
          const expected = transaction.bindings.find((binding) => binding.assetId === assetId)!.manifest;
          if (asset.checksum !== expected.checksum || asset.bytes !== expected.bytes) {
            throw new DesignStorageError("corrupt", "Interrupted Design Asset import Asset diverges from its WAL");
          }
          await rm(target, { recursive: true, force: true });
        }
      }
    } else {
      throw new DesignStorageError("corrupt", "Design Asset import WAL revision authority is invalid");
    }
    await rm(transactionRoot, { recursive: true, force: true });
  }
}

export async function storeDesignAsset(
  dataDir: string,
  projectId: string,
  input: DesignAssetStoreInput,
  now?: number,
): Promise<DesignAssetManifest> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    await requireInitialized(root);
    await recoverPendingAssetImportsUnlocked(root);
    const prepared = await prepareDesignAsset(dataDir, projectId, root, input, now);
    await persistPreparedDesignAsset(root, prepared);
    return prepared.manifest;
  });
}

function materialVersionManifest(
  projectId: string,
  node: DesignNode,
  asset: DesignAssetManifest,
  canvasRevision: number,
  timestamp: number,
): DesignVersionManifest {
  const id = `version-${randomUUID()}`;
  const expectedHeadVersionId = node.currentVersionId;
  return {
    schemaVersion: DESIGN_SCHEMA_VERSION,
    id,
    nodeId: node.id,
    contentKind: "asset",
    assetId: asset.id,
    sequence: node.versionCount + 1,
    checksum: asset.checksum,
    bytes: asset.bytes,
    contextHash: createHash("sha256").update(stableStringify({
      protocol: "dezin-material-version-v1",
      projectId,
      nodeId: node.id,
      assetId: asset.id,
      assetChecksum: asset.checksum,
      assetBytes: asset.bytes,
      canvasRevision,
      expectedHeadVersionId,
    })).digest("hex"),
    canvasRevision,
    expectedHeadVersionId,
    publicationStatus: "published",
    assetPins: [],
    jobId: null,
    runnerId: null,
    model: null,
    createdAt: timestamp,
  };
}

async function stageMaterialVersionManifest(
  directory: string,
  manifest: DesignVersionManifest,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
}

async function importDesignCanvasAssetBatchUnlocked(
  dataDir: string,
  projectId: string,
  root: string,
  input: { expectedRevision: number; items: DesignCanvasAssetImport[] },
  now?: number,
  hooks?: DesignAssetImportTestHooks,
): Promise<DesignAssetImportOutcome> {
    await requireInitialized(root);
    await recoverPendingAssetImportsUnlocked(root);
    const project = await readProject(root);
    if (!Number.isSafeInteger(input?.expectedRevision) || input.expectedRevision < 0) {
      throw new DesignStorageError("invalid-input", "expectedRevision is invalid");
    }
    if (input.expectedRevision !== project.revision) {
      throw new DesignRevisionConflictError(input.expectedRevision, project.revision);
    }
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > MAX_DESIGN_ASSET_BATCH_ITEMS) {
      throw new DesignStorageError(
        "invalid-input",
        `Asset import must contain 1 to ${MAX_DESIGN_ASSET_BATCH_ITEMS} items`,
      );
    }

    const timestamp = nowValue(now);
    const nodes = readNodes(project);
    const before = snapshot(project, nodes);
    const createdAssetIds = new Set<string>();
    const bindings: DesignAssetImportTransactionBinding[] = [];
    const imported: DesignAssetImportOutcome["bindings"] = [];
    const touchedNodeIds = new Set<string>();
    const transactionId = `import-${randomUUID()}`;
    const transactionRoot = join(assetImportTransactionsRoot(root), transactionId);
    let totalBytes = 0;
    let transaction: DesignAssetImportTransaction | null = null;
    let markerWritten = false;
    try {
      for (const item of input.items) {
        if (!item || typeof item !== "object" || Array.isArray(item)
          || Object.keys(item).some((key) => !["asset", "binding"].includes(key))) {
          throw new DesignStorageError("invalid-input", "Asset import item is invalid");
        }
        const prepared = await prepareDesignAsset(dataDir, projectId, root, item.asset, timestamp);
        const preparedBytes = prepared.manifest.bytes
          + prepared.manifest.bundleFiles.reduce((sum, file) => sum + file.bytes, 0);
        totalBytes += preparedBytes;
        if (totalBytes > MAX_DESIGN_ASSET_BATCH_BYTES) {
          throw new DesignStorageError("limit", "Asset import batch exceeds its bounded size");
        }
        if (!prepared.existing && !createdAssetIds.has(prepared.manifest.id)) {
          await stagePreparedDesignAsset(
            join(transactionRoot, "assets", prepared.manifest.id),
            prepared,
          );
          createdAssetIds.add(prepared.manifest.id);
        }
        const binding = item.binding;
        if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
          throw new DesignStorageError("invalid-input", "Asset import binding is invalid");
        }
        let importedNode: DesignNode;
        let createdNode = false;
        if (binding.type === "create-node") {
          if (Object.keys(binding).some((key) => !["type", "node"].includes(key))) {
            throw new DesignStorageError("invalid-input", "Asset create-Node binding is invalid");
          }
          importedNode = await addNode(dataDir, projectId, project, nodes, {
            type: "add-node",
            node: binding.node,
          }, timestamp);
          createdNode = true;
        } else if (binding.type === "append-version") {
          if (Object.keys(binding).some((key) => !["type", "nodeId"].includes(key))) {
            throw new DesignStorageError("invalid-input", "Asset append-Version binding is invalid");
          }
          const nodeId = safeSegment(binding.nodeId, "Node id");
          const existingNode = nodes.get(nodeId);
          if (!existingNode) throw new DesignStorageError("not-found", `Design Node ${nodeId} was not found`);
          importedNode = existingNode;
        } else {
          throw new DesignStorageError("invalid-input", "Asset import binding is unsupported");
        }
        if (touchedNodeIds.has(importedNode.id)) {
          throw new DesignStorageError("invalid-input", "Asset import batch may bind each material Node only once");
        }
        touchedNodeIds.add(importedNode.id);
        if ((DESIGN_GENERATIVE_NODE_KINDS as readonly string[]).includes(importedNode.kind)) {
          throw new DesignStorageError("invalid-input", "Only material Nodes may publish Asset Versions");
        }
        if (importedNode.activeJobId !== null) {
          throw new DesignStorageError("conflict", "Cancel the active scoped Agent Job before importing a material Version");
        }
        if (!matchesMaterialNodeKind(importedNode.kind, prepared.manifest.mimeType)) {
          throw new DesignStorageError(
            "invalid-input",
            `Asset ${prepared.manifest.id} mimeType does not match Node kind ${importedNode.kind}`,
          );
        }
        const previousHeadVersionId = importedNode.currentVersionId;
        const previousSelectedVersionId = importedNode.selectedVersionId;
        const previousVersionCount = importedNode.versionCount;
        const previousAssetId = importedNode.assetId;
        const followsHead = previousSelectedVersionId === null || previousSelectedVersionId === previousHeadVersionId;
        const manifest = materialVersionManifest(projectId, importedNode, prepared.manifest, project.revision, timestamp);
        const selectedVersionIdAfter = followsHead ? manifest.id : previousSelectedVersionId;
        await stageMaterialVersionManifest(
          join(transactionRoot, "versions", importedNode.id, manifest.id),
          manifest,
        );
        importedNode.currentVersionId = manifest.id;
        importedNode.selectedVersionId = selectedVersionIdAfter;
        importedNode.versionCount = previousVersionCount + 1;
        importedNode.assetId = prepared.manifest.id;
        importedNode.state = "ready";
        importedNode.error = null;
        importedNode.updatedAt = timestamp;
        bindings.push({
          createdNode,
          nodeId: importedNode.id,
          assetId: prepared.manifest.id,
          previousHeadVersionId,
          previousSelectedVersionId,
          previousVersionCount,
          previousAssetId,
          selectedVersionIdAfter,
          manifest,
        });
        imported.push({ node: importedNode, version: manifest, asset: prepared.manifest });
      }

      project.nodes = project.nodeOrder.map((id) => cloneNode(nodes.get(id)!));
      project.undo = [...project.undo, before].slice(-MAX_HISTORY);
      project.redo = [];
      project.revision += 1;
      project.updatedAt = Math.max(project.updatedAt, timestamp);
      const transactionContent: Omit<DesignAssetImportTransaction, "checksum"> = {
        schemaVersion: DESIGN_SCHEMA_VERSION,
        projectId,
        expectedRevision: input.expectedRevision,
        nextRevision: project.revision,
        createdAssetIds: [...createdAssetIds].sort(),
        bindings,
      };
      transaction = {
        ...transactionContent,
        checksum: assetImportTransactionChecksum(transactionContent),
      };
      await writeAtomicJson(join(transactionRoot, "transaction.json"), transaction);
      markerWritten = true;
      await hooks?.afterPhase?.("marker");
      for (const assetId of createdAssetIds) {
        await rename(join(transactionRoot, "assets", assetId), assetRoot(root, assetId));
      }
      await hooks?.afterPhase?.("assets");
      for (const binding of bindings) {
        await mkdir(join(nodeRoot(root, binding.nodeId), "versions"), { recursive: true });
        await rename(
          join(transactionRoot, "versions", binding.nodeId, binding.manifest.id),
          versionRoot(root, binding.nodeId, binding.manifest.id),
        );
      }
      await hooks?.afterPhase?.("versions");
      await writeAtomicJson(projectFilePath(root), project);
      await hooks?.afterPhase?.("canvas");
      await rm(transactionRoot, { recursive: true, force: true }).catch(() => {});
      const committedCanvas = canvas(project, nodes);
      return {
        canvas: committedCanvas,
        bindings: imported.map((entry) => ({ ...entry, node: cloneNode(nodes.get(entry.node.id)!) })),
      };
    } catch (error) {
      if (!markerWritten) {
        await rm(transactionRoot, { recursive: true, force: true });
        throw error;
      }
      if (hooks?.simulateProcessCrash) throw error;
      await recoverPendingAssetImportsUnlocked(root);
      const recoveredProject = await readProject(root);
      const recoveredNodes = readNodes(recoveredProject);
      if (transaction !== null && recoveredProject.revision === transaction.nextRevision
        && transaction.bindings.every((binding) =>
          assetImportBindingIsCommitted(recoveredNodes.get(binding.nodeId), binding))) {
        return {
          canvas: canvas(recoveredProject, recoveredNodes),
          bindings: imported.map((entry) => ({
            ...entry,
            node: cloneNode(recoveredNodes.get(entry.node.id)!),
          })),
        };
      }
      throw error;
    }
}

/**
 * Atomically ingest immutable Asset payloads and publish each material binding
 * as an immutable Node Version in one Canvas revision. The durable WAL owns the
 * Asset directories, Version manifests, and Canvas head transition together.
 */
export async function importDesignCanvasAssetBatch(
  dataDir: string,
  projectId: string,
  input: { expectedRevision: number; items: DesignCanvasAssetImport[] },
  now?: number,
  hooks?: DesignAssetImportTestHooks,
): Promise<DesignCanvas> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => (
    await importDesignCanvasAssetBatchUnlocked(dataDir, projectId, root, input, now, hooks)
  ).canvas);
}

export async function appendDesignMaterialVersion(
  dataDir: string,
  projectId: string,
  input: { expectedRevision: number; nodeId: string; asset: DesignAssetStoreInput },
  now?: number,
  hooks?: DesignAssetImportTestHooks,
): Promise<ImportedDesignMaterialVersion> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    const outcome = await importDesignCanvasAssetBatchUnlocked(dataDir, projectId, root, {
      expectedRevision: input.expectedRevision,
      items: [{
        asset: input.asset,
        binding: { type: "append-version", nodeId: input.nodeId },
      }],
    }, now, hooks);
    const binding = outcome.bindings[0];
    if (!binding) throw new DesignStorageError("corrupt", "Material Version import produced no binding");
    return { canvas: outcome.canvas, ...binding };
  });
}

async function getDesignAssetManifestUnlocked(
  root: string,
  assetId: string,
): Promise<DesignAssetManifest> {
  const manifest = await readJson<DesignAssetManifest>(
    join(assetRoot(root, assetId), "manifest.json"),
    `Design Asset ${assetId}`,
  );
  assertStoredAssetManifest(manifest, assetId);
  return manifest;
}

export async function getDesignAssetManifest(
  dataDir: string,
  projectId: string,
  assetId: string,
): Promise<DesignAssetManifest> {
  return getDesignAssetManifestUnlocked(designRoot(dataDir, projectId), assetId);
}

export async function listDesignAssets(dataDir: string, projectId: string): Promise<DesignAssetManifest[]> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    await requireInitialized(root);
    await recoverPendingAssetImportsUnlocked(root);
    const entries = await readdir(join(root, "assets"), { withFileTypes: true });
    const ids = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
    return Promise.all(ids.map((id) => getDesignAssetManifest(dataDir, projectId, id)));
  });
}

export async function resolveDesignAssetFile(
  dataDir: string,
  projectId: string,
  assetId: string,
  requestedFile: string,
): Promise<{ manifest: DesignAssetManifest; path: string }> {
  return resolveDesignAssetFileUnlocked(designRoot(dataDir, projectId), assetId, requestedFile);
}

async function resolveDesignAssetFileUnlocked(
  root: string,
  assetId: string,
  requestedFile: string,
): Promise<{ manifest: DesignAssetManifest; path: string }> {
  const manifest = await getDesignAssetManifestUnlocked(root, assetId);
  if (requestedFile !== manifest.fileName || basename(requestedFile) !== requestedFile) {
    throw new DesignStorageError("not-found", "Design Asset file was not found");
  }
  const path = join(assetRoot(root, assetId), manifest.fileName);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== manifest.bytes) {
    throw new DesignStorageError("corrupt", `Design Asset ${assetId} payload is invalid`);
  }
  const checksum = createHash("sha256").update(await readFile(path)).digest("hex");
  if (checksum !== manifest.checksum) {
    throw new DesignStorageError("corrupt", `Design Asset ${assetId} payload checksum is invalid`);
  }
  return { manifest, path };
}

export async function resolveDesignAssetBundleFile(
  dataDir: string,
  projectId: string,
  assetId: string,
  requestedFile: string,
): Promise<{ manifest: DesignAssetManifest; file: DesignAssetBundleFile; path: string }> {
  const manifest = await getDesignAssetManifest(dataDir, projectId, assetId);
  const normalized = safeBundlePath(requestedFile);
  const file = manifest.bundleFiles.find((candidate) => candidate.path === normalized);
  if (!file) throw new DesignStorageError("not-found", "Design Asset bundle file was not found");
  const root = assetRoot(designRoot(dataDir, projectId), assetId);
  const path = join(root, ...normalized.split("/"));
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes) {
    throw new DesignStorageError("corrupt", `Design Asset ${assetId} bundle payload is invalid`);
  }
  const checksum = createHash("sha256").update(await readFile(path)).digest("hex");
  if (checksum !== file.checksum) {
    throw new DesignStorageError("corrupt", `Design Asset ${assetId} bundle payload checksum is invalid`);
  }
  return { manifest, file, path };
}

function allowedDesignUrl(value: string, allowCanonicalAssets: boolean): boolean {
  const url = value.trim();
  if (url.startsWith("#") || url.startsWith("data:") || url.startsWith("blob:")) return true;
  if (/^dezin-asset:\/\/asset-[a-f0-9]{32}$/i.test(url)) return true;
  return allowCanonicalAssets
    && /^\/api\/projects\/[A-Za-z0-9._-]+\/design-canvas\/assets\/asset-[a-f0-9]{32}\/original\.[a-z0-9]{1,12}\?nodeId=[A-Za-z0-9._-]+&versionId=version-[A-Za-z0-9._-]+&checksum=[a-f0-9]{64}$/i.test(url);
}

interface DesignJavaScriptNode {
  type: string;
  [key: string]: unknown;
}

type DesignJavaScriptProvenance = "global" | "dom" | "style" | "local" | "unknown";

interface DesignJavaScriptScope {
  parent: DesignJavaScriptScope | null;
  kind: "program" | "parameter" | "function-body" | "static-block" | "block";
  bindings: Set<string>;
  constantStrings: Map<string, string>;
  possibleStrings: Map<string, ReadonlySet<string>>;
  possibleValues: Map<string, readonly unknown[]>;
  invalidatedBindings: Set<string>;
  reassignedBindings: Set<string>;
  initializers: Map<string, unknown>;
  stableValues: Map<string, unknown>;
  provenances: Map<string, DesignJavaScriptProvenance>;
  callables: Set<string>;
}

interface DesignJavaScriptIndex {
  bindings: WeakSet<object>;
  scopeByNode: WeakMap<object, DesignJavaScriptScope>;
  parentByNode: WeakMap<object, DesignJavaScriptNode | null>;
  thisOwnerByNode: WeakMap<object, DesignJavaScriptNode>;
  localThisFunctions: WeakSet<object>;
}

function designJavaScriptNode(value: unknown): value is DesignJavaScriptNode {
  return value !== null && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}

function forEachDesignJavaScriptChild(
  node: DesignJavaScriptNode,
  visit: (child: DesignJavaScriptNode, key: string) => void,
): void {
  for (const [key, child] of Object.entries(node)) {
    if (key === "loc" || key === "comments" || key === "tokens" || key === "errors") continue;
    if (Array.isArray(child)) {
      for (const entry of child) {
        if (designJavaScriptNode(entry)) visit(entry, key);
      }
    } else if (designJavaScriptNode(child)) {
      visit(child, key);
    }
  }
}

function visitDesignJavaScript(
  node: DesignJavaScriptNode,
  visit: (node: DesignJavaScriptNode, parent: DesignJavaScriptNode | null, key: string | null) => void,
  parent: DesignJavaScriptNode | null = null,
  key: string | null = null,
): void {
  visit(node, parent, key);
  forEachDesignJavaScriptChild(node, (child, childKey) => {
    visitDesignJavaScript(child, visit, node, childKey);
  });
}

function designJavaScriptFunction(node: DesignJavaScriptNode): boolean {
  return node.type === "FunctionDeclaration"
    || node.type === "FunctionExpression"
    || node.type === "ArrowFunctionExpression"
    || node.type === "ObjectMethod"
    || node.type === "ClassMethod"
    || node.type === "ClassPrivateMethod";
}

function designJavaScriptClass(node: DesignJavaScriptNode): boolean {
  return node.type === "ClassDeclaration" || node.type === "ClassExpression";
}

function addDesignJavaScriptBinding(
  value: unknown,
  scope: DesignJavaScriptScope,
  bindings: WeakSet<object>,
): void {
  if (!designJavaScriptNode(value)) return;
  if (value.type === "Identifier" && typeof value.name === "string") {
    scope.bindings.add(value.name);
    bindings.add(value);
    return;
  }
  if (value.type === "RestElement") {
    addDesignJavaScriptBinding(value.argument, scope, bindings);
    return;
  }
  if (value.type === "AssignmentPattern") {
    addDesignJavaScriptBinding(value.left, scope, bindings);
    return;
  }
  if (value.type === "ArrayPattern") {
    for (const element of Array.isArray(value.elements) ? value.elements : []) {
      addDesignJavaScriptBinding(element, scope, bindings);
    }
    return;
  }
  if (value.type === "ObjectPattern") {
    for (const property of Array.isArray(value.properties) ? value.properties : []) {
      if (!designJavaScriptNode(property)) continue;
      addDesignJavaScriptBinding(
        property.type === "RestElement" ? property.argument : property.value,
        scope,
        bindings,
      );
    }
  }
}

function nearestDesignJavaScriptVarScope(scope: DesignJavaScriptScope): DesignJavaScriptScope {
  let current = scope;
  while (!["program", "function-body", "static-block"].includes(current.kind) && current.parent !== null) {
    current = current.parent;
  }
  return current;
}

function newDesignJavaScriptScope(
  parent: DesignJavaScriptScope | null,
  kind: DesignJavaScriptScope["kind"],
): DesignJavaScriptScope {
  return {
    parent,
    kind,
    bindings: new Set<string>(),
    constantStrings: new Map<string, string>(),
    possibleStrings: new Map<string, ReadonlySet<string>>(),
    possibleValues: new Map<string, readonly unknown[]>(),
    invalidatedBindings: new Set<string>(),
    reassignedBindings: new Set<string>(),
    initializers: new Map<string, unknown>(),
    stableValues: new Map<string, unknown>(),
    provenances: new Map<string, DesignJavaScriptProvenance>(),
    callables: new Set<string>(),
  };
}

function indexDesignJavaScript(root: DesignJavaScriptNode): DesignJavaScriptIndex {
  const index: DesignJavaScriptIndex = {
    bindings: new WeakSet<object>(),
    scopeByNode: new WeakMap<object, DesignJavaScriptScope>(),
    parentByNode: new WeakMap<object, DesignJavaScriptNode | null>(),
    thisOwnerByNode: new WeakMap<object, DesignJavaScriptNode>(),
    localThisFunctions: new WeakSet<object>(),
  };
  const walk = (
    node: DesignJavaScriptNode,
    incoming: DesignJavaScriptScope | null,
    parent: DesignJavaScriptNode | null,
    incomingThisOwner: DesignJavaScriptNode | null,
  ): void => {
    if (node.type === "FunctionDeclaration" && incoming !== null) {
      addDesignJavaScriptBinding(node.id, incoming, index.bindings);
      if (designJavaScriptNode(node.id) && node.id.type === "Identifier" && typeof node.id.name === "string") {
        incoming.callables.add(node.id.name);
        incoming.stableValues.set(node.id.name, node);
      }
    } else if (node.type === "ClassDeclaration" && incoming !== null) {
      addDesignJavaScriptBinding(node.id, incoming, index.bindings);
      if (designJavaScriptNode(node.id) && node.id.type === "Identifier" && typeof node.id.name === "string") {
        incoming.stableValues.set(node.id.name, node);
      }
    }

    let scope = incoming;
    if (node.type === "Program") {
      scope = newDesignJavaScriptScope(null, "program");
    } else if (designJavaScriptFunction(node)) {
      scope = newDesignJavaScriptScope(incoming, "parameter");
      if (node.type === "FunctionExpression") {
        addDesignJavaScriptBinding(node.id, scope, index.bindings);
        if (designJavaScriptNode(node.id) && node.id.type === "Identifier" && typeof node.id.name === "string") {
          scope.callables.add(node.id.name);
        }
      }
      for (const parameter of Array.isArray(node.params) ? node.params : []) {
        addDesignJavaScriptBinding(parameter, scope, index.bindings);
      }
    } else if (designJavaScriptClass(node)) {
      scope = newDesignJavaScriptScope(incoming, "block");
      if (node.type === "ClassExpression") addDesignJavaScriptBinding(node.id, scope, index.bindings);
    } else if (node.type === "CatchClause") {
      scope = newDesignJavaScriptScope(incoming, "block");
      addDesignJavaScriptBinding(node.param, scope, index.bindings);
    } else if (node.type === "StaticBlock") {
      scope = newDesignJavaScriptScope(incoming, "static-block");
    } else if (node.type === "BlockStatement"
      || node.type === "ForStatement"
      || node.type === "ForInStatement"
      || node.type === "ForOfStatement"
      || node.type === "SwitchStatement") {
      scope = newDesignJavaScriptScope(incoming, "block");
    }
    if (scope === null) throw new Error("JavaScript AST has no Program scope");
    index.scopeByNode.set(node, scope);
    index.parentByNode.set(node, parent);
    if (incomingThisOwner !== null) index.thisOwnerByNode.set(node, incomingThisOwner);

    if (node.type === "VariableDeclarator" && parent?.type === "VariableDeclaration") {
      const target = parent.kind === "var" ? nearestDesignJavaScriptVarScope(scope) : scope;
      addDesignJavaScriptBinding(node.id, target, index.bindings);
      if (designJavaScriptNode(node.id) && node.id.type === "Identifier" && typeof node.id.name === "string") {
        if (target.stableValues.has(node.id.name)) {
          target.stableValues.delete(node.id.name);
          target.callables.delete(node.id.name);
          target.constantStrings.delete(node.id.name);
          target.possibleStrings.delete(node.id.name);
          target.possibleValues.delete(node.id.name);
          target.invalidatedBindings.add(node.id.name);
          target.reassignedBindings.add(node.id.name);
        } else {
          target.stableValues.set(node.id.name, node.init);
          if (designJavaScriptNode(node.init) && designJavaScriptFunction(node.init)) {
            target.callables.add(node.id.name);
          }
          if (parent.kind === "const") {
            target.initializers.set(node.id.name, node.init);
            const constant = staticDesignJavaScriptString(node.init);
            target.possibleValues.set(node.id.name, [node.init]);
            if (constant !== null) {
              target.constantStrings.set(node.id.name, constant);
              target.possibleStrings.set(node.id.name, new Set([constant]));
            }
          }
        }
      }
    } else if (node.type === "ImportSpecifier"
      || node.type === "ImportDefaultSpecifier"
      || node.type === "ImportNamespaceSpecifier") {
      addDesignJavaScriptBinding(node.local, scope, index.bindings);
    }

    const functionBodyScope = designJavaScriptFunction(node)
      ? newDesignJavaScriptScope(scope, "function-body")
      : null;
    forEachDesignJavaScriptChild(node, (child, key) => {
      const childScope = designJavaScriptFunction(node) && (key === "key" || key === "decorators")
        ? incoming
        : designJavaScriptFunction(node) && key === "body"
          ? functionBodyScope
        : scope;
      const thisOwner = designJavaScriptFunction(node) && node.type !== "ArrowFunctionExpression"
        ? node
        : incomingThisOwner;
      walk(child, childScope, node, thisOwner);
    });
  };
  walk(root, null, null, null);

  const invalidateStableValue = (
    value: unknown,
    scope: DesignJavaScriptScope | undefined,
    reassignsBinding = true,
  ): void => {
    if (!designJavaScriptNode(value)) return;
    if (value.type === "Identifier" && typeof value.name === "string") {
      const binding = designJavaScriptBindingScope(scope, value.name);
      binding?.stableValues.delete(value.name);
      binding?.callables.delete(value.name);
      binding?.constantStrings.delete(value.name);
      binding?.possibleStrings.delete(value.name);
      binding?.possibleValues.delete(value.name);
      binding?.invalidatedBindings.add(value.name);
      if (reassignsBinding) binding?.reassignedBindings.add(value.name);
      return;
    }
    if (value.type === "MemberExpression" || value.type === "OptionalMemberExpression") {
      invalidateStableValue(value.object, index.scopeByNode.get(value), false);
      return;
    }
    if (value.type === "RestElement") {
      invalidateStableValue(value.argument, scope, reassignsBinding);
      return;
    }
    if (value.type === "AssignmentPattern") {
      invalidateStableValue(value.left, scope, reassignsBinding);
      return;
    }
    if (value.type === "ArrayPattern") {
      for (const element of Array.isArray(value.elements) ? value.elements : []) {
        invalidateStableValue(element, scope, reassignsBinding);
      }
      return;
    }
    if (value.type === "ObjectPattern") {
      for (const property of Array.isArray(value.properties) ? value.properties : []) {
        if (!designJavaScriptNode(property)) continue;
        invalidateStableValue(
          property.type === "RestElement" ? property.argument : property.value,
          scope,
          reassignsBinding,
        );
      }
    }
  };
  visitDesignJavaScript(root, (node) => {
    if (node.type === "AssignmentExpression") {
      invalidateStableValue(node.left, index.scopeByNode.get(node));
    } else if (node.type === "UpdateExpression") {
      invalidateStableValue(node.argument, index.scopeByNode.get(node));
    } else if ((node.type === "ForInStatement" || node.type === "ForOfStatement")
      && (!designJavaScriptNode(node.left) || node.left.type !== "VariableDeclaration")) {
      invalidateStableValue(node.left, index.scopeByNode.get(node));
    } else if (node.type === "CallExpression" && designJavaScriptNode(node.callee)
      && (node.callee.type === "MemberExpression" || node.callee.type === "OptionalMemberExpression")) {
      const calleeName = designJavaScriptMemberName(node.callee, index);
      const calleePath = designJavaScriptGlobalPath(node.callee, index);
      const effective = calleePath === null ? null : designJavaScriptEffectivePath(calleePath);
      if ((effective?.root === "Object" && ["assign", "defineProperty"].includes(calleeName ?? ""))
        || (effective?.root === "Reflect" && calleeName === "set")) {
        invalidateStableValue(
          Array.isArray(node.arguments) ? node.arguments[0] : null,
          index.scopeByNode.get(node),
          false,
        );
      }
      if (["copyWithin", "fill", "pop", "push", "reverse", "shift", "sort", "splice", "unshift"]
        .includes(calleeName ?? "")) {
        invalidateStableValue(node.callee.object, index.scopeByNode.get(node), false);
      }
    }
  });

  interface StaticCallSite {
    args: unknown[];
    receiver: DesignJavaScriptProvenance | null;
  }
  const callSites = new Map<DesignJavaScriptNode, StaticCallSite[]>();
  const escapedFunctions = new WeakSet<object>();
  const recordCall = (
    callable: DesignJavaScriptNode,
    args: unknown[],
    receiver: DesignJavaScriptProvenance | null,
  ): void => {
    const existing = callSites.get(callable) ?? [];
    existing.push({ args, receiver });
    callSites.set(callable, existing);
  };
  visitDesignJavaScript(root, (node, parent, key) => {
    if ((node.type === "Identifier" || node.type === "MemberExpression" || node.type === "OptionalMemberExpression")
      && !index.bindings.has(node)) {
      const resolved = designJavaScriptStableValue(node, index);
      if (resolved !== null && designJavaScriptFunction(resolved)
        && !(parent?.type === "CallExpression" && key === "callee")) {
        escapedFunctions.add(resolved);
      }
    }
    if (node.type === "CallExpression" && designJavaScriptNode(node.callee)) {
      const callable = designJavaScriptStableValue(node.callee, index);
      if (callable !== null && designJavaScriptFunction(callable)) {
        const receiver = node.callee.type === "MemberExpression" || node.callee.type === "OptionalMemberExpression"
          ? designJavaScriptProvenance(node.callee.object, index)
          : null;
        recordCall(callable, Array.isArray(node.arguments) ? node.arguments : [], receiver);
      }
    }
    if (node.type === "NewExpression" && designJavaScriptNode(node.callee)) {
      const classNode = designJavaScriptStableValue(node.callee, index);
      if (classNode !== null && (classNode.type === "ClassDeclaration" || classNode.type === "ClassExpression")
        && designJavaScriptNode(classNode.body) && Array.isArray(classNode.body.body)) {
        const constructor = classNode.body.body.find((candidate) => designJavaScriptNode(candidate)
          && candidate.static !== true && designJavaScriptObjectPropertyName(candidate) === "constructor");
        if (designJavaScriptNode(constructor) && designJavaScriptFunction(constructor)) {
          recordCall(constructor, Array.isArray(node.arguments) ? node.arguments : [], "local");
        }
      }
    }
  });
  const assignLocalParameterProvenance = (
    pattern: unknown,
    scope: DesignJavaScriptScope,
  ): void => {
    if (!designJavaScriptNode(pattern)) return;
    if (pattern.type === "Identifier" && typeof pattern.name === "string") {
      if (!scope.invalidatedBindings.has(pattern.name)) scope.provenances.set(pattern.name, "local");
      return;
    }
    if (pattern.type === "RestElement") {
      assignLocalParameterProvenance(pattern.argument, scope);
      return;
    }
    if (pattern.type === "AssignmentPattern") {
      assignLocalParameterProvenance(pattern.left, scope);
      return;
    }
    if (pattern.type === "ArrayPattern") {
      for (const element of Array.isArray(pattern.elements) ? pattern.elements : []) {
        assignLocalParameterProvenance(element, scope);
      }
      return;
    }
    if (pattern.type === "ObjectPattern") {
      for (const property of Array.isArray(pattern.properties) ? pattern.properties : []) {
        if (!designJavaScriptNode(property)) continue;
        assignLocalParameterProvenance(
          property.type === "RestElement" ? property.argument : property.value,
          scope,
        );
      }
    }
  };
  const expandPossibleValues = (candidates: readonly unknown[]): readonly unknown[] | null => {
    const expanded: unknown[] = [];
    for (const candidate of candidates) {
      const possible = designJavaScriptPossibleValues(candidate, index);
      if (possible === null || expanded.length + possible.length > 256) return null;
      expanded.push(...possible);
    }
    return expanded;
  };
  const assignPossibleValueProvenance = (
    pattern: unknown,
    candidates: readonly unknown[],
    scope: DesignJavaScriptScope,
  ): void => {
    if (!designJavaScriptNode(pattern) || candidates.length === 0) return;
    const expanded = expandPossibleValues(candidates);
    if (expanded === null || expanded.length === 0) return;
    if (pattern.type === "Identifier" && typeof pattern.name === "string") {
      if (!scope.invalidatedBindings.has(pattern.name)) scope.possibleValues.set(pattern.name, expanded);
      return;
    }
    if (pattern.type === "AssignmentPattern") {
      assignPossibleValueProvenance(pattern.left, expanded.map((candidate) => (
        candidate === undefined ? pattern.right : candidate
      )), scope);
      return;
    }
    if (pattern.type === "ArrayPattern") {
      const arrays = expanded.map((candidate) => designJavaScriptPossibleValues(candidate, index)?.[0]);
      if (arrays.some((candidate) => !designJavaScriptNode(candidate) || candidate.type !== "ArrayExpression")) return;
      const elements = Array.isArray(pattern.elements) ? pattern.elements : [];
      for (let elementIndex = 0; elementIndex < elements.length; elementIndex += 1) {
        const element = elements[elementIndex];
        if (element === null || element === undefined) continue;
        const elementCandidates = arrays.map((candidate) => (
          designJavaScriptNode(candidate) && Array.isArray(candidate.elements)
            ? candidate.elements[elementIndex]
            : undefined
        ));
        if (elementCandidates.some((candidate) => candidate === null || candidate === undefined)) continue;
        assignPossibleValueProvenance(element, elementCandidates, scope);
      }
      return;
    }
    if (pattern.type === "ObjectPattern") {
      const objects = expanded.map((candidate) => designJavaScriptPossibleValues(candidate, index)?.[0]);
      if (objects.some((candidate) => !designJavaScriptNode(candidate) || candidate.type !== "ObjectExpression")) return;
      for (const property of Array.isArray(pattern.properties) ? pattern.properties : []) {
        if (!designJavaScriptNode(property) || property.type === "RestElement") continue;
        const propertyName = designJavaScriptObjectPropertyName(property);
        if (propertyName === null) continue;
        const propertyCandidates = objects.map((candidate) => designJavaScriptObjectPropertyValue(candidate, propertyName));
        if (propertyCandidates.some((candidate) => candidate === undefined)) continue;
        assignPossibleValueProvenance(property.value, propertyCandidates, scope);
      }
    }
  };
  const assignPossibleStringProvenance = (
    pattern: unknown,
    candidates: readonly unknown[],
    scope: DesignJavaScriptScope,
  ): void => {
    if (!designJavaScriptNode(pattern) || candidates.length === 0) return;
    if (pattern.type === "Identifier" && typeof pattern.name === "string") {
      if (scope.invalidatedBindings.has(pattern.name)) return;
      const values = new Set<string>();
      for (const candidate of candidates) {
        const possible = designJavaScriptPossibleConstantStrings(candidate, index);
        if (possible === null) return;
        for (const value of possible) {
          values.add(value);
          if (values.size > 256) return;
        }
      }
      scope.possibleStrings.set(pattern.name, values);
      if (values.size === 1) scope.constantStrings.set(pattern.name, values.values().next().value!);
      return;
    }
    if (pattern.type === "AssignmentPattern") {
      assignPossibleStringProvenance(pattern.left, candidates.map((candidate) => (
        candidate === undefined ? pattern.right : candidate
      )), scope);
      return;
    }
    if (pattern.type === "ArrayPattern") {
      const arrays = candidates.map((candidate) => designJavaScriptStableValue(candidate, index));
      if (arrays.some((candidate) => candidate?.type !== "ArrayExpression")) return;
      const elements = Array.isArray(pattern.elements) ? pattern.elements : [];
      for (let elementIndex = 0; elementIndex < elements.length; elementIndex += 1) {
        const element = elements[elementIndex];
        if (element === null || element === undefined) continue;
        const elementCandidates = arrays.map((candidate) => (
          Array.isArray(candidate?.elements) ? candidate.elements[elementIndex] : undefined
        ));
        if (elementCandidates.some((candidate) => candidate === null || candidate === undefined)) continue;
        assignPossibleStringProvenance(element, elementCandidates, scope);
      }
      return;
    }
    if (pattern.type === "ObjectPattern") {
      const objects = candidates.map((candidate) => designJavaScriptStableValue(candidate, index));
      if (objects.some((candidate) => candidate?.type !== "ObjectExpression")) return;
      for (const property of Array.isArray(pattern.properties) ? pattern.properties : []) {
        if (!designJavaScriptNode(property) || property.type === "RestElement") continue;
        const propertyName = designJavaScriptObjectPropertyName(property);
        if (propertyName === null) continue;
        const propertyCandidates = objects.map((candidate) => (
          designJavaScriptObjectPropertyValue(candidate, propertyName)
        ));
        if (propertyCandidates.some((candidate) => candidate === undefined)) continue;
        assignPossibleStringProvenance(property.value, propertyCandidates, scope);
      }
    }
  };
  const propagateLocalCallArguments = (): void => {
    for (const [callable, sites] of callSites) {
      if (escapedFunctions.has(callable) || sites.length === 0) continue;
      if (sites.every((site) => site.receiver === "local")) index.localThisFunctions.add(callable);
      const parameters = Array.isArray(callable.params) ? callable.params : [];
      const parameterScope = index.scopeByNode.get(callable);
      if (parameterScope === undefined) continue;
      for (let parameterIndex = 0; parameterIndex < parameters.length; parameterIndex += 1) {
        const parameter = parameters[parameterIndex];
        const allLocal = sites.every((site) => {
          const argument = site.args[parameterIndex];
          if (argument !== undefined) return designJavaScriptProvenance(argument, index) === "local";
          return designJavaScriptNode(parameter) && parameter.type === "AssignmentPattern"
            && designJavaScriptProvenance(parameter.right, index) === "local";
        });
        if (allLocal) assignLocalParameterProvenance(parameter, parameterScope);
        const stringArguments = sites.map((site) => {
          const argument = site.args[parameterIndex];
          return argument === undefined && designJavaScriptNode(parameter) && parameter.type === "AssignmentPattern"
            ? parameter.right
            : argument;
        });
        if (!stringArguments.some((argument) => argument === undefined)) {
          assignPossibleValueProvenance(parameter, stringArguments, parameterScope);
          assignPossibleStringProvenance(parameter, stringArguments, parameterScope);
        }
      }
    }
  };
  propagateLocalCallArguments();

  // Destructuring a statically local presentation record is not a browser-state
  // probe. Preserve the provenance through direct declarations, for-of loops,
  // and callbacks over a literal local array while leaving imported, DOM, and
  // global sources unknown/fail-closed.
  visitDesignJavaScript(root, (node, parent, key) => {
    if (node.type === "VariableDeclarator" && designJavaScriptNode(node.id)) {
      const declaration = index.parentByNode.get(node);
      let source = node.init;
      let loop: DesignJavaScriptNode | null = null;
      if (!designJavaScriptNode(source)) {
        loop = declaration === undefined || declaration === null
          ? null
          : index.parentByNode.get(declaration) ?? null;
        if (loop !== null && (loop.type === "ForOfStatement" || loop.type === "ForInStatement")
          && loop.left === declaration) source = loop.right;
      }
      const patternScope = index.scopeByNode.get(node.id);
      const stableDeclaration = declaration?.type === "VariableDeclaration"
        && (declaration.kind === "const"
          || ((loop?.type === "ForOfStatement" || loop?.type === "ForInStatement")
            && declaration.kind === "let"));
      if (stableDeclaration && patternScope !== undefined
        && designJavaScriptProvenance(source, index) === "local") {
        assignLocalParameterProvenance(node.id, patternScope);
        if (loop?.type === "ForOfStatement") {
          const collections = designJavaScriptPossibleValues(source, index);
          const elements = collections?.flatMap((collection) => (
            designJavaScriptNode(collection) && collection.type === "ArrayExpression" && Array.isArray(collection.elements)
              ? collection.elements
              : [undefined]
          )) ?? [];
          if (elements.length > 0 && !elements.some((element) => element === null || element === undefined)) {
            assignPossibleValueProvenance(node.id, elements, patternScope);
            assignPossibleStringProvenance(node.id, elements, patternScope);
          }
        } else if (designJavaScriptNode(source)) {
          assignPossibleValueProvenance(node.id, [source], patternScope);
          assignPossibleStringProvenance(node.id, [source], patternScope);
        }
      }
    }
    if (designJavaScriptFunction(node) && parent !== null
      && (parent.type === "CallExpression" || parent.type === "OptionalCallExpression")
      && key === "arguments" && designJavaScriptNode(parent.callee)
      && (parent.callee.type === "MemberExpression" || parent.callee.type === "OptionalMemberExpression")
      && ["every", "filter", "find", "findLast", "flatMap", "forEach", "map", "some"]
        .includes(designJavaScriptMemberName(parent.callee, index) ?? "")) {
      const receivers = designJavaScriptPossibleValues(parent.callee.object, index);
      const receiverElements = receivers?.flatMap((receiver) => (
        designJavaScriptNode(receiver) && receiver.type === "ArrayExpression" && Array.isArray(receiver.elements)
          ? receiver.elements
          : [undefined]
      )) ?? [];
      if (receiverElements.length === 0 || receiverElements.some((element) => element === null || element === undefined)) return;
      const parameterScope = index.scopeByNode.get(node);
      if (parameterScope === undefined) return;
      const parameters = Array.isArray(node.params) ? node.params : [];
      for (const parameter of parameters) assignLocalParameterProvenance(parameter, parameterScope);
      if (parameters[0] !== undefined) {
        assignPossibleValueProvenance(parameters[0], receiverElements, parameterScope);
        assignPossibleStringProvenance(parameters[0], receiverElements, parameterScope);
      }
    }
  });
  // Local loop/callback bindings can feed helper parameters, and helpers can
  // feed other helpers. Iterate over the finite static call graph so provenance
  // reaches a fixed point without treating escaped or imported callables as local.
  for (let pass = 0; pass <= callSites.size; pass += 1) propagateLocalCallArguments();
  return index;
}

function hasDesignJavaScriptBinding(scope: DesignJavaScriptScope | undefined, name: string): boolean {
  let current = scope;
  while (current !== undefined) {
    if (current.bindings.has(name)) return true;
    current = current.parent ?? undefined;
  }
  return false;
}

function designJavaScriptBindingScope(
  scope: DesignJavaScriptScope | undefined,
  name: string,
): DesignJavaScriptScope | null {
  let current = scope;
  while (current !== undefined) {
    if (current.bindings.has(name)) return current;
    current = current.parent ?? undefined;
  }
  return null;
}

function designJavaScriptStableValue(
  value: unknown,
  index: DesignJavaScriptIndex,
  seen: Set<unknown> = new Set<unknown>(),
): DesignJavaScriptNode | null {
  if (!designJavaScriptNode(value) || seen.has(value)) return null;
  seen.add(value);
  if (value.type === "Identifier" && typeof value.name === "string") {
    const scope = designJavaScriptBindingScope(index.scopeByNode.get(value), value.name);
    return scope?.stableValues.has(value.name) === true
      ? designJavaScriptStableValue(scope.stableValues.get(value.name), index, seen)
      : null;
  }
  if (value.type === "MemberExpression" || value.type === "OptionalMemberExpression") {
    const receiver = designJavaScriptStableValue(value.object, index, seen);
    const memberName = designJavaScriptMemberName(value, index);
    if (receiver === null || memberName === null) return null;
    if (receiver.type === "ObjectExpression" && Array.isArray(receiver.properties)) {
      const property = receiver.properties.find((candidate) => designJavaScriptNode(candidate)
        && designJavaScriptObjectPropertyName(candidate) === memberName);
      if (!designJavaScriptNode(property)) return null;
      return property.type === "ObjectMethod" ? property : designJavaScriptStableValue(property.value, index, seen);
    }
    const receiverClass = receiver.type === "NewExpression"
      ? designJavaScriptStableValue(receiver.callee, index, seen)
      : receiver;
    if (receiverClass !== null && (receiverClass.type === "ClassDeclaration" || receiverClass.type === "ClassExpression")
      && designJavaScriptNode(receiverClass.body) && Array.isArray(receiverClass.body.body)) {
      const method = receiverClass.body.body.find((candidate) => designJavaScriptNode(candidate)
        && candidate.static === (receiver.type !== "NewExpression")
        && designJavaScriptObjectPropertyName(candidate) === memberName);
      if (!designJavaScriptNode(method)) return null;
      return designJavaScriptFunction(method) ? method : designJavaScriptStableValue(method.value, index, seen);
    }
    return null;
  }
  return value;
}

function designJavaScriptCallable(value: unknown, index: DesignJavaScriptIndex): boolean {
  if (!designJavaScriptNode(value)) return false;
  const resolved = designJavaScriptStableValue(value, index);
  if (resolved !== null && designJavaScriptFunction(resolved)) return true;
  if (value.type === "CallExpression" && designJavaScriptNode(value.callee)
    && (value.callee.type === "MemberExpression" || value.callee.type === "OptionalMemberExpression")
    && designJavaScriptMemberName(value.callee, index) === "bind") {
    return designJavaScriptCallable(value.callee.object, index);
  }
  return false;
}

function designJavaScriptPossibleValues(
  value: unknown,
  index: DesignJavaScriptIndex,
): readonly unknown[] | null {
  if (!designJavaScriptNode(value)) return null;
  if (["TSAsExpression", "TSInstantiationExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSTypeAssertion"]
    .includes(value.type)) {
    return designJavaScriptPossibleValues(value.expression, index);
  }
  if (value.type === "Identifier" && typeof value.name === "string") {
    let scope = index.scopeByNode.get(value);
    while (scope !== undefined) {
      if (scope.invalidatedBindings.has(value.name)) return null;
      const possible = scope.possibleValues.get(value.name);
      if (possible !== undefined) return possible;
      if (scope.stableValues.has(value.name)) return [scope.stableValues.get(value.name)];
      if (scope.bindings.has(value.name)) return null;
      scope = scope.parent ?? undefined;
    }
    return null;
  }
  if (value.type === "MemberExpression" || value.type === "OptionalMemberExpression") {
    const receivers = designJavaScriptPossibleValues(value.object, index);
    if (receivers === null) return null;
    const memberName = designJavaScriptMemberName(value, index);
    const numericIndex = value.computed === true && designJavaScriptNode(value.property)
      && value.property.type === "NumericLiteral" && typeof value.property.value === "number"
      ? value.property.value
      : null;
    const results: unknown[] = [];
    for (const receiver of receivers) {
      if (!designJavaScriptNode(receiver)) return null;
      if (receiver.type === "ObjectExpression" && memberName !== null) {
        const propertyValue = designJavaScriptObjectPropertyValue(receiver, memberName);
        if (propertyValue === undefined) return null;
        results.push(propertyValue);
      } else if (receiver.type === "ArrayExpression" && numericIndex !== null
        && Array.isArray(receiver.elements)) {
        const element = receiver.elements[numericIndex];
        if (element === null || element === undefined) return null;
        results.push(element);
      } else {
        return null;
      }
      if (results.length > 256) return null;
    }
    return results;
  }
  if ((value.type === "CallExpression" || value.type === "OptionalCallExpression")
    && designJavaScriptNode(value.callee)
    && (value.callee.type === "MemberExpression" || value.callee.type === "OptionalMemberExpression")
    && designJavaScriptMemberName(value.callee, index) === "slice") {
    const receivers = designJavaScriptPossibleValues(value.callee.object, index);
    return receivers !== null && receivers.every((receiver) => (
      designJavaScriptNode(receiver) && receiver.type === "ArrayExpression"
    )) ? receivers : null;
  }
  return [value];
}

function designJavaScriptPossibleConstantStrings(
  value: unknown,
  index: DesignJavaScriptIndex,
): ReadonlySet<string> | null {
  const direct = staticDesignJavaScriptString(value);
  if (direct !== null) return new Set([direct]);
  if (designJavaScriptNode(value) && value.type === "Identifier" && typeof value.name === "string") {
    let scope = index.scopeByNode.get(value);
    while (scope !== undefined) {
      if (scope.invalidatedBindings.has(value.name)) return null;
      const possible = scope.possibleStrings.get(value.name);
      if (possible !== undefined) return possible;
      if (scope.stableValues.has(value.name)) {
        const stable = staticDesignJavaScriptString(scope.stableValues.get(value.name));
        if (stable !== null) return new Set([stable]);
      }
      if (scope.bindings.has(value.name)) break;
      scope = scope.parent ?? undefined;
    }
  }
  const candidates = designJavaScriptPossibleValues(value, index);
  if (candidates === null || candidates.length === 0) return null;
  const strings = new Set<string>();
  for (const candidate of candidates) {
    const string = staticDesignJavaScriptString(candidate);
    if (string === null) return null;
    strings.add(string);
    if (strings.size > 256) return null;
  }
  return strings;
}

function designJavaScriptConstantString(
  value: unknown,
  index: DesignJavaScriptIndex,
): string | null {
  const possible = designJavaScriptPossibleConstantStrings(value, index);
  return possible?.size === 1 ? possible.values().next().value ?? null : null;
}

function designJavaScriptPatternIsLocal(
  pattern: unknown,
  index: DesignJavaScriptIndex,
): boolean {
  if (!designJavaScriptNode(pattern)) return false;
  if (pattern.type === "Identifier") return designJavaScriptProvenance(pattern, index) === "local";
  if (pattern.type === "RestElement") return designJavaScriptPatternIsLocal(pattern.argument, index);
  if (pattern.type === "AssignmentPattern") return designJavaScriptPatternIsLocal(pattern.left, index);
  if (pattern.type === "ArrayPattern") {
    return (Array.isArray(pattern.elements) ? pattern.elements : [])
      .filter((element) => element !== null)
      .every((element) => designJavaScriptPatternIsLocal(element, index));
  }
  if (pattern.type === "ObjectPattern") {
    return (Array.isArray(pattern.properties) ? pattern.properties : []).every((property) => {
      if (!designJavaScriptNode(property)) return false;
      return designJavaScriptPatternIsLocal(
        property.type === "RestElement" ? property.argument : property.value,
        index,
      );
    });
  }
  return false;
}

function designJavaScriptReference(
  node: DesignJavaScriptNode,
  parent: DesignJavaScriptNode | null,
  key: string | null,
  index: DesignJavaScriptIndex,
): boolean {
  if (node.type !== "Identifier" || index.bindings.has(node)) return false;
  if (parent === null) return true;
  if (parent.type.startsWith("TS")) {
    const runtimeExpression = [
      "TSAsExpression",
      "TSInstantiationExpression",
      "TSNonNullExpression",
      "TSSatisfiesExpression",
      "TSTypeAssertion",
    ].includes(parent.type) && key === "expression";
    const runtimeParameter = parent.type === "TSParameterProperty" && key === "parameter";
    if (!runtimeExpression && !runtimeParameter) return false;
  }
  if ((parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression")
    && key === "property" && parent.computed !== true) return false;
  if ((parent.type === "ObjectProperty" || parent.type === "ObjectMethod"
      || parent.type === "ClassProperty" || parent.type === "ClassMethod"
      || parent.type === "ClassPrivateProperty" || parent.type === "ClassPrivateMethod")
    && key === "key" && parent.computed !== true) return false;
  if ((parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement")
    && key === "label") return false;
  if (parent.type === "MetaProperty" || parent.type === "PrivateName") return false;
  if ((parent.type === "ImportSpecifier" && key === "imported")
    || ((parent.type === "ExportSpecifier" || parent.type === "ExportNamespaceSpecifier") && key === "exported")) {
    return false;
  }
  return true;
}

function staticDesignJavaScriptString(value: unknown): string | null {
  if (!designJavaScriptNode(value)) return null;
  if (["TSAsExpression", "TSInstantiationExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSTypeAssertion"]
    .includes(value.type)) return staticDesignJavaScriptString(value.expression);
  if (value.type === "StringLiteral" && typeof value.value === "string") return value.value;
  if (value.type === "TemplateLiteral"
    && Array.isArray(value.expressions) && value.expressions.length === 0
    && Array.isArray(value.quasis) && value.quasis.length === 1) {
    const quasi = value.quasis[0];
    if (designJavaScriptNode(quasi) && quasi.type === "TemplateElement"
      && quasi.value !== null && typeof quasi.value === "object") {
      const cooked = (quasi.value as { cooked?: unknown }).cooked;
      return typeof cooked === "string" ? cooked : null;
    }
  }
  if (value.type === "BinaryExpression" && value.operator === "+") {
    const left = staticDesignJavaScriptString(value.left);
    const right = staticDesignJavaScriptString(value.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

function designJavaScriptMemberName(node: DesignJavaScriptNode, index?: DesignJavaScriptIndex): string | null {
  if (node.type !== "MemberExpression" && node.type !== "OptionalMemberExpression") return null;
  if (node.computed !== true && designJavaScriptNode(node.property)
    && node.property.type === "Identifier" && typeof node.property.name === "string") {
    return node.property.name;
  }
  return index === undefined
    ? staticDesignJavaScriptString(node.property)
    : designJavaScriptConstantString(node.property, index);
}

const DESIGN_JAVASCRIPT_NETWORK_GLOBALS = new Set([
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "WebTransport",
  "Worker",
  "SharedWorker",
  "importScripts",
  "Image",
  "Audio",
  "RTCPeerConnection",
]);
const DESIGN_JAVASCRIPT_NETWORK_MEMBER_CAPABILITIES = new Set([
  ...DESIGN_JAVASCRIPT_NETWORK_GLOBALS,
  "sendBeacon",
  "send",
  "connect",
  "addModule",
  "register",
]);
const DESIGN_JAVASCRIPT_WINDOW_MEMBER_CAPABILITIES = new Set([
  "open",
  "postMessage",
]);
const DESIGN_JAVASCRIPT_DYNAMIC_CODE_GLOBALS = new Set([
  "eval",
  "Function",
  "AsyncFunction",
  "GeneratorFunction",
  "AsyncGeneratorFunction",
]);
const DESIGN_JAVASCRIPT_TIMER_GLOBALS = new Set(["setTimeout", "setInterval"]);
const DESIGN_JAVASCRIPT_EXPORT_SCHEDULER_GLOBALS = new Set([
  "setTimeout",
  "setInterval",
  "requestAnimationFrame",
  "requestIdleCallback",
  "queueMicrotask",
]);
const DESIGN_JAVASCRIPT_EXPORT_STATE_GLOBALS = new Set([
  "navigator",
  "screen",
  "devicePixelRatio",
  "matchMedia",
  "visualViewport",
  "performance",
  "chrome",
  "name",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "caches",
  "cookieStore",
  "Storage",
  "StorageManager",
  "IDBFactory",
  "IDBDatabase",
  "IDBObjectStore",
  "IDBTransaction",
  "IDBRequest",
  "IDBCursor",
  "IDBKeyRange",
]);
const DESIGN_JAVASCRIPT_EXPORT_STATE_MEMBERS = new Set([
  ...DESIGN_JAVASCRIPT_EXPORT_STATE_GLOBALS,
  "cookie",
  "hasStorageAccess",
  "requestStorageAccess",
  "webdriver",
  "outerWidth",
  "outerHeight",
  "__lookupGetter__",
  "__lookupSetter__",
]);
const DESIGN_JAVASCRIPT_EXPORT_ANIMATION_GLOBALS = new Set([
  "Animation",
  "AnimationEvent",
  "DocumentTimeline",
  "KeyframeEffect",
]);
const DESIGN_JAVASCRIPT_EXPORT_ANIMATION_MEMBERS = new Set([
  "animate",
  "getAnimations",
  "timeline",
  "animation",
  "animationDelay",
  "animationDuration",
  "animationName",
  "animationTimeline",
  "transition",
  "transitionDelay",
  "transitionDuration",
  "transitionProperty",
  "scrollTimeline",
  "viewTimeline",
]);
const DESIGN_JAVASCRIPT_EXPORT_REFLECTION_MEMBERS = new Set([
  "entries",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "getOwnPropertyNames",
  "getOwnPropertySymbols",
  "has",
  "keys",
  "ownKeys",
  "values",
]);
const DESIGN_JAVASCRIPT_GLOBAL_NAMESPACES = new Set([
  "window",
  "self",
  "globalThis",
  "document",
  "navigator",
]);
const DESIGN_JAVASCRIPT_PARENT_GLOBALS = new Set(["top", "parent", "opener", "frames", "frameElement"]);
const DESIGN_JAVASCRIPT_URL_PROPERTIES = new Set([
  "src",
  "srcset",
  "href",
  "poster",
  "action",
  "formAction",
  "formaction",
]);
const DESIGN_JAVASCRIPT_MARKUP_PROPERTIES = new Set(["innerHTML", "outerHTML", "srcdoc"]);
const DESIGN_JAVASCRIPT_CSS_URL_PROPERTIES = new Set([
  "background",
  "backgroundImage",
  "borderImage",
  "borderImageSource",
  "content",
  "cursor",
  "filter",
  "listStyle",
  "listStyleImage",
  "mask",
  "maskImage",
  "clipPath",
  "offsetPath",
  "shapeOutside",
]);
const DESIGN_JAVASCRIPT_MARKUP_METHODS = new Set([
  "insertAdjacentHTML",
  "setHTMLUnsafe",
  "createContextualFragment",
  "write",
  "writeln",
  "parseFromString",
]);
const DESIGN_JAVASCRIPT_NAVIGATION_METHODS = new Set(["assign", "replace", "reload"]);
const DESIGN_JAVASCRIPT_HISTORY_METHODS = new Set(["pushState", "replaceState", "go", "back", "forward"]);
const DESIGN_JAVASCRIPT_UNSAFE_CREATED_ELEMENTS = new Set([
  "script",
  "style",
  "link",
  "base",
  "meta",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "portal",
  "fencedframe",
]);

interface DesignJavaScriptGlobalPath {
  root: string;
  path: string[];
  dynamic: boolean;
}

function designJavaScriptGlobalPath(
  value: unknown,
  index: DesignJavaScriptIndex,
): DesignJavaScriptGlobalPath | null {
  if (!designJavaScriptNode(value)) return null;
  if (value.type === "ThisExpression") {
    const owner = index.thisOwnerByNode.get(value);
    if (owner !== undefined && index.localThisFunctions.has(owner)) return null;
    return { root: "window", path: [], dynamic: false };
  }
  if (value.type === "Identifier" && typeof value.name === "string"
    && !hasDesignJavaScriptBinding(index.scopeByNode.get(value), value.name)) {
    return { root: value.name, path: [], dynamic: false };
  }
  if (value.type !== "MemberExpression" && value.type !== "OptionalMemberExpression") return null;
  const base = designJavaScriptGlobalPath(value.object, index);
  if (base === null) return null;
  const member = designJavaScriptMemberName(value, index);
  return {
    root: base.root,
    path: member === null ? base.path : [...base.path, member],
    dynamic: base.dynamic || member === null,
  };
}

function designJavaScriptSafeProbe(
  node: DesignJavaScriptNode,
  parent: DesignJavaScriptNode | null,
  key: string | null,
): boolean {
  if (parent?.type === "UnaryExpression" && key === "argument"
    && ["typeof", "void", "!"].includes(String(parent.operator))) return true;
  if (parent?.type === "BinaryExpression"
    && ["===", "!==", "==", "!=", "in"].includes(String(parent.operator))) return true;
  return parent?.type === "ExpressionStatement" && key === "expression";
}

function designJavaScriptMemberObject(
  parent: DesignJavaScriptNode | null,
  key: string | null,
): boolean {
  return (parent?.type === "MemberExpression" || parent?.type === "OptionalMemberExpression") && key === "object";
}

function designJavaScriptWriteTarget(
  parent: DesignJavaScriptNode | null,
  key: string | null,
): boolean {
  return (parent?.type === "AssignmentExpression" && key === "left")
    || (parent?.type === "UpdateExpression" && key === "argument")
    || (parent?.type === "UnaryExpression" && parent.operator === "delete" && key === "argument")
    || ((parent?.type === "ForInStatement" || parent?.type === "ForOfStatement") && key === "left");
}

function designJavaScriptCapabilityEscapes(
  node: DesignJavaScriptNode,
  parent: DesignJavaScriptNode | null,
  key: string | null,
): boolean {
  if (designJavaScriptSafeProbe(node, parent, key) || designJavaScriptMemberObject(parent, key)) return false;
  if (parent?.type === "UnaryExpression" && key === "argument") return false;
  if (parent?.type === "BinaryExpression" || parent?.type === "LogicalExpression"
    || parent?.type === "ConditionalExpression" || parent?.type === "IfStatement"
    || parent?.type === "WhileStatement" || parent?.type === "DoWhileStatement") return false;
  return true;
}

function designJavaScriptEffectivePath(path: DesignJavaScriptGlobalPath): { root: string; path: string[] } {
  if (["window", "self", "globalThis"].includes(path.root) && path.path.length > 0) {
    return { root: path.path[0]!, path: path.path.slice(1) };
  }
  return { root: path.root, path: path.path };
}

const DESIGN_JAVASCRIPT_DOM_RETURNING_METHODS = new Set([
  "querySelector",
  "getElementById",
  "getElementsByClassName",
  "getElementsByName",
  "getElementsByTagName",
  "closest",
  "createElement",
  "createElementNS",
  "createDocumentFragment",
  "createRange",
  "cloneNode",
]);
const DESIGN_JAVASCRIPT_PARENT_ESCAPE_PROPERTIES = new Set([
  "ownerDocument",
  "defaultView",
  "contentWindow",
  "contentDocument",
]);

function designJavaScriptProvenance(
  value: unknown,
  index: DesignJavaScriptIndex,
  seen: Set<unknown> = new Set<unknown>(),
): DesignJavaScriptProvenance {
  if (!designJavaScriptNode(value) || seen.has(value)) return "unknown";
  seen.add(value);
  if (["TSAsExpression", "TSInstantiationExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSTypeAssertion"]
    .includes(value.type)) return designJavaScriptProvenance(value.expression, index, seen);
  if ([
    "ObjectExpression", "ArrayExpression", "FunctionExpression", "ArrowFunctionExpression",
    "ClassExpression", "StringLiteral", "NumericLiteral", "BooleanLiteral", "NullLiteral", "TemplateLiteral",
  ].includes(value.type)) return "local";
  if (value.type === "ThisExpression") {
    const owner = index.thisOwnerByNode.get(value);
    return owner !== undefined && index.localThisFunctions.has(owner) ? "local" : "global";
  }
  if (value.type === "Identifier" && typeof value.name === "string") {
    const binding = designJavaScriptBindingScope(index.scopeByNode.get(value), value.name);
    if (binding === null) {
      return ["document"].includes(value.name) ? "dom"
        : DESIGN_JAVASCRIPT_GLOBAL_NAMESPACES.has(value.name)
          || DESIGN_JAVASCRIPT_PARENT_GLOBALS.has(value.name)
          || ["location", "history", "open"].includes(value.name)
          ? "global"
          : "unknown";
    }
    const parameterProvenance = binding.provenances.get(value.name);
    if (parameterProvenance !== undefined) return parameterProvenance;
    if (!binding.reassignedBindings.has(value.name) && binding.initializers.has(value.name)) {
      return designJavaScriptProvenance(binding.initializers.get(value.name), index, seen);
    }
    if (binding.invalidatedBindings.has(value.name) || !binding.stableValues.has(value.name)) return "unknown";
    return designJavaScriptProvenance(binding.stableValues.get(value.name), index, seen);
  }
  if (value.type === "NewExpression") {
    const calleePath = designJavaScriptGlobalPath(value.callee, index);
    if (calleePath !== null) {
      const root = designJavaScriptEffectivePath(calleePath).root;
      if (["DOMParser", "Range"].includes(root)) return "dom";
      if (root === "CSSStyleSheet") return "style";
    }
    return "local";
  }
  if (value.type === "CallExpression" || value.type === "OptionalCallExpression") {
    if (!designJavaScriptNode(value.callee)) return "unknown";
    const calleeName = value.callee.type === "MemberExpression" || value.callee.type === "OptionalMemberExpression"
      ? designJavaScriptMemberName(value.callee, index)
      : null;
    const calleePath = designJavaScriptGlobalPath(value.callee, index);
    if (calleePath !== null) {
      const effective = designJavaScriptEffectivePath(calleePath);
      if (effective.root === "document" && DESIGN_JAVASCRIPT_DOM_RETURNING_METHODS.has(calleeName ?? "")) return "dom";
      if (effective.root === "Object" && calleeName === "assign" && Array.isArray(value.arguments)) {
        return designJavaScriptProvenance(value.arguments[0], index, seen);
      }
    }
    if (value.callee.type === "MemberExpression" || value.callee.type === "OptionalMemberExpression") {
      const receiver = designJavaScriptProvenance(value.callee.object, index, seen);
      if (DESIGN_JAVASCRIPT_DOM_RETURNING_METHODS.has(calleeName ?? "") && receiver === "dom") return "dom";
      if (receiver === "local" && [
        "at", "concat", "every", "filter", "find", "findIndex", "findLast", "findLastIndex",
        "flat", "flatMap", "includes", "indexOf", "join", "lastIndexOf", "map", "reduce",
        "reduceRight", "slice", "some", "split", "substring", "substr", "toLowerCase",
        "toUpperCase", "trim", "trimEnd", "trimStart",
      ].includes(calleeName ?? "")) return "local";
    }
    return "unknown";
  }
  if (value.type === "MemberExpression" || value.type === "OptionalMemberExpression") {
    const globalPath = designJavaScriptGlobalPath(value, index);
    if (globalPath !== null) {
      const effective = designJavaScriptEffectivePath(globalPath);
      if (effective.root === "document") {
        if (DESIGN_JAVASCRIPT_PARENT_ESCAPE_PROPERTIES.has(effective.path[0] ?? "")) return "global";
        if (effective.path.at(-1) === "style") return "style";
        if (["dataset", "classList"].includes(effective.path.at(-1) ?? "")) return "local";
        return "dom";
      }
      if (["window", "self", "globalThis", "navigator", "location", "history"].includes(effective.root)
        || DESIGN_JAVASCRIPT_PARENT_GLOBALS.has(effective.root)) return "global";
    }
    const receiver = designJavaScriptProvenance(value.object, index, seen);
    const memberName = designJavaScriptMemberName(value, index);
    if (receiver === "local") return "local";
    if (receiver === "style") return "style";
    if (receiver === "dom" && memberName === "style") return "style";
    if (receiver === "dom" && ["dataset", "classList"].includes(memberName ?? "")) return "local";
    if (receiver === "dom" && [
      "body", "head", "documentElement", "parentElement", "firstElementChild", "lastElementChild",
      "nextElementSibling", "previousElementSibling", "children",
    ].includes(memberName ?? "")) return "dom";
    return receiver === "global" ? "global" : "unknown";
  }
  return "unknown";
}

function designJavaScriptUnsafeReceiver(
  value: unknown,
  index: DesignJavaScriptIndex,
): boolean {
  return designJavaScriptProvenance(value, index) !== "local";
}

function designJavaScriptObjectPropertyName(
  property: DesignJavaScriptNode,
): string | null {
  if (!["ObjectProperty", "ObjectMethod", "ClassProperty", "ClassMethod", "ClassPrivateProperty", "ClassPrivateMethod"]
    .includes(property.type)) return null;
  if (property.computed !== true && designJavaScriptNode(property.key)
    && property.key.type === "Identifier" && typeof property.key.name === "string") return property.key.name;
  return staticDesignJavaScriptString(property.key);
}

function designJavaScriptObjectPropertyValue(
  value: unknown,
  propertyName: string,
): unknown {
  if (!designJavaScriptNode(value) || value.type !== "ObjectExpression" || !Array.isArray(value.properties)) {
    return undefined;
  }
  const property = value.properties.find((candidate) => designJavaScriptNode(candidate)
    && designJavaScriptObjectPropertyName(candidate) === propertyName);
  return designJavaScriptNode(property) && property.type === "ObjectProperty" ? property.value : undefined;
}

function designJavaScriptSelfTarget(value: unknown, index: DesignJavaScriptIndex): boolean {
  return designJavaScriptConstantString(value, index)?.trim().toLowerCase() === "_self";
}

function validateDesignJavaScriptUrl(
  value: unknown,
  index: DesignJavaScriptIndex,
  allowCanonicalAssets: boolean,
  exportProject = false,
): boolean {
  const urls = designJavaScriptPossibleConstantStrings(value, index);
  return urls !== null && urls.size > 0 && [...urls].every((url) => (
    allowedDesignUrl(url, allowCanonicalAssets)
    || (exportProject && allowedDesignExportUrl(url))
  ));
}

function allowedDesignExportUrl(value: string): boolean {
  const url = value.trim();
  if (url.startsWith("#") || url.startsWith("blob:")) return true;
  if (/^data:(?:image|font)\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+=[^;,]*)*;base64,[a-z0-9+/=\s]+$/i.test(url)) return true;
  if (/[\u0000-\u001f\u007f\\]/.test(url) || url.startsWith("//")) return false;
  return url.startsWith("/") || url.startsWith("./") || url.startsWith("../");
}

function allowedDesignExportModuleSpecifier(value: unknown): boolean {
  return designJavaScriptNode(value) && value.type === "StringLiteral"
    && typeof value.value === "string"
    && /^(?:\.\/|\.\.\/)[A-Za-z0-9._/-]+$/.test(value.value)
    && !value.value.split("/").includes(".context");
}

function validateDesignJavaScript(
  script: string,
  allowCanonicalAssets: boolean,
  sourceType: "script" | "module" = "script",
  exportProject = false,
): void {
  let syntax: ReturnType<typeof parse>;
  try {
    syntax = parse(script, {
      sourceType,
      plugins: exportProject ? ["typescript", "jsx"] : [],
    });
  } catch {
    throw new DesignStorageError("invalid-html", "Generated inline JavaScript is invalid");
  }
  const program: unknown = syntax.program;
  if (!designJavaScriptNode(program)) {
    throw new DesignStorageError("invalid-html", "Generated inline JavaScript is invalid");
  }
  const index = indexDesignJavaScript(program);
  let accessesParentNavigation = false;
  let accessesRemoteContent = false;
  let changesNavigation = false;
  let opensWindow = false;
  let evaluatesDynamicCode = false;
  let injectsMarkup = false;
  visitDesignJavaScript(program, (node, parent, key) => {
    if (node.type === "Identifier" && typeof node.name === "string"
      && designJavaScriptReference(node, parent, key, index)
      && !hasDesignJavaScriptBinding(index.scopeByNode.get(node), node.name)) {
      const safeProbe = designJavaScriptSafeProbe(node, parent, key);
      if (DESIGN_JAVASCRIPT_PARENT_GLOBALS.has(node.name)) accessesParentNavigation = true;
      if (DESIGN_JAVASCRIPT_NETWORK_GLOBALS.has(node.name) && !safeProbe) accessesRemoteContent = true;
      if (DESIGN_JAVASCRIPT_DYNAMIC_CODE_GLOBALS.has(node.name) && !safeProbe) evaluatesDynamicCode = true;
      if (node.name === "open" && !safeProbe) opensWindow = true;
      if (DESIGN_JAVASCRIPT_TIMER_GLOBALS.has(node.name) && !safeProbe
        && !(parent?.type === "CallExpression" && key === "callee")) evaluatesDynamicCode = true;
      if ((node.name === "location" || node.name === "history") && !safeProbe
        && !designJavaScriptMemberObject(parent, key)
        && designJavaScriptCapabilityEscapes(node, parent, key)) changesNavigation = true;
      if (DESIGN_JAVASCRIPT_GLOBAL_NAMESPACES.has(node.name) && !safeProbe
        && !designJavaScriptMemberObject(parent, key)) accessesRemoteContent = true;
    }
    if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
      const memberName = designJavaScriptMemberName(node, index);
      const globalPath = designJavaScriptGlobalPath(node, index);
      const receiver = designJavaScriptProvenance(node.object, index);
      const unsafeReceiver = receiver !== "local";
      const safeProbe = designJavaScriptSafeProbe(node, parent, key);
      if (memberName === "constructor" && !designJavaScriptSafeProbe(node, parent, key)) evaluatesDynamicCode = true;
      if (unsafeReceiver && memberName !== null && !safeProbe
        && DESIGN_JAVASCRIPT_NETWORK_MEMBER_CAPABILITIES.has(memberName)) accessesRemoteContent = true;
      if (unsafeReceiver && memberName !== null && !safeProbe
        && DESIGN_JAVASCRIPT_WINDOW_MEMBER_CAPABILITIES.has(memberName)) opensWindow = true;
      if (DESIGN_JAVASCRIPT_PARENT_ESCAPE_PROPERTIES.has(memberName ?? "") && unsafeReceiver) {
        accessesParentNavigation = true;
      }
      if (designJavaScriptWriteTarget(parent, key) && memberName === null && unsafeReceiver) accessesRemoteContent = true;
      if (designJavaScriptWriteTarget(parent, key) && unsafeReceiver
        && DESIGN_JAVASCRIPT_MARKUP_PROPERTIES.has(memberName ?? "")) {
        injectsMarkup = true;
      }
      if (globalPath !== null) {
        const effective = designJavaScriptEffectivePath(globalPath);
        const first = effective.path[0] ?? null;
        const last = effective.path.at(-1) ?? null;
        const safeProbe = designJavaScriptSafeProbe(node, parent, key);
        if (globalPath.dynamic && [
          "window", "self", "globalThis", "document", "navigator", "location", "history",
          "top", "parent", "opener", "frames", "frameElement",
        ].includes(globalPath.root)) accessesRemoteContent = true;
        if (DESIGN_JAVASCRIPT_PARENT_GLOBALS.has(effective.root)
          || (effective.root === "document" && first === "defaultView")) accessesParentNavigation = true;
        if (DESIGN_JAVASCRIPT_NETWORK_GLOBALS.has(effective.root) && !safeProbe) accessesRemoteContent = true;
        if (DESIGN_JAVASCRIPT_DYNAMIC_CODE_GLOBALS.has(effective.root) && !safeProbe) evaluatesDynamicCode = true;
        if (effective.root === "open" && !safeProbe) opensWindow = true;
        if (DESIGN_JAVASCRIPT_TIMER_GLOBALS.has(effective.root) && !safeProbe
          && !(parent?.type === "CallExpression" && key === "callee")) evaluatesDynamicCode = true;
        if (["window", "self", "globalThis", "document", "navigator"].includes(effective.root)
          && effective.path.length === 0 && !safeProbe
          && designJavaScriptCapabilityEscapes(node, parent, key)) accessesRemoteContent = true;
        if (effective.root === "location") {
          if (designJavaScriptWriteTarget(parent, key)
            || (first !== null && DESIGN_JAVASCRIPT_NAVIGATION_METHODS.has(first) && !safeProbe)
            || (effective.path.length === 0 && designJavaScriptCapabilityEscapes(node, parent, key))) {
            changesNavigation = true;
          }
        }
        if (effective.root === "history") {
          if (designJavaScriptWriteTarget(parent, key)
            || (first !== null && DESIGN_JAVASCRIPT_HISTORY_METHODS.has(first) && !safeProbe)
            || (effective.path.length === 0 && designJavaScriptCapabilityEscapes(node, parent, key))) {
            changesNavigation = true;
          }
        }
        if (effective.root === "navigator" && (first === "sendBeacon" || first === "serviceWorker") && !safeProbe) {
          accessesRemoteContent = true;
        }
        if (effective.root === "document" && (first === "location"
          || (first === "defaultView" && last === "location"))) changesNavigation = true;
      }
    }
    if ((node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration"
      || (node.type === "ExportNamedDeclaration" && node.source !== null && node.source !== undefined))
      && !(exportProject && allowedDesignExportModuleSpecifier(node.source))) {
      accessesRemoteContent = true;
    }
    if (node.type === "ImportExpression"
      || (node.type === "CallExpression" && designJavaScriptNode(node.callee) && node.callee.type === "Import")) {
      accessesRemoteContent = true;
    }
    if (node.type === "AssignmentExpression" && designJavaScriptNode(node.left)
      && (node.left.type === "MemberExpression" || node.left.type === "OptionalMemberExpression")) {
      const memberName = designJavaScriptMemberName(node.left, index);
      const receiver = designJavaScriptProvenance(node.left.object, index);
      const unsafeReceiver = receiver !== "local";
      if (unsafeReceiver && DESIGN_JAVASCRIPT_URL_PROPERTIES.has(memberName ?? "")) {
          if (!validateDesignJavaScriptUrl(node.right, index, allowCanonicalAssets, exportProject)) accessesRemoteContent = true;
      }
      if (unsafeReceiver && ["target", "formTarget"].includes(memberName ?? "")) {
        const target = designJavaScriptConstantString(node.right, index)?.trim().toLowerCase();
        if (target !== "_self") opensWindow = true;
      }
      if (receiver === "style") {
        const cssValue = designJavaScriptConstantString(node.right, index);
        if (memberName === "cssText") {
          if (cssValue === null) accessesRemoteContent = true;
          else validateDesignCss(cssValue, allowCanonicalAssets, "attribute");
        } else if (memberName === null
          || (cssValue === null && DESIGN_JAVASCRIPT_CSS_URL_PROPERTIES.has(memberName))) {
          accessesRemoteContent = true;
        } else if (cssValue !== null) {
          validateDesignCss(`${memberName}: ${cssValue}`, allowCanonicalAssets, "attribute");
        }
      }
    }
    if (node.type === "CallExpression" && designJavaScriptNode(node.callee)) {
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      if (node.callee.type === "Identifier" && typeof node.callee.name === "string"
        && DESIGN_JAVASCRIPT_TIMER_GLOBALS.has(node.callee.name)
        && !hasDesignJavaScriptBinding(index.scopeByNode.get(node.callee), node.callee.name)) {
        if (!designJavaScriptCallable(args[0], index)) evaluatesDynamicCode = true;
      }
      if (node.callee.type === "MemberExpression" || node.callee.type === "OptionalMemberExpression") {
        const calleeName = designJavaScriptMemberName(node.callee, index);
        const calleePath = designJavaScriptGlobalPath(node.callee, index);
        const receiver = designJavaScriptProvenance(node.callee.object, index);
        const unsafeReceiver = receiver !== "local";
        if (unsafeReceiver && DESIGN_JAVASCRIPT_MARKUP_METHODS.has(calleeName ?? "")) injectsMarkup = true;
        if (unsafeReceiver && calleeName === "addModule") accessesRemoteContent = true;
        if (unsafeReceiver && (calleeName === "setAttribute" || calleeName === "setAttributeNS")) {
          const offset = calleeName === "setAttributeNS" ? 1 : 0;
          const attribute = designJavaScriptConstantString(args[offset], index);
          if (attribute === null) accessesRemoteContent = true;
          else if (/^on/i.test(attribute) || DESIGN_JAVASCRIPT_MARKUP_PROPERTIES.has(attribute)) injectsMarkup = true;
          else if (["target", "formtarget"].includes(attribute.toLowerCase())) {
            const target = designJavaScriptConstantString(args[offset + 1], index)?.trim().toLowerCase();
            if (target !== "_self") opensWindow = true;
          } else if (attribute.toLowerCase() === "style") {
            const style = designJavaScriptConstantString(args[offset + 1], index);
            if (style === null) accessesRemoteContent = true;
            else validateDesignCss(style, allowCanonicalAssets, "attribute");
          }
          else if (DESIGN_JAVASCRIPT_URL_PROPERTIES.has(attribute)
            && !validateDesignJavaScriptUrl(args[offset + 1], index, allowCanonicalAssets, exportProject)) accessesRemoteContent = true;
        }
        if (receiver === "style" && calleeName === "setProperty") {
          const property = designJavaScriptConstantString(args[0], index);
          const cssValue = designJavaScriptConstantString(args[1], index);
          if (property === null
            || (cssValue === null && DESIGN_JAVASCRIPT_CSS_URL_PROPERTIES.has(property))) accessesRemoteContent = true;
          else if (cssValue !== null) validateDesignCss(`${property}: ${cssValue}`, allowCanonicalAssets, "attribute");
        }
        if ((unsafeReceiver && ["insertRule", "addRule", "replaceSync"].includes(calleeName ?? ""))
          || (receiver === "style" && calleeName === "replace")) {
          const css = designJavaScriptConstantString(args[0], index);
          if (css === null) accessesRemoteContent = true;
          else validateDesignCss(css, allowCanonicalAssets, "stylesheet");
        }
        if (calleePath !== null) {
          const effective = designJavaScriptEffectivePath(calleePath);
          if (DESIGN_JAVASCRIPT_TIMER_GLOBALS.has(effective.root)) {
            if (!designJavaScriptCallable(args[0], index)) evaluatesDynamicCode = true;
          }
          if (effective.root === "document"
            && (calleeName === "createElement" || calleeName === "createElementNS")) {
            const tagName = designJavaScriptConstantString(args[calleeName === "createElementNS" ? 1 : 0], index);
            if (tagName === null || DESIGN_JAVASCRIPT_UNSAFE_CREATED_ELEMENTS.has(tagName.toLowerCase())) {
              injectsMarkup = true;
            }
          }
          if (effective.root === "Reflect" && calleeName === "set") {
            const target = designJavaScriptProvenance(args[0], index);
            if (target !== "local") {
              const property = designJavaScriptConstantString(args[1], index);
              if (property === null) accessesRemoteContent = true;
              else if (DESIGN_JAVASCRIPT_MARKUP_PROPERTIES.has(property)) injectsMarkup = true;
              else if (["target", "formTarget"].includes(property)
                && !designJavaScriptSelfTarget(args[2], index)) opensWindow = true;
              else if (DESIGN_JAVASCRIPT_URL_PROPERTIES.has(property)
                && !validateDesignJavaScriptUrl(args[2], index, allowCanonicalAssets, exportProject)) accessesRemoteContent = true;
            }
          }
          if ((effective.root === "Object" || effective.root === "Reflect")
            && calleeName === "defineProperty") {
            const target = designJavaScriptProvenance(args[0], index);
            if (target !== "local") {
              const property = designJavaScriptConstantString(args[1], index);
              if (property === null) accessesRemoteContent = true;
              else if (DESIGN_JAVASCRIPT_MARKUP_PROPERTIES.has(property)) injectsMarkup = true;
              else if (["target", "formTarget"].includes(property)
                && !designJavaScriptSelfTarget(
                  designJavaScriptObjectPropertyValue(args[2], "value"),
                  index,
                )) opensWindow = true;
              else if (DESIGN_JAVASCRIPT_URL_PROPERTIES.has(property)) accessesRemoteContent = true;
            }
          }
          if (effective.root === "Object" && calleeName === "assign") {
            const target = designJavaScriptProvenance(args[0], index);
            for (const source of args.slice(1)) {
              if (target === "local") {
                if (designJavaScriptProvenance(source, index) !== "local") accessesRemoteContent = true;
                continue;
              }
              if (!designJavaScriptNode(source) || source.type !== "ObjectExpression"
                || !Array.isArray(source.properties)) {
                accessesRemoteContent = true;
                continue;
              }
              for (const property of source.properties) {
                if (!designJavaScriptNode(property) || property.type === "SpreadElement") {
                  accessesRemoteContent = true;
                  continue;
                }
                const propertyName = designJavaScriptObjectPropertyName(property);
                if (propertyName === null) accessesRemoteContent = true;
                else if (DESIGN_JAVASCRIPT_MARKUP_PROPERTIES.has(propertyName)) injectsMarkup = true;
                else if (["target", "formTarget"].includes(propertyName)
                  && !designJavaScriptSelfTarget(property.value, index)) opensWindow = true;
                else if (DESIGN_JAVASCRIPT_URL_PROPERTIES.has(propertyName)
                  && !validateDesignJavaScriptUrl(property.value, index, allowCanonicalAssets, exportProject)) accessesRemoteContent = true;
              }
            }
          }
        }
      }
    }
  });
  if (accessesParentNavigation) {
    throw new DesignStorageError("invalid-html", "Generated HTML may not access parent, top, or opener");
  }
  if (changesNavigation) {
    throw new DesignStorageError("invalid-html", "Generated HTML may not change browser navigation");
  }
  if (opensWindow) {
    throw new DesignStorageError("invalid-html", "Generated HTML may not open browser windows");
  }
  if (evaluatesDynamicCode) {
    throw new DesignStorageError("invalid-html", "Generated HTML may not evaluate dynamic JavaScript");
  }
  if (injectsMarkup) {
    throw new DesignStorageError("invalid-html", "Generated HTML may not inject executable markup");
  }
  if (accessesRemoteContent) {
    throw new DesignStorageError("invalid-html", "Generated HTML may not load remote scripts or resources");
  }
}

const DESIGN_HTML_URL_ATTRIBUTES = new Set([
  "src",
  "href",
  "poster",
  "action",
  "formaction",
  "data",
  "manifest",
]);
const DESIGN_HTML_RESPONSIVE_URL_ATTRIBUTES = new Set(["srcset", "imagesrcset"]);
const DESIGN_HTML_BROWSING_CONTEXT_ELEMENTS = new Set([
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "portal",
  "fencedframe",
]);
const DESIGN_HTML_JAVASCRIPT_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

function designHtmlElement(node: DefaultTreeAdapterTypes.Node): node is DefaultTreeAdapterTypes.Element {
  return "tagName" in node && typeof node.tagName === "string" && Array.isArray(node.attrs);
}

function designHtmlChildren(node: DefaultTreeAdapterTypes.Node): DefaultTreeAdapterTypes.ChildNode[] {
  const children = "childNodes" in node && Array.isArray(node.childNodes) ? [...node.childNodes] : [];
  if (designHtmlElement(node) && node.tagName === "template" && "content" in node
    && node.content !== null && typeof node.content === "object" && Array.isArray(node.content.childNodes)) {
    children.push(...node.content.childNodes);
  }
  return children;
}

function designHtmlText(element: DefaultTreeAdapterTypes.Element): string {
  return element.childNodes.map((node) => node.nodeName === "#text" && "value" in node ? node.value : "").join("");
}

function designHtmlAttribute(element: DefaultTreeAdapterTypes.Element, name: string): string | null {
  return element.attrs.find((attribute) => attribute.name.toLowerCase() === name)?.value ?? null;
}

function validateDesignCss(
  css: string,
  allowCanonicalAssets: boolean,
  mode: "stylesheet" | "attribute" = "stylesheet",
): void {
  let dependencies: ReturnType<typeof transformCss>["dependencies"];
  try {
    dependencies = mode === "attribute"
      ? transformStyleAttribute({
        filename: "design-inline-style.css",
        code: Buffer.from(css),
        analyzeDependencies: true,
      }).dependencies
      : transformCss({
        filename: "design-inline.css",
        code: Buffer.from(css),
        analyzeDependencies: true,
      }).dependencies;
  } catch {
    throw new DesignStorageError("invalid-html", "Generated HTML contains invalid CSS");
  }
  for (const dependency of dependencies ?? []) {
    if (dependency.type === "import") {
      throw new DesignStorageError("invalid-html", "Generated HTML must keep styles and style assets local");
    }
    if (dependency.type !== "url" || !allowedDesignUrl(dependency.url, allowCanonicalAssets)) {
      throw new DesignStorageError("invalid-html", "Generated HTML contains an unpinned style asset URL");
    }
  }
}

export function validateDesignExportJavaScript(source: string): string[] {
  validateDesignJavaScript(source, false, "module", true);
  const syntax = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
  const program = syntax.program as unknown as DesignJavaScriptNode;
  const index = indexDesignJavaScript(program);
  const specifiers: string[] = [];
  let usesDeferredScheduler = false;
  let executionEnvironmentProbe: string | null = null;
  let usesWebAnimations = false;
  let usesDynamicStyle = false;
  const markExecutionEnvironmentProbe = (node: DesignJavaScriptNode, reason: string): void => {
    if (executionEnvironmentProbe !== null) return;
    const location = node.loc as { start?: { line?: number; column?: number } } | undefined;
    const line = location?.start?.line;
    const column = location?.start?.column;
    executionEnvironmentProbe = `${reason}${line === undefined ? "" : ` at ${line}:${(column ?? 0) + 1}`}`;
  };
  visitDesignJavaScript(program, (node, parent, key) => {
    if (node.type === "Identifier" && typeof node.name === "string"
      && designJavaScriptReference(node, parent, key, index)
      && !hasDesignJavaScriptBinding(index.scopeByNode.get(node), node.name)) {
      if (DESIGN_JAVASCRIPT_EXPORT_SCHEDULER_GLOBALS.has(node.name)) usesDeferredScheduler = true;
      if (DESIGN_JAVASCRIPT_EXPORT_STATE_GLOBALS.has(node.name)) {
        markExecutionEnvironmentProbe(node, `global ${node.name}`);
      }
      if (DESIGN_JAVASCRIPT_EXPORT_ANIMATION_GLOBALS.has(node.name)) usesWebAnimations = true;
    }
    if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
      const memberName = designJavaScriptMemberName(node, index);
      const globalPath = designJavaScriptGlobalPath(node, index);
      const effective = globalPath === null ? null : designJavaScriptEffectivePath(globalPath);
      if (memberName !== null && DESIGN_JAVASCRIPT_EXPORT_SCHEDULER_GLOBALS.has(memberName)
        && designJavaScriptProvenance(node.object, index) !== "local") {
        usesDeferredScheduler = true;
      }
      if (memberName !== null && DESIGN_JAVASCRIPT_EXPORT_STATE_MEMBERS.has(memberName)
        && designJavaScriptProvenance(node.object, index) !== "local") {
        markExecutionEnvironmentProbe(node, `unproven member ${memberName}`);
      }
      if (memberName === null && designJavaScriptProvenance(node.object, index) !== "local") {
        markExecutionEnvironmentProbe(node, "dynamic member on an unproven receiver");
      }
      if (effective !== null && DESIGN_JAVASCRIPT_EXPORT_STATE_GLOBALS.has(effective.root)) {
        markExecutionEnvironmentProbe(node, `global path ${effective.root}`);
      }
      if (effective?.root === "document"
        && ["visibilityState", "hidden", "prerendering", "referrer", "hasFocus"].includes(effective.path[0] ?? "")) {
        markExecutionEnvironmentProbe(node, `document.${effective.path[0]}`);
      }
      if (memberName !== null && DESIGN_JAVASCRIPT_EXPORT_ANIMATION_MEMBERS.has(memberName)) {
        usesWebAnimations = true;
      }
    }
    if (node.type === "ObjectProperty" && parent?.type === "ObjectPattern") {
      const memberName = node.computed === true
        ? designJavaScriptConstantString(node.key, index)
        : designJavaScriptNode(node.key) && node.key.type === "Identifier" && typeof node.key.name === "string"
          ? node.key.name
          : staticDesignJavaScriptString(node.key);
      const localPattern = designJavaScriptPatternIsLocal(parent, index);
      if (!localPattern && (memberName === null || DESIGN_JAVASCRIPT_EXPORT_STATE_MEMBERS.has(memberName))) {
        markExecutionEnvironmentProbe(node, `destructured ${memberName ?? "dynamic property"} from an unproven value`);
      }
      if (!localPattern && (memberName === null || DESIGN_JAVASCRIPT_EXPORT_ANIMATION_MEMBERS.has(memberName))) {
        usesWebAnimations = true;
      }
    }
    if (node.type === "ObjectProperty" && parent?.type === "ObjectExpression") {
      const propertyName = designJavaScriptObjectPropertyName(node);
      if (propertyName !== null && DESIGN_JAVASCRIPT_EXPORT_ANIMATION_MEMBERS.has(propertyName)) {
        usesWebAnimations = true;
      }
    }
    if (node.type === "AssignmentExpression" && designJavaScriptNode(node.left)
      && (node.left.type === "MemberExpression" || node.left.type === "OptionalMemberExpression")) {
      const memberName = designJavaScriptMemberName(node.left, index);
      const receiver = designJavaScriptProvenance(node.left.object, index);
      if (receiver === "style" && memberName === "cssText") {
        const css = designJavaScriptConstantString(node.right, index);
        if (css === null) usesDynamicStyle = true;
        else assertDesignExportCssIsStatic(css);
      } else if (receiver === "style") {
        const value = designJavaScriptConstantString(node.right, index);
        if (memberName === null || value === null) usesDynamicStyle = true;
        else assertDesignExportCssIsStatic(`${memberName}: ${value}`);
      }
      if (memberName !== null && DESIGN_JAVASCRIPT_EXPORT_ANIMATION_MEMBERS.has(memberName)) {
        usesWebAnimations = true;
      }
    }
    if ((node.type === "CallExpression" || node.type === "OptionalCallExpression")
      && designJavaScriptNode(node.callee)
      && (node.callee.type === "MemberExpression" || node.callee.type === "OptionalMemberExpression")) {
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      const calleeName = designJavaScriptMemberName(node.callee, index);
      const calleePath = designJavaScriptGlobalPath(node.callee, index);
      const effective = calleePath === null ? null : designJavaScriptEffectivePath(calleePath);
      const receiver = designJavaScriptProvenance(node.callee.object, index);
      if (effective !== null && ["Object", "Reflect"].includes(effective.root)
        && DESIGN_JAVASCRIPT_EXPORT_REFLECTION_MEMBERS.has(calleeName ?? "")
        && designJavaScriptProvenance(args[0], index) !== "local") {
        markExecutionEnvironmentProbe(node, `${effective.root}.${calleeName ?? "dynamic reflection"} on an unproven value`);
      }
      if (calleeName === "setAttribute" || calleeName === "setAttributeNS") {
        const offset = calleeName === "setAttributeNS" ? 1 : 0;
        const attribute = designJavaScriptConstantString(args[offset], index)?.toLowerCase();
        const value = designJavaScriptConstantString(args[offset + 1], index);
        if (attribute === "style") {
          if (value === null) usesDynamicStyle = true;
          else assertDesignExportCssIsStatic(value);
        }
      }
      if (receiver === "style" && calleeName === "setProperty") {
        const property = designJavaScriptConstantString(args[0], index);
        const value = designJavaScriptConstantString(args[1], index);
        if (property === null || value === null) usesDynamicStyle = true;
        else assertDesignExportCssIsStatic(`${property}: ${value}`);
      }
      if (["insertRule", "addRule", "replaceSync"].includes(calleeName ?? "")
        || (receiver === "style" && calleeName === "replace")) {
        const css = designJavaScriptConstantString(args[0], index);
        if (css === null) usesDynamicStyle = true;
        else assertDesignExportCssIsStatic(css);
      }
      if (effective?.root === "document"
        && (calleeName === "createElement" || calleeName === "createElementNS")) {
        const tagName = designJavaScriptConstantString(args[calleeName === "createElementNS" ? 1 : 0], index)?.toLowerCase();
        if (["animate", "set", "marquee"].includes(tagName ?? "")) usesWebAnimations = true;
      }
      if (effective !== null && ["Object", "Reflect"].includes(effective.root)
        && ["defineProperty", "get", "set"].includes(calleeName ?? "")) {
        const property = designJavaScriptConstantString(args[1], index);
        if (property !== null && DESIGN_JAVASCRIPT_EXPORT_STATE_MEMBERS.has(property)) {
          markExecutionEnvironmentProbe(node, `${effective.root}.${calleeName ?? "reflection"} of ${property}`);
        }
        if (property !== null && DESIGN_JAVASCRIPT_EXPORT_ANIMATION_MEMBERS.has(property)) {
          usesWebAnimations = true;
        }
      }
    }
    if ((node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration"
      || (node.type === "ExportNamedDeclaration" && node.source !== null && node.source !== undefined))
      && designJavaScriptNode(node.source) && node.source.type === "StringLiteral"
      && typeof node.source.value === "string") {
      specifiers.push(node.source.value);
    }
  });
  if (usesDeferredScheduler) {
    throw new DesignStorageError("invalid-html", "Design Export JavaScript cannot use deferred timer or scheduler capabilities");
  }
  if (usesWebAnimations) {
    throw new DesignStorageError("invalid-html", "Design Export JavaScript cannot use Web Animations or deferred animation capabilities");
  }
  if (usesDynamicStyle) {
    throw new DesignStorageError("invalid-html", "Design Export JavaScript cannot construct dynamic CSS outside static validation");
  }
  if (executionEnvironmentProbe !== null) {
    throw new DesignStorageError(
      "invalid-html",
      `Design Export JavaScript cannot inspect browser environment or persistent storage state (${executionEnvironmentProbe})`,
    );
  }
  return specifiers;
}

function normalizedDesignExportCssForCapabilityScan(css: string): string {
  let normalized = "";
  for (let index = 0; index < css.length;) {
    const character = css[index]!;
    const next = css[index + 1];
    if (character === "/" && next === "*") {
      const end = css.indexOf("*/", index + 2);
      if (end < 0) return normalized;
      normalized += " ";
      index = end + 2;
      continue;
    }
    if (character === "\"" || character === "'") {
      const quote = character;
      normalized += " ";
      index += 1;
      while (index < css.length) {
        if (css[index] === "\\") {
          index += css[index + 1] === "\r" && css[index + 2] === "\n" ? 3 : 2;
          continue;
        }
        if (css[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    normalized += character;
    index += 1;
  }
  return normalized.replace(
    /\\(?:([0-9a-f]{1,6})(?:\r\n|[\t\n\f\r ])?|([^\r\n\f]))/gi,
    (_match, hexadecimal: string | undefined, escaped: string | undefined) => hexadecimal === undefined
      ? escaped ?? ""
      : String.fromCodePoint(Number.parseInt(hexadecimal, 16)),
  );
}

function assertDesignExportCssIsStatic(css: string): void {
  const normalized = normalizedDesignExportCssForCapabilityScan(css);
  if (/@(?:-webkit-)?keyframes\b|@starting-style\b/i.test(normalized)
    || /(?:^|[;{])\s*(?:-webkit-)?(?:animation|transition)(?:-[a-z-]+)?\s*:/i.test(normalized)
    || /(?:^|[;{])\s*(?:scroll-timeline|view-timeline|timeline-scope)(?:-[a-z-]+)?\s*:/i.test(normalized)) {
    throw new DesignStorageError(
      "invalid-input",
      "Implementation Export CSS cannot use animations, transitions, timelines, or deferred visual changes",
    );
  }
}

export function validateDesignExportCss(
  css: string,
  mode: "stylesheet" | "attribute" = "stylesheet",
): void {
  assertDesignExportCssIsStatic(css);
  let dependencies: ReturnType<typeof transformCss>["dependencies"];
  try {
    dependencies = mode === "attribute"
      ? transformStyleAttribute({
        filename: "design-export-style.css",
        code: Buffer.from(css),
        analyzeDependencies: true,
      }).dependencies
      : transformCss({
        filename: "design-export.css",
        code: Buffer.from(css),
        analyzeDependencies: true,
      }).dependencies;
  } catch {
    throw new DesignStorageError("invalid-input", "Implementation Export contains invalid CSS");
  }
  for (const dependency of dependencies ?? []) {
    if (dependency.type === "import" || dependency.type !== "url"
      || !allowedDesignExportUrl(dependency.url)) {
      throw new DesignStorageError("invalid-input", "Implementation Export CSS must remain local and self-contained");
    }
  }
}

function validateDesignResponsiveUrls(value: string, allowCanonicalAssets: boolean): void {
  const candidates = value.split(",").map((entry) => entry.trim().split(/\s+/, 1)[0] ?? "");
  if (candidates.length === 0 || candidates.some((candidate) => !allowedDesignUrl(candidate, allowCanonicalAssets))) {
    throw new DesignStorageError("invalid-html", "Generated HTML contains an unpinned or external responsive-image URL");
  }
}

function validateDesignScriptElement(
  element: DefaultTreeAdapterTypes.Element,
  allowCanonicalAssets: boolean,
): void {
  if (designHtmlAttribute(element, "src") !== null) {
    throw new DesignStorageError("invalid-html", "Generated HTML must keep JavaScript inline");
  }
  const rawType = (designHtmlAttribute(element, "type") ?? "").trim().toLowerCase();
  const type = rawType.split(";", 1)[0]?.trim() ?? "";
  const script = designHtmlText(element);
  if (type === "speculationrules" || type === "importmap") {
    throw new DesignStorageError("invalid-html", "Generated HTML may not declare browser-loading script data");
  }
  if (type === "module") {
    validateDesignJavaScript(script, allowCanonicalAssets, "module");
    return;
  }
  if (type === "" || DESIGN_HTML_JAVASCRIPT_TYPES.has(type)) {
    validateDesignJavaScript(script, allowCanonicalAssets, "script");
    return;
  }
  if ((type === "application/json" || type.endsWith("+json")) && script.trim()) {
    try {
      JSON.parse(script);
    } catch {
      throw new DesignStorageError("invalid-html", "Generated HTML contains invalid JSON script data");
    }
  }
}

function validateDesignHtmlElement(
  element: DefaultTreeAdapterTypes.Element,
  allowCanonicalAssets: boolean,
): void {
  const tagName = element.tagName.toLowerCase();
  if (DESIGN_HTML_BROWSING_CONTEXT_ELEMENTS.has(tagName)) {
    throw new DesignStorageError("invalid-html", "Generated HTML may not create nested browsing contexts");
  }
  if (tagName === "base") {
    throw new DesignStorageError("invalid-html", "Generated HTML may not redefine navigation");
  }
  const rel = designHtmlAttribute(element, "rel")?.trim().toLowerCase().split(/\s+/) ?? [];
  if (tagName === "link" && rel.includes("stylesheet")) {
    throw new DesignStorageError("invalid-html", "Generated HTML must keep styles inline");
  }
  if (tagName === "meta" && designHtmlAttribute(element, "http-equiv")?.trim().toLowerCase() === "refresh") {
    throw new DesignStorageError("invalid-html", "Generated HTML may not refresh navigation");
  }
  for (const attribute of element.attrs) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith("on")) {
      throw new DesignStorageError("invalid-html", "Generated HTML may not use executable event attributes");
    }
    if (["target", "formtarget"].includes(name) && attribute.value.trim().toLowerCase() !== "_self") {
      throw new DesignStorageError("invalid-html", "Generated HTML may not target another browsing context");
    }
    if (name === "style") validateDesignCss(attribute.value, allowCanonicalAssets, "attribute");
    if (DESIGN_HTML_URL_ATTRIBUTES.has(name) && !allowedDesignUrl(attribute.value, allowCanonicalAssets)) {
      const rejected = attribute.value.trim();
      const preview = rejected.length > 160 ? `${rejected.slice(0, 160)}…` : rejected;
      throw new DesignStorageError(
        "invalid-html",
        `Generated HTML contains an unpinned or external URL in <${tagName}> ${name}=${JSON.stringify(preview)}`,
      );
    }
    if (DESIGN_HTML_RESPONSIVE_URL_ATTRIBUTES.has(name)) {
      validateDesignResponsiveUrls(attribute.value, allowCanonicalAssets);
    }
    if (name === "ping") {
      const targets = attribute.value.trim().split(/\s+/).filter(Boolean);
      if (targets.length === 0 || targets.some((target) => !allowedDesignUrl(target, allowCanonicalAssets))) {
        throw new DesignStorageError("invalid-html", "Generated HTML contains an external hyperlink audit URL");
      }
    }
  }
  if (tagName === "style") validateDesignCss(designHtmlText(element), allowCanonicalAssets);
  if (tagName === "script") validateDesignScriptElement(element, allowCanonicalAssets);
}

export function validateDesignHtml(
  html: string,
  options: { allowCanonicalAssets?: boolean } = {},
): void {
  if (typeof html !== "string" || !html.trim()) {
    throw new DesignStorageError("invalid-html", "Generated HTML is empty");
  }
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > MAX_DESIGN_HTML_BYTES) {
    throw new DesignStorageError("invalid-html", "Generated HTML exceeds the size limit");
  }
  if (!/^\s*<!doctype\s+html\s*>/i.test(html) || !/<\/html\s*>\s*$/i.test(html)) {
    throw new DesignStorageError("invalid-html", "Generated output must be one complete HTML document");
  }
  const parseErrors: ParserError[] = [];
  const document = parseHtml(html, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => parseErrors.push(error),
  });
  if (parseErrors.length > 0) {
    throw new DesignStorageError("invalid-html", "Generated output is not valid HTML");
  }
  let doctypeCount = 0;
  const structural = new Map<string, DefaultTreeAdapterTypes.Element[]>();
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if (node.nodeName === "#documentType" && "name" in node) {
      if (node.name.toLowerCase() === "html" && node.sourceCodeLocation) doctypeCount += 1;
    }
    if (designHtmlElement(node)) {
      const tagName = node.tagName.toLowerCase();
      if (["html", "head", "body"].includes(tagName)) {
        const matches = structural.get(tagName) ?? [];
        matches.push(node);
        structural.set(tagName, matches);
      }
      validateDesignHtmlElement(node, options.allowCanonicalAssets === true);
    }
    for (const child of designHtmlChildren(node)) visit(child);
  };
  visit(document);
  const hasExactSourceElement = (tagName: "html" | "head" | "body"): boolean => {
    const matches = structural.get(tagName) ?? [];
    return matches.length === 1
      && matches[0]?.sourceCodeLocation !== null
      && matches[0]?.sourceCodeLocation !== undefined
      && matches[0]?.sourceCodeLocation?.startTag !== undefined
      && matches[0]?.sourceCodeLocation?.endTag !== undefined;
  };
  if (doctypeCount !== 1 || !hasExactSourceElement("html")
    || !hasExactSourceElement("head") || !hasExactSourceElement("body")) {
    throw new DesignStorageError("invalid-html", "Generated output must be one complete HTML document");
  }
}

async function canonicalizeVersionAssets(input: {
  dataDir: string;
  projectId: string;
  nodeId: string;
  versionId: string;
  html: string;
  allowedCanonicalAssetUrls: ReadonlySet<string>;
}): Promise<{ html: string; pins: Array<{ assetId: string; checksum: string }> }> {
  const ids = new Set<string>();
  for (const match of input.html.matchAll(/dezin-asset:\/\/(asset-[a-f0-9]{32})\b/g)) ids.add(match[1]!);

  const projectPath = `/api/projects/${input.projectId}/design-canvas/assets/`;
  const escaped = projectPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const canonicalAssetUrl = /\/api\/projects\/([A-Za-z0-9._-]+)\/design-canvas\/assets\/(asset-[a-f0-9]{32})\/original\.[a-z0-9]{1,12}\?nodeId=([A-Za-z0-9._-]+)&versionId=(version-[A-Za-z0-9._-]+)&checksum=([a-f0-9]{64})/gi;
  for (const match of input.html.matchAll(canonicalAssetUrl)) {
    if (match[1] !== input.projectId || match[3] !== input.nodeId
      || !input.allowedCanonicalAssetUrls.has(match[0])) {
      throw new DesignStorageError(
        "invalid-html",
        "Generated HTML contains a canonical Asset URL not authorized by its expected Head Version",
      );
    }
  }
  for (const match of input.html.matchAll(new RegExp(`${escaped}(asset-[a-f0-9]{32})/[^\\s"'<>)]*`, "g"))) {
    ids.add(match[1]!);
  }

  const manifests = await Promise.all([...ids].sort().map((id) => getDesignAssetManifest(
    input.dataDir,
    input.projectId,
    id,
  )));
  let html = input.html;
  for (const manifest of manifests) {
    const canonical = `${projectPath}${manifest.id}/${manifest.fileName}`
      + `?nodeId=${input.nodeId}&versionId=${input.versionId}&checksum=${manifest.checksum}`;
    html = html.replaceAll(`dezin-asset://${manifest.id}`, canonical);
    const direct = new RegExp(`${escaped}${manifest.id.replace(/-/g, "\\-")}/[^\\s"'<>)]*`, "g");
    html = html.replace(direct, canonical);
  }
  if (/dezin-asset:\/\//i.test(html)) {
    throw new DesignStorageError("invalid-html", "Generated HTML contains an invalid Design Asset reference");
  }
  validateDesignHtml(html, { allowCanonicalAssets: true });
  return {
    html,
    pins: manifests.map((manifest) => ({ assetId: manifest.id, checksum: manifest.checksum })),
  };
}

function versionRoot(root: string, nodeId: string, versionId: string): string {
  return join(nodeRoot(root, nodeId), "versions", safeSegment(versionId, "Version id"));
}

function publicationTransactionsRoot(root: string): string {
  return join(root, "transactions", "publications");
}

async function assertNoDesignVersionPublicationsUnlocked(root: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(publicationTransactionsRoot(root), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (entries.length > 0) {
    throw new DesignStorageError(
      "conflict",
      "Design publication recovery must complete before this Project can be read or changed",
    );
  }
}

function publicationTransactionPath(root: string, jobId: string): string {
  return join(publicationTransactionsRoot(root), `${safeSegment(jobId, "Job id")}.json`);
}

function pendingVersionRoot(root: string, nodeId: string, versionId: string): string {
  return join(nodeRoot(root, nodeId), ".pending", "versions", safeSegment(versionId, "Version id"));
}

export interface DesignVersionPublicationTestHooks {
  /** Test-only: model a process exit by leaving the durable marker for restart recovery. */
  simulateProcessCrash?: boolean;
  afterPhase?: (phase: DesignVersionPublicationPhase) => void | Promise<void>;
  afterPendingDirectory?: () => void | Promise<void>;
  afterPendingIndex?: () => void | Promise<void>;
}

function publicationTransactionChecksum(
  content: Omit<DesignVersionPublicationTransaction, "checksum">,
): string {
  return createHash("sha256").update(stableStringify(content), "utf8").digest("hex");
}

function assertStoredPublicationTransaction(
  value: unknown,
  expectedProjectId: string,
  expectedJobId: string,
): asserts value is DesignVersionPublicationTransaction {
  const transaction = storedRecord(value, `Design publication ${expectedJobId}`, [
    "schemaVersion", "projectId", "jobId", "nodeId", "manifest", "terminalStatus",
    "projectRevisionBefore", "previousVersionCount", "currentVersionIdBefore",
    "selectedVersionIdBefore", "followsHead", "createdAt", "checksum",
  ]);
  const { checksum, ...content } = transaction;
  const actualChecksum = publicationTransactionChecksum(
    content as Omit<DesignVersionPublicationTransaction, "checksum">,
  );
  if (transaction.schemaVersion !== DESIGN_SCHEMA_VERSION || transaction.projectId !== expectedProjectId
    || transaction.jobId !== expectedJobId || typeof transaction.nodeId !== "string"
    || !SAFE_SEGMENT.test(transaction.nodeId) || !["ready", "superseded"].includes(String(transaction.terminalStatus))
    || !Number.isSafeInteger(transaction.projectRevisionBefore) || (transaction.projectRevisionBefore as number) < 0
    || !Number.isSafeInteger(transaction.previousVersionCount) || (transaction.previousVersionCount as number) < 0
    || !validStoredNullableId(transaction.currentVersionIdBefore)
    || !validStoredNullableId(transaction.selectedVersionIdBefore)
    || typeof transaction.followsHead !== "boolean" || !validStoredTimestamp(transaction.createdAt)
    || typeof checksum !== "string" || !SHA256.test(checksum) || checksum !== actualChecksum) {
    throw new DesignStorageError("corrupt", `Design publication ${expectedJobId} is invalid`);
  }
  const manifest = transaction.manifest;
  if (!manifest || typeof manifest !== "object") {
    throw new DesignStorageError("corrupt", `Design publication ${expectedJobId} manifest is invalid`);
  }
  const versionId = (manifest as { id?: unknown }).id;
  if (typeof versionId !== "string") {
    throw new DesignStorageError("corrupt", `Design publication ${expectedJobId} manifest is invalid`);
  }
  assertStoredVersionManifest(manifest, transaction.nodeId as string, versionId);
  if ((manifest as DesignVersionManifest).contentKind !== "html"
    || (manifest as DesignVersionManifest).assetId !== null
    || (manifest as DesignVersionManifest).jobId !== expectedJobId
    || ((manifest as DesignVersionManifest).publicationStatus === "published" ? "ready" : "superseded")
      !== transaction.terminalStatus) {
    throw new DesignStorageError("corrupt", `Design publication ${expectedJobId} authority is invalid`);
  }
}

async function readPublicationTransaction(
  root: string,
  projectId: string,
  jobId: string,
): Promise<DesignVersionPublicationTransaction> {
  const value = await readJson<DesignVersionPublicationTransaction>(
    publicationTransactionPath(root, jobId),
    `Design publication ${jobId}`,
  );
  assertStoredPublicationTransaction(value, projectId, jobId);
  return value;
}

async function verifyPublicationPayload(path: string, manifest: DesignVersionManifest): Promise<void> {
  const manifestValue = await readJson<DesignVersionManifest>(join(path, "manifest.json"), `Design Version ${manifest.id}`);
  assertStoredVersionManifest(manifestValue, manifest.nodeId, manifest.id);
  if (JSON.stringify(manifestValue) !== JSON.stringify(manifest)) {
    throw new DesignStorageError("corrupt", `Design Version ${manifest.id} diverges from its publication marker`);
  }
  const htmlPath = join(path, "index.html");
  const info = await lstat(htmlPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== manifest.bytes) {
    throw new DesignStorageError("corrupt", `Design Version ${manifest.id} publication payload is invalid`);
  }
  const checksum = createHash("sha256").update(await readFile(htmlPath)).digest("hex");
  if (checksum !== manifest.checksum) {
    throw new DesignStorageError("corrupt", `Design Version ${manifest.id} publication checksum is invalid`);
  }
}

function assertStoredVersionManifest(
  value: unknown,
  expectedNodeId: string,
  expectedVersionId: string,
): asserts value is DesignVersionManifest {
  const manifest = storedRecord(value, `Design Version ${expectedVersionId} manifest`, [
    "schemaVersion", "id", "nodeId", "contentKind", "assetId", "sequence", "checksum", "bytes", "contextHash", "canvasRevision",
    "expectedHeadVersionId", "publicationStatus", "assetPins", "jobId", "runnerId", "model", "createdAt",
  ]);
  if (manifest.schemaVersion !== DESIGN_SCHEMA_VERSION || manifest.id !== expectedVersionId
    || manifest.nodeId !== expectedNodeId || !SAFE_SEGMENT.test(expectedVersionId) || !SAFE_SEGMENT.test(expectedNodeId)
    || !Number.isSafeInteger(manifest.sequence) || (manifest.sequence as number) < 1
    || !SHA256.test(String(manifest.checksum))
    || !["html", "asset"].includes(String(manifest.contentKind))
    || !validStoredNullableId(manifest.assetId)
    || !Number.isSafeInteger(manifest.bytes) || (manifest.bytes as number) < 1
    || (manifest.bytes as number) > (manifest.contentKind === "asset" ? MAX_DESIGN_ASSET_BYTES : MAX_DESIGN_HTML_BYTES)
    || !SHA256.test(String(manifest.contextHash))
    || !Number.isSafeInteger(manifest.canvasRevision) || (manifest.canvasRevision as number) < 0
    || !validStoredNullableId(manifest.expectedHeadVersionId)
    || !["published", "superseded"].includes(String(manifest.publicationStatus))
    || !Array.isArray(manifest.assetPins) || manifest.assetPins.length > MAX_ASSET_BUNDLE_FILES
    || !validStoredNullableId(manifest.jobId)
    || !validStoredText(manifest.runnerId, 512, { nullable: true })
    || (typeof manifest.runnerId === "string" && manifest.runnerId.trim() !== manifest.runnerId)
    || !validStoredText(manifest.model, 512, { nullable: true })
    || (typeof manifest.model === "string" && manifest.model.trim() !== manifest.model)
    || (manifest.jobId !== null && manifest.runnerId === null)
    || (manifest.runnerId === null && manifest.model !== null)
    || !validStoredTimestamp(manifest.createdAt)) {
    throw new DesignStorageError("corrupt", `Design Version ${expectedVersionId} manifest is invalid`);
  }
  const pinIds = new Set<string>();
  for (const [index, entry] of manifest.assetPins.entries()) {
    const pin = storedRecord(entry, `Design Version ${expectedVersionId} Asset pin ${index}`, ["assetId", "checksum"]);
    if (typeof pin.assetId !== "string" || !/^asset-[a-f0-9]{32}$/.test(pin.assetId)
      || pinIds.has(pin.assetId) || !SHA256.test(String(pin.checksum))) {
      throw new DesignStorageError("corrupt", `Design Version ${expectedVersionId} Asset pin ${index} is invalid`);
    }
    pinIds.add(pin.assetId);
  }
  if ((manifest.contentKind === "html" && manifest.assetId !== null)
    || (manifest.contentKind === "asset" && (
      typeof manifest.assetId !== "string" || !/^asset-[a-f0-9]{32}$/.test(manifest.assetId)
      || manifest.assetPins.length !== 0 || manifest.jobId !== null
      || manifest.runnerId !== null || manifest.model !== null
    ))) {
    throw new DesignStorageError("corrupt", `Design Version ${expectedVersionId} content binding is invalid`);
  }
}

function assertPublicationJobAuthority(
  job: DesignJob,
  transaction: DesignVersionPublicationTransaction,
): void {
  const manifest = transaction.manifest;
  if (job.id !== transaction.jobId || job.kind !== "node-generation" || job.nodeId !== transaction.nodeId
    || job.contextHash !== manifest.contextHash || job.canvasRevision !== manifest.canvasRevision
    || job.expectedHeadVersionId !== manifest.expectedHeadVersionId || job.runnerId !== manifest.runnerId
    || job.model !== manifest.model || (job.versionId !== null && job.versionId !== manifest.id)) {
    throw new DesignStorageError("corrupt", `Design publication ${transaction.jobId} Job authority is invalid`);
  }
}

function publicationNodeState(
  node: DesignNode,
  transaction: DesignVersionPublicationTransaction,
): "before" | "after" | null {
  const before = node.currentVersionId === transaction.currentVersionIdBefore
    && node.selectedVersionId === transaction.selectedVersionIdBefore
    && node.versionCount === transaction.previousVersionCount
    && node.activeJobId === transaction.jobId;
  if (before) return "before";
  const expectedCurrent = transaction.terminalStatus === "ready"
    ? transaction.manifest.id
    : transaction.currentVersionIdBefore;
  const expectedSelected = transaction.terminalStatus === "ready" && transaction.followsHead
    ? transaction.manifest.id
    : transaction.selectedVersionIdBefore;
  const after = node.currentVersionId === expectedCurrent && node.selectedVersionId === expectedSelected
    && node.versionCount === transaction.previousVersionCount + 1 && node.activeJobId === null
    && node.state === transaction.terminalStatus;
  return after ? "after" : null;
}

async function rollForwardPublicationUnlocked(
  root: string,
  transaction: DesignVersionPublicationTransaction,
  hooks?: DesignVersionPublicationTestHooks,
): Promise<DesignJob> {
  const manifest = transaction.manifest;
  const pending = pendingVersionRoot(root, transaction.nodeId, manifest.id);
  const target = versionRoot(root, transaction.nodeId, manifest.id);
  const [pendingExists, targetExists] = await Promise.all([exists(pending), exists(target)]);
  if (pendingExists === targetExists) {
    throw new DesignStorageError("corrupt", `Design publication ${transaction.jobId} payload state is invalid`);
  }
  if (pendingExists) {
    await verifyPublicationPayload(pending, manifest);
  } else {
    await verifyPublicationPayload(target, manifest);
  }

  const job = await readJob(root, transaction.jobId);
  assertPublicationJobAuthority(job, transaction);
  if (!(job.status === "validating" || job.status === transaction.terminalStatus)) {
    throw new DesignStorageError("corrupt", `Design publication ${transaction.jobId} Job state is invalid`);
  }

  const project = await readProject(root);
  if (![transaction.projectRevisionBefore, transaction.projectRevisionBefore + 1].includes(project.revision)) {
    throw new DesignStorageError("corrupt", `Design publication ${transaction.jobId} Canvas revision is invalid`);
  }
  const nodes = readNodes(project);
  const node = nodes.get(transaction.nodeId);
  if (!node) throw new DesignStorageError("corrupt", `Design publication ${transaction.jobId} Node is unavailable`);
  const nodeState = publicationNodeState(node, transaction);
  if (nodeState === null || (nodeState === "before" && project.revision !== transaction.projectRevisionBefore)
    || (nodeState === "after" && project.revision !== transaction.projectRevisionBefore + 1)) {
    throw new DesignStorageError("corrupt", `Design publication ${transaction.jobId} Canvas authority is invalid`);
  }
  if (pendingExists) {
    await mkdir(join(nodeRoot(root, transaction.nodeId), "versions"), { recursive: true });
    await rename(pending, target);
    await hooks?.afterPhase?.("target");
  }
  if (nodeState === "before") {
    node.versionCount = transaction.previousVersionCount + 1;
    node.error = null;
    if (transaction.terminalStatus === "ready") {
      node.currentVersionId = manifest.id;
      if (transaction.followsHead) node.selectedVersionId = manifest.id;
      node.state = "ready";
    } else {
      node.state = "superseded";
    }
    node.activeJobId = null;
    node.updatedAt = transaction.createdAt;
    project.nodes = project.nodeOrder.map((id) => cloneNode(nodes.get(id)!));
    project.revision = transaction.projectRevisionBefore + 1;
    project.updatedAt = Math.max(project.updatedAt, transaction.createdAt);
    await writeAtomicJson(projectFilePath(root), project);
    await hooks?.afterPhase?.("canvas");
  }

  job.status = transaction.terminalStatus;
  job.versionId = manifest.id;
  job.cancelRequested = false;
  job.error = transaction.terminalStatus === "ready"
    ? null
    : "A newer Node head was published before this result completed";
  job.updatedAt = Math.max(job.updatedAt, transaction.createdAt);
  job.finishedAt = job.updatedAt;
  await writeAtomicJson(jobFilePath(root, job.id), job);
  await hooks?.afterPhase?.("job");
  await rm(publicationTransactionPath(root, transaction.jobId));
  return job;
}

async function rollBackUnpublishedPublicationUnlocked(
  root: string,
  transaction: DesignVersionPublicationTransaction,
  timestamp: number,
  pending: string | null = null,
): Promise<DesignJob> {
  const job = await readJob(root, transaction.jobId);
  assertPublicationJobAuthority(job, transaction);
  if (!(job.status === "validating" || job.status === "cancelled")) {
    throw new DesignStorageError("corrupt", `Design publication ${transaction.jobId} rollback Job state is invalid`);
  }
  const project = await readProject(root);
  const nodes = readNodes(project);
  const node = nodes.get(transaction.nodeId);
  if (!node) throw new DesignStorageError("corrupt", `Design publication ${transaction.jobId} Node is unavailable`);
  const afterRevision = transaction.projectRevisionBefore + 1;
  const before = project.revision === transaction.projectRevisionBefore
    && node.currentVersionId === transaction.currentVersionIdBefore
    && node.selectedVersionId === transaction.selectedVersionIdBefore
    && node.versionCount === transaction.previousVersionCount && node.activeJobId === transaction.jobId;
  const after = project.revision === afterRevision && node.currentVersionId === transaction.currentVersionIdBefore
    && node.selectedVersionId === transaction.selectedVersionIdBefore
    && node.versionCount === transaction.previousVersionCount && node.activeJobId === null && node.state === "cancelled";
  if (!before && !after) {
    throw new DesignStorageError("corrupt", `Design publication ${transaction.jobId} rollback authority is invalid`);
  }
  if (pending !== null) await rm(pending, { recursive: true, force: true });
  if (before) {
    node.state = "cancelled";
    node.activeJobId = null;
    node.error = null;
    node.updatedAt = timestamp;
    project.nodes = project.nodeOrder.map((id) => cloneNode(nodes.get(id)!));
    project.revision = afterRevision;
    project.updatedAt = Math.max(project.updatedAt, timestamp);
    await writeAtomicJson(projectFilePath(root), project);
  }
  job.status = "cancelled";
  job.cancelRequested = true;
  job.error = "Interrupted before Design Version publication payload was durably staged";
  job.updatedAt = timestamp;
  job.finishedAt = timestamp;
  await writeAtomicJson(jobFilePath(root, job.id), job);
  await rm(publicationTransactionPath(root, transaction.jobId));
  return job;
}

function recoverablePendingPayloadError(error: unknown): boolean {
  return (error instanceof DesignStorageError && (error.code === "missing" || error.code === "corrupt"))
    || (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT");
}

async function recoverPublicationTransactionUnlocked(
  root: string,
  transaction: DesignVersionPublicationTransaction,
  timestamp: number,
): Promise<DesignJob> {
  const pending = pendingVersionRoot(root, transaction.nodeId, transaction.manifest.id);
  const target = versionRoot(root, transaction.nodeId, transaction.manifest.id);
  const [pendingExists, targetExists] = await Promise.all([exists(pending), exists(target)]);
  if (targetExists) {
    // Once the target exists it is the candidate immutable Version. Any mismatch must remain
    // quarantined behind the durable marker instead of being silently discarded or published.
    return rollForwardPublicationUnlocked(root, transaction);
  }
  if (!pendingExists) return rollBackUnpublishedPublicationUnlocked(root, transaction, timestamp);
  try {
    await verifyPublicationPayload(pending, transaction.manifest);
  } catch (error) {
    if (!recoverablePendingPayloadError(error)) throw error;
    return rollBackUnpublishedPublicationUnlocked(root, transaction, timestamp, pending);
  }
  return rollForwardPublicationUnlocked(root, transaction);
}

async function recoverPublicationTransactionsUnlocked(
  root: string,
  projectId: string,
  timestamp: number,
): Promise<DesignJob[]> {
  const parent = publicationTransactionsRoot(root);
  if (!(await exists(parent))) return [];
  const entries = await readdir(parent, { withFileTypes: true });
  const recovered: DesignJob[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isFile() && /^\.job-[0-9a-f-]{36}\.json\.[0-9a-f-]{36}\.tmp$/.test(entry.name)) {
      await rm(join(parent, entry.name));
      continue;
    }
    if (!entry.isFile() || !/^job-[0-9a-f-]{36}\.json$/.test(entry.name)) {
      throw new DesignStorageError("corrupt", "Design publication transaction identity is invalid");
    }
    const jobId = entry.name.slice(0, -5);
    const transaction = await readPublicationTransaction(root, projectId, jobId);
    recovered.push(await recoverPublicationTransactionUnlocked(root, transaction, timestamp));
  }
  return recovered;
}

/** Recover one durable Version publication without terminalizing unrelated interrupted Jobs. */
export async function recoverDesignVersionPublication(
  dataDir: string,
  projectId: string,
  jobId: string,
  now?: number,
): Promise<DesignJob | null> {
  const root = designRoot(dataDir, projectId);
  safeSegment(jobId, "Job id");
  return withProjectLock(root, async () => {
    const marker = publicationTransactionPath(root, jobId);
    if (!(await exists(marker))) return null;
    const transaction = await readPublicationTransaction(root, projectId, jobId);
    return recoverPublicationTransactionUnlocked(root, transaction, nowValue(now));
  }, { allowPublicationTransactions: true });
}

async function listDesignVersionsUnlocked(root: string, nodeId: string): Promise<DesignVersionManifest[]> {
  safeSegment(nodeId, "Node id");
  const parent = join(nodeRoot(root, nodeId), "versions");
  if (!(await exists(parent))) return [];
  const entries = await readdir(parent, { withFileTypes: true });
  const manifests = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && SAFE_SEGMENT.test(entry.name))
    .map(async (entry) => {
      const manifest = await readJson<DesignVersionManifest>(join(parent, entry.name, "manifest.json"), `Design Version ${entry.name}`);
      assertStoredVersionManifest(manifest, nodeId, entry.name);
      return manifest;
    }));
  return manifests.sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

export async function listDesignVersions(
  dataDir: string,
  projectId: string,
  nodeId: string,
): Promise<DesignVersionManifest[]> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    await requireInitialized(root);
    return listDesignVersionsUnlocked(root, nodeId);
  });
}

async function getDesignVersionUnlocked(
  root: string,
  nodeId: string,
  versionId: string,
): Promise<DesignVersionManifest> {
  const manifest = await readJson<DesignVersionManifest>(
    join(versionRoot(root, nodeId, versionId), "manifest.json"),
    `Design Version ${versionId}`,
  );
  assertStoredVersionManifest(manifest, nodeId, versionId);
  return manifest;
}

export async function getDesignVersion(
  dataDir: string,
  projectId: string,
  nodeId: string,
  versionId: string,
): Promise<DesignVersionManifest> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    await requireInitialized(root);
    return getDesignVersionUnlocked(root, nodeId, versionId);
  });
}

export async function publishDesignVersion(
  dataDir: string,
  projectId: string,
  input: {
    nodeId: string;
    html: string;
    contextHash: string;
    canvasRevision: number;
    expectedHeadVersionId: string | null;
    jobId: string | null;
    runnerId: string | null;
    model: string | null;
  },
  now?: number,
  hooks?: DesignVersionPublicationTestHooks,
): Promise<{ manifest: DesignVersionManifest; node: DesignNode; job: DesignJob | null }> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    await requireInitialized(root);
    const project = await readProject(root);
    const nodeId = safeSegment(input.nodeId, "Node id");
    const nodes = readNodes(project);
    const node = nodes.get(nodeId);
    if (!node) throw new DesignStorageError("not-found", `Design Node ${nodeId} was not found`);
    if (!(DESIGN_GENERATIVE_NODE_KINDS as readonly string[]).includes(node.kind)) {
      throw new DesignStorageError("invalid-input", "Material Nodes cannot publish generated versions");
    }
    if (!SHA256.test(input.contextHash) || !Number.isSafeInteger(input.canvasRevision) || input.canvasRevision < 0) {
      throw new DesignStorageError("invalid-input", "Generation context identity is invalid");
    }
    if (input.expectedHeadVersionId !== null) safeSegment(input.expectedHeadVersionId, "Expected Head Version id");
    if (input.jobId !== null) safeSegment(input.jobId, "Job id");
    if (!validStoredText(input.runnerId, 512, { nullable: true })
      || !validStoredText(input.model, 512, { nullable: true })) {
      throw new DesignStorageError("invalid-input", "Generation runner identity is invalid");
    }
    let authorityJob: DesignJob | null = null;
    if (input.jobId !== null) {
      const authority = await readJob(root, input.jobId);
      if (authority.kind !== "node-generation"
        || authority.nodeId !== nodeId
        || authority.status !== "validating"
        || authority.cancelRequested
        || node.activeJobId !== authority.id
        || authority.contextHash !== input.contextHash
        || authority.canvasRevision !== input.canvasRevision
        || authority.expectedHeadVersionId !== input.expectedHeadVersionId
        || authority.runnerId !== input.runnerId
        || authority.model !== input.model) {
        throw new DesignStorageError(
          "conflict",
          "Generation Version publication requires the active validating Job authority",
        );
      }
      authorityJob = authority;
    }
    // A previous immutable Version already contains checksum-bound canonical
    // Asset URLs. Permit only exact URLs pinned by this Node's expected Head;
    // canonicalizeVersionAssets then rebinds them to the new immutable Version.
    const allowedCanonicalAssetUrls = new Set<string>();
    if (input.expectedHeadVersionId !== null) {
      const expectedHead = await getDesignVersionUnlocked(root, nodeId, input.expectedHeadVersionId);
      for (const pin of expectedHead.assetPins) {
        const asset = await getDesignAssetManifest(dataDir, projectId, pin.assetId);
        if (asset.checksum !== pin.checksum) {
          throw new DesignStorageError("corrupt", `Expected Head Version ${expectedHead.id} has an invalid Asset pin`);
        }
        allowedCanonicalAssetUrls.add(
          `/api/projects/${projectId}/design-canvas/assets/${asset.id}/${asset.fileName}`
            + `?nodeId=${nodeId}&versionId=${expectedHead.id}&checksum=${asset.checksum}`,
        );
      }
    }
    validateDesignHtml(input.html, { allowCanonicalAssets: true });

    const existing = await listDesignVersionsUnlocked(root, nodeId);
    const sequence = existing.reduce((maximum, version) => Math.max(maximum, version.sequence), 0) + 1;
    const versionId = `version-${randomUUID()}`;
    const canonical = await canonicalizeVersionAssets({
      dataDir,
      projectId,
      nodeId,
      versionId,
      html: input.html,
      allowedCanonicalAssetUrls,
    });
    const timestamp = nowValue(now);
    const bytes = Buffer.byteLength(canonical.html, "utf8");
    const checksum = createHash("sha256").update(canonical.html, "utf8").digest("hex");
    const publicationStatus = node.currentVersionId === input.expectedHeadVersionId ? "published" : "superseded";
    const manifest: DesignVersionManifest = {
      schemaVersion: DESIGN_SCHEMA_VERSION,
      id: versionId,
      nodeId,
      contentKind: "html",
      assetId: null,
      sequence,
      checksum,
      bytes,
      contextHash: input.contextHash,
      canvasRevision: input.canvasRevision,
      expectedHeadVersionId: input.expectedHeadVersionId,
      publicationStatus,
      assetPins: canonical.pins,
      jobId: input.jobId,
      runnerId: input.runnerId,
      model: input.model,
      createdAt: timestamp,
    };

    if (authorityJob !== null) {
      const transactionContent: Omit<DesignVersionPublicationTransaction, "checksum"> = {
        schemaVersion: DESIGN_SCHEMA_VERSION,
        projectId,
        jobId: authorityJob.id,
        nodeId,
        manifest,
        terminalStatus: publicationStatus === "published" ? "ready" : "superseded",
        projectRevisionBefore: project.revision,
        previousVersionCount: node.versionCount,
        currentVersionIdBefore: node.currentVersionId,
        selectedVersionIdBefore: node.selectedVersionId,
        followsHead: node.selectedVersionId === null || node.selectedVersionId === node.currentVersionId,
        createdAt: timestamp,
      };
      const transaction: DesignVersionPublicationTransaction = {
        ...transactionContent,
        checksum: publicationTransactionChecksum(transactionContent),
      };
      let markerWritten = false;
      try {
        await mkdir(publicationTransactionsRoot(root), { recursive: true });
        const markerPath = publicationTransactionPath(root, authorityJob.id);
        if (await exists(markerPath)) {
          throw new DesignStorageError("conflict", `Design publication ${authorityJob.id} already has a transaction`);
        }
        await writeAtomicJson(markerPath, transaction);
        markerWritten = true;
        await hooks?.afterPhase?.("marker");

        const pending = pendingVersionRoot(root, nodeId, versionId);
        await mkdir(pending, { recursive: true });
        await hooks?.afterPendingDirectory?.();
        await writeFile(join(pending, "index.html"), canonical.html, { flag: "wx", mode: 0o600 });
        await hooks?.afterPendingIndex?.();
        await writeFile(join(pending, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        await hooks?.afterPhase?.("pending");
        const terminalJob = await rollForwardPublicationUnlocked(root, transaction, hooks);
        const committedProject = await readProject(root);
        const committedNode = readNodes(committedProject).get(nodeId);
        if (!committedNode) throw new DesignStorageError("corrupt", `Design publication ${authorityJob.id} lost its Node`);
        return { manifest, node: cloneNode(committedNode), job: terminalJob };
      } catch (error) {
        if (!markerWritten || hooks?.simulateProcessCrash) throw error;
        // Reconcile while this exact Project lock is still held. Letting the lock
        // go first would allow queued Canvas or cancellation writes to invalidate
        // the durable transaction's revision and Job authority.
        const recovered = await recoverPublicationTransactionUnlocked(root, transaction, timestamp);
        if (recovered.status !== transaction.terminalStatus || recovered.versionId !== manifest.id) throw error;
        const committedProject = await readProject(root);
        const committedNode = readNodes(committedProject).get(nodeId);
        if (!committedNode) throw new DesignStorageError("corrupt", `Design publication ${authorityJob.id} lost its Node`);
        return { manifest, node: cloneNode(committedNode), job: recovered };
      }
    }

    const pendingParent = join(nodeRoot(root, nodeId), ".pending");
    const pending = join(pendingParent, versionId);
    const target = versionRoot(root, nodeId, versionId);
    await mkdir(pending, { recursive: true });
    await mkdir(join(nodeRoot(root, nodeId), "versions"), { recursive: true });
    try {
      await writeFile(join(pending, "index.html"), canonical.html, { flag: "wx", mode: 0o600 });
      await writeFile(join(pending, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await rename(pending, target);
    } catch (error) {
      await rm(pending, { recursive: true, force: true }).catch(() => {});
      throw error;
    }

    node.versionCount = existing.length + 1;
    node.error = null;
    if (publicationStatus === "published") {
      const followsHead = node.selectedVersionId === null || node.selectedVersionId === node.currentVersionId;
      node.currentVersionId = versionId;
      if (followsHead) node.selectedVersionId = versionId;
      node.state = "ready";
    } else if (node.activeJobId === null || node.activeJobId === input.jobId) {
      node.state = "superseded";
    }
    if (node.activeJobId === input.jobId) node.activeJobId = null;
    node.updatedAt = timestamp;
    project.nodes = project.nodeOrder.map((id) => cloneNode(nodes.get(id)!));
    project.revision += 1;
    project.updatedAt = Math.max(project.updatedAt, timestamp);
    await writeAtomicJson(projectFilePath(root), project);
    return { manifest, node: cloneNode(node), job: null };
  });
}

async function resolveDesignVersionFileUnlocked(
  root: string,
  nodeId: string,
  versionId: string,
  requestedFile: string,
): Promise<{ manifest: DesignVersionManifest; path: string }> {
  if (requestedFile !== "" && requestedFile !== "index.html") {
    throw new DesignStorageError("not-found", "Design Version file was not found");
  }
  const manifest = await getDesignVersionUnlocked(root, nodeId, versionId);
  if (manifest.contentKind !== "html" || manifest.assetId !== null) {
    throw new DesignStorageError("not-found", "Material Design Versions do not contain index.html");
  }
  const path = join(versionRoot(root, nodeId, versionId), "index.html");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== manifest.bytes) {
    throw new DesignStorageError("corrupt", `Design Version ${versionId} HTML is invalid`);
  }
  const checksum = createHash("sha256").update(await readFile(path)).digest("hex");
  if (checksum !== manifest.checksum) {
    throw new DesignStorageError("corrupt", `Design Version ${versionId} HTML checksum is invalid`);
  }
  return { manifest, path };
}

export async function resolveDesignVersionFile(
  dataDir: string,
  projectId: string,
  nodeId: string,
  versionId: string,
  requestedFile: string,
): Promise<{ manifest: DesignVersionManifest; path: string }> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    await requireInitialized(root);
    return resolveDesignVersionFileUnlocked(root, nodeId, versionId, requestedFile);
  });
}

export type ResolvedDesignVersionPreview =
  | { kind: "html"; path: string; manifest: DesignVersionManifest }
  | {
      kind: "asset";
      path: string;
      manifest: DesignVersionManifest;
      assetManifest: DesignAssetManifest;
    };

async function resolveDesignVersionPreviewUnlocked(
  root: string,
  nodeId: string,
  versionId: string,
): Promise<ResolvedDesignVersionPreview> {
  const manifest = await getDesignVersionUnlocked(root, nodeId, versionId);
  if (manifest.contentKind === "html") {
    const resolved = await resolveDesignVersionFileUnlocked(root, nodeId, versionId, "index.html");
    return { kind: "html", path: resolved.path, manifest: resolved.manifest };
  }
  const assetId = manifest.assetId;
  if (assetId === null) {
    throw new DesignStorageError("corrupt", `Material Design Version ${versionId} has no Asset`);
  }
  const resolved = await resolveDesignAssetFileUnlocked(
    root,
    assetId,
    (await getDesignAssetManifestUnlocked(root, assetId)).fileName,
  );
  if (resolved.manifest.checksum !== manifest.checksum || resolved.manifest.bytes !== manifest.bytes) {
    throw new DesignStorageError("corrupt", `Material Design Version ${versionId} Asset identity is invalid`);
  }
  return {
    kind: "asset",
    path: resolved.path,
    manifest,
    assetManifest: resolved.manifest,
  };
}

export async function resolveDesignVersionPreview(
  dataDir: string,
  projectId: string,
  nodeId: string,
  versionId: string,
): Promise<ResolvedDesignVersionPreview> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    await requireInitialized(root);
    return resolveDesignVersionPreviewUnlocked(root, nodeId, versionId);
  });
}

export async function resolvePinnedDesignAssetFile(
  dataDir: string,
  projectId: string,
  input: {
    nodeId: string;
    versionId: string;
    assetId: string;
    checksum: string;
    requestedFile: string;
  },
): Promise<{ manifest: DesignAssetManifest; path: string }> {
  if (!SHA256.test(input.checksum)) throw new DesignStorageError("invalid-input", "Asset checksum pin is invalid");
  const version = await getDesignVersion(dataDir, projectId, input.nodeId, input.versionId);
  const pin = version.assetPins.find((candidate) => candidate.assetId === input.assetId);
  if (!pin || pin.checksum !== input.checksum) {
    throw new DesignStorageError("forbidden", "Design Asset is not pinned by the exact Version manifest");
  }
  const resolved = await resolveDesignAssetFile(dataDir, projectId, input.assetId, input.requestedFile);
  if (resolved.manifest.checksum !== input.checksum) {
    throw new DesignStorageError("corrupt", "Design Asset payload diverges from the exact Version pin");
  }
  return resolved;
}

function threadFilePath(root: string, scope: { type: "main" } | { type: "node"; nodeId: string }): string {
  if (scope.type === "main") return join(root, "agents", "main", "thread.json");
  return join(nodeRoot(root, scope.nodeId), "agent", "thread.json");
}

function newThread(
  scope: { type: "main" } | { type: "node"; nodeId: string },
  timestamp: number,
): DesignThread {
  return {
    schemaVersion: DESIGN_SCHEMA_VERSION,
    id: scope.type === "main" ? "thread-main" : `thread-${scope.nodeId}`,
    scope: scope.type === "main" ? { type: "main" } : { type: "node", nodeId: scope.nodeId },
    messages: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function assertStoredThread(
  value: unknown,
  expectedScope: { type: "main" } | { type: "node"; nodeId: string },
): asserts value is DesignThread {
  const expectedId = expectedScope.type === "main" ? "thread-main" : `thread-${expectedScope.nodeId}`;
  const thread = storedRecord(value, "Design Agent thread", [
    "schemaVersion", "id", "scope", "messages", "createdAt", "updatedAt",
  ]);
  const scope = storedRecord(thread.scope, "Design Agent thread scope", expectedScope.type === "main" ? ["type"] : ["type", "nodeId"]);
  const validScope = expectedScope.type === "main"
    ? scope.type === "main"
    : scope.type === "node" && scope.nodeId === expectedScope.nodeId && SAFE_SEGMENT.test(expectedScope.nodeId);
  if (thread.schemaVersion !== DESIGN_SCHEMA_VERSION || thread.id !== expectedId || !validScope
    || !Array.isArray(thread.messages) || thread.messages.length > MAX_THREAD_MESSAGES
    || !validStoredTimestamp(thread.createdAt) || !validStoredTimestamp(thread.updatedAt)) {
    throw new DesignStorageError("corrupt", "Design Agent thread is invalid");
  }
  const messageIds = new Set<string>();
  for (const [index, entry] of thread.messages.entries()) {
    const message = storedRecord(entry, `Design Agent thread message ${index}`, ["id", "role", "content", "jobId", "createdAt"]);
    if (typeof message.id !== "string" || !SAFE_SEGMENT.test(message.id) || messageIds.has(message.id)
      || !["user", "assistant", "system", "tool"].includes(String(message.role))
      || !validStoredText(message.content, MAX_THREAD_CONTENT_BYTES)
      || (message.content as string).trim() !== message.content
      || !validStoredNullableId(message.jobId)
      || !validStoredTimestamp(message.createdAt)) {
      throw new DesignStorageError("corrupt", `Design Agent thread message ${index} is invalid`);
    }
    messageIds.add(message.id);
  }
}

async function readThreadOrNewUnlocked(
  root: string,
  scope: { type: "main" } | { type: "node"; nodeId: string },
  now?: number,
): Promise<DesignThread> {
  if (scope.type === "node") {
    safeSegment(scope.nodeId, "Node id");
    const project = await readProject(root);
    if (!project.nodeOrder.includes(scope.nodeId)) {
      throw new DesignStorageError("not-found", `Design Node ${scope.nodeId} was not found`);
    }
  }
  const path = threadFilePath(root, scope);
  if (!(await exists(path))) return newThread(scope, nowValue(now));
  const thread = await readJson<DesignThread>(path, "Design Agent thread");
  assertStoredThread(thread, scope);
  return thread;
}

async function readOrCreateThreadUnlocked(
  root: string,
  scope: { type: "main" } | { type: "node"; nodeId: string },
  now?: number,
): Promise<DesignThread> {
  const path = threadFilePath(root, scope);
  const existed = await exists(path);
  const thread = await readThreadOrNewUnlocked(root, scope, now);
  if (!existed) await writeAtomicJson(path, thread);
  return thread;
}

export async function getDesignThread(
  dataDir: string,
  projectId: string,
  scope: { type: "main" } | { type: "node"; nodeId: string },
): Promise<DesignThread> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    await requireInitialized(root);
    return readOrCreateThreadUnlocked(root, scope);
  });
}

export async function appendDesignThreadMessage(
  dataDir: string,
  projectId: string,
  scope: { type: "main" } | { type: "node"; nodeId: string },
  input: { role: DesignThreadRole; content: string; jobId?: string | null },
  now?: number,
): Promise<{ thread: DesignThread; message: DesignThreadMessage }> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    await requireInitialized(root);
    const thread = await readOrCreateThreadUnlocked(root, scope, now);
    if (!["user", "assistant", "system", "tool"].includes(input?.role)
      || typeof input?.content !== "string" || !input.content.trim()
      || Buffer.byteLength(input.content, "utf8") > MAX_THREAD_CONTENT_BYTES) {
      throw new DesignStorageError("invalid-input", "Design Agent message is invalid");
    }
    if (thread.messages.length >= MAX_THREAD_MESSAGES) {
      throw new DesignStorageError("limit", "Design Agent thread message limit reached");
    }
    const jobId = input.jobId ?? null;
    if (jobId !== null) safeSegment(jobId, "Job id");
    const timestamp = nowValue(now);
    const message: DesignThreadMessage = {
      id: `message-${randomUUID()}`,
      role: input.role,
      content: input.content.trim(),
      jobId,
      createdAt: timestamp,
    };
    thread.messages.push(message);
    thread.updatedAt = timestamp;
    await writeAtomicJson(threadFilePath(root, scope), thread);
    return { thread, message };
  });
}

export async function updateDesignThreadMessage(
  dataDir: string,
  projectId: string,
  scope: { type: "main" } | { type: "node"; nodeId: string },
  messageId: string,
  input: { content: string; expectedRole?: DesignThreadRole; expectedJobId?: string | null },
  now?: number,
): Promise<{ thread: DesignThread; message: DesignThreadMessage }> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    await requireInitialized(root);
    safeSegment(messageId, "Thread message id");
    if (typeof input?.content !== "string" || !input.content.trim()
      || Buffer.byteLength(input.content, "utf8") > MAX_THREAD_CONTENT_BYTES) {
      throw new DesignStorageError("invalid-input", "Design Agent message is invalid");
    }
    if (input.expectedRole !== undefined && !["user", "assistant", "system", "tool"].includes(input.expectedRole)) {
      throw new DesignStorageError("invalid-input", "Design Agent expected message role is invalid");
    }
    const expectedJobId = input.expectedJobId === undefined ? undefined : input.expectedJobId;
    if (expectedJobId !== undefined && expectedJobId !== null) safeSegment(expectedJobId, "Expected Job id");
    const thread = await readThreadOrNewUnlocked(root, scope, now);
    const index = thread.messages.findIndex((message) => message.id === messageId);
    if (index < 0) throw new DesignStorageError("not-found", `Design Agent message ${messageId} was not found`);
    const current = thread.messages[index]!;
    if ((input.expectedRole !== undefined && current.role !== input.expectedRole)
      || (expectedJobId !== undefined && current.jobId !== expectedJobId)) {
      throw new DesignStorageError("conflict", `Design Agent message ${messageId} no longer matches its reservation`);
    }
    const message = { ...current, content: input.content.trim() };
    thread.messages[index] = message;
    thread.updatedAt = nowValue(now);
    await writeAtomicJson(threadFilePath(root, scope), thread);
    return { thread, message };
  });
}

const MAX_MAIN_PLAN_PAYLOAD_BYTES = 512 * 1024;
export const DESIGN_MAIN_AGENT_QUEUED_MESSAGE =
  "Main Agent orchestration is queued. The final result will replace this status.";

interface StoredDesignMainPlanExecution {
  schemaVersion: typeof DESIGN_SCHEMA_VERSION;
  executionId: string;
  requestHash: string;
  sourceJobId: string;
  planHash: string;
  planPayload: string;
  planningAuthorityHash: string;
  canvasRevision: number;
  runnerId: string;
  model: string | null;
  createdAt: number;
  checksum: string;
}

export interface DesignMainPlanExecution {
  executionId: string;
  sourceJobId: string;
  planHash: string;
  planPayload: string;
  planningAuthorityHash: string;
  canvasRevision: number;
  runnerId: string;
  model: string | null;
  appliedRevision: number | null;
}

function mainPlanExecutionId(receiptKey: string): string {
  return createHash("sha256").update(`dezin-design-main-plan-v1\0${receiptKey}`).digest("hex");
}

function mainPlanExecutionPath(root: string, receiptKey: string): string {
  return join(root, "agents", "main", "executions", `${mainPlanExecutionId(receiptKey)}.json`);
}

function mainPlanExecutionChecksum(value: Omit<StoredDesignMainPlanExecution, "checksum">): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertStoredMainPlanExecution(
  value: unknown,
  expectedExecutionId: string,
): asserts value is StoredDesignMainPlanExecution {
  const record = storedRecord(value, "Design Main Agent plan execution", [
    "schemaVersion", "executionId", "requestHash", "sourceJobId", "planHash", "planPayload",
    "planningAuthorityHash", "canvasRevision", "runnerId", "model", "createdAt", "checksum",
  ]);
  if (record.schemaVersion !== DESIGN_SCHEMA_VERSION || record.executionId !== expectedExecutionId
    || !SHA256.test(String(record.executionId)) || !SHA256.test(String(record.requestHash))
    || typeof record.sourceJobId !== "string" || !SAFE_SEGMENT.test(record.sourceJobId)
    || !SHA256.test(String(record.planHash)) || typeof record.planPayload !== "string"
    || !record.planPayload.trim() || Buffer.byteLength(record.planPayload, "utf8") > MAX_MAIN_PLAN_PAYLOAD_BYTES
    || createHash("sha256").update(record.planPayload).digest("hex") !== record.planHash
    || !SHA256.test(String(record.planningAuthorityHash))
    || !Number.isSafeInteger(record.canvasRevision) || (record.canvasRevision as number) < 0
    || !validStoredText(record.runnerId, 512) || (record.runnerId as string).trim() !== record.runnerId
    || !validStoredText(record.model, 512, { nullable: true })
    || (typeof record.model === "string" && record.model.trim() !== record.model)
    || !validStoredTimestamp(record.createdAt) || !SHA256.test(String(record.checksum))) {
    throw new DesignStorageError("corrupt", "Design Main Agent plan execution is invalid");
  }
  const { checksum, ...content } = record as unknown as StoredDesignMainPlanExecution;
  if (mainPlanExecutionChecksum(content) !== checksum) {
    throw new DesignStorageError("corrupt", "Design Main Agent plan execution checksum is invalid");
  }
}

async function readDesignMainPlanExecutionUnlocked(
  root: string,
  project: DesignProjectFile,
  receiptKey: string,
): Promise<DesignMainPlanExecution | null> {
  const receipt = project.turnReceipts[receiptKey];
  if (!receipt || receipt.kind !== "main-agent" || receipt.nodeId !== null || !SHA256.test(receipt.requestHash ?? "")) {
    throw new DesignStorageError("conflict", "Main Agent plan execution is not bound to this idempotent request");
  }
  const executionId = mainPlanExecutionId(receiptKey);
  const path = mainPlanExecutionPath(root, receiptKey);
  if (!(await exists(path))) {
    if (receipt.mainPlanHash !== undefined) {
      throw new DesignStorageError("corrupt", "Design Main Agent plan receipt is missing its immutable payload");
    }
    return null;
  }
  const stored = await readJson<StoredDesignMainPlanExecution>(path, "Design Main Agent plan execution");
  assertStoredMainPlanExecution(stored, executionId);
  if (stored.requestHash !== receipt.requestHash) {
    throw new DesignStorageError("corrupt", "Design Main Agent plan no longer matches its request authority");
  }
  if (receipt.mainPlanHash === undefined) {
    // The immutable payload is written before the Project receipt. Reconcile
    // the only safe partial state after an exit between those two writes.
    receipt.mainPlanHash = stored.planHash;
    await writeAtomicJson(projectFilePath(root), project);
  } else if (receipt.mainPlanHash !== stored.planHash) {
    throw new DesignStorageError("corrupt", "Design Main Agent plan receipt checksum diverges");
  }
  const sourceJob = await readJob(root, stored.sourceJobId);
  if (sourceJob.kind !== "main-agent" || sourceJob.contextHash === null
    || sourceJob.canvasRevision !== stored.canvasRevision
    || sourceJob.runnerId !== stored.runnerId || sourceJob.model !== stored.model) {
    throw new DesignStorageError("corrupt", "Design Main Agent plan source Job authority diverges");
  }
  return {
    executionId,
    sourceJobId: stored.sourceJobId,
    planHash: stored.planHash,
    planPayload: stored.planPayload,
    planningAuthorityHash: stored.planningAuthorityHash,
    canvasRevision: stored.canvasRevision,
    runnerId: stored.runnerId,
    model: stored.model,
    appliedRevision: receipt.mainPlanAppliedRevision ?? null,
  };
}

export async function getDesignMainPlanExecution(
  dataDir: string,
  projectId: string,
  receiptKey: string,
): Promise<DesignMainPlanExecution | null> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    await requireInitialized(root);
    if (typeof receiptKey !== "string" || !receiptKey || receiptKey.length > 512) {
      throw new DesignStorageError("invalid-input", "Main Agent receipt key is invalid");
    }
    const project = await readProject(root);
    return readDesignMainPlanExecutionUnlocked(root, project, receiptKey);
  });
}

export async function reserveDesignMainPlanExecution(
  dataDir: string,
  projectId: string,
  input: {
    jobId: string;
    receiptKey: string;
    planPayload: string;
    planningAuthorityHash: string;
    canvasRevision: number;
  },
  now?: number,
): Promise<DesignMainPlanExecution> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    await requireInitialized(root);
    const jobId = safeSegment(input.jobId, "Job id");
    if (typeof input.receiptKey !== "string" || !input.receiptKey || input.receiptKey.length > 512
      || typeof input.planPayload !== "string" || !input.planPayload.trim()
      || Buffer.byteLength(input.planPayload, "utf8") > MAX_MAIN_PLAN_PAYLOAD_BYTES
      || !SHA256.test(input.planningAuthorityHash)
      || !Number.isSafeInteger(input.canvasRevision) || input.canvasRevision < 0) {
      throw new DesignStorageError("invalid-input", "Main Agent plan execution input is invalid");
    }
    const project = await readProject(root);
    const receipt = project.turnReceipts[input.receiptKey];
    const job = await readJob(root, jobId);
    if (!receipt || receipt.kind !== "main-agent" || receipt.nodeId !== null || receipt.jobId !== job.id
      || receipt.authorityHash !== job.contextHash || !SHA256.test(receipt.requestHash ?? "")
      || job.kind !== "main-agent" || job.status !== "running" || job.contextHash === null
      || job.canvasRevision !== input.canvasRevision) {
      throw new DesignStorageError("conflict", "Main Agent plan requires the active idempotent Job authority");
    }
    const planHash = createHash("sha256").update(input.planPayload).digest("hex");
    const existing = await readDesignMainPlanExecutionUnlocked(root, project, input.receiptKey);
    if (existing !== null) {
      if (existing.planHash !== planHash || existing.planPayload !== input.planPayload
        || existing.planningAuthorityHash !== input.planningAuthorityHash) {
        throw new DesignStorageError("conflict", "Main Agent idempotent request already has a different immutable plan");
      }
      return existing;
    }
    const executionId = mainPlanExecutionId(input.receiptKey);
    const content: Omit<StoredDesignMainPlanExecution, "checksum"> = {
      schemaVersion: DESIGN_SCHEMA_VERSION,
      executionId,
      requestHash: receipt.requestHash!,
      sourceJobId: job.id,
      planHash,
      planPayload: input.planPayload,
      planningAuthorityHash: input.planningAuthorityHash,
      canvasRevision: input.canvasRevision,
      runnerId: job.runnerId,
      model: job.model,
      createdAt: nowValue(now),
    };
    await writeAtomicJson(mainPlanExecutionPath(root, input.receiptKey), {
      ...content,
      checksum: mainPlanExecutionChecksum(content),
    });
    receipt.mainPlanHash = planHash;
    await writeAtomicJson(projectFilePath(root), project);
    return {
      executionId,
      sourceJobId: job.id,
      planHash,
      planPayload: input.planPayload,
      planningAuthorityHash: input.planningAuthorityHash,
      canvasRevision: input.canvasRevision,
      runnerId: job.runnerId,
      model: job.model,
      appliedRevision: null,
    };
  });
}

function assertStoredJob(value: unknown, expectedId: string): asserts value is DesignJob {
  const job = storedRecord(value, `Design Job ${expectedId}`, [
    "schemaVersion", "id", "kind", "runnerId", "model", "status", "nodeId", "parentJobId", "contextHash", "canvasRevision",
    "expectedHeadVersionId", "versionId", "exportId", "error", "cancelRequested", "activity", "createdAt",
    "updatedAt", "finishedAt",
  ]);
  const kinds = ["node-generation", "node-analysis", "main-agent", "implementation-export"];
  const statuses = ["queued", "running", "validating", "ready", "failed", "cancelled", "superseded"];
  const kind = String(job.kind);
  const status = String(job.status);
  const terminal = ["ready", "failed", "cancelled", "superseded"].includes(status);
  const nodeScoped = kind === "node-generation" || kind === "node-analysis";
  if (job.schemaVersion !== DESIGN_SCHEMA_VERSION || job.id !== expectedId || !SAFE_SEGMENT.test(expectedId)
    || !kinds.includes(kind) || !statuses.includes(status)
    || !validStoredText(job.runnerId, 512) || (job.runnerId as string).trim() !== job.runnerId
    || !validStoredText(job.model, 512, { nullable: true })
    || (typeof job.model === "string" && job.model.trim() !== job.model)
    || !validStoredNullableId(job.nodeId) || (nodeScoped !== (job.nodeId !== null))
    || !validStoredNullableId(job.parentJobId)
    || !(job.contextHash === null || (typeof job.contextHash === "string" && SHA256.test(job.contextHash)))
    || !(job.canvasRevision === null || (Number.isSafeInteger(job.canvasRevision) && (job.canvasRevision as number) >= 0))
    || !validStoredNullableId(job.expectedHeadVersionId)
    || (kind !== "node-generation" && job.expectedHeadVersionId !== null)
    || !validStoredNullableId(job.versionId) || (kind !== "node-generation" && job.versionId !== null)
    || !validStoredNullableId(job.exportId) || (kind !== "implementation-export" && job.exportId !== null)
    || !validStoredText(job.error, 16_384, { nullable: true, empty: true })
    || typeof job.cancelRequested !== "boolean"
    || !Array.isArray(job.activity) || job.activity.length > MAX_JOB_ACTIVITY
    || !validStoredTimestamp(job.createdAt) || !validStoredTimestamp(job.updatedAt)
    || !(job.finishedAt === null || validStoredTimestamp(job.finishedAt))
    || (terminal !== (job.finishedAt !== null))) {
    throw new DesignStorageError("corrupt", `Design Job ${expectedId} is invalid`);
  }
  const activityIds = new Set<string>();
  for (const [index, entry] of job.activity.entries()) {
    const activity = storedRecord(entry, `Design Job ${expectedId} activity ${index}`, ["id", "kind", "text", "createdAt"]);
    if (typeof activity.id !== "string" || !SAFE_SEGMENT.test(activity.id) || activityIds.has(activity.id)
      || !["text", "tool", "status"].includes(String(activity.kind))
      || !validStoredText(activity.text, 16_384) || (activity.text as string).trim() !== activity.text
      || !validStoredTimestamp(activity.createdAt)) {
      throw new DesignStorageError("corrupt", `Design Job ${expectedId} activity ${index} is invalid`);
    }
    activityIds.add(activity.id);
  }
}

async function readJob(root: string, jobId: string): Promise<DesignJob> {
  const job = await readJson<DesignJob>(jobFilePath(root, jobId), `Design Job ${jobId}`);
  assertStoredJob(job, jobId);
  return job;
}

function jobContextFilePath(root: string, jobId: string): string {
  return join(root, "jobs", `${safeSegment(jobId, "Job id")}.context.json`);
}

async function buildFrozenContextUnlocked(
  root: string,
  dataDir: string,
  projectId: string,
  project: DesignProjectFile,
  targetNodeId: string | null,
): Promise<DesignFrozenContext> {
  if (targetNodeId !== null && !project.nodeOrder.includes(safeSegment(targetNodeId, "Node id"))) {
    throw new DesignStorageError("not-found", `Design Node ${targetNodeId} was not found`);
  }
  const nodes = readNodes(project);
  const summaries: DesignFrozenContext["nodes"] = [];
  for (const id of project.nodeOrder) {
    const node = nodes.get(id)!;
    const selectedVersionId = node.selectedVersionId ?? node.currentVersionId;
    const selectedVersion = selectedVersionId === null
      ? null
      : await getDesignVersionUnlocked(root, node.id, selectedVersionId);
    const asset = node.assetId === null ? null : await getDesignAssetManifest(dataDir, projectId, node.assetId);
    const selectedVersionAssetPins: DesignFrozenAssetPin[] = [];
    let selectedVersionPath: string | null = null;
    if (selectedVersion?.contentKind === "html") {
      selectedVersionPath = `nodes/${node.id}/versions/${selectedVersion.id}/index.html`;
    } else if (selectedVersion?.contentKind === "asset") {
      if (selectedVersion.assetId === null) {
        throw new DesignStorageError("corrupt", `Material Design Version ${selectedVersion.id} has no Asset`);
      }
      const selectedAsset = await getDesignAssetManifest(dataDir, projectId, selectedVersion.assetId);
      if (selectedAsset.checksum !== selectedVersion.checksum || selectedAsset.bytes !== selectedVersion.bytes) {
        throw new DesignStorageError("corrupt", `Material Design Version ${selectedVersion.id} Asset diverged from its manifest`);
      }
      const selectedPin = frozenAssetPin(selectedAsset);
      selectedVersionAssetPins.push(selectedPin);
      selectedVersionPath = selectedPin.path;
    }
    for (const pin of selectedVersion?.assetPins ?? []) {
      const pinnedAsset = await getDesignAssetManifest(dataDir, projectId, pin.assetId);
      if (pinnedAsset.checksum !== pin.checksum) {
        throw new DesignStorageError("corrupt", `Design Version ${selectedVersion?.id} Asset pin diverged from its manifest`);
      }
      selectedVersionAssetPins.push(frozenAssetPin(pinnedAsset));
    }
    summaries.push({
      id: node.id,
      kind: node.kind,
      name: node.name,
      state: node.state,
      geometry: { ...node.geometry },
      selectedVersionId,
      selectedVersionContentKind: selectedVersion?.contentKind ?? null,
      selectedVersionChecksum: selectedVersion?.checksum ?? null,
      selectedVersionBytes: selectedVersion?.bytes ?? null,
      selectedVersionPath,
      selectedVersionJobId: selectedVersion?.jobId ?? null,
      selectedVersionRunnerId: selectedVersion?.runnerId ?? null,
      selectedVersionModel: selectedVersion?.model ?? null,
      selectedVersionAssetPins,
      assetId: asset?.id ?? null,
      assetChecksum: asset?.checksum ?? null,
      assetBytes: asset?.bytes ?? null,
      assetPath: asset === null ? null : `.context/assets/${asset.id}/${asset.fileName}`,
      assetBundleFiles: asset === null ? [] : frozenAssetPin(asset).bundleFiles,
    });
  }
  const content = {
    schemaVersion: DESIGN_SCHEMA_VERSION,
    projectId,
    canvasRevision: project.revision,
    targetNodeId,
    viewport: { ...project.viewport },
    nodes: summaries,
  };
  assertDesignFrozenContextBudget(content);
  const checksum = createHash("sha256").update(JSON.stringify(content)).digest("hex");
  return { ...content, checksum };
}

function frozenAssetPin(manifest: DesignAssetManifest): DesignFrozenAssetPin {
  const root = `.context/assets/${manifest.id}`;
  return {
    assetId: manifest.id,
    checksum: manifest.checksum,
    bytes: manifest.bytes,
    fileName: manifest.fileName,
    path: `${root}/${manifest.fileName}`,
    bundleFiles: manifest.bundleFiles.map((file) => ({
      ...file,
      path: `${root}/${file.path}`,
    })),
  };
}

export function assertDesignFrozenContextBudget(
  context: Omit<DesignFrozenContext, "checksum"> | DesignFrozenContext,
  limits: { maxPayloads?: number; maxBytes?: number } = {},
): void {
  const maxPayloads = limits.maxPayloads ?? MAX_DESIGN_CONTEXT_PAYLOADS;
  const maxBytes = limits.maxBytes ?? MAX_DESIGN_CONTEXT_BYTES;
  let payloads = 0;
  let bytes = 0;
  const identities = new Set<string>();
  const addPayload = (identity: string, size: unknown, label: string): void => {
    if (!Number.isSafeInteger(size) || (size as number) < 1) {
      throw new DesignStorageError("corrupt", `Frozen Design context contains an invalid ${label} size`);
    }
    if (!identities.has(identity)) {
      identities.add(identity);
      payloads += 1;
      bytes += size as number;
    }
    if (!Number.isSafeInteger(bytes) || payloads > maxPayloads || bytes > maxBytes) {
      throw new DesignStorageError(
        "limit",
        `Frozen Design context exceeds the bounded payload budget (${maxPayloads} files / ${maxBytes} bytes)`,
      );
    }
  };
  for (const node of context.nodes) {
    if (node.selectedVersionBytes !== null) {
      const identity = `version:${node.id}:${node.selectedVersionId}:${node.selectedVersionChecksum}`;
      addPayload(identity, node.selectedVersionBytes, "Version");
    }
    if (!Array.isArray(node.selectedVersionAssetPins) || node.selectedVersionAssetPins.length > MAX_ASSET_BUNDLE_FILES) {
      throw new DesignStorageError("corrupt", "Frozen Design context contains invalid Version Asset pins");
    }
    for (const pin of node.selectedVersionAssetPins) {
      if (!/^asset-[a-f0-9]{32}$/.test(pin.assetId) || !SHA256.test(pin.checksum)
        || typeof pin.fileName !== "string" || pin.path !== `.context/assets/${pin.assetId}/${pin.fileName}`) {
        throw new DesignStorageError("corrupt", "Frozen Design context contains an invalid Version Asset pin");
      }
      addPayload(`asset:${pin.assetId}:${pin.checksum}`, pin.bytes, "Version Asset");
      for (const file of pin.bundleFiles) {
        if (!SHA256.test(file.checksum) || !file.path.startsWith(`.context/assets/${pin.assetId}/`)) {
          throw new DesignStorageError("corrupt", "Frozen Design context contains an invalid Version Asset bundle");
        }
        addPayload(`asset-bundle:${pin.assetId}:${file.path}:${file.checksum}`, file.bytes, "Version Asset bundle");
      }
    }
    if (node.assetBytes !== null) {
      const identity = `asset:${node.assetId}:${node.assetChecksum}`;
      addPayload(identity, node.assetBytes, "Asset");
      if (!Array.isArray(node.assetBundleFiles) || node.assetBundleFiles.length > MAX_ASSET_BUNDLE_FILES) {
        throw new DesignStorageError("corrupt", "Frozen Design context contains an invalid Asset bundle");
      }
      for (const file of node.assetBundleFiles) {
        if (!SHA256.test(file.checksum) || !file.path.startsWith(`.context/assets/${node.assetId}/`)) {
          throw new DesignStorageError("corrupt", "Frozen Design context contains an invalid Asset bundle file");
        }
        addPayload(`asset-bundle:${node.assetId}:${file.path}:${file.checksum}`, file.bytes, "Asset bundle");
      }
    } else if (node.assetBundleFiles.length !== 0) {
      throw new DesignStorageError("corrupt", "Frozen Design context contains an unowned Asset bundle");
    }
  }
}

export interface CreateDesignJobInput {
  kind: DesignJobKind;
  runnerId: string;
  model: string | null;
  nodeId?: string | null;
  parentJobId?: string | null;
  expectedCanvasRevision?: number;
  idempotencyKey?: string | null;
  /** SHA-256 of the normalized system prompt and user message, supplied by the turn caller. */
  promptHash?: string | null;
  /** Ordered priority context whose semantics affect the turn. */
  contextNodeIds?: readonly string[];
  /** Reserve both Main Agent messages under the same Project lock as Job creation. */
  reserveMainThreadTurn?: { userContent: string; assistantContent: string };
}

export interface CreatedDesignJob {
  job: DesignJob;
  reused: boolean;
  canvas: DesignCanvas;
  receiptKey: string | null;
  mainThreadReservation: { thread: DesignThread; assistantMessageId: string } | null;
}

function normalizedDesignJobRequestHash(input: {
  kind: DesignJobKind;
  runnerId: string;
  model: string | null;
  nodeId: string | null;
  parentJobId: string | null;
  expectedCanvasRevision: number | null;
  promptHash: string;
  contextNodeIds: readonly string[];
}): string {
  return createHash("sha256").update(stableStringify({
    protocol: "dezin-design-turn-request-v1",
    ...input,
  })).digest("hex");
}

function assertThreadTurnContent(content: unknown): asserts content is string {
  if (typeof content !== "string" || !content.trim()
    || Buffer.byteLength(content, "utf8") > MAX_THREAD_CONTENT_BYTES) {
    throw new DesignStorageError("invalid-input", "Design Agent message is invalid");
  }
}

export async function createDesignJob(
  dataDir: string,
  projectId: string,
  input: CreateDesignJobInput,
  now?: number,
): Promise<CreatedDesignJob> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    await requireInitialized(root);
    if (!["node-generation", "node-analysis", "main-agent", "implementation-export"].includes(input?.kind)) {
      throw new DesignStorageError("invalid-input", "Design Job kind is unsupported");
    }
    if (!validStoredText(input.runnerId, 512) || input.runnerId.trim() !== input.runnerId
      || !validStoredText(input.model, 512, { nullable: true })
      || (typeof input.model === "string" && input.model.trim() !== input.model)) {
      throw new DesignStorageError("invalid-input", "Design Job runner identity is invalid");
    }
    const nodeId = input.nodeId ?? null;
    if (nodeId !== null) safeSegment(nodeId, "Node id");
    const parentJobId = input.parentJobId ?? null;
    if (parentJobId !== null) safeSegment(parentJobId, "Parent Job id");
    const rawIdempotencyKey = input.idempotencyKey ?? null;
    if (rawIdempotencyKey !== null && (typeof rawIdempotencyKey !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(rawIdempotencyKey))) {
      throw new DesignStorageError("invalid-input", "idempotencyKey is invalid");
    }
    const promptHash = input.promptHash ?? null;
    if (rawIdempotencyKey !== null && (typeof promptHash !== "string" || !SHA256.test(promptHash))) {
      throw new DesignStorageError("invalid-input", "Idempotent Design Agent turns require an exact prompt hash");
    }
    if (promptHash !== null && (typeof promptHash !== "string" || !SHA256.test(promptHash))) {
      throw new DesignStorageError("invalid-input", "Design Agent prompt hash is invalid");
    }
    if (input.contextNodeIds !== undefined && (!Array.isArray(input.contextNodeIds)
      || input.contextNodeIds.length > 100)) {
      throw new DesignStorageError("invalid-input", "Design Agent priority context is invalid");
    }
    const contextNodeIds = Array.from(new Set((input.contextNodeIds ?? []).map((id) =>
      safeSegment(id, "Context Node id"))));
    if (input.reserveMainThreadTurn !== undefined) {
      if (input.kind !== "main-agent") {
        throw new DesignStorageError("invalid-input", "Only Main Agent Jobs may reserve a Main Agent turn");
      }
      assertThreadTurnContent(input.reserveMainThreadTurn.userContent);
      assertThreadTurnContent(input.reserveMainThreadTurn.assistantContent);
    }
    const requestHash = normalizedDesignJobRequestHash({
      kind: input.kind,
      runnerId: input.runnerId,
      model: input.model,
      nodeId,
      parentJobId,
      expectedCanvasRevision: input.expectedCanvasRevision ?? null,
      promptHash: promptHash ?? createHash("sha256").update("").digest("hex"),
      contextNodeIds,
    });
    const project = await readProject(root);
    const nodes = readNodes(project);
    const receiptKey = rawIdempotencyKey === null
      ? null
      : `${input.kind}:${nodeId ?? "main"}:${rawIdempotencyKey}`;
    const priorReceipt = receiptKey === null ? undefined : project.turnReceipts[receiptKey];
    if (priorReceipt) {
      if (priorReceipt.kind !== input.kind || priorReceipt.nodeId !== nodeId) {
        throw new DesignStorageError("conflict", "idempotencyKey is already bound to another Design Agent scope");
      }
      if (priorReceipt.requestHash !== requestHash) {
        throw new DesignStorageError("conflict", "idempotencyKey is already bound to a different Design Agent request");
      }
      const priorJob = await readJob(root, priorReceipt.jobId);
      if (priorReceipt.authorityHash !== priorJob.contextHash) {
        throw new DesignStorageError("corrupt", "Design Agent receipt authority no longer matches its frozen Job context");
      }
      const committedMainPlan = priorJob.kind === "main-agent"
        && priorReceipt.mainPlanAppliedRevision !== undefined;
      if ((priorJob.status !== "failed" && priorJob.status !== "cancelled") || committedMainPlan) {
        return {
          job: priorJob,
          reused: true,
          canvas: canvas(project, nodes),
          receiptKey,
          mainThreadReservation: null,
        };
      }
    }
    const unavailableContextId = contextNodeIds.find((id) => !nodes.has(id));
    if (unavailableContextId !== undefined) {
      throw new DesignStorageError(
        "invalid-input",
        `Design Agent priority context references unavailable Node ${unavailableContextId}`,
      );
    }
    if (input.expectedCanvasRevision !== undefined && input.expectedCanvasRevision !== project.revision) {
      throw new DesignRevisionConflictError(input.expectedCanvasRevision, project.revision);
    }
    if (receiptKey !== null && priorReceipt === undefined && Object.keys(project.turnReceipts).length >= 5_000) {
      throw new DesignStorageError("limit", "Design Agent idempotency receipt limit reached");
    }
    let node: DesignNode | undefined;
    if (input.kind === "node-generation" || input.kind === "node-analysis") {
      if (nodeId === null) throw new DesignStorageError("invalid-input", "Scoped Node Job requires a Node");
      node = nodes.get(safeSegment(nodeId, "Node id"));
      if (!node) throw new DesignStorageError("not-found", `Design Node ${nodeId} was not found`);
      const generative = (DESIGN_GENERATIVE_NODE_KINDS as readonly string[]).includes(node.kind);
      if (input.kind === "node-generation" && !generative) {
        throw new DesignStorageError("invalid-input", "Material Nodes cannot run generation Jobs");
      }
      if (input.kind === "node-analysis" && generative) {
        throw new DesignStorageError("invalid-input", "Generative Nodes use generation Jobs");
      }
      if (node.activeJobId !== null) {
        throw new DesignStorageError("conflict", `Design Node ${nodeId} already has an active Job`);
      }
    } else if (nodeId !== null) {
      throw new DesignStorageError("invalid-input", "Only Node generation Jobs may bind a Node");
    }
    const timestamp = nowValue(now);
    let mainThread: DesignThread | null = null;
    if (input.reserveMainThreadTurn !== undefined) {
      mainThread = await readThreadOrNewUnlocked(root, { type: "main" }, timestamp);
      if (mainThread.messages.length + 2 > MAX_THREAD_MESSAGES) {
        throw new DesignStorageError("limit", "Design Agent thread does not have capacity for a complete turn");
      }
    }
    const jobId = `job-${randomUUID()}`;
    const frozenCanvas = canvas(project, nodes);
    const frozenContext = await buildFrozenContextUnlocked(root, dataDir, projectId, project, nodeId);
    const job: DesignJob = {
      schemaVersion: DESIGN_SCHEMA_VERSION,
      id: jobId,
      kind: input.kind,
      runnerId: input.runnerId,
      model: input.model,
      status: "queued",
      nodeId,
      parentJobId,
      contextHash: frozenContext.checksum,
      canvasRevision: project.revision,
      expectedHeadVersionId: input.kind === "node-generation" ? (node?.currentVersionId ?? null) : null,
      versionId: null,
      exportId: null,
      error: null,
      cancelRequested: false,
      activity: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      finishedAt: null,
    };
    let reservedAssistantMessage: DesignThreadMessage | null = null;
    if (mainThread !== null && input.reserveMainThreadTurn !== undefined) {
      const userMessage: DesignThreadMessage = {
        id: `message-${randomUUID()}`,
        role: "user",
        content: input.reserveMainThreadTurn.userContent.trim(),
        jobId: job.id,
        createdAt: timestamp,
      };
      reservedAssistantMessage = {
        id: `message-${randomUUID()}`,
        role: "assistant",
        content: input.reserveMainThreadTurn.assistantContent.trim(),
        jobId: job.id,
        createdAt: timestamp,
      };
      mainThread.messages.push(userMessage, reservedAssistantMessage);
      mainThread.updatedAt = timestamp;
    }
    await writeAtomicJson(jobContextFilePath(root, job.id), frozenContext);
    await writeAtomicJson(jobFilePath(root, job.id), job);
    if (mainThread !== null) await writeAtomicJson(threadFilePath(root, { type: "main" }), mainThread);
    if (receiptKey !== null) {
      project.turnReceipts[receiptKey] = {
        jobId: job.id,
        kind: job.kind,
        nodeId,
        requestHash,
        authorityHash: frozenContext.checksum,
        ...(priorReceipt?.mainPlanHash === undefined ? {} : { mainPlanHash: priorReceipt.mainPlanHash }),
        ...(priorReceipt?.mainPlanAppliedRevision === undefined
          ? {}
          : { mainPlanAppliedRevision: priorReceipt.mainPlanAppliedRevision }),
        createdAt: timestamp,
      };
    }
    if (node) {
      node.state = "queued";
      node.activeJobId = job.id;
      node.error = null;
      node.updatedAt = timestamp;
      project.nodes = project.nodeOrder.map((id) => cloneNode(nodes.get(id)!));
      project.revision += 1;
      project.updatedAt = Math.max(project.updatedAt, timestamp);
      await writeAtomicJson(projectFilePath(root), project);
    } else if (receiptKey !== null) {
      await writeAtomicJson(projectFilePath(root), project);
    }
    return {
      job,
      reused: false,
      canvas: frozenCanvas,
      receiptKey,
      mainThreadReservation: mainThread === null || reservedAssistantMessage === null
        ? null
        : { thread: mainThread, assistantMessageId: reservedAssistantMessage.id },
    };
  });
}

export async function getDesignJobContext(
  dataDir: string,
  projectId: string,
  jobId: string,
): Promise<DesignFrozenContext> {
  const root = designRoot(dataDir, projectId);
  const context = await readJson<DesignFrozenContext>(jobContextFilePath(root, jobId), `Design Job ${jobId} Context`);
  const record = storedRecord(context, `Design Job ${jobId} Context`, [
    "schemaVersion", "projectId", "canvasRevision", "targetNodeId", "checksum", "viewport", "nodes",
  ]);
  const { checksum, ...content } = record;
  const actual = createHash("sha256").update(JSON.stringify(content)).digest("hex");
  if (typeof checksum !== "string" || !SHA256.test(checksum) || checksum !== actual) {
    throw new DesignStorageError("corrupt", `Design Job ${jobId} Context checksum is invalid`);
  }
  assertStoredFrozenContext(context, projectId);
  return context;
}

function assertStoredFrozenContext(value: unknown, expectedProjectId: string): asserts value is DesignFrozenContext {
  const context = storedRecord(value, "Frozen Design context", [
    "schemaVersion", "projectId", "canvasRevision", "targetNodeId", "checksum", "viewport", "nodes",
  ]);
  const viewportRecord = storedRecord(context.viewport, "Frozen Design context viewport", ["x", "y", "zoom"]);
  if (context.schemaVersion !== DESIGN_SCHEMA_VERSION || context.projectId !== expectedProjectId
    || !Number.isSafeInteger(context.canvasRevision) || (context.canvasRevision as number) < 0
    || !validStoredNullableId(context.targetNodeId) || !SHA256.test(String(context.checksum))
    || !validStoredViewport(viewportRecord)
    || !Array.isArray(context.nodes) || context.nodes.length > 500) {
    throw new DesignStorageError("corrupt", "Frozen Design context is invalid");
  }
  const nodeIds = new Set<string>();
  for (const [nodeIndex, entry] of context.nodes.entries()) {
    const node = storedRecord(entry, `Frozen Design context Node ${nodeIndex}`, [
      "id", "kind", "name", "state", "geometry", "selectedVersionId", "selectedVersionContentKind",
      "selectedVersionChecksum", "selectedVersionBytes", "selectedVersionPath", "selectedVersionJobId", "selectedVersionRunnerId",
      "selectedVersionModel", "selectedVersionAssetPins", "assetId", "assetChecksum", "assetBytes", "assetPath",
      "assetBundleFiles",
    ]);
    const geometryRecord = storedRecord(node.geometry, `Frozen Design context Node ${nodeIndex} geometry`, ["x", "y", "width", "height"]);
    const validGeometry = [geometryRecord.x, geometryRecord.y, geometryRecord.width, geometryRecord.height]
      .every((part) => typeof part === "number" && Number.isFinite(part))
      && (geometryRecord.width as number) >= 120 && (geometryRecord.width as number) <= 4_096
      && (geometryRecord.height as number) >= 80 && (geometryRecord.height as number) <= 4_096;
    const selectedAbsent = node.selectedVersionId === null && node.selectedVersionContentKind === null
      && node.selectedVersionChecksum === null && node.selectedVersionBytes === null && node.selectedVersionPath === null
      && node.selectedVersionJobId === null && node.selectedVersionRunnerId === null
      && node.selectedVersionModel === null;
    const selectedContentKind = node.selectedVersionContentKind;
    const selectedPathValid = selectedContentKind === "html"
      ? node.selectedVersionPath === `nodes/${String(node.id)}/versions/${String(node.selectedVersionId)}/index.html`
      : selectedContentKind === "asset"
        ? typeof node.selectedVersionPath === "string" && /^\.context\/assets\/asset-[a-f0-9]{32}\/[A-Za-z0-9._-]+$/.test(node.selectedVersionPath)
        : false;
    const selectedPresent = typeof node.selectedVersionId === "string" && SAFE_SEGMENT.test(node.selectedVersionId)
      && (selectedContentKind === "html" || selectedContentKind === "asset")
      && typeof node.selectedVersionChecksum === "string" && SHA256.test(node.selectedVersionChecksum)
      && Number.isSafeInteger(node.selectedVersionBytes) && (node.selectedVersionBytes as number) >= 1
      && selectedPathValid
      && validStoredNullableId(node.selectedVersionJobId)
      && validStoredText(node.selectedVersionRunnerId, 512, { nullable: true })
      && (typeof node.selectedVersionRunnerId !== "string"
        || node.selectedVersionRunnerId.trim() === node.selectedVersionRunnerId)
      && validStoredText(node.selectedVersionModel, 512, { nullable: true })
      && (typeof node.selectedVersionModel !== "string" || node.selectedVersionModel.trim() === node.selectedVersionModel)
      && !(node.selectedVersionJobId !== null && node.selectedVersionRunnerId === null)
      && !(node.selectedVersionRunnerId === null && node.selectedVersionModel !== null);
    const assetAbsent = node.assetId === null && node.assetChecksum === null
      && node.assetBytes === null && node.assetPath === null;
    const assetPresent = typeof node.assetId === "string" && /^asset-[a-f0-9]{32}$/.test(node.assetId)
      && typeof node.assetChecksum === "string" && SHA256.test(node.assetChecksum)
      && Number.isSafeInteger(node.assetBytes) && (node.assetBytes as number) >= 1
      && typeof node.assetPath === "string" && node.assetPath.startsWith(`.context/assets/${node.assetId}/`);
    if (typeof node.id !== "string" || !SAFE_SEGMENT.test(node.id) || nodeIds.has(node.id)
      || typeof node.kind !== "string" || !(DESIGN_NODE_KINDS as readonly string[]).includes(node.kind)
      || !validStoredText(node.name, 256)
      || typeof node.state !== "string" || !["empty", "queued", "generating", "validating", "ready", "failed", "cancelled", "superseded"].includes(node.state)
      || !validGeometry || (!selectedAbsent && !selectedPresent) || (!assetAbsent && !assetPresent)
      || !Array.isArray(node.selectedVersionAssetPins) || node.selectedVersionAssetPins.length > MAX_ASSET_BUNDLE_FILES
      || !Array.isArray(node.assetBundleFiles) || node.assetBundleFiles.length > MAX_ASSET_BUNDLE_FILES) {
      throw new DesignStorageError("corrupt", `Frozen Design context Node ${nodeIndex} is invalid`);
    }
    nodeIds.add(node.id);
    const validateFrozenAsset = (pinValue: unknown, label: string): void => {
      const pin = storedRecord(pinValue, label, ["assetId", "checksum", "bytes", "fileName", "path", "bundleFiles"]);
      const prefix = `.context/assets/${String(pin.assetId)}/`;
      if (typeof pin.assetId !== "string" || !/^asset-[a-f0-9]{32}$/.test(pin.assetId)
        || !SHA256.test(String(pin.checksum)) || !Number.isSafeInteger(pin.bytes) || (pin.bytes as number) < 1
        || typeof pin.fileName !== "string" || !SAFE_SEGMENT.test(pin.fileName)
        || pin.path !== `${prefix}${pin.fileName}` || !Array.isArray(pin.bundleFiles)
        || pin.bundleFiles.length > MAX_ASSET_BUNDLE_FILES) {
        throw new DesignStorageError("corrupt", `${label} is invalid`);
      }
      const bundlePaths = new Set<string>();
      for (const [bundleIndex, bundleValue] of pin.bundleFiles.entries()) {
        const bundle = storedRecord(bundleValue, `${label} bundle ${bundleIndex}`, ["path", "checksum", "bytes"]);
        if (typeof bundle.path !== "string" || !bundle.path.startsWith(prefix)
          || bundlePaths.has(bundle.path) || !SHA256.test(String(bundle.checksum))
          || !Number.isSafeInteger(bundle.bytes) || (bundle.bytes as number) < 1) {
          throw new DesignStorageError("corrupt", `${label} bundle ${bundleIndex} is invalid`);
        }
        safeBundlePath(bundle.path.slice(prefix.length), `${label} bundle ${bundleIndex} path`);
        bundlePaths.add(bundle.path);
      }
    };
    const selectedPinIds = new Set<string>();
    for (const [pinIndex, pin] of node.selectedVersionAssetPins.entries()) {
      validateFrozenAsset(pin, `Frozen Design context Node ${nodeIndex} Version pin ${pinIndex}`);
      const assetId = (pin as { assetId: string }).assetId;
      if (selectedPinIds.has(assetId)) throw new DesignStorageError("corrupt", "Frozen Design context repeats a Version Asset pin");
      selectedPinIds.add(assetId);
    }
    if (!selectedPresent && node.selectedVersionAssetPins.length !== 0) {
      throw new DesignStorageError("corrupt", "Frozen Design context has Version Asset pins without a Version");
    }
    if (selectedPresent && node.selectedVersionContentKind === "asset") {
      const primaryAsset = (node.selectedVersionAssetPins as DesignFrozenAssetPin[]).find((pin) => (
        pin.path === node.selectedVersionPath
        && pin.checksum === node.selectedVersionChecksum
        && pin.bytes === node.selectedVersionBytes
      ));
      if (!primaryAsset) {
        throw new DesignStorageError("corrupt", "Frozen material Version has no checksum-bound primary Asset");
      }
    }
    if (assetPresent) {
      validateFrozenAsset({
        assetId: node.assetId,
        checksum: node.assetChecksum,
        bytes: node.assetBytes,
        fileName: String(node.assetPath).slice(String(node.assetPath).lastIndexOf("/") + 1),
        path: `.context/assets/${node.assetId}/${String(node.assetPath).slice(String(node.assetPath).lastIndexOf("/") + 1)}`,
        bundleFiles: node.assetBundleFiles,
      }, `Frozen Design context Node ${nodeIndex} Asset`);
    } else if (node.assetBundleFiles.length !== 0) {
      throw new DesignStorageError("corrupt", "Frozen Design context has an unowned Asset bundle");
    }
  }
  if (context.targetNodeId !== null && !nodeIds.has(context.targetNodeId as string)) {
    throw new DesignStorageError("corrupt", "Frozen Design context target Node is unavailable");
  }
  assertDesignFrozenContextBudget(value as DesignFrozenContext);
}

export async function getDesignJob(dataDir: string, projectId: string, jobId: string): Promise<DesignJob> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    await requireInitialized(root);
    return readJob(root, safeSegment(jobId, "Job id"));
  });
}

async function listDesignJobsUnlocked(root: string): Promise<DesignJob[]> {
  const entries = await readdir(join(root, "jobs"), { withFileTypes: true });
  const jobs = await Promise.all(entries
    .filter((entry) => entry.isFile() && /^job-[0-9a-f-]{36}\.json$/.test(entry.name))
    .map((entry) => readJob(root, entry.name.slice(0, -5))));
  return jobs.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
}

export async function listDesignJobs(dataDir: string, projectId: string): Promise<DesignJob[]> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    await requireInitialized(root);
    return listDesignJobsUnlocked(root);
  });
}

const TERMINAL_JOB_STATUSES = new Set<DesignJobStatus>(["ready", "failed", "cancelled", "superseded"]);
const JOB_TRANSITIONS: Record<DesignJobStatus, ReadonlySet<DesignJobStatus>> = {
  queued: new Set(["running", "failed", "cancelled"]),
  running: new Set(["validating", "ready", "failed", "cancelled", "superseded"]),
  validating: new Set(["ready", "failed", "cancelled", "superseded"]),
  ready: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  superseded: new Set(),
};

/** Reconcile process-local work after a daemon restart. Immutable heads stay intact. */
export async function recoverInterruptedDesignJobs(
  dataDir: string,
  projectId: string,
  now?: number,
): Promise<DesignJob[]> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    if (!(await exists(projectFilePath(root)))) return [];
    const timestamp = nowValue(now);
    const publicationJobs = await recoverPublicationTransactionsUnlocked(root, projectId, timestamp);
    const jobs = await listDesignJobsUnlocked(root);
    const interrupted = jobs
      .filter((job) => job.status === "queued" || job.status === "running" || job.status === "validating");
    const interruptedIds = new Set(interrupted.map((job) => job.id));
    const mainJobs = jobs.filter((job) => job.kind === "main-agent");
    if (mainJobs.length > 0) {
      const scope = { type: "main" } as const;
      const path = threadFilePath(root, scope);
      if (await exists(path)) {
        const thread = await readJson<DesignThread>(path, "Design Agent thread");
        assertStoredThread(thread, scope);
        let changed = false;
        for (const job of mainJobs) {
          const reservations = thread.messages.filter((message) => (
            message.role === "assistant" && message.jobId === job.id
          ));
          if (reservations.length > 1) {
            throw new DesignStorageError("corrupt", `Main Agent Job ${job.id} has duplicate assistant reservations`);
          }
          const reservation = reservations[0];
          if (reservation === undefined) continue;
          const projected = interruptedIds.has(job.id)
            ? "Main Agent orchestration was interrupted by daemon restart and cancelled."
            : job.status === "cancelled"
              ? job.error === "Interrupted by daemon restart"
                ? "Main Agent orchestration was interrupted by daemon restart and cancelled."
                : "Main Agent orchestration cancelled."
              : job.status === "failed"
                ? `Main Agent failed: ${job.error ?? "Main Agent turn failed"}`
                : null;
          if (projected === null) continue;
          if (reservation.content !== projected) {
            reservation.content = projected;
            changed = true;
          }
        }
        if (changed) {
          thread.updatedAt = timestamp;
          // Persist the user-visible terminal projection before terminalizing
          // the Jobs. A second restart can safely repeat this write if the
          // process exits between these two durable steps.
          await writeAtomicJson(path, thread);
        }
      }
    }
    for (const job of interrupted) {
      if (job.kind === "implementation-export" && job.exportId !== null) {
        await Promise.all([
          rm(join(root, "exports", job.exportId), { recursive: true, force: true }),
          rm(join(root, "exports", ".pending", job.exportId), { recursive: true, force: true }),
          rm(join(root, "exports", ".validation", job.exportId), { recursive: true, force: true }),
        ]);
      } else if (job.kind === "main-agent") {
        await rm(join(root, "exports", ".pending", `main-${job.id}`), { recursive: true, force: true });
      } else if (job.nodeId !== null) {
        await rm(join(nodeRoot(root, job.nodeId), ".pending", "jobs", job.id), {
          recursive: true,
          force: true,
        });
      }
      job.status = "cancelled";
      job.cancelRequested = true;
      job.error = "Interrupted by daemon restart";
      job.updatedAt = timestamp;
      job.finishedAt = timestamp;
      await writeAtomicJson(jobFilePath(root, job.id), job);
    }

    const project = await readProject(root);
    const nodes = readNodes(project);
    const jobsById = new Map(jobs.map((job) => [job.id, job]));
    const publicationIds = new Set(publicationJobs.map((job) => job.id));
    const reprojectedTerminalJobs: DesignJob[] = [];
    let projectChanged = interrupted.length > 0;
    for (const node of nodes.values()) {
      if (node.activeJobId === null) continue;
      const activeJob = jobsById.get(node.activeJobId);
      if (!activeJob || activeJob.nodeId !== node.id) {
        throw new DesignStorageError("corrupt", `Design Node ${node.id} has invalid active Job authority`);
      }
      if (!TERMINAL_JOB_STATUSES.has(activeJob.status)) continue;
      node.state = nodeStateForJob(activeJob.status);
      node.activeJobId = null;
      node.error = activeJob.status === "failed" ? (activeJob.error ?? "Generation failed") : null;
      node.updatedAt = timestamp;
      projectChanged = true;
      if (!interruptedIds.has(activeJob.id) && !publicationIds.has(activeJob.id)) {
        reprojectedTerminalJobs.push(activeJob);
      }
    }
    if (projectChanged) {
      project.nodes = project.nodeOrder.map((id) => cloneNode(nodes.get(id)!));
      project.revision += 1;
      project.updatedAt = Math.max(project.updatedAt, timestamp);
      await writeAtomicJson(projectFilePath(root), project);
    }
    return [...publicationJobs, ...interrupted, ...reprojectedTerminalJobs];
  }, { allowPublicationTransactions: true });
}

function nodeStateForJob(status: DesignJobStatus): DesignNodeState {
  switch (status) {
    case "queued": return "queued";
    case "running": return "generating";
    case "validating": return "validating";
    case "ready": return "ready";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "superseded": return "superseded";
  }
}

export async function updateDesignJob(
  dataDir: string,
  projectId: string,
  jobId: string,
  patch: {
    status?: DesignJobStatus;
    runnerId?: string;
    model?: string | null;
    contextHash?: string;
    versionId?: string | null;
    exportId?: string | null;
    error?: string | null;
  },
  now?: number,
): Promise<DesignJob> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    const job = await readJob(root, safeSegment(jobId, "Job id"));
    const timestamp = nowValue(now);
    const updatesIdentity = patch.runnerId !== undefined || patch.model !== undefined;
    if (updatesIdentity) {
      if (patch.runnerId === undefined || patch.model === undefined
        || !validStoredText(patch.runnerId, 512) || patch.runnerId.trim() !== patch.runnerId
        || !validStoredText(patch.model, 512, { nullable: true })
        || (typeof patch.model === "string" && patch.model.trim() !== patch.model)) {
        throw new DesignStorageError("invalid-input", "Observed Job runner identity is invalid");
      }
      if (job.status !== "running") {
        throw new DesignStorageError("conflict", "Observed Job runner identity may only bind a running Job");
      }
      job.runnerId = patch.runnerId;
      job.model = patch.model;
    }
    if (patch.contextHash !== undefined) {
      if (!SHA256.test(patch.contextHash)) throw new DesignStorageError("invalid-input", "Job context hash is invalid");
      job.contextHash = patch.contextHash;
    }
    if (patch.versionId !== undefined) {
      if (patch.versionId !== null) safeSegment(patch.versionId, "Version id");
      job.versionId = patch.versionId;
    }
    if (patch.exportId !== undefined) {
      if (patch.exportId !== null) safeSegment(patch.exportId, "Export id");
      job.exportId = patch.exportId;
    }
    if (patch.error !== undefined) {
      if (patch.error !== null && (typeof patch.error !== "string" || Buffer.byteLength(patch.error, "utf8") > 16_384)) {
        throw new DesignStorageError("invalid-input", "Job error is invalid");
      }
      job.error = patch.error;
    }
    if (patch.status !== undefined && patch.status !== job.status) {
      if (!JOB_TRANSITIONS[job.status].has(patch.status)) {
        throw new DesignStorageError("conflict", `Design Job cannot transition from ${job.status} to ${patch.status}`);
      }
      job.status = patch.status;
      if (TERMINAL_JOB_STATUSES.has(job.status)) job.finishedAt = timestamp;
    }
    job.updatedAt = timestamp;
    await writeAtomicJson(jobFilePath(root, job.id), job);
    if (job.nodeId !== null) {
      const project = await readProject(root);
      const nodes = readNodes(project);
      const node = nodes.get(job.nodeId);
      if (!node) throw new DesignStorageError("not-found", `Design Node ${job.nodeId} was not found`);
      if (node.activeJobId === job.id) {
        node.state = nodeStateForJob(job.status);
        node.error = job.status === "failed" ? (job.error ?? "Generation failed") : null;
        if (TERMINAL_JOB_STATUSES.has(job.status)) node.activeJobId = null;
        node.updatedAt = timestamp;
        project.nodes = project.nodeOrder.map((id) => cloneNode(nodes.get(id)!));
        project.revision += 1;
        project.updatedAt = Math.max(project.updatedAt, timestamp);
        await writeAtomicJson(projectFilePath(root), project);
      }
    }
    return job;
  });
}

export async function appendDesignJobActivity(
  dataDir: string,
  projectId: string,
  jobId: string,
  input: { kind: DesignJobActivity["kind"]; text: string },
  now?: number,
): Promise<DesignJob> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    const job = await readJob(root, safeSegment(jobId, "Job id"));
    if (!["text", "tool", "status"].includes(input?.kind) || typeof input?.text !== "string"
      || !input.text.trim() || Buffer.byteLength(input.text, "utf8") > 16_384) {
      throw new DesignStorageError("invalid-input", "Design Job activity is invalid");
    }
    const timestamp = nowValue(now);
    job.activity.push({ id: `activity-${randomUUID()}`, kind: input.kind, text: input.text.trim(), createdAt: timestamp });
    job.activity = job.activity.slice(-MAX_JOB_ACTIVITY);
    job.updatedAt = timestamp;
    await writeAtomicJson(jobFilePath(root, job.id), job);
    return job;
  });
}

/**
 * Make cancellation durable in the same serialized critical section that clears
 * a Node's active Job. The process-local AbortController is owned by the Agent
 * executor, but storage never leaves cancellation as an in-memory-only request.
 */
export async function cancelDesignJob(
  dataDir: string,
  projectId: string,
  jobId: string,
  now?: number,
): Promise<DesignJob> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    const job = await readJob(root, safeSegment(jobId, "Job id"));
    if (TERMINAL_JOB_STATUSES.has(job.status)) return job;
    const timestamp = nowValue(now);
    job.cancelRequested = true;
    job.status = "cancelled";
    job.error = "Agent turn cancelled";
    job.updatedAt = timestamp;
    job.finishedAt = timestamp;
    await writeAtomicJson(jobFilePath(root, job.id), job);

    const project = await readProject(root);
    const nodes = readNodes(project);
    if (job.nodeId !== null) {
      const node = nodes.get(job.nodeId);
      if (!node) throw new DesignStorageError("not-found", `Design Node ${job.nodeId} was not found`);
      if (node.activeJobId === job.id) {
        node.state = "cancelled";
        node.activeJobId = null;
        node.error = null;
        node.updatedAt = timestamp;
      }
    }
    project.nodes = project.nodeOrder.map((id) => cloneNode(nodes.get(id)!));
    project.revision += 1;
    project.updatedAt = Math.max(project.updatedAt, timestamp);
    await writeAtomicJson(projectFilePath(root), project);
    return job;
  });
}

export async function requestDesignJobCancellation(
  dataDir: string,
  projectId: string,
  jobId: string,
  now?: number,
): Promise<DesignJob> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    const job = await readJob(root, safeSegment(jobId, "Job id"));
    if (TERMINAL_JOB_STATUSES.has(job.status)) return job;
    job.cancelRequested = true;
    job.updatedAt = nowValue(now);
    await writeAtomicJson(jobFilePath(root, job.id), job);
    return job;
  });
}

export async function freezeDesignContext(
  dataDir: string,
  projectId: string,
  input: { targetNodeId?: string | null; expectedRevision?: number },
): Promise<DesignFrozenContext> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    await requireInitialized(root);
    const project = await readProject(root);
    if (input.expectedRevision !== undefined && input.expectedRevision !== project.revision) {
      throw new DesignRevisionConflictError(input.expectedRevision, project.revision);
    }
    return buildFrozenContextUnlocked(root, dataDir, projectId, project, input.targetNodeId ?? null);
  });
}
