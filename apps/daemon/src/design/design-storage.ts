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
  type DesignVersionManifest,
  type DesignViewport,
} from "./design-types.ts";

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_HISTORY = 50;
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

async function withProjectLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const prior = projectLocks.get(root) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  const tail = prior.then(() => current);
  projectLocks.set(root, tail);
  await prior;
  try {
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
    mkdir(join(root, "jobs"), { recursive: true }),
    mkdir(join(root, "exports"), { recursive: true }),
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
    || !Array.isArray(project.retiredNodeIds) || project.retiredNodeIds.length > 5_000
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
  if ((generative && node.assetId !== null)
    || (!generative && (node.currentVersionId !== null || node.selectedVersionId !== null || node.versionCount !== 0))) {
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
  return withProjectLock(root, () => initializeUnlocked(root, projectId, now));
}

export async function getDesignCanvas(dataDir: string, projectId: string): Promise<DesignCanvas> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    await requireInitialized(root);
    await recoverPendingAssetImportsUnlocked(root);
    return readCanvasUnlocked(root);
  });
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
  if (assetId !== null && !["image", "video", "document", "file"].includes(kind)) {
    throw new DesignStorageError("invalid-input", "Only material Nodes may bind an Asset");
  }
  if (assetId !== null) {
    const asset = preparedAsset?.id === assetId
      ? preparedAsset
      : await getDesignAssetManifest(dataDir, projectId, assetId);
    if (!matchesMaterialNodeKind(kind, asset.mimeType)) {
      throw new DesignStorageError("invalid-input", `Asset ${assetId} mimeType does not match Node kind ${kind}`);
    }
  }
  const created: DesignNode = {
    id,
    kind,
    name: nodeName(intent.node.name, kind),
    geometry: geometry(intent.node.geometry, defaultGeometry(kind)),
    state: assetId === null ? "empty" : "ready",
    currentVersionId: null,
    selectedVersionId: null,
    versionCount: 0,
    assetId,
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
    if (!project.retiredNodeIds.includes(id)) project.retiredNodeIds.push(id);
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
        await getDesignVersion(dataDir, projectId, node.id, patch.selectedVersionId);
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
  input: { expectedRevision: number; intents: DesignCanvasIntent[] },
  now?: number,
): Promise<DesignCanvas> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    await requireInitialized(root);
    await recoverPendingAssetImportsUnlocked(root);
    const project = await readProject(root);
    if (!Number.isSafeInteger(input?.expectedRevision) || input.expectedRevision < 0) {
      throw new DesignStorageError("invalid-input", "expectedRevision is invalid");
    }
    if (input.expectedRevision !== project.revision) {
      throw new DesignRevisionConflictError(input.expectedRevision, project.revision);
    }
    if (!Array.isArray(input.intents) || input.intents.length < 1 || input.intents.length > 100) {
      throw new DesignStorageError("invalid-input", "Canvas mutation must contain 1 to 100 intents");
    }
    const timestamp = nowValue(now);
    const nodes = readNodes(project);
    const before = snapshot(project, nodes);
    const changed = new Set<string>();
    for (const intent of input.intents) await applyIntent(dataDir, projectId, project, nodes, intent, timestamp, changed);
    project.nodes = project.nodeOrder.map((id) => cloneNode(nodes.get(id)!));
    if (input.intents.some((intent) => intent.type !== "set-viewport")) {
      project.undo = [...project.undo, before].slice(-MAX_HISTORY);
      project.redo = [];
    }
    project.revision += 1;
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
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(MAX_DESIGN_ASSET_BYTES / 3) * 4 + 4
    || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new DesignStorageError("invalid-input", "Asset base64 is invalid");
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
  node: Extract<DesignCanvasIntent, { type: "add-node" }>["node"];
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
      const resolved = await resolveDesignVersionFile(
        dataDir,
        sourceProjectId,
        sourceNodeId,
        sourceVersionId,
        "index.html",
      );
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

interface DesignAssetImportTransaction {
  schemaVersion: typeof DESIGN_SCHEMA_VERSION;
  expectedRevision: number;
  nextRevision: number;
  createdAssetIds: string[];
  bindings: Array<{ nodeId: string; assetId: string }>;
}

function assetImportTransactionsRoot(root: string): string {
  return join(root, "assets", ".transactions");
}

