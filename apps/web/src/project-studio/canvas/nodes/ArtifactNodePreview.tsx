import { Component, ImageOff, LoaderCircle, PanelTop, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ApiClient } from "../../../lib/api.ts";
import { useApi } from "../../../lib/api-context.tsx";
import type { SemanticZoomLevel } from "../workspace-graph-adapter.ts";

type ArtifactKind = "page" | "component";

interface ThumbnailRequestState {
  key: string;
  status: "idle" | "loading" | "ready" | "error";
  objectUrl: string | null;
}

const IDLE_REQUEST: ThumbnailRequestState = {
  key: "idle",
  status: "idle",
  objectUrl: null,
};

interface ThumbnailCacheEntry {
  status: "pending" | "ready";
  blob: Blob | null;
  request: Promise<Blob>;
  controller: AbortController;
  consumers: Set<symbol>;
}

interface ThumbnailLease {
  request: Promise<Blob>;
  release: () => void;
}

const MAX_CACHED_THUMBNAILS = 96;
const thumbnailCacheByApi = new WeakMap<ApiClient, Map<string, ThumbnailCacheEntry>>();

function thumbnailCacheKey(projectId: string, artifactId: string, revisionId: string): string {
  return `${projectId}\u0000${artifactId}\u0000${revisionId}`;
}

function thumbnailCache(api: ApiClient): Map<string, ThumbnailCacheEntry> {
  const existing = thumbnailCacheByApi.get(api);
  if (existing) return existing;
  const created = new Map<string, ThumbnailCacheEntry>();
  thumbnailCacheByApi.set(api, created);
  return created;
}

