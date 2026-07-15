import type {
  ArtifactKind,
  ArtifactRevisionRecord,
  Store,
  WorkspaceBundle,
  WorkspaceSnapshotRecord,
} from "../../../packages/core/src/index.ts";
import {
  acquireMaterializedRenderAssembly,
  buildRenderAssembly,
  compareCodeUnits,
  ComponentFixtureContractError,
  ComponentInstanceRuntimeContractError,
  ComponentRevisionBindingConflictError,
  stablePreviewHash,
  type RenderAssembly,
} from "./render-assembly.ts";
import {
  previewLeaseManager,
  type PreviewLease,
  type PreviewLeaseManager,
} from "./preview-lease.ts";
import {
  disposePreviewRuntimeState,
  ensureDevServer,
  type PreviewRuntimeOptions,
} from "./project-runtime.ts";

export type PreviewTarget =
  | { kind: "artifact-current"; projectId: string; artifactId: string; trackId?: string }
  | { kind: "artifact-revision"; projectId: string; revisionId: string }
  | { kind: "run-candidate"; projectId: string; runId: string }
  | { kind: "workspace-flow"; projectId: string; snapshotId: string; startArtifactId: string }
  | {
    kind: "component-state";
    projectId: string;
    revisionId: string;
    variantKey: string;
    stateKey: string;
  };

export class PreviewTargetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewTargetValidationError";
  }
}

export class PreviewTargetNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewTargetNotFoundError";
  }
}

export class PreviewTargetConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewTargetConflictError";
  }
}

export interface ResolvedPreviewTarget {
  version: 1;
  targetKey: string;
  requestedKind: PreviewTarget["kind"];
  projectId: string;
  workspaceId: string;
  artifactId: string;
  artifactKind: ArtifactKind;
  revisionId: string;
  trackId: string;
  snapshotId: string | null;
  sourceCommitHash: string;
  sourceTreeHash: string;
  dependencyLockHash: string;
  assemblyHash: string;
  artifactRoot: string;
  renderSpec: Record<string, unknown>;
  variantKey: string | null;
  stateKey: string | null;
  runId: string | null;
}

export interface PreviewTargetResolverDeps {
  store: Store;
  /** Required only when the resolved closure contains immutable Resource payloads. */
  dataDir?: string;
}

export interface PreviewTargetLeaseDeps extends PreviewTargetResolverDeps {
  dataDir: string;
  previewLeaseManager?: PreviewLeaseManager;
  ensureDevServer?: (
    projectId: string,
    artifactDir: string,
    runtimeKey?: string,
    signal?: AbortSignal,
    leaseManager?: PreviewLeaseManager,
    options?: PreviewRuntimeOptions,
  ) => Promise<PreviewLease>;
}

export interface PreviewTargetLease extends PreviewLease {
  resolved: ResolvedPreviewTarget;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PreviewTargetValidationError("PreviewTarget must be an object");
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PreviewTargetValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

function nullableStringField(value: unknown, field: string): string | null {
  return value === null ? null : stringField(value, field);
}

function artifactKindField(value: unknown): ArtifactKind {
  switch (value) {
    case "page":
    case "component":
      return value;
    default:
      throw new PreviewTargetValidationError("artifactKind must be a supported Artifact kind");
  }
}

function renderSpecField(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PreviewTargetValidationError("renderSpec must be an object");
  }
  return value as Record<string, unknown>;
}

function rejectUnexpectedFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allow = new Set(allowed);
  for (const field of Object.keys(value)) {
    if (!allow.has(field)) throw new PreviewTargetValidationError(`unexpected field ${field}`);
  }
}

export function parsePreviewTarget(value: unknown): PreviewTarget {
  const input = record(value);
  const kind = stringField(input.kind, "kind");
  const projectId = stringField(input.projectId, "projectId");
  switch (kind) {
    case "artifact-current": {
      rejectUnexpectedFields(input, ["kind", "projectId", "artifactId", "trackId"]);
      const trackId = input.trackId === undefined ? undefined : stringField(input.trackId, "trackId");
      return {
        kind,
        projectId,
        artifactId: stringField(input.artifactId, "artifactId"),
        ...(trackId === undefined ? {} : { trackId }),
      };
    }
    case "artifact-revision":
      rejectUnexpectedFields(input, ["kind", "projectId", "revisionId"]);
      return { kind, projectId, revisionId: stringField(input.revisionId, "revisionId") };
    case "run-candidate":
      rejectUnexpectedFields(input, ["kind", "projectId", "runId"]);
      return { kind, projectId, runId: stringField(input.runId, "runId") };
    case "workspace-flow":
      rejectUnexpectedFields(input, ["kind", "projectId", "snapshotId", "startArtifactId"]);
      return {
        kind,
        projectId,
        snapshotId: stringField(input.snapshotId, "snapshotId"),
        startArtifactId: stringField(input.startArtifactId, "startArtifactId"),
      };
    case "component-state":
      rejectUnexpectedFields(input, ["kind", "projectId", "revisionId", "variantKey", "stateKey"]);
      return {
        kind,
        projectId,
        revisionId: stringField(input.revisionId, "revisionId"),
        variantKey: stringField(input.variantKey, "variantKey"),
        stateKey: stringField(input.stateKey, "stateKey"),
      };
    default:
      throw new PreviewTargetValidationError(`unsupported PreviewTarget kind ${kind}`);
  }
}

