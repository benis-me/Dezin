import type { PendingDesignCanvasContext } from "../lib/pending-design-canvas.ts";
import type {
  DesignAgentContext,
  DesignAgentSelection,
  DesignAgentTurnResult,
  DesignCanvas,
  DesignCanvasIntent,
  DesignExportResult,
  DesignJob,
  DesignNodeVersion,
  DesignThread,
  DesignThreadScope,
  ExactVersionPreview,
} from "./types.ts";

export interface DesignCanvasMutationRequest {
  baseRevision: number;
  intents: readonly DesignCanvasIntent[];
}

export interface DesignCanvasImportPosition {
  x: number;
  y: number;
}

export interface DesignAgentTurnRequest extends DesignAgentSelection {
  prompt: string;
  context: DesignAgentContext;
  idempotencyKey?: string;
}

/**
 * Deliberately separate from the shared ApiClient. App integration owns the
 * authenticated adapter; the canvas never performs raw fetches or repeats auth.
 */
export interface DesignCanvasApi {
  getCanvas(projectId: string, signal?: AbortSignal): Promise<DesignCanvas>;
  applyIntents(projectId: string, request: DesignCanvasMutationRequest): Promise<DesignCanvas>;
  undo(projectId: string, baseRevision: number): Promise<DesignCanvas>;
  redo(projectId: string, baseRevision: number): Promise<DesignCanvas>;

  importLocalFiles(
    projectId: string,
    files: readonly File[],
    position: DesignCanvasImportPosition,
  ): Promise<DesignCanvas>;
  importProjectVersion(
    projectId: string,
    context: Extract<PendingDesignCanvasContext, { kind: "project-version" }>,
    position: DesignCanvasImportPosition,
  ): Promise<DesignCanvas>;

  listNodeVersions(projectId: string, nodeId: string, signal?: AbortSignal): Promise<DesignNodeVersion[]>;
  getExactVersionPreview(
    projectId: string,
    nodeId: string,
    versionId: string,
    signal?: AbortSignal,
  ): Promise<ExactVersionPreview>;
  getAssetPreviewUrl(projectId: string, assetId: string): string;

  getThread(projectId: string, scope: DesignThreadScope, signal?: AbortSignal): Promise<DesignThread>;
  submitAgentTurn(
    projectId: string,
    scope: DesignThreadScope,
    request: DesignAgentTurnRequest,
  ): Promise<DesignAgentTurnResult>;
  listJobs(projectId: string, signal?: AbortSignal): Promise<DesignJob[]>;
  cancelJob(projectId: string, jobId: string): Promise<DesignJob>;
  startImplementationExport(projectId: string, canvasRevision: number): Promise<DesignExportResult>;
}