function assertAssetImportTransaction(value: unknown): asserts value is DesignAssetImportTransaction {
  const transaction = storedRecord(value, "Design Asset import transaction", [
    "schemaVersion", "expectedRevision", "nextRevision", "createdAssetIds", "bindings",
  ]);
  if (transaction.schemaVersion !== DESIGN_SCHEMA_VERSION
    || !Number.isSafeInteger(transaction.expectedRevision) || (transaction.expectedRevision as number) < 0
    || !Number.isSafeInteger(transaction.nextRevision)
    || transaction.nextRevision !== (transaction.expectedRevision as number) + 1
    || !Array.isArray(transaction.createdAssetIds)
    || transaction.createdAssetIds.length > MAX_DESIGN_ASSET_BATCH_ITEMS
    || !Array.isArray(transaction.bindings)
    || transaction.bindings.length < 1
    || transaction.bindings.length > MAX_DESIGN_ASSET_BATCH_ITEMS) {
    throw new DesignStorageError("corrupt", "Design Asset import transaction is invalid");
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
    const binding = storedRecord(value, "Design Asset import transaction binding", ["nodeId", "assetId"]);
    if (typeof binding.nodeId !== "string" || !SAFE_SEGMENT.test(binding.nodeId) || nodeIds.has(binding.nodeId)
      || typeof binding.assetId !== "string" || !SAFE_SEGMENT.test(binding.assetId)) {
      throw new DesignStorageError("corrupt", "Design Asset import transaction binding is invalid");
    }
    nodeIds.add(binding.nodeId);
  }
}

async function recoverPendingAssetImportsUnlocked(root: string): Promise<void> {
  const transactionsRoot = assetImportTransactionsRoot(root);
  if (!(await exists(transactionsRoot))) return;
  const entries = await readdir(transactionsRoot, { withFileTypes: true });
  if (entries.length === 0) return;
  const project = await readProject(root);
  const nodes = readNodes(project);
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
    assertAssetImportTransaction(transaction);
    const committed = project.revision >= transaction.nextRevision
      && transaction.bindings.every((binding) => nodes.get(binding.nodeId)?.assetId === binding.assetId);
    if (committed) {
      for (const binding of transaction.bindings) {
        if (!(await exists(join(assetRoot(root, binding.assetId), "manifest.json")))) {
          throw new DesignStorageError("corrupt", "Committed Design Asset import is missing an Asset");
        }
      }
    } else {
      const referencedAssetIds = new Set(project.nodes.flatMap((node) => node.assetId ? [node.assetId] : []));
      await Promise.all(transaction.createdAssetIds
        .filter((assetId) => !referencedAssetIds.has(assetId))
        .map((assetId) => rm(assetRoot(root, assetId), { recursive: true, force: true })));
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

/**
 * Atomically ingest immutable Asset payloads and bind their material Nodes in one
 * Canvas revision. Payloads are staged under the project lock; if any payload,
 * Node, CAS, or project commit fails, only Asset directories first created by
 * this transaction are removed. Existing content-addressed Assets are untouched.
 */
export async function importDesignCanvasAssetBatch(
  dataDir: string,
  projectId: string,
  input: { expectedRevision: number; items: DesignCanvasAssetImport[] },
  now?: number,
): Promise<DesignCanvas> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
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
    const bindings: Array<{ nodeId: string; assetId: string }> = [];
    const transactionId = `import-${randomUUID()}`;
    const transactionRoot = join(assetImportTransactionsRoot(root), transactionId);
    let totalBytes = 0;
    try {
      for (const item of input.items) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
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
        const importedNode = await addNode(dataDir, projectId, project, nodes, {
          type: "add-node",
          node: { ...item.node, assetId: prepared.manifest.id },
        }, timestamp, prepared.manifest);
        bindings.push({ nodeId: importedNode.id, assetId: prepared.manifest.id });
      }

      project.nodes = project.nodeOrder.map((id) => cloneNode(nodes.get(id)!));
      project.undo = [...project.undo, before].slice(-MAX_HISTORY);
      project.redo = [];
      project.revision += 1;
      project.updatedAt = Math.max(project.updatedAt, timestamp);
      const transaction: DesignAssetImportTransaction = {
        schemaVersion: DESIGN_SCHEMA_VERSION,
        expectedRevision: input.expectedRevision,
        nextRevision: project.revision,
        createdAssetIds: [...createdAssetIds].sort(),
        bindings,
      };
      await writeAtomicJson(join(transactionRoot, "transaction.json"), transaction);
      for (const assetId of createdAssetIds) {
        await rename(join(transactionRoot, "assets", assetId), assetRoot(root, assetId));
      }
      await writeAtomicJson(projectFilePath(root), project);
      await rm(transactionRoot, { recursive: true, force: true }).catch(() => {});
      return canvas(project, nodes);
    } catch (error) {
      await Promise.all([
        ...[...createdAssetIds].map((assetId) =>
          rm(assetRoot(root, assetId), { recursive: true, force: true })),
        rm(transactionRoot, { recursive: true, force: true }),
      ]);
      throw error;
    }
  });
}

