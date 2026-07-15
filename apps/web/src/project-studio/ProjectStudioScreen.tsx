import { lazy, Suspense, type ComponentType, type ExoticComponent } from "react";
import { Button } from "../components/ui/index.ts";
import { navigate } from "../router.tsx";
import { ArtifactEditorSurface, useArtifactEditorController } from "./artifact/ArtifactEditorSurface.tsx";
import { ArtifactInspector } from "./artifact/ArtifactInspector.tsx";
import { ProjectStudioShell } from "./ProjectStudioShell.tsx";
import { ProposalReviewPanel } from "./proposal/ProposalReviewPanel.tsx";
import { useProjectStudio } from "./useProjectStudio.ts";
import { WorkspaceAgentPanel } from "./WorkspaceAgentPanel.tsx";

const ProjectCanvas = lazy(() => import("./canvas/ProjectCanvas.tsx").then((module) => ({ default: module.ProjectCanvas })));

interface LegacyWorkspaceProps {
  projectId: string;
  onOpenSettings: (section?: string) => void;
}

type LegacyWorkspaceComponent = ComponentType<LegacyWorkspaceProps> | ExoticComponent<LegacyWorkspaceProps>;

function StudioDragRegion() {
  return <div data-testid="project-studio-drag-region" aria-hidden className="app-drag absolute inset-x-0 top-0 z-10 h-11" />;
}

