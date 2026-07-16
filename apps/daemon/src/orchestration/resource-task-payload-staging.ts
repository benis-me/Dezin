import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rm,
  rmdir,
} from "node:fs/promises";
import { dirname, join, posix, sep } from "node:path";
import type {
  ClassifyResourcePayloadStagingInput,
  CompleteResourcePayloadStagingInput,
  ResourcePayloadCleanupIdentity,
  ResourcePayloadStagingBeginInput,
  ResourcePayloadStagingJournal,
} from "../../../../packages/core/src/index.ts";
import {
  snapshotBytes,
} from "../context/adapters/file.ts";
import { stableStringify } from "../context/context-types.ts";
import {
  RESOURCE_REVISION_PAYLOAD_PROTOCOL,
  MAX_RESOURCE_PAYLOAD_BYTES,
  resourceRevisionManifestRelativePath,
  resourceRevisionMountKey,
  resourceRevisionPublicRoot,
  verifyResourceRevisionPayload,
  type ResourceRevisionPayloadDescriptor,
} from "../resource-revision-payload.ts";
import {
  ResourceTaskPayloadError,
  validateResourceTaskPayloadReceipt,
  type ResourceTaskPayloadReceipt,
  type ResourceTaskPayloadScope,
  type ResourceTaskPayloadStageInput,
  type ResourceTaskPayloadStagingPort,
} from "./resource-task-executor.ts";

const RECEIPT_FILE = "generation-receipt.json";
const RECEIPT_PROTOCOL = "dezin.resource-task-payload-receipt.v1" as const;
const MAX_RECEIPT_BYTES = 16 * 1024 * 1024;
const CHECKSUM = /^[a-f0-9]{64}$/;

export interface ResourceTaskPayloadReferenceIdentity {
  readonly taskId: string;
  readonly attempt: number;
  readonly inputHash: string;
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly revisionId: string;
}

/**
 * The implementation must hold the same durable exclusion used by candidate
 * and Resource Revision insertion for the entire callback. Returning false
 * means a candidate/Revision reference exists (or absence cannot be proven).
 */
export interface ResourceTaskPayloadReferenceGuard {
  removeIfUnreferenced(
    identity: ResourceTaskPayloadReferenceIdentity,
    removeOwnedPayload: () => Promise<void>,
  ): Promise<boolean>;
}

export interface OwnedResourceTaskPayloadStagingOptions {
  readonly storageRoot: string;
  readonly references: ResourceTaskPayloadReferenceGuard;
  readonly journal: ResourceTaskPayloadJournalPort;
  readonly now?: () => number;
}

export interface ResourceTaskPayloadJournalPort {
  beginResourcePayloadStaging(input: ResourcePayloadStagingBeginInput): ResourcePayloadStagingJournal;
  getResourcePayloadStaging(input: ResourcePayloadCleanupIdentity): ResourcePayloadStagingJournal | null;
  classifyResourcePayloadStaging(input: ClassifyResourcePayloadStagingInput): ResourcePayloadStagingJournal;
  completeResourcePayloadStaging(input: CompleteResourcePayloadStagingInput): ResourcePayloadStagingJournal;
}

export interface ResourceTaskPayloadReceiptCursor {
  readonly relativePath: string;
}

export interface ResourceTaskPayloadReceiptScanPage {
  readonly receipts: ReadonlyArray<{
    readonly relativePath: string;
    readonly receipt: ResourceTaskPayloadReceipt;
  }>;
  readonly invalidReceiptPaths: readonly string[];
  readonly scanned: number;
  readonly nextCursor: ResourceTaskPayloadReceiptCursor | null;
}

export function resourceTaskReceiptRelativePath(workspaceId: string, revisionId: string): string {
  return posix.join(
    posix.dirname(resourceRevisionManifestRelativePath(workspaceId, revisionId)),
    RECEIPT_FILE,
  );
}

/**
 * Production owned-storage adapter for Resource generation payloads.
 *
 * `snapshotBytes` owns MIME/content verification and immutable payload sealing.
 * This adapter adds an atomic attempt receipt, verifies both receipt and sealed
 * bytes on replay, and delegates deletion to an atomic durable-reference guard.
 */
export class OwnedResourceTaskPayloadStaging implements ResourceTaskPayloadStagingPort {
  readonly #storageRoot: string;
  readonly #removeIfUnreferenced: ResourceTaskPayloadReferenceGuard["removeIfUnreferenced"];
  readonly #beginStaging: ResourceTaskPayloadJournalPort["beginResourcePayloadStaging"];
  readonly #getStaging: ResourceTaskPayloadJournalPort["getResourcePayloadStaging"];
  readonly #classifyStaging: ResourceTaskPayloadJournalPort["classifyResourcePayloadStaging"];
  readonly #completeStaging: ResourceTaskPayloadJournalPort["completeResourcePayloadStaging"];
  readonly #now: () => number;

