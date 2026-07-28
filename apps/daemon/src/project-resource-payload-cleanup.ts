import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Store } from "../../../packages/core/src/index.ts";
import { resourceRevisionManifestRelativePath } from "./resource-revision-payload.ts";

const PROTOCOL = "dezin.project-resource-payload-cleanup.v2" as const;
const JOURNAL_DIRECTORY = "project-resource-cleanup";
const MAX_REVISION_ENTRIES = 100_000;
const MAX_RUN_IDS = 100_000;
const MAX_OWNED_ID_LENGTH = 256;
const OWNED_REVISION_FILE = /^(?:manifest\.json|payload\.bin|materialization-intent\.json|(?:manifest\.json|payload\.bin)\.tmp-[0-9a-f-]+)$/;
const SAFE_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_ID = "x".repeat(MAX_OWNED_ID_LENGTH);
// IDs are restricted to the ASCII SAFE_PROJECT_ID grammar below and manifest
// paths are fixed SHA-256 paths. This cap therefore accommodates the complete
// declared 100k Revision + 100k Run boundary while retaining a finite parse
// bound before JSON decoding.
const MAX_JOURNAL_BYTES = (
  Buffer.byteLength(JSON.stringify({
    resourceId: MAX_ID,
    revisionId: MAX_ID,
    manifestPath: resourceRevisionManifestRelativePath(MAX_ID, MAX_ID),
  }), "utf8") + 1
) * MAX_REVISION_ENTRIES
  + (Buffer.byteLength(JSON.stringify(MAX_ID), "utf8") + 1) * MAX_RUN_IDS
  + 64 * 1024;

interface ProjectResourcePayloadCleanupEntry {
  resourceId: string;
  revisionId: string;
  manifestPath: string;
}

export interface ProjectResourcePayloadCleanupIntent {
  protocol: typeof PROTOCOL;
  projectId: string;
  workspaceId: string | null;
  sharingan: boolean;
  runIds: readonly string[];
  revisions: readonly ProjectResourcePayloadCleanupEntry[];
  createdAt: number;
}

