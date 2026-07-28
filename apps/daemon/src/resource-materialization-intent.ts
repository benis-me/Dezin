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
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { Store } from "../../../packages/core/src/index.ts";
import {
  RESOURCE_REVISION_PAYLOAD_PROTOCOL,
  resolveResourceRevisionPayloadDescriptor,
  resourceRevisionManifestRelativePath,
} from "./resource-revision-payload.ts";

const INTENT_PROTOCOL = "dezin.resource-materialization-payload-intent.v1" as const;
const INTENT_FILE = "materialization-intent.json";
const MAX_INTENT_BYTES = 16 * 1024;
const HASH_DIRECTORY = /^[a-f0-9]{64}$/;
const OWNED_TEMPORARY = /^(?:payload\.bin|manifest\.json)\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ResourceMaterializationPayloadIntent {
  protocol: typeof INTENT_PROTOCOL;
  projectId: string;
  workspaceId: string;
  resourceId: string;
  revisionId: string;
  idempotencyKey: string | null;
  manifestPath: string;
  createdAt: number;
}

export interface ResourceMaterializationPayloadRecovery {
  recovered: number;
  finalized: number;
  retained: number;
}

function exactText(value: unknown, label: string, maxLength = 1_024): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || value.includes("\0")) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactIntent(value: unknown): ResourceMaterializationPayloadIntent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Resource materialization payload intent must be an object");
  }
  const input = value as Record<string, unknown>;
  const expected = [
    "protocol",
    "projectId",
    "workspaceId",
    "resourceId",
    "revisionId",
    "idempotencyKey",
    "manifestPath",
    "createdAt",
  ];
  if (Reflect.ownKeys(input).length !== expected.length || expected.some((field) => !Object.hasOwn(input, field))) {
    throw new Error("Resource materialization payload intent has an invalid shape");
  }
  if (input.protocol !== INTENT_PROTOCOL) {
    throw new Error("Resource materialization payload intent protocol is invalid");
  }
  const projectId = exactText(input.projectId, "Resource materialization Project id");
  const workspaceId = exactText(input.workspaceId, "Resource materialization Workspace id");
  const resourceId = exactText(input.resourceId, "Resource materialization Resource id");
  const revisionId = exactText(input.revisionId, "Resource materialization Revision id");
  const idempotencyKey = input.idempotencyKey === null
    ? null
    : exactText(input.idempotencyKey, "Resource materialization idempotency key", 256);
  const manifestPath = exactText(input.manifestPath, "Resource materialization manifest path", 4_096);
  const expectedManifestPath = resourceRevisionManifestRelativePath(workspaceId, revisionId);
  if (manifestPath !== expectedManifestPath) {
    throw new Error("Resource materialization payload intent manifest identity is invalid");
  }
  if (!Number.isSafeInteger(input.createdAt) || Number(input.createdAt) < 0) {
    throw new Error("Resource materialization payload intent creation time is invalid");
  }
  return Object.freeze({
    protocol: INTENT_PROTOCOL,
    projectId,
    workspaceId,
    resourceId,
    revisionId,
    idempotencyKey,
    manifestPath,
    createdAt: Number(input.createdAt),
  });
}

function intentBytes(intent: ResourceMaterializationPayloadIntent): Buffer {
  return Buffer.from(`${JSON.stringify(intent)}\n`, "utf8");
}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readIntent(path: string): ResourceMaterializationPayloadIntent {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > MAX_INTENT_BYTES) {
    throw new Error("Resource materialization payload intent file is invalid");
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const bytes = readFileSync(fd);
    if (bytes.byteLength !== metadata.size || bytes.byteLength > MAX_INTENT_BYTES) {
      throw new Error("Resource materialization payload intent changed while being read");
    }
    const intent = exactIntent(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (!bytes.equals(intentBytes(intent))) {
      throw new Error("Resource materialization payload intent is not canonical");
    }
    return intent;
  } finally {
    closeSync(fd);
  }
}

