/**
 * Asset import transactions: the durable WAL that commits content-addressed Assets, material
 * Versions, and the Canvas head as one recoverable operation, plus idempotent batch receipts.
 * Split out of design-asset-version-publication.ts; the facade there wires these
 * modules together and remains the only entry point.
 */
import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import {
  basename,
  join,
  resolve,
} from "node:path";
import {
  DESIGN_GENERATIVE_NODE_KINDS,
  DESIGN_SCHEMA_VERSION,
  type DesignAssetManifest,
  type DesignCanvas,
  type DesignNode,
  type DesignVersionManifest,
} from "./design-types.ts";
import {
  stableStringify,
} from "../canonical-json.ts";
import {
  DesignRevisionConflictError,
  DesignStorageError,
  MAX_DESIGN_ASSET_BATCH_BYTES,
  MAX_DESIGN_ASSET_BATCH_ITEMS,
  MAX_HISTORY,
  SAFE_SEGMENT,
  SHA256,
  assetRoot,
  designRoot,
  ensureDurableDirectory,
  exists,
  nodeRoot,
  nowValue,
  projectFilePath,
  readJson,
  safeSegment,
  storedRecord,
  syncDesignDirectory,
  validStoredNullableId,
  validStoredTimestamp,
  validStoredViewport,
  withProjectLock,
  writeAtomic,
  writeAtomicJson,
  writeAuthorityJson,
} from "./design-storage-primitives.ts";
import {
  assetImportReceiptId,
  assetImportReceiptPath,
  assetImportReceiptsRoot,
  assetImportTransactionChecksum,
  assetImportTransactionsRoot,
  matchesMaterialNodeKind,
  mimeType,
  versionRoot,
  type DesignAssetImportIdempotency,
  type DesignAssetImportOutcome,
  type DesignAssetImportTransaction,
  type DesignAssetImportTransactionBinding,
} from "./design-publication-primitives.ts";
import type {
  DesignAssetStoreInput,
  DesignCanvasAssetImport,
  DesignAssetPayloadReadTestHooks,
  DesignAssetImportTestHooks,
  EnsureDesignCanvasAssetBatchInput,
  EnsuredDesignCanvasAssetBatch,
  ImportedDesignMaterialVersion,
} from "./design-asset-version-publication.ts";
import type { DesignSourceVersionSnapshot, DesignAssetPreparation } from "./design-asset-preparation.ts";
import type { DesignAssetResolution } from "./design-asset-resolution.ts";
import type { DesignVersionPublication } from "./design-version-publication.ts";
import type { DesignCanvasState } from "./design-canvas-state.ts";

export interface DesignAssetImportDeps extends Pick<DesignCanvasState, "assertStoredProject" | "addNode" | "canvas" | "cloneNode" | "readNodes" | "readProject" | "requireInitialized" | "snapshot"> {
  snapshotDesignSourceVersions: DesignAssetPreparation["snapshotDesignSourceVersions"];
  prepareDesignAsset: DesignAssetPreparation["prepareDesignAsset"];
  discardPreparedDesignAsset: DesignAssetPreparation["discardPreparedDesignAsset"];
  persistPreparedDesignAsset: DesignAssetPreparation["persistPreparedDesignAsset"];
  stagePreparedDesignAsset: DesignAssetPreparation["stagePreparedDesignAsset"];
  getDesignAssetManifestUnlocked: DesignAssetResolution["getDesignAssetManifestUnlocked"];
  assertStoredVersionManifest: DesignVersionPublication["assertStoredVersionManifest"];
}

