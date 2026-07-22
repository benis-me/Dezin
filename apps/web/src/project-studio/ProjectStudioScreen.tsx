import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ExoticComponent } from "react";

import { type AgentComposerContextItem } from "../components/AgentComposerContext.tsx";
import { useToast } from "../components/Toast.tsx";
import { Button } from "../components/ui/index.ts";
import { useApi } from "../lib/api-context.tsx";
import type {
  Resource,
  ResourceRevision,
  ResourceRevisionOwnedSource,
  WorkspaceResourceKind,
} from "../lib/api.ts";
import { navigate } from "../router.tsx";
import { ArtifactEditorSurface, useArtifactEditorController } from "./artifact/ArtifactEditorSurface.tsx";
import { ArtifactInspector } from "./artifact/ArtifactInspector.tsx";
import { GenerationPlanInspector } from "./generation/GenerationPlanPanel.tsx";
import {
  createPrototypeFlowSession,
  presentablePrototypeFlowPages,
  type PrototypeFlowSession,
} from "./flow/prototype-flow.ts";
import { ProjectStudioShell } from "./ProjectStudioShell.tsx";
import { ProposalReviewPanel } from "./proposal/ProposalReviewPanel.tsx";
import { ResearchResourceViewer } from "./research/ResearchResourceViewer.tsx";
import {
  ResourceEditorSurface,
  ResourceInspector,
  useResourceEditorController,
} from "./resource/ResourceEditorSurface.tsx";
import { useProjectStudio } from "./useProjectStudio.ts";
import { WorkspaceAgentPanel } from "./WorkspaceAgentPanel.tsx";

const ProjectCanvas = lazy(() => import("./canvas/ProjectCanvas.tsx").then((module) => ({ default: module.ProjectCanvas })));
const PrototypeFlowViewer = lazy(() => import("./flow/PrototypeFlowViewer.tsx").then((module) => ({ default: module.PrototypeFlowViewer })));

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

