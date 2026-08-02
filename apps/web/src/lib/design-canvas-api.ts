import type { ApiClient, DesignCanvasAssetImportItem } from "./api.ts";
import type { PendingDesignCanvasContext } from "./pending-design-canvas.ts";
import type {
  DesignCanvasApi,
  DesignCanvasImportPosition,
  DesignCanvasMutationRequest,
} from "../design-canvas/api.ts";
import type {
  DesignCanvas,
  DesignCanvasIntent,
  DesignMaterialNodeKind,
} from "../design-canvas/types.ts";

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
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_LOCAL_ASSET_BYTES) {
      throw new Error(`${file.name || "A file"} must be between 1 byte and 32 MiB.`);
    }
    total += file.size;
  }
  if (total > MAX_LOCAL_ASSET_BATCH_BYTES) {
    throw new Error("The selected files exceed the 64 MiB import limit.");
  }
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

function importedNodeIntent(
  assetId: string,
  name: string,
  mimeType: string,
  position: DesignCanvasImportPosition,
  index = 0,
  id?: string,
): Extract<DesignCanvasIntent, { type: "add-node" }> {
  const kind = fileKind(mimeType);
  const width = kind === "video" ? 440 : kind === "image" ? 360 : 320;
  const height = kind === "video" ? 280 : kind === "image" ? 260 : 190;
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

function pendingProjectVersionNodeId(
  context: Extract<PendingDesignCanvasContext, { kind: "project-version" }>,
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
      if (!item.node.id) return true;
      const node = existing.get(item.node.id);
      if (!node) return true;
      if (node.kind !== item.node.kind) {
        throw new Error(`Imported context identity ${item.node.id} is already used by another Node.`);
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
      const items = await Promise.all(files.map(async (file, index): Promise<DesignCanvasAssetImportItem> => {
        const mimeType = file.type || "application/octet-stream";
        const node = importedNodeIntent("pending-asset", file.name, mimeType, position, index).node;
        const { assetId: _assetId, ...materialNode } = node;
        return {
          asset: { name: file.name, mimeType, base64: await fileBase64(file) },
          node: { ...materialNode, id: importNodeId() },
        };
      }));
      return importBatchAgainstLatest(api, projectId, items);
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
        node: {
          id: pendingProjectVersionNodeId(context, position),
          kind: "document",
          name: context.title,
          geometry: { x: position.x, y: position.y, width: 320, height: 190 },
        },
      }]);
    },

    listNodeVersions: (projectId, nodeId, signal) => api.listDesignNodeVersions(projectId, nodeId, signal),
    getExactVersionPreview: async (projectId, nodeId, versionId) => ({
      nodeId,
      versionId,
      url: api.designNodeVersionPreviewUrl(projectId, nodeId, versionId),
    }),
    getAssetPreviewUrl: (projectId, assetId) => api.designCanvasAssetUrl(projectId, assetId),

    getThread: (projectId, scope, signal) => api.getDesignThread(projectId, scope, signal),
    submitAgentTurn: (projectId, scope, request) => api.submitDesignAgentTurn(projectId, scope, {
      message: request.prompt,
      context: request.context,
      ...(request.agentCommand ? { agentCommand: request.agentCommand } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
    }),
    listJobs: (projectId, signal) => api.listDesignJobs(projectId, signal),
    cancelJob: (projectId, jobId) => api.cancelDesignJob(projectId, jobId),
    startImplementationExport: (projectId, canvasRevision) =>
      api.startDesignImplementationExport(projectId, { canvasRevision }),
  };
}