const RESOLVED_PREVIEW_TARGET_FIELDS = [
  "version",
  "targetKey",
  "requestedKind",
  "projectId",
  "workspaceId",
  "artifactId",
  "artifactKind",
  "revisionId",
  "trackId",
  "snapshotId",
  "sourceCommitHash",
  "sourceTreeHash",
  "dependencyLockHash",
  "assemblyHash",
  "artifactRoot",
  "renderSpec",
  "variantKey",
  "stateKey",
  "runId",
] as const;

/** Strictly parse the immutable transport form accepted by lease acquisition. */
export function parseResolvedPreviewTarget(value: unknown): ResolvedPreviewTarget {
  const input = record(value);
  rejectUnexpectedFields(input, RESOLVED_PREVIEW_TARGET_FIELDS);
  if (input.version !== 1) {
    throw new PreviewTargetValidationError("resolved Preview Target version must be 1");
  }
  const requestedKind = stringField(input.requestedKind, "requestedKind");
  if (![
    "artifact-current",
    "artifact-revision",
    "run-candidate",
    "workspace-flow",
    "component-state",
  ].includes(requestedKind)) {
    throw new PreviewTargetValidationError("requestedKind must be a supported PreviewTarget kind");
  }
  return {
    version: 1,
    targetKey: stringField(input.targetKey, "targetKey"),
    requestedKind: requestedKind as PreviewTarget["kind"],
    projectId: stringField(input.projectId, "projectId"),
    workspaceId: stringField(input.workspaceId, "workspaceId"),
    artifactId: stringField(input.artifactId, "artifactId"),
    artifactKind: artifactKindField(input.artifactKind),
    revisionId: stringField(input.revisionId, "revisionId"),
    trackId: stringField(input.trackId, "trackId"),
    snapshotId: nullableStringField(input.snapshotId, "snapshotId"),
    sourceCommitHash: stringField(input.sourceCommitHash, "sourceCommitHash"),
    sourceTreeHash: stringField(input.sourceTreeHash, "sourceTreeHash"),
    dependencyLockHash: stringField(input.dependencyLockHash, "dependencyLockHash"),
    assemblyHash: stringField(input.assemblyHash, "assemblyHash"),
    artifactRoot: stringField(input.artifactRoot, "artifactRoot"),
    renderSpec: renderSpecField(input.renderSpec),
    variantKey: nullableStringField(input.variantKey, "variantKey"),
    stateKey: nullableStringField(input.stateKey, "stateKey"),
    runId: nullableStringField(input.runId, "runId"),
  };
}

function snapshotForRevision(
  bundle: WorkspaceBundle,
  artifactId: string,
  revisionId: string,
): WorkspaceSnapshotRecord | null {
  return bundle.snapshots
    .filter((snapshot) => snapshot.artifactRevisions[artifactId] === revisionId)
    .sort((left, right) => left.sequence - right.sequence || compareCodeUnits(left.id, right.id))
    .at(-1) ?? null;
}

function ownedRevision(bundle: WorkspaceBundle, revisionId: string): ArtifactRevisionRecord {
  const revision = bundle.revisions.find((candidate) => candidate.id === revisionId);
  if (!revision || revision.workspaceId !== bundle.workspace.id) {
    throw new PreviewTargetNotFoundError("Preview Target Artifact Revision was not found");
  }
  return revision;
}

interface RevisionResolution {
  revision: ArtifactRevisionRecord;
  snapshot: WorkspaceSnapshotRecord | null;
  variantKey: string | null;
  stateKey: string | null;
  runId: string | null;
}

