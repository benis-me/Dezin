import type {
  CompleteResourcePayloadCleanupInput,
  ClassifyResourcePayloadStagingInput,
  CompleteResourcePayloadStagingInput,
  ResourcePayloadCleanupIdentity,
  ResourcePayloadCleanupClaim,
  ResourcePayloadRecoveryCursor,
  ResourcePayloadRecoveryPage,
  ResourcePayloadStagingBeginInput,
  ResourcePayloadStagingJournal,
  TryClaimResourcePayloadCleanupInput,
} from "../../../../packages/core/src/index.ts";
import { ResourceTaskPayloadError } from "./resource-task-executor.ts";
import {
  type OwnedResourceTaskPayloadStaging,
  type ResourceTaskPayloadJournalPort,
  type ResourceTaskPayloadReferenceGuard,
  type ResourceTaskPayloadReferenceIdentity,
} from "./resource-task-payload-staging.ts";

export interface ResourcePayloadCleanupStorePort {
  tryClaimResourcePayloadCleanup(
    input: TryClaimResourcePayloadCleanupInput,
  ): ResourcePayloadCleanupClaim | null;
  completeResourcePayloadCleanup(
    input: CompleteResourcePayloadCleanupInput,
  ): ResourcePayloadCleanupClaim;
  beginResourcePayloadStaging(input: ResourcePayloadStagingBeginInput): ResourcePayloadStagingJournal;
  getResourcePayloadStaging(input: ResourcePayloadCleanupIdentity): ResourcePayloadStagingJournal | null;
  classifyResourcePayloadStaging(input: ClassifyResourcePayloadStagingInput): ResourcePayloadStagingJournal;
  completeResourcePayloadStaging(input: CompleteResourcePayloadStagingInput): ResourcePayloadStagingJournal;
  listResourcePayloadRecoveryEntries(input: {
    cursor?: ResourcePayloadRecoveryCursor | null;
    limit?: number;
  }): ResourcePayloadRecoveryPage;
}

export class WorkspaceStoreResourceTaskPayloadReferenceGuard
implements ResourceTaskPayloadReferenceGuard, ResourceTaskPayloadJournalPort {
  readonly #tryClaim: ResourcePayloadCleanupStorePort["tryClaimResourcePayloadCleanup"];
  readonly #complete: ResourcePayloadCleanupStorePort["completeResourcePayloadCleanup"];
  readonly #beginStaging: ResourcePayloadCleanupStorePort["beginResourcePayloadStaging"];
  readonly #getStaging: ResourcePayloadCleanupStorePort["getResourcePayloadStaging"];
  readonly #classifyStaging: ResourcePayloadCleanupStorePort["classifyResourcePayloadStaging"];
  readonly #completeStaging: ResourcePayloadCleanupStorePort["completeResourcePayloadStaging"];

  constructor(options: { readonly store: ResourcePayloadCleanupStorePort }) {
    const store = options.store;
    if (store === null || typeof store !== "object"
      || typeof store.tryClaimResourcePayloadCleanup !== "function"
      || typeof store.completeResourcePayloadCleanup !== "function"
      || typeof store.beginResourcePayloadStaging !== "function"
      || typeof store.getResourcePayloadStaging !== "function"
      || typeof store.classifyResourcePayloadStaging !== "function"
      || typeof store.completeResourcePayloadStaging !== "function") {
      throw new ResourceTaskPayloadError(
        "RESOURCE_PAYLOAD_CLEANUP_FAILED",
        "Resource payload cleanup Store port is invalid",
      );
    }
    this.#tryClaim = store.tryClaimResourcePayloadCleanup.bind(store);
    this.#complete = store.completeResourcePayloadCleanup.bind(store);
    this.#beginStaging = store.beginResourcePayloadStaging.bind(store);
    this.#getStaging = store.getResourcePayloadStaging.bind(store);
    this.#classifyStaging = store.classifyResourcePayloadStaging.bind(store);
    this.#completeStaging = store.completeResourcePayloadStaging.bind(store);
  }

  beginResourcePayloadStaging(input: ResourcePayloadStagingBeginInput): ResourcePayloadStagingJournal {
    return this.#beginStaging(input);
  }

  getResourcePayloadStaging(input: ResourcePayloadCleanupIdentity): ResourcePayloadStagingJournal | null {
    return this.#getStaging(input);
  }

  classifyResourcePayloadStaging(input: ClassifyResourcePayloadStagingInput): ResourcePayloadStagingJournal {
    return this.#classifyStaging(input);
  }

  completeResourcePayloadStaging(input: CompleteResourcePayloadStagingInput): ResourcePayloadStagingJournal {
    return this.#completeStaging(input);
  }

  async removeIfUnreferenced(
    identity: ResourceTaskPayloadReferenceIdentity,
    removeOwnedPayload: () => Promise<void>,
  ): Promise<boolean> {
    const input: TryClaimResourcePayloadCleanupInput = { ...identity };
    const claim = this.#tryClaim(input);
    if (claim === null) return false;
    assertExactClaim(claim, input);
    if (claim.status === "completed") return true;
    await removeOwnedPayload();
    const completed = this.#complete(input);
    assertExactClaim(completed, input);
    if (completed.status !== "completed" || completed.completedAt === null) {
      throw new ResourceTaskPayloadError(
        "RESOURCE_PAYLOAD_CLEANUP_FAILED",
        "Resource payload cleanup Store did not durably complete its exact claim",
      );
    }
    return true;
  }
}

