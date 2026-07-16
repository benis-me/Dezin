import assert from "node:assert/strict";
import { lstat, mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  OwnedResourceTaskPayloadStaging,
  resourceTaskReceiptRelativePath,
  type ResourceTaskPayloadReferenceGuard,
  type ResourceTaskPayloadReferenceIdentity,
} from "../src/orchestration/resource-task-payload-staging.ts";
import type {
  ResourceTaskPayloadReceipt,
  ResourceTaskPayloadStageInput,
} from "../src/orchestration/resource-task-executor.ts";
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
} from "../../../packages/core/src/index.ts";

interface CleanupStorePort {
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

interface RecoverySummary {
  scanned: number;
  removed: number;
  retained: number;
  invalid: number;
  failed: number;
  nextCursor: ResourcePayloadRecoveryCursor | null;
}

interface RecoveryModule {
  WorkspaceStoreResourceTaskPayloadReferenceGuard: new (options: {
    store: CleanupStorePort;
  }) => ResourceTaskPayloadReferenceGuard;
  OwnedResourceTaskPayloadRecovery: new (options: {
    staging: OwnedResourceTaskPayloadStaging;
    store: CleanupStorePort;
  }) => {
    recover(input: {
      cursor?: ResourcePayloadRecoveryCursor | null;
      limit?: number;
      signal: AbortSignal;
    }): Promise<RecoverySummary>;
  };
}

class DurableCleanupStoreDouble implements CleanupStorePort {
  readonly claims = new Map<string, ResourcePayloadCleanupClaim>();
  readonly journals = new Map<string, ResourcePayloadStagingJournal>();
  retainedTaskId: string | null = null;
  completionCalls = 0;
  completionFailure: "before" | "after" | null = null;

  tryClaimResourcePayloadCleanup(
    input: TryClaimResourcePayloadCleanupInput,
  ): ResourcePayloadCleanupClaim | null {
    if (input.taskId === this.retainedTaskId) return null;
    const existing = this.claims.get(input.revisionId);
    if (existing) return existing;
    const claim: ResourcePayloadCleanupClaim = {
      ...input,
      planId: `plan-${input.taskId}`,
      status: "claimed",
      claimedAt: 100,
      completedAt: null,
    };
    this.claims.set(input.revisionId, claim);
    return claim;
  }

  completeResourcePayloadCleanup(
    input: CompleteResourcePayloadCleanupInput,
  ): ResourcePayloadCleanupClaim {
    const existing = this.claims.get(input.revisionId);
    assert.ok(existing);
    this.completionCalls += 1;
    if (this.completionFailure === "before") {
      this.completionFailure = null;
      throw new Error("simulated crash before durable cleanup completion");
    }
    const completed: ResourcePayloadCleanupClaim = {
      ...existing,
      status: "completed",
      completedAt: 101,
    };
    this.claims.set(input.revisionId, completed);
    if (this.completionFailure === "after") {
      this.completionFailure = null;
      throw new Error("simulated cleanup completion response loss");
    }
    return completed;
  }

  beginResourcePayloadStaging(input: ResourcePayloadStagingBeginInput): ResourcePayloadStagingJournal {
    const existing = this.journals.get(input.revisionId);
    if (existing !== undefined) return existing;
    const { lease, ...journalInput } = input;
    const journal: ResourcePayloadStagingJournal = {
      ...journalInput,
      sequence: this.journals.size + 1,
      planId: `plan-${input.taskId}`,
      ownerId: lease.ownerId,
      leaseToken: lease.leaseToken,
      status: "prepared",
      storageDisposition: null,
      createdAt: 10,
      classifiedAt: null,
      receiptCommittedAt: null,
    };
    this.journals.set(input.revisionId, journal);
    return journal;
  }

