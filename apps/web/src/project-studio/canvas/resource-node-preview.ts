import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient, WorkspaceResourceKind } from "../../lib/api.ts";
import { useApi } from "../../lib/api-context.tsx";
import { withRequestDeadline } from "../../lib/request-deadline.ts";

export interface ResourceNodeRevisionBinding {
  workspaceId: string;
  resourceId: string;
  revisionId: string;
  resourceKind: WorkspaceResourceKind;
}

export type ResourceNodeRevisionPreview =
  | {
      kind: "moodboard";
      boardName: string;
      cover: {
        assetId: string;
        path: string;
        blob: Blob;
        alt: string;
        width: number | null;
        height: number | null;
      } | null;
      assetCount: number;
    }
  | {
      kind: "research";
      executiveSummary: string;
      findingCount: number;
      evidenceDirectionCount: number;
      hypothesisDirectionCount: number;
    };

export type ResourceNodeRevisionPreviewStatus = "loading" | "refreshing" | "ready" | "error";

export interface ResourceNodeRevisionPreviewState {
  binding: ResourceNodeRevisionBinding;
  status: ResourceNodeRevisionPreviewStatus;
  preview: ResourceNodeRevisionPreview | null;
  error: Error | null;
}

export interface ResourceNodeRevisionPreviewsController {
  states: Readonly<Record<string, ResourceNodeRevisionPreviewState>>;
  retry: (resourceId: string) => void;
}

type ResourceRevisionPreviewApi = Pick<
  ApiClient,
  "getResourceRevisionView" | "getResourceRevisionBlob"
>;

interface InternalResourceNodeRevisionPreviewState extends ResourceNodeRevisionPreviewState {
  api: ResourceRevisionPreviewApi;
  projectId: string;
  requestKey: string;
}

interface ActivePreviewRequest {
  api: ResourceRevisionPreviewApi;
  requestKey: string;
  controller: AbortController;
}

function resourcePreviewBindingKey(
  projectId: string,
  binding: ResourceNodeRevisionBinding,
): string {
  return [
    projectId,
    binding.workspaceId,
    binding.resourceId,
    binding.revisionId,
    binding.resourceKind,
  ].join("\u0000");
}

function previewLoadError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("The Resource preview could not be loaded.");
}

export async function loadResourceNodeRevisionPreview(
  api: ResourceRevisionPreviewApi,
  projectId: string,
  binding: ResourceNodeRevisionBinding,
  signal?: AbortSignal,
): Promise<ResourceNodeRevisionPreview | null> {
  signal?.throwIfAborted();
  const view = await withRequestDeadline(
    signal,
    "Resource preview timed out. Try again.",
    (requestSignal) => api.getResourceRevisionView(
      projectId,
      binding.resourceId,
      binding.revisionId,
      requestSignal,
    ),
  );
  signal?.throwIfAborted();
  if (
    view.resource.workspaceId !== binding.workspaceId
    || view.revision.workspaceId !== binding.workspaceId
    || view.resource.id !== binding.resourceId
    || view.resource.kind !== binding.resourceKind
    || view.revision.id !== binding.revisionId
    || view.revision.resourceId !== binding.resourceId
    || view.kind !== binding.resourceKind
  ) {
    throw new Error("Resource Revision preview identity does not match the active canvas binding.");
  }
  if (view.kind === "research") {
    return {
      kind: "research",
      executiveSummary: view.content.executiveSummary.slice(0, 240),
      findingCount: view.content.findings.length,
      evidenceDirectionCount: view.content.evidenceDirectionCount,
      hypothesisDirectionCount: view.content.hypothesisDirectionCount,
    };
  }
  if (view.kind !== "moodboard") return null;

  const coverAssetId = view.content.board.coverAssetId;
  const coverAsset = coverAssetId === null
    ? null
    : view.content.assets.find((asset) => asset.id === coverAssetId) ?? null;
  let cover: Extract<ResourceNodeRevisionPreview, { kind: "moodboard" }>["cover"] = null;
  if (coverAsset?.url && coverAsset.mimeType.startsWith("image/")) {
    const blob = await withRequestDeadline(
      signal,
      "Moodboard cover preview timed out. Try again.",
      (requestSignal) => api.getResourceRevisionBlob(coverAsset.url!, requestSignal),
    );
    signal?.throwIfAborted();
    if (blob.size !== coverAsset.byteLength) {
      throw new Error("Moodboard cover bytes do not match the exact Resource Revision.");
    }
    if (blob.type && blob.type.toLowerCase() !== coverAsset.mimeType.toLowerCase()) {
      throw new Error("Moodboard cover MIME does not match the exact Resource Revision.");
    }
    cover = {
      assetId: coverAsset.id,
      path: coverAsset.url,
      blob,
      alt: `${view.content.board.name} cover`,
      width: coverAsset.width,
      height: coverAsset.height,
    };
  }
  return {
    kind: "moodboard",
    boardName: view.content.board.name,
    cover,
    assetCount: view.content.totalAssetCount,
  };
}

