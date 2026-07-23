import type {
  ArtifactKind,
  ArtifactRevisionRecord,
  Store,
  WorkspaceSnapshotRecord,
} from "../../../packages/core/src/index.ts";
import {
  acquireMaterializedRenderAssembly,
  buildRenderAssembly,
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
  | { kind: "workspace-flow"; projectId: string; snapshotId: string; startArtifactId: string; stateKey?: string }
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

function stateKeyField(value: unknown): string {
  const stateKey = stringField(value, "stateKey");
  if (stateKey.length > 256 || /[\u0000-\u001f\u007f]/.test(stateKey)) {
    throw new PreviewTargetValidationError("stateKey must be at most 256 characters without control characters");
  }
  return stateKey;
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
    case "workspace-flow": {
      rejectUnexpectedFields(input, ["kind", "projectId", "snapshotId", "startArtifactId", "stateKey"]);
      const stateKey = input.stateKey === undefined ? undefined : stateKeyField(input.stateKey);
      return {
        kind,
        projectId,
        snapshotId: stringField(input.snapshotId, "snapshotId"),
        startArtifactId: stringField(input.startArtifactId, "startArtifactId"),
        ...(stateKey === undefined ? {} : { stateKey }),
      };
    }
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
  deps: PreviewTargetResolverDeps,
  projectId: string,
  workspaceId: string,
  artifactId: string,
  revisionId: string,
): WorkspaceSnapshotRecord | null {
  const snapshot = deps.store.workspace.getLatestSnapshotForArtifactRevision(
    projectId,
    artifactId,
    revisionId,
  );
  if (snapshot && snapshot.workspaceId !== workspaceId) {
    throw new PreviewTargetNotFoundError("Preview Target Workspace Snapshot was not found");
  }
  return snapshot;
}

function publishedSnapshotForRevision(
  deps: PreviewTargetResolverDeps,
  projectId: string,
  workspaceId: string,
  artifactId: string,
  revisionId: string,
): WorkspaceSnapshotRecord {
  const snapshot = snapshotForRevision(deps, projectId, workspaceId, artifactId, revisionId);
  if (snapshot === null) {
    throw new PreviewTargetNotFoundError(
      "Preview Target formal Revision was not published in a sealed Workspace Snapshot",
    );
  }
  return snapshot;
}

function ownedRevision(
  deps: PreviewTargetResolverDeps,
  workspaceId: string,
  revisionId: string,
): ArtifactRevisionRecord {
  const revision = deps.store.workspace.getArtifactRevision(revisionId);
  if (!revision || revision.workspaceId !== workspaceId) {
    throw new PreviewTargetNotFoundError("Preview Target Artifact Revision was not found");
  }
  return revision;
}

interface RevisionResolution {
  revision: ArtifactRevisionRecord;
  snapshot: WorkspaceSnapshotRecord | null;
  boundedCurrent: boolean;
  variantKey: string | null;
  stateKey: string | null;
  runId: string | null;
}

function validateWorkspaceFlowState(renderSpec: Record<string, unknown>, stateKey: string | null): void {
  if (stateKey === null) return;
  const frames = renderSpec.frames;
  if (!Array.isArray(frames) || frames.length === 0 || frames.length > 64) {
    throw new PreviewTargetValidationError(`Preview Target flow Revision has no exact RenderSpec state ${stateKey}`);
  }
  let matches = 0;
  for (const value of frames) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)
      && (value as Record<string, unknown>).initialState === stateKey) matches += 1;
  }
  if (matches === 0) {
    throw new PreviewTargetValidationError(`Preview Target flow RenderSpec state ${stateKey} does not exist`);
  }
}