  getResourcePayloadStaging(input: ResourcePayloadCleanupIdentity): ResourcePayloadStagingJournal | null {
    const journal = this.journals.get(input.revisionId);
    return journal?.taskId === input.taskId
      && journal.attempt === input.attempt
      && journal.inputHash === input.inputHash
      && journal.workspaceId === input.workspaceId
      && journal.resourceId === input.resourceId
      ? journal
      : null;
  }

  classifyResourcePayloadStaging(input: ClassifyResourcePayloadStagingInput): ResourcePayloadStagingJournal {
    const journal = this.journals.get(input.revisionId);
    assert.ok(journal);
    const classified: ResourcePayloadStagingJournal = {
      ...journal,
      storageDisposition: input.storageDisposition,
      classifiedAt: 11,
    };
    this.journals.set(input.revisionId, classified);
    return classified;
  }

  completeResourcePayloadStaging(input: CompleteResourcePayloadStagingInput): ResourcePayloadStagingJournal {
    const journal = this.journals.get(input.revisionId);
    assert.ok(journal);
    assert.equal(input.receiptChecksum, journal.receiptChecksum);
    const completed: ResourcePayloadStagingJournal = {
      ...journal,
      status: "receipt-committed",
      receiptCommittedAt: 12,
    };
    this.journals.set(input.revisionId, completed);
    return completed;
  }

  listResourcePayloadRecoveryEntries(input: {
    cursor?: ResourcePayloadRecoveryCursor | null;
    limit?: number;
  }): ResourcePayloadRecoveryPage {
    const limit = input.limit ?? 100;
    const throughSequence = input.cursor?.throughSequence
      ?? Math.max(0, ...[...this.journals.values()].map((journal) => journal.sequence));
    const afterSequence = input.cursor?.afterSequence ?? 0;
    const entries = [...this.journals.values()]
      .filter((journal) => journal.sequence > afterSequence && journal.sequence <= throughSequence)
      .filter((journal) => this.claims.get(journal.revisionId)?.status !== "completed")
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, limit)
      .map((journal) => ({
        journal,
        cleanup: this.claims.get(journal.revisionId) ?? null,
      }));
    const last = entries.at(-1)?.journal.sequence;
    return {
      entries,
      nextCursor: entries.length === limit && last !== undefined
        ? { afterSequence: last, throughSequence }
        : null,
    };
  }
}

async function recoveryModule(): Promise<Partial<RecoveryModule>> {
  return import("../src/orchestration/resource-task-payload-recovery.ts")
    .catch(() => ({})) as Promise<Partial<RecoveryModule>>;
}

function stageInput(index: number): ResourceTaskPayloadStageInput {
  return {
    taskId: `task-resource-recovery-${index}`,
    attempt: 1,
    inputHash: `${"a".repeat(63)}${index}`,
    workspaceId: "workspace-resource-recovery",
    resourceId: `resource-recovery-${index}`,
    revisionId: `7ae98395-aa2e-5a59-8f52-5df48f075d7${index}`,
    parentRevisionId: null,
    adapter: { id: "dezin.resource-adapter.asset", version: 1, kind: "asset" },
    maxOutputBytes: 1024 * 1024,
    lease: {
      taskId: `task-resource-recovery-${index}`,
      workspaceId: "workspace-resource-recovery",
      attempt: 1,
      ownerId: `worker-resource-recovery-${index}`,
      leaseToken: `lease-resource-recovery-${index}`,
    },
    bytes: new TextEncoder().encode(`resource recovery payload ${index}`),
    mimeType: "text/plain",
    summary: `Resource recovery payload ${index}`,
    metadata: { index },
    provenance: { model: "recovery-fixture" },
    evidence: { accepted: true },
    signal: new AbortController().signal,
  };
}

function retainAllGuard(): ResourceTaskPayloadReferenceGuard {
  return {
    async removeIfUnreferenced() { return false; },
  };
}

