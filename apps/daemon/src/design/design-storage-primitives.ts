import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
  DesignAssetBundleFile,
  DesignInvalidationTopic,
  DesignViewport,
} from "./design-types.ts";
import { commitDesignAuthorityChange } from "./design-invalidation-journal.ts";

export const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const SHA256 = /^[a-f0-9]{64}$/;
export const MAX_HISTORY = 50;
export const MAX_RETIRED_NODE_IDS = 5_000;
export const MAX_DESIGN_ASSET_BYTES = 32 * 1024 * 1024;
export const MAX_DESIGN_ASSET_BATCH_BYTES = 64 * 1024 * 1024;
export const MAX_DESIGN_ASSET_BATCH_ITEMS = 32;
export const MAX_DESIGN_HTML_BYTES = 4 * 1024 * 1024;
export const MAX_THREAD_MESSAGES = 2_000;
export const MAX_THREAD_CONTENT_BYTES = 256 * 1024;
export const MAX_JOB_ACTIVITY = 2_000;
export const MAX_ASSET_BUNDLE_FILES = 1_000;
export const MAX_DESIGN_CONTEXT_PAYLOADS = 1_000;
export const MAX_DESIGN_CONTEXT_BYTES = 256 * 1024 * 1024;

const projectLocks = new Map<string, Promise<void>>();
let projectTransactionRecovery: ((root: string) => Promise<void>) | null = null;

export function registerDesignProjectTransactionRecovery(
  recovery: (root: string) => Promise<void>,
): void {
  projectTransactionRecovery = recovery;
}

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

export function safeSegment(value: string, label: string): string {
  if (!SAFE_SEGMENT.test(value) || value === "." || value === "..") {
    throw new DesignStorageError("invalid-id", `${label} is invalid`);
  }
  return value;
}

export type StoredRecord = Record<string, unknown>;

export function storedRecord(value: unknown, label: string, allowed: readonly string[]): StoredRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DesignStorageError("corrupt", `${label} is invalid`);
  }
  const record = value as StoredRecord;
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new DesignStorageError("corrupt", `${label} contains an unexpected field`);
  }
  return record;
}

export function validStoredNullableId(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && SAFE_SEGMENT.test(value));
}

export function validStoredText(value: unknown, maxBytes: number, options: { nullable?: boolean; empty?: boolean } = {}): boolean {
  if (options.nullable && value === null) return true;
  return typeof value === "string"
    && (options.empty || value.trim().length > 0)
    && Buffer.byteLength(value, "utf8") <= maxBytes;
}

export function safeBundlePath(value: unknown, label = "Asset bundle path"): string {
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

export function assertStoredBundleFiles(value: unknown, label: string): asserts value is DesignAssetBundleFile[] {
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

export function validStoredTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function validStoredViewport(value: unknown): value is DesignViewport {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DesignViewport>;
  return typeof candidate.x === "number" && Number.isFinite(candidate.x)
    && typeof candidate.y === "number" && Number.isFinite(candidate.y)
    && typeof candidate.zoom === "number" && Number.isFinite(candidate.zoom)
    && candidate.zoom >= 0.05 && candidate.zoom <= 8;
}

export function designRoot(dataDir: string, projectId: string): string {
  return join(dataDir, "projects", safeSegment(projectId, "Project id"), "design");
}

export function projectFilePath(root: string): string {
  return join(root, "project.json");
}

export function nodeRoot(root: string, nodeId: string): string {
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

export function assetRoot(root: string, assetId: string): string {
  return join(root, "assets", safeSegment(assetId, "Asset id"));
}

export function jobFilePath(root: string, jobId: string): string {
  return join(root, "jobs", `${safeSegment(jobId, "Job id")}.json`);
}

export function nowValue(now?: number): number {
  const value = now ?? Date.now();
  if (!Number.isSafeInteger(value) || value < 0) throw new DesignStorageError("invalid-time", "Timestamp is invalid");
  return value;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function readJson<T>(path: string, label: string): Promise<T> {
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

export interface DesignDurabilityTestHooks {
  afterDirectoryDurable?: (path: string, parent: string) => void | Promise<void>;
  afterAtomicPhase?: (
    phase: "temporary-file-synced" | "parent-directory-synced",
    path: string,
  ) => void | Promise<void>;
}

export async function syncDesignDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function ensureDurableDirectory(
  inputPath: string,
  testHooks?: DesignDurabilityTestHooks,
): Promise<void> {
  const path = resolve(inputPath);
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new DesignStorageError("corrupt", "Design authority directory must be a regular directory");
    }
    return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const parent = dirname(path);
  if (parent === path) throw new DesignStorageError("corrupt", "Design authority directory root is unavailable");
  await ensureDurableDirectory(parent, testHooks);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new DesignStorageError("corrupt", "Design authority directory must be a regular directory");
  }
  await syncDesignDirectory(parent);
  await testHooks?.afterDirectoryDurable?.(path, parent);
}

export async function writeAtomic(
  path: string,
  bytes: string | Uint8Array,
  testHooks?: DesignDurabilityTestHooks,
): Promise<void> {
  const parent = resolve(path, "..");
  await ensureDurableDirectory(parent, testHooks);
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await testHooks?.afterAtomicPhase?.("temporary-file-synced", path);
    await rename(temporary, path);
    await syncDesignDirectory(parent);
    await testHooks?.afterAtomicPhase?.("parent-directory-synced", path);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  await writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeAuthorityJson(
  root: string,
  path: string,
  value: unknown,
  topics: readonly DesignInvalidationTopic[],
): Promise<void> {
  await commitDesignAuthorityChange(root, topics, () => writeAtomicJson(path, value));
}

export async function withProjectLock<T>(
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
    await projectTransactionRecovery?.(root);
    if (!options.allowPublicationTransactions) await assertNoDesignVersionPublicationsUnlocked(root);
    return await operation();
  } finally {
    release();
    if (projectLocks.get(root) === tail) projectLocks.delete(root);
  }
}

export function publicationTransactionsRoot(root: string): string {
  return join(root, "transactions", "publications");
}

export async function assertNoDesignVersionPublicationsUnlocked(root: string): Promise<void> {
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