  constructor(options: OwnedResourceTaskPayloadStagingOptions) {
    if (typeof options.storageRoot !== "string" || options.storageRoot.length === 0) {
      throw new ResourceTaskPayloadError(
        "RESOURCE_PAYLOAD_STAGE_FAILED",
        "Owned Resource payload storage root is invalid",
      );
    }
    const references = options.references;
    const removeIfUnreferenced = references?.removeIfUnreferenced;
    if (references === null || typeof references !== "object"
      || typeof removeIfUnreferenced !== "function") {
      throw new ResourceTaskPayloadError(
        "RESOURCE_PAYLOAD_STAGE_FAILED",
        "Owned Resource payload reference guard is invalid",
      );
    }
    this.#storageRoot = options.storageRoot;
    this.#removeIfUnreferenced = removeIfUnreferenced.bind(references);
    const journal = options.journal;
    if (journal === null || typeof journal !== "object"
      || typeof journal.beginResourcePayloadStaging !== "function"
      || typeof journal.getResourcePayloadStaging !== "function"
      || typeof journal.classifyResourcePayloadStaging !== "function"
      || typeof journal.completeResourcePayloadStaging !== "function") {
      throw new ResourceTaskPayloadError(
        "RESOURCE_PAYLOAD_STAGE_FAILED",
        "Owned Resource payload journal port is invalid",
      );
    }
    this.#beginStaging = journal.beginResourcePayloadStaging.bind(journal);
    this.#getStaging = journal.getResourcePayloadStaging.bind(journal);
    this.#classifyStaging = journal.classifyResourcePayloadStaging.bind(journal);
    this.#completeStaging = journal.completeResourcePayloadStaging.bind(journal);
    this.#now = options.now ?? Date.now;
  }