export function useResourceNodeRevisionPreviewController(
  projectId: string,
  bindings: readonly ResourceNodeRevisionBinding[],
): ResourceNodeRevisionPreviewsController {
  const api = useApi();
  const [entries, setEntries] = useState<Record<string, InternalResourceNodeRevisionPreviewState>>({});
  const entriesRef = useRef(entries);
  const [retryVersions, setRetryVersions] = useState<Record<string, number>>({});
  const activeRequestsRef = useRef(new Map<string, ActivePreviewRequest>());

  const commitEntries = useCallback((
    update: (
      current: Readonly<Record<string, InternalResourceNodeRevisionPreviewState>>,
    ) => Record<string, InternalResourceNodeRevisionPreviewState>,
  ): void => {
    const current = entriesRef.current;
    const next = update(current);
    if (next === current) return;
    entriesRef.current = next;
    setEntries(next);
  }, []);

  useEffect(() => {
    const desired = new Map(bindings.map((binding) => {
      const bindingKey = resourcePreviewBindingKey(projectId, binding);
      return [
        binding.resourceId,
        {
          binding,
          requestKey: `${bindingKey}\u0000${retryVersions[binding.resourceId] ?? 0}`,
        },
      ] as const;
    }));

    for (const [resourceId, request] of activeRequestsRef.current) {
      const next = desired.get(resourceId);
      if (next !== undefined && request.api === api && request.requestKey === next.requestKey) continue;
      request.controller.abort();
      activeRequestsRef.current.delete(resourceId);
    }
    commitEntries((current) => {
      let changed = Object.keys(current).length !== desired.size;
      const next: Record<string, InternalResourceNodeRevisionPreviewState> = {};
      for (const [resourceId, { binding, requestKey }] of desired) {
        const previous = current[resourceId];
        if (
          previous !== undefined
          && previous.api === api
          && previous.requestKey === requestKey
        ) {
          next[resourceId] = previous;
          continue;
        }

        const canPreserveLastGood = previous !== undefined
          && previous.projectId === projectId
          && previous.binding.workspaceId === binding.workspaceId
          && previous.binding.resourceId === binding.resourceId
          && previous.binding.revisionId === binding.revisionId
          && previous.binding.resourceKind === binding.resourceKind;
        const preview = canPreserveLastGood ? previous.preview : null;
        next[resourceId] = {
          api,
          projectId,
          binding: { ...binding },
          requestKey,
          status: preview === null ? "loading" : "refreshing",
          preview,
          error: null,
        };
        changed = true;
      }
      return changed ? next : current as Record<string, InternalResourceNodeRevisionPreviewState>;
    });

    for (const [resourceId, { binding, requestKey }] of desired) {
      const active = activeRequestsRef.current.get(resourceId);
      if (active?.api === api && active.requestKey === requestKey) continue;
      const current = entriesRef.current[resourceId];
      if (
        current?.api === api
        && current.requestKey === requestKey
        && (current.status === "ready" || current.status === "error")
      ) continue;

      const controller = new AbortController();
      const request = { api, requestKey, controller };
      activeRequestsRef.current.set(resourceId, request);
      const finish = (
        patch: Pick<ResourceNodeRevisionPreviewState, "status">
          & Partial<Pick<ResourceNodeRevisionPreviewState, "preview" | "error">>,
      ): void => {
        if (controller.signal.aborted || activeRequestsRef.current.get(resourceId) !== request) return;
        activeRequestsRef.current.delete(resourceId);
        commitEntries((current) => {
          const existing = current[resourceId];
          if (existing === undefined || existing.requestKey !== requestKey) {
            return current as Record<string, InternalResourceNodeRevisionPreviewState>;
          }
          return {
            ...current,
            [resourceId]: { ...existing, ...patch },
          };
        });
      };
      void loadResourceNodeRevisionPreview(api, projectId, binding, controller.signal)
        .then((preview) => {
          finish({ status: "ready", preview, error: null });
        })
        .catch((error: unknown) => {
          finish({ status: "error", error: previewLoadError(error) });
        });
    }
  }, [api, bindings, commitEntries, projectId, retryVersions]);

  useEffect(() => () => {
    for (const request of activeRequestsRef.current.values()) {
      request.controller.abort();
    }
    activeRequestsRef.current.clear();
  }, []);

  const retry = useCallback((resourceId: string): void => {
    setRetryVersions((current) => ({
      ...current,
      [resourceId]: (current[resourceId] ?? 0) + 1,
    }));
  }, []);

  const visibleStates = useMemo<Readonly<Record<string, ResourceNodeRevisionPreviewState>>>(() => {
    const next: Record<string, ResourceNodeRevisionPreviewState> = {};
    for (const binding of bindings) {
      const requestKey = `${resourcePreviewBindingKey(projectId, binding)}\u0000${retryVersions[binding.resourceId] ?? 0}`;
      const current = entries[binding.resourceId];
      if (
        current !== undefined
        && current.api === api
        && current.projectId === projectId
        && current.requestKey === requestKey
      ) {
        next[binding.resourceId] = current;
        continue;
      }
      const sameImmutableBinding = current !== undefined
        && current.projectId === projectId
        && current.binding.workspaceId === binding.workspaceId
        && current.binding.resourceId === binding.resourceId
        && current.binding.revisionId === binding.revisionId
        && current.binding.resourceKind === binding.resourceKind;
      const preview = sameImmutableBinding ? current.preview : null;
      next[binding.resourceId] = {
        binding: { ...binding },
        status: preview === null ? "loading" : "refreshing",
        preview,
        error: null,
      };
    }
    return next;
  }, [api, bindings, entries, projectId, retryVersions]);

  return {
    states: visibleStates,
    retry,
  };
}

export function useResourceNodeRevisionPreviews(
  projectId: string,
  bindings: readonly ResourceNodeRevisionBinding[],
): Readonly<Record<string, ResourceNodeRevisionPreview>> {
  const { states } = useResourceNodeRevisionPreviewController(projectId, bindings);
  return useMemo(() => Object.fromEntries(
    Object.entries(states).flatMap(([resourceId, state]) => (
      state.preview === null ? [] : [[resourceId, state.preview]]
    )),
  ), [states]);
}
