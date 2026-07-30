import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ExoticComponent } from "react";

import { type AgentComposerContextItem } from "../components/AgentComposerContext.tsx";
import {
  ProjectRenameDialog,
  useProjectHeaderActions,
} from "../components/ProjectHeaderActions.tsx";
import { useToast } from "../components/Toast.tsx";
import { Button } from "../components/ui/index.ts";
import { persistAgentModelDefaultsStrict } from "../lib/agent-model-defaults.ts";
import {
  designSystemPickerValue,
  persistedDesignSystemId,
} from "../lib/design-system-selection.ts";
import { SETTINGS_UPDATED_EVENT } from "../lib/settings-events.ts";
import {
  agentAvailabilityReason,
  normalizeAgentModel,
  selectableAgents,
} from "../lib/agent-availability.ts";
import { useAgents } from "../lib/agents-context.tsx";
import { useApi } from "../lib/api-context.tsx";
import { buildProjectAnalysisPrompt } from "../lib/project-analysis-prompt.ts";
import {
  peekPendingDesignWorkspaceTurn,
  type PendingDesignWorkspaceRecoveryContextItem,
  type PendingDesignWorkspaceTurn,
} from "../lib/pending-brief.ts";
import type {
  ApiClient,
  ArtifactRevision,
  DesignSystemCard,
  GenerationPlanDetail,
  GenerationTask,
  Resource,
  ResourceRevision,
  ResourceRevisionOwnedSource,
  Settings,
  WorkspaceResourceKind,
} from "../lib/api.ts";
import { navigate } from "../router.tsx";
import { ArtifactEditorSurface, useArtifactEditorController } from "./artifact/ArtifactEditorSurface.tsx";
import { ArtifactInspector } from "./artifact/ArtifactInspector.tsx";
import {
  generationPlanActivityStatus,
  GenerationPlanInspector,
  terminalGenerationPlan,
  type GenerationPlanDetailChange,
  type GenerationPlanTargetLabels,
} from "./generation/GenerationPlanPanel.tsx";
import {
  buildGenerationTargetStates,
  generationPlanResultKey,
} from "./generation/generation-target-state.ts";
import {
  createPrototypeFlowSession,
  presentablePrototypeFlowPages,
  type PrototypeFlowSession,
} from "./flow/prototype-flow.ts";
import { PrototypeFlowViewer } from "./flow/PrototypeFlowViewer.tsx";
import { ProjectStudioShell } from "./ProjectStudioShell.tsx";
import { ProposalReviewPanel } from "./proposal/ProposalReviewPanel.tsx";
import { ResearchResourceViewer } from "./research/ResearchResourceViewer.tsx";
import {
  ResourceEditorSurface,
  ResourceInspector,
  useResourceEditorController,
} from "./resource/ResourceEditorSurface.tsx";
import { useProjectStudio } from "./useProjectStudio.ts";
import {
  acknowledgePendingDesignWorkspaceTurn,
  claimPendingTurnReplacement,
} from "./pending-turn-supersession.ts";
import type { AgentTranscriptEntry } from "./scoped-agent-session.ts";
import {
  WorkspaceAgentPanel,
  type AgentTraceOutput,
  type AgentTraceStatus,
  type ProjectedAgentTranscriptEntry,
} from "./WorkspaceAgentPanel.tsx";

const ProjectCanvas = lazy(() => import("./canvas/ProjectCanvas.tsx").then((module) => ({ default: module.ProjectCanvas })));

interface LegacyWorkspaceProps {
  projectId: string;
  onOpenSettings: (section?: string) => void;
}

type LegacyWorkspaceComponent = ComponentType<LegacyWorkspaceProps> | ExoticComponent<LegacyWorkspaceProps>;
type DaemonContextCard = Extract<AgentComposerContextItem, { type: "context-ref" }>;
type CanvasResourceRevisionState = {
  revisionId: string;
  resourceKind: WorkspaceResourceKind;
  qualityState: "grounded" | "needs-review" | null;
};
type CanvasArtifactRevisionQualityState = {
  revisionId: string;
  qualityState: "passed" | "needs-attention" | "failed" | "unassessed";
  qualityScore: number | null;
};

interface ArtifactCandidateRouteIdentity {
  planId: string;
  taskId: string;
  attempt: number;
}

const EMPTY_CANVAS_RESOURCE_REVISION_STATES: Readonly<Record<string, CanvasResourceRevisionState>> = {};
const EMPTY_CANVAS_ARTIFACT_REVISION_QUALITY_STATES: Readonly<Record<string, CanvasArtifactRevisionQualityState>> = {};
const SETTINGS_LOAD_ERROR_AFTER_FAILURES = 5;
const SETTINGS_LOAD_ERROR_MESSAGE = "Agent and Design System settings couldn't load after 5 tries. Dezin is retrying; use Rescan agents to retry now.";
type WorkspaceRightPanel = "proposal" | "plan" | null;

function projectAgentTrace(
  entry: AgentTranscriptEntry,
  detail: GenerationPlanDetail | null,
  labels: GenerationPlanTargetLabels,
  artifactId: string | null,
  resourceId: string | null,
): ProjectedAgentTranscriptEntry["trace"] {
  if (detail === null) {
    const kind = artifactId === null ? resourceId === null ? null : "resource" : "artifact";
    const targetId = artifactId ?? resourceId;
    if (entry.planId === undefined || entry.resultRevisionId === undefined || kind === null || targetId === null) {
      return undefined;
    }
    const name = kind === "artifact" ? labels.artifacts.get(targetId) ?? "Artifact" : labels.resources.get(targetId) ?? "Resource";
    return {
      status: "succeeded",
      planId: entry.planId,
      ...(entry.taskId === undefined ? {} : { taskId: entry.taskId }),
      output: { kind, targetId, revisionId: entry.resultRevisionId, label: `${name} Revision` },
    };
  }
  const task = entry.taskId === undefined
    ? detail.tasks.length === 1 ? detail.tasks[0] : undefined
    : detail.tasks.find((candidate) => candidate.id === entry.taskId);
  const taskStatus = task?.status;
  const planStatus = detail.plan.status;
  const status: AgentTraceStatus = taskStatus === "succeeded" || taskStatus === "cancelled"
    ? taskStatus
    : taskStatus === "failed" || taskStatus === "blocked"
      ? "failed"
      : planStatus === "succeeded" || planStatus === "cancelled"
        ? planStatus
        : planStatus === "failed" || planStatus === "compile-failed" || planStatus === "requires-new-impact"
          ? "failed"
          : taskStatus === "running" || planStatus === "running" ? "running" : "queued";
  let output: AgentTraceOutput | undefined;
  if (task?.target.type === "artifact" && task.resultRevisionId !== null) {
    output = {
      kind: "artifact",
      targetId: task.target.id,
      revisionId: task.resultRevisionId,
      label: `${labels.artifacts.get(task.target.id) ?? (task.kind === "component" ? "Component" : "Page")} Revision`,
    };
  } else if (task?.target.type === "resource" && task.resultResourceRevisionId !== null) {
    output = {
      kind: "resource",
      targetId: task.target.id,
      revisionId: task.resultResourceRevisionId,
      label: `${labels.resources.get(task.target.id) ?? "Resource"} Revision`,
    };
  }
  return {
    status,
    planId: detail.plan.id,
    ...(task === undefined ? {} : { taskId: task.id }),
    ...(output === undefined ? {} : { output }),
  };
}

interface SharedSettingsRead {
  promise: Promise<Settings>;
  consumers: number;
  releaseTimer?: ReturnType<typeof setTimeout>;
}
interface AcquiredSettingsRead {
  promise: Promise<Settings>;
  release: () => void;
}
const inFlightSettingsReads = new WeakMap<ApiClient, SharedSettingsRead>();

function acquireSettingsRead(api: ApiClient): AcquiredSettingsRead {
  let shared = inFlightSettingsReads.get(api);
  if (!shared) {
    shared = {
      promise: Promise.resolve().then(() => api.getSettings()),
      consumers: 0,
    };
    inFlightSettingsReads.set(api, shared);
  }
  const entry = shared;
  if (entry.releaseTimer !== undefined) {
    clearTimeout(entry.releaseTimer);
    entry.releaseTimer = undefined;
  }
  entry.consumers += 1;
  let released = false;
  return {
    promise: entry.promise,
    release: () => {
      if (released) return;
      released = true;
      entry.consumers = Math.max(0, entry.consumers - 1);
      if (entry.consumers !== 0) return;
      entry.releaseTimer = setTimeout(() => {
        if (inFlightSettingsReads.get(api) === entry && entry.consumers === 0) {
          inFlightSettingsReads.delete(api);
        }
      }, 0);
    },
  };
}

export function buildResourceRevisionStates(
  resources: readonly Resource[],
  activeRevisionIds: Readonly<Record<string, string | null | undefined>>,
  revisions: readonly ResourceRevision[],
): Readonly<Record<string, CanvasResourceRevisionState>> {
  const revisionByResourceAndId = new Map(revisions.map((revision) => [
    `${revision.resourceId}\u0000${revision.id}`,
    revision,
  ]));
  const result: Record<string, CanvasResourceRevisionState> = {};
  for (const resource of resources) {
    const revisionId = activeRevisionIds[resource.id] ?? null;
    if (revisionId === null) continue;
    const revision = revisionByResourceAndId.get(`${resource.id}\u0000${revisionId}`);
    const qualityState = revision?.metadata.qualityState;
    result[resource.id] = {
      revisionId,
      resourceKind: resource.kind,
      qualityState: qualityState === "grounded" || qualityState === "needs-review" ? qualityState : null,
    };
  }
  return result;
}

