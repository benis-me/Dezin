import {
  ContextIntegrityError,
  assertIdentifier,
  checksumBytes,
  stableStringify,
  type ResourceContextAdapter,
  type ResourceRevisionSnapshot,
} from "../context-types.ts";
import { resolveSnapshot, snapshotBytes } from "./file.ts";

const MAX_MOODBOARD_ASSETS = 1_024;
const MAX_MOODBOARD_NODES = 100_000;
const MAX_MOODBOARD_MESSAGES = 100_000;
const MAX_MOODBOARD_RAW_ASSET_BYTES = 6 * 1024 * 1024;
const MAX_MOODBOARD_CONTEXT_BYTES = 512 * 1024;

function binaryCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContextIntegrityError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, maxCodePoints: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const codePoints = Array.from(value);
  return codePoints.length <= maxCodePoints ? value : `${codePoints.slice(0, maxCodePoints).join("")}…`;
}

function selectedFields(
  value: unknown,
  fields: readonly string[],
  maxTextCodePoints = 512,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const selected: Record<string, unknown> = {};
  for (const field of fields) {
    const item = record[field];
    if (typeof item === "string") selected[field] = boundedText(item, maxTextCodePoints);
    else if (item === null || typeof item === "number" || typeof item === "boolean") selected[field] = item;
    else if (Array.isArray(item)) {
      selected[field] = item.slice(0, 64).map((entry) => typeof entry === "string"
        ? boundedText(entry, maxTextCodePoints)
        : entry);
    }
  }
  return selected;
}

function moodboardContextBody(payload: Buffer, revision: ResourceRevisionSnapshot): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch {
    throw new ContextIntegrityError("Moodboard Resource bundle is not valid UTF-8 JSON");
  }
  const bundle = plainRecord(parsed, "Moodboard Resource bundle");
  if (bundle.format !== "dezin-moodboard-resource-bundle"
    || (bundle.version !== 1 && bundle.version !== 2)
    || !Array.isArray(bundle.nodes) || !Array.isArray(bundle.messages) || !Array.isArray(bundle.assets)) {
    throw new ContextIntegrityError("Moodboard Resource bundle format is invalid");
  }
  const assets = bundle.assets.map((value, index) => {
    const asset = plainRecord(value, `Moodboard Resource Asset ${index}`);
    if (typeof asset.bytesBase64 !== "string") {
      throw new ContextIntegrityError(`Moodboard Resource Asset ${index} has no immutable byte representation`);
    }
    return Object.fromEntries(Object.entries(asset).filter(([field]) => field !== "bytesBase64"));
  });
  const promptBundle = {
    ...bundle,
    assets,
    assetBytes: "exact bytes are retained in the immutable payload and intentionally omitted from prompt text",
    immutablePayload: {
      manifestPath: revision.manifestPath,
      payloadChecksum: revision.payloadChecksum,
      byteLength: revision.byteSize,
      mimeType: revision.mimeType,
    },
  };
  const full = stableStringify(promptBundle);
  if (Buffer.byteLength(full, "utf8") <= MAX_MOODBOARD_CONTEXT_BYTES) return full;

  const nodeTypeCounts: Record<string, number> = {};
  for (const value of bundle.nodes) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const type = (value as Record<string, unknown>).type;
    if (typeof type === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(type)) {
      nodeTypeCounts[type] = (nodeTypeCounts[type] ?? 0) + 1;
    }
  }
  const summary = stableStringify({
    format: bundle.format,
    version: bundle.version,
    board: selectedFields(bundle.board, ["id", "name", "coverAssetId", "createdAt", "updatedAt"], 1_024),
    nodeCount: bundle.nodes.length,
    nodeTypeCounts,
    recentMessages: bundle.messages.slice(-32).map((message) => selectedFields(
      message,
      ["id", "role", "content", "createdAt"],
      2_048,
    )),
    assets: assets.slice(0, MAX_MOODBOARD_ASSETS).map((asset) => ({
      ...selectedFields(asset, ["id", "byteLength", "checksum"], 512),
      metadata: selectedFields(
        asset.metadata,
        ["fileName", "mimeType", "kind", "source", "width", "height"],
        512,
      ),
    })),
    omittedFromPrompt: {
      nodeDetails: bundle.nodes.length,
      olderMessages: Math.max(0, bundle.messages.length - 32),
      assetBytes: assets.length,
    },
    immutablePayload: {
      manifestPath: revision.manifestPath,
      payloadChecksum: revision.payloadChecksum,
      byteLength: revision.byteSize,
      mimeType: revision.mimeType,
    },
  });
  if (Buffer.byteLength(summary, "utf8") > MAX_MOODBOARD_CONTEXT_BYTES) {
    return stableStringify({
      format: bundle.format,
      version: bundle.version,
      board: selectedFields(bundle.board, ["id", "name", "coverAssetId"], 1_024),
      nodeCount: bundle.nodes.length,
      messageCount: bundle.messages.length,
      assetCount: assets.length,
      note: "Use the immutable Resource payload for full board, message, node, and Asset detail.",
      immutablePayload: {
        manifestPath: revision.manifestPath,
        payloadChecksum: revision.payloadChecksum,
        byteLength: revision.byteSize,
        mimeType: revision.mimeType,
      },
    });
  }
  return summary;
}

