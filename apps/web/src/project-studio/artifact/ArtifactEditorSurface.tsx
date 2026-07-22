import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "../../lib/api-context.tsx";
import type {
  ArtifactMutationCommand,
  ArtifactMutationResult,
  ArtifactRevision,
  ArtifactTrack,
  ArtifactVersionActionResult,
  PreviewTarget,
  WorkspaceArtifact,
  WorkspaceRenderFrameSpec,
} from "../../lib/api.ts";
import { ArtifactHeader } from "./ArtifactHeader.tsx";
import { ArtifactPreviewSurface } from "./ArtifactPreviewSurface.tsx";
import { ArtifactVersions } from "./ArtifactVersions.tsx";
import "./artifact-editor.css";
import { useArtifactPreview } from "./useArtifactPreview.ts";
import { usePreviewBridge } from "./usePreviewBridge.ts";

type MutationState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; revisionSequence: number }
  | { status: "error"; message: string };

export interface ArtifactEditorController {
  projectId: string;
  artifactId: string | null;
  artifact: WorkspaceArtifact | null;
  tracks: ArtifactTrack[];
  revisions: ArtifactRevision[];
  revision: ArtifactRevision | null;
  headRevisionId: string | null;
  snapshotId: string | null;
  pinnedRevisionId: string | null;
  preview: ReturnType<typeof useArtifactPreview>;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  selection: ReturnType<typeof usePreviewBridge>["selection"];
  pickerActive: boolean;
  frameState: ReturnType<typeof usePreviewBridge>["frameState"];
  runtimeErrors: ReturnType<typeof usePreviewBridge>["runtimeErrors"];
  runtimeErrorIdentity: ReturnType<typeof usePreviewBridge>["runtimeErrorIdentity"];
  runtimeRepairContext: string | null;
  dismissRuntimeFatal: () => void;
  dismissRuntimeNonFatal: (sig: string) => void;
  retryFrame: () => void;
  clearSelection: () => void;
  beginSelection: () => void;
  onPreviewLoad: () => void;
  frames: WorkspaceRenderFrameSpec[];
  activeFrame: WorkspaceRenderFrameSpec;
  setActiveFrameId: (frameId: string) => void;
  zoom: number;
  setZoom: (zoom: number) => void;
  presentation: boolean;
  setPresentation: (value: boolean) => void;
  mutationState: MutationState;
  mutationDisabled: boolean;
  applyMutation: (command: ArtifactMutationCommand) => Promise<void>;
}

const PAGE_FRAME: WorkspaceRenderFrameSpec = { id: "desktop", name: "Desktop", width: 1440, height: 900 };
const COMPONENT_FRAME: WorkspaceRenderFrameSpec = { id: "fixture", name: "Fixture", width: 720, height: 540 };

export function fitArtifactPreviewZoom(
  frame: WorkspaceRenderFrameSpec,
  stage: {
    width: number;
    height: number;
    paddingLeft?: number;
    paddingRight?: number;
    paddingTop?: number;
    paddingBottom?: number;
  },
): number {
  const availableWidth = Math.max(0, stage.width - (stage.paddingLeft ?? 0) - (stage.paddingRight ?? 0));
  const availableHeight = Math.max(0, stage.height - (stage.paddingTop ?? 0) - (stage.paddingBottom ?? 0));
  const fitted = Math.min(availableWidth / frame.width, availableHeight / frame.height, 1);
  return Math.min(1.5, Math.max(0.25, Number.isFinite(fitted) ? fitted : 0.25));
}