export interface ProjectResourcePayloadCleanupRecovery {
  recovered: number;
  rolledBack: number;
  completed: number;
  retained: number;
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function journalPath(dataDir: string, projectId: string): string {
  if (!SAFE_PROJECT_ID.test(projectId)) throw new Error("Project payload cleanup identity is invalid");
  const hash = createHash("sha256").update("dezin-project-resource-cleanup-v1\0").update(projectId).digest("hex");
  return join(resolve(dataDir), JOURNAL_DIRECTORY, `${hash}.json`);
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096 || value.includes("\0")) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function ownedId(value: unknown, label: string): string {
  const id = exactString(value, label);
  if (!SAFE_PROJECT_ID.test(id)) throw new Error(`${label} is invalid`);
  return id;
}

function normalizeIntent(value: unknown): ProjectResourcePayloadCleanupIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Project payload cleanup intent must be an object");
  }
  const input = value as Record<string, unknown>;
  const fields = ["protocol", "projectId", "workspaceId", "sharingan", "runIds", "revisions", "createdAt"];
  if (Reflect.ownKeys(input).length !== fields.length
    || fields.some((field) => !Object.hasOwn(input, field))
    || input.protocol !== PROTOCOL
    || typeof input.sharingan !== "boolean"
    || !Number.isSafeInteger(input.createdAt)
    || Number(input.createdAt) < 0
    || !Array.isArray(input.runIds)
    || input.runIds.length > MAX_RUN_IDS
    || !Array.isArray(input.revisions)
    || input.revisions.length > MAX_REVISION_ENTRIES) {
    throw new Error("Project payload cleanup intent shape is invalid");
  }
  const projectId = ownedId(input.projectId, "Project payload cleanup Project id");
  const workspaceId = input.workspaceId === null
    ? null
    : ownedId(input.workspaceId, "Project payload cleanup Workspace id");
  const runIds = input.runIds.map((value, index) => (
    ownedId(value, `Project payload cleanup Run ${index}`)
  )).sort();
  if (new Set(runIds).size !== runIds.length) {
    throw new Error("Project payload cleanup contains duplicate Runs");
  }
  const revisions = input.revisions.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Project payload cleanup Revision ${index} is invalid`);
    }
    const entry = value as Record<string, unknown>;
    const entryFields = ["resourceId", "revisionId", "manifestPath"];
    if (Reflect.ownKeys(entry).length !== entryFields.length
      || entryFields.some((field) => !Object.hasOwn(entry, field))) {
      throw new Error(`Project payload cleanup Revision ${index} shape is invalid`);
    }
    const resourceId = ownedId(entry.resourceId, `Project payload cleanup Resource ${index}`);
    const revisionId = ownedId(entry.revisionId, `Project payload cleanup Revision ${index}`);
    const manifestPath = exactString(entry.manifestPath, `Project payload cleanup manifest ${index}`);
    if (workspaceId === null
      || manifestPath !== resourceRevisionManifestRelativePath(workspaceId, revisionId)) {
      throw new Error(`Project payload cleanup manifest ${index} identity is invalid`);
    }
    return Object.freeze({ resourceId, revisionId, manifestPath });
  }).sort((left, right) => (
    left.revisionId < right.revisionId ? -1 : left.revisionId > right.revisionId ? 1 : 0
  ));
  if (new Set(revisions.map((entry) => entry.revisionId)).size !== revisions.length) {
    throw new Error("Project payload cleanup contains duplicate Revisions");
  }
  return Object.freeze({
    protocol: PROTOCOL,
    projectId,
    workspaceId,
    sharingan: input.sharingan,
    runIds: Object.freeze(runIds),
    revisions: Object.freeze(revisions),
    createdAt: Number(input.createdAt),
  });
}

function bytes(intent: ProjectResourcePayloadCleanupIntent): Buffer {
  return Buffer.from(`${JSON.stringify(intent)}\n`, "utf8");
}

function sameCleanupIdentity(
  left: ProjectResourcePayloadCleanupIntent,
  right: ProjectResourcePayloadCleanupIntent,
): boolean {
  return left.projectId === right.projectId
    && left.workspaceId === right.workspaceId
    && left.sharingan === right.sharingan
    && JSON.stringify(left.runIds) === JSON.stringify(right.runIds)
    && JSON.stringify(left.revisions) === JSON.stringify(right.revisions);
}

function readIntent(path: string): ProjectResourcePayloadCleanupIntent {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()
    || metadata.size < 2 || metadata.size > MAX_JOURNAL_BYTES) {
    throw new Error("Project payload cleanup journal is invalid");
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const value = readFileSync(fd);
    if (value.byteLength !== metadata.size) throw new Error("Project payload cleanup journal changed");
    const intent = normalizeIntent(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)));
    if (!value.equals(bytes(intent))) throw new Error("Project payload cleanup journal is not canonical");
    return intent;
  } finally {
    closeSync(fd);
  }
}

function writeIntent(
  dataDir: string,
  intent: ProjectResourcePayloadCleanupIntent,
): ProjectResourcePayloadCleanupIntent {
  const path = journalPath(dataDir, intent.projectId);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const encoded = bytes(intent);
  if (encoded.byteLength > MAX_JOURNAL_BYTES) {
    throw new Error("Project payload cleanup journal exceeds its durable byte limit");
  }
  if (existsSync(path)) {
    const existing = readIntent(path);
    if (!sameCleanupIdentity(existing, intent)) {
      throw new Error("Project payload cleanup journal identity collision");
    }
    return existing;
  }
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | null = null;
  let temporaryOwned = false;
  try {
    fd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    temporaryOwned = true;
    writeFileSync(fd, encoded);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, path);
    syncDirectory(directory);
    return intent;
  } finally {
    if (fd !== null) closeSync(fd);
    if (temporaryOwned) rmSync(temporary, { force: true });
  }
}

export function beginProjectResourcePayloadCleanup(input: {
  store: Store;
  dataDir: string;
  projectId: string;
  createdAt?: number;
}): ProjectResourcePayloadCleanupIntent {
  const project = input.store.getProject(input.projectId);
  if (!project) throw new Error("Project payload cleanup requires an owned Project");
  const workspace = input.store.workspace.getWorkspace(input.projectId);
  const revisions = workspace === null
    ? []
    : input.store.workspace.listResources(input.projectId, { includeArchived: true })
        .flatMap((resource) => input.store.workspace.listResourceRevisions(input.projectId, resource.id)
          .map((revision) => {
            const expected = resourceRevisionManifestRelativePath(workspace.id, revision.id);
            if (revision.workspaceId !== workspace.id
              || revision.resourceId !== resource.id
              || revision.manifestPath !== expected) {
              throw new Error("Project payload cleanup refused a non-owned Resource Revision");
            }
            return {
              resourceId: resource.id,
              revisionId: revision.id,
              manifestPath: expected,
            };
          }));
  const intent = normalizeIntent({
    protocol: PROTOCOL,
    projectId: project.id,
    workspaceId: workspace?.id ?? null,
    sharingan: project.sharingan,
    runIds: input.store.listRuns(input.projectId).map((run) => run.id),
    revisions,
    createdAt: input.createdAt ?? Date.now(),
  });
  return writeIntent(input.dataDir, intent);
}

function assertRevisionDirectoryRemovable(
  dataDir: string,
  entry: ProjectResourcePayloadCleanupEntry,
): string | null {
  const root = secureOwnedRoot(dataDir, "resource-revisions");
  if (root === null) return null;
  const segments = entry.manifestPath.split("/");
  if (segments.length !== 4 || segments[0] !== "resource-revisions"
    || segments[3] !== "manifest.json") {
    throw new Error("Project payload cleanup Revision path is invalid");
  }
  const workspaceDirectory = checkedOwnedTarget(root, segments[1]!);
  if (!existsSync(workspaceDirectory)) return null;
  const workspaceMetadata = lstatSync(workspaceDirectory);
  if (!workspaceMetadata.isDirectory() || workspaceMetadata.isSymbolicLink()) {
    throw new Error("Project payload cleanup retained an invalid Resource Workspace directory");
  }
  const directory = checkedOwnedTarget(root, segments[1]!, segments[2]!);
  if (!existsSync(directory)) return null;
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Project payload cleanup retained an invalid Revision directory");
  }
  for (const value of readdirSync(directory, { withFileTypes: true })) {
    if (value.isSymbolicLink() || !value.isFile() || !OWNED_REVISION_FILE.test(value.name)) {
      throw new Error("Project payload cleanup retained a Revision directory with unowned files");
    }
  }
  return directory;
}

function removeRevisionDirectory(dataDir: string, entry: ProjectResourcePayloadCleanupEntry): void {
  const directory = assertRevisionDirectoryRemovable(dataDir, entry);
  if (directory === null) return;
  rmSync(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
  syncDirectory(dirname(directory));
}

function assertSharinganStateRemovable(dataDir: string, projectId: string): string | null {
  if (!SAFE_PROJECT_ID.test(projectId)) throw new Error("Sharingan cleanup Project identity is invalid");
  const directory = secureOwnedRoot(dataDir, "sharingan-bootstrap");
  if (directory === null) return null;
  const target = checkedOwnedTarget(directory, `${projectId}.json`);
  if (!existsSync(target)) return null;
  const metadata = lstatSync(target);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Sharingan cleanup state is not an owned file");
  }
  return target;
}

function removeSharinganState(dataDir: string, projectId: string): void {
  const target = assertSharinganStateRemovable(dataDir, projectId);
  if (target === null) return;
  const directory = dirname(target);
  rmSync(target, { force: true });
  syncDirectory(directory);
}

function checkedOwnedTarget(root: string, ...segments: string[]): string {
  const target = resolve(root, ...segments);
  const owned = relative(root, target);
  if (!owned || owned === ".." || owned.startsWith(`..${sep}`) || isAbsolute(owned)) {
    throw new Error("Project payload cleanup target escapes its owned root");
  }
  return target;
}

function secureOwnedRoot(dataDir: string, name: string): string | null {
  const root = resolve(dataDir, name);
  if (!existsSync(root)) return null;
  const metadata = lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Project payload cleanup root ${name} is not an owned directory`);
  }
  return root;
}