  async find(scope: ResourceTaskPayloadScope): Promise<ResourceTaskPayloadReceipt | null> {
    checkAbort(scope.signal);
    try {
      const root = await canonicalStorageRoot(this.#storageRoot);
      checkAbort(scope.signal);
      const relativePath = resourceTaskReceiptRelativePath(scope.workspaceId, scope.revisionId);
      const absolutePath = ownedPath(root, relativePath, "Resource generation receipt");
      // The Task budget covers adapter-authored bytes and JSON. The receipt's
      // executor-authored identity envelope has its own independent hard cap.
      const bytes = await readOwnedFile(root, absolutePath, MAX_RECEIPT_BYTES, true);
      if (bytes === null) return null;
      const raw = parseReceipt(bytes);
      const receipt = validateResourceTaskPayloadReceipt(raw, scope);
      await verifyResourceRevisionPayload(root, payloadDescriptor(receipt), { signal: scope.signal });
      const journal = this.#getStaging(cleanupIdentity(receipt));
      if (journal === null) {
        throw new ResourceTaskPayloadError(
          "RESOURCE_PAYLOAD_RECEIPT_INVALID",
          "Owned Resource payload receipt has no exact durable staging journal",
        );
      }
      assertJournalReceipt(journal, receipt, bytes);
      const completed = journal.status === "receipt-committed"
        ? journal
        : this.#completeStaging({
            ...cleanupIdentity(receipt),
            lease: requirePayloadLease(scope),
            receiptChecksum: journal.receiptChecksum,
          });
      assertSameJournal(completed, journal);
      if (completed.status !== "receipt-committed") {
        throw new ResourceTaskPayloadError(
          "RESOURCE_PAYLOAD_RECEIPT_INVALID",
          "Owned Resource payload receipt journal did not settle",
        );
      }
      checkAbort(scope.signal);
      return receipt;
    } catch (error) {
      if (scope.signal.aborted) throw abortReason(scope.signal);
      if (error instanceof ResourceTaskPayloadError) throw error;
      throw new ResourceTaskPayloadError(
        "RESOURCE_PAYLOAD_LOOKUP_FAILED",
        "Owned Resource payload receipt lookup or verification failed",
        error,
      );
    }
  }

  async stage(input: ResourceTaskPayloadStageInput): Promise<ResourceTaskPayloadReceipt> {
    checkAbort(input.signal);
    const planned = plannedPayload(input);
    let journal: ResourcePayloadStagingJournal | null = null;
    let exactJournal = false;
    try {
      journal = this.#beginStaging(planned.journal);
      assertSameJournal(journal, planned.journal);
      exactJournal = true;
      const root = await canonicalStorageRoot(this.#storageRoot);
      const createdAt = this.#now();
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
        throw new ResourceTaskPayloadError(
          "RESOURCE_PAYLOAD_STAGE_FAILED",
          "Owned Resource payload clock returned an invalid timestamp",
        );
      }
      checkAbort(input.signal);
      const disposition = journal.storageDisposition ?? await classifyStorage(root, journal);
      journal = this.#classifyStaging({
        ...cleanupIdentity(planned.receipt),
        lease: input.lease,
        storageDisposition: disposition,
      });
      assertSameJournal(journal, planned.journal);
      if (journal.storageDisposition === null) {
        throw new ResourceTaskPayloadError(
          "RESOURCE_PAYLOAD_STAGE_FAILED",
          "Owned Resource payload journal was not classified before storage",
        );
      }
      const snapshot = await snapshotBytes({
        workspaceId: input.workspaceId,
        resourceId: input.resourceId,
        revisionId: input.revisionId,
        kind: input.adapter.kind,
        workspaceRoot: root,
        snapshotRoot: root,
        source: {
          type: "bounded-external",
          url: `dezin://generation/${encodeURIComponent(input.taskId)}/${input.attempt}`,
          finalUrl: `dezin://generation/${encodeURIComponent(input.taskId)}/${input.attempt}`,
          status: 200,
          mimeType: input.mimeType,
          bytes: new Uint8Array(input.bytes),
        },
        provenance: {
          kind: "generation-task-resource-payload",
          taskId: input.taskId,
          attempt: input.attempt,
          inputHash: input.inputHash,
          adapter: { ...input.adapter },
        },
        createdAt,
      }, new Uint8Array(input.bytes), input.mimeType);
      if (snapshot.manifestPath !== journal.manifestPath
        || snapshot.checksum !== journal.manifestChecksum
        || snapshot.payloadChecksum !== journal.payloadChecksum
        || snapshot.byteSize !== journal.byteSize
        || snapshot.mimeType !== journal.mimeType
        || (journal.storageDisposition === "preexisting" && snapshot.storageState !== "existing")) {
        throw new ResourceTaskPayloadError(
          "RESOURCE_PAYLOAD_STAGE_FAILED",
          "Owned Resource payload storage result diverged from its durable journal",
        );
      }
      checkAbort(input.signal);
      const relativePath = resourceTaskReceiptRelativePath(input.workspaceId, input.revisionId);
      const absolutePath = ownedPath(root, relativePath, "Resource generation receipt");
      await immutableReceiptWrite(root, absolutePath, planned.receiptBytes);
      journal = this.#completeStaging({
        ...cleanupIdentity(planned.receipt),
        lease: input.lease,
        receiptChecksum: planned.receiptChecksum,
      });
      assertSameJournal(journal, planned.journal);
      if (journal.status !== "receipt-committed") {
        throw new ResourceTaskPayloadError(
          "RESOURCE_PAYLOAD_STAGE_FAILED",
          "Owned Resource payload receipt journal did not settle",
        );
      }
      checkAbort(input.signal);
      const replay = await this.find(input);
      if (replay === null) {
        throw new ResourceTaskPayloadError(
          "RESOURCE_PAYLOAD_STAGE_FAILED",
          "Owned Resource payload receipt disappeared after staging",
        );
      }
      return replay;
    } catch (error) {
      if (journal !== null && exactJournal) {
        await this.cleanupJournalIfUnreferenced(journal).catch(() => false);
      }
      if (input.signal.aborted) throw abortReason(input.signal);
      if (error instanceof ResourceTaskPayloadError) throw error;
      throw new ResourceTaskPayloadError(
        "RESOURCE_PAYLOAD_STAGE_FAILED",
        "Owned Resource payload sealing or receipt staging failed",
        error,
      );
    }
  }

  async cleanupIfUnreferenced(receipt: ResourceTaskPayloadReceipt): Promise<boolean> {
    const journal = this.#getStaging(cleanupIdentity(receipt));
    if (journal === null) {
      throw new ResourceTaskPayloadError(
        "RESOURCE_PAYLOAD_CLEANUP_FAILED",
        "Owned Resource payload cleanup has no exact durable staging journal",
      );
    }
    assertJournalReceipt(journal, receipt, receiptBytes(receipt));
    return this.cleanupJournalIfUnreferenced(journal);
  }

  async cleanupJournalIfUnreferenced(journal: ResourcePayloadStagingJournal): Promise<boolean> {
    assertJournal(journal);
    const identity = journalIdentity(journal);
    try {
      return await this.#removeIfUnreferenced(identity, async () => {
        const root = await canonicalStorageRoot(this.#storageRoot);
        await verifyJournalFilesForCleanup(root, journal);
        const receiptPath = ownedPath(
          root,
          resourceTaskReceiptRelativePath(journal.workspaceId, journal.revisionId),
          "Resource generation receipt",
        );
        const manifestPath = ownedPath(root, journal.manifestPath, "Resource payload manifest");
        const payloadPath = ownedPath(
          root,
          posix.join(posix.dirname(journal.manifestPath), "payload.bin"),
          "Resource payload bytes",
        );
        await removeOwnedFile(root, receiptPath);
        if (journal.storageDisposition !== "owned-created") return;
        await removeOwnedFile(root, manifestPath);
        await removeOwnedFile(root, payloadPath);
        const revisionDirectory = dirname(manifestPath);
        await rmdir(revisionDirectory).catch((error) => {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
        });
        await syncDirectory(dirname(revisionDirectory));
      });
    } catch (error) {
      if (error instanceof ResourceTaskPayloadError) throw error;
      throw new ResourceTaskPayloadError(
        "RESOURCE_PAYLOAD_CLEANUP_FAILED",
        "Owned Resource payload orphan cleanup failed",
        error,
      );
    }
  }

  async scanReceipts(input: {
    readonly cursor?: ResourceTaskPayloadReceiptCursor | null;
    readonly limit?: number;
    readonly signal: AbortSignal;
  }): Promise<ResourceTaskPayloadReceiptScanPage> {
    checkAbort(input.signal);
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new ResourceTaskPayloadError(
        "RESOURCE_PAYLOAD_LOOKUP_FAILED",
        "Resource payload receipt scan limit must be a safe integer from 1 through 1000",
      );
    }
    const cursor = normalizeReceiptCursor(input.cursor);
    try {
      const root = await canonicalStorageRoot(this.#storageRoot);
      const relativePaths = await boundedReceiptPaths(root, cursor?.relativePath ?? null, limit, input.signal);
      const receipts: Array<{ relativePath: string; receipt: ResourceTaskPayloadReceipt }> = [];
      const invalidReceiptPaths: string[] = [];
      for (const relativePath of relativePaths) {
        checkAbort(input.signal);
        try {
          const absolutePath = ownedPath(root, relativePath, "Scanned Resource generation receipt");
          const bytes = await readOwnedFile(root, absolutePath, MAX_RECEIPT_BYTES, false);
          if (bytes === null) throw new Error("receipt disappeared");
          const raw = parseReceipt(bytes);
          const scope = scannedReceiptScope(raw, input.signal);
          const receipt = validateResourceTaskPayloadReceipt(raw, scope);
          if (relativePath !== resourceTaskReceiptRelativePath(receipt.workspaceId, receipt.revisionId)) {
            throw new ResourceTaskPayloadError(
              "RESOURCE_PAYLOAD_RECEIPT_INVALID",
              "Scanned Resource payload receipt does not match its owned path",
            );
          }
          await verifyResourceRevisionPayload(root, payloadDescriptor(receipt), { signal: input.signal });
          receipts.push({ relativePath, receipt });
        } catch (error) {
          if (input.signal.aborted) throw abortReason(input.signal);
          invalidReceiptPaths.push(relativePath);
        }
      }
      const last = relativePaths.at(-1);
      return {
        receipts,
        invalidReceiptPaths,
        scanned: relativePaths.length,
        nextCursor: relativePaths.length === limit && last !== undefined
          ? { relativePath: last }
          : null,
      };
    } catch (error) {
      if (input.signal.aborted) throw abortReason(input.signal);
      if (error instanceof ResourceTaskPayloadError) throw error;
      throw new ResourceTaskPayloadError(
        "RESOURCE_PAYLOAD_LOOKUP_FAILED",
        "Owned Resource payload receipt scan failed",
        error,
      );
    }
  }
}

