/**
 * Pure primitives of Asset/Version publication: input validation, byte
 * signature checks, and the on-disk layout of import receipts, transactions,
 * and Version directories. Nothing here holds state or touches the Canvas.
 */
import { createHash } from "node:crypto";
import { basename, extname, join } from "node:path";
import { stableStringify } from "../canonical-json.ts";
import {
  DesignStorageError,
  MAX_DESIGN_ASSET_BYTES,
  SHA256,
  nodeRoot,
  publicationTransactionsRoot,
  safeSegment,
} from "./design-storage-primitives.ts";
import type {
  DESIGN_SCHEMA_VERSION,
  DesignAssetManifest,
  DesignCanvas,
  DesignNode,
  DesignNodeKind,
  DesignVersionManifest,
  DesignVersionPublicationTransaction,
} from "./design-types.ts";

export function displayAssetName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)
    || Buffer.byteLength(value, "utf8") > 240) {
    throw new DesignStorageError("invalid-input", "Asset name is invalid");
  }
  return value.trim();
}

export function mimeType(value: unknown): string {
  if (typeof value !== "string" || value.length > 120
    || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(value)) {
    throw new DesignStorageError("invalid-input", "Asset mimeType is invalid");
  }
  return value.toLowerCase();
}

export function extensionFor(name: string, type: string): string {
  const candidate = extname(basename(name)).toLowerCase();
  if (/^\.[a-z0-9]{1,12}$/.test(candidate)) return candidate;
  const known: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "text/markdown": ".md",
  };
  return known[type] ?? ".bin";
}

export function strictBase64(value: unknown): Buffer {
  if (typeof value !== "string" || value.length === 0
    || value.length > Math.ceil(MAX_DESIGN_ASSET_BYTES / 3) * 4 + 4
    || value.length % 4 !== 0) {
    throw new DesignStorageError("invalid-input", "Asset base64 is invalid");
  }
  // Do not validate a multi-megabyte payload with a repeated-group RegExp.
  // V8's RegExp engine recursively backtracks that shape and overflows the
  // JavaScript stack for otherwise valid local images around 4 MiB or larger.
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const valid = (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 43
      || code === 47;
    if (!valid) throw new DesignStorageError("invalid-input", "Asset base64 is invalid");
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) {
      throw new DesignStorageError("invalid-input", "Asset base64 is invalid");
    }
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 1 || bytes.length > MAX_DESIGN_ASSET_BYTES || bytes.toString("base64") !== value) {
    throw new DesignStorageError("invalid-input", "Asset base64 is invalid or exceeds the size limit");
  }
  return bytes;
}

export function validateAssetSignature(bytes: Buffer, type: string): void {
  const matches = (() => {
    switch (type) {
      case "image/png":
        return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      case "image/jpeg":
        return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      case "image/gif":
        return bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a";
      case "image/webp":
        return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF"
          && bytes.subarray(8, 12).toString("ascii") === "WEBP";
      case "application/pdf":
        return bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-";
      default:
        return true;
    }
  })();
  if (!matches) throw new DesignStorageError("invalid-input", `Asset bytes do not match declared mimeType ${type}`);
}

export function matchesMaterialNodeKind(kind: DesignNodeKind, type: string): boolean {
  if (kind === "file") return true;
  if (kind === "image") return type.startsWith("image/");
  if (kind === "video") return type.startsWith("video/");
  if (kind !== "document") return false;
  return type === "application/pdf" || type === "application/rtf" || type === "text/rtf"
    || type.startsWith("text/") || type.includes("document") || type.includes("presentation")
    || type.includes("sheet") || type.includes("wordprocessingml")
    || type.includes("presentationml") || type.includes("spreadsheetml");
}

export function uploadedRefName(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith(".refs/")) {
    throw new DesignStorageError("invalid-input", "uploadedFileId must be exactly .refs/<safe basename>");
  }
  const name = value.slice(".refs/".length);
  if (!name || name !== basename(name) || name.length > 80 || !/^[A-Za-z0-9._-]+$/.test(name)
    || value !== `.refs/${name}`) {
    throw new DesignStorageError("invalid-input", "uploadedFileId must be exactly .refs/<safe basename>");
  }
  return name;
}

export interface DesignAssetImportTransactionBinding {
  createdNode: boolean;
  nodeId: string;
  assetId: string;
  previousHeadVersionId: string | null;
  previousSelectedVersionId: string | null;
  previousVersionCount: number;
  previousAssetId: string | null;
  selectedVersionIdAfter: string | null;
  manifest: DesignVersionManifest;
}

export interface DesignAssetImportIdempotency {
  receiptId: string;
  requestHash: string;
  itemsHash: string;
}

export interface DesignAssetImportTransaction {
  schemaVersion: typeof DESIGN_SCHEMA_VERSION;
  projectId: string;
  expectedRevision: number;
  nextRevision: number;
  createdAssetIds: string[];
  bindings: DesignAssetImportTransactionBinding[];
  /** Added by the idempotent batch authority; absent only in legacy in-flight WAL. */
  idempotency?: DesignAssetImportIdempotency | null;
  /** Exact compact committed result; absent only in legacy in-flight WAL. */
  canvasAfter?: DesignCanvas;
  checksum: string;
}

export interface DesignAssetImportOutcome {
  canvas: DesignCanvas;
  bindings: Array<{
    node: DesignNode;
    version: DesignVersionManifest;
    asset: DesignAssetManifest;
  }>;
}

export function assetImportTransactionsRoot(root: string): string {
  return join(root, "assets", ".transactions");
}

export function assetImportReceiptsRoot(root: string): string {
  return join(root, "assets", ".import-receipts");
}

export function assetImportReceiptId(idempotencyKey: string): string {
  return createHash("sha256")
    .update(`dezin-design-asset-import-receipt-v1\0${idempotencyKey}`)
    .digest("hex");
}

export function assetImportReceiptPath(root: string, receiptId: string): string {
  if (!SHA256.test(receiptId)) {
    throw new DesignStorageError("corrupt", "Design Asset import receipt identity is invalid");
  }
  return join(assetImportReceiptsRoot(root), `${receiptId}.json`);
}

export function assetImportTransactionChecksum(
  value: Omit<DesignAssetImportTransaction, "checksum">,
): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function versionRoot(root: string, nodeId: string, versionId: string): string {
  return join(nodeRoot(root, nodeId), "versions", safeSegment(versionId, "Version id"));
}

export function publicationTransactionPath(root: string, jobId: string): string {
  return join(publicationTransactionsRoot(root), `${safeSegment(jobId, "Job id")}.json`);
}

export function pendingVersionRoot(root: string, nodeId: string, versionId: string): string {
  return join(nodeRoot(root, nodeId), ".pending", "versions", safeSegment(versionId, "Version id"));
}

export function publicationTransactionChecksum(
  content: Omit<DesignVersionPublicationTransaction, "checksum">,
): string {
  return createHash("sha256").update(stableStringify(content), "utf8").digest("hex");
}
