import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { isDeepStrictEqual, types as nodeUtilTypes } from "node:util";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import type { GenerationTaskFailureClass } from "../../../../packages/core/src/index.ts";
import {
  createSharinganCaptureBundleFence,
  type ImmutableSharinganCaptureReference,
  type SharinganCaptureBundleFence,
  type SharinganCaptureMaterializationInput,
  type SharinganCaptureRevisionMaterializerPort,
} from "./sharingan-capture-reference.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const CONTEXT_PACK_ID = /^context-pack-([a-f0-9]{64})$/;
const BUNDLE_MOUNT = ".sharingan";
const ASSET_MOUNT = join("public", "_assets");
const MAX_STAGED_FILES = 20_000;
const MAX_STAGED_DIRECTORIES = 20_000;
const MAX_STAGED_DEPTH = 64;
const MAX_STAGED_BYTES = 48 * 1024 * 1024;
const MAX_STAGED_FILE_BYTES = 48 * 1024 * 1024;
const MAX_STAGED_PATH_BYTES = 8 * 1024;

export interface SharinganCaptureRevisionMaterializationReceipt
  extends ImmutableSharinganCaptureReference {
  readonly protocol: "dezin.sharingan-capture-materialization.v2";
  /** Canonical exact file set decoded from the content-addressed ResourceRevision. */
  readonly files: readonly SharinganCaptureRevisionMaterializedFile[];
}

export interface SharinganCaptureRevisionMaterializedFile {
  readonly path: string;
  readonly mode: 0o444;
  readonly byteLength: number;
  readonly checksum: string;
}

export interface SharinganCaptureRevisionBundleSourcePort {
  materializeExactRevision(input: {
    readonly reference: ImmutableSharinganCaptureReference;
    /** Empty daemon-owned staging directory; never the candidate mount path. */
    readonly destinationDir: string;
    readonly signal: AbortSignal;
  }): Promise<SharinganCaptureRevisionMaterializationReceipt>;
}

export class ProductionSharinganCaptureRevisionMaterializerError extends Error {
  readonly code:
    | "SHARINGAN_CAPTURE_SOURCE_UNAVAILABLE"
    | "SHARINGAN_CAPTURE_REFERENCE_INVALID"
    | "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED"
    | "SHARINGAN_CAPTURE_WORKTREE_UNAVAILABLE"
    | "SHARINGAN_CAPTURE_MOUNT_COLLISION"
    | "SHARINGAN_CAPTURE_STAGING_FAILED"
    | "SHARINGAN_CAPTURE_CLEANUP_FAILED";
  readonly failureClass: GenerationTaskFailureClass;

  constructor(
    code: ProductionSharinganCaptureRevisionMaterializerError["code"],
    message: string,
    failureClass: GenerationTaskFailureClass,
    cause?: unknown,
  ) {
    super(message);
    this.name = "ProductionSharinganCaptureRevisionMaterializerError";
    this.code = code;
    this.failureClass = failureClass;
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Sharingan Capture Revision materialization aborted", "AbortError");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

async function invokeWithAbort<T>(
  signal: AbortSignal,
  operation: () => T | PromiseLike<T>,
): Promise<T> {
  checkAbort(signal);
  const value = Promise.resolve().then(operation);
  let listener: (() => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(abortReason(signal));
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    checkAbort(signal);
    return await Promise.race([value, aborted]);
  } finally {
    if (listener !== null) signal.removeEventListener("abort", listener);
  }
}

function canonicalText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512
    || value !== value.trim() || value.includes("\0")) {
    throw new ProductionSharinganCaptureRevisionMaterializerError(
      "SHARINGAN_CAPTURE_REFERENCE_INVALID",
      `${label} is invalid`,
      "context",
    );
  }
  return value;
}