test("a durable cleanup claim survives a delete crash and a new guard resumes it", async () => {
  const module = await recoveryModule();
  const Guard = module.WorkspaceStoreResourceTaskPayloadReferenceGuard;
  assert.ok(Guard, "production durable Resource payload guard must be exported");
  const store = new DurableCleanupStoreDouble();
  const identity: ResourceTaskPayloadReferenceIdentity = {
    taskId: "task-resource-crash",
    attempt: 1,
    inputHash: "b".repeat(64),
    workspaceId: "workspace-resource-crash",
    resourceId: "resource-crash",
    revisionId: "revision-resource-crash",
  };
  const firstGuard = new Guard({ store });

  await assert.rejects(
    firstGuard.removeIfUnreferenced(identity, async () => {
      throw new Error("simulated crash after durable claim");
    }),
    /simulated crash/,
  );
  assert.equal(store.claims.get(identity.revisionId)?.status, "claimed");
  assert.equal(store.completionCalls, 0);

  let resumedDeletes = 0;
  const restartedGuard = new Guard({ store });
  assert.equal(await restartedGuard.removeIfUnreferenced(identity, async () => {
    resumedDeletes += 1;
  }), true);
  assert.equal(resumedDeletes, 1);
  assert.equal(store.claims.get(identity.revisionId)?.status, "completed");
  assert.equal(store.completionCalls, 1);
  assert.equal(await restartedGuard.removeIfUnreferenced(identity, async () => {
    resumedDeletes += 1;
  }), true);
  assert.equal(resumedDeletes, 1, "completed cleanup must not delete twice");
});

test("bounded recovery advances beyond a retained prefix and a new instance scavenges the suffix", async (t) => {
  const module = await recoveryModule();
  const Guard = module.WorkspaceStoreResourceTaskPayloadReferenceGuard;
  const Recovery = module.OwnedResourceTaskPayloadRecovery;
  assert.ok(Guard, "production durable Resource payload guard must be exported");
  assert.ok(Recovery, "independent Resource payload recovery port must be exported");
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-recovery-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const store = new DurableCleanupStoreDouble();
  const writer = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: retainAllGuard(),
    journal: store,
  });
  for (let index = 1; index <= 3; index += 1) await writer.stage(stageInput(index));
  const ordered = await writer.scanReceipts({
    limit: 10,
    signal: new AbortController().signal,
  });
  assert.equal(ordered.receipts.length, 3);
  store.retainedTaskId = [...store.journals.values()]
    .sort((left, right) => left.sequence - right.sequence)[0]!.taskId;
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: new Guard({ store }),
    journal: store,
  });
  const firstRecovery = new Recovery({ staging, store });

  const first = await firstRecovery.recover({
    limit: 1,
    signal: new AbortController().signal,
  });
  assert.deepEqual(
    { scanned: first.scanned, removed: first.removed, retained: first.retained },
    { scanned: 1, removed: 0, retained: 1 },
  );
  assert.ok(first.nextCursor);
  assert.equal(first.nextCursor.throughSequence, 3);
  await writer.stage(stageInput(4));

  const restartedRecovery = new Recovery({ staging, store });
  const second = await restartedRecovery.recover({
    cursor: first.nextCursor,
    limit: 1,
    signal: new AbortController().signal,
  });
  assert.deepEqual(
    { scanned: second.scanned, removed: second.removed, retained: second.retained, failed: second.failed },
    { scanned: 1, removed: 1, retained: 0, failed: 0 },
  );
  assert.ok(second.nextCursor);

  const third = await restartedRecovery.recover({
    cursor: second.nextCursor,
    limit: 1,
    signal: new AbortController().signal,
  });
  assert.equal(third.removed, 1);
  assert.ok(third.nextCursor);
  const endOfBoundedSweep = await restartedRecovery.recover({
    cursor: third.nextCursor,
    limit: 1,
    signal: new AbortController().signal,
  });
  assert.equal(endOfBoundedSweep.scanned, 0);
  assert.equal(endOfBoundedSweep.nextCursor, null);
  const nextSweepHead = await restartedRecovery.recover({
    limit: 1,
    signal: new AbortController().signal,
  });
  assert.equal(nextSweepHead.retained, 1);
  assert.ok(nextSweepHead.nextCursor);
  assert.equal(nextSweepHead.nextCursor.throughSequence, 4);
  const nextSweepTail = await restartedRecovery.recover({
    cursor: nextSweepHead.nextCursor,
    limit: 1,
    signal: new AbortController().signal,
  });
  assert.equal(nextSweepTail.removed, 1, "new rows wait for but cannot starve behind a bounded sweep");
  const remaining = await staging.scanReceipts({
    limit: 10,
    signal: new AbortController().signal,
  });
  assert.deepEqual(remaining.receipts.map((entry) => entry.receipt.taskId), [store.retainedTaskId]);
});