function removeOwnedTarget(root: string, target: string): void {
  if (!existsSync(target)) return;
  const metadata = lstatSync(target);
  if (metadata.isSymbolicLink()) {
    throw new Error("Project payload cleanup refuses an owned path symbolic link");
  }
  rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
}

function assertOwnedTargetRemovable(root: string, target: string): void {
  if (!existsSync(target)) return;
  const metadata = lstatSync(target);
  if (metadata.isSymbolicLink()) {
    throw new Error("Project payload cleanup refuses an owned path symbolic link");
  }
}

const PROJECT_RUNTIME_ROOTS = Object.freeze([
  "worktrees",
  "run-worktrees",
  "version-worktrees",
  "version-evidence",
  "generation-task-evidence",
  "render-assemblies",
  "projects",
]);

function assertProjectRuntimeStateRemovable(
  dataDir: string,
  projectId: string,
  runIds: readonly string[],
): void {
  if (!SAFE_PROJECT_ID.test(projectId)) throw new Error("Project cleanup identity is invalid");
  for (const rootName of PROJECT_RUNTIME_ROOTS) {
    const root = secureOwnedRoot(dataDir, rootName);
    if (root === null) continue;
    assertOwnedTargetRemovable(root, checkedOwnedTarget(root, projectId));
  }
  const profilesRoot = secureOwnedRoot(dataDir, ".sharingan-profiles");
  if (profilesRoot !== null) {
    const profileOwner = createHash("sha256").update(projectId).digest("hex");
    assertOwnedTargetRemovable(profilesRoot, checkedOwnedTarget(profilesRoot, profileOwner));
  }
  const runsRoot = secureOwnedRoot(dataDir, ".runs");
  if (runsRoot === null) return;
  for (const runId of runIds) {
    if (!SAFE_PROJECT_ID.test(runId)) throw new Error("Project cleanup Run identity is invalid");
    assertOwnedTargetRemovable(runsRoot, checkedOwnedTarget(runsRoot, `${runId}.jsonl`));
    assertOwnedTargetRemovable(runsRoot, checkedOwnedTarget(runsRoot, runId));
  }
}

