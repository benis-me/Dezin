import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { GenerationTaskFailureClass } from "../../../../packages/core/src/index.ts";
import type { StandardArtifactCandidateIdentity } from "./standard-artifact-execution.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const CONTEXT_PACK_ID = /^context-pack-([0-9a-f]{64})$/;
const MAX_BUNDLE_FILES = 20_000;
const MAX_BUNDLE_BYTES = 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_PATH_BYTES = 8 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;
const BUNDLE_MOUNT = ".sharingan";

export interface ImmutableSharinganCaptureReference {
  readonly workspaceId: string;
  readonly contextPackId: string;
  readonly contextPackHash: string;
  readonly resourceId: string;
  readonly revisionId: string;
  readonly revisionChecksum: string;
}

export interface SharinganCaptureMaterializationInput {
  /** Exact immutable identity only. A mutable capture/project path is deliberately unavailable. */
  readonly reference: ImmutableSharinganCaptureReference;
  /** Isolated Artifact candidate worktree owned by this Attempt. */
  readonly worktreeDir: string;
  readonly signal: AbortSignal;
}

export interface SharinganCaptureBundleFence {
  readonly protocol: "dezin.sharingan-capture-fence.v1";
  readonly reference: ImmutableSharinganCaptureReference;
  readonly worktreeDir: string;
  readonly mountPath: ".sharingan";
  readonly fingerprint: string;
  verify(signal: AbortSignal): Promise<void>;
  withoutMaterializedBundle<Result>(
    operation: () => Promise<Result>,
    signal: AbortSignal,
  ): Promise<Result>;
  dispose(): Promise<void>;
}

/** Task 16 supplies the ResourceRevision storage adapter behind this exact-revision-only port. */
export interface SharinganCaptureRevisionMaterializerPort {
  materializeExactRevision(
    input: SharinganCaptureMaterializationInput,
  ): Promise<SharinganCaptureBundleFence>;
}

export interface SharinganFencedCandidateTransactionPort {
  readonly dir: string;
  readonly attemptRef: string;
  fingerprint(signal: AbortSignal): Promise<string>;
  commit(message: string, signal: AbortSignal): Promise<StandardArtifactCandidateIdentity>;
  restore(candidate: StandardArtifactCandidateIdentity, signal: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}

export class SharinganCaptureReferenceError extends Error {
  readonly code:
    | "invalid-reference"
    | "bundle-missing"
    | "bundle-unsafe"
    | "bundle-unbounded"
    | "bundle-fingerprint-mismatch"
    | "bundle-operation-conflict"
    | "bundle-cleanup-failed";
  readonly failureClass: GenerationTaskFailureClass = "context";

  constructor(code: SharinganCaptureReferenceError["code"], message: string) {
    super(message);
    this.name = "SharinganCaptureReferenceError";
    this.code = code;
  }
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Sharingan Capture materialization aborted", "AbortError");
  }
}

function canonicalId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512
    || value.includes("\0") || value !== value.trim()) {
    throw new SharinganCaptureReferenceError("invalid-reference", `${label} is invalid`);
  }
  return value;
}

function canonicalReference(
  value: ImmutableSharinganCaptureReference,
): ImmutableSharinganCaptureReference {
  const contextPackId = canonicalId(value?.contextPackId, "Sharingan Context Pack id");
  const contextPackHash = canonicalId(value?.contextPackHash, "Sharingan Context Pack hash");
  const match = CONTEXT_PACK_ID.exec(contextPackId);
  if (!match || !SHA256.test(contextPackHash) || match[1] !== contextPackHash
    || typeof value?.revisionChecksum !== "string" || !SHA256.test(value.revisionChecksum)) {
    throw new SharinganCaptureReferenceError(
      "invalid-reference",
      "Sharingan Capture reference is not bound to an exact content-addressed Context Pack and Revision",
    );
  }
  return Object.freeze({
    workspaceId: canonicalId(value.workspaceId, "Sharingan Workspace id"),
    contextPackId,
    contextPackHash,
    resourceId: canonicalId(value.resourceId, "Sharingan Resource id"),
    revisionId: canonicalId(value.revisionId, "Sharingan Resource Revision id"),
    revisionChecksum: value.revisionChecksum,
  });
}

function safePathComponent(value: string): void {
  if (value.length === 0 || value === "." || value === ".." || value.toLowerCase() === ".git"
    || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new SharinganCaptureReferenceError("bundle-unsafe", "Sharingan Capture bundle contains an unsafe path");
  }
}

interface FingerprintState {
  files: number;
  bytes: number;
  readonly records: string[];
}

