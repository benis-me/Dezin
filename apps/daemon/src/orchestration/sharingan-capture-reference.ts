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
const MAX_BUNDLE_DIRECTORIES = 20_000;
const MAX_BUNDLE_DEPTH = 64;
const MAX_BUNDLE_BYTES = 48 * 1024 * 1024;
const MAX_FILE_BYTES = 48 * 1024 * 1024;
const MAX_PATH_BYTES = 8 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;
const BUNDLE_MOUNT = ".sharingan";
const ASSET_MOUNT = "public/_assets";
const MATERIALIZED_ROOTS = [BUNDLE_MOUNT, ASSET_MOUNT] as const;

export interface ImmutableSharinganCaptureReference {
  readonly workspaceId: string;
  /** Context Pack of the consuming Artifact Attempt, not the Resource Task that produced the Revision. */
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
  /** Keeps `.sharingan` readable for exact QA while hiding runtime-served source assets. */
  withoutMaterializedAssets<Result>(
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
  directories: number;
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

export function resolveSharinganFingerprintOpenFlags(
  source: { readonly O_NOFOLLOW?: number; readonly O_NONBLOCK?: number } = constants,
): number | null {
  if (!Number.isInteger(source.O_NOFOLLOW) || (source.O_NOFOLLOW ?? 0) <= 0
    || !Number.isInteger(source.O_NONBLOCK) || (source.O_NONBLOCK ?? 0) <= 0) {
    return null;
  }
  return source.O_NOFOLLOW! | source.O_NONBLOCK!;
}

async function hashExactFile(
  path: string,
  expectedFile: Awaited<ReturnType<typeof lstat>>,
  parentPath: string,
  expectedParent: Awaited<ReturnType<typeof lstat>>,
  signal: AbortSignal,
): Promise<string> {
  const secureFlags = resolveSharinganFingerprintOpenFlags();
  if (secureFlags === null) {
    throw new SharinganCaptureReferenceError(
      "bundle-unsafe",
      "Sharingan Capture file cannot be opened with non-blocking no-follow semantics",
    );
  }
  checkAbort(signal);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | secureFlags);
  } catch {
    throw new SharinganCaptureReferenceError("bundle-unsafe", "Sharingan Capture file could not be opened safely");
  }
  try {
    const before = await handle.stat();
    const parentBefore = await lstat(parentPath).catch(() => null);
    if (!before.isFile() || before.nlink !== 1 || !sameFile(expectedFile, before)
      || parentBefore === null || !parentBefore.isDirectory() || parentBefore.isSymbolicLink()
      || !sameFile(expectedParent, parentBefore)) {
      throw new SharinganCaptureReferenceError(
        "bundle-unsafe",
        "Sharingan Capture file or its parent changed before its fd was pinned",
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
    const [after, currentPath, parentAfter] = await Promise.all([
      handle.stat(),
      lstat(path).catch(() => null),
      lstat(parentPath).catch(() => null),
    ]);
    if (!sameFile(before, after)
      || currentPath === null || currentPath.isSymbolicLink() || !currentPath.isFile()
      || !sameFile(after, currentPath)
      || parentAfter === null || !parentAfter.isDirectory() || parentAfter.isSymbolicLink()
      || !sameFile(expectedParent, parentAfter)) {
      throw new SharinganCaptureReferenceError("bundle-unsafe", "Sharingan Capture file changed during verification");
    }
    return hash.digest("hex");
  } catch (error) {
    if (error instanceof SharinganCaptureReferenceError) throw error;
    throw new SharinganCaptureReferenceError("bundle-unsafe", "Sharingan Capture file verification failed safely");
  } finally {
    await handle.close().catch(() => {});
  }
}

async function collectFingerprintRecords(
  directory: string,
  relativeDirectory: string,
  state: FingerprintState,
  signal: AbortSignal,
  depth: number,
  afterFileLstat?: (path: string) => void | Promise<void>,
): Promise<void> {
  checkAbort(signal);
  state.directories += 1;
  if (depth > MAX_BUNDLE_DEPTH || state.directories > MAX_BUNDLE_DIRECTORIES) {
    throw new SharinganCaptureReferenceError("bundle-unbounded", "Sharingan Capture directory tree exceeds its bound");
  }
  const directoryBefore = await lstat(directory).catch(() => null);
  if (directoryBefore === null || !directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) {
    throw new SharinganCaptureReferenceError("bundle-unsafe", "Sharingan Capture directory is unsafe");
  }
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
      await collectFingerprintRecords(absolutePath, relativePath, state, signal, depth + 1, afterFileLstat);
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
    await afterFileLstat?.(absolutePath);
    checkAbort(signal);
    const checksum = await hashExactFile(absolutePath, metadata, directory, directoryBefore, signal);
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
  const directoryAfter = await lstat(directory).catch(() => null);
  if (directoryAfter === null || !directoryAfter.isDirectory() || directoryAfter.isSymbolicLink()
    || !sameFile(directoryBefore, directoryAfter)) {
    throw new SharinganCaptureReferenceError("bundle-unsafe", "Sharingan Capture directory changed during verification");
  }
}

async function bundleFingerprint(
  worktreeDir: string,
  signal: AbortSignal,
  afterFileLstat?: (path: string) => void | Promise<void>,
): Promise<string> {
  checkAbort(signal);
  let canonicalWorktree: string;
  try {
    canonicalWorktree = await realpath(worktreeDir);
  } catch {
    throw new SharinganCaptureReferenceError("bundle-missing", "Sharingan candidate worktree is missing");
  }
  const state: FingerprintState = { files: 0, directories: 0, bytes: 0, records: [] };
  for (const relativeRoot of MATERIALIZED_ROOTS) {
    const mount = join(canonicalWorktree, ...relativeRoot.split("/"));
    const metadata = await lstat(mount).catch(() => null);
    if (metadata === null) {
      if (relativeRoot === BUNDLE_MOUNT) {
        throw new SharinganCaptureReferenceError("bundle-missing", "Pinned Sharingan Capture bundle is missing");
      }
      state.records.push(JSON.stringify(["root", relativeRoot, "absent"]));
      continue;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new SharinganCaptureReferenceError("bundle-unsafe", "Pinned Sharingan Capture root is unsafe");
    }
    let canonicalMount: string;
    try {
      canonicalMount = await realpath(mount);
    } catch {
      throw new SharinganCaptureReferenceError("bundle-unsafe", "Pinned Sharingan Capture root is not resolvable");
    }
    if (canonicalMount !== resolve(canonicalWorktree, ...relativeRoot.split("/"))) {
      throw new SharinganCaptureReferenceError("bundle-unsafe", "Pinned Sharingan Capture root escaped its worktree");
    }
    state.records.push(JSON.stringify(["root", relativeRoot, metadata.mode & 0o777]));
    const filesBefore = state.files;
    const canonicalMetadata = await lstat(canonicalMount).catch(() => null);
    if (canonicalMetadata === null || !sameFile(metadata, canonicalMetadata)) {
      throw new SharinganCaptureReferenceError("bundle-unsafe", "Pinned Sharingan Capture root changed while resolving");
    }
    await collectFingerprintRecords(canonicalMount, relativeRoot, state, signal, 0, afterFileLstat);
    if (relativeRoot === BUNDLE_MOUNT && state.files === filesBefore) {
      throw new SharinganCaptureReferenceError("bundle-missing", "Pinned Sharingan Capture bundle is empty");
    }
  }
  const hash = createHash("sha256");
  hash.update("dezin.sharingan-capture-bundle-fingerprint.v2\0");
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
  /** Test seam invoked after pathname metadata is observed and before the non-blocking no-follow open. */
  afterFingerprintFileLstat?: (path: string) => void | Promise<void>;
}): Promise<SharinganCaptureBundleFence> {
  const reference = canonicalReference(input.reference);
  checkAbort(input.signal);
  let worktreeDir: string;
  try {
    worktreeDir = await realpath(input.worktreeDir);
  } catch {
    throw new SharinganCaptureReferenceError("bundle-missing", "Sharingan candidate worktree is missing");
  }
  const fingerprint = await bundleFingerprint(worktreeDir, input.signal, input.afterFingerprintFileLstat);
  const roots = await Promise.all(MATERIALIZED_ROOTS.map(async (relativeRoot) => ({
    relativeRoot,
    mount: join(worktreeDir, ...relativeRoot.split("/")),
    present: await pathExists(join(worktreeDir, ...relativeRoot.split("/"))),
  })));
  const quarantineRoot = await mkdtemp(join(dirname(worktreeDir), ".dezin-sharingan-reference-"));
  const bundleRoot = roots.find((root) => root.relativeRoot === BUNDLE_MOUNT)!;
  const assetRoot = roots.find((root) => root.relativeRoot === ASSET_MOUNT)!;
  const publicPath = join(worktreeDir, "public");
  const heldBundle = join(quarantineRoot, "bundle");
  const heldPublic = join(quarantineRoot, "public-with-pinned-assets");
  const candidatePublic = join(quarantineRoot, "candidate-public");
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
    const current = await bundleFingerprint(worktreeDir, signal, input.afterFingerprintFileLstat);
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
      let bundleHidden = false;
      let publicHidden = false;
      let conflictIndex = 0;
      const conflicts: string[] = [];
      const markConflict = (message: string): void => {
        integrityError ??= new SharinganCaptureReferenceError("bundle-operation-conflict", message);
      };
      const quarantineEntry = async (path: string): Promise<void> => {
        const destination = join(quarantineRoot, `candidate-conflict-${conflictIndex++}`);
        await rename(path, destination);
        conflicts.push(destination);
      };
      try {
        if (bundleRoot.present) {
          await rename(bundleRoot.mount, heldBundle);
          bundleHidden = true;
        }
        if (assetRoot.present) {
          const publicBefore = await lstat(publicPath);
          const canonicalPublic = await realpath(publicPath);
          if (!publicBefore.isDirectory() || publicBefore.isSymbolicLink()
            || canonicalPublic !== resolve(worktreeDir, "public")) {
            throw new SharinganCaptureReferenceError(
              "bundle-unsafe",
              "Pinned Sharingan Capture public parent is unsafe",
            );
          }
          await rename(publicPath, heldPublic);
          publicHidden = true;
          const heldBefore = await lstat(heldPublic);
          if (heldBefore.dev !== publicBefore.dev || heldBefore.ino !== publicBefore.ino) {
            throw new SharinganCaptureReferenceError(
              "bundle-operation-conflict",
              "Pinned Sharingan Capture public parent changed while it was isolated",
            );
          }
          await mkdir(publicPath, { mode: publicBefore.mode & 0o777 });
          const activePublic = await lstat(publicPath);
          const names = await readdir(heldPublic);
          names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
          if (!names.includes("_assets")) {
            throw new SharinganCaptureReferenceError("bundle-missing", "Pinned Sharingan Capture assets are missing");
          }
          for (const name of names) {
            if (name === "_assets") continue;
            safePathComponent(name);
            await rename(join(heldPublic, name), join(publicPath, name));
            const [heldNow, activeNow] = await Promise.all([lstat(heldPublic), lstat(publicPath)]);
            if (heldNow.dev !== heldBefore.dev || heldNow.ino !== heldBefore.ino
              || activeNow.dev !== activePublic.dev || activeNow.ino !== activePublic.ino) {
              throw new SharinganCaptureReferenceError(
                "bundle-operation-conflict",
                "Sharingan Capture public parents changed while source assets were isolated",
              );
            }
          }
        }
        try {
          result = await operation();
        } catch (error) {
          operationError = error;
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
          if (publicHidden && await pathExists(heldPublic)) {
            if (await pathExists(candidatePublic)) {
              await quarantineEntry(candidatePublic);
              markConflict("Candidate operation collided with Sharingan public restoration staging");
            }
            const currentPublic = await lstat(publicPath).catch(() => null);
            if (currentPublic !== null) {
              await rename(publicPath, candidatePublic);
              const isolated = await lstat(candidatePublic);
              const canonical = await realpath(candidatePublic).catch(() => "");
              if (!isolated.isDirectory() || isolated.isSymbolicLink()
                || canonical !== candidatePublic) {
                await quarantineEntry(candidatePublic);
                await mkdir(candidatePublic, { mode: 0o755 });
                markConflict("Candidate operation replaced the public parent with an unsafe entry");
              }
            } else {
              await mkdir(candidatePublic, { mode: 0o755 });
            }

            const remaining = await readdir(heldPublic);
            remaining.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
            for (const name of remaining) {
              if (name === "_assets") continue;
              safePathComponent(name);
              const destination = join(candidatePublic, name);
              if (await pathExists(destination)) {
                await quarantineEntry(join(heldPublic, name));
                markConflict("Candidate operation collided with an original public entry during restoration");
              } else {
                await rename(join(heldPublic, name), destination);
              }
            }

            const candidateAssets = join(candidatePublic, "_assets");
            if (await pathExists(candidateAssets)) {
              await quarantineEntry(candidateAssets);
              markConflict("Candidate operation recreated the reserved Sharingan Capture asset root");
            }
            await rename(join(heldPublic, "_assets"), candidateAssets);

            let installed = false;
            for (let attempt = 0; attempt < 4 && !installed; attempt += 1) {
              if (await pathExists(publicPath)) {
                await quarantineEntry(publicPath);
                markConflict("Candidate operation raced Sharingan public restoration");
              }
              try {
                await rename(candidatePublic, publicPath);
                installed = true;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
              }
            }
            if (!installed) {
              throw new SharinganCaptureReferenceError(
                "bundle-cleanup-failed",
                "Pinned Sharingan Capture public root could not be restored atomically",
              );
            }
            const restoredPublic = await lstat(publicPath);
            const restoredCanonical = await realpath(publicPath);
            if (!restoredPublic.isDirectory() || restoredPublic.isSymbolicLink()
              || restoredCanonical !== resolve(worktreeDir, "public")) {
              throw new SharinganCaptureReferenceError(
                "bundle-cleanup-failed",
                "Pinned Sharingan Capture public root escaped during restoration",
              );
            }
            publicHidden = false;
            await rm(heldPublic, { recursive: true, force: true });
          }
          if (bundleHidden && await pathExists(heldBundle)) {
            if (await pathExists(bundleRoot.mount)) {
              await quarantineEntry(bundleRoot.mount);
              markConflict("Candidate operation recreated the reserved Sharingan Capture bundle root");
            }
            await rename(heldBundle, bundleRoot.mount);
            bundleHidden = false;
          }
          for (const conflict of conflicts) {
            await rm(conflict, { recursive: true, force: true });
          }
        } catch (error) {
          integrityError = new SharinganCaptureReferenceError(
            "bundle-cleanup-failed",
            "Pinned Sharingan Capture roots could not be restored after the candidate operation",
          );
          (integrityError as Error & { cause?: unknown }).cause = error;
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
    async withoutMaterializedAssets<Result>(
      operation: () => Promise<Result>,
      signal: AbortSignal,
    ): Promise<Result> {
      return fence.withoutMaterializedBundle(async () => {
        if (!bundleRoot.present) return operation();
        if (!await pathExists(heldBundle) || await pathExists(bundleRoot.mount)) {
          throw new SharinganCaptureReferenceError(
            "bundle-operation-conflict",
            "Pinned Sharingan Capture bundle could not be exposed for asset-hidden QA",
          );
        }
        await rename(heldBundle, bundleRoot.mount);
        try {
          return await operation();
        } finally {
          if (!await pathExists(bundleRoot.mount) || await pathExists(heldBundle)) {
            throw new SharinganCaptureReferenceError(
              "bundle-cleanup-failed",
              "Pinned Sharingan Capture bundle could not be re-isolated after asset-hidden QA",
            );
          }
          await rename(bundleRoot.mount, heldBundle);
        }
      }, signal);
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