function buildPreviewAssembly(
  store: Store,
  projectId: string,
  revisionId: string,
  variantKey: string | null,
  stateKey: string | null,
  dataDir?: string,
  shallowSnapshotId?: string,
): RenderAssembly {
  try {
    return buildRenderAssembly(store, {
      projectId,
      revisionId,
      ...(variantKey === null || stateKey === null
        ? {}
        : { componentState: { variantKey, stateKey } }),
    }, {
      ...(dataDir === undefined ? {} : { dataDir }),
      ...(shallowSnapshotId === undefined ? {} : { shallowSnapshotId }),
    });
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
  workspaceId: string,
  target: PreviewTarget,
): RevisionResolution {
  switch (target.kind) {
    case "artifact-current": {
      const artifact = deps.store.workspace.getArtifact(target.artifactId);
      if (!artifact || artifact.workspaceId !== workspaceId || artifact.archivedAt !== null) {
        throw new PreviewTargetNotFoundError("Preview Target Artifact was not found");
      }
      const requestedActiveTrack = target.trackId === undefined || target.trackId === artifact.activeTrackId;
      if (requestedActiveTrack) {
        const bundle = deps.store.workspace.getCompactBundleByProjectId(target.projectId);
        const currentArtifact = bundle?.artifacts.find((candidate) => candidate.id === target.artifactId);
        if (!bundle || bundle.workspace.id !== workspaceId || !currentArtifact
          || currentArtifact.archivedAt !== null) {
          throw new PreviewTargetNotFoundError("Preview Target Artifact was not found");
        }
        // An explicit Track can cease to be active between the identity read
        // above and the aggregate read. In that case it is an exact historical
        // Track request and must keep the full-lineage path below.
        if (target.trackId === undefined || target.trackId === currentArtifact.activeTrackId) {
          const trackId = currentArtifact.activeTrackId;
          if (trackId === null) {
            throw new PreviewTargetNotFoundError("Preview Target Artifact has no active Track");
          }
          const revisionId = bundle.activeSnapshot.artifactRevisions[currentArtifact.id];
          const snapshotTrackId = bundle.activeSnapshot.artifactTracks[currentArtifact.id];
          const track = bundle.tracks.find((candidate) => candidate.id === trackId);
          const revision = revisionId == null
            ? undefined
            : bundle.revisions.find((candidate) => candidate.id === revisionId);
          if (snapshotTrackId !== trackId || !track || track.artifactId !== currentArtifact.id
            || track.headRevisionId !== revisionId || !revision
            || revision.workspaceId !== workspaceId
            || revision.artifactId !== currentArtifact.id
            || revision.trackId !== trackId) {
            throw new PreviewTargetNotFoundError("Preview Target Artifact Track has no current Revision");
          }
          return {
            revision,
            snapshot: bundle.activeSnapshot,
            boundedCurrent: true,
            variantKey: null,
            stateKey: null,
            runId: null,
          };
        }
      }
      const trackId = target.trackId;
      if (trackId === undefined) {
        throw new PreviewTargetNotFoundError("Preview Target Artifact has no active Track");
      }
      const track = deps.store.workspace.getTrack(trackId);
      if (!track || track.headRevisionId === null) {
        throw new PreviewTargetNotFoundError("Preview Target Artifact Track has no current Revision");
      }
      if (track.artifactId !== artifact.id) {
        throw new PreviewTargetNotFoundError("Preview Target Artifact Track was not found");
      }
      const revision = ownedRevision(deps, workspaceId, track.headRevisionId);
      return {
        revision,
        snapshot: publishedSnapshotForRevision(
          deps,
          target.projectId,
          workspaceId,
          artifact.id,
          revision.id,
        ),
        boundedCurrent: false,
        variantKey: null,
        stateKey: null,
        runId: null,
      };
    }
    case "artifact-revision": {
      const revision = ownedRevision(deps, workspaceId, target.revisionId);
      return {
        revision,
        snapshot: publishedSnapshotForRevision(
          deps,
          target.projectId,
          workspaceId,
          revision.artifactId,
          revision.id,
        ),
        boundedCurrent: false,
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
      const revisions = deps.store.workspace.listArtifactRevisionsProducedByRun(
        target.projectId,
        target.runId,
        2,
      );
      if (revisions.length === 0) {
        throw new PreviewTargetNotFoundError("Preview Target candidate Run has no Artifact Revision");
      }
      if (revisions.length !== 1) {
        throw new PreviewTargetConflictError("Preview Target candidate Run resolves to multiple Artifact Revisions");
      }
      const revision = revisions[0]!;
      return {
        revision,
        snapshot: snapshotForRevision(
          deps,
          target.projectId,
          workspaceId,
          revision.artifactId,
          revision.id,
        ),
        boundedCurrent: false,
        variantKey: null,
        stateKey: null,
        runId: target.runId,
      };
    }
    case "workspace-flow": {
      const snapshot = deps.store.workspace.getSnapshotForProject(target.projectId, target.snapshotId);
      if (!snapshot || snapshot.workspaceId !== workspaceId) {
        throw new PreviewTargetNotFoundError("Preview Target Workspace Snapshot was not found");
      }
      const artifact = deps.store.workspace.getArtifact(target.startArtifactId);
      if (!artifact || artifact.workspaceId !== workspaceId) {
        throw new PreviewTargetNotFoundError("Preview Target flow start Artifact was not found");
      }
      if (artifact.kind !== "page") {
        throw new PreviewTargetValidationError("Preview Target flow must start from a Page Artifact");
      }
      const revisionId = snapshot.artifactRevisions[artifact.id];
      if (revisionId === undefined || revisionId === null) {
        throw new PreviewTargetNotFoundError("Preview Target flow Snapshot has no start Artifact Revision");
      }
      const revision = ownedRevision(deps, workspaceId, revisionId);
      const stateKey = target.stateKey ?? null;
      validateWorkspaceFlowState(revision.renderSpec, stateKey);
      return {
        revision,
        snapshot,
        boundedCurrent: false,
        variantKey: null,
        stateKey,
        runId: null,
      };
    }
    case "component-state": {
      const revision = ownedRevision(deps, workspaceId, target.revisionId);
      const artifact = deps.store.workspace.getArtifact(revision.artifactId);
      if (!artifact || artifact.workspaceId !== workspaceId || artifact.kind !== "component") {
        throw new PreviewTargetValidationError("Preview Target component-state requires a Component Revision");
      }
      return {
        revision,
        snapshot: publishedSnapshotForRevision(
          deps,
          target.projectId,
          workspaceId,
          revision.artifactId,
          revision.id,
        ),
        boundedCurrent: false,
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
  const workspace = deps.store.workspace.getWorkspace(target.projectId);
  if (!workspace) throw new PreviewTargetNotFoundError("Preview Target project Workspace was not found");
  const resolution = resolveRevision(deps, workspace.id, target);
  const artifact = deps.store.workspace.getArtifact(resolution.revision.artifactId);
  if (!artifact || artifact.workspaceId !== workspace.id) {
    throw new PreviewTargetNotFoundError("Preview Target owning Artifact was not found");
  }
  const assembly = buildPreviewAssembly(
    deps.store,
    target.projectId,
    resolution.revision.id,
    resolution.variantKey,
    resolution.stateKey,
    deps.dataDir,
    resolution.boundedCurrent ? resolution.snapshot?.id : undefined,
  );
  const targetKey = `preview-target-v1:${stablePreviewHash("dezin-preview-target-v1", {
    requestedKind: target.kind,
    projectId: target.projectId,
    workspaceId: workspace.id,
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
    workspaceId: workspace.id,
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
  const workspace = deps.store.workspace.getWorkspace(resolved.projectId);
  if (!workspace || workspace.id !== resolved.workspaceId) immutableIdentityChanged();
  const artifact = deps.store.workspace.getArtifact(resolved.artifactId);
  const useShallowCurrentSnapshot = resolved.requestedKind === "artifact-current"
    && resolved.snapshotId !== null
    && artifact?.activeTrackId === resolved.trackId;
  let assembly = useShallowCurrentSnapshot
    ? buildPreviewAssembly(
      deps.store,
      resolved.projectId,
      resolved.revisionId,
      resolved.variantKey,
      resolved.stateKey,
      deps.dataDir,
      resolved.snapshotId ?? undefined,
    )
    : null;
  const revision = assembly?.rootRevision
    ?? deps.store.workspace.getArtifactRevision(resolved.revisionId);
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
    : useShallowCurrentSnapshot
      ? null
      : deps.store.workspace.getSnapshotForProject(resolved.projectId, resolved.snapshotId);
  if (
    resolved.snapshotId !== null
    && (!useShallowCurrentSnapshot
      && (!snapshot
        || snapshot.workspaceId !== resolved.workspaceId
        || snapshot.artifactRevisions[resolved.artifactId] !== resolved.revisionId))
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
        || resolved.runId !== null
      ) immutableIdentityChanged();
      validateWorkspaceFlowState(revision.renderSpec, resolved.stateKey);
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

  assembly ??= buildPreviewAssembly(
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
  const artifact = deps.store.workspace.getArtifact(resolved.artifactId);
  const shallowSnapshotId = resolved.requestedKind === "artifact-current"
    && artifact?.activeTrackId === resolved.trackId
    ? resolved.snapshotId ?? undefined
    : undefined;
  const assembly = buildPreviewAssembly(
    deps.store,
    resolved.projectId,
    resolved.revisionId,
    resolved.variantKey,
    resolved.stateKey,
    deps.dataDir,
    shallowSnapshotId,
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
