import { CircleAlert, Copy, LoaderCircle, MousePointer2, RotateCw, X } from "lucide-react";
import { useState, type RefObject } from "react";
import type { WorkspaceArtifact, WorkspaceRenderFrameSpec } from "../../lib/api.ts";
import { previewDocumentSrc } from "../../lib/preview-channel.ts";
import type { RuntimeError } from "../../lib/preview-runtime-errors.ts";
import { previewSandboxForSrc } from "../../lib/preview-sandbox.ts";
import type { ArtifactPreviewController } from "./useArtifactPreview.ts";
import {
  safePreviewFrameBackground,
  type ArtifactElementContext,
  type ArtifactRuntimeErrorIdentity,
  type PreviewFrameState,
} from "./usePreviewBridge.ts";

export function ArtifactPreviewSurface({
  artifact,
  preview,
  frame,
  stageRef,
  iframeRef,
  zoom,
  selection,
  pickerActive,
  frameState,
  runtimeErrors,
  runtimeErrorIdentity,
  runtimeRepairContext,
  onDismissRuntimeFatal,
  onDismissRuntimeNonFatal,
  onRetryFrame,
  onPreviewLoad,
}: {
  artifact: WorkspaceArtifact | null;
  preview: ArtifactPreviewController;
  frame: WorkspaceRenderFrameSpec;
  stageRef: RefObject<HTMLDivElement | null>;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  zoom: number;
  selection: ArtifactElementContext | null;
  pickerActive: boolean;
  frameState: PreviewFrameState;
  runtimeErrors: { fatal: RuntimeError | null; nonFatal: RuntimeError[] };
  runtimeErrorIdentity: ArtifactRuntimeErrorIdentity | null;
  runtimeRepairContext: string | null;
  onDismissRuntimeFatal: () => void;
  onDismissRuntimeNonFatal: (sig: string) => void;
  onRetryFrame: () => void;
  onPreviewLoad: () => void;
}) {
  const [repairContextCopied, setRepairContextCopied] = useState(false);
  if (artifact === null) {
    return (
      <div className="artifact-stage artifact-stage--message">
        <div role="alert" className="artifact-stage-message">
          <CircleAlert aria-hidden size={18} />
          <div>
            <strong>Artifact is not in the active workspace</strong>
            <p>Return to the canvas and choose an active Page or Component.</p>
          </div>
        </div>
      </div>
    );
  }

  if (preview.status === "idle" || preview.status === "loading") {
    return (
      <div className="artifact-stage artifact-stage--message">
        <div role="status" aria-live="polite" aria-label="Preparing artifact preview" className="artifact-stage-message">
          <LoaderCircle aria-hidden size={18} className="artifact-spin" />
          <div>
            <strong>Assembling immutable preview</strong>
            <p>{preview.status === "loading" && preview.resolved ? "Resolved revision; acquiring an isolated lease." : "Resolving the exact current revision."}</p>
          </div>
        </div>
      </div>
    );
  }

  if (preview.status === "error") {
    return (
      <div className="artifact-stage artifact-stage--message">
        <div role="alert" aria-label="Artifact preview unavailable" className="artifact-stage-message artifact-stage-message--error">
          <CircleAlert aria-hidden size={18} />
          <div>
            <strong>Preview unavailable</strong>
            <p>{preview.error}</p>
            <button type="button" onClick={preview.retry} aria-label="Retry artifact preview">
              <RotateCw aria-hidden size={13} />
              Retry assembly
            </button>
          </div>
        </div>
      </div>
    );
  }

  const frameBackground = safePreviewFrameBackground(frame.background) ?? "white";

  return (
    <div ref={stageRef} className="artifact-stage" data-preview-revision={preview.resolved.revisionId}>
      <div className="artifact-stage__measure" aria-hidden>
        <span>{frame.width} × {frame.height}</span>
        <span>{frame.name}</span>
      </div>
      {runtimeErrorIdentity !== null && runtimeRepairContext !== null
        && (runtimeErrors.fatal !== null || runtimeErrors.nonFatal.length > 0) ? (
          <aside className="artifact-runtime-errors" aria-label="Artifact runtime diagnostics">
            <div className="artifact-runtime-errors__header">
              <div>
                <strong>Runtime diagnostics</strong>
                <span>Revision {runtimeErrorIdentity.revisionId} · Frame {runtimeErrorIdentity.frameId}</span>
              </div>
              {runtimeErrors.fatal ? (
                <button type="button" aria-label="Dismiss runtime error" onClick={onDismissRuntimeFatal}>
                  <X aria-hidden size={12} />
                </button>
              ) : null}
            </div>
            {runtimeErrors.fatal ? (
              <div role="alert" aria-label="Artifact preview runtime error" className="artifact-runtime-errors__fatal">
                <CircleAlert aria-hidden size={14} />
                <div>
                  <p>{runtimeErrors.fatal.message}</p>
                  {runtimeErrors.fatal.stack ? <pre>{runtimeErrors.fatal.stack}</pre> : null}
                </div>
              </div>
            ) : null}
            {runtimeErrors.nonFatal.length > 0 ? (
              <ul aria-label="Artifact preview nonfatal runtime errors">
                {runtimeErrors.nonFatal.map((error) => (
                  <li key={error.sig}>
                    <span>{error.message}{error.count > 1 ? ` ×${error.count}` : ""}</span>
                    <button type="button" aria-label={`Dismiss ${error.message}`} onClick={() => onDismissRuntimeNonFatal(error.sig)}>
                      <X aria-hidden size={11} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <details onToggle={() => setRepairContextCopied(false)}>
              <summary>Repair context</summary>
              <pre aria-label="Runtime repair context">{runtimeRepairContext}</pre>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(runtimeRepairContext).then(
                    () => setRepairContextCopied(true),
                    () => setRepairContextCopied(false),
                  );
                }}
              >
                <Copy aria-hidden size={11} />
                {repairContextCopied ? "Copied" : "Copy repair context"}
              </button>
            </details>
          </aside>
        ) : null}
      <div
        className="artifact-preview-scale"
        style={{
          width: frame.width * zoom,
          height: frame.height * zoom,
          "--artifact-preview-width": `${frame.width}px`,
          "--artifact-preview-height": `${frame.height}px`,
          "--artifact-preview-zoom": zoom,
        } as React.CSSProperties}
      >
        <div className="artifact-preview-frame" style={{ background: frameBackground }}>
          <iframe
            ref={iframeRef}
            title={`${artifact.name} preview`}
            src={previewDocumentSrc(preview.lease.url)}
            sandbox={previewSandboxForSrc(previewDocumentSrc(preview.lease.url))}
            onLoad={onPreviewLoad}
            style={{ background: frameBackground }}
          />
        </div>
      </div>
      <div
        className="artifact-stage__frame-status"
        role="status"
        aria-label="Preview frame state"
        data-state={frameState.status}
        title={frameState.status === "rejected" ? frameState.message : undefined}
      >
        <span aria-hidden />
        {frameState.status === "applied"
          ? "State applied"
          : frameState.status === "rejected"
            ? frameState.retryable
              ? "State timed out"
              : "State rejected"
            : frameState.status === "applying"
              ? frameState.attempt === 1
                ? "Retrying state"
                : "Applying state"
              : frameState.status === "pending" && frameState.reconnecting
                ? "Reconnecting state"
                : "State pending"}
        {frameState.status === "rejected" && frameState.retryable ? (
          <button type="button" onClick={onRetryFrame} aria-label="Retry frame state">
            Retry
          </button>
        ) : null}
      </div>
      <div className="artifact-stage__status" aria-live="polite">
        <MousePointer2 aria-hidden size={13} />
        {selection
          ? `Selected · ${selection.label}`
          : pickerActive
            ? "Picker active · choose an element in the preview"
            : "Selection paused · resume from the Inspector"}
      </div>
    </div>
  );
}
