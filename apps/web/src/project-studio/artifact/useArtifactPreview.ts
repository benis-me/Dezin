import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "../../lib/api-context.tsx";
import type {
  PreviewTarget,
  PreviewTargetLease,
  ResolvedPreviewTarget,
} from "../../lib/api.ts";
import { previewBridgeNonceForSrc } from "../../lib/preview-channel.ts";

const RENEW_WINDOW_MS = 15_000;
const MIN_RENEW_DELAY_MS = 1_000;

export type ArtifactPreviewState =
  | { status: "idle"; resolved: null; lease: null; error: null }
  | { status: "loading"; resolved: ResolvedPreviewTarget | null; lease: null; error: null }
  | { status: "ready"; resolved: ResolvedPreviewTarget; lease: PreviewTargetLease; error: null }
  | { status: "error"; resolved: ResolvedPreviewTarget | null; lease: null; error: string };

export type ArtifactPreviewController = ArtifactPreviewState & {
  readOnly: boolean;
  retry: () => void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : "The artifact preview could not be prepared.";
}

function targetIdentity(target: PreviewTarget | null): string {
  if (target === null) return "none";
  switch (target.kind) {
    case "artifact-current":
      return `${target.kind}:${target.projectId}:${target.artifactId}:${target.trackId ?? ""}`;
    case "artifact-revision":
      return `${target.kind}:${target.projectId}:${target.revisionId}`;
    case "run-candidate":
      return `${target.kind}:${target.projectId}:${target.runId}`;
    case "generation-candidate":
      return `${target.kind}:${target.projectId}:${target.artifactId}:${target.planId}:${target.taskId}:${target.attempt}`;
    case "workspace-flow":
      return `${target.kind}:${target.projectId}:${target.snapshotId}:${target.startArtifactId}:${target.stateKey ?? ""}`;
    case "component-state":
      return `${target.kind}:${target.projectId}:${target.revisionId}:${target.variantKey}:${target.stateKey}`;
  }
}

const IDLE_STATE: ArtifactPreviewState = { status: "idle", resolved: null, lease: null, error: null };
const LOADING_STATE: ArtifactPreviewState = { status: "loading", resolved: null, lease: null, error: null };

interface PreviewStateEnvelope {
  requestKey: string;
  state: ArtifactPreviewState;
}

function resolutionError(
  target: PreviewTarget,
  resolved: ResolvedPreviewTarget,
  projectId: string,
  expectedArtifactId: string | undefined,
  expectedRevisionId: string | undefined,
  expectedWorkspaceId: string | undefined,
  expectedRenderSpec: Readonly<Record<string, unknown>> | undefined,
): string | null {
  if (resolved.projectId !== projectId) return "Resolved preview belongs to a different project.";
  if (resolved.requestedKind !== target.kind) return "Resolved preview kind does not match the requested target.";
  if (expectedWorkspaceId !== undefined && resolved.workspaceId !== expectedWorkspaceId) {
    return "Resolved preview does not match the frozen Snapshot workspace.";
  }
  const targetArtifactId = target.kind === "artifact-current"
    ? target.artifactId
    : target.kind === "generation-candidate"
      ? target.artifactId
    : target.kind === "workspace-flow"
      ? target.startArtifactId
      : expectedArtifactId;
  if ((targetArtifactId && resolved.artifactId !== targetArtifactId)
    || (expectedArtifactId && resolved.artifactId !== expectedArtifactId)) {
    return "Resolved preview belongs to a different artifact.";
  }
  if (target.kind === "artifact-current"
    && target.trackId
    && resolved.trackId !== target.trackId) {
    return "Resolved preview track does not match the requested target.";
  }
  if ((target.kind === "artifact-revision" || target.kind === "component-state")
    && resolved.revisionId !== target.revisionId) {
    return "Resolved preview revision does not match the requested target.";
  }
  if (expectedRevisionId !== undefined && resolved.revisionId !== expectedRevisionId) {
    return "Resolved preview does not match the frozen Snapshot Revision.";
  }
  if (expectedRenderSpec !== undefined
    && canonicalJson(resolved.renderSpec) !== canonicalJson(expectedRenderSpec)) {
    return "Resolved preview does not match the frozen Snapshot RenderSpec.";
  }
  if (target.kind === "workspace-flow" && resolved.snapshotId !== target.snapshotId) {
    return "Resolved preview Snapshot does not match the requested target.";
  }
  if (target.kind === "workspace-flow" && resolved.stateKey !== (target.stateKey ?? null)) {
    return "Resolved preview state does not match the requested frozen target.";
  }
  if (target.kind === "run-candidate" && resolved.runId !== target.runId) {
    return "Resolved preview run does not match the requested target.";
  }
  if (target.kind === "generation-candidate") {
    const identity = resolved.generationCandidate;
    if (identity === undefined
      || identity === null
      || identity.planId !== target.planId
      || identity.taskId !== target.taskId
      || identity.attempt !== target.attempt) {
      return "Resolved preview Generation candidate does not match the requested Attempt.";
    }
  }
  if (target.kind === "component-state"
    && (resolved.variantKey !== target.variantKey || resolved.stateKey !== target.stateKey)) {
    return "Resolved component state does not match the requested target.";
  }
  return null;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (nested === null || Array.isArray(nested) || typeof nested !== "object") return nested;
    return Object.fromEntries(
      Object.entries(nested as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    );
  }) ?? "";
}