export async function getDesignAssetManifest(
  dataDir: string,
  projectId: string,
  assetId: string,
): Promise<DesignAssetManifest> {
  const root = designRoot(dataDir, projectId);
  const manifest = await readJson<DesignAssetManifest>(
    join(assetRoot(root, assetId), "manifest.json"),
    `Design Asset ${assetId}`,
  );
  assertStoredAssetManifest(manifest, assetId);
  return manifest;
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
  const manifest = await getDesignAssetManifest(dataDir, projectId, assetId);
  if (requestedFile !== manifest.fileName || basename(requestedFile) !== requestedFile) {
    throw new DesignStorageError("not-found", "Design Asset file was not found");
  }
  const path = join(assetRoot(designRoot(dataDir, projectId), assetId), manifest.fileName);
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

const CANONICAL_DESIGN_ASSET_URL = /\/api\/projects\/[A-Za-z0-9._-]+\/design-canvas\/assets\/asset-[a-f0-9]{32}\/original\.[a-z0-9]{1,12}\?nodeId=[A-Za-z0-9._-]+&versionId=version-[A-Za-z0-9._-]+&checksum=[a-f0-9]{64}/gi;

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
  if (!/^\s*<!doctype\s+html\s*>/i.test(html)
    || (html.match(/<html\b/gi)?.length ?? 0) !== 1
    || (html.match(/<head\b/gi)?.length ?? 0) !== 1
    || (html.match(/<body\b/gi)?.length ?? 0) !== 1
    || !/<\/html\s*>\s*$/i.test(html)) {
    throw new DesignStorageError("invalid-html", "Generated output must be one complete HTML document");
  }
  if (/<script\b[^>]*\bsrc\s*=/i.test(html)) {
    throw new DesignStorageError("invalid-html", "Generated HTML must keep JavaScript inline");
  }
  if (/<link\b[^>]*\brel\s*=\s*["']?stylesheet\b/i.test(html)
    || /@import\s+(?:url\s*\()?\s*["']?https?:/i.test(html)
    || /url\s*\(\s*["']?https?:/i.test(html)) {
    throw new DesignStorageError("invalid-html", "Generated HTML must keep styles and style assets local");
  }
  if (/<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i.test(html) || /<base\b/i.test(html)) {
    throw new DesignStorageError("invalid-html", "Generated HTML may not redefine or refresh navigation");
  }
  if (/\btarget\s*=\s*["']?_(?:top|parent)\b/i.test(html)) {
    throw new DesignStorageError("invalid-html", "Generated HTML may not target parent navigation");
  }
  for (const match of html.matchAll(/\b(?:src|href|poster|action|formaction)\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/gi)) {
    if (!allowedDesignUrl(match[2] ?? match[3] ?? "", options.allowCanonicalAssets === true)) {
      throw new DesignStorageError("invalid-html", "Generated HTML contains an unpinned or external URL");
    }
  }
  for (const match of html.matchAll(/\b(?:srcset|imagesrcset)\s*=\s*(?:(["'])(.*?)\1|([^>\s]+))/gi)) {
    const candidates = (match[2] ?? match[3] ?? "").split(",").map((entry) => entry.trim().split(/\s+/, 1)[0] ?? "");
    if (candidates.length === 0 || candidates.some((candidate) => !allowedDesignUrl(candidate, options.allowCanonicalAssets === true))) {
      throw new DesignStorageError("invalid-html", "Generated HTML contains an unpinned or external responsive-image URL");
    }
  }
  for (const match of html.matchAll(/url\s*\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    if (!allowedDesignUrl(match[2] ?? "", options.allowCanonicalAssets === true)) {
      throw new DesignStorageError("invalid-html", "Generated HTML contains an unpinned style asset URL");
    }
  }
  for (const match of html.matchAll(/(?:-webkit-)?image-set\s*\((.*?)\)/gis)) {
    if (/https?:|(?:^|["'(\s])\/(?!\/)/i.test(match[1] ?? "")) {
      throw new DesignStorageError("invalid-html", "Generated HTML contains an external image-set URL");
    }
  }
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map((match) => match[1] ?? "");
  for (const script of scripts) {
    const inspected = options.allowCanonicalAssets === true ? script.replace(CANONICAL_DESIGN_ASSET_URL, "") : script;
    CANONICAL_DESIGN_ASSET_URL.lastIndex = 0;
    if (/\b(?:window\s*\.\s*)?(?:top|parent|opener)\b/i.test(inspected)
      || /\bimport\s*(?:\(|[^;\n]*\bfrom\s*)["']https?:/i.test(inspected)
      || /https?:\/\//i.test(inspected)
      || /["'`]\s*\/api(?:\/|\?|["'`])/i.test(inspected)
      || /\b(?:window\s*\.\s*)?location\s*(?:\.\s*(?:assign|replace)\s*\(|(?:\.\s*href)?\s*=)/i.test(inspected)
      || /\bwindow\s*\.\s*open\s*\(/i.test(inspected)) {
      throw new DesignStorageError("invalid-html", "Generated HTML may not access parent navigation or remote scripts");
    }
  }
}

async function canonicalizeVersionAssets(input: {
  dataDir: string;
  projectId: string;
  nodeId: string;
  versionId: string;
  html: string;
}): Promise<{ html: string; pins: Array<{ assetId: string; checksum: string }> }> {
  const ids = new Set<string>();
  for (const match of input.html.matchAll(/dezin-asset:\/\/(asset-[a-f0-9]{32})\b/g)) ids.add(match[1]!);

  const projectPath = `/api/projects/${input.projectId}/design-canvas/assets/`;
  const escaped = projectPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function assertStoredVersionManifest(
  value: unknown,
  expectedNodeId: string,
  expectedVersionId: string,
): asserts value is DesignVersionManifest {
  const manifest = storedRecord(value, `Design Version ${expectedVersionId} manifest`, [
    "schemaVersion", "id", "nodeId", "sequence", "checksum", "bytes", "contextHash", "canvasRevision",
    "expectedHeadVersionId", "publicationStatus", "assetPins", "jobId", "runnerId", "model", "createdAt",
  ]);
  if (manifest.schemaVersion !== DESIGN_SCHEMA_VERSION || manifest.id !== expectedVersionId
    || manifest.nodeId !== expectedNodeId || !SAFE_SEGMENT.test(expectedVersionId) || !SAFE_SEGMENT.test(expectedNodeId)
    || !Number.isSafeInteger(manifest.sequence) || (manifest.sequence as number) < 1
    || !SHA256.test(String(manifest.checksum))
    || !Number.isSafeInteger(manifest.bytes) || (manifest.bytes as number) < 1
    || (manifest.bytes as number) > MAX_DESIGN_HTML_BYTES
    || !SHA256.test(String(manifest.contextHash))
    || !Number.isSafeInteger(manifest.canvasRevision) || (manifest.canvasRevision as number) < 0
    || !validStoredNullableId(manifest.expectedHeadVersionId)
    || !["published", "superseded"].includes(String(manifest.publicationStatus))
    || !Array.isArray(manifest.assetPins) || manifest.assetPins.length > MAX_ASSET_BUNDLE_FILES
    || !validStoredNullableId(manifest.jobId)
    || !validStoredText(manifest.runnerId, 512, { nullable: true })
    || !validStoredText(manifest.model, 512, { nullable: true })
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
}

export async function listDesignVersions(
  dataDir: string,
  projectId: string,
  nodeId: string,
): Promise<DesignVersionManifest[]> {
  const root = designRoot(dataDir, projectId);
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

export async function getDesignVersion(
  dataDir: string,
  projectId: string,
  nodeId: string,
  versionId: string,
): Promise<DesignVersionManifest> {
  const root = designRoot(dataDir, projectId);
  const manifest = await readJson<DesignVersionManifest>(
    join(versionRoot(root, nodeId, versionId), "manifest.json"),
    `Design Version ${versionId}`,
  );
  assertStoredVersionManifest(manifest, nodeId, versionId);
  return manifest;
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
): Promise<{ manifest: DesignVersionManifest; node: DesignNode }> {
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
    validateDesignHtml(input.html);

    const existing = await listDesignVersions(dataDir, projectId, nodeId);
    const sequence = existing.reduce((maximum, version) => Math.max(maximum, version.sequence), 0) + 1;
    const versionId = `version-${randomUUID()}`;
    const canonical = await canonicalizeVersionAssets({
      dataDir,
      projectId,
      nodeId,
      versionId,
      html: input.html,
    });
    const timestamp = nowValue(now);
    const bytes = Buffer.byteLength(canonical.html, "utf8");
    const checksum = createHash("sha256").update(canonical.html, "utf8").digest("hex");
    const publicationStatus = node.currentVersionId === input.expectedHeadVersionId ? "published" : "superseded";
    const manifest: DesignVersionManifest = {
      schemaVersion: DESIGN_SCHEMA_VERSION,
      id: versionId,
      nodeId,
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
    return { manifest, node: cloneNode(node) };
  });
}

export async function resolveDesignVersionFile(
  dataDir: string,
  projectId: string,
  nodeId: string,
  versionId: string,
  requestedFile: string,
): Promise<{ manifest: DesignVersionManifest; path: string }> {
  if (requestedFile !== "" && requestedFile !== "index.html") {
    throw new DesignStorageError("not-found", "Design Version file was not found");
  }
  const manifest = await getDesignVersion(dataDir, projectId, nodeId, versionId);
  const path = join(versionRoot(designRoot(dataDir, projectId), nodeId, versionId), "index.html");
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

async function readOrCreateThreadUnlocked(
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
  if (!(await exists(path))) await writeAtomicJson(path, newThread(scope, nowValue(now)));
  const thread = await readJson<DesignThread>(path, "Design Agent thread");
  assertStoredThread(thread, scope);
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

function assertStoredJob(value: unknown, expectedId: string): asserts value is DesignJob {
  const job = storedRecord(value, `Design Job ${expectedId}`, [
    "schemaVersion", "id", "kind", "status", "nodeId", "parentJobId", "contextHash", "canvasRevision",
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
      : await getDesignVersion(dataDir, projectId, node.id, selectedVersionId);
    const asset = node.assetId === null ? null : await getDesignAssetManifest(dataDir, projectId, node.assetId);
    const selectedVersionAssetPins: DesignFrozenAssetPin[] = [];
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
      selectedVersionChecksum: selectedVersion?.checksum ?? null,
      selectedVersionBytes: selectedVersion?.bytes ?? null,
      selectedVersionPath: selectedVersion === null
        ? null
        : `nodes/${node.id}/versions/${selectedVersion.id}/index.html`,
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

export async function createDesignJob(
  dataDir: string,
  projectId: string,
  input: {
    kind: DesignJobKind;
    nodeId?: string | null;
    parentJobId?: string | null;
    expectedCanvasRevision?: number;
    idempotencyKey?: string | null;
  },
  now?: number,
): Promise<{ job: DesignJob; reused: boolean; canvas: DesignCanvas }> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    await requireInitialized(root);
    if (!["node-generation", "node-analysis", "main-agent", "implementation-export"].includes(input?.kind)) {
      throw new DesignStorageError("invalid-input", "Design Job kind is unsupported");
    }
    const project = await readProject(root);
    if (input.expectedCanvasRevision !== undefined && input.expectedCanvasRevision !== project.revision) {
      throw new DesignRevisionConflictError(input.expectedCanvasRevision, project.revision);
    }
    const nodes = readNodes(project);
    const nodeId = input.nodeId ?? null;
    const rawIdempotencyKey = input.idempotencyKey ?? null;
    if (rawIdempotencyKey !== null && (typeof rawIdempotencyKey !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(rawIdempotencyKey))) {
      throw new DesignStorageError("invalid-input", "idempotencyKey is invalid");
    }
    const receiptKey = rawIdempotencyKey === null
      ? null
      : `${input.kind}:${nodeId ?? "main"}:${rawIdempotencyKey}`;
    const priorReceipt = receiptKey === null ? undefined : project.turnReceipts[receiptKey];
    if (priorReceipt) {
      if (priorReceipt.kind !== input.kind || priorReceipt.nodeId !== nodeId) {
        throw new DesignStorageError("conflict", "idempotencyKey is already bound to another Design Agent scope");
      }
      return { job: await readJob(root, priorReceipt.jobId), reused: true, canvas: canvas(project, nodes) };
    }
    if (receiptKey !== null && Object.keys(project.turnReceipts).length >= 5_000) {
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
    const parentJobId = input.parentJobId ?? null;
    if (parentJobId !== null) safeSegment(parentJobId, "Parent Job id");
    const timestamp = nowValue(now);
    const jobId = `job-${randomUUID()}`;
    const frozenCanvas = canvas(project, nodes);
    const frozenContext = await buildFrozenContextUnlocked(root, dataDir, projectId, project, nodeId);
    const job: DesignJob = {
      schemaVersion: DESIGN_SCHEMA_VERSION,
      id: jobId,
      kind: input.kind,
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
    await writeAtomicJson(jobContextFilePath(root, job.id), frozenContext);
    await writeAtomicJson(jobFilePath(root, job.id), job);
    if (receiptKey !== null) {
      project.turnReceipts[receiptKey] = { jobId: job.id, kind: job.kind, nodeId, createdAt: timestamp };
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
    return { job, reused: false, canvas: frozenCanvas };
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
      "id", "kind", "name", "state", "geometry", "selectedVersionId", "selectedVersionChecksum",
      "selectedVersionBytes", "selectedVersionPath", "selectedVersionAssetPins", "assetId", "assetChecksum",
      "assetBytes", "assetPath", "assetBundleFiles",
    ]);
    const geometryRecord = storedRecord(node.geometry, `Frozen Design context Node ${nodeIndex} geometry`, ["x", "y", "width", "height"]);
    const validGeometry = [geometryRecord.x, geometryRecord.y, geometryRecord.width, geometryRecord.height]
      .every((part) => typeof part === "number" && Number.isFinite(part))
      && (geometryRecord.width as number) >= 120 && (geometryRecord.width as number) <= 4_096
      && (geometryRecord.height as number) >= 80 && (geometryRecord.height as number) <= 4_096;
    const selectedAbsent = node.selectedVersionId === null && node.selectedVersionChecksum === null
      && node.selectedVersionBytes === null && node.selectedVersionPath === null;
    const selectedPresent = typeof node.selectedVersionId === "string" && SAFE_SEGMENT.test(node.selectedVersionId)
      && typeof node.selectedVersionChecksum === "string" && SHA256.test(node.selectedVersionChecksum)
      && Number.isSafeInteger(node.selectedVersionBytes) && (node.selectedVersionBytes as number) >= 1
      && typeof node.selectedVersionPath === "string"
      && node.selectedVersionPath === `nodes/${String(node.id)}/versions/${node.selectedVersionId}/index.html`;
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
  return readJob(designRoot(dataDir, projectId), safeSegment(jobId, "Job id"));
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
  await requireInitialized(root);
  return listDesignJobsUnlocked(root);
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
    const interrupted = (await listDesignJobsUnlocked(root))
      .filter((job) => job.status === "queued" || job.status === "running" || job.status === "validating");
    if (interrupted.length === 0) return [];

    const timestamp = nowValue(now);
    const project = await readProject(root);
    const nodes = readNodes(project);
    const interruptedIds = new Set(interrupted.map((job) => job.id));
    for (const job of interrupted) {
      if (job.kind === "implementation-export" && job.exportId !== null) {
        await Promise.all([
          rm(join(root, "exports", job.exportId), { recursive: true, force: true }),
          rm(join(root, "exports", ".pending", job.exportId), { recursive: true, force: true }),
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
    for (const node of nodes.values()) {
      if (node.activeJobId === null || !interruptedIds.has(node.activeJobId)) continue;
      node.state = "cancelled";
      node.activeJobId = null;
      node.error = null;
      node.updatedAt = timestamp;
    }
    project.nodes = project.nodeOrder.map((id) => cloneNode(nodes.get(id)!));
    project.revision += 1;
    project.updatedAt = Math.max(project.updatedAt, timestamp);
    await writeAtomicJson(projectFilePath(root), project);
    return interrupted;
  });
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
