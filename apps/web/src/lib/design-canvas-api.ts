import type { ApiClient, DesignCanvasAssetImportItem } from "./api.ts";
import type {
  DesignCanvasApi,
  DesignCanvasImportPosition,
  DesignCanvasMutationRequest,
  DesignProjectVersionReference,
} from "../design-canvas/api.ts";
import type {
  DesignCanvas,
  DesignCanvasIntent,
  DesignMaterialNodeKind,
} from "../design-canvas/types.ts";
import { fittedImageNodeSize } from "./design-canvas-geometry.ts";

const IMPORT_RETRIES = 3;
const MAX_LOCAL_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_LOCAL_ASSET_BATCH_BYTES = 64 * 1024 * 1024;
const MAX_LOCAL_ASSET_BATCH_ITEMS = 32;

function assertLocalFileBatch(files: readonly File[]): void {
  if (files.length < 1 || files.length > MAX_LOCAL_ASSET_BATCH_ITEMS) {
    throw new Error(`Choose between 1 and ${MAX_LOCAL_ASSET_BATCH_ITEMS} files.`);
  }
  let total = 0;
  for (const file of files) {
    const video = inferredMimeType(file).startsWith("video/");
    if (!Number.isSafeInteger(file.size) || file.size < 1 || (!video && file.size > MAX_LOCAL_ASSET_BYTES)) {
      throw new Error(`${file.name || "A file"} must be between 1 byte and 32 MiB.`);
    }
    if (!video) total += file.size;
  }
  if (total > MAX_LOCAL_ASSET_BATCH_BYTES) {
    throw new Error("The selected files exceed the 64 MiB import limit.");
  }
}

function inferredMimeType(file: File): string {
  if (file.type.trim()) return file.type.trim().toLowerCase();
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  const known: Record<string, string> = {
    avif: "image/avif",
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    svg: "image/svg+xml",
    webp: "image/webp",
    mp4: "video/mp4",
    webm: "video/webm",
    pdf: "application/pdf",
    md: "text/markdown",
    txt: "text/plain",
  };
  return known[extension] ?? "application/octet-stream";
}