function buildPreviewAssembly(
  store: Store,
  projectId: string,
  revisionId: string,
  variantKey: string | null,
  stateKey: string | null,
  dataDir?: string,
): RenderAssembly {
  try {
    return buildRenderAssembly(store, {
      projectId,
      revisionId,
      ...(variantKey === null || stateKey === null
        ? {}
        : { componentState: { variantKey, stateKey } }),
    }, dataDir === undefined ? {} : { dataDir });
  } catch (error) {
    if (error instanceof ComponentFixtureContractError
      || error instanceof ComponentInstanceRuntimeContractError
      || error instanceof ComponentRevisionBindingConflictError) {
      throw new PreviewTargetConflictError(error.message);
    }
    throw error;
  }
}

function resolveRevision(
  deps: PreviewTargetResolverDeps,
  bundle: WorkspaceBundle,
  target: PreviewTarget,
): RevisionResolution {
  switch (target.kind) {
    case "artifact-current": {
      const artifact = bundle.artifacts.find((candidate) => candidate.id === target.artifactId);
      if (!artifact || artifact.workspaceId !== bundle.workspace.id || artifact.archivedAt !== null) {
        throw new PreviewTargetNotFoundError("Preview Target Artifact was not found");
      }
      const trackId = target.trackId ?? artifact.activeTrackId;
      if (trackId === null) throw new PreviewTargetNotFoundError("Preview Target Artifact has no active Track");
      const track = bundle.tracks.find((candidate) => candidate.id === trackId && candidate.artifactId === artifact.id);
      if (!track || track.headRevisionId === null) {
        throw new PreviewTargetNotFoundError("Preview Target Artifact Track has no current Revision");
      }
      const revision = ownedRevision(bundle, track.headRevisionId);
      return {
        revision,
        snapshot: snapshotForRevision(bundle, artifact.id, revision.id),
        variantKey: null,
        stateKey: null,
        runId: null,
      };
    }
    case "artifact-revision": {
      const revision = ownedRevision(bundle, target.revisionId);
      return {
        revision,
        snapshot: snapshotForRevision(bundle, revision.artifactId, revision.id),
        variantKey: null,
        stateKey: null,
        runId: null,
      };
    }
    case "run-candidate": {
      const run = deps.store.getRun(target.runId);
      if (!run || run.projectId !== target.projectId) {
        throw new PreviewTargetNotFoundError("Preview Target candidate Run was not found");
      }
      const revisions = bundle.revisions.filter((revision) => revision.producedByRunId === target.runId);
      if (revisions.length === 0) {
        throw new PreviewTargetNotFoundError("Preview Target candidate Run has no Artifact Revision");
      }
      if (revisions.length !== 1) {
        throw new PreviewTargetConflictError("Preview Target candidate Run resolves to multiple Artifact Revisions");
      }
      const revision = revisions[0]!;
      return {
        revision,
        snapshot: snapshotForRevision(bundle, revision.artifactId, revision.id),
        variantKey: null,
        stateKey: null,
        runId: target.runId,
      };
    }
    case "workspace-flow": {
      const snapshot = bundle.snapshots.find((candidate) => candidate.id === target.snapshotId);
      if (!snapshot || snapshot.workspaceId !== bundle.workspace.id) {
        throw new PreviewTargetNotFoundError("Preview Target Workspace Snapshot was not found");
      }
      const artifact = bundle.artifacts.find((candidate) => candidate.id === target.startArtifactId);
      if (!artifact || artifact.workspaceId !== bundle.workspace.id) {
        throw new PreviewTargetNotFoundError("Preview Target flow start Artifact was not found");
      }
      if (artifact.kind !== "page") {
        throw new PreviewTargetValidationError("Preview Target flow must start from a Page Artifact");
      }
      const revisionId = snapshot.artifactRevisions[artifact.id];
      if (revisionId === undefined || revisionId === null) {
        throw new PreviewTargetNotFoundError("Preview Target flow Snapshot has no start Artifact Revision");
      }
      return {
        revision: ownedRevision(bundle, revisionId),
        snapshot,
        variantKey: null,
        stateKey: null,
        runId: null,
      };
    }
    case "component-state": {
      const revision = ownedRevision(bundle, target.revisionId);
      const artifact = bundle.artifacts.find((candidate) => candidate.id === revision.artifactId);
      if (!artifact || artifact.kind !== "component") {
        throw new PreviewTargetValidationError("Preview Target component-state requires a Component Revision");
      }
      return {
        revision,
        snapshot: snapshotForRevision(bundle, revision.artifactId, revision.id),
        variantKey: target.variantKey,
        stateKey: target.stateKey,
        runId: null,
      };
    }
  }
}

