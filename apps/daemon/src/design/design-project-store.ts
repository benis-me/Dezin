import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DesignStorageError, initializeDesignProject } from "./design-storage.ts";
import {
  ensureDurableDirectory,
  syncDesignDirectory,
  writeAtomicJson,
} from "./design-storage-primitives.ts";
import { DESIGN_SCHEMA_VERSION } from "./design-types.ts";

const DESIGN_PROJECT_METADATA_SCHEMA_VERSION = 1;
const SAFE_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_PROJECT_NAME_BYTES = 1_024;
const metadataLocks = new Map<string, Promise<void>>();

export interface DesignProjectMetadata {
  schemaVersion: typeof DESIGN_PROJECT_METADATA_SCHEMA_VERSION;
  projectId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  /** Registry id of the design system Node Agents follow; null means the registry default. */
  designSystemId: string | null;
}

const DESIGN_SYSTEM_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function designSystemIdOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !DESIGN_SYSTEM_ID.test(value)) {
    throw new DesignStorageError("invalid-input", "Design system id is invalid");
  }
  return value;
}

export interface PublicDesignProject {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  coverUrl: string;
  projectPath: string;
  sharingan: false;
  designSystemId: string | null;
}

function safeProjectId(projectId: string): string {
  if (!SAFE_PROJECT_ID.test(projectId) || projectId === "." || projectId === "..") {
    throw new DesignStorageError("invalid-id", "Project id is invalid");
  }
  return projectId;
}

function projectRoot(dataDir: string, projectId: string): string {
  return join(dataDir, "projects", safeProjectId(projectId));
}

function designRoot(dataDir: string, projectId: string): string {
  return join(projectRoot(dataDir, projectId), "design");
}

function metadataPath(dataDir: string, projectId: string): string {
  return join(designRoot(dataDir, projectId), "metadata.json");
}

function canvasPath(dataDir: string, projectId: string): string {
  return join(designRoot(dataDir, projectId), "project.json");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DesignStorageError("corrupt", `Design Project metadata ${label} is invalid`);
  }
  return value as number;
}

function projectName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value.trim(), "utf8") > MAX_PROJECT_NAME_BYTES) {
    throw new DesignStorageError("invalid-input", "Design Project name is invalid");
  }
  return value.trim();
}

function persistedProjectName(value: unknown): string {
  try {
    return projectName(value);
  } catch (error) {
    throw new DesignStorageError("corrupt", "Design Project metadata name is invalid", { cause: error });
  }
}

function parseMetadata(value: unknown, expectedProjectId: string): DesignProjectMetadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DesignStorageError("corrupt", "Design Project metadata must be an object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "projectId", "name", "createdAt", "updatedAt", "archivedAt", "designSystemId"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new DesignStorageError("corrupt", "Design Project metadata contains an unexpected field");
  }
  if (record.schemaVersion !== DESIGN_PROJECT_METADATA_SCHEMA_VERSION || record.projectId !== expectedProjectId) {
    throw new DesignStorageError("corrupt", "Design Project metadata identity is invalid");
  }
  const createdAt = timestamp(record.createdAt, "createdAt");
  const updatedAt = timestamp(record.updatedAt, "updatedAt");
  if (updatedAt < createdAt) {
    throw new DesignStorageError("corrupt", "Design Project metadata timestamps are invalid");
  }
  const archivedAt = record.archivedAt === null ? null : timestamp(record.archivedAt, "archivedAt");
  let designSystemId: string | null;
  try {
    designSystemId = designSystemIdOrNull(record.designSystemId);
  } catch {
    throw new DesignStorageError("corrupt", "Design Project metadata design system id is invalid");
  }
  return {
    schemaVersion: DESIGN_PROJECT_METADATA_SCHEMA_VERSION,
    projectId: expectedProjectId,
    name: persistedProjectName(record.name),
    createdAt,
    updatedAt,
    archivedAt,
    designSystemId,
  };
}

async function regularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function withMetadataLock<T>(dataDir: string, projectId: string, fn: () => Promise<T>): Promise<T> {
  const key = metadataPath(dataDir, projectId);
  const prior = metadataLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = prior.then(() => current);
  metadataLocks.set(key, queued);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    if (metadataLocks.get(key) === queued) metadataLocks.delete(key);
  }
}

