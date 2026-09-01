import { createHash } from "node:crypto";
import {
  DESIGN_NODE_KINDS,
  DESIGN_SCHEMA_VERSION,
  type DesignAssetManifest,
  type DesignFrozenAssetPin,
  type DesignFrozenContext,
  type DesignNode,
  type DesignProjectFile,
  type DesignVersionManifest,
} from "./design-types.ts";
import {
  DesignStorageError,
  MAX_ASSET_BUNDLE_FILES,
  MAX_DESIGN_CONTEXT_BYTES,
  MAX_DESIGN_CONTEXT_PAYLOADS,
  SAFE_SEGMENT,
  SHA256,
  safeBundlePath,
  safeSegment,
  storedRecord,
  validStoredNullableId,
  validStoredText,
  validStoredViewport,
} from "./design-storage-primitives.ts";

export interface DesignFrozenContextSources {
  readNodes(project: DesignProjectFile): Map<string, DesignNode>;
  getVersionUnlocked(root: string, nodeId: string, versionId: string): Promise<DesignVersionManifest>;
  getAsset(dataDir: string, projectId: string, assetId: string): Promise<DesignAssetManifest>;
}

export async function buildFrozenContextUnlocked(
  root: string,
  dataDir: string,
  projectId: string,
  project: DesignProjectFile,
  targetNodeId: string | null,
  sources: DesignFrozenContextSources,
): Promise<DesignFrozenContext> {
  if (targetNodeId !== null && !project.nodeOrder.includes(safeSegment(targetNodeId, "Node id"))) {
    throw new DesignStorageError("not-found", `Design Node ${targetNodeId} was not found`);
  }
  const nodes = sources.readNodes(project);
  const summaries: DesignFrozenContext["nodes"] = [];
  for (const id of project.nodeOrder) {
    const node = nodes.get(id)!;
    const selectedVersionId = node.selectedVersionId ?? node.currentVersionId;
    const selectedVersion = selectedVersionId === null
      ? null
      : await sources.getVersionUnlocked(root, node.id, selectedVersionId);
    const asset = node.assetId === null ? null : await sources.getAsset(dataDir, projectId, node.assetId);
    const selectedVersionAssetPins: DesignFrozenAssetPin[] = [];
    let selectedVersionPath: string | null = null;
    if (selectedVersion?.contentKind === "html") {
      selectedVersionPath = `nodes/${node.id}/versions/${selectedVersion.id}/index.html`;
    } else if (selectedVersion?.contentKind === "asset") {
      if (selectedVersion.assetId === null) {
        throw new DesignStorageError("corrupt", `Material Design Version ${selectedVersion.id} has no Asset`);
      }
      const selectedAsset = await sources.getAsset(dataDir, projectId, selectedVersion.assetId);
      if (selectedAsset.checksum !== selectedVersion.checksum || selectedAsset.bytes !== selectedVersion.bytes) {
        throw new DesignStorageError("corrupt", `Material Design Version ${selectedVersion.id} Asset diverged from its manifest`);
      }
      const selectedPin = frozenAssetPin(selectedAsset);
      selectedVersionAssetPins.push(selectedPin);
      selectedVersionPath = selectedPin.path;
    }
    for (const pin of selectedVersion?.assetPins ?? []) {
      const pinnedAsset = await sources.getAsset(dataDir, projectId, pin.assetId);
      if (pinnedAsset.checksum !== pin.checksum) {
        throw new DesignStorageError("corrupt", `Design Version ${selectedVersion?.id} Asset pin diverged from its manifest`);
      }
      selectedVersionAssetPins.push(frozenAssetPin(pinnedAsset));
    }
    summaries.push({
      id: node.id,
      kind: node.kind,
      name: node.name,
      state: node.state,
      geometry: { ...node.geometry },
      selectedVersionId,
      selectedVersionContentKind: selectedVersion?.contentKind ?? null,
      selectedVersionChecksum: selectedVersion?.checksum ?? null,
      selectedVersionBytes: selectedVersion?.bytes ?? null,
      selectedVersionPath,
      selectedVersionJobId: selectedVersion?.jobId ?? null,
      selectedVersionRunnerId: selectedVersion?.runnerId ?? null,
      selectedVersionModel: selectedVersion?.model ?? null,
      selectedVersionAssetPins,
      assetId: asset?.id ?? null,
      assetChecksum: asset?.checksum ?? null,
      assetBytes: asset?.bytes ?? null,
      assetPath: asset === null ? null : `.context/assets/${asset.id}/${asset.fileName}`,
      assetBundleFiles: asset === null ? [] : frozenAssetPin(asset).bundleFiles,
    });
  }
  const content = {
    schemaVersion: DESIGN_SCHEMA_VERSION,
    projectId,
    canvasRevision: project.revision,
    targetNodeId,
    viewport: { ...project.viewport },
    nodes: summaries,
  };
  assertDesignFrozenContextBudget(content);
  const checksum = createHash("sha256").update(JSON.stringify(content)).digest("hex");
  return { ...content, checksum };
}

