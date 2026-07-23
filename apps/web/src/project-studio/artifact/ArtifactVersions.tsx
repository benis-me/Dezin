import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  Clock3,
  GitBranch,
  GitCompareArrows,
  LoaderCircle,
  RotateCcw,
  X,
} from "lucide-react";
import { Dialog } from "../../components/ui/index.ts";
import type { VersionCompareSide } from "../../components/VersionCompare.tsx";
import { useApi } from "../../lib/api-context.tsx";
import type {
  ArtifactRevision,
  ArtifactTrack,
  ArtifactVersionActionResult,
  WorkspaceRenderFrameSpec,
} from "../../lib/api.ts";
import { useArtifactPreview } from "./useArtifactPreview.ts";
import {
  readFrozenPrototypeRenderFrames,
  selectFrozenPrototypeRenderFrame,
} from "../../../../../packages/core/src/prototype-relation.ts";

const HISTORY_PAGE_SIZE = 20;
const VersionCompare = lazy(() => import("../../components/VersionCompare.tsx").then((module) => ({
  default: module.VersionCompare,
})));

type HistoryState =
  | { status: "idle"; items: ArtifactRevision[]; nextCursor: string | null; error: null }
  | { status: "loading"; items: ArtifactRevision[]; nextCursor: string | null; error: null }
  | { status: "ready"; items: ArtifactRevision[]; nextCursor: string | null; error: null }
  | { status: "error"; items: ArtifactRevision[]; nextCursor: string | null; error: string };

interface Comparison {
  first: ArtifactRevision;
  second: ArtifactRevision;
}

export function selectVersionComparisonFrame(
  revision: Readonly<ArtifactRevision>,
  preferredFrame: Readonly<WorkspaceRenderFrameSpec> | null,
): Readonly<WorkspaceRenderFrameSpec> | null {
  const frames = readFrozenPrototypeRenderFrames(revision.renderSpec);
  return selectFrozenPrototypeRenderFrame(frames, {
    currentFrame: preferredFrame,
    targetState: null,
  });
}

function versionError(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "The version action could not be completed.";
}

function mergeHistory(current: ArtifactRevision[], incoming: ArtifactRevision[]): ArtifactRevision[] {
  const merged = new Map(current.map((revision) => [revision.id, revision]));
  for (const revision of incoming) merged.set(revision.id, revision);
  return [...merged.values()].sort((left, right) => (
    right.createdAt - left.createdAt || right.sequence - left.sequence || right.id.localeCompare(left.id)
  ));
}

function revisionLabel(revision: ArtifactRevision, tracks: ArtifactTrack[]): string {
  const track = tracks.find((candidate) => candidate.id === revision.trackId);
  return `Revision ${revision.sequence} · ${track?.name ?? "Unknown track"}`;
}

function ComparisonPreview({
  projectId,
  artifactId,
  comparison,
  tracks,
  preferredFrame,
  onClose,
}: {
  projectId: string;
  artifactId: string;
  comparison: Comparison;
  tracks: ArtifactTrack[];
  preferredFrame: Readonly<WorkspaceRenderFrameSpec> | null;
  onClose: () => void;
}) {
  const comparisonFrames = useMemo(() => ({
    first: selectVersionComparisonFrame(comparison.first, preferredFrame),
    second: selectVersionComparisonFrame(comparison.second, preferredFrame),
  }), [comparison.first, comparison.second, preferredFrame]);
  const first = useArtifactPreview({
    projectId,
    expectedArtifactId: artifactId,
    expectedRevisionId: comparison.first.id,
    expectedRenderSpec: comparison.first.renderSpec,
    target: { kind: "artifact-revision", projectId, revisionId: comparison.first.id },
  });
  const second = useArtifactPreview({
    projectId,
    expectedArtifactId: artifactId,
    expectedRevisionId: comparison.second.id,
    expectedRenderSpec: comparison.second.renderSpec,
    target: { kind: "artifact-revision", projectId, revisionId: comparison.second.id },
  });
  const side = (
    preview: typeof first,
    revision: ArtifactRevision,
    frame: Readonly<WorkspaceRenderFrameSpec> | null,
  ): VersionCompareSide => {
    const label = revisionLabel(revision, tracks);
    if (frame === null) {
      return { status: "error", label, error: "This Revision has no valid exact Render Frame." };
    }
    if (preview.status === "ready") {
      return {
        status: "ready",
        label,
        url: preview.lease.url,
        bridgeNonce: preview.lease.bridgeNonce,
        frame,
      };
    }
    if (preview.status === "error") {
      return { status: "error", label, error: preview.error, retry: preview.retry };
    }
    return { status: "loading", label };
  };

  return (
    <Suspense fallback={<div role="status" className="artifact-versions__compare-loading">Preparing comparison…</div>}>
      <VersionCompare
        open
        onClose={onClose}
        a={side(first, comparison.first, comparisonFrames.first)}
        b={side(second, comparison.second, comparisonFrames.second)}
      />
    </Suspense>
  );
}