function canonicalReference(
  value: ImmutableSharinganCaptureReference,
): ImmutableSharinganCaptureReference {
  const contextPackId = canonicalText(value?.contextPackId, "Sharingan Context Pack id");
  const contextPackHash = canonicalText(value?.contextPackHash, "Sharingan Context Pack hash");
  const match = CONTEXT_PACK_ID.exec(contextPackId);
  if (!match || match[1] !== contextPackHash || !SHA256.test(contextPackHash)
    || typeof value?.revisionChecksum !== "string" || !SHA256.test(value.revisionChecksum)) {
    throw new ProductionSharinganCaptureRevisionMaterializerError(
      "SHARINGAN_CAPTURE_REFERENCE_INVALID",
      "Sharingan Capture reference is not bound to an exact Context Pack and Revision checksum",
      "context",
    );
  }
  return Object.freeze({
    workspaceId: canonicalText(value.workspaceId, "Sharingan Workspace id"),
    contextPackId,
    contextPackHash,
    resourceId: canonicalText(value.resourceId, "Sharingan Resource id"),
    revisionId: canonicalText(value.revisionId, "Sharingan Resource Revision id"),
    revisionChecksum: value.revisionChecksum,
  });
}

function exactReceiptFiles(value: unknown): readonly SharinganCaptureRevisionMaterializedFile[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || value.length < 2
    || value.length > MAX_STAGED_FILES) {
    throw new ProductionSharinganCaptureRevisionMaterializerError(
      "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
      "Sharingan Capture exact-Revision file manifest is invalid",
      "context",
    );
  }
  let arrayDescriptors: PropertyDescriptorMap;
  try {
    arrayDescriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
  } catch (error) {
    throw new ProductionSharinganCaptureRevisionMaterializerError(
      "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
      "Sharingan Capture exact-Revision file manifest could not be inspected",
      "context",
      error,
    );
  }
  const arrayKeys = Reflect.ownKeys(arrayDescriptors);
  const expectedArrayKeys = new Set<string>([
    ...Array.from({ length: value.length }, (_item, index) => String(index)),
    "length",
  ]);
  if (arrayKeys.length !== expectedArrayKeys.size
    || arrayKeys.some((key) => typeof key !== "string" || !expectedArrayKeys.has(key))) {
    throw new ProductionSharinganCaptureRevisionMaterializerError(
      "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
      "Sharingan Capture exact-Revision file manifest contains non-canonical fields",
      "context",
    );
  }
  const files: SharinganCaptureRevisionMaterializedFile[] = [];
  const fields = ["path", "mode", "byteLength", "checksum"] as const;
  let previousPath = "";
  let totalBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const slot = arrayDescriptors[String(index)];
    const raw = slot && slot.enumerable && "value" in slot ? slot.value : null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || nodeUtilTypes.isProxy(raw)) {
      throw new ProductionSharinganCaptureRevisionMaterializerError(
        "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
        "Sharingan Capture exact-Revision file manifest entry is invalid",
        "context",
      );
    }
    let prototype: object | null;
    let descriptors: PropertyDescriptorMap;
    try {
      prototype = Object.getPrototypeOf(raw);
      descriptors = Object.getOwnPropertyDescriptors(raw);
    } catch (error) {
      throw new ProductionSharinganCaptureRevisionMaterializerError(
        "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
        "Sharingan Capture exact-Revision file manifest entry could not be inspected",
        "context",
        error,
      );
    }
    const keys = Reflect.ownKeys(descriptors);
    if ((prototype !== Object.prototype && prototype !== null) || keys.length !== fields.length
      || keys.some((key) => typeof key !== "string" || !fields.includes(key as typeof fields[number]))) {
      throw new ProductionSharinganCaptureRevisionMaterializerError(
        "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
        "Sharingan Capture exact-Revision file manifest entry fields are invalid",
        "context",
      );
    }
    const item: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new ProductionSharinganCaptureRevisionMaterializerError(
          "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
          "Sharingan Capture exact-Revision file manifest entry is not plain data",
          "context",
        );
      }
      item[field] = descriptor.value;
    }
    const path = item.path;
    const segments = typeof path === "string" ? path.split("/") : [];
    const rootQualified = typeof path === "string"
      && (path.startsWith(".sharingan/") || path.startsWith("public/_assets/"));
    if (!rootQualified || typeof path !== "string" || path.length === 0
      || Buffer.byteLength(path, "utf8") > MAX_STAGED_PATH_BYTES
      || !/^[A-Za-z0-9._/-]+$/.test(path)
      || segments.some((segment) => !safeName(segment))
      || (previousPath !== "" && Buffer.compare(Buffer.from(previousPath), Buffer.from(path)) >= 0)
      || item.mode !== 0o444 || !Number.isSafeInteger(item.byteLength)
      || (item.byteLength as number) < 0 || (item.byteLength as number) > MAX_STAGED_FILE_BYTES
      || typeof item.checksum !== "string" || !SHA256.test(item.checksum)
      || totalBytes > MAX_STAGED_BYTES - (item.byteLength as number)) {
      throw new ProductionSharinganCaptureRevisionMaterializerError(
        "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
        "Sharingan Capture exact-Revision file manifest is unsafe or non-canonical",
        "context",
      );
    }
    totalBytes += item.byteLength as number;
    previousPath = path;
    files.push(Object.freeze({
      path,
      mode: 0o444,
      byteLength: item.byteLength as number,
      checksum: item.checksum,
    }));
  }
  if (!files.some((file) => file.path === ".sharingan/pages.json")
    || !files.some((file) => file.path === ".sharingan/probe.mjs")) {
    throw new ProductionSharinganCaptureRevisionMaterializerError(
      "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
      "Sharingan Capture exact-Revision file manifest omitted required control files",
      "context",
    );
  }
  return Object.freeze(files);
}