test("restart enumerates the Core journal when snapshot bytes exist without a receipt", async (t) => {
  const module = await recoveryModule();
  const Guard = module.WorkspaceStoreResourceTaskPayloadReferenceGuard;
  const Recovery = module.OwnedResourceTaskPayloadRecovery;
  assert.ok(Guard);
  assert.ok(Recovery);
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-pre-receipt-crash-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const store = new DurableCleanupStoreDouble();
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: new Guard({ store }),
    journal: store,
  });
  const input = stageInput(4);
  const receipt = await staging.stage(input);
  const receiptPath = join(
    storageRoot,
    ...resourceTaskReceiptRelativePath(receipt.workspaceId, receipt.revisionId).split("/"),
  );
  await unlink(receiptPath);
  const committedJournal = store.journals.get(receipt.revisionId);
  assert.ok(committedJournal);
  store.journals.set(receipt.revisionId, {
    ...committedJournal,
    status: "prepared",
    receiptCommittedAt: null,
  });

  const restarted = new Recovery({ staging, store });
  const summary = await restarted.recover({
    limit: 1,
    signal: new AbortController().signal,
  });

  assert.deepEqual(
    { scanned: summary.scanned, removed: summary.removed, failed: summary.failed },
    { scanned: 1, removed: 1, failed: 0 },
  );
  assert.equal(store.claims.get(receipt.revisionId)?.status, "completed");
  await assert.rejects(lstat(join(storageRoot, ...receipt.manifestPath.split("/"))), { code: "ENOENT" });
});

test("restart resumes claimed cleanup after every durable unlink boundary", async (t) => {
  const module = await recoveryModule();
  const Guard = module.WorkspaceStoreResourceTaskPayloadReferenceGuard;
  const Recovery = module.OwnedResourceTaskPayloadRecovery;
  assert.ok(Guard);
  assert.ok(Recovery);
  for (let removedFiles = 1; removedFiles <= 3; removedFiles += 1) {
    await t.test(`after ${removedFiles} unlink${removedFiles === 1 ? "" : "s"}`, async (t) => {
      const storageRoot = await mkdtemp(join(tmpdir(), `dezin-resource-unlink-${removedFiles}-`));
      t.after(() => rm(storageRoot, { recursive: true, force: true }));
      const store = new DurableCleanupStoreDouble();
      const staging = new OwnedResourceTaskPayloadStaging({
        storageRoot,
        references: new Guard({ store }),
        journal: store,
      });
      const receipt = await staging.stage(stageInput(4 + removedFiles));
      const identity: TryClaimResourcePayloadCleanupInput = {
        taskId: receipt.taskId,
        attempt: receipt.attempt,
        inputHash: receipt.inputHash,
        workspaceId: receipt.workspaceId,
        resourceId: receipt.resourceId,
        revisionId: receipt.revisionId,
      };
      assert.equal(store.tryClaimResourcePayloadCleanup(identity)?.status, "claimed");
      const files = [
        resourceTaskReceiptRelativePath(receipt.workspaceId, receipt.revisionId),
        receipt.manifestPath,
        `${receipt.manifestPath.slice(0, -"manifest.json".length)}payload.bin`,
      ].map((relativePath) => join(storageRoot, ...relativePath.split("/")));
      for (const path of files.slice(0, removedFiles)) await unlink(path);

      const summary = await new Recovery({ staging, store }).recover({
        limit: 10,
        signal: new AbortController().signal,
      });

      assert.deepEqual(
        { scanned: summary.scanned, removed: summary.removed, failed: summary.failed },
        { scanned: 1, removed: 1, failed: 0 },
      );
      assert.equal(store.claims.get(receipt.revisionId)?.status, "completed");
      for (const path of files) await assert.rejects(lstat(path), { code: "ENOENT" });
    });
  }
});