function removeProjectRuntimeState(
  dataDir: string,
  projectId: string,
  runIds: readonly string[],
): void {
  if (!SAFE_PROJECT_ID.test(projectId)) throw new Error("Project cleanup identity is invalid");
  for (const rootName of PROJECT_RUNTIME_ROOTS) {
    const root = secureOwnedRoot(dataDir, rootName);
    if (root === null) continue;
    removeOwnedTarget(root, checkedOwnedTarget(root, projectId));
    syncDirectory(root);
  }
  const profilesRoot = secureOwnedRoot(dataDir, ".sharingan-profiles");
  if (profilesRoot !== null) {
    const profileOwner = createHash("sha256").update(projectId).digest("hex");
    removeOwnedTarget(profilesRoot, checkedOwnedTarget(profilesRoot, profileOwner));
    syncDirectory(profilesRoot);
  }
  const runsRoot = secureOwnedRoot(dataDir, ".runs");
  if (runsRoot === null) return;
  for (const runId of runIds) {
    if (!SAFE_PROJECT_ID.test(runId)) throw new Error("Project cleanup Run identity is invalid");
    removeOwnedTarget(runsRoot, checkedOwnedTarget(runsRoot, `${runId}.jsonl`));
    removeOwnedTarget(runsRoot, checkedOwnedTarget(runsRoot, runId));
  }
  syncDirectory(runsRoot);
}

