import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient, WorkspaceResourceKind } from "../../lib/api.ts";
import { useApi } from "../../lib/api-context.tsx";

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
  previews: Readonly<Record<string, ResourceNodeRevisionPreview>>;
  states: Readonly<Record<string, ResourceNodeRevisionPreviewState>>;
  retry: (resourceId: string) => void;
}

type ResourceRevisionPreviewApi = Pick<ApiClient, "getResourceRevisionView">;

interface InternalResourceNodeRevisionPreviewState extends ResourceNodeRevisionPreviewState {
  projectId: string;
  bindingKey: string;
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
  const view = await api.getResourceRevisionView(
    projectId,
    binding.resourceId,
    binding.revisionId,
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
  const cover = coverAsset?.url && coverAsset.mimeType.startsWith("image/")
    ? {
        assetId: coverAsset.id,
        path: coverAsset.url,
        alt: `${view.content.board.name} cover`,
        width: coverAsset.width,
        height: coverAsset.height,
      }
    : null;
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
  const completedRequestsRef = useRef(new Map<string, {
    api: ResourceRevisionPreviewApi;
    requestKey: string;
  }>());

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
    const desired = new Map(bindings.map((binding) => [
      binding.resourceId,
      {
        binding,
        bindingKey: resourcePreviewBindingKey(projectId, binding),
        requestKey: `${resourcePreviewBindingKey(projectId, binding)}\u0000${retryVersions[binding.resourceId] ?? 0}`,
      },
    ]));

    for (const [resourceId, request] of activeRequestsRef.current) {
      const next = desired.get(resourceId);
      if (next !== undefined && request.api === api && request.requestKey === next.requestKey) continue;
      request.controller.abort();
      activeRequestsRef.current.delete(resourceId);
    }
    for (const resourceId of completedRequestsRef.current.keys()) {
      if (!desired.has(resourceId)) completedRequestsRef.current.delete(resourceId);
    }

    commitEntries((current) => {
      let changed = Object.keys(current).length !== desired.size;
      const next: Record<string, InternalResourceNodeRevisionPreviewState> = {};
      for (const [resourceId, { binding, bindingKey, requestKey }] of desired) {
        const previous = current[resourceId];
        const active = activeRequestsRef.current.get(resourceId);
        const completed = completedRequestsRef.current.get(resourceId);
        const hasCurrentLifecycle = (
          active?.api === api && active.requestKey === requestKey
        ) || (
          completed?.api === api && completed.requestKey === requestKey
        );
        if (
          previous !== undefined
          && previous.bindingKey === bindingKey
          && previous.requestKey === requestKey
          && hasCurrentLifecycle
        ) {
          next[resourceId] = previous;
          continue;
        }

        const canPreserveLastGood = previous !== undefined
          && previous.projectId === projectId
          && previous.binding.workspaceId === binding.workspaceId
          && previous.binding.resourceKind === binding.resourceKind;
        const preview = canPreserveLastGood ? previous.preview : null;
        next[resourceId] = {
          projectId,
          binding: { ...binding },
          bindingKey,
          requestKey,
          status: preview === null ? "loading" : "refreshing",
          preview,
          error: null,
        };
        changed = true;
      }
      return changed ? next : current as Record<string, InternalResourceNodeRevisionPreviewState>;
    });

    for (const [resourceId, { binding, bindingKey, requestKey }] of desired) {
      const active = activeRequestsRef.current.get(resourceId);
      if (active?.api === api && active.requestKey === requestKey) continue;
      const completed = completedRequestsRef.current.get(resourceId);
      if (completed?.api === api && completed.requestKey === requestKey) continue;

      const controller = new AbortController();
      const request = { api, requestKey, controller };
      activeRequestsRef.current.set(resourceId, request);
      void loadResourceNodeRevisionPreview(api, projectId, binding, controller.signal)
        .then((preview) => {
          if (controller.signal.aborted || activeRequestsRef.current.get(resourceId) !== request) return;
          activeRequestsRef.current.delete(resourceId);
          completedRequestsRef.current.set(resourceId, { api, requestKey });
          commitEntries((current) => {
            const existing = current[resourceId];
            if (
              existing === undefined
              || existing.bindingKey !== bindingKey
              || existing.requestKey !== requestKey
            ) return current as Record<string, InternalResourceNodeRevisionPreviewState>;
            return {
              ...current,
              [resourceId]: {
                ...existing,
                status: "ready",
                preview,
                error: null,
              },
            };
          });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || activeRequestsRef.current.get(resourceId) !== request) return;
          activeRequestsRef.current.delete(resourceId);
          completedRequestsRef.current.set(resourceId, { api, requestKey });
          commitEntries((current) => {
            const existing = current[resourceId];
            if (
              existing === undefined
              || existing.bindingKey !== bindingKey
              || existing.requestKey !== requestKey
            ) return current as Record<string, InternalResourceNodeRevisionPreviewState>;
            return {
              ...current,
              [resourceId]: {
                ...existing,
                status: "error",
                error: previewLoadError(error),
              },
            };
          });
        });
    }
  }, [api, bindings, commitEntries, projectId, retryVersions]);

  useEffect(() => () => {
    for (const request of activeRequestsRef.current.values()) {
      request.controller.abort();
    }
    activeRequestsRef.current.clear();
  }, []);

  const states = useMemo(() => Object.fromEntries(
    Object.entries(entries).map(([resourceId, entry]) => {
      const {
        projectId: _projectId,
        bindingKey: _bindingKey,
        requestKey: _requestKey,
        ...state
      } = entry;
      return [resourceId, state];
    }),
  ), [entries]);
  const previews = useMemo(() => Object.fromEntries(
    Object.entries(entries).flatMap(([resourceId, entry]) => (
      entry.preview === null ? [] : [[resourceId, entry.preview]]
    )),
  ), [entries]);
  const retry = useCallback((resourceId: string): void => {
    setRetryVersions((current) => ({
      ...current,
      [resourceId]: (current[resourceId] ?? 0) + 1,
    }));
  }, []);

  return {
    previews,
    states,
    retry,
  };
}

export function useResourceNodeRevisionPreviews(
  projectId: string,
  bindings: readonly ResourceNodeRevisionBinding[],
): Readonly<Record<string, ResourceNodeRevisionPreview>> {
  return useResourceNodeRevisionPreviewController(projectId, bindings).previews;
}
