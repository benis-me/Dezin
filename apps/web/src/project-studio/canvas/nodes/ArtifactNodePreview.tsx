import { Component, ImageOff, LoaderCircle, PanelTop, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/index.ts";
import { ApiError, type ApiClient } from "../../../lib/api.ts";
import { useApi } from "../../../lib/api-context.tsx";
import { withRequestDeadline } from "../../../lib/request-deadline.ts";
import type { SemanticZoomLevel, WorkspaceFlowNodeData } from "../workspace-graph-adapter.ts";

type ArtifactKind = "page" | "component";

type ThumbnailRequestState = readonly [
  key: string,
  status: "idle" | "loading" | "ready" | "error",
  objectUrl: string | null,
];

const IDLE_REQUEST: ThumbnailRequestState = ["idle", "idle", null];

interface ThumbnailCacheEntry {
  pending: boolean;
  request: Promise<Blob>;
  controller: AbortController;
  consumers: number;
}

interface ThumbnailLease {
  request: Promise<Blob>;
  release: () => void;
}

const MAX_CACHED_THUMBNAILS = 96;
const THUMBNAIL_RETRY_DELAYS_MS = [300, 1_000] as const;
const CANVAS_FAILURE_DETAIL_MAX_CHARS = 96;
const thumbnailCacheByApi = new WeakMap<ApiClient, Map<string, ThumbnailCacheEntry>>();

function boundedCanvasFailureDetail(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (normalized.length <= CANVAS_FAILURE_DETAIL_MAX_CHARS) return normalized;
  return `${normalized.slice(0, CANVAS_FAILURE_DETAIL_MAX_CHARS - 1).trimEnd()}…`;
}

function thumbnailCacheKey(projectId: string, artifactId: string, revisionId: string): string {
  return `${projectId}\u0000${artifactId}\u0000${revisionId}`;
}

function thumbnailCache(api: ApiClient): Map<string, ThumbnailCacheEntry> {
  const cache = thumbnailCacheByApi.get(api) ?? new Map<string, ThumbnailCacheEntry>();
  thumbnailCacheByApi.set(api, cache);
  return cache;
}

function trimThumbnailCache(cache: Map<string, ThumbnailCacheEntry>): void {
  while (cache.size > MAX_CACHED_THUMBNAILS) {
    const disposable = [...cache].find(([, entry]) => (
      !entry.pending || entry.consumers === 0
    ));
    if (disposable === undefined) return;
    const [key, entry] = disposable;
    cache.delete(key);
    if (entry.pending) entry.controller.abort();
  }
}

function readThumbnail(
  api: ApiClient,
  projectId: string,
  artifactId: string,
  revisionId: string,
): ThumbnailLease {
  const cache = thumbnailCache(api);
  const key = thumbnailCacheKey(projectId, artifactId, revisionId);
  let entry = cache.get(key);
  if (entry?.controller.signal.aborted) {
    cache.delete(key);
    entry = undefined;
  }
  if (entry) {
    cache.delete(key);
    cache.set(key, entry);
  } else {
    const controller = new AbortController();
    let created!: ThumbnailCacheEntry;
    const request = withRequestDeadline(
      controller.signal,
      "Thumbnail preparation timed out. Try again.",
      (signal) => api.getArtifactThumbnail(projectId, artifactId, revisionId, signal),
    )
      .then((blob) => {
        created.pending = false;
        trimThumbnailCache(cache);
        return blob;
      }, (error: unknown) => {
        if (cache.get(key) === created) cache.delete(key);
        throw error;
      });
    created = {
      pending: true,
      request,
      controller,
      consumers: 0,
    };
    entry = created;
    cache.set(key, created);
    trimThumbnailCache(cache);
  }

  entry.consumers += 1;
  let released = false;
  return {
    request: entry.request,
    release: () => {
      if (released) return;
      released = true;
      entry!.consumers -= 1;
      if (!entry!.pending || entry!.consumers !== 0) return;
      // Semantic zoom can tear down and recreate the same preview in one render turn.
      // Deferring cancellation preserves that shared request while still stopping work
      // as soon as the final real consumer leaves the canvas.
      queueMicrotask(() => {
        if (
          entry!.pending
          && entry!.consumers === 0
          && cache.get(key) === entry
        ) {
          cache.delete(key);
          entry!.controller.abort();
        }
      });
    },
  };
}

function invalidateThumbnail(api: ApiClient, projectId: string, artifactId: string, revisionId: string): void {
  const cache = thumbnailCache(api);
  const key = thumbnailCacheKey(projectId, artifactId, revisionId);
  const entry = cache.get(key);
  cache.delete(key);
  if (entry?.pending) entry.controller.abort();
}

export function ArtifactNodePreview({
  artifactKind,
  projectId,
  artifactId,
  name,
  revisionId,
  zoomLevel = "full",
  generationState = "idle",
  generationMessage = null,
}: {
  artifactKind: ArtifactKind;
  projectId: string | null;
  artifactId: string | null;
  name: string;
  revisionId: string | null;
  zoomLevel?: SemanticZoomLevel;
  generationState?: WorkspaceFlowNodeData["generationState"];
  generationMessage?: string | null;
}) {
  const api = useApi();
  const [attempt, setAttempt] = useState(0);
  const [request, setRequest] = useState<ThumbnailRequestState>(IDLE_REQUEST);
  const [loadedObjectUrl, setLoadedObjectUrl] = useState<string | null>(null);
  const [failedObjectUrl, setFailedObjectUrl] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const hasPublishedRevision = projectId !== null
    && artifactId !== null
    && revisionId !== null;
  const [hasEnteredPreloadMargin, setHasEnteredPreloadMargin] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  const enabled = hasPublishedRevision && hasEnteredPreloadMargin;
  const requestKey = enabled
    ? `${projectId}\u0000${artifactId}\u0000${revisionId}\u0000${attempt}`
    : "idle";

  useEffect(() => setAttempt(0), [artifactId, projectId, revisionId]);

  useEffect(() => {
    if (!hasPublishedRevision || hasEnteredPreloadMargin) return;
    const preview = previewRef.current;
    if (preview === null || typeof IntersectionObserver === "undefined") {
      setHasEnteredPreloadMargin(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setHasEnteredPreloadMargin(true);
      observer.disconnect();
    }, { rootMargin: "480px" });
    observer.observe(preview);
    return () => observer.disconnect();
  }, [hasEnteredPreloadMargin, hasPublishedRevision]);

  useEffect(() => {
    if (!enabled || projectId === null || artifactId === null || revisionId === null) {
      setRequest(IDLE_REQUEST);
      return;
    }
    let objectUrl: string | null = null;
    let retryTimer: number | null = null;
    let disposed = false;
    setLoadedObjectUrl(null);
    setFailedObjectUrl(null);
    setRequest([requestKey, "loading", null]);
    const lease = readThumbnail(api, projectId, artifactId, revisionId);
    void lease.request
      .then((blob) => {
        if (disposed) return;
        objectUrl = URL.createObjectURL(blob);
        setRequest([requestKey, "ready", objectUrl]);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        if (
          attempt < THUMBNAIL_RETRY_DELAYS_MS.length
          && error instanceof ApiError
          && [404, 502, 503, 504].includes(error.status)
        ) {
          retryTimer = window.setTimeout(
            () => setAttempt((value) => value + 1),
            THUMBNAIL_RETRY_DELAYS_MS[attempt],
          );
          return;
        }
        setRequest([requestKey, "error", null]);
      });
    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      lease.release();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [api, artifactId, enabled, projectId, requestKey, revisionId]);

  const visibleRequest = request[0] === requestKey
    ? request
    : enabled
      ? [requestKey, "loading", null] as const
      : IDLE_REQUEST;
  const visibleObjectUrl = visibleRequest[2];
  const imageReady = visibleObjectUrl !== null
    && loadedObjectUrl === visibleObjectUrl
    && failedObjectUrl !== visibleObjectUrl;
  const imageFailed = visibleObjectUrl !== null
    && failedObjectUrl === visibleObjectUrl;
  const unpublishedState = generationState === "awaiting-selection" || generationState === "idle"
    ? "empty"
    : generationState;
  const visualState = revisionId === null
      ? unpublishedState
    : visibleRequest[1] === "error" || imageFailed
      ? "error"
      : imageReady
        ? "ready"
        : "loading";
  const KindIcon = artifactKind === "page" ? PanelTop : Component;
  const kindLabel = artifactKind === "page" ? "Page" : "Component";
  const quietLoading = zoomLevel !== "full";
  const busy = visualState === "loading" || visualState === "queued" || visualState === "running";
  const previewMessage = visualState === "empty" ? "Not generated"
    : visualState === "queued" ? "Queued for generation"
      : visualState === "running" ? "Generating…"
        : visualState === "complete" ? "Generated · syncing revision"
          : visualState === "failed" ? "Generation failed"
            : visualState === "blocked" ? "Blocked by dependency"
              : visualState === "cancelled" ? "Generation cancelled"
                : visualState === "error" ? "Preview unavailable"
                  : visualState === "loading" ? "Rendering preview…"
                    : null;

  return (
    <div
      ref={previewRef}
      className={`dezin-flow-card__preview${zoomLevel === "overview" ? " dezin-flow-card__preview--overview" : ""}`}
      data-artifact-kind={artifactKind}
      data-state={visualState}
      role="group"
      aria-label={`${kindLabel} preview for ${name}`}
      aria-busy={busy || undefined}
    >
      {visibleObjectUrl !== null && (
        <img
          key={visibleObjectUrl}
          src={visibleObjectUrl}
          alt={`${name} design preview`}
          draggable={false}
          decoding="async"
          width={280}
          height={160}
          data-ready={imageReady || undefined}
          onLoad={() => setLoadedObjectUrl(visibleObjectUrl)}
          onError={() => setFailedObjectUrl(visibleObjectUrl)}
        />
      )}
      {zoomLevel === "overview" ? (
        <span className="dezin-flow-card__kind dezin-flow-card__overview-kind">
          <KindIcon size={11} aria-hidden />
          {kindLabel}
        </span>
      ) : null}
      {visualState !== "ready" && (
        <div
          className="dezin-flow-card__placeholder"
          data-state={visualState}
          data-motion={visualState === "loading" && quietLoading ? "quiet" : undefined}
          title={generationMessage ?? undefined}
        >
          {busy
            ? quietLoading
              ? <KindIcon className="dezin-flow-card__preview-static" size={17} strokeWidth={1.5} aria-hidden />
              : <LoaderCircle className="dezin-flow-card__preview-spinner" size={17} strokeWidth={1.5} aria-hidden />
            : visualState === "error" || visualState === "failed" || visualState === "blocked"
              ? <ImageOff size={17} strokeWidth={1.5} aria-hidden />
              : <KindIcon size={17} strokeWidth={1.5} aria-hidden />}
          <span>{previewMessage}</span>
          {revisionId === null
            && generationMessage
            && zoomLevel === "full"
            && visualState === "failed" ? (
            <small title={generationMessage}>{boundedCanvasFailureDetail(generationMessage)}</small>
          ) : null}
          {visualState === "error" && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="nodrag nopan dezin-flow-card__preview-retry"
              aria-label={`Retry ${name} preview`}
              onPointerDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                if (projectId !== null && artifactId !== null && revisionId !== null) {
                  invalidateThumbnail(api, projectId, artifactId, revisionId);
                }
                setAttempt((value) => value + 1);
              }}
            >
              <RotateCcw size={11} aria-hidden />
              Retry
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
