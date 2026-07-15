import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import {
  ContextIntegrityError,
  CONTEXT_PRIORITY,
  assertPortableContextValue,
  assertIdentifier,
  checksumBytes,
  cloneAndFreeze,
  estimateContextTokens,
  isWellFormedContextText,
  normalizeContextItemRef,
  stableStringify,
  type AppendContextPackItemUsageInput,
  type ContextPack,
  type ContextPackDraft,
  type ContextPackItemUsage,
  type ContextPackRepository,
  type ContextPackUsageKind,
} from "./context-types.ts";
import type {
  ContextPack as CoreContextPack,
  ContextPackItemUsage as CoreContextPackItemUsage,
  PersistContextPackInput,
  RecordContextPackItemUsageInput,
} from "../../../../packages/core/src/index.ts";

const CONTEXT_PACK_PROTOCOL = "dezin-context-pack-v1";
const MAX_CONTEXT_PACK_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_CONTEXT_PACK_ITEM_BYTES = 2 * 1024 * 1024;
const IMMUTABLE_MANIFEST_SETTLE_TIMEOUT_MS = 2_000;
const IMMUTABLE_MANIFEST_SETTLE_RETRY_MS = 2;
const immutableManifestSettleWaiter = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const IMMUTABLE_TEMP_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTEXT_CLASSES = new Set(CONTEXT_PRIORITY);
const CONTEXT_CLASS_ORDER = new Map(CONTEXT_PRIORITY.map((contextClass, index) => [contextClass, index]));
const REQUIRED_CONTEXT_CLASSES = new Set(["system-kernel", "target", "selection", "explicit"]);
const SHA256 = /^[a-f0-9]{64}$/;

function binaryCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function hashInput(draft: ContextPackDraft): Record<string, unknown> {
  return {
    protocol: CONTEXT_PACK_PROTOCOL,
    workspaceId: draft.workspaceId,
    graphRevision: draft.graphRevision,
    target: draft.target,
    intent: draft.intent,
    messageChecksum: draft.messageChecksum,
    items: draft.items,
    omissions: draft.omissions,
    tokenEstimate: draft.tokenEstimate,
  };
}

function contextPackManifestBytes(id: string, draft: ContextPackDraft, hash: string): Buffer {
  return Buffer.from(`${stableStringify({
    protocol: CONTEXT_PACK_PROTOCOL,
    id,
    ...hashInput(draft),
    hash,
  })}\n`, "utf8");
}