function sameResolvedIdentity(first: ResolvedPreviewTarget, second: ResolvedPreviewTarget): boolean {
  return first.version === second.version
    && first.targetKey === second.targetKey
    && first.requestedKind === second.requestedKind
    && first.projectId === second.projectId
    && first.workspaceId === second.workspaceId
    && first.artifactId === second.artifactId
    && first.artifactKind === second.artifactKind
    && first.revisionId === second.revisionId
    && first.trackId === second.trackId
    && first.snapshotId === second.snapshotId
    && first.sourceCommitHash === second.sourceCommitHash
    && first.sourceTreeHash === second.sourceTreeHash
    && first.dependencyLockHash === second.dependencyLockHash
    && first.assemblyHash === second.assemblyHash
    && first.artifactRoot === second.artifactRoot
    && canonicalJson(first.renderSpec) === canonicalJson(second.renderSpec)
    && first.variantKey === second.variantKey
    && first.stateKey === second.stateKey
    && first.runId === second.runId
    && canonicalJson(first.generationCandidate ?? null)
      === canonicalJson(second.generationCandidate ?? null);
}

function leaseBridgeError(lease: Pick<PreviewTargetLease, "leaseId" | "url" | "bridgeNonce">): string | null {
  if (typeof lease.leaseId !== "string" || !lease.leaseId.trim()) return "Preview lease identity is missing.";
  if (typeof lease.url !== "string"
    || typeof lease.bridgeNonce !== "string"
    || !/^[a-zA-Z0-9_-]{43}$/.test(lease.bridgeNonce)) {
    return "Preview bridge capability is missing or invalid.";
  }
  if (previewBridgeNonceForSrc(lease.url) !== lease.bridgeNonce) {
    return "Preview bridge capability does not match the leased URL.";
  }
  return null;
}