function frozenAssetPin(manifest: DesignAssetManifest): DesignFrozenAssetPin {
  const root = `.context/assets/${manifest.id}`;
  return {
    assetId: manifest.id,
    checksum: manifest.checksum,
    bytes: manifest.bytes,
    fileName: manifest.fileName,
    path: `${root}/${manifest.fileName}`,
    bundleFiles: manifest.bundleFiles.map((file) => ({
      ...file,
      path: `${root}/${file.path}`,
    })),
  };
}

export function assertDesignFrozenContextBudget(
  context: Omit<DesignFrozenContext, "checksum"> | DesignFrozenContext,
  limits: { maxPayloads?: number; maxBytes?: number } = {},
): void {
  const maxPayloads = limits.maxPayloads ?? MAX_DESIGN_CONTEXT_PAYLOADS;
  const maxBytes = limits.maxBytes ?? MAX_DESIGN_CONTEXT_BYTES;
  let payloads = 0;
  let bytes = 0;
  const identities = new Set<string>();
  const addPayload = (identity: string, size: unknown, label: string): void => {
    if (!Number.isSafeInteger(size) || (size as number) < 1) {
      throw new DesignStorageError("corrupt", `Frozen Design context contains an invalid ${label} size`);
    }
    if (!identities.has(identity)) {
      identities.add(identity);
      payloads += 1;
      bytes += size as number;
    }
    if (!Number.isSafeInteger(bytes) || payloads > maxPayloads || bytes > maxBytes) {
      throw new DesignStorageError(
        "limit",
        `Frozen Design context exceeds the bounded payload budget (${maxPayloads} files / ${maxBytes} bytes)`,
      );
    }
  };
  for (const node of context.nodes) {
    if (node.selectedVersionBytes !== null) {
      const identity = `version:${node.id}:${node.selectedVersionId}:${node.selectedVersionChecksum}`;
      addPayload(identity, node.selectedVersionBytes, "Version");
    }
    if (!Array.isArray(node.selectedVersionAssetPins) || node.selectedVersionAssetPins.length > MAX_ASSET_BUNDLE_FILES) {
      throw new DesignStorageError("corrupt", "Frozen Design context contains invalid Version Asset pins");
    }
    for (const pin of node.selectedVersionAssetPins) {
      if (!/^asset-[a-f0-9]{32}$/.test(pin.assetId) || !SHA256.test(pin.checksum)
        || typeof pin.fileName !== "string" || pin.path !== `.context/assets/${pin.assetId}/${pin.fileName}`) {
        throw new DesignStorageError("corrupt", "Frozen Design context contains an invalid Version Asset pin");
      }
      addPayload(`asset:${pin.assetId}:${pin.checksum}`, pin.bytes, "Version Asset");
      for (const file of pin.bundleFiles) {
        if (!SHA256.test(file.checksum) || !file.path.startsWith(`.context/assets/${pin.assetId}/`)) {
          throw new DesignStorageError("corrupt", "Frozen Design context contains an invalid Version Asset bundle");
        }
        addPayload(`asset-bundle:${pin.assetId}:${file.path}:${file.checksum}`, file.bytes, "Version Asset bundle");
      }
    }
    if (node.assetBytes !== null) {
      const identity = `asset:${node.assetId}:${node.assetChecksum}`;
      addPayload(identity, node.assetBytes, "Asset");
      if (!Array.isArray(node.assetBundleFiles) || node.assetBundleFiles.length > MAX_ASSET_BUNDLE_FILES) {
        throw new DesignStorageError("corrupt", "Frozen Design context contains an invalid Asset bundle");
      }
      for (const file of node.assetBundleFiles) {
        if (!SHA256.test(file.checksum) || !file.path.startsWith(`.context/assets/${node.assetId}/`)) {
          throw new DesignStorageError("corrupt", "Frozen Design context contains an invalid Asset bundle file");
        }
        addPayload(`asset-bundle:${node.assetId}:${file.path}:${file.checksum}`, file.bytes, "Asset bundle");
      }
    } else if (node.assetBundleFiles.length !== 0) {
      throw new DesignStorageError("corrupt", "Frozen Design context contains an unowned Asset bundle");
    }
  }
}