function sameFile(left: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>, right: typeof left): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function hashExactFile(
  path: string,
  expectedSize: number,
  signal: AbortSignal,
): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new SharinganCaptureReferenceError("bundle-unsafe", "Sharingan Capture file could not be opened safely");
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== expectedSize) {
      throw new SharinganCaptureReferenceError(
        "bundle-unsafe",
        "Sharingan Capture file is not an isolated immutable regular file",
      );
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let offset = 0;
    while (offset < before.size) {
      checkAbort(signal);
      const read = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (read.bytesRead <= 0) {
        throw new SharinganCaptureReferenceError("bundle-unsafe", "Sharingan Capture file ended during verification");
      }
      hash.update(buffer.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    const extra = await handle.read(buffer, 0, 1, offset);
    if (extra.bytesRead !== 0) {
      throw new SharinganCaptureReferenceError("bundle-unsafe", "Sharingan Capture file grew during verification");
    }
    const after = await handle.stat();
    if (!sameFile(before, after)) {
      throw new SharinganCaptureReferenceError("bundle-unsafe", "Sharingan Capture file changed during verification");
    }
    return hash.digest("hex");
  } finally {
    await handle.close().catch(() => {});
  }
}

async function collectFingerprintRecords(
  directory: string,
  relativeDirectory: string,
  state: FingerprintState,
  signal: AbortSignal,
): Promise<void> {
  checkAbort(signal);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    throw new SharinganCaptureReferenceError("bundle-missing", "Sharingan Capture bundle is missing");
  }
  names.sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  for (const name of names) {
    checkAbort(signal);
    safePathComponent(name);
    const relativePath = relativeDirectory.length === 0 ? name : `${relativeDirectory}/${name}`;
    if (Buffer.byteLength(relativePath, "utf8") > MAX_PATH_BYTES) {
      throw new SharinganCaptureReferenceError("bundle-unbounded", "Sharingan Capture bundle path exceeds its bound");
    }
    const absolutePath = join(directory, name);
    const metadata = await lstat(absolutePath).catch(() => null);
    if (!metadata || metadata.isSymbolicLink()) {
      throw new SharinganCaptureReferenceError("bundle-unsafe", "Sharingan Capture bundle cannot contain links");
    }
    if (metadata.isDirectory()) {
      state.records.push(JSON.stringify(["directory", relativePath, metadata.mode & 0o777]));
      await collectFingerprintRecords(absolutePath, relativePath, state, signal);
      continue;
    }
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new SharinganCaptureReferenceError(
        "bundle-unsafe",
        "Sharingan Capture bundle contains a non-isolated file",
      );
    }
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > MAX_FILE_BYTES
      || state.files >= MAX_BUNDLE_FILES || state.bytes > MAX_BUNDLE_BYTES - metadata.size) {
      throw new SharinganCaptureReferenceError("bundle-unbounded", "Sharingan Capture bundle exceeds its bound");
    }
    const checksum = await hashExactFile(absolutePath, metadata.size, signal);
    state.files += 1;
    state.bytes += metadata.size;
    state.records.push(JSON.stringify([
      "file",
      relativePath,
      metadata.mode & 0o777,
      metadata.size,
      checksum,
    ]));
  }
}