interface PlannedResourcePayload {
  readonly journal: ResourcePayloadStagingBeginInput;
  readonly receipt: ResourceTaskPayloadReceipt;
  readonly receiptBytes: Buffer;
  readonly receiptChecksum: string;
}

function plannedPayload(input: ResourceTaskPayloadStageInput): PlannedResourcePayload {
  const payloadChecksum = sha256(input.bytes);
  const manifestPath = resourceRevisionManifestRelativePath(input.workspaceId, input.revisionId);
  const manifestBytes = expectedManifestBytes({
    workspaceId: input.workspaceId,
    resourceId: input.resourceId,
    revisionId: input.revisionId,
    payloadChecksum,
    byteSize: input.bytes.byteLength,
    mimeType: input.mimeType,
  });
  const manifestChecksum = sha256(manifestBytes);
  const receipt = validateResourceTaskPayloadReceipt({
    protocol: RECEIPT_PROTOCOL,
    taskId: input.taskId,
    attempt: input.attempt,
    inputHash: input.inputHash,
    workspaceId: input.workspaceId,
    resourceId: input.resourceId,
    revisionId: input.revisionId,
    parentRevisionId: input.parentRevisionId,
    adapter: { ...input.adapter },
    manifestPath,
    manifestChecksum,
    payloadChecksum,
    byteSize: input.bytes.byteLength,
    mimeType: input.mimeType,
    summary: input.summary,
    metadata: input.metadata,
    provenance: input.provenance,
    evidence: input.evidence,
  }, input, input);
  const bytes = receiptBytes(receipt);
  const receiptChecksum = sha256(bytes);
  return {
    journal: {
      ...cleanupIdentity(receipt),
      lease: input.lease,
      manifestPath,
      payloadChecksum,
      manifestChecksum,
      receiptChecksum,
      byteSize: receipt.byteSize,
      mimeType: receipt.mimeType,
    },
    receipt,
    receiptBytes: bytes,
    receiptChecksum,
  };
}