const EMPTY_CANVAS_RESOURCE_REVISION_STATES: Readonly<Record<string, CanvasResourceRevisionState>> = {};

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
  resourceId = null,
  resourceRevisionId = null,
  legacyFallback,
  onOpenSettings,
}: {
  projectId: string;
  artifactId: string | null;
  artifactRevisionId?: string | null;
  resourceId?: string | null;
  resourceRevisionId?: string | null;
  legacyFallback: LegacyWorkspaceComponent;
  onOpenSettings: (section?: string) => void;
}) {
  const api = useApi();
  const { toast } = useToast();
  const studio = useProjectStudio(projectId, artifactId, resourceId);
  const { load } = studio;
  const readyWorkspace = load.status === "ready" ? load.workspace : null;
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
    target: artifactRevisionId === null
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
  const [dismissedWorkspacePlanId, setDismissedWorkspacePlanId] = useState<string | null>(null);
  const [prototypeFlowSession, setPrototypeFlowSession] = useState<PrototypeFlowSession | null>(null);
  const presentFlowButtonRef = useRef<HTMLButtonElement | null>(null);
  const restorePresentFlowFocusRef = useRef(false);
  const [scopedInspectorMode, setScopedInspectorMode] = useState<"inspector" | "plan">("inspector");
  const scopedInspectorScopeKey = artifactId !== null
    ? `artifact:${artifactId}`
    : resourceId !== null
      ? `resource:${resourceId}`
      : "workspace";
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
  const scopedGenerationPlanId = artifactId !== null && artifactRevisionId === null
    ? studio.artifactAgentPlanId
    : resourceId !== null && resourceRevisionId === null
      ? studio.resourceAgentPlanId
      : null;
  const scopedAgentSubmitting = artifactId !== null
    ? studio.artifactAgentSubmitting
    : resourceId !== null
      ? studio.resourceAgentSubmitting
      : false;
  const scopedAgentReceiptId = artifactId !== null
    ? studio.artifactAgentReceipt?.task.id ?? null
    : resourceId !== null
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
    if (approvedPlanFromReview === null) return;
    setWorkspacePlanId(approvedPlanFromReview);
    setDismissedWorkspacePlanId(null);
  }, [approvedPlanFromReview]);

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
    if (tracked.wasSubmitting && !scopedAgentSubmitting
      && scopedGenerationPlanId !== null && scopedAgentReceiptId !== null
      && scopedAgentReceiptId !== tracked.receiptAtStart) {
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

  if (load.status === "loading") {
    return <RouteLoading scope={artifactId !== null ? "artifact" : resourceId !== null ? "resource" : "canvas"} />;
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

  const workspaceScope = artifactId === null && resourceId === null;
  const artifactScope = artifactId !== null;
  const resourceScope = resourceId !== null;
  const artifactHeadRevisionId = artifactId === null
    ? null
    : load.workspace.activeSnapshot.artifactRevisions[artifactId] ?? null;
  const activeResource = resourceEditor.load.status === "ready" ? resourceEditor.load.resource : null;
  const artifactAgentAvailable = artifactScope && activeArtifact !== null
    && artifactHeadRevisionId !== null && artifactRevisionId === null;
  const resourceAgentAvailable = resourceScope && activeResource !== null
    && resourceHeadRevisionId !== null && resourceRevisionId === null;
  const artifactKindLabel = activeArtifact?.kind === "component" ? "Component" : activeArtifact?.kind === "page" ? "Page" : "Artifact";
  const resourceKindLabel = resourceScopeLabel(activeResource?.kind);
  const contextLabel = workspaceScope
    ? `${load.workspace.artifacts.length} ${load.workspace.artifacts.length === 1 ? "artifact" : "artifacts"}`
    : artifactScope
      ? `${artifactKindLabel} · ${artifactEditor.selection ? "1 selected element" : "artifact context"}`
      : `${resourceKindLabel} · ${resourceRevisionId === null ? "current context" : "pinned Revision"}`;
  const agentTitle = workspaceScope ? "Workspace Agent" : artifactScope ? "Artifact Agent" : "Resource Agent";
  const reviewableProposal = studio.proposalReview.status === "draft"
    || studio.proposalReview.status === "saving"
    || studio.proposalReview.status === "validation-error"
    || studio.proposalReview.status === "conflicted"
    ? studio.proposalReview
    : null;
  const openResourceRevision = (nextResourceId: string, revisionId: string): void => {
    navigate(`/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(nextResourceId)}/revisions/${encodeURIComponent(revisionId)}`);
  };
  const canPresentFlow = presentablePrototypeFlowPages(load.workspace.activeSnapshot).length > 0;
  const main = workspaceScope && prototypeFlowSession !== null
    ? (
        <Suspense fallback={<ProjectCanvasLoading />}>
          <PrototypeFlowViewer
            projectId={projectId}
            session={prototypeFlowSession}
            onClose={() => {
              restorePresentFlowFocusRef.current = true;
              setPrototypeFlowSession(null);
            }}
          />
        </Suspense>
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
            resourceRevisionStates={resourceRevisionStates}
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
            onBack={() => navigate(`/projects/${encodeURIComponent(projectId)}/canvas`)}
            onOpenRevision={(revisionId) => openResourceRevision(resourceId!, revisionId)}
            onReturnToHead={() => navigate(`/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId!)}`)}
            onPlanCreated={(planId) => {
              setResourceIntentPlanId(planId);
              setScopedInspectorMode("plan");
              studio.reconcileGenerationPublication();
            }}
            onWorkspaceChanged={studio.reconcileGenerationPublication}
          />
        ) : (
          <ResourceEditorSurface
            editor={resourceEditor}
            projectId={projectId}
            onBack={() => navigate(`/projects/${encodeURIComponent(projectId)}/canvas`)}
            onOpenRevision={(revisionId) => openResourceRevision(resourceId!, revisionId)}
            onReturnToHead={() => navigate(`/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId!)}`)}
          />
        );
  const approvedGenerationPlanId = studio.proposalReview.status === "approved"
    ? studio.proposalReview.plan?.id ?? null
    : null;
  const preferredGenerationPlanId = workspaceScope
    ? workspacePlanId ?? approvedGenerationPlanId
    : resourceIntentPlanId ?? scopedGenerationPlanId ?? approvedGenerationPlanId;
  const proposalReviewOpen = studio.proposalReview.status !== "idle"
    && !(studio.proposalReview.status === "approved"
      && studio.proposalReview.plan?.status === "compile-failed");
  const generationPlanOpen = !proposalReviewOpen
    && preferredGenerationPlanId !== null
    && (workspaceScope
      ? dismissedWorkspacePlanId !== preferredGenerationPlanId
      : scopedInspectorMode === "plan");
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
      onClose={studio.closeProposalReview}
    />
  ) : generationPlanOpen ? (
    <GenerationPlanInspector
      projectId={projectId}
      preferredPlanId={preferredGenerationPlanId}
      onWorkspaceChanged={studio.reconcileGenerationPublication}
      onClose={() => {
        if (workspaceScope) setDismissedWorkspacePlanId(preferredGenerationPlanId);
        else setScopedInspectorMode("inspector");
      }}
    />
  ) : resourceScope ? (
    <ResourceInspector editor={resourceEditor} />
  ) : (
    <ArtifactInspector editor={artifactEditor} />
  );

  const artifactAgentStatus = artifactRevisionId !== null
    ? "Artifact Agent is read-only while viewing a pinned Revision."
    : studio.artifactAgentReceipt !== null
      ? `Queued · Plan ${studio.artifactAgentReceipt.task.planId}`
      : studio.artifactAgentPlanId !== null
        ? `Recent · Plan ${studio.artifactAgentPlanId}`
        : artifactId !== null && artifactHeadRevisionId === null
          ? "Artifact Agent needs an active Revision before work can be queued."
          : null;
  const resourceAgentStatus = resourceRevisionId !== null
    ? "Resource Agent is read-only while viewing a pinned Revision."
    : studio.resourceAgentReceipt !== null
      ? `Queued · Plan ${studio.resourceAgentReceipt.task.planId}`
      : studio.resourceAgentPlanId !== null
        ? `Recent · Plan ${studio.resourceAgentPlanId}`
        : resourceId !== null && resourceHeadRevisionId === null
          ? "Resource Agent needs an active Revision before work can be queued."
          : null;
  const workspaceAgentStatus = preferredGenerationPlanId === null
    ? null
    : `Recent · Plan ${preferredGenerationPlanId}`;

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
      toast(message, { variant: "error" });
    } finally {
      setAttachingContext(false);
    }
  };

  return (
    <ProjectStudioShell
      agent={(
        <WorkspaceAgentPanel
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
            ? () => {
                clearAttachmentError(scopedInspectorScopeKey);
                return studio.submitWorkspaceAgentPrompt();
              }
            : artifactAgentAvailable
              ? () => {
                  clearAttachmentError(scopedInspectorScopeKey);
                  return studio.submitArtifactAgentPrompt({
                    artifactId,
                    baseRevisionId: artifactHeadRevisionId,
                    selection: artifactEditor.selection === null ? [] : [{
                      kind: "element",
                      id: artifactEditor.selection.locator.designNodeId,
                      revisionId: artifactEditor.selection.revisionId,
                    }],
                  });
                }
              : resourceAgentAvailable
                ? () => {
                    clearAttachmentError(scopedInspectorScopeKey);
                    return studio.submitResourceAgentPrompt({
                      resourceId,
                      baseRevisionId: resourceHeadRevisionId,
                    });
                  }
                : undefined}
          submitting={studio.agentTurnSubmitting}
          error={attachmentError ?? (workspaceScope
            ? studio.workspaceAgentError
            : artifactScope
              ? studio.artifactAgentError
              : studio.resourceAgentError)}
          status={workspaceScope ? workspaceAgentStatus : artifactScope ? artifactAgentStatus : resourceAgentStatus}
          onStatusClick={workspaceScope
            ? preferredGenerationPlanId !== null && !proposalReviewOpen && !generationPlanOpen
              ? () => setDismissedWorkspacePlanId(null)
              : undefined
            : scopedGenerationPlanId !== null && scopedInspectorMode === "inspector"
              ? () => setScopedInspectorMode("plan")
              : undefined}
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
          transcript={studio.agentTranscript}
          attaching={attachingContext}
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
              toast(message, { variant: "error" });
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
        />
      )}
      main={main}
      inspector={inspector}
      agentLabel={agentTitle}
      inspectorOpen={!workspaceScope || proposalReviewOpen || generationPlanOpen}
      inspectorLabel={generationPlanOpen ? "Build plan" : "Inspector"}
      inspectorToggleLabel={proposalReviewOpen
        ? "proposal review"
        : generationPlanOpen
          ? "build plan"
          : resourceScope
            ? "resource inspector"
            : "artifact inspector"}
      presentation={artifactScope && artifactEditor.presentation}
    />
  );
}