export function parseFrames(renderSpec: Record<string, unknown> | null, kind: WorkspaceArtifact["kind"] | undefined): WorkspaceRenderFrameSpec[] {
  const value = renderSpec?.frames;
  if (!Array.isArray(value)) return [kind === "component" ? COMPONENT_FRAME : PAGE_FRAME];
  const frames: WorkspaceRenderFrameSpec[] = [];
  const ids = new Set<string>();
  for (const candidate of value.slice(0, 64)) {
    if (!candidate || typeof candidate !== "object") continue;
    const frame = candidate as Partial<WorkspaceRenderFrameSpec>;
    if (typeof frame.id !== "string" || frame.id.length === 0 || frame.id.length > 256
      || frame.id !== frame.id.trim() || /[\u0000-\u001f\u007f]/.test(frame.id)) continue;
    if (ids.has(frame.id) || typeof frame.name !== "string" || frame.name.trim().length === 0 || frame.name.length > 256) continue;
    if (typeof frame.width !== "number" || !Number.isFinite(frame.width) || frame.width <= 0 || frame.width > 16_384) continue;
    if (typeof frame.height !== "number" || !Number.isFinite(frame.height) || frame.height <= 0 || frame.height > 16_384) continue;
    ids.add(frame.id);
    frames.push({
      id: frame.id,
      name: frame.name.trim(),
      width: frame.width,
      height: frame.height,
      ...(typeof frame.initialState === "string" ? { initialState: frame.initialState } : {}),
      ...(frame.fixture && typeof frame.fixture === "object" ? { fixture: frame.fixture } : {}),
      ...(typeof frame.background === "string" ? { background: frame.background } : {}),
    });
  }
  return frames.length > 0 ? frames : [kind === "component" ? COMPONENT_FRAME : PAGE_FRAME];
}

function mutationError(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : "The direct edit could not be published.";
}

