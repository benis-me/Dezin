import type {
  DesignAgentContext,
  DesignAgentSelection,
  DesignAgentTurnResult,
  DesignCanvas,
  DesignCanvasIntent,
  DesignExportResult,
  DesignInvalidationMessage,
  DesignJob,
  DesignJobRetryResult,
  DesignMainSessionList,
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

export interface DesignProjectVersionReference {
  kind: "project-version";
  title: string;
  sourceProjectId: string;
  sourceNodeId: string;
  sourceVersionId: string;
}

export interface DesignAgentTurnRequest extends DesignAgentSelection {
  prompt: string;
  context: DesignAgentContext;
  idempotencyKey?: string;
}

export type DesignAgentCommand = string;

export function isDesignAgentCommand(value: string | undefined): value is DesignAgentCommand {
  return typeof value === "string" && value.trim().length > 0;
}

/** Export carries the exact selected Design Agent authority instead of
 * inheriting an unrelated global provider implicitly. */
export interface DesignImplementationExportSelection {
  agentCommand: DesignAgentCommand;
  model: string | null;
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
  appendMaterialVersion(projectId: string, nodeId: string, file: File): Promise<DesignCanvas>;
  importProjectVersion(
    projectId: string,
    context: DesignProjectVersionReference,
    position: DesignCanvasImportPosition,
  ): Promise<DesignCanvas>;

  listNodeVersions(projectId: string, nodeId: string, signal?: AbortSignal): Promise<DesignNodeVersion[]>;
  getExactVersionPreview(
    projectId: string,
    nodeId: string,
    versionId: string,
    signal?: AbortSignal,
  ): Promise<ExactVersionPreview>;
  downloadExactVersionHtml(projectId: string, nodeId: string, versionId: string): Promise<Blob>;
  /** Built directory as a ZIP; adapters without it fall back to the single HTML file. */
  downloadExactVersionExport?(projectId: string, nodeId: string, versionId: string): Promise<Blob>;

  getThread(projectId: string, scope: DesignThreadScope, signal?: AbortSignal): Promise<DesignThread>;
  streamInvalidations(
    projectId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<DesignInvalidationMessage>;
  submitAgentTurn(
    projectId: string,
    scope: DesignThreadScope,
    request: DesignAgentTurnRequest,
  ): Promise<DesignAgentTurnResult>;
  /** Main Agent sessions; optional so adapters without session support hide the switcher. */
  listMainSessions?(projectId: string, signal?: AbortSignal): Promise<DesignMainSessionList>;
  createMainSession?(projectId: string): Promise<DesignMainSessionList>;
  activateMainSession?(projectId: string, sessionId: string): Promise<DesignMainSessionList>;
  renameMainSession?(projectId: string, sessionId: string, title: string | null): Promise<DesignMainSessionList>;
  deleteMainSession?(projectId: string, sessionId: string): Promise<DesignMainSessionList>;
  listJobs(projectId: string, signal?: AbortSignal): Promise<DesignJob[]>;
  cancelJob(projectId: string, jobId: string): Promise<DesignJob>;
  retryJob(projectId: string, jobId: string): Promise<DesignJobRetryResult>;
  startImplementationExport(
    projectId: string,
    canvasRevision: number,
    selection: DesignImplementationExportSelection,
  ): Promise<DesignExportResult>;
}