function sameFile(
  left: { dev: number | bigint; ino: number | bigint; size: number | bigint },
  right: { dev: number | bigint; ino: number | bigint; size: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function sameNode(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function canonicalStorageRoot(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new ContextIntegrityError("Context Pack storage root cannot be a symlink or non-directory");
  }
  return realpathSync(path);
}

function assertCanonicalStorageRoot(root: string): void {
  const metadata = lstatSync(root);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || realpathSync(root) !== root) {
    throw new ContextIntegrityError("Context Pack canonical storage root changed");
  }
}

function secureDirectory(root: string, directory: string): void {
  assertCanonicalStorageRoot(root);
  if (!inside(root, directory)) throw new ContextIntegrityError("Context Pack storage directory escapes its root");
  let cursor = root;
  for (const segment of relative(root, directory).split(sep)) {
    if (!segment) continue;
    cursor = join(cursor, segment);
    let created = false;
    try {
      mkdirSync(cursor, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (created) syncStorageDirectory(dirname(cursor));
    const metadata = lstatSync(cursor);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || !inside(root, realpathSync(cursor))) {
      throw new ContextIntegrityError("Context Pack storage cannot traverse a symlink or non-directory");
    }
  }
}

function assertStableStorageDirectory(
  root: string,
  directory: string,
  expected: { dev: number | bigint; ino: number | bigint },
): void {
  const current = lstatSync(directory);
  if (current.isSymbolicLink() || !current.isDirectory() || !sameNode(expected, current)
    || !inside(root, realpathSync(directory))) {
    throw new ContextIntegrityError("Context Pack storage directory changed during I/O");
  }
}

function readSecureImmutableFile(root: string, path: string): Buffer {
  if (!inside(root, path)) throw new ContextIntegrityError("Context Pack storage path escapes its root");
  const directory = dirname(path);
  secureDirectory(root, directory);
  const directoryIdentity = lstatSync(directory);
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new ContextIntegrityError("Context Pack manifest cannot be a symlink or hardlink");
  }
  if (before.size <= 0 || before.size > MAX_CONTEXT_PACK_MANIFEST_BYTES) {
    throw new ContextIntegrityError("Context Pack manifest size is out of bounds");
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    const current = lstatSync(path);
    assertStableStorageDirectory(root, directory, directoryIdentity);
    if (!sameFile(before, opened) || !sameFile(opened, current) || current.nlink !== 1) {
      throw new ContextIntegrityError("Context Pack manifest changed while it was opened");
    }
    const expectedSize = Number(opened.size);
    const bytes = Buffer.alloc(expectedSize);
    let offset = 0;
    while (offset < expectedSize) {
      const read = readSync(fd, bytes, offset, expectedSize - offset, offset);
      if (read <= 0) throw new ContextIntegrityError("Context Pack manifest shrank while it was read");
      offset += read;
    }
    const extra = Buffer.allocUnsafe(1);
    if (readSync(fd, extra, 0, 1, expectedSize) !== 0) {
      throw new ContextIntegrityError("Context Pack manifest grew while it was read");
    }
    const after = fstatSync(fd);
    const final = lstatSync(path);
    assertStableStorageDirectory(root, directory, directoryIdentity);
    if (!sameFile(opened, after) || !sameFile(after, final) || final.nlink !== 1 || bytes.byteLength !== Number(after.size)) {
      throw new ContextIntegrityError("Context Pack manifest changed while it was read");
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function readSettledImmutableFile(root: string, path: string): Buffer {
  const deadline = Date.now() + IMMUTABLE_MANIFEST_SETTLE_TIMEOUT_MS;
  for (;;) {
    try {
      return readSecureImmutableFile(root, path);
    } catch (error) {
      const remaining = deadline - Date.now();
      if (!(error instanceof ContextIntegrityError) || !/hardlink/.test(error.message) || remaining <= 0) {
        throw error;
      }
      if (recoverOwnedTemporaryHardlink(root, path)) continue;
      Atomics.wait(
        immutableManifestSettleWaiter,
        0,
        0,
        Math.min(IMMUTABLE_MANIFEST_SETTLE_RETRY_MS, remaining),
      );
    }
  }
}

function syncStorageDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function recoverOwnedTemporaryHardlink(root: string, path: string): boolean {
  const directory = dirname(path);
  secureDirectory(root, directory);
  const directoryIdentity = lstatSync(directory);
  let target: ReturnType<typeof lstatSync>;
  try {
    target = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (target.isSymbolicLink() || !target.isFile() || target.nlink !== 2
    || (target.mode & 0o222) !== 0
    || (typeof process.getuid === "function" && target.uid !== process.getuid())) {
    return false;
  }
  const prefix = `${basename(path)}.tmp-`;
  const matches: string[] = [];
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(prefix) || !IMMUTABLE_TEMP_UUID.test(name.slice(prefix.length))) continue;
    const candidate = join(directory, name);
    let metadata: ReturnType<typeof lstatSync>;
    try {
      metadata = lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isSymbolicLink() && metadata.isFile() && metadata.nlink === 2
      && metadata.uid === target.uid && sameFile(target, metadata)) {
      matches.push(candidate);
    }
  }
  if (matches.length !== 1) {
    const currentTarget = lstatSync(path);
    if (currentTarget.nlink !== 1 || !sameFile(target, currentTarget)) return false;
    assertStableStorageDirectory(root, directory, directoryIdentity);
    syncStorageDirectory(directory);
    const durableTarget = lstatSync(path);
    assertStableStorageDirectory(root, directory, directoryIdentity);
    return durableTarget.nlink === 1 && sameFile(target, durableTarget);
  }
  const temporary = matches[0]!;
  const currentTarget = lstatSync(path);
  let currentTemporary: ReturnType<typeof lstatSync> | null;
  try {
    currentTemporary = lstatSync(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    currentTemporary = null;
  }
  assertStableStorageDirectory(root, directory, directoryIdentity);
  if (currentTemporary === null) {
    if (currentTarget.nlink !== 1 || !sameFile(target, currentTarget)) return false;
    syncStorageDirectory(directory);
    const durableTarget = lstatSync(path);
    assertStableStorageDirectory(root, directory, directoryIdentity);
    return durableTarget.nlink === 1 && sameFile(target, durableTarget);
  }
  if (currentTarget.isSymbolicLink() || !currentTarget.isFile() || currentTarget.nlink !== 2
    || currentTemporary.isSymbolicLink() || !currentTemporary.isFile() || currentTemporary.nlink !== 2
    || currentTarget.uid !== target.uid || currentTemporary.uid !== target.uid
    || !sameFile(target, currentTarget) || !sameFile(currentTarget, currentTemporary)) {
    return false;
  }
  try {
    rmSync(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  syncStorageDirectory(directory);
  const recoveredTarget = lstatSync(path);
  assertStableStorageDirectory(root, directory, directoryIdentity);
  return recoveredTarget.nlink === 1 && sameFile(target, recoveredTarget);
}

function immutableWrite(root: string, path: string, bytes: Buffer): "created" | "existing" {
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_CONTEXT_PACK_MANIFEST_BYTES) {
    throw new ContextIntegrityError("Context Pack manifest size is out of bounds");
  }
  const directory = dirname(path);
  secureDirectory(root, directory);
  const directoryIdentity = lstatSync(directory);
  const temporary = `${path}.tmp-${randomUUID()}`;
  let fd: number | null = null;
  let temporaryIdentity: { dev: number | bigint; ino: number | bigint; size: number | bigint } | null = null;
  try {
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o444);
    temporaryIdentity = fstatSync(fd);
    const openedPath = lstatSync(temporary);
    assertStableStorageDirectory(root, directory, directoryIdentity);
    if (!openedPath.isFile() || openedPath.nlink !== 1 || !sameFile(temporaryIdentity, openedPath)) {
      throw new ContextIntegrityError("Context Pack temporary manifest changed while it was opened");
    }
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, null);
      if (written <= 0) throw new ContextIntegrityError("Context Pack manifest write made no progress");
      offset += written;
    }
    fsyncSync(fd);
    const written = fstatSync(fd);
    const writtenPath = lstatSync(temporary);
    assertStableStorageDirectory(root, directory, directoryIdentity);
    if (writtenPath.nlink !== 1 || !sameNode(temporaryIdentity, written)
      || !sameFile(written, writtenPath) || Number(written.size) !== bytes.byteLength) {
      throw new ContextIntegrityError("Context Pack temporary manifest changed while it was written");
    }
    closeSync(fd);
    fd = null;
    try {
      assertStableStorageDirectory(root, directory, directoryIdentity);
      linkSync(temporary, path);
      syncStorageDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!readSettledImmutableFile(root, path).equals(bytes)) {
        throw new ContextIntegrityError("Context Pack manifest already exists with different immutable content");
      }
      return "existing";
    }
  } finally {
    if (fd !== null) closeSync(fd);
    let removedTemporary = false;
    try {
      const current = lstatSync(temporary);
      if (temporaryIdentity && sameNode(temporaryIdentity, current)) {
        rmSync(temporary);
        removedTemporary = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (removedTemporary) syncStorageDirectory(directory);
  }
  if (!readSecureImmutableFile(root, path).equals(bytes)) {
    throw new ContextIntegrityError("Context Pack manifest immutable write verification failed");
  }
  return "created";
}

function validateDraft(draft: ContextPackDraft): void {
  if (!draft || typeof draft !== "object"
    || !Array.isArray(draft.items) || draft.items.length > 1_024
    || !Array.isArray(draft.omissions) || draft.omissions.length > 1_024) {
    throw new ContextIntegrityError("Context Pack draft arrays are invalid or unbounded");
  }
  assertIdentifier(draft.workspaceId, "Workspace ID");
  if (!Number.isSafeInteger(draft.graphRevision) || draft.graphRevision < 0) {
    throw new ContextIntegrityError("Context Pack graph Revision is invalid");
  }
  if (!draft.target || typeof draft.target !== "object"
    || !draft.target.id
    || (draft.target.type !== "workspace" && draft.target.type !== "artifact" && draft.target.type !== "resource")) {
    throw new ContextIntegrityError("Context Pack target is invalid");
  }
  assertIdentifier(draft.target.id, "Context Pack target ID");
  if (draft.intent !== "plan" && draft.intent !== "generate" && draft.intent !== "edit"
    && draft.intent !== "repair" && draft.intent !== "analyze-impact") {
    throw new ContextIntegrityError("Context Pack intent is invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(draft.messageChecksum)) {
    throw new ContextIntegrityError("Context Pack message checksum is invalid");
  }
  let total = 0;
  let hasSystemKernel = false;
  let hasExactTarget = false;
  let previousClassOrder = -1;
  let previousItemOrderKey: string | null = null;
  for (let ordinal = 0; ordinal < draft.items.length; ordinal += 1) {
    const item = draft.items[ordinal]!;
    if (!item || typeof item !== "object" || typeof item.content !== "string"
      || !Array.isArray(item.capabilities) || typeof item.reason !== "string"
      || !item.boundary || typeof item.boundary !== "object" || Array.isArray(item.boundary)
      || !item.provenance || typeof item.provenance !== "object" || Array.isArray(item.provenance)) {
      throw new ContextIntegrityError(`Context Pack item ${ordinal} shape is invalid`);
    }
    if (!CONTEXT_CLASSES.has(item.contextClass)) {
      throw new ContextIntegrityError(`Context Pack item ${ordinal} priority class is invalid`);
    }
    const normalizedRef = normalizeContextItemRef(item.ref, `Context Pack item ${ordinal} ref`);
    if (stableStringify(normalizedRef) !== stableStringify(item.ref)) {
      throw new ContextIntegrityError(`Context Pack item ${ordinal} ref is not canonical`);
    }
    const exactRevisionId = "revisionId" in normalizedRef ? normalizedRef.revisionId : undefined;
    const exactIdentity = (item.resolvedKind === "resource-revision"
        && normalizedRef.kind === "resource" && exactRevisionId !== undefined)
      || (item.resolvedKind === "artifact-revision"
        && normalizedRef.kind === "artifact" && exactRevisionId !== undefined)
      || (item.resolvedKind === "kernel-revision"
        && normalizedRef.kind === "kernel" && exactRevisionId !== undefined)
      || (item.resolvedKind === "inline" && normalizedRef.kind === "inline");
    if (!exactIdentity) throw new ContextIntegrityError(`Context Pack item ${ordinal} exact identity is invalid`);
    const currentClassOrder = CONTEXT_CLASS_ORDER.get(item.contextClass)!;
    const itemOrderKey = stableStringify({
      contextClass: item.contextClass,
      resolvedKind: item.resolvedKind,
      kind: normalizedRef.kind,
      resourceKind: normalizedRef.kind === "resource" ? normalizedRef.resourceKind : null,
      id: normalizedRef.id,
      revisionId: exactRevisionId ?? null,
    });
    if (currentClassOrder < previousClassOrder
      || (currentClassOrder === previousClassOrder
        && previousItemOrderKey !== null && binaryCompare(previousItemOrderKey, itemOrderKey) > 0)) {
      throw new ContextIntegrityError("Context Pack items are not in canonical priority order");
    }
    previousClassOrder = currentClassOrder;
    previousItemOrderKey = itemOrderKey;
    if (item.ordinal !== ordinal) throw new ContextIntegrityError("Context Pack item ordinals must be contiguous");
    if (!item.provided) throw new ContextIntegrityError("Retained Context Pack items must be frozen as provided");
    if (!isWellFormedContextText(item.content)
      || Buffer.byteLength(item.content, "utf8") > MAX_CONTEXT_PACK_ITEM_BYTES) {
      throw new ContextIntegrityError(`Context Pack item ${ordinal} content is invalid or unbounded`);
    }
    if (!isWellFormedContextText(item.reason) || !item.reason
      || Buffer.byteLength(item.reason, "utf8") > 2_000) {
      throw new ContextIntegrityError(`Context Pack item ${ordinal} reason is invalid`);
    }
    if (!SHA256.test(item.checksum)
      || (item.resolvedKind === "inline" && item.checksum !== checksumBytes(item.content))) {
      throw new ContextIntegrityError(`Context Pack item ${ordinal} checksum is invalid`);
    }
    if (item.trustLevel !== "system" && item.trustLevel !== "trusted" && item.trustLevel !== "untrusted") {
      throw new ContextIntegrityError(`Context Pack item ${ordinal} trust level is invalid`);
    }
    if (item.contextClass === "system-kernel" && item.trustLevel !== "system") {
      throw new ContextIntegrityError("System Kernel Context Pack items must use system trust");
    }
    if (item.contextClass === "system-kernel") hasSystemKernel = true;
    if (item.contextClass === "target"
      && item.ref.id === draft.target.id
      && (draft.target.type === "workspace"
        || (draft.target.type === "artifact" && item.ref.kind === "artifact")
        || (draft.target.type === "resource" && item.ref.kind === "resource"))) {
      hasExactTarget = true;
    }
    if (item.capabilities.length > 64 || item.capabilities.some((capability: unknown) => typeof capability !== "string"
      || !capability || !isWellFormedContextText(capability)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(capability)
      || Buffer.byteLength(capability, "utf8") > 128)) {
      throw new ContextIntegrityError(`Context Pack item ${ordinal} capabilities are invalid`);
    }
    const canonicalCapabilities = [...new Set(item.capabilities as readonly string[])].sort(binaryCompare);
    if (stableStringify(canonicalCapabilities) !== stableStringify(item.capabilities)) {
      throw new ContextIntegrityError(`Context Pack item ${ordinal} capabilities are not canonical`);
    }
    if (item.boundary.mayGrantCapabilities !== false || item.boundary.readOnly !== true
      || typeof item.boundary.source !== "string" || !item.boundary.source
      || !isWellFormedContextText(item.boundary.source)
      || /[\u0000-\u001f\u007f]/.test(item.boundary.source)
      || Buffer.byteLength(item.boundary.source, "utf8") > 1_024
      || (item.boundary.delimiter !== undefined
        && (typeof item.boundary.delimiter !== "string" || !item.boundary.delimiter
          || !isWellFormedContextText(item.boundary.delimiter)
          || /[\u0000-\u001f\u007f]/.test(item.boundary.delimiter)
          || Buffer.byteLength(item.boundary.delimiter, "utf8") > 1_024))
      || Object.keys(item.boundary).some(
        (field) => field !== "source" && field !== "readOnly"
          && field !== "mayGrantCapabilities" && field !== "delimiter",
      )) {
      throw new ContextIntegrityError("Context Pack item boundary is invalid");
    }
    if (item.trustLevel === "untrusted" && item.capabilities.length !== 0) {
      throw new ContextIntegrityError("Untrusted Context Pack items cannot grant capabilities");
    }
    assertPortableContextValue(item.boundary, `Context Pack item ${ordinal} boundary`, 128 * 1024);
    assertPortableContextValue(item.provenance, `Context Pack item ${ordinal} provenance`);
    if (!Number.isSafeInteger(item.tokenEstimate) || item.tokenEstimate !== estimateContextTokens(item.content)) {
      throw new ContextIntegrityError("Context Pack item token estimate is invalid");
    }
    total += item.tokenEstimate;
  }
  if (!hasSystemKernel || !hasExactTarget) {
    throw new ContextIntegrityError("Context Pack is missing its required system Kernel or exact target");
  }
  for (const omission of draft.omissions) {
    if (!omission || typeof omission !== "object" || typeof omission.reason !== "string"
      || !Number.isSafeInteger(omission.tokenEstimate) || omission.tokenEstimate < 1) {
      throw new ContextIntegrityError("Context Pack omission shape is invalid");
    }
    if (!CONTEXT_CLASSES.has(omission.contextClass) || REQUIRED_CONTEXT_CLASSES.has(omission.contextClass)) {
      throw new ContextIntegrityError("Context Pack omission priority class is invalid");
    }
    const normalizedRef = normalizeContextItemRef(omission.ref, "Context Pack omission ref");
    if (stableStringify(normalizedRef) !== stableStringify(omission.ref)
      || !isWellFormedContextText(omission.reason)
      || Buffer.byteLength(omission.reason, "utf8") > 2_000) {
      throw new ContextIntegrityError("Context Pack omission is not canonical");
    }
  }
  if (!Number.isSafeInteger(draft.tokenEstimate) || total !== draft.tokenEstimate) {
    throw new ContextIntegrityError("Context Pack token estimate does not match its items");
  }
  if (Buffer.byteLength(stableStringify(hashInput(draft)), "utf8") > MAX_CONTEXT_PACK_MANIFEST_BYTES) {
    throw new ContextIntegrityError("Context Pack manifest content exceeds its byte limit");
  }
}

function existingMatches(existing: ContextPack, expectedHash: string): boolean {
  const draft: ContextPackDraft = {
    workspaceId: existing.workspaceId,
    graphRevision: existing.graphRevision,
    target: existing.target,
    intent: existing.intent,
    messageChecksum: existing.messageChecksum,
    items: existing.items,
    omissions: existing.omissions,
    tokenEstimate: existing.tokenEstimate,
  };
  return checksumBytes(stableStringify(hashInput(draft))) === expectedHash;
}

function assertStoredPackIdentity(
  pack: ContextPack,
  expected: { id: string; hash: string; manifestPath: string },
): void {
  validateDraft({
    workspaceId: pack.workspaceId,
    graphRevision: pack.graphRevision,
    target: pack.target,
    intent: pack.intent,
    messageChecksum: pack.messageChecksum,
    items: pack.items,
    omissions: pack.omissions,
    tokenEstimate: pack.tokenEstimate,
  });
  if (pack.id !== expected.id
    || pack.hash !== expected.hash
    || pack.manifestPath !== expected.manifestPath
    || !Number.isSafeInteger(pack.createdAt) || pack.createdAt < 0
    || !existingMatches(pack, expected.hash)) {
    throw new ContextIntegrityError("Stored Context Pack immutable identity is corrupt");
  }
}

function validateUsageEntry(
  entry: ContextPackItemUsage,
  expected: { workspaceId: string; contextPackId: string; ordinal: number },
): void {
  if (!entry || typeof entry !== "object"
    || entry.workspaceId !== expected.workspaceId
    || entry.contextPackId !== expected.contextPackId
    || entry.ordinal !== expected.ordinal
    || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1
    || (entry.usageKind !== "observed-read" && entry.usageKind !== "agent-declared-used")
    || (entry.runId !== null && typeof entry.runId !== "string")
    || !entry.evidence || typeof entry.evidence !== "object" || Array.isArray(entry.evidence)
    || !Number.isSafeInteger(entry.recordedAt) || entry.recordedAt < 0) {
    throw new ContextIntegrityError("Context Pack usage entry is invalid");
  }
  if (entry.runId !== null) assertIdentifier(entry.runId, "Context Pack usage Run ID");
  assertPortableContextValue(entry.evidence, "Context Pack usage evidence", 256 * 1024);
}

export interface ContextPackStoreOptions {
  manifestRoot: string;
  repository: ContextPackRepository;
  now?: () => number;
}

export class ContextPackStore {
  readonly #manifestRoot: string;
  readonly #repository: ContextPackRepository;
  readonly #now: () => number;

  constructor(options: ContextPackStoreOptions) {
    this.#manifestRoot = resolve(options.manifestRoot);
    this.#repository = options.repository;
    this.#now = options.now ?? Date.now;
  }

  persist(unsafeDraft: ContextPackDraft): ContextPack {
    const draft = cloneAndFreeze(unsafeDraft);
    validateDraft(draft);
    const canonical = stableStringify(hashInput(draft));
    const hash = checksumBytes(canonical);
    const storageRoot = canonicalStorageRoot(this.#manifestRoot);
    const workspaceKey = checksumBytes(`workspace\0${draft.workspaceId}`);
    const manifestPath = posix.join("context-packs", workspaceKey, `${hash}.json`);
    const manifestAbsolutePath = join(storageRoot, ...manifestPath.split("/"));
    if (!inside(storageRoot, manifestAbsolutePath)) throw new ContextIntegrityError("Context Pack manifest path escapes storage");
    const existing = this.#repository.findByHash(draft.workspaceId, hash);
    if (existing) {
      assertStoredPackIdentity(existing, { id: `context-pack-${hash}`, hash, manifestPath });
      const expectedManifest = contextPackManifestBytes(existing.id, {
        workspaceId: existing.workspaceId,
        graphRevision: existing.graphRevision,
        target: existing.target,
        intent: existing.intent,
        messageChecksum: existing.messageChecksum,
        items: existing.items,
        omissions: existing.omissions,
        tokenEstimate: existing.tokenEstimate,
      }, hash);
      const manifest = readSettledImmutableFile(storageRoot, manifestAbsolutePath);
      if (!manifest.equals(expectedManifest)) {
        throw new ContextIntegrityError("Stored Context Pack manifest does not match its hash");
      }
      return cloneAndFreeze(existing);
    }

    const id = `context-pack-${hash}`;
    const createdAt = this.#now();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new ContextIntegrityError("Context Pack createdAt is invalid");
    const pack = cloneAndFreeze({
      id,
      ...draft,
      manifestPath,
      hash,
      createdAt,
    } satisfies ContextPack);
    const manifestBytes = contextPackManifestBytes(id, draft, hash);
    const manifestState = immutableWrite(storageRoot, manifestAbsolutePath, manifestBytes);
    try {
      const inserted = this.#repository.insert(pack);
      assertStoredPackIdentity(inserted, { id, hash, manifestPath });
      return cloneAndFreeze(inserted);
    } catch (error) {
      const concurrent = this.#repository.get(draft.workspaceId, id);
      if (concurrent) {
        assertStoredPackIdentity(concurrent, { id, hash, manifestPath });
        return cloneAndFreeze(concurrent);
      }
      if (manifestState === "created") {
        try {
          if (readSecureImmutableFile(storageRoot, manifestAbsolutePath).equals(manifestBytes)) {
            rmSync(manifestAbsolutePath);
            syncStorageDirectory(dirname(manifestAbsolutePath));
          }
        } catch {
          // Preserve suspicious storage for operator inspection instead of following a changed path.
        }
      }
      throw error;
    }
  }

  recordUsage(input: {
    contextPackId: string;
    workspaceId: string;
    ordinal: number;
    usageKind: ContextPackUsageKind;
    runId: string | null;
    evidence: Readonly<Record<string, unknown>>;
  }): ContextPackItemUsage {
    assertIdentifier(input.workspaceId, "Context Pack usage Workspace ID");
    assertIdentifier(input.contextPackId, "Context Pack usage Pack ID");
    if (input.usageKind !== "observed-read" && input.usageKind !== "agent-declared-used") {
      throw new ContextIntegrityError("Context Pack usage kind is invalid");
    }
    if (input.runId !== null) assertIdentifier(input.runId, "Context Pack usage Run ID");
    if (!input.evidence || typeof input.evidence !== "object" || Array.isArray(input.evidence)) {
      throw new ContextIntegrityError("Context Pack usage evidence must be an object");
    }
    assertPortableContextValue(input.evidence, "Context Pack usage evidence", 256 * 1024);
    const pack = this.#repository.get(input.workspaceId, input.contextPackId);
    if (!pack || pack.workspaceId !== input.workspaceId || pack.id !== input.contextPackId) {
      throw new ContextIntegrityError("Context Pack usage references a missing or cross-Workspace pack");
    }
    if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0 || input.ordinal >= pack.items.length) {
      throw new ContextIntegrityError("Context Pack usage ordinal is invalid");
    }
    const entry = this.#repository.appendUsage({
      contextPackId: pack.id,
      workspaceId: pack.workspaceId,
      ordinal: input.ordinal,
      usageKind: input.usageKind,
      runId: input.runId,
      evidence: cloneAndFreeze(input.evidence),
    });
    validateUsageEntry(entry, {
      workspaceId: pack.workspaceId,
      contextPackId: pack.id,
      ordinal: input.ordinal,
    });
    if (entry.usageKind !== input.usageKind
      || entry.runId !== input.runId
      || stableStringify(entry.evidence) !== stableStringify(input.evidence)) {
      throw new ContextIntegrityError("Context Pack repository changed immutable usage evidence");
    }
    return cloneAndFreeze(entry);
  }

  listUsage(workspaceId: string, contextPackId: string, ordinal: number): readonly ContextPackItemUsage[] {
    assertIdentifier(workspaceId, "Context Pack usage Workspace ID");
    assertIdentifier(contextPackId, "Context Pack usage Pack ID");
    const pack = this.#repository.get(workspaceId, contextPackId);
    if (!pack || pack.workspaceId !== workspaceId || pack.id !== contextPackId) {
      throw new ContextIntegrityError("Context Pack usage references a missing or cross-Workspace pack");
    }
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= pack.items.length) {
      throw new ContextIntegrityError("Context Pack usage ordinal is invalid");
    }
    const entries = this.#repository.listUsage(workspaceId, contextPackId, ordinal);
    if (!Array.isArray(entries) || entries.length > 1_000_000) {
      throw new ContextIntegrityError("Context Pack usage list is invalid or unbounded");
    }
    let previousSequence = 0;
    for (const entry of entries) {
      validateUsageEntry(entry, { workspaceId, contextPackId, ordinal });
      if (entry.sequence !== previousSequence + 1) {
        throw new ContextIntegrityError("Context Pack usage entries are not contiguous append-only records");
      }
      previousSequence = entry.sequence;
    }
    return cloneAndFreeze(entries);
  }
}

export interface WorkspaceContextPackPersistencePort {
  persistContextPack(input: PersistContextPackInput): CoreContextPack;
  getContextPack(workspaceId: string, contextPackId: string): CoreContextPack | null;
  findContextPackByHash(workspaceId: string, hash: string): CoreContextPack | null;
  recordContextPackItemUsage(input: RecordContextPackItemUsageInput): CoreContextPackItemUsage;
  listContextPackItemUsage(workspaceId: string, contextPackId: string, ordinal?: number): CoreContextPackItemUsage[];
}

function coreRef(ref: ContextPack["items"][number]["ref"]): PersistContextPackInput["items"][number]["ref"] {
  if (ref.kind === "resource") {
    return {
      kind: "resource",
      id: ref.id,
      resourceKind: ref.resourceKind,
      ...(ref.revisionId === undefined ? {} : { revisionId: ref.revisionId }),
    };
  }
  if (ref.kind === "artifact" || ref.kind === "kernel") {
    return ref.revisionId === undefined
      ? { kind: ref.kind, id: ref.id }
      : { kind: ref.kind, id: ref.id, revisionId: ref.revisionId };
  }
  return { kind: "inline", id: ref.id };
}

function exactRevisionPins(item: ContextPack["items"][number]): {
  artifactRevisionId: string | null;
  resourceRevisionId: string | null;
  kernelRevisionId: string | null;
} {
  const revisionId = "revisionId" in item.ref ? item.ref.revisionId ?? null : null;
  if (item.resolvedKind !== "inline" && revisionId === null) {
    throw new ContextIntegrityError(`Context Pack item ${item.ordinal} is missing its exact Revision pin`);
  }
  return {
    artifactRevisionId: item.resolvedKind === "artifact-revision" ? revisionId : null,
    resourceRevisionId: item.resolvedKind === "resource-revision" ? revisionId : null,
    kernelRevisionId: item.resolvedKind === "kernel-revision" ? revisionId : null,
  };
}

function toCorePersistInput(pack: ContextPack): PersistContextPackInput {
  return {
    id: pack.id,
    workspaceId: pack.workspaceId,
    graphRevision: pack.graphRevision,
    target: pack.target,
    intent: pack.intent,
    messageChecksum: pack.messageChecksum,
    items: pack.items.map((item) => ({
      ref: coreRef(item.ref),
      resolvedKind: item.resolvedKind,
      ...exactRevisionPins(item),
      checksum: item.checksum,
      reason: item.reason,
      trustLevel: item.trustLevel,
      boundary: { ...structuredClone(item.boundary) },
      tokenEstimate: item.tokenEstimate,
      provenance: { ...structuredClone(item.provenance) },
      provided: item.provided,
    })),
    omissions: pack.omissions.map((omission) => ({
      ref: coreRef(omission.ref),
      reason: omission.reason,
      tokenEstimate: omission.tokenEstimate,
    })),
    tokenEstimate: pack.tokenEstimate,
    manifestPath: pack.manifestPath,
    hash: pack.hash,
  };
}

function parseManifestPack(
  storageRoot: string,
  core: CoreContextPack,
): ContextPack {
  if (typeof core.manifestPath !== "string"
    || core.manifestPath.length > 4_096
    || posix.isAbsolute(core.manifestPath)
    || /^[A-Za-z]:/.test(core.manifestPath)
    || core.manifestPath.includes("\\")
    || core.manifestPath.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new ContextIntegrityError("Stored Context Pack manifest path is not portable");
  }
  const absolutePath = join(storageRoot, ...core.manifestPath.split("/"));
  if (!inside(storageRoot, absolutePath)) throw new ContextIntegrityError("Stored Context Pack manifest escapes storage");
  const bytes = readSecureImmutableFile(storageRoot, absolutePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ContextIntegrityError("Stored Context Pack manifest is invalid UTF-8 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ContextIntegrityError("Stored Context Pack manifest must be an object");
  }
  const manifest = parsed as Record<string, unknown>;
  const candidate = cloneAndFreeze({
    id: manifest.id,
    workspaceId: manifest.workspaceId,
    graphRevision: manifest.graphRevision,
    target: manifest.target,
    intent: manifest.intent,
    messageChecksum: manifest.messageChecksum,
    items: manifest.items,
    omissions: manifest.omissions,
    tokenEstimate: manifest.tokenEstimate,
    manifestPath: core.manifestPath,
    hash: manifest.hash,
    createdAt: core.createdAt,
  }) as ContextPack;
  const draft: ContextPackDraft = {
    workspaceId: candidate.workspaceId,
    graphRevision: candidate.graphRevision,
    target: candidate.target,
    intent: candidate.intent,
    messageChecksum: candidate.messageChecksum,
    items: candidate.items,
    omissions: candidate.omissions,
    tokenEstimate: candidate.tokenEstimate,
  };
  validateDraft(draft);
  const expectedManifestPath = posix.join(
    "context-packs",
    checksumBytes(`workspace\0${candidate.workspaceId}`),
    `${candidate.hash}.json`,
  );
  if (!bytes.equals(contextPackManifestBytes(candidate.id, draft, candidate.hash))) {
    throw new ContextIntegrityError("Stored Context Pack manifest bytes are not canonical");
  }
  if (manifest.protocol !== CONTEXT_PACK_PROTOCOL
    || !SHA256.test(candidate.hash)
    || candidate.id !== `context-pack-${candidate.hash}`
    || candidate.id !== core.id
    || candidate.workspaceId !== core.workspaceId
    || candidate.graphRevision !== core.graphRevision
    || candidate.intent !== core.intent
    || candidate.messageChecksum !== core.messageChecksum
    || candidate.hash !== core.hash
    || candidate.manifestPath !== core.manifestPath
    || candidate.manifestPath !== expectedManifestPath
    || !Number.isSafeInteger(candidate.createdAt) || candidate.createdAt < 0
    || !existingMatches(candidate, core.hash)
    || stableStringify(toCorePersistInput(candidate).items) !== stableStringify(core.items.map(({ ordinal: _ordinal, ...item }) => item))
    || stableStringify(toCorePersistInput(candidate).omissions) !== stableStringify(core.omissions)
    || candidate.tokenEstimate !== core.tokenEstimate
    || stableStringify(candidate.target) !== stableStringify(core.target)) {
    throw new ContextIntegrityError("Stored Context Pack manifest and durable row do not match");
  }
  return candidate;
}

/** Production bridge that round-trips daemon-only prompt content via the manifest. */
export function createWorkspaceContextPackRepository(
  workspaceStore: WorkspaceContextPackPersistencePort,
  options: { manifestRoot: string },
): ContextPackRepository {
  const storageRoot = canonicalStorageRoot(resolve(options.manifestRoot));
  const get = (workspaceId: string, contextPackId: string): ContextPack | null => {
    const core = workspaceStore.getContextPack(workspaceId, contextPackId);
    return core ? parseManifestPack(storageRoot, core) : null;
  };
  return Object.freeze({
    findByHash(workspaceId: string, hash: string) {
      const core = workspaceStore.findContextPackByHash(workspaceId, hash);
      return core ? parseManifestPack(storageRoot, core) : null;
    },
    insert(pack: ContextPack) {
      const persisted = workspaceStore.persistContextPack(toCorePersistInput(pack));
      return parseManifestPack(storageRoot, persisted);
    },
    get,
    appendUsage(input: AppendContextPackItemUsageInput) {
      return workspaceStore.recordContextPackItemUsage({
        contextPackId: input.contextPackId,
        workspaceId: input.workspaceId,
        ordinal: input.ordinal,
        usageKind: input.usageKind,
        runId: input.runId,
        evidence: structuredClone(input.evidence),
      });
    },
    listUsage(workspaceId: string, contextPackId: string, ordinal: number) {
      return workspaceStore.listContextPackItemUsage(workspaceId, contextPackId, ordinal);
    },
  });
}