function trimThumbnailCache(cache: Map<string, ThumbnailCacheEntry>): void {
  while (cache.size > MAX_CACHED_THUMBNAILS) {
    const disposable = [...cache].find(([, entry]) => (
      entry.status === "ready" || entry.consumers.size === 0
    ));
    if (disposable === undefined) return;
    const [key, entry] = disposable;
    cache.delete(key);
    if (entry.status === "pending" && !entry.controller.signal.aborted) {
      entry.controller.abort();
    }
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
    const request = api.getArtifactThumbnail(projectId, artifactId, revisionId, controller.signal)
      .then((blob) => {
        created.status = "ready";
        created.blob = blob;
        trimThumbnailCache(cache);
        return blob;
      }, (error: unknown) => {
        if (cache.get(key) === created) cache.delete(key);
        throw error;
      });
    created = {
      status: "pending",
      blob: null,
      request,
      controller,
      consumers: new Set(),
    };
    entry = created;
    cache.set(key, created);
    trimThumbnailCache(cache);
  }

  const consumer = Symbol("thumbnail-consumer");
  entry.consumers.add(consumer);
  let released = false;
  return {
    request: entry.status === "ready" && entry.blob !== null
      ? Promise.resolve(entry.blob)
      : entry.request,
    release: () => {
      if (released) return;
      released = true;
      entry!.consumers.delete(consumer);
      if (entry!.status !== "pending" || entry!.consumers.size !== 0) return;
      // Semantic zoom can tear down and recreate the same preview in one render turn.
      // Deferring cancellation preserves that shared request while still stopping work
      // as soon as the final real consumer leaves the canvas.
      queueMicrotask(() => {
        if (
          entry!.status === "pending"
          && entry!.consumers.size === 0
          && cache.get(key) === entry
        ) {
          cache.delete(key);
          if (!entry!.controller.signal.aborted) entry!.controller.abort();
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
  if (entry?.status === "pending" && !entry.controller.signal.aborted) {
    entry.controller.abort();
  }
}

export function ArtifactNodePreview({
  artifactKind,
  projectId,
  artifactId,
  name,
  revisionId,
  zoomLevel = "full",
}: {
  artifactKind: ArtifactKind;
  projectId: string | null;
  artifactId: string | null;
  name: string;
  revisionId: string | null;
  zoomLevel?: SemanticZoomLevel;
}) {
  const api = useApi();
  const [attempt, setAttempt] = useState(0);
  const [request, setRequest] = useState<ThumbnailRequestState>(IDLE_REQUEST);
  const [loadedObjectUrl, setLoadedObjectUrl] = useState<string | null>(null);
  const [failedObjectUrl, setFailedObjectUrl] = useState<string | null>(null);
  const enabled = zoomLevel !== "overview"
    && projectId !== null
    && artifactId !== null
    && revisionId !== null;
  const requestKey = enabled
    ? `${projectId}\u0000${artifactId}\u0000${revisionId}\u0000${attempt}`
    : "idle";

  useEffect(() => {
    if (!enabled || projectId === null || artifactId === null || revisionId === null) {
      setRequest(IDLE_REQUEST);
      return;
    }
    let objectUrl: string | null = null;
    let disposed = false;
    setLoadedObjectUrl(null);
    setFailedObjectUrl(null);
    setRequest({ key: requestKey, status: "loading", objectUrl: null });
    const lease = readThumbnail(api, projectId, artifactId, revisionId);
    void lease.request
      .then((blob) => {
        if (disposed) return;
        objectUrl = URL.createObjectURL(blob);
        setRequest({ key: requestKey, status: "ready", objectUrl });
      })
      .catch(() => {
        if (!disposed) {
          setRequest({ key: requestKey, status: "error", objectUrl: null });
        }
      });
    return () => {
      disposed = true;
      lease.release();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [api, artifactId, enabled, projectId, requestKey, revisionId]);

  const visibleRequest = request.key === requestKey
    ? request
    : enabled
      ? { key: requestKey, status: "loading" as const, objectUrl: null }
      : IDLE_REQUEST;
  const imageReady = visibleRequest.objectUrl !== null
    && loadedObjectUrl === visibleRequest.objectUrl
    && failedObjectUrl !== visibleRequest.objectUrl;
  const imageFailed = visibleRequest.objectUrl !== null
    && failedObjectUrl === visibleRequest.objectUrl;
  const visualState = zoomLevel === "overview"
    ? "idle"
    : revisionId === null
    ? "empty"
    : visibleRequest.status === "error" || imageFailed
      ? "error"
      : imageReady
        ? "ready"
        : "loading";
  const KindIcon = artifactKind === "page" ? PanelTop : Component;
  const kindLabel = artifactKind === "page" ? "Page" : "Component";
  const quietLoading = zoomLevel === "compact";
  const previewMessage = useMemo(() => {
    if (visualState === "empty") return "Generate to preview";
    if (visualState === "error") return "Preview unavailable";
    if (visualState === "loading") return "Rendering preview…";
    return null;
  }, [visualState]);

  if (zoomLevel === "overview") {
    return (
      <div
        className="dezin-flow-card__preview dezin-flow-card__preview--overview"
        data-artifact-kind={artifactKind}
        data-state="overview"
        role="group"
        aria-label={`${kindLabel} artifact`}
      >
        <span className="dezin-flow-card__kind"><KindIcon size={11} aria-hidden /> {kindLabel}</span>
      </div>
    );
  }

  return (
    <div
      className="dezin-flow-card__preview"
      data-artifact-kind={artifactKind}
      data-state={visualState}
      role="group"
      aria-label={`${kindLabel} preview for ${name}`}
      aria-busy={visualState === "loading" || undefined}
    >
      {visibleRequest.objectUrl !== null && (
        <img
          key={visibleRequest.objectUrl}
          src={visibleRequest.objectUrl}
          alt={`${name} design preview`}
          draggable={false}
          decoding="async"
          width={280}
          height={160}
          data-ready={imageReady || undefined}
          onLoad={() => setLoadedObjectUrl(visibleRequest.objectUrl)}
          onError={() => setFailedObjectUrl(visibleRequest.objectUrl)}
        />
      )}
      {visualState !== "ready" && (
        <div
          className="dezin-flow-card__placeholder"
          data-state={visualState}
          data-motion={visualState === "loading" && quietLoading ? "quiet" : undefined}
        >
          {visualState === "loading"
            ? quietLoading
              ? <KindIcon className="dezin-flow-card__preview-static" size={17} strokeWidth={1.5} aria-hidden />
              : <LoaderCircle className="dezin-flow-card__preview-spinner" size={17} strokeWidth={1.5} aria-hidden />
            : visualState === "error"
              ? <ImageOff size={17} strokeWidth={1.5} aria-hidden />
              : <KindIcon size={17} strokeWidth={1.5} aria-hidden />}
          <span>{previewMessage}</span>
          {visualState === "error" && (
            <button
              type="button"
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
            </button>
          )}
        </div>
      )}
    </div>
  );
}