export function assertStoredFrozenContext(value: unknown, expectedProjectId: string): asserts value is DesignFrozenContext {
  const context = storedRecord(value, "Frozen Design context", [
    "schemaVersion", "projectId", "canvasRevision", "targetNodeId", "checksum", "viewport", "nodes",
  ]);
  const viewportRecord = storedRecord(context.viewport, "Frozen Design context viewport", ["x", "y", "zoom"]);
  if (context.schemaVersion !== DESIGN_SCHEMA_VERSION || context.projectId !== expectedProjectId
    || !Number.isSafeInteger(context.canvasRevision) || (context.canvasRevision as number) < 0
    || !validStoredNullableId(context.targetNodeId) || !SHA256.test(String(context.checksum))
    || !validStoredViewport(viewportRecord)
    || !Array.isArray(context.nodes) || context.nodes.length > 500) {
    throw new DesignStorageError("corrupt", "Frozen Design context is invalid");
  }
  const nodeIds = new Set<string>();
  for (const [nodeIndex, entry] of context.nodes.entries()) {
    const node = storedRecord(entry, `Frozen Design context Node ${nodeIndex}`, [
      "id", "kind", "name", "state", "geometry", "selectedVersionId", "selectedVersionContentKind",
      "selectedVersionChecksum", "selectedVersionBytes", "selectedVersionPath", "selectedVersionJobId", "selectedVersionRunnerId",
      "selectedVersionModel", "selectedVersionAssetPins", "assetId", "assetChecksum", "assetBytes", "assetPath",
      "assetBundleFiles",
    ]);
    const geometryRecord = storedRecord(node.geometry, `Frozen Design context Node ${nodeIndex} geometry`, ["x", "y", "width", "height"]);
    const validGeometry = [geometryRecord.x, geometryRecord.y, geometryRecord.width, geometryRecord.height]
      .every((part) => typeof part === "number" && Number.isFinite(part))
      && (geometryRecord.width as number) >= 120
      && (geometryRecord.height as number) >= 80;
    const selectedAbsent = node.selectedVersionId === null && node.selectedVersionContentKind === null
      && node.selectedVersionChecksum === null && node.selectedVersionBytes === null && node.selectedVersionPath === null
      && node.selectedVersionJobId === null && node.selectedVersionRunnerId === null
      && node.selectedVersionModel === null;
    const selectedContentKind = node.selectedVersionContentKind;
    const selectedPathValid = selectedContentKind === "html"
      ? node.selectedVersionPath === `nodes/${String(node.id)}/versions/${String(node.selectedVersionId)}/index.html`
      : selectedContentKind === "asset"
        ? typeof node.selectedVersionPath === "string" && /^\.context\/assets\/asset-[a-f0-9]{32}\/[A-Za-z0-9._-]+$/.test(node.selectedVersionPath)
        : false;
    const selectedPresent = typeof node.selectedVersionId === "string" && SAFE_SEGMENT.test(node.selectedVersionId)
      && (selectedContentKind === "html" || selectedContentKind === "asset")
      && typeof node.selectedVersionChecksum === "string" && SHA256.test(node.selectedVersionChecksum)
      && Number.isSafeInteger(node.selectedVersionBytes) && (node.selectedVersionBytes as number) >= 1
      && selectedPathValid
      && validStoredNullableId(node.selectedVersionJobId)
      && validStoredText(node.selectedVersionRunnerId, 512, { nullable: true })
      && (typeof node.selectedVersionRunnerId !== "string"
        || node.selectedVersionRunnerId.trim() === node.selectedVersionRunnerId)
      && validStoredText(node.selectedVersionModel, 512, { nullable: true })
      && (typeof node.selectedVersionModel !== "string" || node.selectedVersionModel.trim() === node.selectedVersionModel)
      && !(node.selectedVersionJobId !== null && node.selectedVersionRunnerId === null)
      && !(node.selectedVersionRunnerId === null && node.selectedVersionModel !== null);
    const assetAbsent = node.assetId === null && node.assetChecksum === null
      && node.assetBytes === null && node.assetPath === null;
    const assetPresent = typeof node.assetId === "string" && /^asset-[a-f0-9]{32}$/.test(node.assetId)
      && typeof node.assetChecksum === "string" && SHA256.test(node.assetChecksum)
      && Number.isSafeInteger(node.assetBytes) && (node.assetBytes as number) >= 1
      && typeof node.assetPath === "string" && node.assetPath.startsWith(`.context/assets/${node.assetId}/`);
    if (typeof node.id !== "string" || !SAFE_SEGMENT.test(node.id) || nodeIds.has(node.id)
      || typeof node.kind !== "string" || !(DESIGN_NODE_KINDS as readonly string[]).includes(node.kind)
      || !validStoredText(node.name, 256)
      || typeof node.state !== "string" || !["empty", "queued", "generating", "validating", "ready", "failed", "cancelled", "superseded"].includes(node.state)
      || !validGeometry || (!selectedAbsent && !selectedPresent) || (!assetAbsent && !assetPresent)
      || !Array.isArray(node.selectedVersionAssetPins) || node.selectedVersionAssetPins.length > MAX_ASSET_BUNDLE_FILES
      || !Array.isArray(node.assetBundleFiles) || node.assetBundleFiles.length > MAX_ASSET_BUNDLE_FILES) {
      throw new DesignStorageError("corrupt", `Frozen Design context Node ${nodeIndex} is invalid`);
    }
    nodeIds.add(node.id);
    const validateFrozenAsset = (pinValue: unknown, label: string): void => {
      const pin = storedRecord(pinValue, label, ["assetId", "checksum", "bytes", "fileName", "path", "bundleFiles"]);
      const prefix = `.context/assets/${String(pin.assetId)}/`;
      if (typeof pin.assetId !== "string" || !/^asset-[a-f0-9]{32}$/.test(pin.assetId)
        || !SHA256.test(String(pin.checksum)) || !Number.isSafeInteger(pin.bytes) || (pin.bytes as number) < 1
        || typeof pin.fileName !== "string" || !SAFE_SEGMENT.test(pin.fileName)
        || pin.path !== `${prefix}${pin.fileName}` || !Array.isArray(pin.bundleFiles)
        || pin.bundleFiles.length > MAX_ASSET_BUNDLE_FILES) {
        throw new DesignStorageError("corrupt", `${label} is invalid`);
      }
      const bundlePaths = new Set<string>();
      for (const [bundleIndex, bundleValue] of pin.bundleFiles.entries()) {
        const bundle = storedRecord(bundleValue, `${label} bundle ${bundleIndex}`, ["path", "checksum", "bytes"]);
        if (typeof bundle.path !== "string" || !bundle.path.startsWith(prefix)
          || bundlePaths.has(bundle.path) || !SHA256.test(String(bundle.checksum))
          || !Number.isSafeInteger(bundle.bytes) || (bundle.bytes as number) < 1) {
          throw new DesignStorageError("corrupt", `${label} bundle ${bundleIndex} is invalid`);
        }
        safeBundlePath(bundle.path.slice(prefix.length), `${label} bundle ${bundleIndex} path`);
        bundlePaths.add(bundle.path);
      }
    };
    const selectedPinIds = new Set<string>();
    for (const [pinIndex, pin] of node.selectedVersionAssetPins.entries()) {
      validateFrozenAsset(pin, `Frozen Design context Node ${nodeIndex} Version pin ${pinIndex}`);
      const assetId = (pin as { assetId: string }).assetId;
      if (selectedPinIds.has(assetId)) throw new DesignStorageError("corrupt", "Frozen Design context repeats a Version Asset pin");
      selectedPinIds.add(assetId);
    }
    if (!selectedPresent && node.selectedVersionAssetPins.length !== 0) {
      throw new DesignStorageError("corrupt", "Frozen Design context has Version Asset pins without a Version");
    }
    if (selectedPresent && node.selectedVersionContentKind === "asset") {
      const primaryAsset = (node.selectedVersionAssetPins as DesignFrozenAssetPin[]).find((pin) => (
        pin.path === node.selectedVersionPath
        && pin.checksum === node.selectedVersionChecksum
        && pin.bytes === node.selectedVersionBytes
      ));
      if (!primaryAsset) {
        throw new DesignStorageError("corrupt", "Frozen material Version has no checksum-bound primary Asset");
      }
    }
    if (assetPresent) {
      validateFrozenAsset({
        assetId: node.assetId,
        checksum: node.assetChecksum,
        bytes: node.assetBytes,
        fileName: String(node.assetPath).slice(String(node.assetPath).lastIndexOf("/") + 1),
        path: `.context/assets/${node.assetId}/${String(node.assetPath).slice(String(node.assetPath).lastIndexOf("/") + 1)}`,
        bundleFiles: node.assetBundleFiles,
      }, `Frozen Design context Node ${nodeIndex} Asset`);
    } else if (node.assetBundleFiles.length !== 0) {
      throw new DesignStorageError("corrupt", "Frozen Design context has an unowned Asset bundle");
    }
  }
  if (context.targetNodeId !== null && !nodeIds.has(context.targetNodeId as string)) {
    throw new DesignStorageError("corrupt", "Frozen Design context target Node is unavailable");
  }
  assertDesignFrozenContextBudget(value as DesignFrozenContext);
}