export function useArtifactPreview({
  projectId,
  target,
  expectedArtifactId,
  expectedRevisionId,
  expectedWorkspaceId,
  expectedRenderSpec,
  enabled = true,
}: {
  projectId: string;
  target: PreviewTarget | null;
  expectedArtifactId?: string;
  expectedRevisionId?: string;
  expectedWorkspaceId?: string;
  expectedRenderSpec?: Readonly<Record<string, unknown>>;
  enabled?: boolean;
}): ArtifactPreviewController {
  const api = useApi();
  const [envelope, setEnvelope] = useState<PreviewStateEnvelope>({ requestKey: "none:0", state: IDLE_STATE });
  const [attempt, setAttempt] = useState(0);
  const requestIdRef = useRef(0);
  const targetRef = useRef(target);
  targetRef.current = target;
  const identity = useMemo(() => targetIdentity(target), [target]);
  const expectedRenderSpecKey = expectedRenderSpec === undefined ? "" : canonicalJson(expectedRenderSpec);
  const requestKey = `${identity}\u0000${expectedArtifactId ?? ""}\u0000${expectedRevisionId ?? ""}\u0000${expectedWorkspaceId ?? ""}\u0000${expectedRenderSpecKey}\u0000${attempt}`;
  const readOnly = target !== null && target.kind !== "artifact-current";
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    const currentTarget = targetRef.current;
    let disposed = false;
    let ownedLease: PreviewTargetLease | null = null;
    let renewTimer: ReturnType<typeof setTimeout> | null = null;
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;
    const acquisitionController = new AbortController();
    let renewController: AbortController | null = null;
    let resolvedTarget: ResolvedPreviewTarget | null = null;

    const isCurrent = () => !disposed && requestId === requestIdRef.current;
    const commit = (state: ArtifactPreviewState): void => {
      if (isCurrent()) setEnvelope({ requestKey, state });
    };
    const release = (lease: PreviewTargetLease): void => {
      void api.releasePreviewTargetLease(lease.leaseId).catch(() => {});
    };

    const clearLeaseTimers = (): void => {
      if (renewTimer !== null) clearTimeout(renewTimer);
      if (expiryTimer !== null) clearTimeout(expiryTimer);
      renewTimer = null;
      expiryTimer = null;
    };

    const failOwnedLease = (lease: PreviewTargetLease, error: string): void => {
      if (!isCurrent() || ownedLease?.leaseId !== lease.leaseId) return;
      ownedLease = null;
      clearLeaseTimers();
      renewController?.abort();
      renewController = null;
      release(lease);
      commit({ status: "error", resolved: lease.resolved, lease: null, error });
    };

    const armExpiry = (lease: PreviewTargetLease): boolean => {
      if (expiryTimer !== null) clearTimeout(expiryTimer);
      expiryTimer = null;
      const remaining = lease.expiresAt - Date.now();
      if (!Number.isFinite(lease.expiresAt) || remaining <= 0) {
        failOwnedLease(lease, "Preview lease expired before renewal completed.");
        return false;
      }
      expiryTimer = setTimeout(() => {
        failOwnedLease(lease, "Preview lease expired before renewal completed.");
      }, remaining);
      return true;
    };

    const scheduleRenewal = (lease: PreviewTargetLease): void => {
      if (!isCurrent() || ownedLease?.leaseId !== lease.leaseId || !armExpiry(lease)) return;
      if (renewTimer !== null) clearTimeout(renewTimer);
      const remaining = lease.expiresAt - Date.now();
      const delay = remaining <= RENEW_WINDOW_MS
        ? Math.min(MIN_RENEW_DELAY_MS, Math.max(0, Math.floor(remaining / 2)))
        : remaining - RENEW_WINDOW_MS;
      renewTimer = setTimeout(() => {
        if (!isCurrent() || ownedLease?.leaseId !== lease.leaseId) return;
        const controller = new AbortController();
        renewController = controller;
        void api.renewPreviewTargetLease(lease.leaseId, controller.signal)
          .then((renewed) => {
            if (renewController === controller) renewController = null;
            if (!isCurrent() || ownedLease?.leaseId !== lease.leaseId) return;
            if (renewed.leaseId !== lease.leaseId
              || renewed.url !== lease.url
              || renewed.bridgeNonce !== lease.bridgeNonce
              || leaseBridgeError({ ...lease, ...renewed }) !== null) {
              failOwnedLease(lease, "Renewed preview lease changed its bridge capability.");
              return;
            }
            if (!Number.isFinite(renewed.expiresAt) || renewed.expiresAt <= Date.now()) {
              failOwnedLease(lease, "Renewed preview lease is already expired.");
              return;
            }
            const next: PreviewTargetLease = { ...lease, ...renewed };
            ownedLease = next;
            commit({ status: "ready", resolved: next.resolved, lease: next, error: null });
            scheduleRenewal(next);
          })
          .catch((error: unknown) => {
            if (renewController === controller) renewController = null;
            if (!isCurrent() || ownedLease?.leaseId !== lease.leaseId) return;
            failOwnedLease(lease, errorMessage(error));
          });
      }, delay);
    };

    if (!enabled || currentTarget === null) {
      commit(IDLE_STATE);
      return () => {
        disposed = true;
      };
    }

    if (currentTarget.projectId !== projectId) {
      commit({ status: "error", resolved: null, lease: null, error: "Preview target does not belong to this project." });
      return () => {
        disposed = true;
      };
    }

    commit(LOADING_STATE);
    void api.resolvePreviewTarget(projectId, currentTarget, acquisitionController.signal)
      .then(async (resolved) => {
        if (!isCurrent()) return;
        resolvedTarget = resolved;
        const mismatch = resolutionError(
          currentTarget,
          resolved,
          projectId,
          expectedArtifactId,
          expectedRevisionId,
          expectedWorkspaceId,
          expectedRenderSpec,
        );
        if (mismatch) throw new Error(mismatch);
        commit({ status: "loading", resolved, lease: null, error: null });
        const acquired = await api.acquirePreviewTargetLease(projectId, resolved, acquisitionController.signal);
        if (!isCurrent()) {
          release(acquired);
          return;
        }
        if (!sameResolvedIdentity(resolved, acquired.resolved)) {
          release(acquired);
          throw new Error("Acquired preview identity does not match the resolved target.");
        }
        const bridgeError = leaseBridgeError(acquired);
        if (bridgeError !== null) {
          release(acquired);
          throw new Error(bridgeError);
        }
        if (!Number.isFinite(acquired.expiresAt) || acquired.expiresAt <= Date.now()) {
          release(acquired);
          throw new Error("Acquired preview lease is already expired.");
        }
        ownedLease = acquired;
        commit({ status: "ready", resolved: acquired.resolved, lease: acquired, error: null });
        scheduleRenewal(acquired);
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        commit({
          status: "error",
          resolved: resolvedTarget,
          lease: null,
          error: errorMessage(error),
        });
      });

    return () => {
      disposed = true;
      acquisitionController.abort();
      clearLeaseTimers();
      renewController?.abort();
      renewController = null;
      if (ownedLease !== null) release(ownedLease);
      ownedLease = null;
    };
  }, [
    api,
    enabled,
    expectedArtifactId,
    expectedRenderSpec,
    expectedRevisionId,
    expectedWorkspaceId,
    projectId,
    requestKey,
  ]);

  const visibleState = !enabled || target === null
    ? IDLE_STATE
    : target.projectId !== projectId
      ? { status: "error" as const, resolved: null, lease: null, error: "Preview target does not belong to this project." }
      : envelope.requestKey === requestKey
        ? envelope.state
        : LOADING_STATE;
  return { ...visibleState, readOnly, retry };
}