export function useArtifactEditorController({
  projectId,
  artifactId,
  artifact,
  tracks,
  revisions,
  activeRevisionId,
  activeSnapshotId,
  target: targetOverride,
  onArtifactPublished,
}: {
  projectId: string;
  artifactId: string | null;
  artifact: WorkspaceArtifact | null;
  tracks: ArtifactTrack[];
  revisions: ArtifactRevision[];
  activeRevisionId: string | null;
  activeSnapshotId: string | null;
  target?: PreviewTarget;
  onArtifactPublished?: (result: ArtifactMutationResult) => void;
}): ArtifactEditorController {
  const api = useApi();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [headRevisionId, setHeadRevisionId] = useState(activeRevisionId);
  const [snapshotId, setSnapshotId] = useState(activeSnapshotId);
  const [publishedRevision, setPublishedRevision] = useState<ArtifactRevision | null>(null);
  const [fetchedRevision, setFetchedRevision] = useState<ArtifactRevision | null>(null);
  const [activeFrameId, setActiveFrameId] = useState(artifact?.kind === "component" ? COMPONENT_FRAME.id : PAGE_FRAME.id);
  const [zoom, setZoomState] = useState(0.65);
  const [presentation, setPresentation] = useState(false);
  const [mutationState, setMutationState] = useState<MutationState>({ status: "idle" });
  const artifactIdentity = artifactId === null ? null : `${projectId}:${artifactId}`;
  const lastArtifactIdentityRef = useRef<string | null>(artifactIdentity);
  const lastInputRevisionIdRef = useRef(activeRevisionId);
  const lastInputSnapshotIdRef = useRef(activeSnapshotId);
  const mutationRequestIdRef = useRef(0);
  const mutationEpochRef = useRef({ identity: artifactIdentity, value: 0 });
  if (mutationEpochRef.current.identity !== artifactIdentity) {
    mutationEpochRef.current = {
      identity: artifactIdentity,
      value: mutationEpochRef.current.value + 1,
    };
  }

  useEffect(() => {
    if (artifactId === null) return;
    if (lastArtifactIdentityRef.current !== artifactIdentity) {
      lastArtifactIdentityRef.current = artifactIdentity;
      lastInputRevisionIdRef.current = activeRevisionId;
      lastInputSnapshotIdRef.current = activeSnapshotId;
      setHeadRevisionId(activeRevisionId);
      setSnapshotId(activeSnapshotId);
      setPublishedRevision(null);
      setActiveFrameId(artifact?.kind === "component" ? COMPONENT_FRAME.id : PAGE_FRAME.id);
      setZoomState(0.65);
      setMutationState({ status: "idle" });
      setPresentation(false);
      return;
    }
    if (lastInputRevisionIdRef.current !== activeRevisionId) {
      lastInputRevisionIdRef.current = activeRevisionId;
      setHeadRevisionId(activeRevisionId);
      setPublishedRevision(null);
    }
    if (lastInputSnapshotIdRef.current !== activeSnapshotId) {
      lastInputSnapshotIdRef.current = activeSnapshotId;
      setSnapshotId(activeSnapshotId);
    }
  }, [activeRevisionId, activeSnapshotId, artifact?.kind, artifactId, artifactIdentity]);

  const target = useMemo<PreviewTarget | null>(() => {
    if (artifactId === null || artifact === null) return null;
    return targetOverride ?? {
      kind: "artifact-current",
      projectId,
      artifactId,
      ...(artifact.activeTrackId ? { trackId: artifact.activeTrackId } : {}),
    };
  }, [artifact, artifactId, projectId, targetOverride]);
  const preview = useArtifactPreview({
    projectId,
    target,
    expectedArtifactId: artifactId ?? undefined,
    expectedRevisionId: target?.kind === "artifact-current"
      ? activeRevisionId ?? undefined
      : undefined,
    enabled: artifactId !== null && artifact !== null,
  });
  const pinnedRevisionId = targetOverride?.kind === "artifact-revision" ? targetOverride.revisionId : null;
  const bundledPinnedRevision = pinnedRevisionId === null
    ? null
    : revisions.find((candidate) => candidate.id === pinnedRevisionId) ?? null;
  useEffect(() => {
    if (pinnedRevisionId === null || artifactId === null || bundledPinnedRevision !== null) {
      setFetchedRevision(null);
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    setFetchedRevision(null);
    void Promise.resolve()
      .then(() => api.getArtifactRevision(projectId, artifactId, pinnedRevisionId))
      .then((candidate) => {
        if (disposed || controller.signal.aborted) return;
        if (candidate.id === pinnedRevisionId && candidate.artifactId === artifactId) setFetchedRevision(candidate);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [api, artifactId, bundledPinnedRevision, pinnedRevisionId, projectId]);
  const previewRevisionId = preview.status === "ready" ? preview.resolved.revisionId : null;
  const previewTargetKey = preview.status === "ready" ? preview.resolved.targetKey : null;
  const previewAssemblyHash = preview.status === "ready" ? preview.resolved.assemblyHash : null;
  const previewLeaseId = preview.status === "ready" ? preview.lease.leaseId : null;
  const previewBridgeNonce = preview.status === "ready" ? preview.lease.bridgeNonce : null;
  const previewIdentity = useMemo(() => (
    previewRevisionId === null || previewTargetKey === null || previewAssemblyHash === null
      || previewLeaseId === null || previewBridgeNonce === null
      ? null
      : {
          revisionId: previewRevisionId,
          targetKey: previewTargetKey,
          assemblyHash: previewAssemblyHash,
          leaseId: previewLeaseId,
          bridgeNonce: previewBridgeNonce,
      }
  ), [previewAssemblyHash, previewBridgeNonce, previewLeaseId, previewRevisionId, previewTargetKey]);
  const resolvedRevision = revisions.find((candidate) => candidate.id === preview.resolved?.revisionId)
    ?? (fetchedRevision?.id === preview.resolved?.revisionId ? fetchedRevision : null);
  const revision = preview.readOnly
    ? resolvedRevision
    : publishedRevision
      ?? resolvedRevision
      ?? revisions.find((candidate) => candidate.id === headRevisionId)
      ?? null;
  const frames = useMemo(
    () => parseFrames(preview.resolved?.renderSpec ?? revision?.renderSpec ?? null, artifact?.kind),
    [artifact?.kind, preview.resolved?.renderSpec, revision?.renderSpec],
  );
  const activeFrame = frames.find((frame) => frame.id === activeFrameId) ?? frames[0] ?? PAGE_FRAME;
  const bridge = usePreviewBridge({
    iframeRef,
    previewSrc: preview.status === "ready" ? preview.lease.url : null,
    projectId,
    artifactId,
    previewIdentity,
    frame: activeFrame,
    enabled: artifactId !== null && artifact !== null,
  });
  const retryPreview = useCallback(() => {
    bridge.clearSelection();
    preview.retry();
  }, [bridge.clearSelection, preview.retry]);
  const controlledPreview = useMemo(() => ({ ...preview, retry: retryPreview }), [preview, retryPreview]);

  useEffect(() => {
    if (!frames.some((frame) => frame.id === activeFrameId)) setActiveFrameId(frames[0]?.id ?? PAGE_FRAME.id);
  }, [activeFrameId, frames]);

  useEffect(() => {
    if (!presentation) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setPresentation(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [presentation]);

  useEffect(() => () => {
    mutationRequestIdRef.current += 1;
  }, []);

  const mutationDisabled = preview.readOnly
    || bridge.selection === null
    || !bridge.selection.mutationCapable
    || artifactId === null
    || headRevisionId === null
    || snapshotId === null
    || mutationState.status === "saving";
  const applyMutation = useCallback(async (command: ArtifactMutationCommand): Promise<void> => {
    if (preview.readOnly || artifactId === null || headRevisionId === null || snapshotId === null
      || bridge.selection === null || !bridge.selection.mutationCapable) return;
    const requestId = ++mutationRequestIdRef.current;
    const requestIdentity = artifactIdentity;
    const requestEpoch = mutationEpochRef.current.value;
    const isCurrentMutation = () => mutationRequestIdRef.current === requestId
      && mutationEpochRef.current.value === requestEpoch
      && mutationEpochRef.current.identity === requestIdentity;
    setMutationState({ status: "saving" });
    try {
      const result = await api.applyArtifactMutation(projectId, artifactId, {
        expectedHeadRevisionId: headRevisionId,
        expectedSnapshotId: snapshotId,
        command,
      });
      onArtifactPublished?.(result);
      if (!isCurrentMutation()) return;
      setHeadRevisionId(result.revision.id);
      setSnapshotId(result.snapshot.id);
      setPublishedRevision(result.revision);
      setMutationState({ status: "saved", revisionSequence: result.revision.sequence });
      bridge.clearSelection();
      preview.retry();
    } catch (error) {
      if (isCurrentMutation()) setMutationState({ status: "error", message: mutationError(error) });
    }
  }, [
    api,
    artifactId,
    artifactIdentity,
    bridge.clearSelection,
    bridge.selection,
    headRevisionId,
    onArtifactPublished,
    preview,
    projectId,
    snapshotId,
  ]);
  const setZoom = useCallback((value: number) => setZoomState(Math.min(1.5, Math.max(0.25, value))), []);

  return {
    projectId,
    artifactId,
    artifact,
    tracks,
    revisions,
    revision,
    headRevisionId,
    snapshotId,
    pinnedRevisionId,
    preview: controlledPreview,
    iframeRef,
    selection: bridge.selection,
    pickerActive: bridge.pickerActive,
    frameState: bridge.frameState,
    runtimeErrors: bridge.runtimeErrors,
    runtimeErrorIdentity: bridge.runtimeErrorIdentity,
    runtimeRepairContext: bridge.runtimeRepairContext,
    dismissRuntimeFatal: bridge.dismissRuntimeFatal,
    dismissRuntimeNonFatal: bridge.dismissRuntimeNonFatal,
    retryFrame: bridge.retryFrame,
    clearSelection: bridge.clearSelection,
    beginSelection: bridge.beginSelection,
    onPreviewLoad: bridge.onPreviewLoad,
    frames,
    activeFrame,
    setActiveFrameId,
    zoom,
    setZoom,
    presentation,
    setPresentation,
    mutationState,
    mutationDisabled,
    applyMutation,
  };
}

export function ArtifactEditorSurface({
  editor,
  onBack,
  onReturnToHead = () => {},
  onViewRevision = () => {},
  onVersionPublished,
}: {
  editor: ArtifactEditorController;
  onBack: () => void;
  onReturnToHead?: () => void;
  onViewRevision?: (revisionId: string) => void;
  onVersionPublished?: (result: ArtifactVersionActionResult) => void;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [keepPreviewFitted, setKeepPreviewFitted] = useState(true);
  const [versionsMode, setVersionsMode] = useState<"versions" | "compare" | null>(null);
  const fitPreview = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const style = window.getComputedStyle(stage);
    const padding = (value: string): number => {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    editor.setZoom(fitArtifactPreviewZoom(editor.activeFrame, {
      width: stage.clientWidth,
      height: stage.clientHeight,
      paddingLeft: padding(style.paddingLeft),
      paddingRight: padding(style.paddingRight),
      paddingTop: padding(style.paddingTop),
      paddingBottom: padding(style.paddingBottom),
    }));
  }, [editor.activeFrame, editor.setZoom]);
  const requestFitPreview = useCallback(() => {
    setKeepPreviewFitted(true);
    fitPreview();
  }, [fitPreview]);
  const setManualZoom = useCallback((zoom: number) => {
    setKeepPreviewFitted(false);
    editor.setZoom(zoom);
  }, [editor.setZoom]);

  useEffect(() => {
    setKeepPreviewFitted(true);
  }, [editor.activeFrame.id, editor.artifactId]);

  useEffect(() => {
    if (!keepPreviewFitted || editor.preview.status !== "ready") return;
    fitPreview();
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fitPreview());
    observer.observe(stage);
    return () => observer.disconnect();
  }, [editor.preview.status, fitPreview, keepPreviewFitted]);

  return (
    <section
      role="region"
      aria-label="Artifact editor"
      className="artifact-editor"
      data-presentation={editor.presentation || undefined}
      data-read-only={editor.preview.readOnly || undefined}
    >
      <ArtifactHeader
        artifact={editor.artifact}
        artifactId={editor.artifactId}
        revisionSequence={editor.revision?.sequence ?? null}
        frames={editor.frames}
        activeFrameId={editor.activeFrame.id}
        zoom={editor.zoom}
        readOnly={editor.preview.readOnly}
        presentation={editor.presentation}
        previewReady={editor.preview.status === "ready"}
        onBack={() => {
          editor.setPresentation(false);
          onBack();
        }}
        onFrameChange={(frameId) => {
          setKeepPreviewFitted(true);
          editor.setActiveFrameId(frameId);
        }}
        onZoomChange={setManualZoom}
        onFitPreview={requestFitPreview}
        onTogglePresentation={() => editor.setPresentation(!editor.presentation)}
        pinnedRevisionId={editor.pinnedRevisionId}
        onOpenVersions={() => setVersionsMode("versions")}
        onOpenCompare={() => setVersionsMode("compare")}
        onReturnToHead={onReturnToHead}
      />
      <ArtifactPreviewSurface
        artifact={editor.artifact}
        preview={editor.preview}
        frame={editor.activeFrame}
        stageRef={stageRef}
        iframeRef={editor.iframeRef}
        zoom={editor.zoom}
        selection={editor.selection}
        pickerActive={editor.pickerActive}
        frameState={editor.frameState}
        runtimeErrors={editor.runtimeErrors}
        runtimeErrorIdentity={editor.runtimeErrorIdentity}
        runtimeRepairContext={editor.runtimeRepairContext}
        onDismissRuntimeFatal={editor.dismissRuntimeFatal}
        onDismissRuntimeNonFatal={editor.dismissRuntimeNonFatal}
        onRetryFrame={editor.retryFrame}
        onPreviewLoad={editor.onPreviewLoad}
      />
      {editor.artifactId ? (
        <ArtifactVersions
          open={versionsMode !== null}
          initialMode={versionsMode ?? "versions"}
          projectId={editor.projectId}
          artifactId={editor.artifactId}
          tracks={editor.tracks}
          headRevisionId={editor.headRevisionId}
          snapshotId={editor.snapshotId}
          pinnedRevisionId={editor.pinnedRevisionId}
          onClose={() => setVersionsMode(null)}
          onViewRevision={(revisionId) => {
            setVersionsMode(null);
            onViewRevision(revisionId);
          }}
          onVersionPublished={onVersionPublished}
        />
      ) : null}
    </section>
  );
}