function expectedManifestBytes(input: {
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly revisionId: string;
  readonly payloadChecksum: string;
  readonly byteSize: number;
  readonly mimeType: string;
}): Buffer {
  return Buffer.from(`${stableStringify({
    protocol: RESOURCE_REVISION_PAYLOAD_PROTOCOL,
    workspaceId: input.workspaceId,
    resourceId: input.resourceId,
    resourceRevisionId: input.revisionId,
    payload: {
      file: "payload.bin",
      mimeType: input.mimeType,
      byteLength: input.byteSize,
      checksum: input.payloadChecksum,
    },
  })}\n`, "utf8");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function journalIdentity(journal: ResourcePayloadStagingJournal): ResourcePayloadCleanupIdentity {
  return {
    taskId: journal.taskId,
    attempt: journal.attempt,
    inputHash: journal.inputHash,
    workspaceId: journal.workspaceId,
    resourceId: journal.resourceId,
    revisionId: journal.revisionId,
  };
}

function assertSameJournal(
  actual: ResourcePayloadStagingJournal,
  expected: ResourcePayloadStagingBeginInput | ResourcePayloadStagingJournal,
): void {
  const expectedOwnerId = "lease" in expected ? expected.lease.ownerId : expected.ownerId;
  const expectedLeaseToken = "lease" in expected ? expected.lease.leaseToken : expected.leaseToken;
  if (actual.taskId !== expected.taskId
    || actual.attempt !== expected.attempt
    || actual.inputHash !== expected.inputHash
    || actual.workspaceId !== expected.workspaceId
    || actual.resourceId !== expected.resourceId
    || actual.revisionId !== expected.revisionId
    || actual.ownerId !== expectedOwnerId
    || actual.leaseToken !== expectedLeaseToken
    || actual.manifestPath !== expected.manifestPath
    || actual.payloadChecksum !== expected.payloadChecksum
    || actual.manifestChecksum !== expected.manifestChecksum
    || actual.receiptChecksum !== expected.receiptChecksum
    || actual.byteSize !== expected.byteSize
    || actual.mimeType !== expected.mimeType) {
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_STAGE_FAILED",
      "Owned Resource payload Store returned a mismatched staging journal",
    );
  }
}

function assertJournal(journal: ResourcePayloadStagingJournal): void {
  if (!Number.isSafeInteger(journal.sequence) || journal.sequence < 1
    || !Number.isSafeInteger(journal.attempt) || journal.attempt < 1
    || !Number.isSafeInteger(journal.byteSize) || journal.byteSize < 0
    || !CHECKSUM.test(journal.inputHash)
    || !CHECKSUM.test(journal.payloadChecksum)
    || !CHECKSUM.test(journal.manifestChecksum)
    || !CHECKSUM.test(journal.receiptChecksum)
    || typeof journal.ownerId !== "string" || journal.ownerId.length === 0
    || typeof journal.leaseToken !== "string" || journal.leaseToken.length === 0
    || journal.manifestPath !== resourceRevisionManifestRelativePath(
      journal.workspaceId,
      journal.revisionId,
    )
    || (journal.status !== "prepared" && journal.status !== "receipt-committed")
    || (journal.storageDisposition !== null
      && journal.storageDisposition !== "owned-created"
      && journal.storageDisposition !== "preexisting")) {
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_CLEANUP_FAILED",
      "Owned Resource payload cleanup journal identity is invalid",
    );
  }
}

function assertJournalReceipt(
  journal: ResourcePayloadStagingJournal,
  receipt: ResourceTaskPayloadReceipt,
  bytes: Buffer,
): void {
  assertJournal(journal);
  assertCleanupReceipt(receipt);
  if (sha256(bytes) !== journal.receiptChecksum
    || receipt.taskId !== journal.taskId
    || receipt.attempt !== journal.attempt
    || receipt.inputHash !== journal.inputHash
    || receipt.workspaceId !== journal.workspaceId
    || receipt.resourceId !== journal.resourceId
    || receipt.revisionId !== journal.revisionId
    || receipt.manifestPath !== journal.manifestPath
    || receipt.manifestChecksum !== journal.manifestChecksum
    || receipt.payloadChecksum !== journal.payloadChecksum
    || receipt.byteSize !== journal.byteSize
    || receipt.mimeType !== journal.mimeType) {
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_RECEIPT_INVALID",
      "Owned Resource payload receipt diverges from its durable journal",
    );
  }
}