function exactReceipt(
  value: unknown,
  reference: ImmutableSharinganCaptureReference,
): SharinganCaptureRevisionMaterializationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    throw new ProductionSharinganCaptureRevisionMaterializerError(
      "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
      "Sharingan Capture source returned an invalid exact-Revision receipt",
      "context",
    );
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    throw new ProductionSharinganCaptureRevisionMaterializerError(
      "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
      "Sharingan Capture exact-Revision receipt could not be inspected",
      "context",
      error,
    );
  }
  const fields = [
    "protocol",
    "workspaceId",
    "contextPackId",
    "contextPackHash",
    "resourceId",
    "revisionId",
    "revisionChecksum",
    "files",
  ] as const;
  const keys = Reflect.ownKeys(descriptors);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.length !== fields.length
    || keys.some((key) => typeof key !== "string" || !fields.includes(key as typeof fields[number]))) {
    throw new ProductionSharinganCaptureRevisionMaterializerError(
      "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
      "Sharingan Capture exact-Revision receipt fields are invalid",
      "context",
    );
  }
  const record: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new ProductionSharinganCaptureRevisionMaterializerError(
        "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
        `Sharingan Capture exact-Revision receipt field ${field} is not plain data`,
        "context",
      );
    }
    record[field] = descriptor.value;
  }
  const normalized = {
    protocol: record.protocol,
    workspaceId: record.workspaceId,
    contextPackId: record.contextPackId,
    contextPackHash: record.contextPackHash,
    resourceId: record.resourceId,
    revisionId: record.revisionId,
    revisionChecksum: record.revisionChecksum,
  };
  if (!isDeepStrictEqual(normalized, {
    protocol: "dezin.sharingan-capture-materialization.v2",
    ...reference,
  })) {
    throw new ProductionSharinganCaptureRevisionMaterializerError(
      "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
      "Sharingan Capture source substituted the immutable Resource Revision identity",
      "context",
    );
  }
  return Object.freeze({
    ...normalized,
    files: exactReceiptFiles(record.files),
  }) as SharinganCaptureRevisionMaterializationReceipt;
}

function sourceMethod(
  source: unknown,
): SharinganCaptureRevisionBundleSourcePort["materializeExactRevision"] | null {
  if (!source || (typeof source !== "object" && typeof source !== "function")
    || nodeUtilTypes.isProxy(source)) return null;
  let cursor: object | null = source;
  try {
    while (cursor !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(cursor, "materializeExactRevision");
      if (descriptor !== undefined) {
        return "value" in descriptor && typeof descriptor.value === "function"
          ? descriptor.value.bind(source) as SharinganCaptureRevisionBundleSourcePort["materializeExactRevision"]
          : null;
      }
      cursor = Object.getPrototypeOf(cursor);
    }
  } catch {
    return null;
  }
  return null;
}

function sourceConfiguration(value: unknown): { source: unknown } | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const source = descriptors.source;
    if ((prototype !== Object.prototype && prototype !== null)
      || keys.length !== 1 || keys[0] !== "source"
      || !source || !source.enumerable || !("value" in source)) return null;
    return { source: source.value };
  } catch {
    return null;
  }
}