export function createDesignAssetImport(deps: DesignAssetImportDeps) {
  const assertStoredProject: DesignCanvasState["assertStoredProject"] = deps.assertStoredProject;
  const addNode: DesignCanvasState["addNode"] = deps.addNode;
  const canvas: DesignCanvasState["canvas"] = deps.canvas;
  const cloneNode: DesignCanvasState["cloneNode"] = deps.cloneNode;
  const readNodes: DesignCanvasState["readNodes"] = deps.readNodes;
  const readProject: DesignCanvasState["readProject"] = deps.readProject;
  const requireInitialized: DesignCanvasState["requireInitialized"] = deps.requireInitialized;
  const snapshot: DesignCanvasState["snapshot"] = deps.snapshot;
  const snapshotDesignSourceVersions: DesignAssetPreparation["snapshotDesignSourceVersions"] = deps.snapshotDesignSourceVersions;
  const prepareDesignAsset: DesignAssetPreparation["prepareDesignAsset"] = deps.prepareDesignAsset;
  const discardPreparedDesignAsset: DesignAssetPreparation["discardPreparedDesignAsset"] = deps.discardPreparedDesignAsset;
  const persistPreparedDesignAsset: DesignAssetPreparation["persistPreparedDesignAsset"] = deps.persistPreparedDesignAsset;
  const stagePreparedDesignAsset: DesignAssetPreparation["stagePreparedDesignAsset"] = deps.stagePreparedDesignAsset;
  const getDesignAssetManifestUnlocked: DesignAssetResolution["getDesignAssetManifestUnlocked"] = deps.getDesignAssetManifestUnlocked;
  const assertStoredVersionManifest: DesignVersionPublication["assertStoredVersionManifest"] = deps.assertStoredVersionManifest;

  function assertStoredAssetImportCanvas(
    value: unknown,
    expectedProjectId: string,
    expectedRevision: number,
  ): asserts value is DesignCanvas {
    const record = storedRecord(value, "Design Asset import result Canvas", [
      "schemaVersion", "projectId", "revision", "viewport", "nodeOrder", "nodes", "connections",
      "undoDepth", "redoDepth", "createdAt", "updatedAt",
    ]);
    if (record.schemaVersion !== DESIGN_SCHEMA_VERSION || record.projectId !== expectedProjectId
      || record.revision !== expectedRevision || !validStoredViewport(record.viewport)
      || !Array.isArray(record.nodeOrder) || !Array.isArray(record.nodes)
      || (record.connections !== undefined && !Array.isArray(record.connections))
      || !Number.isSafeInteger(record.undoDepth) || (record.undoDepth as number) < 0
      || (record.undoDepth as number) > MAX_HISTORY
      || !Number.isSafeInteger(record.redoDepth) || (record.redoDepth as number) < 0
      || (record.redoDepth as number) > MAX_HISTORY
      || !validStoredTimestamp(record.createdAt) || !validStoredTimestamp(record.updatedAt)) {
      throw new DesignStorageError("corrupt", "Design Asset import result Canvas is invalid");
    }
    const syntheticProject = {
      schemaVersion: DESIGN_SCHEMA_VERSION,
      projectId: expectedProjectId,
      revision: expectedRevision,
      viewport: record.viewport,
      nodeOrder: record.nodeOrder,
      nodes: record.nodes,
      ...(record.connections === undefined ? {} : { connections: record.connections }),
      retiredNodeIds: [],
      undo: [],
      redo: [],
      turnReceipts: {},
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
    assertStoredProject(syntheticProject, expectedProjectId);
  }

  function assertAssetImportTransaction(
    value: unknown,
    expectedProjectId: string,
  ): asserts value is DesignAssetImportTransaction {
    const record = storedRecord(value, "Design Asset import transaction", [
      "schemaVersion", "projectId", "expectedRevision", "nextRevision", "createdAssetIds", "bindings",
      "idempotency", "canvasAfter", "checksum",
    ]);
    const transaction = record as unknown as DesignAssetImportTransaction;
    if (transaction.schemaVersion !== DESIGN_SCHEMA_VERSION
      || transaction.projectId !== expectedProjectId || !SAFE_SEGMENT.test(expectedProjectId)
      || !Number.isSafeInteger(transaction.expectedRevision) || (transaction.expectedRevision as number) < 0
      || !Number.isSafeInteger(transaction.nextRevision)
      || transaction.nextRevision !== (transaction.expectedRevision as number) + 1
      || !Array.isArray(transaction.createdAssetIds)
      || transaction.createdAssetIds.length > MAX_DESIGN_ASSET_BATCH_ITEMS
      || !Array.isArray(transaction.bindings)
      || transaction.bindings.length < 1
      || transaction.bindings.length > MAX_DESIGN_ASSET_BATCH_ITEMS
      || typeof transaction.checksum !== "string" || !SHA256.test(transaction.checksum)) {
      throw new DesignStorageError("corrupt", "Design Asset import transaction is invalid");
    }
    const { checksum, ...content } = transaction;
    if (checksum !== assetImportTransactionChecksum(
      content as Omit<DesignAssetImportTransaction, "checksum">,
    )) {
      throw new DesignStorageError("corrupt", "Design Asset import transaction checksum is invalid");
    }
    if ((transaction.idempotency === undefined) !== (transaction.canvasAfter === undefined)) {
      throw new DesignStorageError("corrupt", "Design Asset import transaction result authority is incomplete");
    }
    if (transaction.idempotency !== undefined && transaction.idempotency !== null) {
      const idempotency = storedRecord(transaction.idempotency, "Design Asset import idempotency", [
        "receiptId", "requestHash", "itemsHash",
      ]);
      if (!SHA256.test(String(idempotency.receiptId))
        || !SHA256.test(String(idempotency.requestHash))
        || !SHA256.test(String(idempotency.itemsHash))) {
        throw new DesignStorageError("corrupt", "Design Asset import idempotency authority is invalid");
      }
    }
    if (transaction.canvasAfter !== undefined) {
      assertStoredAssetImportCanvas(transaction.canvasAfter, expectedProjectId, transaction.nextRevision);
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
      const binding = storedRecord(value, "Design Asset import transaction binding", [
        "createdNode", "nodeId", "assetId", "previousHeadVersionId", "previousSelectedVersionId",
        "previousVersionCount", "previousAssetId", "selectedVersionIdAfter", "manifest",
      ]);
      if (typeof binding.nodeId !== "string" || !SAFE_SEGMENT.test(binding.nodeId) || nodeIds.has(binding.nodeId)
        || typeof binding.assetId !== "string" || !/^asset-[a-f0-9]{32}$/.test(binding.assetId)
        || typeof binding.createdNode !== "boolean"
        || !validStoredNullableId(binding.previousHeadVersionId)
        || !validStoredNullableId(binding.previousSelectedVersionId)
        || !Number.isSafeInteger(binding.previousVersionCount) || (binding.previousVersionCount as number) < 0
        || !validStoredNullableId(binding.previousAssetId)
        || !validStoredNullableId(binding.selectedVersionIdAfter)
        || !binding.manifest || typeof binding.manifest !== "object") {
        throw new DesignStorageError("corrupt", "Design Asset import transaction binding is invalid");
      }
      const manifest = binding.manifest as DesignVersionManifest;
      const versionId = (manifest as { id?: unknown }).id;
      if (typeof versionId !== "string") {
        throw new DesignStorageError("corrupt", "Design Asset import transaction Version is invalid");
      }
      assertStoredVersionManifest(manifest, binding.nodeId, versionId);
      if (manifest.contentKind !== "asset" || manifest.assetId !== binding.assetId
        || manifest.canvasRevision !== transaction.expectedRevision || manifest.publicationStatus !== "published"
        || manifest.expectedHeadVersionId !== binding.previousHeadVersionId
        || manifest.sequence !== (binding.previousVersionCount as number) + 1
        || (binding.selectedVersionIdAfter !== manifest.id
          && binding.selectedVersionIdAfter !== binding.previousSelectedVersionId)
        || (binding.createdNode && (
          binding.previousHeadVersionId !== null || binding.previousSelectedVersionId !== null
          || binding.previousVersionCount !== 0 || binding.previousAssetId !== null
          || binding.selectedVersionIdAfter !== manifest.id
        ))) {
        throw new DesignStorageError("corrupt", "Design Asset import transaction Version authority is invalid");
      }
      nodeIds.add(binding.nodeId);
    }
    const validatedBindings = transaction.bindings as DesignAssetImportTransactionBinding[];
    if ([...assetIds].some((assetId) => !validatedBindings.some((binding) => binding.assetId === assetId))) {
      throw new DesignStorageError("corrupt", "Design Asset import transaction contains an unbound Asset");
    }
    if (transaction.canvasAfter !== undefined) {
      const resultNodes = new Map(transaction.canvasAfter.nodes.map((node) => [node.id, node]));
      if (!validatedBindings.every((binding) =>
        assetImportBindingIsCommitted(resultNodes.get(binding.nodeId), binding))) {
        throw new DesignStorageError("corrupt", "Design Asset import result Canvas is inconsistent");
      }
    }
  }

  async function verifyMaterialVersionManifestDirectory(
    directory: string,
    expected: DesignVersionManifest,
  ): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0]?.isFile() || entries[0].name !== "manifest.json") {
      throw new DesignStorageError("corrupt", `Material Design Version ${expected.id} payload is invalid`);
    }
    const manifest = await readJson<DesignVersionManifest>(
      join(directory, "manifest.json"),
      `Material Design Version ${expected.id}`,
    );
    assertStoredVersionManifest(manifest, expected.nodeId, expected.id);
    if (JSON.stringify(manifest) !== JSON.stringify(expected)) {
      throw new DesignStorageError("corrupt", `Material Design Version ${expected.id} diverges from its WAL`);
    }
  }

  async function verifyCommittedAssetImportPayloadsUnlocked(
    root: string,
    transaction: DesignAssetImportTransaction,
  ): Promise<void> {
    for (const binding of transaction.bindings) {
      const asset = await getDesignAssetManifestUnlocked(root, binding.assetId);
      if (asset.checksum !== binding.manifest.checksum || asset.bytes !== binding.manifest.bytes) {
        throw new DesignStorageError("corrupt", "Committed Design Asset import Asset diverges from its Version");
      }
      await verifyMaterialVersionManifestDirectory(
        versionRoot(root, binding.nodeId, binding.manifest.id),
        binding.manifest,
      );
    }
  }

  async function readDesignAssetImportReceiptUnlocked(
    root: string,
    projectId: string,
    receiptId: string,
  ): Promise<DesignAssetImportTransaction | null> {
    const path = assetImportReceiptPath(root, receiptId);
    if (!(await exists(path))) return null;
    const transaction = await readJson<DesignAssetImportTransaction>(path, "Design Asset import receipt");
    assertAssetImportTransaction(transaction, projectId);
    if (transaction.idempotency?.receiptId !== receiptId || transaction.canvasAfter === undefined) {
      throw new DesignStorageError("corrupt", "Design Asset import receipt authority is invalid");
    }
    await verifyCommittedAssetImportPayloadsUnlocked(root, transaction);
    return transaction;
  }

  async function finalizeAssetImportTransactionUnlocked(
    root: string,
    transactionRoot: string,
    transaction: DesignAssetImportTransaction,
  ): Promise<void> {
    const transactionsRoot = resolve(transactionRoot, "..");
    const removeTransaction = async (): Promise<void> => {
      await rm(transactionRoot, { recursive: true, force: true });
      await syncDesignDirectory(transactionsRoot);
    };
    if (transaction.idempotency === undefined || transaction.idempotency === null) {
      await removeTransaction();
      return;
    }
    if (transaction.canvasAfter === undefined) {
      throw new DesignStorageError("corrupt", "Idempotent Design Asset import is missing its exact result");
    }
    const receiptPath = assetImportReceiptPath(root, transaction.idempotency.receiptId);
    const receiptsRoot = assetImportReceiptsRoot(root);
    await ensureDurableDirectory(receiptsRoot);
    if (await exists(receiptPath)) {
      const prior = await readJson<DesignAssetImportTransaction>(receiptPath, "Design Asset import receipt");
      assertAssetImportTransaction(prior, transaction.projectId);
      if (prior.checksum !== transaction.checksum) {
        throw new DesignStorageError("corrupt", "Design Asset import receipt diverges from its committed WAL");
      }
      await removeTransaction();
      return;
    }
    await rename(join(transactionRoot, "transaction.json"), receiptPath);
    await syncDesignDirectory(transactionRoot);
    await syncDesignDirectory(receiptsRoot);
    await removeTransaction();
  }

  function assetImportBindingIsCommitted(
    node: DesignNode | undefined,
    binding: DesignAssetImportTransactionBinding,
  ): boolean {
    return node !== undefined
      && node.currentVersionId === binding.manifest.id
      && node.selectedVersionId === binding.selectedVersionIdAfter
      && node.versionCount === binding.previousVersionCount + 1
      && node.assetId === binding.assetId;
  }

  function assetImportBindingIsBefore(
    node: DesignNode | undefined,
    binding: DesignAssetImportTransactionBinding,
  ): boolean {
    if (binding.createdNode) return node === undefined;
    return node !== undefined
      && node.currentVersionId === binding.previousHeadVersionId
      && node.selectedVersionId === binding.previousSelectedVersionId
      && node.versionCount === binding.previousVersionCount
      && node.assetId === binding.previousAssetId;
  }

  async function recoverPendingAssetImportsUnlocked(root: string): Promise<void> {
    const transactionsRoot = assetImportTransactionsRoot(root);
    if (!(await exists(transactionsRoot))) return;
    const entries = (await readdir(transactionsRoot, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (entries.length === 0) return;
    for (const entry of entries) {
      const transactionRoot = join(transactionsRoot, entry.name);
      if (!entry.isDirectory() || !SAFE_SEGMENT.test(entry.name)) {
        throw new DesignStorageError("corrupt", "Design Asset import staging contains an invalid entry");
      }
      const transactionPath = join(transactionRoot, "transaction.json");
      if (!(await exists(transactionPath))) {
        await rm(transactionRoot, { recursive: true, force: true });
        await syncDesignDirectory(transactionsRoot);
        continue;
      }
      const transaction = await readJson<DesignAssetImportTransaction>(transactionPath, "Design Asset import transaction");
      const projectId = basename(resolve(root, ".."));
      assertAssetImportTransaction(transaction, projectId);
      const project = await readProject(root);
      const nodes = readNodes(project);
      const committed = transaction.bindings.every((binding) =>
        assetImportBindingIsCommitted(nodes.get(binding.nodeId), binding));
      if (project.revision === transaction.nextRevision) {
        if (!committed) {
          throw new DesignStorageError("corrupt", "Committed Design Asset import has inconsistent Canvas authority");
        }
        await verifyCommittedAssetImportPayloadsUnlocked(root, transaction);
        await finalizeAssetImportTransactionUnlocked(root, transactionRoot, transaction);
        continue;
      } else if (project.revision === transaction.expectedRevision) {
        if (!transaction.bindings.every((binding) =>
          assetImportBindingIsBefore(nodes.get(binding.nodeId), binding))) {
          throw new DesignStorageError("corrupt", "Interrupted Design Asset import lost its prior Canvas authority");
        }
        for (const binding of transaction.bindings) {
          const target = versionRoot(root, binding.nodeId, binding.manifest.id);
          if (await exists(target)) {
            await verifyMaterialVersionManifestDirectory(target, binding.manifest);
            await rm(target, { recursive: true, force: true });
            await syncDesignDirectory(resolve(target, ".."));
          }
        }
        const referencedAssetIds = new Set(project.nodes.flatMap((node) => node.assetId ? [node.assetId] : []));
        for (const assetId of transaction.createdAssetIds) {
          if (referencedAssetIds.has(assetId)) {
            throw new DesignStorageError("corrupt", "Interrupted Design Asset import Asset became unexpectedly referenced");
          }
          const target = assetRoot(root, assetId);
          if (await exists(target)) {
            const asset = await getDesignAssetManifestUnlocked(root, assetId);
            const expected = transaction.bindings.find((binding) => binding.assetId === assetId)!.manifest;
            if (asset.checksum !== expected.checksum || asset.bytes !== expected.bytes) {
              throw new DesignStorageError("corrupt", "Interrupted Design Asset import Asset diverges from its WAL");
            }
            await rm(target, { recursive: true, force: true });
            await syncDesignDirectory(join(root, "assets"));
          }
        }
      } else {
        throw new DesignStorageError("corrupt", "Design Asset import WAL revision authority is invalid");
      }
      await rm(transactionRoot, { recursive: true, force: true });
      await syncDesignDirectory(transactionsRoot);
    }
  }

  async function storeDesignAsset(
    dataDir: string,
    projectId: string,
    input: DesignAssetStoreInput,
    now?: number,
    hooks?: DesignAssetPayloadReadTestHooks,
  ): Promise<DesignAssetManifest> {
    const root = designRoot(dataDir, projectId);
    const sourceVersionSnapshots = await snapshotDesignSourceVersions(dataDir, [input], undefined, hooks);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      await recoverPendingAssetImportsUnlocked(root);
      const prepared = await prepareDesignAsset(
        dataDir,
        projectId,
        root,
        input,
        now,
        sourceVersionSnapshots,
        hooks,
      );
      await persistPreparedDesignAsset(root, prepared);
      return prepared.manifest;
    });
  }

  function materialVersionManifest(
    projectId: string,
    node: DesignNode,
    asset: DesignAssetManifest,
    canvasRevision: number,
    timestamp: number,
  ): DesignVersionManifest {
    const id = `version-${randomUUID()}`;
    const expectedHeadVersionId = node.currentVersionId;
    return {
      schemaVersion: DESIGN_SCHEMA_VERSION,
      id,
      nodeId: node.id,
      contentKind: "asset",
      assetId: asset.id,
      sequence: node.versionCount + 1,
      checksum: asset.checksum,
      bytes: asset.bytes,
      contextHash: createHash("sha256").update(stableStringify({
        protocol: "dezin-material-version-v1",
        projectId,
        nodeId: node.id,
        assetId: asset.id,
        assetChecksum: asset.checksum,
        assetBytes: asset.bytes,
        canvasRevision,
        expectedHeadVersionId,
      })).digest("hex"),
      canvasRevision,
      expectedHeadVersionId,
      publicationStatus: "published",
      assetPins: [],
      jobId: null,
      runnerId: null,
      model: null,
      createdAt: timestamp,
    };
  }

  async function stageMaterialVersionManifest(
    directory: string,
    manifest: DesignVersionManifest,
  ): Promise<void> {
    await ensureDurableDirectory(directory);
    await writeAtomic(
      join(directory, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }

  function designAssetImportByteLimit(hooks?: DesignAssetImportTestHooks): number {
    const assetBatchByteLimit = hooks?.assetBatchByteLimit ?? MAX_DESIGN_ASSET_BATCH_BYTES;
    if (!Number.isSafeInteger(assetBatchByteLimit) || assetBatchByteLimit < 1
      || assetBatchByteLimit > MAX_DESIGN_ASSET_BATCH_BYTES) {
      throw new DesignStorageError("invalid-input", "Asset import test byte limit is invalid");
    }
    return assetBatchByteLimit;
  }

  async function importDesignCanvasAssetBatchUnlocked(
    dataDir: string,
    projectId: string,
    root: string,
    input: {
      expectedRevision: number;
      items: DesignCanvasAssetImport[];
      idempotency?: DesignAssetImportIdempotency;
    },
    now?: number,
    hooks?: DesignAssetImportTestHooks,
    sourceVersionSnapshots: ReadonlyMap<string, DesignSourceVersionSnapshot> = new Map(),
  ): Promise<DesignAssetImportOutcome> {
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
      const assetBatchByteLimit = designAssetImportByteLimit(hooks);
      const nodes = readNodes(project);
      const before = snapshot(project, nodes);
      const createdAssetIds = new Set<string>();
      const bindings: DesignAssetImportTransactionBinding[] = [];
      const imported: DesignAssetImportOutcome["bindings"] = [];
      const touchedNodeIds = new Set<string>();
      const transactionId = `import-${randomUUID()}`;
      const transactionRoot = join(assetImportTransactionsRoot(root), transactionId);
      let totalBytes = 0;
      let transaction: DesignAssetImportTransaction | null = null;
      let markerWritten = false;
      try {
        for (const item of input.items) {
          if (!item || typeof item !== "object" || Array.isArray(item)
            || Object.keys(item).some((key) => !["asset", "binding"].includes(key))) {
            throw new DesignStorageError("invalid-input", "Asset import item is invalid");
          }
          const prepared = await prepareDesignAsset(
            dataDir,
            projectId,
            root,
            item.asset,
            timestamp,
            sourceVersionSnapshots,
            hooks,
          );
          const preparedBytes = prepared.manifest.bytes
            + prepared.manifest.bundleFiles.reduce((sum, file) => sum + file.bytes, 0);
          if (!prepared.manifest.mimeType.startsWith("video/")) totalBytes += preparedBytes;
          if (totalBytes > assetBatchByteLimit) {
            await discardPreparedDesignAsset(prepared);
            throw new DesignStorageError("limit", "Asset import batch exceeds its bounded size");
          }
          if (!prepared.existing && !createdAssetIds.has(prepared.manifest.id)) {
            await stagePreparedDesignAsset(
              join(transactionRoot, "assets", prepared.manifest.id),
              prepared,
            );
            createdAssetIds.add(prepared.manifest.id);
          } else {
            await discardPreparedDesignAsset(prepared);
          }
          const binding = item.binding;
          if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
            throw new DesignStorageError("invalid-input", "Asset import binding is invalid");
          }
          let importedNode: DesignNode;
          let createdNode = false;
          if (binding.type === "create-node") {
            if (Object.keys(binding).some((key) => !["type", "node"].includes(key))) {
              throw new DesignStorageError("invalid-input", "Asset create-Node binding is invalid");
            }
            importedNode = await addNode(project, nodes, {
              type: "add-node",
              node: binding.node,
            }, timestamp);
            createdNode = true;
          } else if (binding.type === "append-version") {
            if (Object.keys(binding).some((key) => !["type", "nodeId"].includes(key))) {
              throw new DesignStorageError("invalid-input", "Asset append-Version binding is invalid");
            }
            const nodeId = safeSegment(binding.nodeId, "Node id");
            const existingNode = nodes.get(nodeId);
            if (!existingNode) throw new DesignStorageError("not-found", `Design Node ${nodeId} was not found`);
            importedNode = existingNode;
          } else {
            throw new DesignStorageError("invalid-input", "Asset import binding is unsupported");
          }
          if (touchedNodeIds.has(importedNode.id)) {
            throw new DesignStorageError("invalid-input", "Asset import batch may bind each material Node only once");
          }
          touchedNodeIds.add(importedNode.id);
          if ((DESIGN_GENERATIVE_NODE_KINDS as readonly string[]).includes(importedNode.kind)) {
            throw new DesignStorageError("invalid-input", "Only material Nodes may publish Asset Versions");
          }
          if (importedNode.activeJobId !== null) {
            throw new DesignStorageError("conflict", "Cancel the active scoped Agent Job before importing a material Version");
          }
          if (!matchesMaterialNodeKind(importedNode.kind, prepared.manifest.mimeType)) {
            throw new DesignStorageError(
              "invalid-input",
              `Asset ${prepared.manifest.id} mimeType does not match Node kind ${importedNode.kind}`,
            );
          }
          const previousHeadVersionId = importedNode.currentVersionId;
          const previousSelectedVersionId = importedNode.selectedVersionId;
          const previousVersionCount = importedNode.versionCount;
          const previousAssetId = importedNode.assetId;
          const followsHead = previousSelectedVersionId === null || previousSelectedVersionId === previousHeadVersionId;
          const manifest = materialVersionManifest(projectId, importedNode, prepared.manifest, project.revision, timestamp);
          const selectedVersionIdAfter = followsHead ? manifest.id : previousSelectedVersionId;
          await stageMaterialVersionManifest(
            join(transactionRoot, "versions", importedNode.id, manifest.id),
            manifest,
          );
          importedNode.currentVersionId = manifest.id;
          importedNode.selectedVersionId = selectedVersionIdAfter;
          importedNode.versionCount = previousVersionCount + 1;
          importedNode.assetId = prepared.manifest.id;
          importedNode.state = "ready";
          importedNode.error = null;
          importedNode.updatedAt = timestamp;
          bindings.push({
            createdNode,
            nodeId: importedNode.id,
            assetId: prepared.manifest.id,
            previousHeadVersionId,
            previousSelectedVersionId,
            previousVersionCount,
            previousAssetId,
            selectedVersionIdAfter,
            manifest,
          });
          imported.push({ node: importedNode, version: manifest, asset: prepared.manifest });
        }

        project.nodes = project.nodeOrder.map((id) => cloneNode(nodes.get(id)!));
        project.undo = [...project.undo, before].slice(-MAX_HISTORY);
        project.redo = [];
        project.revision += 1;
        project.updatedAt = Math.max(project.updatedAt, timestamp);
        const transactionContent: Omit<DesignAssetImportTransaction, "checksum"> = {
          schemaVersion: DESIGN_SCHEMA_VERSION,
          projectId,
          expectedRevision: input.expectedRevision,
          nextRevision: project.revision,
          createdAssetIds: [...createdAssetIds].sort(),
          bindings,
          idempotency: input.idempotency ?? null,
          canvasAfter: canvas(project, nodes),
        };
        transaction = {
          ...transactionContent,
          checksum: assetImportTransactionChecksum(transactionContent),
        };
        await writeAtomicJson(join(transactionRoot, "transaction.json"), transaction);
        markerWritten = true;
        await hooks?.afterDurablePhase?.("marker");
        await hooks?.afterPhase?.("marker");
        for (const assetId of createdAssetIds) {
          await rename(join(transactionRoot, "assets", assetId), assetRoot(root, assetId));
        }
        if (createdAssetIds.size > 0) {
          await syncDesignDirectory(join(transactionRoot, "assets"));
          await syncDesignDirectory(join(root, "assets"));
        }
        await hooks?.afterDurablePhase?.("assets");
        await hooks?.afterPhase?.("assets");
        for (const binding of bindings) {
          const targetParent = join(nodeRoot(root, binding.nodeId), "versions");
          const sourceParent = join(transactionRoot, "versions", binding.nodeId);
          await ensureDurableDirectory(targetParent);
          await rename(
            join(sourceParent, binding.manifest.id),
            versionRoot(root, binding.nodeId, binding.manifest.id),
          );
          await syncDesignDirectory(sourceParent);
          await syncDesignDirectory(targetParent);
        }
        await hooks?.afterDurablePhase?.("versions");
        await hooks?.afterPhase?.("versions");
        await writeAuthorityJson(root, projectFilePath(root), project, ["canvas"]);
        await hooks?.afterDurablePhase?.("canvas");
        await hooks?.afterPhase?.("canvas");
        await finalizeAssetImportTransactionUnlocked(root, transactionRoot, transaction);
        await hooks?.afterDurablePhase?.("receipt");
        await hooks?.afterPhase?.("receipt");
        const committedCanvas = canvas(project, nodes);
        return {
          canvas: committedCanvas,
          bindings: imported.map((entry) => ({ ...entry, node: cloneNode(nodes.get(entry.node.id)!) })),
        };
      } catch (error) {
        if (!markerWritten) {
          await rm(transactionRoot, { recursive: true, force: true });
          throw error;
        }
        if (hooks?.simulateProcessCrash) throw error;
        await recoverPendingAssetImportsUnlocked(root);
        const recoveredProject = await readProject(root);
        const recoveredNodes = readNodes(recoveredProject);
        if (transaction !== null && recoveredProject.revision === transaction.nextRevision
          && transaction.bindings.every((binding) =>
            assetImportBindingIsCommitted(recoveredNodes.get(binding.nodeId), binding))) {
          return {
            canvas: canvas(recoveredProject, recoveredNodes),
            bindings: imported.map((entry) => ({
              ...entry,
              node: cloneNode(recoveredNodes.get(entry.node.id)!),
            })),
          };
        }
        throw error;
      }
  }

  /**
   * Atomically ingest immutable Asset payloads and publish each material binding
   * as an immutable Node Version in one Canvas revision. The durable WAL owns the
   * Asset directories, Version manifests, and Canvas head transition together.
   */
  async function importDesignCanvasAssetBatch(
    dataDir: string,
    projectId: string,
    input: { expectedRevision: number; items: DesignCanvasAssetImport[] },
    now?: number,
    hooks?: DesignAssetImportTestHooks,
  ): Promise<DesignCanvas> {
    const root = designRoot(dataDir, projectId);
    const assetBatchByteLimit = designAssetImportByteLimit(hooks);
    const sourceVersionSnapshots = await snapshotDesignSourceVersions(
      dataDir,
      Array.isArray(input?.items) ? input.items.map((item) => item?.asset) : [],
      assetBatchByteLimit,
      hooks,
    );
    return withProjectLock(root, async () => (
      await importDesignCanvasAssetBatchUnlocked(
        dataDir,
        projectId,
        root,
        input,
        now,
        hooks,
        sourceVersionSnapshots,
      )
    ).canvas);
  }

  async function ensureDesignCanvasAssetBatch(
    dataDir: string,
    projectId: string,
    input: EnsureDesignCanvasAssetBatchInput,
    now?: number,
    hooks?: DesignAssetImportTestHooks,
  ): Promise<EnsuredDesignCanvasAssetBatch> {
    const root = designRoot(dataDir, projectId);
    if (typeof input?.idempotencyKey !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.idempotencyKey)
      || typeof input.requestHash !== "string" || !SHA256.test(input.requestHash)
      || !Array.isArray(input.items)) {
      throw new DesignStorageError("invalid-input", "Idempotent Asset import authority is invalid");
    }
    const receiptId = assetImportReceiptId(input.idempotencyKey);
    const itemsHash = createHash("sha256").update(stableStringify(input.items)).digest("hex");
    const replayReceiptUnlocked = async (): Promise<EnsuredDesignCanvasAssetBatch | null> => {
      await requireInitialized(root);
      await recoverPendingAssetImportsUnlocked(root);
      const prior = await readDesignAssetImportReceiptUnlocked(root, projectId, receiptId);
      if (prior === null) return null;
      if (prior.idempotency?.requestHash !== input.requestHash
        || prior.idempotency.itemsHash !== itemsHash) {
        throw new DesignStorageError(
          "conflict",
          "Asset import idempotencyKey is already bound to a different request",
        );
      }
      return { canvas: structuredClone(prior.canvasAfter!), reused: true };
    };

    const replay = await withProjectLock(root, replayReceiptUnlocked);
    if (replay !== null) return replay;

    const assetBatchByteLimit = designAssetImportByteLimit(hooks);
    let sourceVersionSnapshots: Map<string, DesignSourceVersionSnapshot>;
    try {
      sourceVersionSnapshots = await snapshotDesignSourceVersions(
        dataDir,
        input.items.map((item) => item?.asset),
        assetBatchByteLimit,
        hooks,
      );
    } catch (error) {
      const concurrentReplay = await withProjectLock(root, replayReceiptUnlocked);
      if (concurrentReplay !== null) return concurrentReplay;
      throw error;
    }

    return withProjectLock(root, async () => {
      const concurrentReplay = await replayReceiptUnlocked();
      if (concurrentReplay !== null) return concurrentReplay;
      if (await exists(assetImportReceiptsRoot(root))) {
        const entries = await readdir(assetImportReceiptsRoot(root), { withFileTypes: true });
        if (entries.some((entry) => !entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name))) {
          throw new DesignStorageError("corrupt", "Design Asset import receipt ledger contains an invalid entry");
        }
        if (entries.length >= 5_000) {
          throw new DesignStorageError("limit", "Design Asset import receipt limit reached");
        }
      }
      const project = await readProject(root);
      const outcome = await importDesignCanvasAssetBatchUnlocked(dataDir, projectId, root, {
        expectedRevision: project.revision,
        items: input.items,
        idempotency: { receiptId, requestHash: input.requestHash, itemsHash },
      }, now, hooks, sourceVersionSnapshots);
      return { canvas: outcome.canvas, reused: false };
    });
  }

  async function appendDesignMaterialVersion(
    dataDir: string,
    projectId: string,
    input: { expectedRevision: number; nodeId: string; asset: DesignAssetStoreInput },
    now?: number,
    hooks?: DesignAssetImportTestHooks,
  ): Promise<ImportedDesignMaterialVersion> {
    const root = designRoot(dataDir, projectId);
    const sourceVersionSnapshots = await snapshotDesignSourceVersions(
      dataDir,
      [input?.asset],
      designAssetImportByteLimit(hooks),
      hooks,
    );
    return withProjectLock(root, async () => {
      const outcome = await importDesignCanvasAssetBatchUnlocked(dataDir, projectId, root, {
        expectedRevision: input.expectedRevision,
        items: [{
          asset: input.asset,
          binding: { type: "append-version", nodeId: input.nodeId },
        }],
      }, now, hooks, sourceVersionSnapshots);
      const binding = outcome.bindings[0];
      if (!binding) throw new DesignStorageError("corrupt", "Material Version import produced no binding");
      return { canvas: outcome.canvas, ...binding };
    });
  }

  return {
    assertStoredAssetImportCanvas,
    assertAssetImportTransaction,
    verifyMaterialVersionManifestDirectory,
    verifyCommittedAssetImportPayloadsUnlocked,
    readDesignAssetImportReceiptUnlocked,
    finalizeAssetImportTransactionUnlocked,
    assetImportBindingIsCommitted,
    assetImportBindingIsBefore,
    recoverPendingAssetImportsUnlocked,
    storeDesignAsset,
    materialVersionManifest,
    stageMaterialVersionManifest,
    designAssetImportByteLimit,
    importDesignCanvasAssetBatchUnlocked,
    importDesignCanvasAssetBatch,
    ensureDesignCanvasAssetBatch,
    appendDesignMaterialVersion,
  };
}

export type DesignAssetImport = ReturnType<typeof createDesignAssetImport>;