export function ArtifactVersions({
  open,
  initialMode,
  projectId,
  artifactId,
  tracks,
  headRevisionId,
  snapshotId,
  pinnedRevisionId,
  preferredFrame = null,
  onClose,
  onViewRevision,
  onVersionPublished,
}: {
  open: boolean;
  initialMode: "versions" | "compare";
  projectId: string;
  artifactId: string;
  tracks: ArtifactTrack[];
  headRevisionId: string | null;
  snapshotId: string | null;
  pinnedRevisionId: string | null;
  preferredFrame?: Readonly<WorkspaceRenderFrameSpec> | null;
  onClose: () => void;
  onViewRevision: (revisionId: string) => void;
  onVersionPublished?: (result: ArtifactVersionActionResult) => void;
}) {
  const api = useApi();
  const [history, setHistory] = useState<HistoryState>({
    status: "idle",
    items: [],
    nextCursor: null,
    error: null,
  });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [forkingRevisionId, setForkingRevisionId] = useState<string | null>(null);
  const [trackName, setTrackName] = useState("");
  const [action, setAction] = useState<{ kind: "restore" | "fork"; revisionId: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectionHydrating, setSelectionHydrating] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const actionRequestIdRef = useRef(0);
  const selectionRequestIdRef = useRef(0);
  const artifactIdentityRef = useRef(`${projectId}:${artifactId}`);
  const openedHistoryIdentityRef = useRef<string | null>(null);

  useEffect(() => {
    const identity = `${projectId}:${artifactId}`;
    if (artifactIdentityRef.current === identity) return;
    artifactIdentityRef.current = identity;
    requestIdRef.current += 1;
    actionRequestIdRef.current += 1;
    selectionRequestIdRef.current += 1;
    setHistory({ status: "idle", items: [], nextCursor: null, error: null });
    setSelectedIds([]);
    setComparison(null);
    setForkingRevisionId(null);
    setAction(null);
    setActionError(null);
    setSelectionHydrating(false);
    setSelectionError(null);
  }, [artifactId, projectId]);

  const loadPage = useCallback(async (cursor?: string): Promise<void> => {
    const requestId = ++requestIdRef.current;
    setHistory((current) => ({ ...current, status: "loading", error: null }));
    try {
      const page = await api.listArtifactRevisionHistory(projectId, artifactId, {
        limit: HISTORY_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      if (requestIdRef.current !== requestId) return;
      setHistory((current) => ({
        status: "ready",
        items: mergeHistory(cursor ? current.items : [], page.items),
        nextCursor: page.nextCursor,
        error: null,
      }));
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setHistory((current) => ({ ...current, status: "error", error: versionError(error) }));
    }
  }, [api, artifactId, projectId]);

  useEffect(() => {
    if (!open) {
      if (openedHistoryIdentityRef.current !== null) requestIdRef.current += 1;
      openedHistoryIdentityRef.current = null;
      return;
    }
    const identity = `${projectId}:${artifactId}`;
    if (openedHistoryIdentityRef.current === identity) return;
    openedHistoryIdentityRef.current = identity;
    setHistory({ status: "idle", items: [], nextCursor: null, error: null });
    void loadPage();
  }, [artifactId, loadPage, open, projectId]);

  useEffect(() => {
    if (!open) return;
    setActionError(null);
    setSelectionError(null);
    selectionRequestIdRef.current += 1;
    setSelectionHydrating(false);
    setForkingRevisionId(null);
    setSelectedIds(initialMode === "compare"
      && pinnedRevisionId !== null
      && headRevisionId !== null
      && pinnedRevisionId !== headRevisionId
      ? [pinnedRevisionId, headRevisionId]
      : []);
  }, [headRevisionId, initialMode, open, pinnedRevisionId]);

  useEffect(() => () => {
    requestIdRef.current += 1;
    actionRequestIdRef.current += 1;
    selectionRequestIdRef.current += 1;
  }, []);

  const selectedRevisions = useMemo(() => selectedIds
    .map((id) => history.items.find((revision) => revision.id === id))
    .filter((revision): revision is ArtifactRevision => revision !== undefined), [history.items, selectedIds]);
  const missingSelectionIds = initialMode === "compare"
    ? selectedIds.filter((id) => !history.items.some((revision) => revision.id === id))
    : [];
  const missingSelectionKey = missingSelectionIds.join("\u0000");

  useEffect(() => {
    if (!open || initialMode !== "compare" || missingSelectionIds.length === 0
      || history.status === "idle" || history.status === "loading") return;
    const requestId = ++selectionRequestIdRef.current;
    const identity = artifactIdentityRef.current;
    let disposed = false;
    setSelectionHydrating(true);
    setSelectionError(null);
    void Promise.allSettled(missingSelectionIds.map(async (revisionId) => {
      const candidate = await api.getArtifactRevision(projectId, artifactId, revisionId);
      if (candidate.id !== revisionId || candidate.artifactId !== artifactId) {
        throw new Error("Saved Revision identity did not match the requested Artifact.");
      }
      return candidate;
    })).then((results) => {
      if (disposed || selectionRequestIdRef.current !== requestId
        || artifactIdentityRef.current !== identity) return;
      const fulfilled = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      if (fulfilled.length > 0) {
        setHistory((current) => ({ ...current, items: mergeHistory(current.items, fulfilled) }));
      }
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      setSelectionError(failure ? versionError(failure.reason) : null);
      setSelectionHydrating(false);
    });
    return () => {
      disposed = true;
    };
  // The canonical key prevents a page response from restarting the same exact-ID hydration.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, artifactId, history.status, initialMode, missingSelectionKey, open, projectId]);

  const toggleSelection = (revisionId: string): void => {
    setSelectedIds((current) => {
      if (current.includes(revisionId)) return current.filter((id) => id !== revisionId);
      return current.length >= 2 ? [current[1]!, revisionId] : [...current, revisionId];
    });
  };

  const publishRestore = async (revision: ArtifactRevision): Promise<void> => {
    if (snapshotId === null || action !== null) return;
    const requestId = ++actionRequestIdRef.current;
    const identity = artifactIdentityRef.current;
    setAction({ kind: "restore", revisionId: revision.id });
    setActionError(null);
    try {
      const result = await api.restoreArtifactRevision(projectId, artifactId, revision.id, {
        expectedHeadRevisionId: headRevisionId,
        expectedSnapshotId: snapshotId,
      });
      if (actionRequestIdRef.current !== requestId || artifactIdentityRef.current !== identity) return;
      onVersionPublished?.(result);
      setAction(null);
      onClose();
    } catch (error) {
      if (actionRequestIdRef.current !== requestId || artifactIdentityRef.current !== identity) return;
      setAction(null);
      setActionError(versionError(error));
    }
  };

  const publishFork = async (revision: ArtifactRevision): Promise<void> => {
    const name = trackName.trim();
    if (!name || snapshotId === null || action !== null) return;
    const requestId = ++actionRequestIdRef.current;
    const identity = artifactIdentityRef.current;
    setAction({ kind: "fork", revisionId: revision.id });
    setActionError(null);
    try {
      const result = await api.forkArtifactTrack(projectId, artifactId, revision.id, {
        name,
        expectedHeadRevisionId: headRevisionId,
        expectedSnapshotId: snapshotId,
      });
      if (actionRequestIdRef.current !== requestId || artifactIdentityRef.current !== identity) return;
      onVersionPublished?.(result);
      setAction(null);
      onClose();
    } catch (error) {
      if (actionRequestIdRef.current !== requestId || artifactIdentityRef.current !== identity) return;
      setAction(null);
      setActionError(versionError(error));
    }
  };

  const canPublish = snapshotId !== null;
  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        label="Artifact versions"
        align="top"
        className="artifact-versions-dialog sm:max-w-3xl"
        showClose
      >
        <div className="artifact-versions">
          <header className="artifact-versions__header">
            <div>
              <span>Immutable history</span>
              <h2>{initialMode === "compare" ? "Choose two Revisions" : "Versions"}</h2>
              <p>
                Saved Revisions never change. Restore and fork publish against the current Design Kernel,
                then remain unassessed until validation runs again.
              </p>
            </div>
            {initialMode === "compare" ? (
              <button
                type="button"
                className="artifact-versions__compare"
                disabled={selectedRevisions.length !== 2 || selectionHydrating}
                aria-label="Compare selected revisions"
                onClick={() => {
                  if (selectedRevisions.length !== 2) return;
                  setComparison({ first: selectedRevisions[0]!, second: selectedRevisions[1]! });
                  onClose();
                }}
              >
                {selectionHydrating
                  ? <LoaderCircle aria-hidden className="artifact-spin" size={14} />
                  : <GitCompareArrows aria-hidden size={14} />}
                Compare {selectedIds.length}/2
              </button>
            ) : null}
          </header>

          <div className="artifact-versions__body">
            {history.status === "loading" && history.items.length === 0 ? (
              <div className="artifact-versions__message" role="status">
                <LoaderCircle aria-hidden className="artifact-spin" size={16} />
                Loading saved Revisions…
              </div>
            ) : null}
            {history.status === "error" && history.items.length === 0 ? (
              <div className="artifact-versions__message artifact-versions__message--error" role="alert">
                <p>{history.error}</p>
                <button type="button" onClick={() => void loadPage()}>Try again</button>
              </div>
            ) : null}
            {history.status === "ready" && history.items.length === 0 ? (
              <div className="artifact-versions__message" role="status">No saved Revisions yet.</div>
            ) : null}

            {history.items.length > 0 ? (
              <ol className="artifact-version-list">
                {history.items.map((revision) => {
                  const track = tracks.find((candidate) => candidate.id === revision.trackId);
                  const trackLabel = track?.name ?? "Unknown track";
                  const isHead = revision.id === headRevisionId;
                  const isTrackHead = track?.headRevisionId === revision.id;
                  const isPinned = revision.id === pinnedRevisionId;
                  const selected = selectedIds.includes(revision.id);
                  const forking = forkingRevisionId === revision.id;
                  const actionPending = action?.revisionId === revision.id;
                  return (
                    <li key={revision.id} data-selected={selected || undefined}>
                      <div className="artifact-version-row">
                        {initialMode === "compare" ? (
                          <label className="artifact-version-row__select">
                            <input
                              type="checkbox"
                              checked={selected}
                              aria-label={`Select Revision ${revision.sequence} on ${trackLabel} for compare`}
                              onChange={() => toggleSelection(revision.id)}
                            />
                            <span aria-hidden>{selected ? <Check size={11} /> : null}</span>
                          </label>
                        ) : (
                          <span className="artifact-version-row__rail" aria-hidden />
                        )}
                        <div className="artifact-version-row__main">
                          <div className="artifact-version-row__title">
                            <strong>Revision {revision.sequence}</strong>
                            {isHead ? <span className="artifact-version-badge artifact-version-badge--head">Head</span> : null}
                            {!isHead && isTrackHead ? <span className="artifact-version-badge">Track head</span> : null}
                            {isPinned ? <span className="artifact-version-badge">Pinned</span> : null}
                          </div>
                          <div className="artifact-version-row__meta">
                            <span><GitBranch aria-hidden size={11} />{track?.name ?? "Unknown track"}</span>
                            <span><Clock3 aria-hidden size={11} />{new Date(revision.createdAt).toLocaleString()}</span>
                            <code title={revision.id}>{revision.id.slice(0, 12)}</code>
                          </div>
                        </div>
                        <div className="artifact-version-row__actions">
                          {!isPinned ? (
                            <button type="button" onClick={() => onViewRevision(revision.id)}>
                              <span className="sr-only">View Revision {revision.sequence} on {trackLabel}</span>
                              <span aria-hidden>View</span> <ArrowUpRight aria-hidden size={11} />
                            </button>
                          ) : null}
                          {!isHead ? (
                            <button
                              type="button"
                              disabled={!canPublish || action !== null}
                              aria-label={`Restore Revision ${revision.sequence} on ${trackLabel} as a new revision`}
                              onClick={() => void publishRestore(revision)}
                            >
                              {actionPending && action?.kind === "restore" ? <LoaderCircle aria-hidden className="artifact-spin" size={11} /> : <RotateCcw aria-hidden size={11} />}
                              Restore
                            </button>
                          ) : null}
                          <button
                            type="button"
                            disabled={!canPublish || action !== null}
                            aria-label={`Fork a track from Revision ${revision.sequence} on ${trackLabel}`}
                            onClick={() => {
                              setForkingRevisionId(revision.id);
                              setTrackName(`${track?.name ?? "Track"} fork`);
                              setActionError(null);
                            }}
                          >
                            <GitBranch aria-hidden size={11} />
                            Fork
                          </button>
                        </div>
                      </div>
                      {forking ? (
                        <form
                          className="artifact-version-fork"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void publishFork(revision);
                          }}
                        >
                          <label>
                            <span>New track name</span>
                            <input
                              autoFocus
                              aria-label="New track name"
                              value={trackName}
                              maxLength={80}
                              onChange={(event) => setTrackName(event.target.value)}
                            />
                          </label>
                          <button type="submit" disabled={!trackName.trim() || action !== null}>
                            {actionPending && action?.kind === "fork" ? <LoaderCircle aria-hidden className="artifact-spin" size={12} /> : null}
                            Create track
                          </button>
                          <button type="button" aria-label="Cancel track fork" onClick={() => setForkingRevisionId(null)}>
                            <X aria-hidden size={12} />
                          </button>
                        </form>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            ) : null}

            {actionError ? <p className="artifact-versions__action-error" role="alert">{actionError}</p> : null}
            {selectionError ? <p className="artifact-versions__action-error" role="alert">{selectionError}</p> : null}
            {history.status === "error" && history.items.length > 0 ? (
              <div className="artifact-versions__page-error" role="alert">
                <span>{history.error}</span>
                <button type="button" onClick={() => void loadPage(history.nextCursor ?? undefined)}>Retry</button>
              </div>
            ) : null}
            {history.nextCursor ? (
              <button
                type="button"
                className="artifact-versions__load"
                aria-label="Load older revisions"
                disabled={history.status === "loading"}
                onClick={() => void loadPage(history.nextCursor ?? undefined)}
              >
                {history.status === "loading" ? <LoaderCircle aria-hidden className="artifact-spin" size={13} /> : null}
                Load older Revisions
              </button>
            ) : null}
          </div>
        </div>
      </Dialog>
      {comparison ? (
        <ComparisonPreview
          projectId={projectId}
        artifactId={artifactId}
        comparison={comparison}
        tracks={tracks}
        preferredFrame={preferredFrame}
        onClose={() => setComparison(null)}
        />
      ) : null}
    </>
  );
}