export const moodboardResourceAdapter: ResourceContextAdapter = {
  kind: "moodboard",
  async snapshot(input) {
    if (input.kind !== "moodboard" || input.source.type !== "moodboard-bundle") {
      throw new ContextIntegrityError("Moodboard Resource adapter requires a complete owned moodboard bundle");
    }
    if (!input.source.board || typeof input.source.board !== "object" || Array.isArray(input.source.board)
      || !Array.isArray(input.source.nodes) || input.source.nodes.length > MAX_MOODBOARD_NODES
      || !Array.isArray(input.source.messages) || input.source.messages.length > MAX_MOODBOARD_MESSAGES
      || !Array.isArray(input.source.assets) || input.source.assets.length > MAX_MOODBOARD_ASSETS) {
      throw new ContextIntegrityError("Moodboard Resource bundle is invalid or unbounded");
    }
    const ids = new Set<string>();
    let rawAssetBytes = 0;
    const assets = [...input.source.assets]
      .sort((left, right) => binaryCompare(left.id, right.id))
      .map((asset) => {
        if (!asset.id || ids.has(asset.id)) {
          throw new ContextIntegrityError("Moodboard Resource bundle contains a missing or duplicate Asset identity");
        }
        assertIdentifier(asset.id, "Moodboard Asset ID");
        if (!(asset.bytes instanceof Uint8Array)) {
          throw new ContextIntegrityError(`Moodboard Asset ${asset.id} is missing its exact owned bytes`);
        }
        if (!asset.metadata || typeof asset.metadata !== "object" || Array.isArray(asset.metadata)) {
          throw new ContextIntegrityError(`Moodboard Asset ${asset.id} metadata is invalid`);
        }
        rawAssetBytes += asset.bytes.byteLength;
        if (rawAssetBytes > MAX_MOODBOARD_RAW_ASSET_BYTES) {
          throw new ContextIntegrityError("Moodboard Resource Asset bytes exceed the bundle limit");
        }
        ids.add(asset.id);
        return {
          id: asset.id,
          metadata: structuredClone(asset.metadata),
          byteLength: asset.bytes.byteLength,
          checksum: checksumBytes(asset.bytes),
          bytesBase64: Buffer.from(asset.bytes).toString("base64"),
        };
      });
    const bundle = {
      format: "dezin-moodboard-resource-bundle",
      version: 1,
      board: structuredClone(input.source.board),
      nodes: structuredClone(input.source.nodes),
      messages: structuredClone(input.source.messages),
      assets,
    };
    const bytes = Buffer.from(`${stableStringify(bundle)}\n`, "utf8");
    return snapshotBytes(
      {
        ...input,
        provenance: {
          ...structuredClone(input.provenance),
          bundleFormat: bundle.format,
          bundleVersion: bundle.version,
          assetCount: assets.length,
          assetChecksums: assets.map((asset) => ({ id: asset.id, checksum: asset.checksum })),
        },
      },
      bytes,
      "application/json",
    );
  },
  resolve(input) {
    return resolveSnapshot(input, "moodboard", moodboardContextBody);
  },
};