export function buildArtifactRevisionQualityStates(
  activeRevisionIds: Readonly<Record<string, string | null | undefined>>,
  revisions: readonly ArtifactRevision[],
): Readonly<Record<string, CanvasArtifactRevisionQualityState>> {
  const revisionByArtifactAndId = new Map(revisions.map((revision) => [
    `${revision.artifactId}\u0000${revision.id}`,
    revision,
  ]));
  const result: Record<string, CanvasArtifactRevisionQualityState> = {};
  for (const [artifactId, revisionId] of Object.entries(activeRevisionIds)) {
    if (revisionId === null || revisionId === undefined) continue;
    const revision = revisionByArtifactAndId.get(`${artifactId}\u0000${revisionId}`);
    if (!revision) continue;
    const state = revision.quality.state;
    const qualityState = state === "passed"
      || state === "needs-attention"
      || state === "failed"
      || state === "unassessed"
      ? state
      : "unassessed";
    const score = revision.quality.score;
    result[artifactId] = {
      revisionId,
      qualityState,
      qualityScore: typeof score === "number"
        && Number.isFinite(score)
        && score >= 0
        && score <= 100
        ? score
        : null,
    };
  }
  return result;
}

function StudioDragRegion() {
  return <div data-testid="project-studio-drag-region" aria-hidden className="app-drag absolute inset-x-0 top-0 z-10 h-11" />;
}

function RouteLoading({ scope }: { scope: "canvas" | "artifact" | "resource" }) {
  const label = scope === "artifact"
    ? "Loading artifact editor"
    : scope === "resource"
      ? "Loading resource editor"
      : "Loading project canvas";
  return (
    <section
      role="status"
      aria-label={label}
      aria-live="polite"
      className="relative grid h-full min-h-0 w-full place-items-center bg-background px-6 text-center"
    >
      <StudioDragRegion />
      <div>
        <div aria-hidden className="mx-auto mb-3 h-4 w-4 animate-pulse rounded-full bg-muted-foreground/35" />
        <p className="text-xs font-medium text-foreground">{label}…</p>
        <p className="mt-1 text-[11px] text-muted-foreground">Preparing project context</p>
      </div>
    </section>
  );
}

function ProjectCanvasLoading() {
  return (
    <section role="region" aria-label="Project canvas" className="relative grid h-full min-h-0 min-w-0 place-items-center bg-background">
      <StudioDragRegion />
      <p role="status" aria-live="polite" className="text-xs text-muted-foreground">Loading project canvas…</p>
    </section>
  );
}

