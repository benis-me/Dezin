import assert from "node:assert/strict";
import { lstatSync } from "node:fs";
import { mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { sealResourceRevisionPayload } from "../src/context/adapters/file.ts";
import {
  OwnedResourceTaskPayloadStaging,
  resourceTaskReceiptRelativePath,
  type ResourceTaskPayloadReferenceGuard,
} from "../src/orchestration/resource-task-payload-staging.ts";
import {
  ResourceTaskPayloadError,
  type ResourceTaskPayloadReceipt,
  type ResourceTaskPayloadStageInput,
} from "../src/orchestration/resource-task-executor.ts";
import type {
  ClassifyResourcePayloadStagingInput,
  CompleteResourcePayloadStagingInput,
  ResourcePayloadCleanupIdentity,
  ResourcePayloadStagingBeginInput,
  ResourcePayloadStagingJournal,
} from "../../../packages/core/src/index.ts";

interface ResourcePayloadJournalDouble {
  beginResourcePayloadStaging(input: ResourcePayloadStagingBeginInput): ResourcePayloadStagingJournal;
  getResourcePayloadStaging(input: ResourcePayloadCleanupIdentity): ResourcePayloadStagingJournal | null;
  classifyResourcePayloadStaging(input: ClassifyResourcePayloadStagingInput): ResourcePayloadStagingJournal;
  completeResourcePayloadStaging(input: CompleteResourcePayloadStagingInput): ResourcePayloadStagingJournal;
}

function stageInput(
  overrides: Partial<ResourceTaskPayloadStageInput> = {},
): ResourceTaskPayloadStageInput {
  return {
    taskId: "task-owned-resource-stage",
    attempt: 1,
    inputHash: "a".repeat(64),
    workspaceId: "workspace-owned-resource-stage",
    resourceId: "resource-owned-resource-stage",
    revisionId: "7ae98395-aa2e-5a59-8f52-5df48f075d6e",
    parentRevisionId: "resource-owned-parent",
    adapter: { id: "dezin.resource-adapter.asset", version: 1, kind: "asset" },
    maxOutputBytes: 1024 * 1024,
    lease: {
      taskId: "task-owned-resource-stage",
      workspaceId: "workspace-owned-resource-stage",
      attempt: 1,
      ownerId: "worker-owned-resource-stage",
      leaseToken: "lease-owned-resource-stage",
    },
    bytes: new TextEncoder().encode("owned generated payload"),
    mimeType: "text/plain",
    summary: "Owned generated payload",
    metadata: { width: 1440 },
    provenance: { model: "fixture-v1" },
    evidence: { accepted: true },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function referenceGuard(state: { referenced: boolean; removals: number }): ResourceTaskPayloadReferenceGuard {
  return {
    async removeIfUnreferenced(_identity, removeOwnedPayload) {
      if (state.referenced) return false;
      await removeOwnedPayload();
      state.removals += 1;
      return true;
    },
  };
}

function journalDouble(options: {
  onBegin?: (input: ResourcePayloadStagingBeginInput) => void;
} = {}): ResourcePayloadJournalDouble {
  const values = new Map<string, ResourcePayloadStagingJournal>();
  return {
    beginResourcePayloadStaging(input) {
      options.onBegin?.(input);
      const existing = values.get(input.revisionId);
      if (existing !== undefined) return existing;
      const { lease, ...journalInput } = input;
      const value: ResourcePayloadStagingJournal = {
        ...journalInput,
        sequence: values.size + 1,
        planId: "plan-owned-resource-stage",
        ownerId: lease.ownerId,
        leaseToken: lease.leaseToken,
        status: "prepared",
        storageDisposition: null,
        createdAt: 1,
        classifiedAt: null,
        receiptCommittedAt: null,
      };
      values.set(input.revisionId, value);
      return value;
    },
    getResourcePayloadStaging(input) {
      const value = values.get(input.revisionId);
      return value?.taskId === input.taskId
        && value.attempt === input.attempt
        && value.inputHash === input.inputHash
        && value.workspaceId === input.workspaceId
        && value.resourceId === input.resourceId
        && value.revisionId === input.revisionId
        ? value
        : null;
    },
    classifyResourcePayloadStaging(input) {
      const value = values.get(input.revisionId);
      assert.ok(value);
      const classified: ResourcePayloadStagingJournal = {
        ...value,
        storageDisposition: input.storageDisposition,
        classifiedAt: 2,
      };
      values.set(input.revisionId, classified);
      return classified;
    },
    completeResourcePayloadStaging(input) {
      const value = values.get(input.revisionId);
      assert.ok(value);
      assert.equal(input.receiptChecksum, value.receiptChecksum);
      const completed: ResourcePayloadStagingJournal = {
        ...value,
        status: "receipt-committed",
        receiptCommittedAt: 3,
      };
      values.set(input.revisionId, completed);
      return completed;
    },
  };
}

interface ReceiptScanCursor {
  relativePath: string;
}

interface ReceiptScanPage {
  receipts: Array<{ relativePath: string; receipt: ResourceTaskPayloadReceipt }>;
  invalidReceiptPaths: string[];
  scanned: number;
  nextCursor: ReceiptScanCursor | null;
}

interface ReceiptScanner {
  scanReceipts(input: {
    cursor?: ReceiptScanCursor | null;
    limit?: number;
    signal: AbortSignal;
  }): Promise<ReceiptScanPage>;
}

test("commits an exact staging journal before the first owned filesystem write", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-journal-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const input = stageInput({ inputHash: "a".repeat(64) });
  const events: string[] = [];
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal: journalDouble({
      onBegin(begin) {
        events.push("begin");
        const manifest = join(storageRoot, ...begin.manifestPath.split("/"));
        assert.throws(() => lstatSync(manifest), { code: "ENOENT" });
      },
    }),
    now: () => 122_000,
  });

  await staging.stage(input);

  assert.deepEqual(events, ["begin"]);
});

