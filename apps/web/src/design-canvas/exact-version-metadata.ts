import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { DesignCanvasApi } from "./api.ts";
import type { DesignNodeVersion } from "./types.ts";

export type ExactVersionMetadataStatus = "idle" | "loading" | "ready" | "error";

export interface ExactVersionMetadataSnapshot {
  status: ExactVersionMetadataStatus;
  metadata: DesignNodeVersion | null;
}

interface MetadataEntry {
  snapshot: ExactVersionMetadataSnapshot;
  listeners: Set<() => void>;
  pending: Promise<void> | null;
}

const EMPTY_SNAPSHOT: ExactVersionMetadataSnapshot = { status: "idle", metadata: null };
const stores = new WeakMap<DesignCanvasApi, Map<string, MetadataEntry>>();

function cacheKey(projectId: string, nodeId: string, versionId: string): string {
  return `${projectId}:${nodeId}:${versionId}`;
}

function storeFor(api: DesignCanvasApi): Map<string, MetadataEntry> {
  let store = stores.get(api);
  if (!store) {
    store = new Map();
    stores.set(api, store);
  }
  return store;
}

function entryFor(api: DesignCanvasApi, key: string): MetadataEntry {
  const store = storeFor(api);
  let entry = store.get(key);
  if (!entry) {
    entry = { snapshot: EMPTY_SNAPSHOT, listeners: new Set(), pending: null };
    store.set(key, entry);
  }
  return entry;
}

function publish(entry: MetadataEntry, snapshot: ExactVersionMetadataSnapshot): void {
  entry.snapshot = snapshot;
  for (const listener of entry.listeners) listener();
}

function loadExactVersionMetadata(
  api: DesignCanvasApi,
  projectId: string,
  nodeId: string,
  versionId: string,
): Promise<void> {
  const key = cacheKey(projectId, nodeId, versionId);
  const requested = entryFor(api, key);
  if (requested.snapshot.status === "ready") return Promise.resolve();
  if (requested.pending) return requested.pending;

  publish(requested, { status: "loading", metadata: requested.snapshot.metadata });
  const pending = api.listNodeVersions(projectId, nodeId).then((versions) => {
    const store = storeFor(api);
    for (const version of versions) {
      const versionEntry = entryFor(api, cacheKey(projectId, nodeId, version.id));
      versionEntry.pending = null;
      publish(versionEntry, { status: "ready", metadata: version });
    }
    if (!versions.some((version) => version.id === versionId)) {
      publish(requested, { status: "ready", metadata: null });
    }
    // Keep the requested entry reachable even if the versions loop did not touch it.
    store.set(key, requested);
  }).catch(() => {
    if (requested.snapshot.status !== "ready") {
      publish(requested, { status: "error", metadata: null });
    }
  }).finally(() => {
    requested.pending = null;
  });
  requested.pending = pending;
  return pending;
}

export function readExactVersionMetadata({
  api,
  projectId,
  nodeId,
  versionId,
}: {
  api: DesignCanvasApi;
  projectId: string;
  nodeId: string;
  versionId: string | null;
}): DesignNodeVersion | null {
  if (!versionId) return null;
  return storeFor(api).get(cacheKey(projectId, nodeId, versionId))?.snapshot.metadata ?? null;
}

export function useExactVersionMetadata({
  api,
  projectId,
  nodeId,
  versionId,
  enabled = true,
}: {
  api: DesignCanvasApi;
  projectId: string;
  nodeId: string | null;
  versionId: string | null;
  enabled?: boolean;
}): ExactVersionMetadataSnapshot {
  const key = enabled && nodeId && versionId ? cacheKey(projectId, nodeId, versionId) : null;
  const subscribe = useCallback((listener: () => void) => {
    if (!key) return () => undefined;
    const entry = entryFor(api, key);
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }, [api, key]);
  const getSnapshot = useCallback(
    () => key ? entryFor(api, key).snapshot : EMPTY_SNAPSHOT,
    [api, key],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!key || !nodeId || !versionId) return;
    void loadExactVersionMetadata(api, projectId, nodeId, versionId);
  }, [api, key, nodeId, projectId, versionId]);

  return snapshot;
}