export function resourceMaterializationPayloadIntentPath(
  dataDir: string,
  workspaceId: string,
  revisionId: string,
): string {
  const manifestPath = resourceRevisionManifestRelativePath(workspaceId, revisionId);
  return join(resolve(dataDir), dirname(manifestPath), INTENT_FILE);
}

export function beginResourceMaterializationPayloadIntent(input: {
  dataDir: string;
  projectId: string;
  workspaceId: string;
  resourceId: string;
  revisionId: string;
  idempotencyKey: string | null;
  createdAt?: number;
}): ResourceMaterializationPayloadIntent {
  const intent = exactIntent({
    protocol: INTENT_PROTOCOL,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    resourceId: input.resourceId,
    revisionId: input.revisionId,
    idempotencyKey: input.idempotencyKey,
    manifestPath: resourceRevisionManifestRelativePath(input.workspaceId, input.revisionId),
    createdAt: input.createdAt ?? Date.now(),
  });
  const path = resourceMaterializationPayloadIntentPath(input.dataDir, intent.workspaceId, intent.revisionId);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const existing = readIntent(path);
    if (intentBytes(existing).equals(intentBytes(intent))) return existing;
    throw new Error("Resource materialization payload intent identity collision");
  }
  if (existsSync(join(directory, "manifest.json")) || existsSync(join(directory, "payload.bin"))) {
    throw new Error("Resource materialization payload exists without its durable intent");
  }
  let fd: number | null = null;
  try {
    fd = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(fd, intentBytes(intent));
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    syncDirectory(directory);
    return intent;
  } catch (error) {
    if (fd !== null) closeSync(fd);
    try {
      unlinkSync(path);
      syncDirectory(directory);
    } catch {
      // Startup recovery will ignore a partial intent because payload sealing
      // cannot begin until this function has returned successfully.
    }
    throw error;
  }
}

export function completeResourceMaterializationPayloadIntent(
  dataDir: string,
  intent: ResourceMaterializationPayloadIntent,
): boolean {
  const path = resourceMaterializationPayloadIntentPath(dataDir, intent.workspaceId, intent.revisionId);
  if (!existsSync(path)) return false;
  const stored = readIntent(path);
  if (!intentBytes(stored).equals(intentBytes(exactIntent(intent)))) {
    throw new Error("Resource materialization payload intent changed before finalization");
  }
  unlinkSync(path);
  syncDirectory(dirname(path));
  return true;
}