async function readMetadata(dataDir: string, projectId: string): Promise<DesignProjectMetadata | null> {
  try {
    return parseMetadata(JSON.parse(await readFile(metadataPath(dataDir, projectId), "utf8")), projectId);
  } catch (error) {
    if (isMissing(error)) return null;
    if (error instanceof SyntaxError) {
      throw new DesignStorageError("corrupt", "Design Project metadata is not valid JSON", { cause: error });
    }
    throw error;
  }
}

async function readCanvasActivityTimestamp(dataDir: string, projectId: string): Promise<number | null> {
  try {
    const value = JSON.parse(await readFile(canvasPath(dataDir, projectId), "utf8")) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new DesignStorageError("corrupt", "Design Canvas manifest must be an object");
    }
    const record = value as Record<string, unknown>;
    // This rebuild intentionally has no migration path. An older Canvas root is
    // not a current Project and must not make startup recovery unavailable for
    // every newly-created Project.
    if (record.schemaVersion !== DESIGN_SCHEMA_VERSION) return null;
    if (record.projectId !== projectId || !Number.isSafeInteger(record.updatedAt) || (record.updatedAt as number) < 0) {
      throw new DesignStorageError("corrupt", "Design Canvas activity timestamp is invalid");
    }
    return record.updatedAt as number;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new DesignStorageError("corrupt", "Design Canvas manifest is not valid JSON", { cause: error });
    }
    throw error;
  }
}

/**
 * Create a normal Design Project. The Canvas manifest is the existence authority;
 * metadata is written first so no partially initialized Project can become visible.
 */
export async function createDesignProject(
  dataDir: string,
  input: { name: string },
  now = Date.now(),
): Promise<DesignProjectMetadata> {
  const name = projectName(input?.name);
  const createdAt = timestamp(now, "createdAt");
  const projectsRoot = join(dataDir, "projects");
  await ensureDurableDirectory(projectsRoot);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const projectId = randomUUID();
    const root = projectRoot(dataDir, projectId);
    try {
      await mkdir(root, { recursive: false });
      await syncDesignDirectory(projectsRoot);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
      throw error;
    }
    const metadata: DesignProjectMetadata = {
      schemaVersion: DESIGN_PROJECT_METADATA_SCHEMA_VERSION,
      projectId,
      name,
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
      designSystemId: null,
    };
    try {
      await mkdir(join(root, "design"), { recursive: false });
      await syncDesignDirectory(root);
      await writeAtomicJson(metadataPath(dataDir, projectId), metadata);
      await initializeDesignProject(dataDir, projectId, createdAt);
      return metadata;
    } catch (error) {
      await rm(root, { recursive: true, force: true }).catch(() => {});
      await syncDesignDirectory(projectsRoot).catch(() => {});
      throw error;
    }
  }
  throw new DesignStorageError("conflict", "Could not allocate a unique Design Project id");
}

/**
 * Initialize the exact filesystem Project identity reserved by a durable
 * coordinator. Replaying the same identity is a no-op; adopting an existing
 * identity with different metadata fails closed.
 */
export async function ensureDesignProjectAtId(
  dataDir: string,
  input: { projectId: string; name: string; createdAt: number },
): Promise<DesignProjectMetadata> {
  const projectId = safeProjectId(input?.projectId);
  const name = projectName(input?.name);
  const createdAt = timestamp(input?.createdAt, "createdAt");
  return withMetadataLock(dataDir, projectId, async () => {
    const root = projectRoot(dataDir, projectId);
    await ensureDurableDirectory(join(dataDir, "projects"));
    await ensureDurableDirectory(root);
    await ensureDurableDirectory(designRoot(dataDir, projectId));

    const current = await readMetadata(dataDir, projectId);
    if (current !== null && (
      current.name !== name
      || current.createdAt !== createdAt
      || current.archivedAt !== null
    )) {
      throw new DesignStorageError("conflict", "Design Project identity is already bound to different metadata");
    }
    const metadata: DesignProjectMetadata = current ?? {
      schemaVersion: DESIGN_PROJECT_METADATA_SCHEMA_VERSION,
      projectId,
      name,
      designSystemId: null,
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
    };
    if (current === null) await writeAtomicJson(metadataPath(dataDir, projectId), metadata);
    await initializeDesignProject(dataDir, projectId, createdAt);
    const initialized = await getDesignProject(dataDir, projectId);
    if (initialized === null) {
      throw new DesignStorageError("corrupt", "Design Project initialization did not publish its Canvas authority");
    }
    return initialized;
  });
}