async function classifyStorage(
  root: string,
  journal: ResourcePayloadStagingJournal,
): Promise<"owned-created" | "preexisting"> {
  assertJournal(journal);
  const manifestPath = ownedPath(root, journal.manifestPath, "Resource payload manifest");
  const payloadPath = ownedPath(
    root,
    posix.join(posix.dirname(journal.manifestPath), "payload.bin"),
    "Resource payload bytes",
  );
  const receiptPath = ownedPath(
    root,
    resourceTaskReceiptRelativePath(journal.workspaceId, journal.revisionId),
    "Resource generation receipt",
  );
  const [manifest, payload, receipt] = await Promise.all([
    readOwnedFile(root, manifestPath, MAX_RECEIPT_BYTES, true),
    readOwnedFile(root, payloadPath, journal.byteSize, true),
    readOwnedFile(root, receiptPath, MAX_RECEIPT_BYTES, true),
  ]);
  if (manifest === null && payload === null && receipt === null) return "owned-created";
  if (manifest === null || payload === null) {
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_STAGE_FAILED",
      "Owned Resource payload staging refused a partial pre-existing revision",
    );
  }
  const expectedManifest = expectedManifestBytes(journal);
  if (!manifest.equals(expectedManifest)
    || sha256(manifest) !== journal.manifestChecksum
    || payload.byteLength !== journal.byteSize
    || sha256(payload) !== journal.payloadChecksum
    || (receipt !== null && sha256(receipt) !== journal.receiptChecksum)) {
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_STAGE_FAILED",
      "Owned Resource payload staging refused a foreign immutable collision",
    );
  }
  return "preexisting";
}

async function verifyJournalFilesForCleanup(
  root: string,
  journal: ResourcePayloadStagingJournal,
): Promise<void> {
  assertJournal(journal);
  const manifestPath = ownedPath(root, journal.manifestPath, "Resource payload manifest");
  const payloadPath = ownedPath(
    root,
    posix.join(posix.dirname(journal.manifestPath), "payload.bin"),
    "Resource payload bytes",
  );
  const receiptPath = ownedPath(
    root,
    resourceTaskReceiptRelativePath(journal.workspaceId, journal.revisionId),
    "Resource generation receipt",
  );
  const [manifest, payload, receipt] = await Promise.all([
    readOwnedFile(root, manifestPath, MAX_RECEIPT_BYTES, true),
    readOwnedFile(root, payloadPath, journal.byteSize, true),
    readOwnedFile(root, receiptPath, MAX_RECEIPT_BYTES, true),
  ]);
  if (journal.storageDisposition === null) {
    if (manifest !== null || payload !== null || receipt !== null) {
      throw new ResourceTaskPayloadError(
        "RESOURCE_PAYLOAD_CLEANUP_FAILED",
        "Unclassified Resource payload journal cannot own filesystem objects",
      );
    }
    return;
  }
  if (manifest !== null) {
    const expected = expectedManifestBytes(journal);
    if (!manifest.equals(expected) || sha256(manifest) !== journal.manifestChecksum) {
      throw new ResourceTaskPayloadError(
        "RESOURCE_PAYLOAD_CLEANUP_FAILED",
        "Owned Resource payload cleanup refused changed manifest bytes",
      );
    }
  }
  if (payload !== null
    && (payload.byteLength !== journal.byteSize || sha256(payload) !== journal.payloadChecksum)) {
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_CLEANUP_FAILED",
      "Owned Resource payload cleanup refused changed payload bytes",
    );
  }
  if (receipt !== null && sha256(receipt) !== journal.receiptChecksum) {
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_CLEANUP_FAILED",
      "Owned Resource payload cleanup refused changed receipt bytes",
    );
  }
}

const RECEIPT_CURSOR_PATH = /^resource-revisions\/[a-f0-9]{64}\/[a-f0-9]{64}\/generation-receipt\.json$/;

function normalizeReceiptCursor(
  value: ResourceTaskPayloadReceiptCursor | null | undefined,
): ResourceTaskPayloadReceiptCursor | null {
  if (value === null || value === undefined) return null;
  try {
    if (typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError("cursor must be a plain object");
    }
    const keys = Reflect.ownKeys(value);
    const descriptor = Object.getOwnPropertyDescriptor(value, "relativePath");
    if (keys.length !== 1 || keys[0] !== "relativePath" || descriptor === undefined
      || !("value" in descriptor) || typeof descriptor.value !== "string"
      || !RECEIPT_CURSOR_PATH.test(descriptor.value)) {
      throw new TypeError("cursor path is invalid");
    }
    return { relativePath: descriptor.value };
  } catch (error) {
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_LOOKUP_FAILED",
      "Resource payload receipt scan cursor is invalid",
      error,
    );
  }
}

async function boundedReceiptPaths(
  root: string,
  after: string | null,
  limit: number,
  signal: AbortSignal,
): Promise<string[]> {
  const selected: string[] = [];
  const resourceRoot = join(root, "resource-revisions");
  for await (const workspaceEntry of ownedDirectoryEntries(root, resourceRoot)) {
    checkAbort(signal);
    if (!workspaceEntry.isDirectory() || workspaceEntry.isSymbolicLink()
      || !/^[a-f0-9]{64}$/.test(workspaceEntry.name)) continue;
    const workspaceDirectory = join(resourceRoot, workspaceEntry.name);
    for await (const revisionEntry of ownedDirectoryEntries(root, workspaceDirectory)) {
      checkAbort(signal);
      if (!revisionEntry.isDirectory() || revisionEntry.isSymbolicLink()
        || !/^[a-f0-9]{64}$/.test(revisionEntry.name)) continue;
      const relativePath = posix.join(
        "resource-revisions",
        workspaceEntry.name,
        revisionEntry.name,
        RECEIPT_FILE,
      );
      if (after !== null && relativePath <= after) continue;
      const receiptPath = join(workspaceDirectory, revisionEntry.name, RECEIPT_FILE);
      const exists = await lstat(receiptPath).then(() => true).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      });
      if (!exists) continue;
      insertBoundedPath(selected, relativePath, limit);
    }
  }
  return selected;
}