test("a stale lease rejection leaves zero Resource payload filesystem writes", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-stale-lease-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const journal = journalDouble();
  journal.beginResourcePayloadStaging = () => {
    assert.throws(() => lstatSync(join(storageRoot, "resource-revisions")), { code: "ENOENT" });
    throw new Error("stale Resource payload lease fence");
  };
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal,
  });

  await assert.rejects(
    staging.stage(stageInput()),
    (error) => error instanceof ResourceTaskPayloadError
      && error.code === "RESOURCE_PAYLOAD_STAGE_FAILED"
      && error.cause instanceof Error
      && /stale Resource payload lease fence/.test(error.cause.message),
  );
  assert.throws(() => lstatSync(join(storageRoot, "resource-revisions")), { code: "ENOENT" });
});

test("seals and replays a real immutable attempt-scoped payload receipt", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const state = { referenced: false, removals: 0 };
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard(state),
    journal: journalDouble(),
    now: () => 123_000,
  });
  const input = stageInput();

  const staged = await staging.stage(input);
  const replay = await staging.find(input);

  assert.deepEqual(replay, staged);
  assert.equal(staged.revisionId, input.revisionId);
  assert.equal(staged.parentRevisionId, input.parentRevisionId);
  assert.equal(staged.byteSize, input.bytes.byteLength);
  assert.match(staged.manifestChecksum, /^[a-f0-9]{64}$/);
  assert.match(staged.payloadChecksum, /^[a-f0-9]{64}$/);
  assert.equal(
    resourceTaskReceiptRelativePath(input.workspaceId, input.revisionId),
    `${dirname(staged.manifestPath)}/generation-receipt.json`,
  );
});

test("does not charge the durable receipt envelope against the adapter output budget", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-budget-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal: journalDouble(),
    now: () => 123_500,
  });
  const input = stageInput({ maxOutputBytes: 300 });

  const receipt = await staging.stage(input);

  assert.deepEqual(await staging.find(input), receipt);
});

test("scans receipts with a bounded stable cursor that advances across every path", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-scan-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: true, removals: 0 }),
    journal: journalDouble(),
  });
  for (let index = 1; index <= 3; index += 1) {
    await staging.stage(stageInput({
      taskId: `task-owned-resource-scan-${index}`,
      inputHash: String(index).repeat(64),
      revisionId: `7ae98395-aa2e-5a59-8f52-5df48f075d6${index}`,
      summary: `Owned generated scan payload ${index}`,
    }));
  }
  const scanner = staging as unknown as ReceiptScanner;
  assert.equal(typeof scanner.scanReceipts, "function");
  const seenPaths: string[] = [];
  let cursor: ReceiptScanCursor | null = null;
  do {
    const page = await scanner.scanReceipts({
      cursor,
      limit: 1,
      signal: new AbortController().signal,
    });
    assert.ok(page.scanned <= 1);
    assert.ok(page.receipts.length <= 1);
    assert.equal(page.invalidReceiptPaths.length, 0);
    seenPaths.push(...page.receipts.map((entry) => entry.relativePath));
    cursor = page.nextCursor;
  } while (cursor !== null);

  assert.equal(seenPaths.length, 3);
  assert.equal(new Set(seenPaths).size, 3);
  assert.deepEqual(seenPaths, [...seenPaths].sort());
});

