import type { DesignFrozenContext } from "./design-types.ts";
import {
  validateDesignExportCss,
  validateDesignExportJavaScript,
  validateDesignHtml,
} from "./design-static-validation.ts";
export {
  validateDesignExportCss,
  validateDesignExportJavaScript,
  validateDesignHtml,
};
import { createDesignCanvasState } from "./design-canvas-state.ts";
import {
  createDesignAssetVersionPublication,
  type DesignAssetVersionPublication,
} from "./design-asset-version-publication.ts";
import {
  createDesignJobThreadLedger,
  type DesignJobThreadLedger,
} from "./design-job-thread-ledger.ts";
export type {
  CreatedDesignJob,
  CreateDesignJobInput,
  DesignJobCreationPhase,
  DesignJobCreationTestHooks,
  DesignJobReceiptLookup,
  DesignJobTerminalReceiptPolicy,
  DesignMainPlanExecution,
  DesignThreadTurnReservation,
} from "./design-job-thread-ledger.ts";
export type {
  DesignAssetImportPhase,
  DesignAssetImportTestHooks,
  DesignAssetStoreInput,
  DesignCanvasAssetImport,
  EnsureDesignCanvasAssetBatchInput,
  EnsuredDesignCanvasAssetBatch,
  DesignVersionPublicationTestHooks,
  ImportedDesignMaterialVersion,
  PortableDesignVersionHtmlTestHooks,
  ResolvedDesignVersionPreview,
} from "./design-asset-version-publication.ts";
import {
  assertDesignFrozenContextBudget,
  buildFrozenContextUnlocked,
} from "./design-frozen-context.ts";
import {
  designRoot,
  DesignRevisionConflictError,
  registerDesignProjectTransactionRecovery,
  withProjectLock,
} from "./design-storage-primitives.ts";
export {
  assertDesignFrozenContextBudget,
};
export {
  designExportDirectory,
  designExportStagingDirectory,
  designNodeJobStagingDirectory,
  DesignRevisionConflictError,
  DesignStorageError,
  MAX_DESIGN_ASSET_BATCH_BYTES,
  MAX_DESIGN_ASSET_BATCH_ITEMS,
  MAX_DESIGN_ASSET_BYTES,
  MAX_DESIGN_CONTEXT_BYTES,
  MAX_DESIGN_CONTEXT_PAYLOADS,
  MAX_DESIGN_HTML_BYTES,
} from "./design-storage-primitives.ts";

let publicationState!: DesignAssetVersionPublication;
let ledgerState!: DesignJobThreadLedger;

const canvasState = createDesignCanvasState({
  recoverPendingAssetImportsUnlocked: (...args) => publicationState.recoverPendingAssetImportsUnlocked(...args),
  getVersionUnlocked: (...args) => publicationState.getDesignVersionUnlocked(...args),
  readJob: (...args) => ledgerState.readJob(...args),
  readMainPlanExecutionUnlocked: (...args) => ledgerState.readDesignMainPlanExecutionUnlocked(...args),
});

const {
  readNodes,
  readProject,
  requireInitialized,
} = canvasState;

export const initializeDesignProject = canvasState.initializeDesignProject;
export const assertDesignCanvasTarget = canvasState.assertDesignCanvasTarget;
export const getDesignCanvas = canvasState.getDesignCanvas;
export const mutateDesignCanvas = canvasState.mutateDesignCanvas;
export const undoDesignCanvas = canvasState.undoDesignCanvas;
export const redoDesignCanvas = canvasState.redoDesignCanvas;

publicationState = createDesignAssetVersionPublication({
  canvasState,
  readJob: (...args) => ledgerState.readJob(...args),
});

const {
  getDesignVersionUnlocked,
} = publicationState;

export const storeDesignAsset = publicationState.storeDesignAsset;
export const ensureDesignCanvasAssetBatch = publicationState.ensureDesignCanvasAssetBatch;
export const importDesignCanvasAssetBatch = publicationState.importDesignCanvasAssetBatch;
export const appendDesignMaterialVersion = publicationState.appendDesignMaterialVersion;
export const getDesignAssetManifest = publicationState.getDesignAssetManifest;
export const listDesignAssets = publicationState.listDesignAssets;
export const resolveDesignAssetFile = publicationState.resolveDesignAssetFile;
export const resolveDesignAssetBundleFile = publicationState.resolveDesignAssetBundleFile;
export const recoverDesignVersionPublication = publicationState.recoverDesignVersionPublication;
export const listDesignVersions = publicationState.listDesignVersions;
export const getDesignVersion = publicationState.getDesignVersion;
export const publishDesignVersion = publicationState.publishDesignVersion;
export const resolveDesignVersionFile = publicationState.resolveDesignVersionFile;
export const resolveDesignVersionPreview = publicationState.resolveDesignVersionPreview;
export const buildPortableDesignVersionHtml = publicationState.buildPortableDesignVersionHtml;
export const resolvePinnedDesignAssetFile = publicationState.resolvePinnedDesignAssetFile;

ledgerState = createDesignJobThreadLedger({
  canvasState,
  publicationState,
});
registerDesignProjectTransactionRecovery((root) => ledgerState.recoverPendingJobCreationsUnlocked(root));

export const DESIGN_MAIN_AGENT_QUEUED_MESSAGE = ledgerState.DESIGN_MAIN_AGENT_QUEUED_MESSAGE;
export const getDesignThread = ledgerState.getDesignThread;
export const appendDesignThreadMessage = ledgerState.appendDesignThreadMessage;
export const updateDesignThreadMessage = ledgerState.updateDesignThreadMessage;
export const getDesignMainPlanExecution = ledgerState.getDesignMainPlanExecution;
export const reserveDesignMainPlanExecution = ledgerState.reserveDesignMainPlanExecution;
export const createDesignJob = ledgerState.createDesignJob;
export const getDesignJobContext = ledgerState.getDesignJobContext;
export const getDesignJob = ledgerState.getDesignJob;
export const getDesignJobByIdempotencyKey = ledgerState.getDesignJobByIdempotencyKey;
export const getDesignJobByReceiptKey = ledgerState.getDesignJobByReceiptKey;
export const listDesignJobs = ledgerState.listDesignJobs;
export const recoverInterruptedDesignJobs = ledgerState.recoverInterruptedDesignJobs;
export const updateDesignJob = ledgerState.updateDesignJob;
export const appendDesignJobActivity = ledgerState.appendDesignJobActivity;
export const updateDesignJobToolActivity = ledgerState.updateDesignJobToolActivity;
export const cancelDesignJob = ledgerState.cancelDesignJob;
export const requestDesignJobCancellation = ledgerState.requestDesignJobCancellation;

const frozenContextSources = {
  readNodes,
  getVersionUnlocked: getDesignVersionUnlocked,
  getAsset: getDesignAssetManifest,
};

export async function freezeDesignContext(
  dataDir: string,
  projectId: string,
  input: { targetNodeId?: string | null; expectedRevision?: number },
): Promise<DesignFrozenContext> {
  const root = designRoot(dataDir, projectId);
  return withProjectLock(root, async () => {
    await requireInitialized(root);
    const project = await readProject(root);
    if (input.expectedRevision !== undefined && input.expectedRevision !== project.revision) {
      throw new DesignRevisionConflictError(input.expectedRevision, project.revision);
    }
    return buildFrozenContextUnlocked(
      root,
      dataDir,
      projectId,
      project,
      input.targetNodeId ?? null,
      frozenContextSources,
    );
  });
}