function fileKind(mimeType: string): DesignMaterialNodeKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (
    mimeType === "application/pdf"
    || mimeType.startsWith("text/")
    || mimeType.includes("document")
    || mimeType.includes("presentation")
    || mimeType.includes("sheet")
  ) return "document";
  return "file";
}

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const separator = value.indexOf(",");
      if (separator < 0) reject(new Error(`Could not encode ${file.name}`));
      else resolve(value.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

async function localFileAsset(
  api: ApiClient,
  projectId: string,
  file: File,
  mimeType: string,
): Promise<DesignCanvasAssetImportItem["asset"]> {
  if (!mimeType.startsWith("video/")) {
    return { name: file.name, mimeType, base64: await fileBase64(file) };
  }
  const { uploadedFileId } = await api.uploadDesignCanvasVideo(projectId, file);
  return { name: file.name, mimeType, uploadedFileId };
}

interface ImportedMediaSize {
  width: number;
  height: number;
}

async function importedMediaSize(file: File, kind: DesignMaterialNodeKind): Promise<ImportedMediaSize | null> {
  if (kind !== "image" || typeof globalThis.createImageBitmap !== "function") return null;
  try {
    const bitmap = await globalThis.createImageBitmap(file);
    const size = fittedImageNodeSize({ width: bitmap.width, height: bitmap.height });
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}

function importedNodeIntent(
  assetId: string,
  name: string,
  mimeType: string,
  position: DesignCanvasImportPosition,
  index = 0,
  id?: string,
  mediaSize?: ImportedMediaSize | null,
): Extract<DesignCanvasIntent, { type: "add-node" }> {
  const kind = fileKind(mimeType);
  const width = mediaSize?.width ?? (kind === "video" ? 440 : kind === "image" ? 360 : 320);
  const height = mediaSize?.height ?? (kind === "video" ? 280 : kind === "image" ? 260 : 190);
  return {
    type: "add-node",
    node: {
      ...(id ? { id } : {}),
      kind,
      name,
      assetId,
      geometry: {
        x: position.x + index * 28,
        y: position.y + index * 28,
        width,
        height,
      },
    },
  };
}

function stableImportIdentity(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function projectVersionNodeId(
  context: DesignProjectVersionReference,
  position: DesignCanvasImportPosition,
): string {
  return `node-context-version-${stableImportIdentity([
    context.sourceProjectId,
    context.sourceNodeId,
    context.sourceVersionId,
    Math.round(position.x),
    Math.round(position.y),
  ].join("\0"))}`;
}

function importNodeId(): string {
  const suffix = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `node-${suffix}`;
}

async function importBatchAgainstLatest(
  api: ApiClient,
  projectId: string,
  items: readonly DesignCanvasAssetImportItem[],
): Promise<DesignCanvas> {
  let lastError: unknown;
  for (let attempt = 0; attempt < IMPORT_RETRIES; attempt += 1) {
    const canvas = await api.getDesignCanvas(projectId);
    const existing = new Map(canvas.nodes.map((node) => [node.id, node]));
    const remaining = items.filter((item) => {
      if (item.binding.type === "append-version") return true;
      const imported = item.binding.node;
      if (!imported.id) return true;
      const node = existing.get(imported.id);
      if (!node) return true;
      if (node.kind !== imported.kind) {
        throw new Error(`Imported context identity ${imported.id} is already used by another Node.`);
      }
      return false;
    });
    if (remaining.length === 0) return canvas;
    try {
      return await api.importDesignCanvasAssets(projectId, {
        expectedRevision: canvas.revision,
        items: remaining,
      });
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error) || !("status" in error) || error.status !== 409) throw error;
    }
  }
  throw lastError ?? new Error("The canvas changed while importing context.");
}

export function createDesignCanvasApi(api: ApiClient): DesignCanvasApi {
  return {
    getCanvas: (projectId, signal) => api.getDesignCanvas(projectId, signal),
    applyIntents: (projectId, request: DesignCanvasMutationRequest) =>
      api.mutateDesignCanvas(projectId, {
        expectedRevision: request.baseRevision,
        intents: request.intents,
      }),
    undo: (projectId, baseRevision) => api.undoDesignCanvas(projectId, baseRevision),
    redo: (projectId, baseRevision) => api.redoDesignCanvas(projectId, baseRevision),

    importLocalFiles: async (projectId, files, position) => {
      assertLocalFileBatch(files);
      const items: DesignCanvasAssetImportItem[] = [];
      for (const [index, file] of files.entries()) {
        const mimeType = inferredMimeType(file);
        const kind = fileKind(mimeType);
        const mediaSize = await importedMediaSize(file, kind);
        const node = importedNodeIntent("pending-asset", file.name, mimeType, position, index, undefined, mediaSize).node;
        const { assetId: _assetId, ...materialNode } = node;
        const asset = await localFileAsset(api, projectId, file, mimeType);
        items.push({
          asset,
          binding: {
            type: "create-node",
            node: { ...materialNode, id: importNodeId() },
          },
        });
      }
      return importBatchAgainstLatest(api, projectId, items);
    },
    appendMaterialVersion: async (projectId, nodeId, file) => {
      assertLocalFileBatch([file]);
      const mimeType = inferredMimeType(file);
      const asset = await localFileAsset(api, projectId, file, mimeType);
      return importBatchAgainstLatest(api, projectId, [{
        asset,
        binding: { type: "append-version", nodeId },
      }]);
    },
    importProjectVersion: async (projectId, context, position) => {
      return importBatchAgainstLatest(api, projectId, [{
        asset: {
          name: `${context.title}.html`,
          mimeType: "text/html",
          sourceVersion: {
            projectId: context.sourceProjectId,
            nodeId: context.sourceNodeId,
            versionId: context.sourceVersionId,
          },
        },
        binding: {
          type: "create-node",
          node: {
            id: projectVersionNodeId(context, position),
            kind: "document",
            name: context.title,
            geometry: { x: position.x, y: position.y, width: 320, height: 190 },
          },
        },
      }]);
    },

    listNodeVersions: (projectId, nodeId, signal) => api.listDesignNodeVersions(projectId, nodeId, signal),
    getExactVersionPreview: async (projectId, nodeId, versionId) => ({
      nodeId,
      versionId,
      url: api.designNodeVersionPreviewUrl(projectId, nodeId, versionId),
    }),
    downloadExactVersionHtml: (projectId, nodeId, versionId) =>
      api.downloadDesignNodeVersionHtml(projectId, nodeId, versionId),
    getThread: (projectId, scope, signal) => api.getDesignThread(projectId, scope, signal),
    streamInvalidations: (projectId, signal) => api.streamDesignCanvasInvalidations(projectId, signal),
    submitAgentTurn: (projectId, scope, request) => api.submitDesignAgentTurn(projectId, scope, {
      message: request.prompt,
      context: request.context,
      ...(request.agentCommand ? { agentCommand: request.agentCommand } : {}),
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
    }),
    listMainSessions: (projectId, signal) => api.listDesignMainSessions(projectId, signal),
    createMainSession: (projectId) => api.createDesignMainSession(projectId),
    activateMainSession: (projectId, sessionId) => api.activateDesignMainSession(projectId, sessionId),
    renameMainSession: (projectId, sessionId, title) => api.renameDesignMainSession(projectId, sessionId, title),
    deleteMainSession: (projectId, sessionId) => api.deleteDesignMainSession(projectId, sessionId),
    listJobs: (projectId, signal) => api.listDesignJobs(projectId, signal),
    cancelJob: (projectId, jobId) => api.cancelDesignJob(projectId, jobId),
    retryJob: (projectId, jobId) => api.retryDesignJob(projectId, jobId),
    startImplementationExport: (projectId, canvasRevision, selection) =>
      api.startDesignImplementationExport(projectId, { canvasRevision, ...selection }),
  };
}