test("recovers when payload sealing committed before the attempt receipt", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-seal-crash-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const input = stageInput();
  await sealResourceRevisionPayload({
    storageRoot,
    workspaceId: input.workspaceId,
    resourceId: input.resourceId,
    revisionId: input.revisionId,
    mimeType: input.mimeType,
    bytes: input.bytes,
  });
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal: journalDouble(),
    now: () => 124_000,
  });

  assert.equal(await staging.find(input), null);
  const staged = await staging.stage(input);
  assert.deepEqual(await staging.find(input), staged);
  assert.equal(await staging.cleanupIfUnreferenced(staged), true);
  assert.equal(await staging.find(input), null);
  assert.equal(lstatSync(join(storageRoot, ...staged.manifestPath.split("/"))).isFile(), true);
  assert.equal(lstatSync(join(
    storageRoot,
    ...`${dirname(staged.manifestPath)}/payload.bin`.split("/"),
  )).isFile(), true);
});

test("converges concurrent identical staging races on one immutable receipt", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-race-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  let timestamp = 130_000;
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal: journalDouble(),
    now: () => timestamp++,
  });
  const input = stageInput();

  const [left, right] = await Promise.all([
    staging.stage(input),
    staging.stage(input),
  ]);

  assert.deepEqual(left, right);
  assert.deepEqual(await staging.find(input), left);
});

test("rejects an immutable revision collision without changing the committed payload", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-collision-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const state = { referenced: false, removals: 0 };
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard(state),
    journal: journalDouble(),
    now: () => 131_000,
  });
  const input = stageInput();
  const committed = await staging.stage(input);

  await assert.rejects(
    staging.stage({
      ...input,
      bytes: new TextEncoder().encode("different bytes for the same revision"),
      summary: "Conflicting generated payload",
    }),
    (error) => error instanceof ResourceTaskPayloadError
      && error.code === "RESOURCE_PAYLOAD_STAGE_FAILED",
  );

  assert.deepEqual(await staging.find(input), committed);
  assert.equal(state.removals, 0);
});

test("deletes owned files only inside an atomic no-reference guard", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-cleanup-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const state = { referenced: true, removals: 0 };
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard(state),
    journal: journalDouble(),
    now: () => 125_000,
  });
  const input = stageInput();
  const receipt = await staging.stage(input);

  assert.equal(await staging.cleanupIfUnreferenced(receipt), false);
  assert.deepEqual(await staging.find(input), receipt);
  state.referenced = false;
  assert.equal(await staging.cleanupIfUnreferenced(receipt), true);
  assert.equal(state.removals, 1);
  assert.equal(await staging.find(input), null);
});

test("pins the durable reference guard method at staging construction", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-guard-pin-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const state = { referenced: false, removals: 0 };
  const guard = referenceGuard(state);
  let substitutedCalls = 0;
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: guard,
    journal: journalDouble(),
  });
  const receipt = await staging.stage(stageInput());
  (guard as { removeIfUnreferenced: ResourceTaskPayloadReferenceGuard["removeIfUnreferenced"] })
    .removeIfUnreferenced = async () => {
      substitutedCalls += 1;
      return false;
    };

  assert.equal(await staging.cleanupIfUnreferenced(receipt), true);
  assert.equal(state.removals, 1);
  assert.equal(substitutedCalls, 0);
});

test("rejects MIME-incompatible bytes without leaving a replay receipt", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-mime-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal: journalDouble(),
    now: () => 126_000,
  });
  const input = stageInput({ mimeType: "image/png" });

  await assert.rejects(staging.stage(input));
  assert.equal(await staging.find(input), null);
});

test("refuses a symlink-substituted receipt during replay", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-symlink-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal: journalDouble(),
    now: () => 127_000,
  });
  const input = stageInput();
  await staging.stage(input);
  const receiptPath = join(storageRoot, ...resourceTaskReceiptRelativePath(
    input.workspaceId,
    input.revisionId,
  ).split("/"));
  const moved = `${receiptPath}.moved`;
  await rename(receiptPath, moved);
  await symlink(moved, receiptPath);

  await assert.rejects(
    staging.find(input),
    (error) => error instanceof ResourceTaskPayloadError
      && error.failureClass === "storage",
  );
});