export interface ResourceTaskPayloadRecoveryResult {
  readonly scanned: number;
  readonly removed: number;
  readonly retained: number;
  readonly invalid: number;
  readonly failed: number;
  readonly nextCursor: ResourcePayloadRecoveryCursor | null;
}

export interface ResourceTaskPayloadRecoveryPort {
  recover(input: {
    readonly cursor?: ResourcePayloadRecoveryCursor | null;
    readonly limit?: number;
    readonly signal: AbortSignal;
  }): Promise<ResourceTaskPayloadRecoveryResult>;
}

export class OwnedResourceTaskPayloadRecovery implements ResourceTaskPayloadRecoveryPort {
  readonly #listRecovery: ResourcePayloadCleanupStorePort["listResourcePayloadRecoveryEntries"];
  readonly #cleanupJournal: OwnedResourceTaskPayloadStaging["cleanupJournalIfUnreferenced"];

  constructor(options: {
    readonly staging: OwnedResourceTaskPayloadStaging;
    readonly store: Pick<ResourcePayloadCleanupStorePort, "listResourcePayloadRecoveryEntries">;
  }) {
    const staging = options.staging;
    if (staging === null || typeof staging !== "object"
      || typeof staging.cleanupJournalIfUnreferenced !== "function") {
      throw new ResourceTaskPayloadError(
        "RESOURCE_PAYLOAD_CLEANUP_FAILED",
        "Resource payload recovery staging port is invalid",
      );
    }
    const store = options.store;
    if (store === null || typeof store !== "object"
      || typeof store.listResourcePayloadRecoveryEntries !== "function") {
      throw new ResourceTaskPayloadError(
        "RESOURCE_PAYLOAD_CLEANUP_FAILED",
        "Resource payload recovery Store inventory port is invalid",
      );
    }
    this.#listRecovery = store.listResourcePayloadRecoveryEntries.bind(store);
    this.#cleanupJournal = staging.cleanupJournalIfUnreferenced.bind(staging);
  }

  async recover(input: {
    readonly cursor?: ResourcePayloadRecoveryCursor | null;
    readonly limit?: number;
    readonly signal: AbortSignal;
  }): Promise<ResourceTaskPayloadRecoveryResult> {
    checkAbort(input.signal);
    const page = this.#listRecovery({ cursor: input.cursor, limit: input.limit });
    let removed = 0;
    let retained = 0;
    let failed = 0;
    for (const entry of page.entries) {
      checkAbort(input.signal);
      try {
        assertRecoveryEntry(entry.journal, entry.cleanup);
        if (await this.#cleanupJournal(entry.journal)) removed += 1;
        else retained += 1;
      } catch {
        if (input.signal.aborted) throw abortReason(input.signal);
        failed += 1;
      }
    }
    return {
      scanned: page.entries.length,
      removed,
      retained,
      invalid: 0,
      failed,
      nextCursor: page.nextCursor,
    };
  }
}

function assertRecoveryEntry(
  journal: ResourcePayloadStagingJournal,
  cleanup: ResourcePayloadCleanupClaim | null,
): void {
  if (cleanup === null) return;
  assertExactClaim(cleanup, {
    taskId: journal.taskId,
    attempt: journal.attempt,
    inputHash: journal.inputHash,
    workspaceId: journal.workspaceId,
    resourceId: journal.resourceId,
    revisionId: journal.revisionId,
  });
  if (cleanup.planId !== journal.planId || cleanup.status !== "claimed") {
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_CLEANUP_FAILED",
      "Resource payload recovery inventory returned an incoherent cleanup claim",
    );
  }
}

function assertExactClaim(
  claim: ResourcePayloadCleanupClaim,
  identity: TryClaimResourcePayloadCleanupInput,
): void {
  if (claim.taskId !== identity.taskId
    || claim.attempt !== identity.attempt
    || claim.inputHash !== identity.inputHash
    || claim.workspaceId !== identity.workspaceId
    || claim.resourceId !== identity.resourceId
    || claim.revisionId !== identity.revisionId
    || (claim.status !== "claimed" && claim.status !== "completed")) {
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_CLEANUP_FAILED",
      "Resource payload cleanup Store returned a mismatched durable claim",
    );
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Resource payload recovery aborted", "AbortError");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}
