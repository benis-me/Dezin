export {
  DESIGN_GENERATIVE_NODE_KINDS,
  DESIGN_MATERIAL_NODE_KINDS,
  DESIGN_NODE_KINDS,
  DESIGN_PROJECT_BOOTSTRAP_SCHEMA_VERSION,
  FIGMA_IMPORT_SCHEMA_VERSION,
} from "@dezin/design-canvas-contracts";

export type {
  DesignAgentContext,
  DesignAgentSelection,
  DesignAgentTurnResult,
  DesignAsset,
  DesignCanvas,
  DesignConnection,
  DesignCanvasAssetImportItem,
  DesignCanvasAssetImportSource,
  DesignCanvasIntent,
  DesignExportResult,
  DesignGenerativeNodeKind,
  DesignInvalidationEvent,
  DesignInvalidationMessage,
  DesignInvalidationReset,
  DesignInvalidationTopic,
  DesignJob,
  DesignJobActivity,
  DesignJobKind,
  DesignJobRetryResult,
  DesignJobStatus,
  DesignMaterialNodeKind,
  DesignNodeGeometry,
  DesignNodeKind,
  DesignNode,
  DesignNodeState,
  DesignNodeVersion,
  DesignProjectBootstrapInput,
  DesignProjectBootstrapJob,
  DesignProjectBootstrapPhase,
  DesignProjectBootstrapResult,
  DesignThread,
  DesignThreadMessage,
  DesignThreadRole,
  DesignThreadScope,
  DesignMainSession,
  DesignMainSessionList,
  DesignViewport,
  FigmaCredentialPutInput,
  FigmaCredentialStatus,
  FigmaCanvasImportResponse,
  FigmaImportAnchor,
  FigmaImportInput,
  FigmaImportResult,
  NewDesignNode,
} from "@dezin/design-canvas-contracts";

export interface ExactVersionPreview {
  nodeId: string;
  versionId: string;
  url: string;
  expiresAt?: number;
}
