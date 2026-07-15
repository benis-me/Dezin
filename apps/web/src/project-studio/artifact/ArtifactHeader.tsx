import {
  ArrowLeft,
  Focus,
  History,
  Maximize2,
  Minus,
  Plus,
  ScanSearch,
} from "lucide-react";
import type { WorkspaceArtifact, WorkspaceRenderFrameSpec } from "../../lib/api.ts";

export function ArtifactHeader({
  artifact,
  artifactId,
  revisionSequence,
  frames,
  activeFrameId,
  zoom,
  readOnly,
  presentation,
  previewReady,
  onBack,
  onFrameChange,
  onZoomChange,
  onFitPreview,
  onTogglePresentation,
}: {
  artifact: WorkspaceArtifact | null;
  artifactId: string | null;
  revisionSequence: number | null;
  frames: WorkspaceRenderFrameSpec[];
  activeFrameId: string;
  zoom: number;
  readOnly: boolean;
  presentation: boolean;
  previewReady: boolean;
  onBack: () => void;
  onFrameChange: (frameId: string) => void;
  onZoomChange: (zoom: number) => void;
  onFitPreview: () => void;
  onTogglePresentation: () => void;
}) {
  const name = artifact?.name ?? "Artifact unavailable";
  return (
    <header className="artifact-header app-drag">
      <div className="artifact-header__identity">
        <button type="button" className="artifact-tool app-no-drag" aria-label="Back to workspace canvas" onClick={onBack}>
          <ArrowLeft aria-hidden size={15} strokeWidth={1.8} />
        </button>
        <span className="artifact-header__rule" aria-hidden />
        <div className="artifact-header__title">
          <h1>{name}</h1>
          <div className="artifact-header__metadata">
            <span>{artifact?.kind === "component" ? "Component master" : "Page design"}</span>
            <span aria-hidden>·</span>
            {artifactId ? <span title={artifactId}>{artifactId.length > 18 ? artifactId.slice(0, 8) : artifactId}</span> : null}
            {artifactId ? <span aria-hidden>·</span> : null}
            <span>{revisionSequence === null ? "No revision" : `Revision ${revisionSequence}`}</span>
            {readOnly ? <strong>Historical / read-only</strong> : <strong>Current head</strong>}
          </div>
        </div>
      </div>

      <div className="artifact-header__controls app-no-drag">
        <label className="artifact-frame-select">
          <span className="sr-only">Preview frame</span>
          <select
            aria-label="Preview frame"
            value={activeFrameId}
            onChange={(event) => onFrameChange(event.target.value)}
          >
            {frames.map((frame) => <option key={frame.id} value={frame.id}>{frame.name}</option>)}
          </select>
        </label>
        <div className="artifact-tool-group" aria-label="Preview zoom controls" role="group">
          <button
            type="button"
            className="artifact-tool"
            aria-label="Zoom out"
            onClick={() => onZoomChange(Math.max(0.25, zoom - 0.1))}
          >
            <Minus aria-hidden size={14} />
          </button>
          <output aria-label="Preview zoom">{Math.round(zoom * 100)}%</output>
          <button
            type="button"
            className="artifact-tool"
            aria-label="Zoom in"
            onClick={() => onZoomChange(Math.min(1.5, zoom + 0.1))}
          >
            <Plus aria-hidden size={14} />
          </button>
          <button type="button" className="artifact-tool" aria-label="Fit preview" onClick={onFitPreview}>
            <Focus aria-hidden size={14} strokeWidth={1.7} />
          </button>
        </div>
        <button type="button" className="artifact-action" disabled title="Version controls arrive in the artifact history slice">
          <History aria-hidden size={14} />
          Versions
        </button>
        <button type="button" className="artifact-action" disabled title="Compare arrives in the artifact history slice">
          <ScanSearch aria-hidden size={14} />
          Compare
        </button>
        <button
          type="button"
          className="artifact-action artifact-action--primary"
          aria-pressed={presentation}
          disabled={!previewReady}
          onClick={onTogglePresentation}
        >
          <Maximize2 aria-hidden size={14} />
          {presentation ? "Exit present" : "Present"}
        </button>
      </div>
    </header>
  );
}