function resourceScopeLabel(kind: WorkspaceResourceKind | undefined): string {
  if (!kind) return "Resource";
  return kind.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error(`Couldn't read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

export function ProjectStudioScreen({
  projectId,
  artifactId,
  artifactRevisionId = null,
  artifactCandidate = null,
  resourceId = null,
  resourceRevisionId = null,
  legacyFallback,
  onOpenSettings,
}: {
  projectId: string;
  artifactId: string | null;
  artifactRevisionId?: string | null;
  artifactCandidate?: ArtifactCandidateRouteIdentity | null;
  resourceId?: string | null;
  resourceRevisionId?: string | null;
  legacyFallback: LegacyWorkspaceComponent;
  onOpenSettings: (section?: string) => void;
}) {
  const api = useApi();
  const { toast } = useToast();
  const {
    provided: agentsProvided,
    agents,
    loading: agentsLoading,
    error: agentsError,
    rescan: rescanAgents,
  } = useAgents();
  const studio = useProjectStudio(projectId, artifactId, resourceId);
  const { load } = studio;
  const artifactScope = artifactId !== null;
  const resourceScope = resourceId !== null;
  const workspaceScope = !artifactScope && !resourceScope;
  const readyWorkspace = load.status === "ready" ? load.workspace : null;
  const [designSystems, setDesignSystems] = useState<DesignSystemCard[]>([]);
  const [designSystemCatalogStatus, setDesignSystemCatalogStatus] = useState<"loading" | "ready" | "error">("loading");
  const [projectDesignSystemId, setProjectDesignSystemId] = useState<string | null | undefined>(undefined);
  const [defaultDesignSystemId, setDefaultDesignSystemId] = useState("");
  const [settingsLoadStatus, setSettingsLoadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [settingsLoadError, setSettingsLoadError] = useState<string | null>(null);
  const [settingsLoadRetryEpoch, setSettingsLoadRetryEpoch] = useState(0);
  const designSystemId = projectDesignSystemId === null
    ? defaultDesignSystemId
    : designSystemPickerValue(projectDesignSystemId ?? null);
  const designSystemSelectionStatus = projectDesignSystemId === undefined
    ? "loading"
    : projectDesignSystemId === null
      ? settingsLoadStatus
      : "ready";
  const [settingsAgent, setSettingsAgent] = useState<string | null>(null);
  const [settingsModel, setSettingsModel] = useState("");
  const settingsAgentSelectionRef = useRef<{ agent: string | null; model: string }>({
    agent: null,
    model: "",
  });
  settingsAgentSelectionRef.current = { agent: settingsAgent, model: settingsModel };
  const [studioAgent, setStudioAgent] = useState("");
  const [studioModel, setStudioModel] = useState("");
  const [agentSettingsReady, setAgentSettingsReady] = useState(false);
  const [agentSettingsError, setAgentSettingsError] = useState<string | null>(null);
  const [designSystemError, setDesignSystemError] = useState<string | null>(null);
  const studioAgentRef = useRef("");
  const agentSettingsWriteRef = useRef<Promise<void>>(Promise.resolve());
  const agentSettingsErrorRef = useRef<string | null>(null);
  const agentSettingsPendingWritesRef = useRef(0);
  const settingsHydrationEpochRef = useRef(0);
  const designSystemWriteRef = useRef<Promise<void>>(Promise.resolve());
  const designSystemErrorRef = useRef<string | null>(null);
  const agentSettingsRequestRef = useRef(0);
  const designSystemRequestRef = useRef(0);
  const designSystemCatalogRequestRef = useRef(0);
  const initialTurnRef = useRef<PendingDesignWorkspaceTurn | null | undefined>(undefined);
  const initialTurnAttemptedRef = useRef(false);
  const initialTurnOperationRef = useRef<object | null>(null);
  const initialTurnProcessingRef = useRef(false);
  const initialTurnCleanupFailedRef = useRef<string | null>(null);
  const activeProjectIdRef = useRef(projectId);
  activeProjectIdRef.current = projectId;
  const [initialTurnProcessing, setInitialTurnProcessing] = useState(false);
  const [initialTurnObservationEpoch, setInitialTurnObservationEpoch] = useState(0);
  const workspaceId = readyWorkspace?.workspace.id ?? null;
  const resourceHeadRevisionId = resourceId === null
    ? null
    : readyWorkspace?.activeSnapshot.resourceRevisions[resourceId] ?? null;
  const activeSnapshotId = readyWorkspace?.activeSnapshot.id ?? null;
  const activeArtifact = artifactId === null
    ? null
    : readyWorkspace?.artifacts.find((candidate) => candidate.id === artifactId) ?? null;
  const artifactEditor = useArtifactEditorController({
    projectId,
    artifactId,
    artifact: activeArtifact,
    tracks: readyWorkspace?.tracks.filter((track) => track.artifactId === artifactId) ?? [],
    revisions: readyWorkspace?.revisions.filter((revision) => revision.artifactId === artifactId) ?? [],
    activeRevisionId: artifactId === null
      ? null
      : readyWorkspace?.activeSnapshot.artifactRevisions[artifactId] ?? null,
    activeSnapshotId: readyWorkspace?.activeSnapshot.id ?? null,
    target: artifactCandidate !== null && artifactId !== null
      ? {
          kind: "generation-candidate",
          projectId,
          artifactId,
          planId: artifactCandidate.planId,
          taskId: artifactCandidate.taskId,
          attempt: artifactCandidate.attempt,
        }
      : artifactRevisionId === null
        ? undefined
        : { kind: "artifact-revision", projectId, revisionId: artifactRevisionId },
    onArtifactPublished: studio.reconcileArtifactPublication,
  });
  const resourceEditor = useResourceEditorController({
    projectId,
    workspaceId,
    resourceId,
    requestedRevisionId: resourceRevisionId,
    activeRevisionId: resourceHeadRevisionId,
    activeSnapshotId,
  });
  const [resourceCatalog, setResourceCatalog] = useState<Resource[]>([]);
  const [attachingContext, setAttachingContext] = useState(false);
  const [resourceIntentPlanId, setResourceIntentPlanId] = useState<string | null>(null);
  const [workspacePlanId, setWorkspacePlanId] = useState<string | null>(null);
  const [workspacePlanDetail, setWorkspacePlanDetail] = useState<GenerationPlanDetail | null>(null);
  const [viewedPlanDetail, setViewedPlanDetail] = useState<GenerationPlanDetail | null>(null);
  const [workspacePlanObservationEpoch, setWorkspacePlanObservationEpoch] = useState(0);
  const workspacePlanResultKeysRef = useRef(new Set<string>());
  const [workspaceRightPanel, setWorkspaceRightPanel] = useState<WorkspaceRightPanel>(null);
  const planPanelButtonRef = useRef<HTMLButtonElement | null>(null);
  const pendingTraceTaskIdRef = useRef<string | null>(null);
  const autoOpenedProposalIdRef = useRef<string | null>(null);
  const [prototypeFlowSession, setPrototypeFlowSession] = useState<PrototypeFlowSession | null>(null);
  const presentFlowButtonRef = useRef<HTMLButtonElement | null>(null);
  const restorePresentFlowFocusRef = useRef(false);
  const [scopedInspectorMode, setScopedInspectorMode] = useState<"inspector" | "plan">("inspector");
  const scopedInspectorScopeKey = artifactId !== null
    ? `artifact:${artifactId}:${
        artifactCandidate !== null
          ? `candidate:${artifactCandidate.planId}:${artifactCandidate.taskId}:${artifactCandidate.attempt}`
          : artifactRevisionId === null
            ? "head"
            : `revision:${artifactRevisionId}`
      }`
    : resourceId !== null
      ? `resource:${resourceId}:${resourceRevisionId === null ? "head" : `revision:${resourceRevisionId}`}`
      : "workspace";
  const contextActionGuardRef = useRef({
    mounted: true,
    scopeKey: scopedInspectorScopeKey,
    epoch: 0,
  });
  if (contextActionGuardRef.current.scopeKey !== scopedInspectorScopeKey) {
    contextActionGuardRef.current.scopeKey = scopedInspectorScopeKey;
    contextActionGuardRef.current.epoch += 1;
  }
  const [attachmentErrorsByScope, setAttachmentErrorsByScope] = useState<Record<string, string>>({});
  const attachmentError = attachmentErrorsByScope[scopedInspectorScopeKey] ?? null;
  const clearAttachmentError = useCallback((scopeKey: string): void => {
    setAttachmentErrorsByScope((current) => {
      if (!(scopeKey in current)) return current;
      const next = { ...current };
      delete next[scopeKey];
      return next;
    });
  }, []);
  const recordAttachmentError = useCallback((scopeKey: string, message: string): void => {
    setAttachmentErrorsByScope((current) => ({ ...current, [scopeKey]: message }));
  }, []);
  const reconcileCompletedInitialTurn = useCallback((completedTurnId: string): void => {
    if (acknowledgePendingDesignWorkspaceTurn(projectId, completedTurnId)) {
      initialTurnCleanupFailedRef.current = null;
      initialTurnRef.current = null;
      return;
    }
    const latest = peekPendingDesignWorkspaceTurn(projectId);
    if (latest === null) {
      initialTurnCleanupFailedRef.current = null;
      initialTurnRef.current = null;
      return;
    }
    const latestActiveTurnId = latest.supersededByTurnId ?? latest.turnId;
    initialTurnRef.current = latest;
    if (latestActiveTurnId !== completedTurnId) {
      initialTurnCleanupFailedRef.current = null;
      initialTurnAttemptedRef.current = false;
      setInitialTurnObservationEpoch((epoch) => epoch + 1);
      return;
    }
    initialTurnCleanupFailedRef.current = completedTurnId;
    initialTurnAttemptedRef.current = true;
    recordAttachmentError(
      "workspace",
      "The proposal is ready, but its recovery marker couldn't be cleared. Dezin will retry cleanup next time this project opens.",
    );
  }, [projectId, recordAttachmentError]);
  const scopedGenerationPlanId = artifactCandidate !== null
    ? artifactCandidate.planId
    : artifactScope && artifactRevisionId === null
      ? studio.artifactAgentPlanId
      : resourceScope && resourceRevisionId === null
        ? studio.resourceAgentPlanId
        : null;
  const observedGenerationPlanId = workspaceScope
    ? workspacePlanId
    : resourceIntentPlanId ?? scopedGenerationPlanId ?? workspacePlanId;
  const observeGenerationPlanResult = useCallback((detail: GenerationPlanDetail): void => {
    const resultKey = generationPlanResultKey(detail);
    if (resultKey === null || workspacePlanResultKeysRef.current.has(resultKey)) return;
    workspacePlanResultKeysRef.current.add(resultKey);
    studio.reconcileGenerationPublication();
  }, [studio.reconcileGenerationPublication]);
  const commitWorkspacePlanDetail = useCallback((detail: GenerationPlanDetail): void => {
    setWorkspacePlanDetail(detail);
    observeGenerationPlanResult(detail);
  }, [observeGenerationPlanResult]);
  const handleGenerationPlanDetailChange = useCallback((
    change: GenerationPlanDetailChange,
  ): void => {
    setViewedPlanDetail(change.detail);
    observeGenerationPlanResult(change.detail);
    if (change.detail.plan.id === observedGenerationPlanId) {
      setWorkspacePlanDetail(change.detail);
    }
    if (change.detail.plan.id === observedGenerationPlanId
      && change.source === "retry"
      && !terminalGenerationPlan(change.detail)) {
      setWorkspacePlanObservationEpoch((epoch) => epoch + 1);
    }
  }, [observeGenerationPlanResult, observedGenerationPlanId]);
  const scopedAgentSubmitting = artifactScope
    ? studio.artifactAgentSubmitting
    : resourceScope
      ? studio.resourceAgentSubmitting
      : false;
  const scopedAgentReceiptId = artifactScope
    ? studio.artifactAgentReceipt?.task.id ?? null
    : resourceScope
      ? studio.resourceAgentReceipt?.task.id ?? null
      : null;
  const scopedSubmissionRef = useRef({
    scopeKey: scopedInspectorScopeKey,
    wasSubmitting: false,
    receiptAtStart: scopedAgentReceiptId,
  });
  const workspaceRevision = readyWorkspace?.graph.revision ?? null;
  const approvedPlanFromReview = studio.proposalReview.status === "approved"
    ? studio.proposalReview.plan?.id ?? null
    : null;
  const reviewableProposal = studio.proposalReview.status === "draft"
    || studio.proposalReview.status === "saving"
    || studio.proposalReview.status === "validation-error"
    || studio.proposalReview.status === "conflicted"
    ? studio.proposalReview
    : null;
  const workspaceProposalId = reviewableProposal?.proposal.id ?? null;

  useEffect(() => {
    studioAgentRef.current = studioAgent;
  }, [studioAgent]);

  useEffect(() => {
    contextActionGuardRef.current.mounted = true;
    contextActionGuardRef.current.epoch += 1;
    return () => {
      contextActionGuardRef.current.mounted = false;
      contextActionGuardRef.current.epoch += 1;
    };
  }, []);

  const refreshDesignSystems = useCallback((): void => {
    const request = ++designSystemCatalogRequestRef.current;
    setDesignSystemCatalogStatus("loading");
    void api.listDesignSystems().then((systems) => {
      if (request !== designSystemCatalogRequestRef.current) return;
      setDesignSystems(systems);
      setDesignSystemCatalogStatus("ready");
    }).catch(() => {
      if (request === designSystemCatalogRequestRef.current) setDesignSystemCatalogStatus("error");
    });
  }, [api]);

  useEffect(() => {
    refreshDesignSystems();
    return () => {
      designSystemCatalogRequestRef.current += 1;
    };
  }, [refreshDesignSystems]);

  useEffect(() => {
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const activeReads = new Set<AcquiredSettingsRead>();
    setSettingsLoadStatus("loading");
    setSettingsLoadError(null);
    const refresh = async (): Promise<void> => {
      const hydrationEpoch = settingsHydrationEpochRef.current;
      const agentRequest = agentSettingsRequestRef.current;
      const read = acquireSettingsRead(api);
      activeReads.add(read);
      try {
        const settings = await read.promise;
        if (!alive) return;
        if (hydrationEpoch !== settingsHydrationEpochRef.current) return;
        if (agentRequest === agentSettingsRequestRef.current
          && agentSettingsPendingWritesRef.current === 0) {
          setSettingsAgent(settings.agentCommand ?? "");
          setSettingsModel(settings.model ?? "");
        }
        setDefaultDesignSystemId(settings.defaultDesignSystemId);
        setSettingsLoadStatus("ready");
        setSettingsLoadError(null);
      } catch {
        if (!alive) return;
        if (hydrationEpoch !== settingsHydrationEpochRef.current) return;
        failures += 1;
        if (failures >= SETTINGS_LOAD_ERROR_AFTER_FAILURES) {
          setSettingsLoadStatus("error");
          setSettingsLoadError(SETTINGS_LOAD_ERROR_MESSAGE);
        }
        retryTimer = setTimeout(
          () => {
            if (!alive || hydrationEpoch !== settingsHydrationEpochRef.current) return;
            void refresh();
          },
          Math.min(250 * (2 ** Math.min(failures - 1, 4)), 4_000),
        );
      } finally {
        activeReads.delete(read);
        read.release();
      }
    };
    void refresh();
    return () => {
      alive = false;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      for (const read of activeReads) read.release();
      activeReads.clear();
    };
  }, [api, settingsLoadRetryEpoch]);

  useEffect(() => {
    const onSettingsUpdated = (event: Event): void => {
      const settings = (event as CustomEvent<Settings>).detail;
      if (!settings) return;
      settingsHydrationEpochRef.current += 1;
      setDefaultDesignSystemId(settings.defaultDesignSystemId);
      setSettingsLoadStatus("ready");
      setSettingsLoadError(null);
      if (agentSettingsPendingWritesRef.current !== 0) return;
      const nextAgent = settings.agentCommand ?? "";
      const nextModel = settings.model ?? "";
      const current = settingsAgentSelectionRef.current;
      if (current.agent !== nextAgent || current.model !== nextModel) {
        setAgentSettingsReady(false);
      }
      agentSettingsErrorRef.current = null;
      setAgentSettingsError(null);
      setSettingsAgent(nextAgent);
      setSettingsModel(nextModel);
    };
    window.addEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated);
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated);
  }, []);

  useEffect(() => {
    if (load.status !== "ready") return;
    setProjectDesignSystemId(load.project.designSystemId);
  }, [load.status, load.status === "ready" ? load.project.designSystemId : null, projectId]);

  const saveAgentModelDefaults = useCallback((agentCommand: string, model: string): void => {
    const request = ++agentSettingsRequestRef.current;
    agentSettingsPendingWritesRef.current += 1;
    agentSettingsErrorRef.current = null;
    setAgentSettingsError(null);
    setAgentSettingsReady(false);
    const write = agentSettingsWriteRef.current
      .catch(() => {})
      .then(() => persistAgentModelDefaultsStrict(
        api,
        { agentCommand, model },
      ));
    agentSettingsWriteRef.current = write.then(
      () => {
        agentSettingsPendingWritesRef.current = Math.max(0, agentSettingsPendingWritesRef.current - 1);
        if (request !== agentSettingsRequestRef.current) return;
        agentSettingsErrorRef.current = null;
        if (contextActionGuardRef.current.mounted) {
          setSettingsAgent(agentCommand);
          setSettingsModel(model);
          setAgentSettingsError(null);
          setAgentSettingsReady(true);
        }
      },
      () => {
        agentSettingsPendingWritesRef.current = Math.max(0, agentSettingsPendingWritesRef.current - 1);
        if (request !== agentSettingsRequestRef.current) return;
        const message = "Couldn't save the selected Agent setting. Choose it again to retry.";
        agentSettingsErrorRef.current = message;
        if (contextActionGuardRef.current.mounted) {
          setAgentSettingsError(message);
          setAgentSettingsReady(false);
        }
      },
    );
  }, [api]);

  useEffect(() => {
    if (settingsAgent === null) return;
    const selectable = selectableAgents(agents);
    const saved = selectable.find((candidate) => candidate.command === settingsAgent);
    const selected = saved ?? agents.find((candidate) => candidate.available) ?? selectable[0];
    if (!selected) return;
    studioAgentRef.current = selected.command;
    setStudioAgent(selected.command);
    setStudioModel(saved ? normalizeAgentModel(selected, settingsModel) : "");
    setAgentSettingsReady(true);
  }, [agents, settingsAgent, settingsModel]);

  const changeStudioAgent = useCallback((command: string): void => {
    studioAgentRef.current = command;
    setStudioAgent(command);
    setStudioModel("");
    saveAgentModelDefaults(command, "");
  }, [saveAgentModelDefaults]);

  const changeStudioModel = useCallback((model: string): void => {
    setStudioModel(model);
    if (studioAgentRef.current) saveAgentModelDefaults(studioAgentRef.current, model);
  }, [saveAgentModelDefaults]);

  const retrySettingsLoad = useCallback((): void => {
    setSettingsLoadError(null);
    setSettingsLoadStatus("loading");
    // Let acquireSettingsRead's zero-delay release discard the failed shared read
    // before starting an explicit retry from the Agent menu.
    window.setTimeout(() => {
      if (contextActionGuardRef.current.mounted) {
        setSettingsLoadRetryEpoch((epoch) => epoch + 1);
      }
    }, 0);
  }, []);

  const rescanStudioAgents = useCallback(async (): Promise<void> => {
    if (settingsLoadStatus === "error") retrySettingsLoad();
    await rescanAgents();
  }, [rescanAgents, retrySettingsLoad, settingsLoadStatus]);

  const changeDesignSystem = useCallback((nextId: string | null): void => {
    const previousId = projectDesignSystemId;
    const nextProjectDesignSystemId = nextId === null ? null : persistedDesignSystemId(nextId);
    const request = ++designSystemRequestRef.current;
    designSystemErrorRef.current = null;
    setDesignSystemError(null);
    setProjectDesignSystemId(nextProjectDesignSystemId);
    const write = designSystemWriteRef.current
      .catch(() => {})
      .then(() => api.patchProject(projectId, {
        designSystemId: nextProjectDesignSystemId,
      }))
      .then((project) => {
        if (request !== designSystemRequestRef.current) return;
        designSystemErrorRef.current = null;
        if (contextActionGuardRef.current.mounted) {
          setDesignSystemError(null);
          setProjectDesignSystemId(project.designSystemId);
        }
      })
      .catch(() => {
        if (request !== designSystemRequestRef.current) return;
        const persistenceMessage = "Couldn't save the Design System. Choose it again to retry.";
        designSystemErrorRef.current = persistenceMessage;
        if (!contextActionGuardRef.current.mounted) return;
        setDesignSystemError(persistenceMessage);
        setProjectDesignSystemId(previousId);
      });
    designSystemWriteRef.current = write;
  }, [api, projectDesignSystemId, projectId]);

  const afterContextSettings = useCallback(async <T,>(action: () => T | Promise<T>): Promise<T | undefined> => {
    const guard = contextActionGuardRef.current;
    const epoch = guard.epoch;
    const scopeKey = guard.scopeKey;
    for (;;) {
      const agentRequest = agentSettingsRequestRef.current;
      const designSystemRequest = designSystemRequestRef.current;
      await Promise.all([agentSettingsWriteRef.current, designSystemWriteRef.current]);
      if (!guard.mounted || guard.epoch !== epoch || guard.scopeKey !== scopeKey) return undefined;
      if (agentRequest !== agentSettingsRequestRef.current
        || designSystemRequest !== designSystemRequestRef.current) continue;
      if (agentSettingsErrorRef.current !== null || designSystemErrorRef.current !== null) return undefined;
      break;
    }
    return action();
  }, []);

  useEffect(() => {
    if (load.status !== "ready" || settingsAgent === null || (agentsProvided && agentsLoading)) return;
    if (initialTurnRef.current === undefined) {
      initialTurnRef.current = peekPendingDesignWorkspaceTurn(projectId);
    }
    const pendingTurn = initialTurnRef.current;
    if (pendingTurn === null) return;
    const activePendingTurnId = pendingTurn.supersededByTurnId ?? pendingTurn.turnId;
    const completedByOutboxReplay = studio.agentTranscript.some((entry) => (
      entry.turnId === activePendingTurnId
      && entry.role === "assistant"
      && entry.state === "proposal"
    ));
    if (completedByOutboxReplay) {
      if (initialTurnCleanupFailedRef.current === activePendingTurnId) return;
      reconcileCompletedInitialTurn(activePendingTurnId);
      return;
    }
    if (studio.workspaceAgentOutbox?.turnId === activePendingTurnId) {
      if (studio.workspaceAgentOutbox.delivery.status === "failed"
        && !initialTurnAttemptedRef.current) {
        initialTurnAttemptedRef.current = true;
        if (pendingTurn.supersededByTurnId === undefined) {
          studio.setWorkspaceAgentDraft((current) => current.trim() ? current : pendingTurn.brief);
        }
      }
      return;
    }
    if (initialTurnAttemptedRef.current) return;
    if (pendingTurn.supersededByTurnId !== undefined) {
      initialTurnAttemptedRef.current = true;
      if (pendingTurn.recoveryRequest !== undefined) {
        studio.setAgentContextItems(pendingTurn.recoveryRequest.contextItems.map((item) => ({
          ...item,
          type: "context-ref" as const,
        })));
        studio.setSelectedGraphObjectIds([
          ...new Set((pendingTurn.recoveryRequest.request.selection ?? [])
            .filter((selection) => selection.kind === "node")
            .map((selection) => selection.id)),
        ]);
      }
      studio.setWorkspaceAgentDraft((current) => current.trim() ? current : pendingTurn.brief);
      recordAttachmentError(
        "workspace",
        "The replacement request was interrupted before delivery. Review this draft, then submit it again.",
      );
      return;
    }
    const agentCommand = pendingTurn.agentCommand ?? studioAgentRef.current;
    const selectedAgent = agents.find((candidate) => candidate.command === agentCommand);
    if (agentsProvided && (!selectedAgent || !selectedAgent.available)) {
      initialTurnAttemptedRef.current = true;
      studio.setWorkspaceAgentDraft((current) => current.trim() ? current : pendingTurn.brief);
      recordAttachmentError(
        "workspace",
        `${selectedAgent?.command ?? pendingTurn.agentCommand ?? "The selected Agent"} is unavailable. Choose an available Agent, then submit this draft.`,
      );
      return;
    }

    studioAgentRef.current = agentCommand;
    setStudioAgent(agentCommand);
    setStudioModel(pendingTurn.model ?? "");
    setAgentSettingsReady(true);
    const guard = contextActionGuardRef.current;
    const epoch = guard.epoch;
    const operation = {};
    initialTurnOperationRef.current = operation;
    initialTurnProcessingRef.current = true;
    setInitialTurnProcessing(true);
    const finishOperation = (): void => {
      if (initialTurnOperationRef.current !== operation) return;
      initialTurnOperationRef.current = null;
      initialTurnProcessingRef.current = false;
      if (guard.mounted) setInitialTurnProcessing(false);
    };
    const originalTurnStillActive = (): boolean => {
      if (activeProjectIdRef.current !== projectId) return false;
      const durable = peekPendingDesignWorkspaceTurn(projectId);
      const active = durable !== null
        && durable.turnId === pendingTurn.turnId
        && durable.supersededByTurnId === undefined;
      if (!active) {
        initialTurnRef.current = durable;
        initialTurnAttemptedRef.current = false;
        setInitialTurnObservationEpoch((current) => current + 1);
      }
      return active
        && initialTurnRef.current?.turnId === pendingTurn.turnId
        && initialTurnRef.current.supersededByTurnId === undefined;
    };
    let timerStarted = false;
    const timer = window.setTimeout(() => {
      timerStarted = true;
      if (!guard.mounted || guard.epoch !== epoch || guard.scopeKey !== "workspace"
        || !originalTurnStillActive()) {
        finishOperation();
        return;
      }
      initialTurnAttemptedRef.current = true;
      void (async () => {
        try {
          for (const attachment of pendingTurn.attachments ?? []) {
            if (!guard.mounted || guard.epoch !== epoch || guard.scopeKey !== "workspace"
              || !originalTurnStillActive()) return;
            const source = attachment.projectReference === undefined
              ? {
                  type: "uploaded-file" as const,
                  uploadedFileId: attachment.uploadedFileId!,
                }
              : {
                  type: "project-reference" as const,
                  ...attachment.projectReference,
                };
            const attachmentIdentity = attachment.projectReference === undefined
              ? attachment.uploadedFileId!
              : [
                  attachment.projectReference.sourceProjectId,
                  attachment.projectReference.sourceArtifactRevisionId,
                ].join(":");
            await studio.materializeAgentResourceContext({
              title: attachment.title,
              kind: "file",
              source,
              idempotencyKey: `home-attachment:${attachmentIdentity}`,
              ...(attachment.preview && attachment.uploadedFileId
                ? { previewUrl: api.refUrl(projectId, attachment.uploadedFileId) }
                : {}),
            });
            if (!guard.mounted || guard.epoch !== epoch || guard.scopeKey !== "workspace"
              || !originalTurnStillActive()) return;
          }
          if (!guard.mounted || guard.epoch !== epoch || guard.scopeKey !== "workspace"
            || !originalTurnStillActive()) return;
          clearAttachmentError("workspace");
          if (!pendingTurn.attachmentsStaged) {
            recordAttachmentError(
              "workspace",
              `Initial attachment staging was interrupted (${pendingTurn.attachments?.length ?? 0}/${pendingTurn.attachmentCount}). Reattach the missing references, then submit this draft.`,
            );
            studio.setWorkspaceAgentDraft((current) => current.trim() ? current : pendingTurn.brief);
            return;
          }
          if (!originalTurnStillActive()) return;
          const queued = await studio.submitWorkspaceAgentPrompt({
            message: pendingTurn.brief,
            turnId: pendingTurn.turnId,
            ...(agentCommand ? { agentCommand } : {}),
            ...(pendingTurn.model ? { model: pendingTurn.model } : {}),
            isCurrent: originalTurnStillActive,
          });
          if (!queued) {
            if (originalTurnStillActive()) {
              studio.setWorkspaceAgentDraft((current) => current.trim() ? current : pendingTurn.brief);
            }
            return;
          }
          reconcileCompletedInitialTurn(pendingTurn.turnId);
        } catch (error) {
          if (!guard.mounted || guard.epoch !== epoch || guard.scopeKey !== "workspace"
            || !originalTurnStillActive()) return;
          const message = error instanceof Error && error.message.trim()
            ? error.message
            : "Couldn't attach the initial design context.";
          recordAttachmentError("workspace", message);
          studio.setWorkspaceAgentDraft((current) => current.trim() ? current : pendingTurn.brief);
        } finally {
          finishOperation();
        }
      })();
    }, 0);
    return () => {
      if (!timerStarted || !guard.mounted || guard.epoch !== epoch || guard.scopeKey !== "workspace"
        || activeProjectIdRef.current !== projectId) {
        window.clearTimeout(timer);
        finishOperation();
      }
    };
  }, [
    agents,
    agentsLoading,
    agentsProvided,
    load.status,
    api,
    clearAttachmentError,
    initialTurnObservationEpoch,
    projectId,
    reconcileCompletedInitialTurn,
    recordAttachmentError,
    settingsAgent,
    studio.agentTranscript,
    studio.materializeAgentResourceContext,
    studio.setWorkspaceAgentDraft,
    studio.submitWorkspaceAgentPrompt,
    studio.workspaceAgentDraft,
    studio.workspaceAgentOutbox,
  ]);

  useEffect(() => {
    if (prototypeFlowSession !== null || !restorePresentFlowFocusRef.current) return;
    restorePresentFlowFocusRef.current = false;
    presentFlowButtonRef.current?.focus();
  }, [prototypeFlowSession]);

  useEffect(() => {
    let alive = true;
    if (workspaceId === null) {
      setResourceCatalog([]);
      return;
    }
    void api.listResources(projectId).then((resources) => {
      if (alive) setResourceCatalog(resources.filter((resource) => resource.archivedAt === null));
    }).catch(() => {
      if (alive) setResourceCatalog([]);
    });
    return () => {
      alive = false;
    };
  }, [api, projectId, workspaceId, workspaceRevision]);

  useEffect(() => {
    setResourceIntentPlanId(null);
  }, [resourceId, resourceRevisionId]);

  useEffect(() => {
    setPrototypeFlowSession(null);
  }, [projectId]);

  useEffect(() => {
    setWorkspacePlanId(null);
    setWorkspacePlanDetail(null);
    setViewedPlanDetail(null);
    setWorkspaceRightPanel(null);
    workspacePlanResultKeysRef.current.clear();
    autoOpenedProposalIdRef.current = null;
  }, [projectId]);

  useEffect(() => {
    if (workspaceId === null) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const controller = new AbortController();
    const discover = async (): Promise<void> => {
      try {
        const planId = await api.getLatestWorkspaceAgentPlanId(projectId, controller.signal);
        failures = 0;
        if (current && planId !== null) {
          setWorkspacePlanId((known) => known ?? planId);
        }
      } catch {
        failures += 1;
        if (current) {
          timer = setTimeout(
            () => void discover(),
            Math.min(100 * (4 ** Math.min(failures - 1, 3)), 4_000),
          );
        }
      }
    };
    void discover();
    return () => {
      current = false;
      controller.abort(new DOMException("Workspace view closed", "AbortError"));
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [api, projectId, workspaceId]);

  useEffect(() => {
    setWorkspacePlanDetail(null);
    setViewedPlanDetail(null);
  }, [observedGenerationPlanId, projectId]);

  useEffect(() => {
    if (observedGenerationPlanId === null) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const controller = new AbortController();
    const refresh = async (): Promise<void> => {
      try {
        const detail = await api.getGenerationPlan(projectId, observedGenerationPlanId, controller.signal);
        failures = 0;
        if (!current) return;
        commitWorkspacePlanDetail(detail);
        if (!terminalGenerationPlan(detail)) timer = setTimeout(() => void refresh(), 1_500);
      } catch {
        if (controller.signal.aborted) return;
        failures += 1;
        if (current) {
          timer = setTimeout(
            () => void refresh(),
            Math.min(500 * (2 ** Math.min(failures - 1, 3)), 4_000),
          );
        }
      }
    };
    void refresh();
    return () => {
      current = false;
      controller.abort(new DOMException("Generation Plan view closed", "AbortError"));
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [
    api,
    commitWorkspacePlanDetail,
    observedGenerationPlanId,
    projectId,
    workspacePlanObservationEpoch,
  ]);

  useEffect(() => {
    if (approvedPlanFromReview === null) return;
    setWorkspacePlanId(approvedPlanFromReview);
    setViewedPlanDetail(null);
  }, [approvedPlanFromReview]);

  useEffect(() => {
    if (!workspaceScope) return;
    if (workspaceProposalId !== null) {
      if (autoOpenedProposalIdRef.current === workspaceProposalId) return;
      autoOpenedProposalIdRef.current = workspaceProposalId;
      setWorkspaceRightPanel("proposal");
    } else if (workspaceRightPanel === "proposal" && studio.proposalReview.status === "idle") {
      setWorkspaceRightPanel(null);
    }
  }, [
    studio.proposalReview.status,
    workspaceProposalId,
    workspaceRightPanel,
    workspaceScope,
  ]);

  useEffect(() => {
    const tracked = scopedSubmissionRef.current;
    if (tracked.scopeKey !== scopedInspectorScopeKey) {
      scopedSubmissionRef.current = {
        scopeKey: scopedInspectorScopeKey,
        wasSubmitting: scopedAgentSubmitting,
        receiptAtStart: scopedAgentReceiptId,
      };
      setScopedInspectorMode("inspector");
      return;
    }
    if (!tracked.wasSubmitting && scopedAgentSubmitting) tracked.receiptAtStart = scopedAgentReceiptId;
    if (scopedGenerationPlanId !== null && scopedAgentReceiptId !== null
      && scopedAgentReceiptId !== tracked.receiptAtStart) {
      tracked.receiptAtStart = scopedAgentReceiptId;
      clearAttachmentError(scopedInspectorScopeKey);
      setScopedInspectorMode("plan");
    }
    tracked.wasSubmitting = scopedAgentSubmitting;
  }, [clearAttachmentError, scopedAgentReceiptId, scopedAgentSubmitting, scopedGenerationPlanId, scopedInspectorScopeKey]);

  const availableResources = useMemo(() => {
    const byId = new Map((readyWorkspace?.resources ?? []).map((resource) => [resource.id, resource]));
    for (const resource of resourceCatalog) {
      if (resource.workspaceId === workspaceId) byId.set(resource.id, resource);
    }
    return [...byId.values()];
  }, [readyWorkspace?.resources, resourceCatalog, workspaceId]);
  const resourceById = useMemo(
    () => new Map(availableResources.map((resource) => [resource.id, resource])),
    [availableResources],
  );
  const generationPlanTargetLabels = useMemo<GenerationPlanTargetLabels>(() => ({
    artifacts: new Map((readyWorkspace?.artifacts ?? []).map((artifact) => [artifact.id, artifact.name])),
    resources: new Map(availableResources.map((resource) => [resource.id, resource.title])),
  }), [availableResources, readyWorkspace?.artifacts]);
  const projectedAgentTranscript = useMemo(() => studio.agentTranscript.map((entry): ProjectedAgentTranscriptEntry => {
    const viewedMatches = viewedPlanDetail !== null && (
      viewedPlanDetail.plan.id === entry.planId || viewedPlanDetail.plan.proposalId === entry.proposalId
    );
    const workspaceMatches = workspacePlanDetail !== null && (
      workspacePlanDetail.plan.id === entry.planId || workspacePlanDetail.plan.proposalId === entry.proposalId
    );
    const detail = viewedMatches ? viewedPlanDetail : workspaceMatches ? workspacePlanDetail : null;
    const trace = projectAgentTrace(entry, detail, generationPlanTargetLabels, artifactId, resourceId);
    return trace === undefined ? entry : { ...entry, trace };
  }), [
    artifactId,
    generationPlanTargetLabels,
    resourceId,
    studio.agentTranscript,
    viewedPlanDetail,
    workspacePlanDetail,
  ]);
  const resourceRevisionStates = useMemo(() => readyWorkspace === null
    ? EMPTY_CANVAS_RESOURCE_REVISION_STATES
    : buildResourceRevisionStates(
        availableResources,
        readyWorkspace.activeSnapshot.resourceRevisions,
        readyWorkspace.resourceRevisions ?? [],
      ), [
    availableResources,
    readyWorkspace?.activeSnapshot.resourceRevisions,
    readyWorkspace?.resourceRevisions,
  ]);
  const artifactRevisionQualityStates = useMemo(() => readyWorkspace === null
    ? EMPTY_CANVAS_ARTIFACT_REVISION_QUALITY_STATES
    : buildArtifactRevisionQualityStates(
        readyWorkspace.activeSnapshot.artifactRevisions,
        readyWorkspace.revisions,
      ), [
    readyWorkspace?.activeSnapshot.artifactRevisions,
    readyWorkspace?.revisions,
  ]);
  const planViewActive = workspaceScope
    ? workspaceRightPanel === "plan"
    : scopedInspectorMode === "plan";
  const visibleGenerationPlanDetail = planViewActive
    ? viewedPlanDetail ?? workspacePlanDetail
    : workspacePlanDetail;
  const generationTargetStates = useMemo(
    () => buildGenerationTargetStates(visibleGenerationPlanDetail),
    [visibleGenerationPlanDetail],
  );
  const workspaceReferenceCards = useMemo(() => {
    if (readyWorkspace === null) return [] as DaemonContextCard[];
    const artifactCards = readyWorkspace.artifacts.flatMap((artifact): DaemonContextCard[] => {
      const revisionId = readyWorkspace.activeSnapshot.artifactRevisions[artifact.id] ?? null;
      if (revisionId === null) return [];
      return [{
        id: `artifact:${artifact.id}:${revisionId}`,
        type: "context-ref",
        title: artifact.name,
        subtitle: `${artifact.kind} · immutable Revision`,
        ref: { kind: "artifact", id: artifact.id, revisionId },
        projectId,
        artifactId: artifact.id,
        revisionId,
      }];
    });
    const resourceCards = availableResources.flatMap((resource): DaemonContextCard[] => {
      const revisionId = readyWorkspace.activeSnapshot.resourceRevisions[resource.id] ?? null;
      if (revisionId === null) return [];
      return [{
        id: `resource:${resource.id}:${revisionId}`,
        type: "context-ref",
        title: resource.title,
        subtitle: `${resource.kind} · immutable Revision`,
        ref: { kind: "resource", id: resource.id, resourceKind: resource.kind, revisionId },
        projectId,
        revisionId,
      }];
    });
    return [...artifactCards, ...resourceCards];
  }, [availableResources, projectId, readyWorkspace]);
  const workspaceReferenceById = useMemo(
    () => new Map(workspaceReferenceCards.map((item) => [item.id, item])),
    [workspaceReferenceCards],
  );

  const selectedContextItems = useMemo(() => {
    const items: DaemonContextCard[] = [];
    if (artifactId !== null && artifactEditor.selection !== null) {
      const selection = artifactEditor.selection;
      items.push({
        id: `selection:${selection.id}`,
        type: "context-ref",
        title: selection.label,
        subtitle: "Selected element",
        ref: { kind: "artifact", id: selection.artifactId, revisionId: selection.revisionId },
        projectId: selection.projectId,
        artifactId: selection.artifactId,
        revisionId: selection.revisionId,
        targetKey: selection.targetKey,
        assemblyHash: selection.assemblyHash,
        frameId: selection.frameId,
        designNodeId: selection.locator.designNodeId,
      });
    }
    if (artifactId === null && resourceId === null && readyWorkspace !== null) {
      const selected = new Set(studio.selectedGraphObjectIds);
      for (const node of readyWorkspace.graph.nodes) {
        if (!selected.has(node.id)) continue;
        if (node.kind === "resource") {
          const resource = resourceById.get(node.resourceId);
          const revisionId = readyWorkspace.activeSnapshot.resourceRevisions[node.resourceId] ?? null;
          if (!resource || revisionId === null) continue;
          items.push({
            id: `selection-node:${node.id}`,
            type: "context-ref",
            title: node.name,
            subtitle: `Selected ${resource.kind}`,
            ref: { kind: "resource", id: node.resourceId, resourceKind: resource.kind, revisionId },
            projectId,
            revisionId,
          });
        } else {
          const revisionId = readyWorkspace.activeSnapshot.artifactRevisions[node.artifactId] ?? null;
          if (revisionId === null) continue;
          items.push({
            id: `selection-node:${node.id}`,
            type: "context-ref",
            title: node.name,
            subtitle: `Selected ${node.kind}`,
            ref: { kind: "artifact", id: node.artifactId, revisionId },
            projectId,
            artifactId: node.artifactId,
            revisionId,
          });
        }
      }
    }
    return items;
  }, [artifactEditor.selection, artifactId, projectId, readyWorkspace, resourceById, resourceId, studio.selectedGraphObjectIds]);

  const agentContextItems = useMemo(() => {
    const selectedRefs = new Set(selectedContextItems.map((item) => JSON.stringify(item.ref)));
    return [
      ...selectedContextItems,
      ...studio.agentContextItems.filter((item) => !selectedRefs.has(JSON.stringify(item.ref))),
    ];
  }, [selectedContextItems, studio.agentContextItems]);
  const focusGenerationTaskOnCanvas = useCallback((task: GenerationTask): void => {
    const target = task.target;
    if (readyWorkspace === null || target.type === "workspace") return;
    const node = readyWorkspace.graph.nodes.find((candidate) => (
      target.type === "artifact"
        ? candidate.kind !== "resource" && candidate.artifactId === target.id
        : candidate.kind === "resource" && candidate.resourceId === target.id
    ));
    if (!node) return;
    studio.setSelectedGraphObjectIds([node.id]);
    if (!workspaceScope) {
      navigate(`/projects/${encodeURIComponent(projectId)}/canvas`);
    }
  }, [projectId, readyWorkspace, studio.setSelectedGraphObjectIds, workspaceScope]);
  useEffect(() => {
    const taskId = pendingTraceTaskIdRef.current;
    if (taskId === null || visibleGenerationPlanDetail === null) return;
    const task = visibleGenerationPlanDetail.tasks.find((candidate) => candidate.id === taskId);
    if (task === undefined) return;
    pendingTraceTaskIdRef.current = null;
    focusGenerationTaskOnCanvas(task);
  }, [focusGenerationTaskOnCanvas, visibleGenerationPlanDetail]);
  const projectForHeader = load.status === "ready" ? load.project : null;
  const projectHeaderActions = useProjectHeaderActions({
    api,
    projectId,
    projectName: projectForHeader?.name ?? "",
    projectPath: projectForHeader?.projectPath,
    analysisPrompt: projectForHeader === null ? null : buildProjectAnalysisPrompt(projectForHeader),
    enabled: projectForHeader !== null,
    onRenamed: () => {
      studio.retry();
      toast("Project renamed.");
    },
    onDeleted: () => navigate("/"),
    toast,
  });

  if (load.status === "loading") {
    return <RouteLoading scope={artifactScope ? "artifact" : resourceScope ? "resource" : "canvas"} />;
  }
  if (load.status === "error") {
    return (
      <section role="alert" className="relative grid h-full min-h-0 w-full place-items-center bg-background px-6 text-center">
        <StudioDragRegion />
        <div className="max-w-sm">
          <h1 className="text-sm font-medium text-foreground">Couldn't open this workspace</h1>
          <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{load.message}</p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <Button size="sm" onClick={studio.retry}>Try again</Button>
            <Button size="sm" variant="outline" onClick={() => navigate("/")}>Back to projects</Button>
          </div>
        </div>
      </section>
    );
  }
  if (load.status === "prototype") {
    const LegacyFallback = legacyFallback;
    return <LegacyFallback projectId={projectId} onOpenSettings={onOpenSettings} />;
  }

  const selectableStudioAgents = selectableAgents(agents);
  const selectedStudioAgent = agents.find((candidate) => candidate.command === studioAgent);
  const noSelectableAgentReason = agentsProvided
    && !agentsLoading
    && selectableStudioAgents.length === 0
    ? "No Agent is available. Install or sign in to one, then rescan agents."
    : null;
  const agentCatalogError = selectableStudioAgents.length === 0 ? agentsError : null;
  const agentCapabilityPending = agentsProvided && (
    agentsLoading
    || settingsLoadStatus === "loading"
    || (
      settingsLoadStatus === "ready"
      && selectableStudioAgents.length > 0
      && (
        settingsAgent === null
        || studioAgent.length === 0
        || (!agentSettingsReady && agentSettingsError === null)
      )
    )
  );
  const agentSubmissionBlockedReason = agentCapabilityPending
    ? "Checking Agent availability…"
    : settingsLoadError ?? agentSettingsError ?? designSystemError ?? agentCatalogError ?? noSelectableAgentReason ?? (
        agentsProvided
          ? agentAvailabilityReason(selectedStudioAgent)
          : null
      );
  const artifactHeadRevisionId = artifactId === null
    ? null
    : load.workspace.activeSnapshot.artifactRevisions[artifactId] ?? null;
  const artifactReadOnlyRoute = artifactRevisionId !== null || artifactCandidate !== null;
  const activeResource = resourceEditor.load.status === "ready" ? resourceEditor.load.resource : null;
  const artifactAgentAvailable = artifactScope && activeArtifact !== null
    && artifactHeadRevisionId !== null && !artifactReadOnlyRoute;
  const resourceAgentAvailable = resourceScope && activeResource !== null
    && resourceHeadRevisionId !== null && resourceRevisionId === null;
  const artifactKindLabel = activeArtifact?.kind === "component" ? "Component" : activeArtifact?.kind === "page" ? "Page" : "Artifact";
  const resourceKindLabel = resourceScopeLabel(activeResource?.kind);
  const contextLabel = workspaceScope
    ? `${load.workspace.artifacts.length} ${load.workspace.artifacts.length === 1 ? "artifact" : "artifacts"}`
    : artifactScope
      ? `${artifactKindLabel} · ${
          artifactCandidate !== null
            ? "Generation candidate"
            : artifactEditor.selection ? "1 selected element" : "artifact context"
        }`
      : `${resourceKindLabel} · ${resourceRevisionId === null ? "current context" : "pinned Revision"}`;
  const agentTitle = workspaceScope ? "Workspace Agent" : artifactScope ? "Artifact Agent" : "Resource Agent";
  const openResourceRevision = (nextResourceId: string, revisionId: string): void => {
    navigate(`/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(nextResourceId)}/revisions/${encodeURIComponent(revisionId)}`);
  };
  const toggleWorkspacePlanPanel = (): void => {
    setWorkspaceRightPanel((current) => current === "plan" ? null : "plan");
  };
  const canPresentFlow = presentablePrototypeFlowPages(load.workspace.activeSnapshot).length > 0;
  const main = workspaceScope && prototypeFlowSession !== null
    ? (
        <PrototypeFlowViewer
          projectId={projectId}
          session={prototypeFlowSession}
          activeSnapshotId={load.workspace.activeSnapshot.id}
          onClose={() => {
            restorePresentFlowFocusRef.current = true;
            setPrototypeFlowSession(null);
          }}
        />
      )
    : workspaceScope
    ? (
        <Suspense fallback={<ProjectCanvasLoading />}>
          <ProjectCanvas
            projectId={projectId}
            projectName={load.project.name}
            graph={load.workspace.graph}
            layout={load.workspace.layout}
            viewport={studio.viewport}
            artifactRevisionIds={load.workspace.activeSnapshot.artifactRevisions}
            artifactRevisionQualityStates={artifactRevisionQualityStates}
            resourceRevisionStates={resourceRevisionStates}
            artifactGenerationStates={generationTargetStates.artifacts}
            resourceGenerationStates={generationTargetStates.resources}
            selectedNodeIds={studio.selectedGraphObjectIds}
            onSelectionChange={studio.setSelectedGraphObjectIds}
            onViewportChange={studio.setViewport}
            onSaveLayout={studio.saveLayout}
            onApplyGraphCommands={studio.applyGraphCommands}
            onOpenArtifact={(nextArtifactId) => navigate(`/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(nextArtifactId)}`)}
            onOpenResource={(nextResourceId, revisionId) => navigate(revisionId === null
              ? `/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(nextResourceId)}`
              : `/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(nextResourceId)}/revisions/${encodeURIComponent(revisionId)}`)}
            onPresentFlow={canPresentFlow
              ? () => setPrototypeFlowSession(createPrototypeFlowSession(
                  load.workspace.activeSnapshot,
                  studio.selectedGraphObjectIds,
                  load.workspace.revisions,
                ))
              : undefined}
            presentFlowButtonRef={presentFlowButtonRef}
            planPanelAvailable
            planPanelOpen={workspaceRightPanel === "plan"}
            onTogglePlanPanel={toggleWorkspacePlanPanel}
            planPanelButtonRef={planPanelButtonRef}
            exportSourceUrl={api.exportUrl(projectId)}
            exportFullUrl={api.exportUrl(projectId, "full")}
            onRenameProject={projectHeaderActions.startRename}
            onOpenProjectInFinder={projectHeaderActions.openInFinder}
            canOpenProjectInFinder={projectHeaderActions.canOpenInFinder}
            onDeleteProject={projectHeaderActions.deleteProject}
            onCopyAnalysisPrompt={projectHeaderActions.copyAnalysisPrompt}
            onOpenSettings={() => onOpenSettings()}
            proposal={reviewableProposal?.proposal ?? null}
            proposalDiff={reviewableProposal?.diff ?? null}
            proposalFocus={studio.proposalFocus}
          />
        </Suspense>
      )
    : artifactScope
      ? (
          <ArtifactEditorSurface
            editor={artifactEditor}
            onBack={() => navigate(`/projects/${encodeURIComponent(projectId)}/canvas`)}
            onReturnToHead={() => navigate(`/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId!)}`)}
            onViewRevision={(revisionId) => navigate(
              `/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId!)}/revisions/${encodeURIComponent(revisionId)}`,
            )}
            onVersionPublished={() => {
              navigate(`/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId!)}`);
              studio.retry();
            }}
          />
        )
      : activeResource?.kind === "research" ? (
          <ResearchResourceViewer
            projectId={projectId}
            resourceId={resourceId!}
            requestedRevisionId={resourceRevisionId}
            workspace={load.workspace}
            agentCommand={studioAgent}
            model={studioModel}
            agentSettingsReady={agentSettingsReady && agentSubmissionBlockedReason === null}
            afterContextSettings={afterContextSettings}
            onBack={() => navigate(`/projects/${encodeURIComponent(projectId)}/canvas`)}
            onOpenRevision={(revisionId) => openResourceRevision(resourceId!, revisionId)}
            onReturnToHead={() => navigate(`/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId!)}`)}
            onPlanCreated={(planId) => {
              setResourceIntentPlanId(planId);
              setScopedInspectorMode("plan");
              studio.reconcileGenerationPublication();
            }}
            onWorkspaceChanged={studio.reconcileGenerationPublication}
            generationState={generationTargetStates.resources[resourceId!] ?? null}
            onOpenPlan={observedGenerationPlanId === null ? undefined : () => setScopedInspectorMode("plan")}
          />
        ) : (
          <ResourceEditorSurface
            editor={resourceEditor}
            projectId={projectId}
            generationState={generationTargetStates.resources[resourceId!] ?? null}
            onOpenPlan={observedGenerationPlanId === null ? undefined : () => setScopedInspectorMode("plan")}
            onBack={() => navigate(`/projects/${encodeURIComponent(projectId)}/canvas`)}
            onOpenRevision={(revisionId) => openResourceRevision(resourceId!, revisionId)}
            onReturnToHead={() => navigate(`/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId!)}`)}
          />
        );
  const preferredGenerationPlanId = workspaceScope
    ? workspacePlanId ?? approvedPlanFromReview
    : resourceIntentPlanId ?? scopedGenerationPlanId ?? approvedPlanFromReview ?? workspacePlanId;
  const openAgentTrace = (entry: ProjectedAgentTranscriptEntry): void => {
    const planId = entry.trace?.planId ?? entry.planId;
    if (planId === undefined) {
      if (entry.proposalId !== undefined && studio.openProposalReview(entry.proposalId)) {
        setWorkspaceRightPanel("proposal");
        requestAnimationFrame(() => document.getElementById("workspace-proposal-review-title")?.focus());
      }
      return;
    }
    pendingTraceTaskIdRef.current = entry.trace?.taskId ?? entry.taskId ?? null;
    setViewedPlanDetail(null);
    setWorkspacePlanDetail(null);
    if (workspaceScope) {
      setWorkspacePlanId(planId);
      setWorkspaceRightPanel("plan");
    } else {
      setResourceIntentPlanId(planId);
      setScopedInspectorMode("plan");
    }
  };
  const proposalReviewTerminal = studio.proposalReview.status === "approved"
    || studio.proposalReview.status === "rejected"
    || studio.proposalReview.status === "superseded";
  const proposalReviewOpen = workspaceScope
    ? workspaceRightPanel === "proposal" && studio.proposalReview.status !== "idle"
    : studio.proposalReview.status !== "idle"
      && !proposalReviewTerminal;
  const generationPlanOpen = workspaceScope
    ? workspaceRightPanel === "plan"
    : !proposalReviewOpen
      && preferredGenerationPlanId !== null
      && scopedInspectorMode === "plan";
  const inspector = proposalReviewOpen ? (
    <ProposalReviewPanel
      review={studio.proposalReview}
      focusedChangeKey={studio.focusedProposalChangeKey}
      onEdit={studio.editProposal}
      onRenameNode={studio.renameProposalNode}
      onRevert={studio.revertProposalChange}
      onFocusItem={(changeKey) => {
        studio.focusProposalChange(changeKey);
        if (!workspaceScope) navigate(`/projects/${encodeURIComponent(projectId)}/canvas`);
      }}
      onApprove={studio.approveProposal}
      onReject={studio.rejectProposal}
      onClose={() => {
        studio.closeProposalReview();
        if (workspaceScope) {
          if (approvedPlanFromReview !== null) {
            setWorkspacePlanId(approvedPlanFromReview);
            setWorkspaceRightPanel("plan");
          } else {
            setWorkspaceRightPanel(null);
          }
        }
      }}
    />
  ) : generationPlanOpen ? (
    <GenerationPlanInspector
      projectId={projectId}
      preferredPlanId={preferredGenerationPlanId}
      authoritativeDetail={workspacePlanDetail}
      targetLabels={generationPlanTargetLabels}
      onFocusTask={focusGenerationTaskOnCanvas}
      onDetailChange={handleGenerationPlanDetailChange}
      onWorkspaceChanged={studio.reconcileGenerationPublication}
      onClose={() => {
        if (workspaceScope) {
          setWorkspaceRightPanel(null);
          requestAnimationFrame(() => planPanelButtonRef.current?.focus());
        } else {
          setScopedInspectorMode("inspector");
        }
      }}
    />
  ) : resourceScope ? (
    <ResourceInspector editor={resourceEditor} />
  ) : (
    <ArtifactInspector editor={artifactEditor} />
  );

  const artifactAgentStatus = artifactCandidate !== null
    ? "Artifact Agent is read-only while reviewing a Generation candidate."
    : artifactRevisionId !== null
      ? "Artifact Agent is read-only while viewing a pinned Revision."
      : artifactId !== null && artifactHeadRevisionId === null
        ? "Artifact Agent needs an active Revision before work can be queued."
        : null;
  const resourceAgentStatus = resourceRevisionId !== null
    ? "Resource Agent is read-only while viewing a pinned Revision."
    : resourceId !== null && resourceHeadRevisionId === null
      ? "Resource Agent needs an active Revision before work can be queued."
      : null;
  const planIsQueued = (artifactScope && studio.artifactAgentReceipt !== null)
    || (resourceScope && studio.resourceAgentReceipt !== null);
  const activityStatus = visibleGenerationPlanDetail === null
    ? null
    : generationPlanActivityStatus(visibleGenerationPlanDetail);
  const planAffordance = preferredGenerationPlanId !== null || visibleGenerationPlanDetail !== null
      ? {
          open: generationPlanOpen,
          planId: preferredGenerationPlanId ?? visibleGenerationPlanDetail?.plan.id,
          status: activityStatus === null
          ? planIsQueued ? "Queued" : "Loading build plan"
          : activityStatus,
        onToggle: workspaceScope
          ? toggleWorkspacePlanPanel
          : () => setScopedInspectorMode((current) => current === "plan" ? "inspector" : "plan"),
      }
    : null;
  const proposalGeneration = reviewableProposal?.proposal.generation.kind === "workspace-generation"
    ? reviewableProposal.proposal.generation
    : null;
  const proposalBuildChangeCount = proposalGeneration === null
    ? 0
    : proposalGeneration.artifactPlans.length
      + proposalGeneration.resourceOperations.filter((operation) => operation.operation !== "reuse").length;
  const proposalAffordance = workspaceScope && reviewableProposal !== null
    ? {
        summary: reviewableProposal.proposal.rationale.trim() || "Review the proposed workspace changes.",
        changeCount: proposalBuildChangeCount || reviewableProposal.diff.reviewItems.length,
        onOpen: () => {
          setWorkspaceRightPanel("proposal");
          requestAnimationFrame(() => document.getElementById("workspace-proposal-review-title")?.focus());
        },
      }
    : undefined;
  const proposalReviewError = workspaceScope && studio.proposalReview.status === "error"
    ? studio.proposalReview.message
    : null;

  const persistOwnedContext = async (input: {
    title: string;
    kind: Exclude<WorkspaceResourceKind, "research" | "sharingan-capture">;
    source: ResourceRevisionOwnedSource;
    previewUrl?: string;
  }): Promise<void> => {
    const attachmentScopeKey = scopedInspectorScopeKey;
    setAttachingContext(true);
    clearAttachmentError(attachmentScopeKey);
    try {
      await studio.materializeAgentResourceContext(input);
    } catch (error) {
      const message = error instanceof Error && error.message.trim()
        ? error.message
        : "Couldn't save this Agent Context.";
      recordAttachmentError(attachmentScopeKey, message);
    } finally {
      setAttachingContext(false);
    }
  };

  return (
    <>
      <ProjectStudioShell
      agent={(
        <WorkspaceAgentPanel
          projectName={load.project.name}
          onBackHome={() => navigate("/")}
          draft={studio.workspaceAgentDraft}
          onDraftChange={studio.setWorkspaceAgentDraft}
          contextLabel={contextLabel}
          title={agentTitle}
          draftLabel={`${agentTitle} draft`}
          placeholder={workspaceScope
            ? "Plan a page, component, or workspace change…"
            : artifactScope
              ? "Describe a focused change to this artifact or selected element…"
              : "Describe how this Resource should inform or change the design…"}
          scopeLabel={workspaceScope ? "Workspace" : artifactScope ? artifactKindLabel : resourceKindLabel}
          onSubmit={workspaceScope
            ? () => afterContextSettings(async () => {
                clearAttachmentError(scopedInspectorScopeKey);
                if (initialTurnProcessingRef.current) {
                  recordAttachmentError(
                    "workspace",
                    "Initial references are still being attached. Submit after this context is ready.",
                  );
                  return;
                }
                const pendingTurn = peekPendingDesignWorkspaceTurn(projectId);
                initialTurnRef.current = pendingTurn;
                let reservedTurnId: string | undefined;
                if (pendingTurn !== null) {
                  initialTurnAttemptedRef.current = true;
                }
                const queued = await studio.submitWorkspaceAgentPrompt({
                  agentCommand: studioAgent,
                  model: studioModel || undefined,
                  ...(pendingTurn === null ? {} : {
                    reserveTurn: async (facts) => {
                      const expectedActiveTurnId = pendingTurn.supersededByTurnId ?? pendingTurn.turnId;
                      const contextItems: PendingDesignWorkspaceRecoveryContextItem[] = facts.contextItems
                        .map(({ previewUrl: _previewUrl, type: _type, ...item }) => item);
                      const claim = await claimPendingTurnReplacement({
                        projectId,
                        expectedActiveTurnId,
                        ...(studio.workspaceAgentOutbox?.turnId === expectedActiveTurnId
                          ? { activeRequestFingerprint: studio.workspaceAgentOutbox.fingerprint }
                          : {}),
                        reservation: {
                          ...facts,
                          contextItems,
                        },
                      });
                      if (claim.status !== "claimed" && claim.status !== "reused") {
                        initialTurnRef.current = peekPendingDesignWorkspaceTurn(projectId);
                        recordAttachmentError(
                          "workspace",
                          claim.status === "conflict"
                            ? "Another window replaced this recovery request. Review the current draft before submitting again."
                            : "Dezin couldn't durably save this recovery request. Free browser storage, then submit again.",
                        );
                        return null;
                      }
                      initialTurnRef.current = claim.turn;
                      reservedTurnId = claim.turnId;
                      return {
                        turnId: claim.turnId,
                        isCurrent: () => {
                          const current = peekPendingDesignWorkspaceTurn(projectId);
                          return current !== null
                            && current.turnId === claim.turn.turnId
                            && current.supersededByTurnId === claim.turnId
                            && current.recoveryRequest?.fingerprint === facts.fingerprint;
                        },
                      };
                    },
                  }),
                });
                if (queued) {
                  if (reservedTurnId !== undefined) reconcileCompletedInitialTurn(reservedTurnId);
                }
              })
            : artifactAgentAvailable
              ? () => afterContextSettings(() => {
                  clearAttachmentError(scopedInspectorScopeKey);
                  return studio.submitArtifactAgentPrompt({
                    artifactId,
                    baseRevisionId: artifactHeadRevisionId,
                    selection: artifactEditor.selection === null ? [] : [{
                      kind: "element",
                      id: artifactEditor.selection.locator.designNodeId,
                      revisionId: artifactEditor.selection.revisionId,
                    }],
                    agentCommand: studioAgent,
                    model: studioModel || undefined,
                  });
                })
              : resourceAgentAvailable
                ? () => afterContextSettings(() => {
                    clearAttachmentError(scopedInspectorScopeKey);
                    return studio.submitResourceAgentPrompt({
                      resourceId,
                      baseRevisionId: resourceHeadRevisionId,
                      agentCommand: studioAgent,
                      model: studioModel || undefined,
                    });
                  })
                : undefined}
          submitting={studio.agentTurnSubmitting}
          error={agentsError ?? settingsLoadError ?? attachmentError ?? proposalReviewError ?? (workspaceScope
            ? studio.workspaceAgentError
            : artifactScope
              ? studio.artifactAgentError
              : studio.resourceAgentError)}
          status={workspaceScope ? null : artifactScope ? artifactAgentStatus : resourceAgentStatus}
          planAffordance={planAffordance}
          proposalAffordance={proposalAffordance}
          submitLabel={workspaceScope ? "Create proposal" : artifactScope ? "Queue artifact edit" : "Queue resource task"}
          submittingLabel={workspaceScope
            ? "Creating a reviewable proposal…"
            : artifactScope
              ? "Queuing an exact artifact Task…"
              : "Queuing an exact Resource Task…"}
          contextItems={agentContextItems}
          onContextItemsChange={(items) => {
            const selectedIds = new Set(selectedContextItems.map((item) => item.id));
            studio.setAgentContextItems(items.flatMap((item): DaemonContextCard[] => (
              item.type === "context-ref" && !selectedIds.has(item.id) ? [item] : []
            )));
          }}
          onRemoveContextItem={(id) => {
            if (id.startsWith("selection:")) {
              artifactEditor.clearSelection();
              return;
            }
            if (id.startsWith("selection-node:")) {
              const nodeId = id.slice("selection-node:".length);
              studio.setSelectedGraphObjectIds((current) => current.filter((candidate) => candidate !== nodeId));
              return;
            }
            studio.removeAgentContextItem(id);
          }}
          transcript={projectedAgentTranscript}
          onOpenTrace={openAgentTrace}
          onOpenTraceOutput={(output) => navigate(output.kind === "artifact"
            ? `/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(output.targetId)}/revisions/${encodeURIComponent(output.revisionId)}`
            : `/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(output.targetId)}/revisions/${encodeURIComponent(output.revisionId)}`)}
          attaching={attachingContext || initialTurnProcessing}
          onAttachFiles={async (files) => {
            const attachmentScopeKey = scopedInspectorScopeKey;
            setAttachingContext(true);
            clearAttachmentError(attachmentScopeKey);
            try {
              for (const file of files) {
                const base64 = await fileBase64(file);
                const uploaded = await api.uploadRef(projectId, file.name, base64);
                await studio.materializeAgentResourceContext({
                  title: uploaded.name,
                  kind: "file",
                  source: { type: "uploaded-file", uploadedFileId: uploaded.path },
                  ...(file.type.startsWith("image/") ? { previewUrl: api.refUrl(projectId, uploaded.path) } : {}),
                });
              }
            } catch (error) {
              const message = error instanceof Error && error.message.trim() ? error.message : "Couldn't attach this file.";
              recordAttachmentError(attachmentScopeKey, message);
            } finally {
              setAttachingContext(false);
            }
          }}
          onReferenceMoodboard={(board) => void persistOwnedContext({
            title: board.name,
            kind: "moodboard",
            source: { type: "moodboard", moodboardId: board.id },
          })}
          onReferenceEffect={(effect) => void persistOwnedContext({
            title: effect.name,
            kind: "effect",
            source: { type: "effect", effectId: effect.id },
          })}
          workspaceReferences={workspaceReferenceCards.map((item) => ({
            id: item.id,
            label: item.title,
            detail: item.subtitle,
          }))}
          onReferenceWorkspaceItem={(id) => {
            const item = workspaceReferenceById.get(id);
            if (item) studio.addAgentContextItems([item]);
          }}
          agents={agents}
          agent={studioAgent}
          model={studioModel}
          onAgentChange={changeStudioAgent}
          onModelChange={changeStudioModel}
          onRescanAgents={rescanStudioAgents}
          submissionBlockedReason={agentSubmissionBlockedReason}
          submissionBlockedPending={agentCapabilityPending}
          designSystems={designSystems}
          designSystemId={designSystemId}
          designSystemInherited={projectDesignSystemId === null}
          defaultDesignSystemId={defaultDesignSystemId}
          designSystemSelectionStatus={designSystemSelectionStatus}
          onDesignSystemChange={changeDesignSystem}
          onUseDefaultDesignSystem={() => changeDesignSystem(null)}
          designSystemCatalogStatus={designSystemCatalogStatus}
          onRetryDesignSystems={refreshDesignSystems}
        />
      )}
      main={main}
      inspector={inspector}
      agentLabel={agentTitle}
      inspectorAvailable
      inspectorOpen={workspaceScope ? proposalReviewOpen || generationPlanOpen : true}
      inspectorLabel={proposalReviewOpen ? "Proposal review" : generationPlanOpen ? "Build plan" : "Inspector"}
      inspectorToggleLabel={proposalReviewOpen
        ? "proposal review"
        : generationPlanOpen
          ? "build plan"
          : resourceScope
            ? "resource inspector"
            : "artifact inspector"}
      narrowInspectorContentOwnsClose={proposalReviewOpen || generationPlanOpen}
      presentation={(artifactScope && artifactEditor.presentation)
        || (workspaceScope && prototypeFlowSession !== null)}
      />
      <ProjectRenameDialog controller={projectHeaderActions} />
    </>
  );
}