/**
 * Fail closed on every ownership/shape condition that cleanup itself can
 * reject. This must run after the durable journal is written and before the
 * database cascade, so an unowned filesystem entry cannot strand a deleted
 * Project in an unrecoverable cleanup loop.
 */
export function assertProjectResourcePayloadCleanupCompletable(
  dataDir: string,
  unsafeIntent: ProjectResourcePayloadCleanupIntent,
): void {
  const intent = normalizeIntent(unsafeIntent);
  const stored = readIntent(journalPath(dataDir, intent.projectId));
  if (!bytes(stored).equals(bytes(intent))) {
    throw new Error("Project payload cleanup journal changed before preflight");
  }
  for (const revision of intent.revisions) {
    assertRevisionDirectoryRemovable(dataDir, revision);
  }
  if (intent.sharingan) assertSharinganStateRemovable(dataDir, intent.projectId);
  assertProjectRuntimeStateRemovable(dataDir, intent.projectId, intent.runIds);
}

function removeJournal(dataDir: string, intent: ProjectResourcePayloadCleanupIntent): void {
  const path = journalPath(dataDir, intent.projectId);
  if (!existsSync(path)) return;
  const stored = readIntent(path);
  if (!bytes(stored).equals(bytes(normalizeIntent(intent)))) {
    throw new Error("Project payload cleanup journal changed before completion");
  }
  unlinkSync(path);
  syncDirectory(dirname(path));
}

/** Remove only the exact durable intent owned by a deletion that did not commit. */
export function rollbackProjectResourcePayloadCleanup(
  dataDir: string,
  unsafeIntent: ProjectResourcePayloadCleanupIntent,
): void {
  removeJournal(dataDir, normalizeIntent(unsafeIntent));
}

export function completeProjectResourcePayloadCleanup(
  dataDir: string,
  unsafeIntent: ProjectResourcePayloadCleanupIntent,
): void {
  const intent = normalizeIntent(unsafeIntent);
  for (const revision of intent.revisions) removeRevisionDirectory(dataDir, revision);
  if (intent.workspaceId !== null) {
    const probe = resourceRevisionManifestRelativePath(intent.workspaceId, "cleanup-probe");
    const workspaceDirectory = dirname(dirname(join(resolve(dataDir), ...probe.split("/"))));
    try {
      rmdirSync(workspaceDirectory);
      syncDirectory(dirname(workspaceDirectory));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY"
        && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (intent.sharingan) removeSharinganState(dataDir, intent.projectId);
  removeProjectRuntimeState(dataDir, intent.projectId, intent.runIds);
  removeJournal(dataDir, intent);
}

export function recoverProjectResourcePayloadCleanups(input: {
  store: Store;
  dataDir: string;
}): ProjectResourcePayloadCleanupRecovery {
  const result: ProjectResourcePayloadCleanupRecovery = {
    recovered: 0,
    rolledBack: 0,
    completed: 0,
    retained: 0,
  };
  const directory = join(resolve(input.dataDir), JOURNAL_DIRECTORY);
  if (!existsSync(directory)) return result;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    const path = join(directory, entry.name);
    try {
      const intent = readIntent(path);
      if (journalPath(input.dataDir, intent.projectId) !== path) {
        throw new Error("Project payload cleanup journal path changed");
      }
      if (input.store.getProject(intent.projectId)) {
        removeJournal(input.dataDir, intent);
        result.rolledBack += 1;
      } else {
        completeProjectResourcePayloadCleanup(input.dataDir, intent);
        result.completed += 1;
      }
      result.recovered += 1;
    } catch (error) {
      result.retained += 1;
      console.warn("[dezin:project-cleanup] retained invalid payload cleanup intent", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
