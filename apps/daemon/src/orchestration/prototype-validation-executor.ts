import type {
  ArtifactRevisionRecord,
  GenerationTaskAttemptClaim,
  GenerationTaskPrototypeMarkerProof,
  ResourceRevision,
  WorkspaceSnapshotRecord,
} from "../../../../packages/core/src/index.ts";
import {
  buildGenerationTaskPrototypeFinalizationBindings,
  buildGenerationTaskPrototypeFinalizationPreparation,
  buildGenerationTaskPrototypeValidationResult,
  GenerationTaskPrototypeValidationError,
  generationTaskPrototypeRuntimeReceiptNonce,
  getGenerationTaskPrototypeValidationRevisionIds,
} from "../../../../packages/core/src/index.ts";
import {
  GenerationTaskExecutionError,
  type PrototypeValidationResult,
  type PrototypeValidationTaskLeafExecutor,
} from "./generation-task-executor.ts";

type Awaitable<T> = T | Promise<T>;

/** The validator deliberately depends only on immutable, read-only records. */
export interface PrototypeValidationStorePort {
  readSnapshot(
    workspaceId: string,
    snapshotId: string,
    signal: AbortSignal,
  ): Awaitable<WorkspaceSnapshotRecord | null>;
  readArtifactRevision(
    workspaceId: string,
    revisionId: string,
    signal: AbortSignal,
  ): Awaitable<ArtifactRevisionRecord | null>;
  readResourceRevision(
    workspaceId: string,
    revisionId: string,
    signal: AbortSignal,
  ): Awaitable<ResourceRevision | null>;
  resolveArtifactMarkers(
    inputs: Array<{
      workspaceId: string;
      artifactId: string;
      revisionId: string;
      sourceMarkerId: string;
      trigger: "click" | "submit";
      receiptNonce: string;
    }>,
    signal: AbortSignal,
  ): Awaitable<GenerationTaskPrototypeMarkerProof[]>;
}

export interface PrototypeValidationExecutorOptions {
  store: PrototypeValidationStorePort;
}

export class PrototypeValidationError extends GenerationTaskExecutionError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super({ failureClass: "qa", message, details });
    this.name = "PrototypeValidationError";
  }
}

function invalid(message: string, details: Record<string, unknown> = {}): never {
  throw new PrototypeValidationError(message, details);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Prototype validation aborted", "AbortError");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(`${label} must be a non-empty string`);
  return value;
}

function useCoreValidation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof GenerationTaskPrototypeValidationError) {
      invalid(error.message, error.details);
    }
    throw error;
  }
}

/**
 * Reads only the Attempt's immutable pins, then delegates the complete result
 * construction to Core so execution and durable completion share one contract.
 */
export class PrototypeValidationExecutor implements PrototypeValidationTaskLeafExecutor {
  private readonly store: PrototypeValidationStorePort;

  constructor(options: PrototypeValidationExecutorOptions) {
    this.store = options.store;
  }

  async execute(claim: GenerationTaskAttemptClaim, signal: AbortSignal): Promise<PrototypeValidationResult> {
    checkAbort(signal);
    const revisionIds = useCoreValidation(() => (
      getGenerationTaskPrototypeValidationRevisionIds(claim.task, claim.attempt)
    ));
    const snapshotId = nonEmptyString(
      claim.attempt.expectedSnapshotId,
      "Prototype validation expected Snapshot id",
    );
    const snapshot = await this.store.readSnapshot(claim.task.workspaceId, snapshotId, signal);
    checkAbort(signal);
    if (snapshot === null) invalid("Immutable prototype validation Snapshot is missing", { snapshotId });

    const artifactRevisions: ArtifactRevisionRecord[] = [];
    const resourceRevisions: ResourceRevision[] = [];
    for (const revisionId of revisionIds.artifactRevisionIds) {
      const revision = await this.store.readArtifactRevision(
        claim.task.workspaceId,
        revisionId,
        signal,
      );
      checkAbort(signal);
      if (revision === null) {
        invalid(`Immutable prototype Artifact Revision ${revisionId} is missing`);
      }
      artifactRevisions.push(revision);
    }
    for (const revisionId of revisionIds.resourceRevisionIds) {
      const revision = await this.store.readResourceRevision(
        claim.task.workspaceId,
        revisionId,
        signal,
      );
      checkAbort(signal);
      if (revision === null) {
        invalid(`Immutable prototype Resource Revision ${revisionId} is missing`);
      }
      resourceRevisions.push(revision);
    }

    if (claim.task.payload.version === 2) {
      const preparation = useCoreValidation(() => (
        buildGenerationTaskPrototypeFinalizationPreparation({
          task: claim.task,
          attempt: claim.attempt,
          snapshot,
          artifactRevisions,
          resourceRevisions,
        })
      ));
      let markerProofs: GenerationTaskPrototypeMarkerProof[];
      try {
        markerProofs = await this.store.resolveArtifactMarkers(
          preparation.requirements.map((requirement) => ({
            workspaceId: claim.task.workspaceId,
            artifactId: requirement.sourceArtifactId,
            revisionId: requirement.sourceRevisionId,
            sourceMarkerId: requirement.sourceMarkerId,
            trigger: requirement.trigger,
            receiptNonce: generationTaskPrototypeRuntimeReceiptNonce(
              claim.task.id,
              claim.attempt.attempt,
              requirement.edgeId,
              requirement.sourceMarkerId,
            ),
          })),
          signal,
        );
      } catch (error) {
        if (signal.aborted) throw abortReason(signal);
        invalid("Prototype markers cannot be proven in their exact immutable preview runtimes", {
          edgeIds: preparation.requirements.map((requirement) => requirement.edgeId),
          sourceMarkerIds: preparation.requirements.map((requirement) => requirement.sourceMarkerId),
          reason: error instanceof Error ? error.name : "unknown",
        });
      }
      checkAbort(signal);
      const authorized = useCoreValidation(() => buildGenerationTaskPrototypeFinalizationBindings({
        task: claim.task,
        attempt: claim.attempt,
        snapshot,
        artifactRevisions,
        resourceRevisions,
        markerProofs,
      }));
      checkAbort(signal);
      return {
        kind: "prototype-finalization",
        taskId: claim.task.id,
        workspaceId: claim.task.workspaceId,
        baseSnapshotId: authorized.preparation.baseSnapshotId,
        baseGraphRevision: authorized.preparation.baseGraphRevision,
        artifactRevisionIds: authorized.preparation.artifactRevisionIds,
        resourceRevisionIds: authorized.preparation.resourceRevisionIds,
        markerProofs: authorized.bindings.map((binding) => binding.markerProof),
      };
    }

    return useCoreValidation(() => {
      const result = buildGenerationTaskPrototypeValidationResult({
        task: claim.task,
        attempt: claim.attempt,
        snapshot,
        artifactRevisions,
        resourceRevisions,
      });
      checkAbort(signal);
      return {
        kind: "snapshot-validation",
        taskId: claim.task.id,
        workspaceId: claim.task.workspaceId,
        ...result,
      };
    });
  }
}