function declaredFailure(error: unknown): boolean {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return false;
  try {
    return typeof Reflect.get(error, "failureClass") === "string";
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

type EntryIdentity = Pick<Awaited<ReturnType<typeof lstat>>, "dev" | "ino">;

function sameEntry(left: EntryIdentity, right: EntryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

interface DirectoryFence {
  readonly path: string;
  readonly identity: EntryIdentity;
  readonly canonical: string;
}

async function assertDirectoryFence(fence: DirectoryFence): Promise<void> {
  const current = await lstat(fence.path).catch(() => null);
  const canonical = await realpath(fence.path).catch(() => "");
  if (current === null || !current.isDirectory() || current.isSymbolicLink()
    || !sameEntry(current, fence.identity) || canonical !== fence.canonical) {
    throw new ProductionSharinganCaptureRevisionMaterializerError(
      "SHARINGAN_CAPTURE_MOUNT_COLLISION",
      "Sharingan Capture installation parent changed during an exact filesystem operation",
      "context",
    );
  }
}

async function removeOwnedMount(
  mount: string,
  identity: EntryIdentity,
  parentFences: readonly DirectoryFence[] = [],
): Promise<void> {
  for (const fence of parentFences) await assertDirectoryFence(fence);
  const current = await lstat(mount).catch(() => null);
  if (current === null) return;
  if (!sameEntry(current, identity)) {
    throw new ProductionSharinganCaptureRevisionMaterializerError(
      "SHARINGAN_CAPTURE_CLEANUP_FAILED",
      "Sharingan Capture mount changed before owned staging cleanup",
      "storage",
    );
  }
  try {
    await rm(mount, { recursive: true, force: true });
  } catch (error) {
    throw new ProductionSharinganCaptureRevisionMaterializerError(
      "SHARINGAN_CAPTURE_CLEANUP_FAILED",
      "Sharingan Capture owned mount could not be removed",
      "storage",
      error,
    );
  }
}

async function removeOwnedParent(path: string, identity: EntryIdentity): Promise<void> {
  const current = await lstat(path).catch(() => null);
  if (current === null) return;
  if (!current.isDirectory() || current.isSymbolicLink() || !sameEntry(current, identity)) {
    throw new ProductionSharinganCaptureRevisionMaterializerError(
      "SHARINGAN_CAPTURE_CLEANUP_FAILED",
      "Sharingan Capture owned public parent changed before cleanup",
      "storage",
    );
  }
  try {
    await rmdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") {
      throw new ProductionSharinganCaptureRevisionMaterializerError(
        "SHARINGAN_CAPTURE_CLEANUP_FAILED",
        "Sharingan Capture owned public parent could not be removed",
        "storage",
        error,
      );
    }
  }
}

function safeName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && name.toLowerCase() !== ".git"
    && !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}

type StableEntry = Pick<Awaited<ReturnType<typeof lstat>>,
  "dev" | "ino" | "mode" | "nlink" | "size" | "mtimeMs" | "ctimeMs">;

function sameStableEntry(left: StableEntry, right: StableEntry): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function hashExactStagedFile(
  path: string,
  expectedSize: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW <= 0
    || !Number.isInteger(constants.O_NONBLOCK) || constants.O_NONBLOCK <= 0) {
    throw new ProductionSharinganCaptureRevisionMaterializerError(
      "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
      "Sharingan Capture exact file verification requires no-follow non-blocking opens",
      "context",
    );
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw new ProductionSharinganCaptureRevisionMaterializerError(
      "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
      "Sharingan Capture exact file could not be opened safely",
      "context",
      error,
    );
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== expectedSize
      || (before.mode & 0o777) !== 0o444) {
      throw new ProductionSharinganCaptureRevisionMaterializerError(
        "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
        "Sharingan Capture exact file metadata differs from its Revision manifest",
        "context",
      );
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let offset = 0;
    while (offset < before.size) {
      if (signal) checkAbort(signal);
      const read = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (read.bytesRead <= 0) {
        throw new ProductionSharinganCaptureRevisionMaterializerError(
          "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
          "Sharingan Capture exact file ended during verification",
          "context",
        );
      }
      hash.update(buffer.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    if ((await handle.read(buffer, 0, 1, offset)).bytesRead !== 0) {
      throw new ProductionSharinganCaptureRevisionMaterializerError(
        "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
        "Sharingan Capture exact file grew during verification",
        "context",
      );
    }
    const after = await handle.stat();
    const current = await lstat(path).catch(() => null);
    if (current === null || current.isSymbolicLink() || !sameStableEntry(before, after)
      || !sameStableEntry(before, current)) {
      throw new ProductionSharinganCaptureRevisionMaterializerError(
        "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
        "Sharingan Capture exact file changed during verification",
        "context",
      );
    }
    return hash.digest("hex");
  } finally {
    await handle.close().catch(() => {});
  }
}

async function collectMaterializedFiles(
  bundle: string,
  signal?: AbortSignal,
): Promise<readonly SharinganCaptureRevisionMaterializedFile[]> {
  const canonicalBundle = await realpath(bundle);
  const observed: SharinganCaptureRevisionMaterializedFile[] = [];
  let files = 0;
  let directories = 0;
  let bytes = 0;
  const visit = async (directory: string, relativeDirectory: string, depth: number): Promise<void> => {
    if (signal) checkAbort(signal);
    directories += 1;
    if (depth > MAX_STAGED_DEPTH || directories > MAX_STAGED_DIRECTORIES) {
      throw new ProductionSharinganCaptureRevisionMaterializerError(
        "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
        "Sharingan Capture source directory count exceeds its bound",
        "context",
      );
    }
    const before = await lstat(directory);
    const canonical = await realpath(directory);
    if (!before.isDirectory() || before.isSymbolicLink() || !inside(canonicalBundle, canonical)) {
      throw new ProductionSharinganCaptureRevisionMaterializerError(
        "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
        "Sharingan Capture source returned an unsafe directory",
        "context",
      );
    }
    const names = await readdir(directory);
    names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    for (const name of names) {
      if (signal) checkAbort(signal);
      if (!safeName(name)) {
        throw new ProductionSharinganCaptureRevisionMaterializerError(
          "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
          "Sharingan Capture source returned an unsafe path",
          "context",
        );
      }
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (Buffer.byteLength(relativePath, "utf8") > MAX_STAGED_PATH_BYTES) {
        throw new ProductionSharinganCaptureRevisionMaterializerError(
          "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
          "Sharingan Capture source path exceeds its bound",
          "context",
        );
      }
      const path = join(directory, name);
      const child = await lstat(path);
      if (child.isSymbolicLink()) {
        throw new ProductionSharinganCaptureRevisionMaterializerError(
          "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
          "Sharingan Capture source returned a symbolic link",
          "context",
        );
      }
      if (child.isDirectory()) {
        await visit(path, relativePath, depth + 1);
        continue;
      }
      if (!child.isFile() || child.nlink !== 1 || !Number.isSafeInteger(child.size)
        || child.size < 0 || child.size > MAX_STAGED_FILE_BYTES
        || files >= MAX_STAGED_FILES || bytes > MAX_STAGED_BYTES - child.size) {
        throw new ProductionSharinganCaptureRevisionMaterializerError(
          "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
          "Sharingan Capture source returned an unsafe or unbounded file",
          "context",
        );
      }
      const checksum = await hashExactStagedFile(path, child.size, signal);
      files += 1;
      bytes += child.size;
      observed.push(Object.freeze({
        path: relativePath,
        mode: 0o444,
        byteLength: child.size,
        checksum,
      }));
    }
    const afterNames = await readdir(directory);
    afterNames.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    const after = await lstat(directory);
    if (!isDeepStrictEqual(afterNames, names) || !sameStableEntry(before, after)) {
      throw new ProductionSharinganCaptureRevisionMaterializerError(
        "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
        "Sharingan Capture source directory changed during verification",
        "context",
      );
    }
  };
  await visit(join(bundle, ".sharingan"), ".sharingan", 0);
  await visit(join(bundle, "public", "_assets"), "public/_assets", 0);
  observed.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return Object.freeze(observed);
}

async function validateStagedTree(
  bundle: string,
  expected: readonly SharinganCaptureRevisionMaterializedFile[],
  signal?: AbortSignal,
): Promise<void> {
  const top = await readdir(bundle);
  top.sort();
  if (!isDeepStrictEqual(top, [".sharingan", "public"])) {
    throw new ProductionSharinganCaptureRevisionMaterializerError(
      "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
      "Sharingan Capture source returned missing or extra materialization roots",
      "context",
    );
  }
  const publicEntries = await readdir(join(bundle, "public"));
  publicEntries.sort();
  if (!isDeepStrictEqual(publicEntries, ["_assets"])) {
    throw new ProductionSharinganCaptureRevisionMaterializerError(
      "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
      "Sharingan Capture source returned missing or extra public roots",
      "context",
    );
  }
  const observed = await collectMaterializedFiles(bundle, signal);
  if (!isDeepStrictEqual(observed, expected)) {
    throw new ProductionSharinganCaptureRevisionMaterializerError(
      "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
      "Sharingan Capture staged paths or bytes differ from the exact Resource Revision manifest",
      "context",
    );
  }
}

async function existingDirectory(path: string, expectedCanonical: string): Promise<EntryIdentity | null> {
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null) return null;
  const canonical = await realpath(path).catch(() => "");
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== expectedCanonical) {
    throw new ProductionSharinganCaptureRevisionMaterializerError(
      "SHARINGAN_CAPTURE_MOUNT_COLLISION",
      "Sharingan Capture public parent is unsafe",
      "context",
    );
  }
  return metadata;
}