export async function resolvePreviewTarget(
  deps: PreviewTargetResolverDeps,
  unsafeTarget: PreviewTarget | unknown,
): Promise<ResolvedPreviewTarget> {
  const target = parsePreviewTarget(unsafeTarget);
  const bundle = deps.store.workspace.getBundleByProjectId(target.projectId);
  if (!bundle) throw new PreviewTargetNotFoundError("Preview Target project Workspace was not found");
  const resolution = resolveRevision(deps, bundle, target);
  const artifact = bundle.artifacts.find((candidate) => candidate.id === resolution.revision.artifactId);
  if (!artifact || artifact.workspaceId !== bundle.workspace.id) {
    throw new PreviewTargetNotFoundError("Preview Target owning Artifact was not found");
  }
  const assembly = buildPreviewAssembly(
    deps.store,
    target.projectId,
    resolution.revision.id,
    resolution.variantKey,
    resolution.stateKey,
    deps.dataDir,
  );
  const targetKey = `preview-target-v1:${stablePreviewHash("dezin-preview-target-v1", {
    requestedKind: target.kind,
    projectId: target.projectId,
    workspaceId: bundle.workspace.id,
    artifactId: artifact.id,
    revisionId: resolution.revision.id,
    snapshotId: resolution.snapshot?.id ?? null,
    variantKey: resolution.variantKey,
    stateKey: resolution.stateKey,
    runId: resolution.runId,
    assemblyHash: assembly.assemblyHash,
  })}`;
  return {
    version: 1,
    targetKey,
    requestedKind: target.kind,
    projectId: target.projectId,
    workspaceId: bundle.workspace.id,
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    revisionId: resolution.revision.id,
    trackId: resolution.revision.trackId,
    snapshotId: resolution.snapshot?.id ?? null,
    sourceCommitHash: resolution.revision.sourceCommitHash,
    sourceTreeHash: resolution.revision.sourceTreeHash,
    dependencyLockHash: assembly.dependencyLockHash,
    assemblyHash: assembly.assemblyHash,
    artifactRoot: resolution.revision.artifactRoot,
    renderSpec: resolution.revision.renderSpec,
    variantKey: resolution.variantKey,
    stateKey: resolution.stateKey,
    runId: resolution.runId,
  };
}

function targetKeyFor(resolved: Omit<ResolvedPreviewTarget, "targetKey">): string {
  return `preview-target-v1:${stablePreviewHash("dezin-preview-target-v1", {
    requestedKind: resolved.requestedKind,
    projectId: resolved.projectId,
    workspaceId: resolved.workspaceId,
    artifactId: resolved.artifactId,
    revisionId: resolved.revisionId,
    snapshotId: resolved.snapshotId,
    variantKey: resolved.variantKey,
    stateKey: resolved.stateKey,
    runId: resolved.runId,
    assemblyHash: resolved.assemblyHash,
  })}`;
}

function immutableIdentityChanged(): never {
  throw new PreviewTargetConflictError(
    "resolved Preview Target no longer matches its immutable assembly",
  );
}

function equalJson(left: unknown, right: unknown): boolean {
  return stablePreviewHash("dezin-preview-transport-equality-v1", left)
    === stablePreviewHash("dezin-preview-transport-equality-v1", right);
}

/**
 * Revalidate the server-issued resolved DTO without resolving any moving Head.
 * In particular, artifact-current remains pinned to the revision selected by
 * resolvePreviewTarget even if the Track advances before lease acquisition.
 */