test("restart converges cleanup completion crashes before commit and after response loss", async (t) => {
  const module = await recoveryModule();
  const Guard = module.WorkspaceStoreResourceTaskPayloadReferenceGuard;
  const Recovery = module.OwnedResourceTaskPayloadRecovery;
  assert.ok(Guard);
  assert.ok(Recovery);
  for (const failure of ["before", "after"] as const) {
    await t.test(failure, async (t) => {
      const storageRoot = await mkdtemp(join(tmpdir(), `dezin-resource-complete-${failure}-`));
      t.after(() => rm(storageRoot, { recursive: true, force: true }));
      const store = new DurableCleanupStoreDouble();
      const staging = new OwnedResourceTaskPayloadStaging({
        storageRoot,
        references: new Guard({ store }),
        journal: store,
      });
      const receipt = await staging.stage(stageInput(failure === "before" ? 8 : 9));
      store.completionFailure = failure;
      const recovery = new Recovery({ staging, store });

      const interrupted = await recovery.recover({
        limit: 10,
        signal: new AbortController().signal,
      });
      assert.equal(interrupted.failed, 1);
      assert.equal(
        store.claims.get(receipt.revisionId)?.status,
        failure === "before" ? "claimed" : "completed",
      );

      const restarted = await new Recovery({ staging, store }).recover({
        limit: 10,
        signal: new AbortController().signal,
      });
      if (failure === "before") {
        assert.deepEqual(
          { scanned: restarted.scanned, removed: restarted.removed, failed: restarted.failed },
          { scanned: 1, removed: 1, failed: 0 },
        );
      } else {
        assert.deepEqual(
          { scanned: restarted.scanned, removed: restarted.removed, failed: restarted.failed },
          { scanned: 0, removed: 0, failed: 0 },
        );
      }
      assert.equal(store.claims.get(receipt.revisionId)?.status, "completed");
    });
  }
});

test("an unclassified journal fails closed when any filesystem object exists", async (t) => {
  const module = await recoveryModule();
  const Guard = module.WorkspaceStoreResourceTaskPayloadReferenceGuard;
  const Recovery = module.OwnedResourceTaskPayloadRecovery;
  assert.ok(Guard);
  assert.ok(Recovery);
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-unclassified-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const store = new DurableCleanupStoreDouble();
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: new Guard({ store }),
    journal: store,
  });
  const receipt = await staging.stage(stageInput(7));
  const journal = store.journals.get(receipt.revisionId);
  assert.ok(journal);
  store.journals.set(receipt.revisionId, {
    ...journal,
    status: "prepared",
    storageDisposition: null,
    classifiedAt: null,
    receiptCommittedAt: null,
  });

  const summary = await new Recovery({ staging, store }).recover({
    limit: 10,
    signal: new AbortController().signal,
  });

  assert.deepEqual(
    { scanned: summary.scanned, removed: summary.removed, failed: summary.failed },
    { scanned: 1, removed: 0, failed: 1 },
  );
  assert.equal(store.claims.get(receipt.revisionId)?.status, "claimed");
  assert.equal((await lstat(join(storageRoot, ...receipt.manifestPath.split("/")))).isFile(), true);
  assert.equal((await lstat(join(
    storageRoot,
    ...resourceTaskReceiptRelativePath(receipt.workspaceId, receipt.revisionId).split("/"),
  ))).isFile(), true);
});