async function removeStagingRoot(stagingRoot: string): Promise<void> {
  try {
    await rm(stagingRoot, { recursive: true, force: true });
  } catch (error) {
    throw new ProductionSharinganCaptureRevisionMaterializerError(
      "SHARINGAN_CAPTURE_CLEANUP_FAILED",
      "Sharingan Capture staging directory could not be removed",
      "storage",
      error,
    );
  }
}

/**
 * Exact ResourceRevision-to-worktree materializer. The source can write only an
 * empty staging directory and must return an exact identity receipt. This
 * adapter reserves and installs both `.sharingan` and `public/_assets`,
 * validates every file through the shared fingerprint fence, and never
 * replaces preexisting worktree content.
 */
export class ProductionSharinganCaptureRevisionMaterializer
implements SharinganCaptureRevisionMaterializerPort {
  readonly #materialize: SharinganCaptureRevisionBundleSourcePort["materializeExactRevision"];

  constructor(options: { readonly source: SharinganCaptureRevisionBundleSourcePort }) {
    const configuration = sourceConfiguration(options);
    const materialize = sourceMethod(configuration?.source);
    if (materialize === null) {
      throw new ProductionSharinganCaptureRevisionMaterializerError(
        "SHARINGAN_CAPTURE_SOURCE_UNAVAILABLE",
        "Sharingan Capture exact Resource Revision source is unavailable",
        "adapter",
      );
    }
    this.#materialize = materialize;
  }

  async materializeExactRevision(
    input: SharinganCaptureMaterializationInput,
  ): Promise<SharinganCaptureBundleFence> {
    const reference = canonicalReference(input.reference);
    checkAbort(input.signal);
    let worktreeDir: string;
    try {
      worktreeDir = await realpath(input.worktreeDir);
    } catch (error) {
      throw new ProductionSharinganCaptureRevisionMaterializerError(
        "SHARINGAN_CAPTURE_WORKTREE_UNAVAILABLE",
        "Sharingan Capture candidate worktree is unavailable",
        "build-infrastructure",
        error,
      );
    }
    const worktreeIdentity = await lstat(worktreeDir);
    const worktreeFence: DirectoryFence = Object.freeze({
      path: worktreeDir,
      identity: worktreeIdentity,
      canonical: worktreeDir,
    });
    const mount = join(worktreeDir, BUNDLE_MOUNT);
    const assetMount = join(worktreeDir, ASSET_MOUNT);
    if (await exists(mount) || await exists(assetMount)) {
      throw new ProductionSharinganCaptureRevisionMaterializerError(
        "SHARINGAN_CAPTURE_MOUNT_COLLISION",
        "Sharingan Capture candidate worktree already contains a reserved materialization root",
        "context",
      );
    }
    const stagingRoot = await mkdtemp(join(dirname(worktreeDir), ".dezin-sharingan-materialize-"))
      .catch((error) => {
        throw new ProductionSharinganCaptureRevisionMaterializerError(
          "SHARINGAN_CAPTURE_STAGING_FAILED",
          "Sharingan Capture staging directory could not be allocated",
          "storage",
          error,
        );
      });
    const bundle = join(stagingRoot, "bundle");
    const stagedPublic = join(bundle, "candidate-public-install");
    let mountedIdentity: EntryIdentity | null = null;
    let assetMountedIdentity: EntryIdentity | null = null;
    let createdPublicIdentity: EntryIdentity | null = null;
    let originalPublicIdentity: EntryIdentity | null = null;
    let stagedPublicIdentity: EntryIdentity | null = null;
    let publicFence: DirectoryFence | null = null;
    let fence: SharinganCaptureBundleFence | null = null;
    try {
      await mkdir(bundle);
      let receipt: SharinganCaptureRevisionMaterializationReceipt;
      try {
        receipt = await invokeWithAbort(
          input.signal,
          () => this.#materialize(Object.freeze({
            reference,
            destinationDir: bundle,
            signal: input.signal,
          })),
        );
      } catch (error) {
        if (input.signal.aborted) throw abortReason(input.signal);
        if (declaredFailure(error)) throw error;
        throw new ProductionSharinganCaptureRevisionMaterializerError(
          "SHARINGAN_CAPTURE_SOURCE_UNAVAILABLE",
          "Sharingan Capture exact Resource Revision source failed",
          "adapter",
          error,
        );
      }
      checkAbort(input.signal);
      const exact = exactReceipt(receipt, reference);
      await validateStagedTree(bundle, exact.files, input.signal);
      if (await exists(mount) || await exists(assetMount)) {
        throw new ProductionSharinganCaptureRevisionMaterializerError(
          "SHARINGAN_CAPTURE_MOUNT_COLLISION",
          "Sharingan Capture reserved materialization root appeared during Revision materialization",
          "context",
        );
      }
      const publicPath = join(worktreeDir, "public");
      originalPublicIdentity = await existingDirectory(publicPath, resolve(worktreeDir, "public"));
      if (originalPublicIdentity === null) {
        await mkdir(stagedPublic, { mode: 0o700 });
      } else {
        await assertDirectoryFence(worktreeFence);
        await rename(publicPath, stagedPublic);
      }
      const stagedPublicMetadata = await lstat(stagedPublic);
      stagedPublicIdentity = stagedPublicMetadata;
      if (!stagedPublicMetadata.isDirectory() || stagedPublicMetadata.isSymbolicLink()
        || (originalPublicIdentity !== null && !sameEntry(stagedPublicMetadata, originalPublicIdentity))) {
        throw new ProductionSharinganCaptureRevisionMaterializerError(
          "SHARINGAN_CAPTURE_MOUNT_COLLISION",
          "Sharingan Capture public parent changed while it was staged atomically",
          "context",
        );
      }
      if (originalPublicIdentity === null) createdPublicIdentity = stagedPublicIdentity;
      if (await exists(join(stagedPublic, "_assets"))) {
        throw new ProductionSharinganCaptureRevisionMaterializerError(
          "SHARINGAN_CAPTURE_MOUNT_COLLISION",
          "Sharingan Capture staged public parent already contains reserved source assets",
          "context",
        );
      }
      const stagedAssets = join(bundle, "public", "_assets");
      assetMountedIdentity = await lstat(stagedAssets);
      await rename(stagedAssets, join(stagedPublic, "_assets"));
      const stagedPublicAfterAssets = await lstat(stagedPublic);
      const stagedAssetsAfter = await lstat(join(stagedPublic, "_assets"));
      if (!sameEntry(stagedPublicIdentity, stagedPublicAfterAssets)
        || !sameEntry(assetMountedIdentity, stagedAssetsAfter)) {
        throw new ProductionSharinganCaptureRevisionMaterializerError(
          "SHARINGAN_CAPTURE_STAGING_FAILED",
          "Sharingan Capture staged public tree changed during atomic assembly",
          "storage",
        );
      }
      await assertDirectoryFence(worktreeFence);
      if (await exists(publicPath)) {
        throw new ProductionSharinganCaptureRevisionMaterializerError(
          "SHARINGAN_CAPTURE_MOUNT_COLLISION",
          "Sharingan Capture public parent reappeared during atomic installation",
          "context",
        );
      }
      await rename(stagedPublic, publicPath);
      publicFence = Object.freeze({
        path: publicPath,
        identity: stagedPublicIdentity,
        canonical: resolve(worktreeDir, "public"),
      });
      await assertDirectoryFence(worktreeFence);
      await assertDirectoryFence(publicFence);
      mountedIdentity = await lstat(join(bundle, ".sharingan"));
      if (await exists(mount)) {
        throw new ProductionSharinganCaptureRevisionMaterializerError(
          "SHARINGAN_CAPTURE_MOUNT_COLLISION",
          "Sharingan Capture bundle mount reappeared during atomic installation",
          "context",
        );
      }
      await rename(join(bundle, ".sharingan"), mount);
      const installedMount = await lstat(mount);
      const installedAssets = await lstat(assetMount);
      if (!sameEntry(mountedIdentity, installedMount) || !sameEntry(assetMountedIdentity, installedAssets)) {
        throw new ProductionSharinganCaptureRevisionMaterializerError(
          "SHARINGAN_CAPTURE_STAGING_FAILED",
          "Sharingan Capture reserved roots changed during installation",
          "storage",
        );
      }
      const installedFiles = await collectMaterializedFiles(worktreeDir, input.signal);
      if (!isDeepStrictEqual(installedFiles, exact.files)) {
        throw new ProductionSharinganCaptureRevisionMaterializerError(
          "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
          "Sharingan Capture installed paths or bytes differ from the exact Resource Revision manifest",
          "context",
        );
      }
      await rm(bundle, { recursive: true });
      checkAbort(input.signal);
      await removeStagingRoot(stagingRoot);
      checkAbort(input.signal);
      fence = await createSharinganCaptureBundleFence({
        reference,
        worktreeDir,
        signal: input.signal,
      });
      return fence;
    } catch (error) {
      const normalized = input.signal.aborted
        ? abortReason(input.signal)
        : declaredFailure(error)
          ? error
          : new ProductionSharinganCaptureRevisionMaterializerError(
            "SHARINGAN_CAPTURE_STAGING_FAILED",
            "Sharingan Capture Revision could not be installed atomically",
            "storage",
            error,
          );
      throw normalized;
    } finally {
      let cleanupError: unknown = null;
      if (fence === null && publicFence === null && stagedPublicIdentity !== null
        && await exists(stagedPublic)) {
        try {
          const current = await lstat(stagedPublic);
          if (!current.isDirectory() || current.isSymbolicLink()
            || !sameEntry(current, stagedPublicIdentity)) {
            throw new ProductionSharinganCaptureRevisionMaterializerError(
              "SHARINGAN_CAPTURE_CLEANUP_FAILED",
              "Sharingan Capture staged public parent changed before rollback",
              "storage",
            );
          }
          if (originalPublicIdentity === null) {
            await rm(stagedPublic, { recursive: true, force: true });
            createdPublicIdentity = null;
          } else {
            const stagedAssetMount = join(stagedPublic, "_assets");
            const stagedAsset = await lstat(stagedAssetMount).catch(() => null);
            if (stagedAsset !== null) {
              if (assetMountedIdentity === null || !sameEntry(stagedAsset, assetMountedIdentity)) {
                throw new ProductionSharinganCaptureRevisionMaterializerError(
                  "SHARINGAN_CAPTURE_CLEANUP_FAILED",
                  "Sharingan Capture staged source assets changed before rollback",
                  "storage",
                );
              }
              await rm(stagedAssetMount, { recursive: true, force: true });
            }
            if (await exists(join(worktreeDir, "public"))) {
              throw new ProductionSharinganCaptureRevisionMaterializerError(
                "SHARINGAN_CAPTURE_CLEANUP_FAILED",
                "Sharingan Capture public parent was occupied before rollback",
                "storage",
              );
            }
            await rename(stagedPublic, join(worktreeDir, "public"));
          }
          stagedPublicIdentity = null;
          assetMountedIdentity = null;
        } catch (error) {
          cleanupError = error;
        }
      }
      if (fence === null && assetMountedIdentity !== null) {
        try {
          await removeOwnedMount(assetMount, assetMountedIdentity, publicFence === null ? [] : [publicFence]);
        } catch (error) {
          cleanupError = error;
        }
      }
      if (fence === null && mountedIdentity !== null) {
        try {
          await removeOwnedMount(mount, mountedIdentity);
        } catch (error) {
          cleanupError ??= error;
        }
      }
      if (fence === null && createdPublicIdentity !== null) {
        try {
          await removeOwnedParent(join(worktreeDir, "public"), createdPublicIdentity);
        } catch (error) {
          cleanupError ??= error;
        }
      }
      if (fence === null) {
        try {
          await removeStagingRoot(stagingRoot);
        } catch (error) {
          cleanupError ??= error;
        }
      }
      if (cleanupError !== null) throw cleanupError;
    }
  }
}