export function revalidateResolvedPreviewTarget(
  deps: PreviewTargetResolverDeps,
  unsafeResolved: ResolvedPreviewTarget | unknown,
): ResolvedPreviewTarget {
  const resolved = parseResolvedPreviewTarget(unsafeResolved);
  const bundle = deps.store.workspace.getBundleByProjectId(resolved.projectId);
  if (!bundle || bundle.workspace.id !== resolved.workspaceId) immutableIdentityChanged();
  const revision = bundle.revisions.find((candidate) => candidate.id === resolved.revisionId);
  const artifact = bundle.artifacts.find((candidate) => candidate.id === resolved.artifactId);
  if (
    !revision
    || revision.workspaceId !== resolved.workspaceId
    || revision.artifactId !== resolved.artifactId
    || revision.trackId !== resolved.trackId
    || revision.sourceCommitHash !== resolved.sourceCommitHash
    || revision.sourceTreeHash !== resolved.sourceTreeHash
    || revision.artifactRoot !== resolved.artifactRoot
    || !equalJson(revision.renderSpec, resolved.renderSpec)
    || !artifact
    || artifact.workspaceId !== resolved.workspaceId
    || artifact.kind !== resolved.artifactKind
  ) immutableIdentityChanged();

  const snapshot = resolved.snapshotId === null
    ? null
    : bundle.snapshots.find((candidate) => candidate.id === resolved.snapshotId);
  if (
    resolved.snapshotId !== null
    && (!snapshot
      || snapshot.workspaceId !== resolved.workspaceId
      || snapshot.artifactRevisions[resolved.artifactId] !== resolved.revisionId)
  ) immutableIdentityChanged();

  switch (resolved.requestedKind) {
    case "component-state":
      if (
        resolved.artifactKind !== "component"
        || resolved.variantKey === null
        || resolved.stateKey === null
        || resolved.runId !== null
      ) immutableIdentityChanged();
      break;
    case "workspace-flow":
      if (
        resolved.artifactKind !== "page"
        || resolved.snapshotId === null
        || resolved.variantKey !== null
        || resolved.stateKey !== null
        || resolved.runId !== null
      ) immutableIdentityChanged();
      break;
    case "run-candidate": {
      const run = resolved.runId === null ? null : deps.store.getRun(resolved.runId);
      if (
        !run
        || run.projectId !== resolved.projectId
        || revision.producedByRunId !== resolved.runId
        || resolved.variantKey !== null
        || resolved.stateKey !== null
      ) immutableIdentityChanged();
      break;
    }
    case "artifact-current":
      if (
        artifact.archivedAt !== null
        || resolved.variantKey !== null
        || resolved.stateKey !== null
        || resolved.runId !== null
      ) immutableIdentityChanged();
      break;
    case "artifact-revision":
      if (
        resolved.variantKey !== null
        || resolved.stateKey !== null
        || resolved.runId !== null
      ) immutableIdentityChanged();
      break;
  }

  const assembly = buildPreviewAssembly(
    deps.store,
    resolved.projectId,
    resolved.revisionId,
    resolved.variantKey,
    resolved.stateKey,
    deps.dataDir,
  );
  if (
    assembly.workspaceId !== resolved.workspaceId
    || assembly.artifactId !== resolved.artifactId
    || assembly.dependencyLockHash !== resolved.dependencyLockHash
    || assembly.assemblyHash !== resolved.assemblyHash
  ) immutableIdentityChanged();
  const { targetKey: _targetKey, ...withoutTargetKey } = resolved;
  if (targetKeyFor(withoutTargetKey) !== resolved.targetKey) immutableIdentityChanged();
  return resolved;
}

/** Materialize an immutable assembly and acquire its independently keyed preview lease. */
export async function acquirePreviewTargetLease(
  deps: PreviewTargetLeaseDeps,
  unsafeResolved: ResolvedPreviewTarget | unknown,
  signal?: AbortSignal,
): Promise<PreviewTargetLease> {
  signal?.throwIfAborted();
  const resolved = revalidateResolvedPreviewTarget(deps, unsafeResolved);
  const assembly = buildPreviewAssembly(
    deps.store,
    resolved.projectId,
    resolved.revisionId,
    resolved.variantKey,
    resolved.stateKey,
    deps.dataDir,
  );
  const materialized = await acquireMaterializedRenderAssembly(deps, assembly, signal);
  let lease: PreviewLease;
  try {
    signal?.throwIfAborted();
    lease = await (deps.ensureDevServer ?? ensureDevServer)(
      resolved.projectId,
      materialized.artifactDir,
      assembly.runtimeKey,
      signal,
      deps.previewLeaseManager ?? previewLeaseManager,
      {
        immutableSource: true,
        disposeOnIdle: true,
        onLeaseRelease: materialized.release,
        onEntryDispose: () => disposePreviewRuntimeState(assembly.runtimeKey),
        runtimeIdentity: {
          artifactId: resolved.artifactId,
          revisionId: resolved.revisionId,
          sourceTreeHash: resolved.sourceTreeHash,
          dependencyLockHash: resolved.dependencyLockHash,
        },
      },
    );
  } catch (error) {
    await Promise.allSettled([
      materialized.release(),
      disposePreviewRuntimeState(assembly.runtimeKey),
    ]);
    throw error;
  }
  try {
    signal?.throwIfAborted();
  } catch (error) {
    await lease.release();
    await materialized.release();
    throw error;
  }
  return {
    ...lease,
    resolved,
    release: async () => {
      await lease.release();
      await materialized.release();
    },
  };
}
