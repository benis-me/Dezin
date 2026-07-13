import type { ComponentType, ExoticComponent } from "react";
import { Button } from "../components/ui/index.ts";
import type { WorkspaceArtifact } from "../lib/api.ts";
import { navigate } from "../router.tsx";
import { ProjectStudioShell } from "./ProjectStudioShell.tsx";
import { useProjectStudio } from "./useProjectStudio.ts";
import { WorkspaceAgentPanel } from "./WorkspaceAgentPanel.tsx";

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

function ProjectCanvasPlaceholder({ projectName, artifactCount }: { projectName: string; artifactCount: number }) {
  return (
    <section role="region" aria-label="Project canvas" className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="app-drag flex h-11 shrink-0 items-center justify-between border-b border-border px-3.5">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-xs font-medium tracking-[-0.01em] text-foreground">{projectName}</h1>
          <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">Canvas</span>
        </div>
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {artifactCount} {artifactCount === 1 ? "artifact" : "artifacts"}
        </span>
      </header>
      <div className="dz-canvas relative min-h-0 flex-1 overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,var(--border)_1px,transparent_1px)] bg-[size:24px_24px] opacity-25" aria-hidden />
        <div className="relative grid h-full place-items-center px-8 text-center">
          <div className="max-w-xs rounded-lg border border-border bg-card/90 px-4 py-3 shadow-sm backdrop-blur-sm">
            <p className="text-xs font-medium text-foreground">Workspace graph ready</p>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">Canvas tools and artifact nodes are added in the next workspace stage.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function ArtifactPlaceholder({ artifactId, artifact }: { artifactId: string; artifact: WorkspaceArtifact | null }) {
  return (
    <section role="region" aria-label="Artifact editor" className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="app-drag flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border px-3.5">
        <div className="min-w-0">
          <h1 className="truncate text-xs font-medium tracking-[-0.01em] text-foreground">
            {artifact?.name ?? "Artifact unavailable"}
          </h1>
          <p className="mt-0.5 truncate font-mono text-[9px] text-muted-foreground">{artifactId}</p>
        </div>
        <span className="shrink-0 rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium capitalize text-muted-foreground">
          {artifact?.kind ?? "artifact"}
        </span>
      </header>
      <div className="dz-canvas grid min-h-0 flex-1 place-items-center px-8 text-center">
        <div className="max-w-xs rounded-lg border border-border bg-card/90 px-4 py-3 shadow-sm">
          <p className="text-xs font-medium text-foreground">
            {artifact ? "Artifact editor ready" : "Artifact isn't in the active workspace"}
          </p>
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">The focused editing surface arrives with artifact tools.</p>
        </div>
      </div>
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

  const artifact = artifactId === null
    ? null
    : load.workspace.artifacts.find((candidate) => candidate.id === artifactId) ?? null;
  const contextLabel = `${load.workspace.artifacts.length} ${load.workspace.artifacts.length === 1 ? "artifact" : "artifacts"}`;
  const main = artifactId === null
    ? <ProjectCanvasPlaceholder projectName={load.project.name} artifactCount={load.workspace.artifacts.length} />
    : <ArtifactPlaceholder artifactId={artifactId} artifact={artifact} />;

  return (
    <ProjectStudioShell
      agent={(
        <WorkspaceAgentPanel
          draft={studio.workspaceAgentDraft}
          onDraftChange={studio.setWorkspaceAgentDraft}
          contextLabel={contextLabel}
        />
      )}
      main={main}
      inspector={<InspectorPlaceholder selectedCount={studio.selectedGraphObjectIds.length} zoom={studio.viewport.zoom} />}
    />
  );
}