function RouteLoading({ artifact }: { artifact: boolean }) {
  const label = artifact ? "Loading artifact editor" : "Loading project canvas";
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

function InspectorPlaceholder({ selectedCount, zoom }: { selectedCount: number; zoom: number }) {
  return (
    <section className="flex h-full min-h-0 flex-col" aria-labelledby="studio-inspector-title">
      <header className="app-drag flex h-11 shrink-0 items-center border-b border-border px-3.5">
        <h2 id="studio-inspector-title" className="text-xs font-medium tracking-[-0.01em] text-foreground">Inspector</h2>
      </header>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 border-b border-border px-3.5 py-3 text-[11px]">
        <dt className="text-muted-foreground">Selection</dt>
        <dd className="font-medium tabular-nums text-foreground">{selectedCount || "None"}</dd>
        <dt className="text-muted-foreground">Zoom</dt>
        <dd className="font-medium tabular-nums text-foreground">{Math.round(zoom * 100)}%</dd>
      </dl>
      <p className="px-3.5 py-3 text-[10px] leading-4 text-muted-foreground">Properties follow the active canvas or artifact selection.</p>
    </section>
  );
}

export function ProjectStudioScreen({
  projectId,
  artifactId,
  legacyFallback,
  onOpenSettings,
}: {
  projectId: string;
  artifactId: string | null;
  legacyFallback: LegacyWorkspaceComponent;
  onOpenSettings: (section?: string) => void;
}) {
  const studio = useProjectStudio(projectId);
  const { load } = studio;
  const readyWorkspace = load.status === "ready" ? load.workspace : null;
  const activeArtifact = artifactId === null
    ? null
    : readyWorkspace?.artifacts.find((candidate) => candidate.id === artifactId) ?? null;
  const artifactEditor = useArtifactEditorController({
    projectId,
    artifactId,
    artifact: activeArtifact,
    tracks: readyWorkspace?.tracks.filter((track) => track.artifactId === artifactId) ?? [],
    revisions: readyWorkspace?.revisions.filter((revision) => revision.artifactId === artifactId) ?? [],
    activeRevisionId: artifactId === null ? null : readyWorkspace?.activeSnapshot.artifactRevisions[artifactId] ?? null,
    activeSnapshotId: readyWorkspace?.activeSnapshot.id ?? null,
    onArtifactPublished: studio.reconcileArtifactPublication,
  });

  if (load.status === "loading") return <RouteLoading artifact={artifactId !== null} />;
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

  const artifactScope = activeArtifact?.kind === "component" ? "Component" : activeArtifact?.kind === "page" ? "Page" : "Artifact";
  const contextLabel = artifactId === null
    ? `${load.workspace.artifacts.length} ${load.workspace.artifacts.length === 1 ? "artifact" : "artifacts"}`
    : `${artifactScope} · ${artifactEditor.selection ? "1 selected element" : "artifact context"}`;
  const agentTitle = artifactId === null ? "Workspace Agent" : "Artifact Agent";
  const reviewableProposal = studio.proposalReview.status === "draft"
    || studio.proposalReview.status === "saving"
    || studio.proposalReview.status === "validation-error"
    || studio.proposalReview.status === "conflicted"
    ? studio.proposalReview
    : null;
  const main = artifactId === null
    ? (
        <Suspense fallback={<ProjectCanvasLoading />}>
          <ProjectCanvas
            projectId={projectId}
            projectName={load.project.name}
            graph={load.workspace.graph}
            layout={load.workspace.layout}
            viewport={studio.viewport}
            artifactRevisionIds={load.workspace.activeSnapshot.artifactRevisions}
            selectedNodeIds={studio.selectedGraphObjectIds}
            onSelectionChange={studio.setSelectedGraphObjectIds}
            onViewportChange={studio.setViewport}
            onSaveLayout={studio.saveLayout}
            onApplyGraphCommands={studio.applyGraphCommands}
            onOpenArtifact={(nextArtifactId) => navigate(`/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(nextArtifactId)}`)}
            proposal={reviewableProposal?.proposal ?? null}
            proposalDiff={reviewableProposal?.diff ?? null}
            proposalFocus={studio.proposalFocus}
          />
        </Suspense>
      )
    : (
        <ArtifactEditorSurface
          editor={artifactEditor}
          onBack={() => navigate(`/projects/${encodeURIComponent(projectId)}/canvas`)}
        />
      );
  const proposalReviewOpen = studio.proposalReview.status !== "idle";
  const inspector = proposalReviewOpen ? (
        <ProposalReviewPanel
          review={studio.proposalReview}
          focusedChangeKey={studio.focusedProposalChangeKey}
          onEdit={studio.editProposal}
          onRenameNode={studio.renameProposalNode}
          onRevert={studio.revertProposalChange}
          onFocusItem={(changeKey) => {
            studio.focusProposalChange(changeKey);
            if (artifactId !== null) navigate(`/projects/${encodeURIComponent(projectId)}/canvas`);
          }}
          onApprove={studio.approveProposal}
          onReject={studio.rejectProposal}
          onClose={studio.closeProposalReview}
        />
      ) : artifactId !== null
    ? <ArtifactInspector editor={artifactEditor} />
    : (
        <InspectorPlaceholder selectedCount={studio.selectedGraphObjectIds.length} zoom={studio.viewport.zoom} />
      );

  return (
    <ProjectStudioShell
      agent={(
        <WorkspaceAgentPanel
          draft={studio.workspaceAgentDraft}
          onDraftChange={studio.setWorkspaceAgentDraft}
          contextLabel={contextLabel}
          title={agentTitle}
          draftLabel={`${agentTitle} draft`}
          placeholder={artifactId === null
            ? "Plan a page, component, or workspace change…"
            : "Describe a focused change to this artifact or selected element…"}
          scopeLabel={artifactId === null ? "Workspace" : artifactScope}
          contextItems={artifactId !== null && artifactEditor.selection ? [{
            id: artifactEditor.selection.id,
            label: artifactEditor.selection.label,
            kind: "Selected element",
            projectId: artifactEditor.selection.projectId,
            artifactId: artifactEditor.selection.artifactId,
            revisionId: artifactEditor.selection.revisionId,
            targetKey: artifactEditor.selection.targetKey,
            assemblyHash: artifactEditor.selection.assemblyHash,
            frameId: artifactEditor.selection.frameId,
            locator: artifactEditor.selection.locator,
          }] : []}
        />
      )}
      main={main}
      inspector={inspector}
      agentLabel={agentTitle}
      inspectorOpen={artifactId !== null || proposalReviewOpen}
      inspectorLabel="Inspector"
      inspectorToggleLabel={proposalReviewOpen ? "proposal review" : "artifact inspector"}
      presentation={artifactId !== null && artifactEditor.presentation}
    />
  );
}