function insertBoundedPath(paths: string[], value: string, limit: number): void {
  let low = 0;
  let high = paths.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (paths[middle]! < value) low = middle + 1;
    else high = middle;
  }
  if (paths[low] === value) return;
  paths.splice(low, 0, value);
  if (paths.length > limit) paths.pop();
}

async function* ownedDirectoryEntries(root: string, path: string) {
  if (!inside(root, path)) {
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_LOOKUP_FAILED",
      "Resource payload receipt scan directory escapes owned storage",
    );
  }
  const metadata = await lstat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (metadata === null) return;
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || await realpath(path) !== path) {
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_LOOKUP_FAILED",
      "Resource payload receipt scan refused a changed or linked directory",
    );
  }
  const directory = await opendir(path);
  try {
    for await (const entry of directory) yield entry;
  } finally {
    await directory.close().catch(() => {});
  }
}

function scannedReceiptScope(value: unknown, signal: AbortSignal): ResourceTaskPayloadScope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_RECEIPT_INVALID",
      "Scanned Resource payload receipt must be an object",
    );
  }
  const receipt = value as Record<string, unknown>;
  const adapterValue = receipt.adapter;
  if (adapterValue === null || typeof adapterValue !== "object" || Array.isArray(adapterValue)) {
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_RECEIPT_INVALID",
      "Scanned Resource payload receipt adapter must be an object",
    );
  }
  const adapter = adapterValue as Record<string, unknown>;
  return {
    taskId: receipt.taskId as string,
    attempt: receipt.attempt as number,
    inputHash: receipt.inputHash as string,
    workspaceId: receipt.workspaceId as string,
    resourceId: receipt.resourceId as string,
    revisionId: receipt.revisionId as string,
    parentRevisionId: receipt.parentRevisionId as string | null,
    adapter: {
      id: adapter.id as string,
      version: adapter.version as number,
      kind: adapter.kind as ResourceTaskPayloadScope["adapter"]["kind"],
    },
    maxOutputBytes: MAX_RESOURCE_PAYLOAD_BYTES + MAX_RECEIPT_BYTES,
    signal,
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Resource payload operation aborted", "AbortError");
}

function requirePayloadLease(scope: ResourceTaskPayloadScope) {
  const lease = scope.lease;
  if (lease === undefined || lease.taskId !== scope.taskId
    || lease.attempt !== scope.attempt || lease.workspaceId !== scope.workspaceId) {
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_STAGE_FAILED",
      "Resource payload operation is missing its exact Attempt lease",
    );
  }
  return lease;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

async function canonicalStorageRoot(storageRoot: string): Promise<string> {
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const metadata = await lstat(storageRoot);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_STAGE_FAILED",
      "Owned Resource payload storage root cannot be a symlink or non-directory",
    );
  }
  return realpath(storageRoot);
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function ownedPath(root: string, relativePath: string, label: string): string {
  if (typeof relativePath !== "string" || relativePath.length === 0
    || posix.isAbsolute(relativePath) || relativePath.includes("\\")
    || relativePath.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_RECEIPT_INVALID",
      `${label} path is not portable`,
    );
  }
  const absolutePath = join(root, ...relativePath.split("/"));
  if (!inside(root, absolutePath)) {
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_RECEIPT_INVALID",
      `${label} path escapes owned storage`,
    );
  }
  return absolutePath;
}

async function readOwnedFile(
  root: string,
  path: string,
  maxBytes: number,
  optional: boolean,
): Promise<Buffer | null> {
  if (!inside(root, path)) {
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_RECEIPT_INVALID",
      "Owned Resource file path escapes storage",
    );
  }
  const parentsExist = await verifyOwnedParentDirectories(root, path);
  if (!parentsExist) {
    if (optional) return null;
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_RECEIPT_INVALID",
      "Owned Resource file parent directory is missing",
    );
  }
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes) {
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_RECEIPT_INVALID",
      "Owned Resource file is a symlink, non-file, or exceeds its byte limit",
    );
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new ResourceTaskPayloadError(
        "RESOURCE_PAYLOAD_RECEIPT_INVALID",
        "Owned Resource file changed while being opened",
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.byteLength !== opened.size || after.dev !== opened.dev
      || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new ResourceTaskPayloadError(
        "RESOURCE_PAYLOAD_RECEIPT_INVALID",
        "Owned Resource file changed while being read",
      );
    }
    return bytes;
  } finally {
    await handle.close().catch(() => {});
  }
}