function removeOrphanIntentDirectory(dataDir: string, intent: ResourceMaterializationPayloadIntent): void {
  const path = resourceMaterializationPayloadIntentPath(dataDir, intent.workspaceId, intent.revisionId);
  const directory = dirname(path);
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.isSymbolicLink()
      || !entry.isFile()
      || (
        entry.name !== INTENT_FILE
        && entry.name !== "manifest.json"
        && entry.name !== "payload.bin"
        && !OWNED_TEMPORARY.test(entry.name)
      )
    ) {
      throw new Error("Resource materialization orphan directory contains unowned files");
    }
  }
  const manifestPath = join(directory, "manifest.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    if (
      manifest.protocol !== RESOURCE_REVISION_PAYLOAD_PROTOCOL
      || manifest.workspaceId !== intent.workspaceId
      || manifest.resourceId !== intent.resourceId
      || manifest.resourceRevisionId !== intent.revisionId
    ) {
      throw new Error("Resource materialization orphan manifest identity changed");
    }
  }
  rmSync(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
  syncDirectory(dirname(directory));
  try {
    rmdirSync(dirname(directory));
    syncDirectory(dirname(dirname(directory)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
  }
}

export function rollbackResourceMaterializationPayloadIntent(
  dataDir: string,
  intent: ResourceMaterializationPayloadIntent,
): void {
  const path = resourceMaterializationPayloadIntentPath(dataDir, intent.workspaceId, intent.revisionId);
  if (!existsSync(path)) return;
  const stored = readIntent(path);
  if (!intentBytes(stored).equals(intentBytes(exactIntent(intent)))) {
    throw new Error("Resource materialization payload intent changed before rollback");
  }
  removeOrphanIntentDirectory(dataDir, stored);
}

function journalPaths(dataDir: string): string[] {
  const root = join(resolve(dataDir), "resource-revisions");
  if (!existsSync(root)) return [];
  const paths: string[] = [];
  for (const workspace of readdirSync(root, { withFileTypes: true })) {
    if (!workspace.isDirectory() || workspace.isSymbolicLink() || !HASH_DIRECTORY.test(workspace.name)) continue;
    const workspacePath = join(root, workspace.name);
    for (const revision of readdirSync(workspacePath, { withFileTypes: true })) {
      if (!revision.isDirectory() || revision.isSymbolicLink() || !HASH_DIRECTORY.test(revision.name)) continue;
      const path = join(workspacePath, revision.name, INTENT_FILE);
      if (existsSync(path)) paths.push(path);
    }
  }
  return paths;
}

function removeInvalidUnsealedIntent(path: string): boolean {
  const directory = dirname(path);
  const entries = readdirSync(directory, { withFileTypes: true });
  if (entries.length !== 1) return false;
  const entry = entries[0]!;
  if (entry.name !== INTENT_FILE || !entry.isFile() || entry.isSymbolicLink()) return false;
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) return false;

  // An invalid final intent can only precede payload sealing: begin() does not
  // return until the complete journal entry is fsynced. Delete it narrowly
  // without recursive removal so a concurrent or unowned file is never swept.
  unlinkSync(path);
  syncDirectory(directory);
  rmdirSync(directory);
  const workspaceDirectory = dirname(directory);
  syncDirectory(workspaceDirectory);
  try {
    rmdirSync(workspaceDirectory);
    syncDirectory(dirname(workspaceDirectory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
  }
  return true;
}

export function recoverResourceMaterializationPayloadIntents(input: {
  store: Store;
  dataDir: string;
}): ResourceMaterializationPayloadRecovery {
  const summary: ResourceMaterializationPayloadRecovery = {
    recovered: 0,
    finalized: 0,
    retained: 0,
  };
  for (const path of journalPaths(input.dataDir)) {
    try {
      const intent = readIntent(path);
      if (resourceMaterializationPayloadIntentPath(
        input.dataDir,
        intent.workspaceId,
        intent.revisionId,
      ) !== path) {
        throw new Error("Resource materialization payload intent storage identity changed");
      }
      const row = input.store.db.prepare(
        `SELECT revision.resource_id, revision.manifest_path, workspace.project_id
           FROM resource_revisions revision
           JOIN project_workspaces workspace ON workspace.id = revision.workspace_id
          WHERE revision.workspace_id = ? AND revision.id = ?`,
      ).get(intent.workspaceId, intent.revisionId) as {
        resource_id: string;
        manifest_path: string;
        project_id: string;
      } | undefined;
      if (row) {
        if (
          row.resource_id !== intent.resourceId
          || row.manifest_path !== intent.manifestPath
          || row.project_id !== intent.projectId
        ) {
          throw new Error("Committed Resource materialization does not match its durable intent");
        }
        const descriptor = resolveResourceRevisionPayloadDescriptor({
          store: input.store,
          dataDir: input.dataDir,
          workspaceId: intent.workspaceId,
          resourceRevisionId: intent.revisionId,
          expectedResourceId: intent.resourceId,
        });
        if (descriptor.manifestPath !== intent.manifestPath) {
          throw new Error("Committed Resource materialization payload path changed");
        }
        completeResourceMaterializationPayloadIntent(input.dataDir, intent);
        summary.finalized += 1;
        summary.retained += 1;
      } else {
        removeOrphanIntentDirectory(input.dataDir, intent);
      }
      summary.recovered += 1;
    } catch (error) {
      try {
        if (removeInvalidUnsealedIntent(path)) {
          summary.recovered += 1;
          continue;
        }
      } catch (cleanupError) {
        console.warn("[dezin:resource-materialization] startup recovery could not remove an invalid unsealed intent", {
          path,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
      console.warn("[dezin:resource-materialization] startup recovery retained an invalid intent", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return summary;
}