async function bundleFingerprint(worktreeDir: string, signal: AbortSignal): Promise<string> {
  checkAbort(signal);
  let canonicalWorktree: string;
  try {
    canonicalWorktree = await realpath(worktreeDir);
  } catch {
    throw new SharinganCaptureReferenceError("bundle-missing", "Sharingan candidate worktree is missing");
  }
  const mount = join(canonicalWorktree, BUNDLE_MOUNT);
  const metadata = await lstat(mount).catch(() => null);
  if (!metadata || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new SharinganCaptureReferenceError("bundle-missing", "Pinned Sharingan Capture bundle is missing");
  }
  let canonicalMount: string;
  try {
    canonicalMount = await realpath(mount);
  } catch {
    throw new SharinganCaptureReferenceError("bundle-unsafe", "Pinned Sharingan Capture bundle is not resolvable");
  }
  if (canonicalMount !== resolve(canonicalWorktree, BUNDLE_MOUNT)) {
    throw new SharinganCaptureReferenceError("bundle-unsafe", "Pinned Sharingan Capture bundle escaped its worktree");
  }
  const state: FingerprintState = { files: 0, bytes: 0, records: [] };
  await collectFingerprintRecords(canonicalMount, "", state, signal);
  if (state.files === 0 || state.bytes === 0) {
    throw new SharinganCaptureReferenceError("bundle-missing", "Pinned Sharingan Capture bundle is empty");
  }
  const hash = createHash("sha256");
  hash.update("dezin.sharingan-capture-bundle-fingerprint.v1\0");
  for (const record of state.records) hash.update(record).update("\n");
  return hash.digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

export async function createSharinganCaptureBundleFence(input: {
  reference: ImmutableSharinganCaptureReference;
  worktreeDir: string;
  signal: AbortSignal;
}): Promise<SharinganCaptureBundleFence> {
  const reference = canonicalReference(input.reference);
  checkAbort(input.signal);
  let worktreeDir: string;
  try {
    worktreeDir = await realpath(input.worktreeDir);
  } catch {
    throw new SharinganCaptureReferenceError("bundle-missing", "Sharingan candidate worktree is missing");
  }
  const fingerprint = await bundleFingerprint(worktreeDir, input.signal);
  const mount = join(worktreeDir, BUNDLE_MOUNT);
  const quarantineRoot = await mkdtemp(join(dirname(worktreeDir), ".dezin-sharingan-reference-"));
  const heldBundle = join(quarantineRoot, "bundle");
  let disposed = false;
  let busy = false;

  const verify = async (signal: AbortSignal): Promise<void> => {
    checkAbort(signal);
    if (disposed) {
      throw new SharinganCaptureReferenceError("bundle-cleanup-failed", "Sharingan Capture fence is disposed");
    }
    if (busy) {
      throw new SharinganCaptureReferenceError(
        "bundle-operation-conflict",
        "Sharingan Capture bundle is hidden by a candidate transaction",
      );
    }
    const current = await bundleFingerprint(worktreeDir, signal);
    if (current !== fingerprint) {
      throw new SharinganCaptureReferenceError(
        "bundle-fingerprint-mismatch",
        "Pinned Sharingan Capture bundle fingerprint changed",
      );
    }
  };

  const fence: SharinganCaptureBundleFence = {
    protocol: "dezin.sharingan-capture-fence.v1",
    reference,
    worktreeDir,
    mountPath: BUNDLE_MOUNT,
    fingerprint,
    verify,
    async withoutMaterializedBundle<Result>(
      operation: () => Promise<Result>,
      signal: AbortSignal,
    ): Promise<Result> {
      if (busy) {
        throw new SharinganCaptureReferenceError(
          "bundle-operation-conflict",
          "Sharingan Capture candidate operation overlapped another operation",
        );
      }
      await verify(signal);
      if (busy) {
        throw new SharinganCaptureReferenceError(
          "bundle-operation-conflict",
          "Sharingan Capture candidate operation overlapped another operation",
        );
      }
      busy = true;
      let result: Result | undefined;
      let operationError: unknown = null;
      let integrityError: unknown = null;
      try {
        await rename(mount, heldBundle);
        try {
          result = await operation();
        } catch (error) {
          operationError = error;
        }
        if (await pathExists(mount)) {
          integrityError = new SharinganCaptureReferenceError(
            "bundle-operation-conflict",
            "Candidate operation recreated the reserved Sharingan Capture mount",
          );
          await rm(mount, { recursive: true, force: true }).catch(() => {});
        }
      } catch (error) {
        integrityError = error instanceof SharinganCaptureReferenceError
          ? error
          : new SharinganCaptureReferenceError(
            "bundle-operation-conflict",
            "Sharingan Capture bundle could not be isolated from the candidate operation",
          );
      } finally {
        try {
          await mkdir(worktreeDir, { recursive: true });
          if (await pathExists(heldBundle)) await rename(heldBundle, mount);
        } catch {
          integrityError = new SharinganCaptureReferenceError(
            "bundle-cleanup-failed",
            "Pinned Sharingan Capture bundle could not be restored after the candidate operation",
          );
        }
        busy = false;
      }
      try {
        await verify(signal);
      } catch (error) {
        integrityError = error;
      }
      if (integrityError !== null) throw integrityError;
      if (operationError !== null) throw operationError;
      return result as Result;
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      if (busy) {
        throw new SharinganCaptureReferenceError(
          "bundle-cleanup-failed",
          "Sharingan Capture fence cannot be disposed during a candidate operation",
        );
      }
      disposed = true;
      await rm(quarantineRoot, { recursive: true, force: true });
    },
  };
  return Object.freeze(fence);
}

export function fenceArtifactCandidateTransaction(
  transaction: SharinganFencedCandidateTransactionPort,
  fence: SharinganCaptureBundleFence,
): SharinganFencedCandidateTransactionPort {
  let transactionDir: string;
  try {
    transactionDir = realpathSync(transaction.dir);
  } catch {
    transactionDir = resolve(transaction.dir);
  }
  if (transactionDir !== resolve(fence.worktreeDir)) {
    throw new SharinganCaptureReferenceError(
      "invalid-reference",
      "Sharingan Capture fence is scoped to another candidate worktree",
    );
  }
  let disposed = false;
  return Object.freeze({
    dir: transaction.dir,
    attemptRef: transaction.attemptRef,
    fingerprint(signal: AbortSignal) {
      return fence.withoutMaterializedBundle(() => transaction.fingerprint(signal), signal);
    },
    commit(message: string, signal: AbortSignal) {
      return fence.withoutMaterializedBundle(() => transaction.commit(message, signal), signal);
    },
    restore(candidate: StandardArtifactCandidateIdentity, signal: AbortSignal) {
      return fence.withoutMaterializedBundle(() => transaction.restore(candidate, signal), signal);
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      let fenceError: unknown = null;
      try {
        await fence.dispose();
      } catch (error) {
        fenceError = error;
      }
      try {
        await transaction.dispose();
      } catch (error) {
        if (fenceError === null) throw error;
      }
      if (fenceError !== null) throw fenceError;
    },
  });
}