function parseReceipt(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_RECEIPT_INVALID",
      "Owned Resource payload receipt is not valid UTF-8 JSON",
      error,
    );
  }
}

function receiptBytes(receipt: ResourceTaskPayloadReceipt): Buffer {
  return Buffer.from(`${stableStringify(receipt)}\n`, "utf8");
}

async function immutableReceiptWrite(root: string, path: string, bytes: Buffer): Promise<void> {
  if (bytes.byteLength > MAX_RECEIPT_BYTES) {
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_STAGE_FAILED",
      "Owned Resource payload receipt exceeds its durable byte limit",
    );
  }
  const directory = dirname(path);
  const resolvedDirectory = await realpath(directory);
  if (!inside(root, resolvedDirectory) || resolvedDirectory !== directory) {
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_STAGE_FAILED",
      "Owned Resource payload receipt directory changed or escapes storage",
    );
  }
  const temporaryPath = join(directory, `.generation-receipt-${randomUUID()}.tmp`);
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o400,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close().catch(() => {});
  }
  try {
    await link(temporaryPath, path);
    await syncDirectory(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readOwnedFile(root, path, MAX_RECEIPT_BYTES, false);
    if (existing === null || !existing.equals(bytes)) {
      throw new ResourceTaskPayloadError(
        "RESOURCE_PAYLOAD_RECEIPT_INVALID",
        "Owned Resource payload receipt immutable identity collision",
      );
    }
  } finally {
    await rm(temporaryPath, { force: true });
    await syncDirectory(directory);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => {});
  }
}

function payloadDescriptor(receipt: ResourceTaskPayloadReceipt): ResourceRevisionPayloadDescriptor {
  return {
    protocol: RESOURCE_REVISION_PAYLOAD_PROTOCOL,
    workspaceId: receipt.workspaceId,
    resourceId: receipt.resourceId,
    resourceRevisionId: receipt.revisionId,
    resourceKind: receipt.adapter.kind,
    manifestPath: receipt.manifestPath,
    manifestChecksum: receipt.manifestChecksum,
    payloadPath: posix.join(posix.dirname(receipt.manifestPath), "payload.bin"),
    payloadChecksum: receipt.payloadChecksum,
    byteLength: receipt.byteSize,
    mimeType: receipt.mimeType,
    mountPath: posix.join(
      ".dezin",
      "resources",
      resourceRevisionMountKey(receipt.revisionId),
      "payload.bin",
    ),
    publicUrl: resourceRevisionPublicRoot(receipt.revisionId),
  };
}

function cleanupIdentity(receipt: ResourceTaskPayloadReceipt): ResourceTaskPayloadReferenceIdentity {
  assertCleanupReceipt(receipt);
  return {
    taskId: receipt.taskId,
    attempt: receipt.attempt,
    inputHash: receipt.inputHash,
    workspaceId: receipt.workspaceId,
    resourceId: receipt.resourceId,
    revisionId: receipt.revisionId,
  };
}

function assertCleanupReceipt(receipt: ResourceTaskPayloadReceipt): void {
  const expectedManifest = resourceRevisionManifestRelativePath(receipt.workspaceId, receipt.revisionId);
  if (receipt.protocol !== RECEIPT_PROTOCOL || receipt.manifestPath !== expectedManifest
    || !CHECKSUM.test(receipt.manifestChecksum) || !CHECKSUM.test(receipt.payloadChecksum)
    || !Number.isSafeInteger(receipt.attempt) || receipt.attempt < 1
    || !Number.isSafeInteger(receipt.byteSize) || receipt.byteSize < 0) {
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_CLEANUP_FAILED",
      "Owned Resource payload cleanup receipt identity is invalid",
    );
  }
}

async function removeOwnedFile(root: string, path: string): Promise<void> {
  if (!inside(root, path)) {
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_CLEANUP_FAILED",
      "Owned Resource cleanup path escapes storage",
    );
  }
  if (!await verifyOwnedParentDirectories(root, path)) return;
  const metadata = await lstat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (metadata === null) return;
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_CLEANUP_FAILED",
      "Owned Resource cleanup refused a symlink or non-file",
    );
  }
  await rm(path);
  await syncDirectory(dirname(path));
}

async function verifyOwnedParentDirectories(root: string, path: string): Promise<boolean> {
  const directories: string[] = [];
  let current = dirname(path);
  while (current !== root) {
    if (!inside(root, current) || current === dirname(current)) {
      throw new ResourceTaskPayloadError(
        "RESOURCE_PAYLOAD_RECEIPT_INVALID",
        "Owned Resource path parent escapes storage",
      );
    }
    directories.push(current);
    current = dirname(current);
  }
  for (const directory of directories.reverse()) {
    const metadata = await lstat(directory).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (metadata === null) return false;
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || await realpath(directory) !== directory) {
      throw new ResourceTaskPayloadError(
        "RESOURCE_PAYLOAD_RECEIPT_INVALID",
        "Owned Resource path parent is linked or changed",
      );
    }
  }
  return true;
}
