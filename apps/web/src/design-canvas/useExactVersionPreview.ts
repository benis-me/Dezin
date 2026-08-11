import { useEffect, useMemo, useState } from "react";

import type { DesignCanvasApi } from "./api.ts";
import type { DesignNode, ExactVersionPreview } from "./types.ts";

const previewCache = new Map<string, ExactVersionPreview>();

interface ExactVersionPreviewState {
  cacheKey: string | null;
  preview: ExactVersionPreview | null;
  loading: boolean;
  error: string | null;
}

export function previewVersionIdForNode(node: DesignNode): string | null {
  return node.selectedVersionId ?? node.currentVersionId;
}

export function useExactVersionPreview({
  api,
  projectId,
  node,
  enabled,
}: {
  api: DesignCanvasApi;
  projectId: string;
  node: DesignNode;
  enabled: boolean;
}): {
  versionId: string | null;
  preview: ExactVersionPreview | null;
  loading: boolean;
  error: string | null;
} {
  const versionId = previewVersionIdForNode(node);
  const [state, setState] = useState<ExactVersionPreviewState>({
    cacheKey: null,
    preview: null,
    loading: false,
    error: null,
  });
  const cacheKey = useMemo(() => (
    versionId ? `${projectId}:${node.id}:${versionId}` : null
  ), [node.id, projectId, versionId]);

  useEffect(() => {
    if (!enabled || !versionId || !cacheKey) return;
    let active = true;
    const controller = new AbortController();
    const cached = previewCache.get(cacheKey);
    if (cached) {
      setState({ cacheKey, preview: cached, loading: false, error: null });
      return () => controller.abort();
    }
    setState({ cacheKey, preview: null, loading: true, error: null });
    void api.getExactVersionPreview(projectId, node.id, versionId, controller.signal).then((lease) => {
      if (lease.nodeId !== node.id || lease.versionId !== versionId) {
        throw new Error("Preview lease did not match the requested node revision.");
      }
      previewCache.set(cacheKey, lease);
      if (!active) return;
      setState({ cacheKey, preview: lease, loading: false, error: null });
    }).catch((problem: unknown) => {
      if (!active || controller.signal.aborted) return;
      setState({
        cacheKey,
        preview: null,
        loading: false,
        error: problem instanceof Error ? problem.message : String(problem),
      });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [api, cacheKey, enabled, node.id, projectId, versionId]);

  if (!enabled || !versionId || !cacheKey) {
    return { versionId, preview: null, loading: false, error: null };
  }
  if (state.cacheKey !== cacheKey) {
    return { versionId, preview: null, loading: true, error: null };
  }
  return { versionId, preview: state.preview, loading: state.loading, error: state.error };
}