/**
 * Return a normal Design Project only when both exact manifests exist. Canvas
 * activity is part of the public Project recency authority, while name/archive
 * edits remain owned by metadata.json.
 */
export async function getDesignProject(dataDir: string, projectId: string): Promise<DesignProjectMetadata | null> {
  safeProjectId(projectId);
  if (!(await regularFile(canvasPath(dataDir, projectId)))) return null;
  const [metadata, canvasUpdatedAt] = await Promise.all([
    readMetadata(dataDir, projectId),
    readCanvasActivityTimestamp(dataDir, projectId),
  ]);
  if (!metadata || canvasUpdatedAt === null) return null;
  return { ...metadata, updatedAt: Math.max(metadata.updatedAt, canvasUpdatedAt) };
}

export async function listDesignProjects(dataDir: string): Promise<DesignProjectMetadata[]> {
  let entries;
  try {
    entries = await readdir(join(dataDir, "projects"), { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const projects = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && SAFE_PROJECT_ID.test(entry.name))
    .map((entry) => getDesignProject(dataDir, entry.name)));
  return projects
    .filter((project): project is DesignProjectMetadata => project !== null)
    .sort((left, right) => right.updatedAt - left.updatedAt || right.projectId.localeCompare(left.projectId));
}

/** Enumerate every initialized Canvas, including independent Sharingan Canvases. */
export async function listInitializedDesignProjectIds(dataDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(dataDir, "projects"), { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const candidates = entries.filter((entry) => entry.isDirectory() && SAFE_PROJECT_ID.test(entry.name));
  const initialized = await Promise.all(candidates.map(async (entry) => ({
    id: entry.name,
    current: await regularFile(canvasPath(dataDir, entry.name))
      && await readCanvasActivityTimestamp(dataDir, entry.name) !== null,
  })));
  return initialized.filter((entry) => entry.current).map((entry) => entry.id).sort();
}

export async function updateDesignProject(
  dataDir: string,
  projectId: string,
  patch: { name?: string; archived?: boolean; designSystemId?: string | null },
  now = Date.now(),
): Promise<DesignProjectMetadata> {
  return withMetadataLock(dataDir, projectId, async () => {
    if (!(await regularFile(canvasPath(dataDir, projectId)))) {
      throw new DesignStorageError("not-found", "Design Project not found");
    }
    const current = await readMetadata(dataDir, projectId);
    if (!current) throw new DesignStorageError("not-found", "Design Project not found");
    const canvasUpdatedAt = await readCanvasActivityTimestamp(dataDir, projectId);
    if (canvasUpdatedAt === null) throw new DesignStorageError("not-found", "Design Project not found");
    const updatedAt = Math.max(timestamp(now, "updatedAt"), current.updatedAt, canvasUpdatedAt);
    const next: DesignProjectMetadata = {
      ...current,
      ...(patch.name === undefined ? {} : { name: projectName(patch.name) }),
      ...(patch.archived === undefined ? {} : { archivedAt: patch.archived ? updatedAt : null }),
      ...(patch.designSystemId === undefined ? {} : { designSystemId: designSystemIdOrNull(patch.designSystemId) }),
      updatedAt,
    };
    await writeAtomicJson(metadataPath(dataDir, projectId), next);
    return next;
  });
}

export function designProjectPayload(dataDir: string, project: DesignProjectMetadata): PublicDesignProject {
  return {
    id: project.projectId,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    archivedAt: project.archivedAt,
    coverUrl: `/api/projects/${encodeURIComponent(project.projectId)}/design-canvas/cover?v=${project.updatedAt}`,
    projectPath: projectRoot(dataDir, project.projectId),
    sharingan: false,
    designSystemId: project.designSystemId ?? null,
  };
}
