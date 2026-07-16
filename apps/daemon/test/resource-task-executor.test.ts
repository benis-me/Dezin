import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeGenerationTaskIntent,
  type GenerationTask,
  type GenerationTaskAttempt,
  type GenerationTaskAttemptClaim,
  type GenerationTaskClaim,
} from "../../../packages/core/src/index.ts";
import { resourceRevisionManifestRelativePath } from "../src/resource-revision-payload.ts";
import {
  ResourceTaskAdapterError,
  ResourceTaskContractError,
  ResourceTaskExecutor,
  ResourceTaskPayloadError,
  VersionedResourceGenerationAdapterRegistry,
  parseResourceGenerationTaskPayloadV2,
  type ResourceTaskPayloadReceipt,
  type ResourceTaskPayloadStageInput,
  type ResourceGenerationAdapterIdentity,
  type ResourceGenerationAdapterOutput,
} from "../src/orchestration/resource-task-executor.ts";

const WORKSPACE_ID = "workspace-resource-executor";
const PLAN_ID = "plan-resource-executor";
const TASK_ID = "task-resource-executor";
const RESOURCE_ID = "resource-generated-hero";

function taskFixture(): GenerationTask {
  return {
    ...normalizeGenerationTaskIntent({
      id: TASK_ID,
      ordinal: 0,
      workspaceId: WORKSPACE_ID,
      planId: PLAN_ID,
      kind: "resource",
      target: { type: "resource", workspaceId: WORKSPACE_ID, id: RESOURCE_ID },
      dependencyIds: [],
      payload: {
        version: 2,
        adapter: { id: "dezin.resource-adapter.asset", version: 1, kind: "asset" },
        operation: {
          operation: "revise",
          nodeId: "node-generated-hero",
          resourceId: RESOURCE_ID,
          kind: "asset",
          title: "Generated hero",
          revisionPolicy: { kind: "generate" },
        },
        brief: {
          proposalRationale: "Create a focused visual hero for the approved concept.",
          assumptions: ["The output is an immutable generated asset."],
          targetInstructions: {
            operation: "revise",
            kind: "asset",
            title: "Generated hero",
          },
        },
        capabilityDescriptors: [{ id: "image-generation", kind: "image", required: true }],
      },
      capabilities: ["image-generation"],
      qaProfile: {
        requiredFrameIds: [],
        blockingSeverities: [],
        requireRuntimeChecks: false,
        requireVisualReview: false,
      },
      resourceLimits: {
        timeoutMs: 120_000,
        maxAgentTurns: 1,
        maxRepairRounds: 0,
        maxOutputBytes: 1_000_000,
        capacityClasses: ["image"],
      },
    }),
    status: "running",
    blockedReason: null,
    blockedByTaskId: null,
    pendingContextPolicy: null,
    currentAttempt: 1,
    materializationFailures: 0,
    failureClass: null,
    error: null,
    nextEligibleAt: null,
    resultRevisionId: null,
    resultResourceRevisionId: null,
    resultSnapshotId: null,
    createdAt: 10_000,
    finishedAt: null,
  };
}

function claimFixture(): GenerationTaskAttemptClaim {
  const task = taskFixture();
  const lease = {
    taskId: task.id,
    workspaceId: task.workspaceId,
    attempt: 1,
    ownerId: "daemon-resource-executor",
    leaseToken: "resource-executor-lease",
  };
  const attempt: GenerationTaskAttempt = {
    taskId: task.id,
    planId: task.planId,
    workspaceId: task.workspaceId,
    attempt: 1,
    target: task.target,
    baseRevisionId: "resource-revision-parent",
    expectedSnapshotId: "snapshot-resource-executor",
    contextPackId: "context-resource-executor",
    kernelRevisionId: "kernel-resource-executor",
    sourceCommitHash: null,
    sourceTreeHash: null,
    payload: task.payload,
    dependencyOutputs: [],
    resourcePins: [],
    componentPins: [],
    inputHash: "resource-input-hash",
    retryContextPolicy: "same-context",
    executionMode: "full",
    attemptOrigin: "materialized",
    predecessorAttempt: null,
    automaticRetryIndex: 0,
    status: "running",
    blockedReason: null,
    failureClass: null,
    error: null,
    nextEligibleAt: null,
    candidateRevisionId: null,
    candidateResourceRevisionId: null,
    candidateEvidence: null,
    candidateEvidenceHash: null,
    lease,
    leaseExpiresAt: 130_000,
    heartbeatAt: 100_000,
    createdAt: 10_000,
    startedAt: 100_000,
    finishedAt: null,
  };
  const claims: GenerationTaskClaim[] = [
    {
      ...lease,
      planId: task.planId,
      claimKey: "capacity:image:1",
      claimKind: "capacity",
      leaseExpiresAt: 130_000,
      createdAt: 100_000,
    },
    {
      ...lease,
      planId: task.planId,
      claimKey: `writer:resource:${Buffer.from(WORKSPACE_ID).toString("hex")}:${Buffer.from(RESOURCE_ID).toString("hex")}`,
      claimKind: "writer",
      leaseExpiresAt: 130_000,
      createdAt: 100_000,
    },
  ];
  return { task, attempt, lease, claims };
}

function receiptFor(input: ResourceTaskPayloadStageInput): ResourceTaskPayloadReceipt {
  return {
    protocol: "dezin.resource-task-payload-receipt.v1",
    taskId: input.taskId,
    attempt: input.attempt,
    inputHash: input.inputHash,
    workspaceId: input.workspaceId,
    resourceId: input.resourceId,
    revisionId: input.revisionId,
    parentRevisionId: input.parentRevisionId,
    adapter: input.adapter,
    manifestPath: resourceRevisionManifestRelativePath(input.workspaceId, input.revisionId),
    manifestChecksum: "a".repeat(64),
    payloadChecksum: "b".repeat(64),
    byteSize: input.bytes.byteLength,
    mimeType: input.mimeType,
    summary: input.summary,
    metadata: input.metadata,
    provenance: input.provenance,
    evidence: input.evidence,
  };
}

function adapterFixture(
  identity: ResourceGenerationAdapterIdentity = {
    id: "dezin.resource-adapter.asset",
    version: 1,
    kind: "asset",
  },
) {
  return {
    identity,
    async generate() {
      return {
        bytes: new TextEncoder().encode("generated hero"),
        mimeType: "text/plain",
        summary: "Generated hero asset",
        metadata: { width: 1440 },
        provenance: { model: "image-model-v3" },
        evidence: { accepted: true },
      };
    },
  };
}

function outputFixture(
  overrides: Partial<ResourceGenerationAdapterOutput> = {},
): ResourceGenerationAdapterOutput {
  return {
    bytes: new TextEncoder().encode("generated hero"),
    mimeType: "text/plain",
    summary: "Generated hero asset",
    metadata: { width: 1440 },
    provenance: { model: "image-model-v3" },
    evidence: { accepted: true },
    ...overrides,
  };
}

function claimWithOutputBudget(maxOutputBytes: number): GenerationTaskAttemptClaim {
  const claim = claimFixture();
  return {
    ...claim,
    task: {
      ...claim.task,
      resourceLimits: { ...claim.task.resourceLimits, maxOutputBytes },
    },
  };
}

test("selects the exact frozen adapter while the executor authors durable Resource identity", async () => {
  const claim = claimFixture();
  const adapterInputs: unknown[] = [];
  const stageInputs: ResourceTaskPayloadStageInput[] = [];
  const cleanupReceipts: ResourceTaskPayloadReceipt[] = [];
  const adapters = new VersionedResourceGenerationAdapterRegistry([{
    identity: { id: "dezin.resource-adapter.asset", version: 1, kind: "asset" },
    async generate(input) {
      adapterInputs.push(input);
      return {
        bytes: new TextEncoder().encode("generated hero"),
        mimeType: "text/plain",
        summary: "Generated hero asset",
        metadata: { width: 1440 },
        provenance: { model: "image-model-v3" },
        evidence: { accepted: true },
      };
    },
  }]);
  const executor = new ResourceTaskExecutor({
    adapters,
    staging: {
      async find() { return null; },
      async stage(input) {
        stageInputs.push(input);
        return receiptFor(input);
      },
      async cleanupIfUnreferenced(receipt) {
        cleanupReceipts.push(receipt);
        return true;
      },
    },
  });

  const result = await executor.execute(claim, new AbortController().signal);

  assert.equal(adapterInputs.length, 1);
  assert.equal(stageInputs.length, 1);
  assert.deepEqual(stageInputs[0]?.adapter, {
    id: "dezin.resource-adapter.asset",
    version: 1,
    kind: "asset",
  });
  assert.match(result.revision.revisionId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(result.revision.parentRevisionId, claim.attempt.baseRevisionId);
  assert.equal(
    result.revision.manifestPath,
    resourceRevisionManifestRelativePath(WORKSPACE_ID, result.revision.revisionId),
  );
  assert.equal(result.revision.checksum, "a".repeat(64));
  assert.deepEqual(result.revision.metadata, {
    adapter: { width: 1440 },
    payload: { mimeType: "text/plain", byteSize: 14, checksum: "b".repeat(64) },
  });
  assert.deepEqual(result.revision.provenance, {
    kind: "generation-task-resource",
    planId: PLAN_ID,
    taskId: TASK_ID,
    attempt: 1,
    inputHash: "resource-input-hash",
    adapter: { id: "dezin.resource-adapter.asset", version: 1, kind: "asset" },
    adapterProvenance: { model: "image-model-v3" },
  });
  assert.deepEqual(result.evidence, {
    taskId: TASK_ID,
    attempt: 1,
    inputHash: "resource-input-hash",
    adapter: { id: "dezin.resource-adapter.asset", version: 1, kind: "asset" },
    payload: { mimeType: "text/plain", byteSize: 14, checksum: "b".repeat(64) },
    adapterEvidence: { accepted: true },
  });
  assert.equal(await executor.cleanupIfUnreferenced(claim, result), true);
  assert.equal(cleanupReceipts.length, 1);
  assert.equal(cleanupReceipts[0]?.revisionId, result.revision.revisionId);
  assert.equal(
    await executor.cleanupIfUnreferenced(claim, structuredClone(result)),
    false,
    "only the exact executor-owned candidate may authorize receipt reconciliation",
  );
});

test("rejects duplicate adapter identities instead of allowing last-registration wins", () => {
  const adapter = adapterFixture();
  assert.throws(
    () => new VersionedResourceGenerationAdapterRegistry([adapter, adapterFixture()]),
    (error) => error instanceof ResourceTaskAdapterError
      && error.failureClass === "adapter"
      && error.code === "RESOURCE_ADAPTER_DUPLICATE",
  );
});

test("reports a deterministic version error when the frozen adapter version is unavailable", () => {
  const registry = new VersionedResourceGenerationAdapterRegistry([
    adapterFixture({ id: "dezin.resource-adapter.asset", version: 2, kind: "asset" }),
  ]);
  assert.throws(
    () => registry.require({ id: "dezin.resource-adapter.asset", version: 1, kind: "asset" }),
    (error) => error instanceof ResourceTaskAdapterError
      && error.failureClass === "adapter"
      && error.code === "RESOURCE_ADAPTER_VERSION_UNAVAILABLE",
  );
});

test("distinguishes missing and wrong-kind adapters without falling back", () => {
  const registry = new VersionedResourceGenerationAdapterRegistry([
    adapterFixture({ id: "dezin.resource-adapter.asset", version: 1, kind: "effect" }),
  ]);
  assert.throws(
    () => registry.require({ id: "dezin.resource-adapter.asset", version: 1, kind: "asset" }),
    (error) => error instanceof ResourceTaskAdapterError
      && error.code === "RESOURCE_ADAPTER_KIND_UNAVAILABLE",
  );
  assert.throws(
    () => registry.require({ id: "missing-generation", version: 1, kind: "asset" }),
    (error) => error instanceof ResourceTaskAdapterError
      && error.code === "RESOURCE_ADAPTER_UNAVAILABLE",
  );
});

test("parses only the exact frozen v2 adapter and Resource operation contract", () => {
  const parsed = parseResourceGenerationTaskPayloadV2(taskFixture());
  assert.deepEqual(parsed, {
    version: 2,
    adapter: { id: "dezin.resource-adapter.asset", version: 1, kind: "asset" },
    operation: {
      operation: "revise",
      nodeId: "node-generated-hero",
      resourceId: RESOURCE_ID,
      kind: "asset",
      title: "Generated hero",
      revisionPolicy: { kind: "generate" },
    },
    brief: {
      proposalRationale: "Create a focused visual hero for the approved concept.",
      assumptions: ["The output is an immutable generated asset."],
      targetInstructions: {
        operation: "revise",
        kind: "asset",
        title: "Generated hero",
      },
    },
    capabilityDescriptors: [{ id: "image-generation", kind: "image", required: true }],
  });
});

test("rejects extra fields at every v2 payload boundary", () => {
  const base = taskFixture();
  const payload = structuredClone(base.payload) as Record<string, unknown>;
  const adapter = payload.adapter as Record<string, unknown>;
  const operation = payload.operation as Record<string, unknown>;
  const revisionPolicy = operation.revisionPolicy as Record<string, unknown>;
  const cases = [
    { ...payload, forged: true },
    { ...payload, adapter: { ...adapter, fallback: "latest" } },
    { ...payload, operation: { ...operation, revisionId: "adapter-forged" } },
    { ...payload, operation: { ...operation, revisionPolicy: { ...revisionPolicy, path: "/tmp/escape" } } },
  ];
  for (const candidate of cases) {
    assert.throws(
      () => parseResourceGenerationTaskPayloadV2({ ...base, payload: candidate }),
      (error) => error instanceof ResourceTaskContractError
        && error.code === "RESOURCE_TASK_PAYLOAD_INVALID",
    );
  }
});

test("rejects legacy payload versions and adapter-operation target mismatches", () => {
  const base = taskFixture();
  assert.throws(
    () => parseResourceGenerationTaskPayloadV2({ ...base, payload: { version: 1, operation: {} } }),
    (error) => error instanceof ResourceTaskContractError
      && error.code === "RESOURCE_TASK_PAYLOAD_VERSION_UNSUPPORTED",
  );
  const payload = structuredClone(base.payload) as Record<string, unknown>;
  assert.throws(
    () => parseResourceGenerationTaskPayloadV2({
      ...base,
      payload: {
        ...payload,
        adapter: { id: "dezin.resource-adapter.effect", version: 1, kind: "effect" },
      },
    }),
    (error) => error instanceof ResourceTaskContractError
      && error.code === "RESOURCE_TASK_PAYLOAD_INVALID",
  );
});

test("rejects a Resource claim whose immutable Attempt does not exactly match its Task", async () => {
  const base = claimFixture();
  const cases: GenerationTaskAttemptClaim[] = [
    {
      ...base,
      attempt: {
        ...base.attempt,
        target: { type: "resource", workspaceId: WORKSPACE_ID, id: "resource-substituted" },
      },
    },
    {
      ...base,
      attempt: { ...base.attempt, payload: { ...base.attempt.payload, forged: true } },
    },
    {
      ...base,
      attempt: { ...base.attempt, contextPackId: null },
    },
    {
      ...base,
      attempt: { ...base.attempt, executionMode: "publication-only" },
    },
    {
      ...base,
      lease: { ...base.lease, leaseToken: "substituted-lease" },
    },
  ];
  for (const claim of cases) {
    let sideEffects = 0;
    const executor = new ResourceTaskExecutor({
      adapters: new VersionedResourceGenerationAdapterRegistry([adapterFixture()]),
      staging: {
        async find() { sideEffects += 1; return null; },
        async stage(input) { sideEffects += 1; return receiptFor(input); },
        async cleanupIfUnreferenced() { sideEffects += 1; return false; },
      },
    });
    await assert.rejects(
      executor.execute(claim, new AbortController().signal),
      (error) => error instanceof ResourceTaskContractError
        && error.code === "RESOURCE_TASK_ATTEMPT_INVALID",
    );
    assert.equal(sideEffects, 0);
  }
});

test("rejects adapter attempts to forge durable identity, paths, or hashes before staging", async () => {
  let staged = false;
  const executor = new ResourceTaskExecutor({
    adapters: new VersionedResourceGenerationAdapterRegistry([{
      ...adapterFixture(),
      async generate() {
        return {
          ...outputFixture(),
          revisionId: "adapter-forged-revision",
          manifestPath: "/tmp/adapter-forged-manifest",
          checksum: "f".repeat(64),
        } as ResourceGenerationAdapterOutput;
      },
    }]),
    staging: {
      async find() { return null; },
      async stage(input) { staged = true; return receiptFor(input); },
      async cleanupIfUnreferenced() { return false; },
    },
  });

  await assert.rejects(
    executor.execute(claimFixture(), new AbortController().signal),
    (error) => error instanceof ResourceTaskAdapterError
      && error.code === "RESOURCE_ADAPTER_OUTPUT_INVALID",
  );
  assert.equal(staged, false);
});

test("turns hostile adapter output reflection into a typed deterministic adapter failure", async () => {
  const output = new Proxy({}, {
    ownKeys() { throw new Error("hostile ownKeys"); },
    get() { throw new Error("hostile get"); },
  }) as ResourceGenerationAdapterOutput;
  const executor = new ResourceTaskExecutor({
    adapters: new VersionedResourceGenerationAdapterRegistry([{
      ...adapterFixture(),
      async generate() { return output; },
    }]),
    staging: {
      async find() { return null; },
      async stage(input) { return receiptFor(input); },
      async cleanupIfUnreferenced() { return false; },
    },
  });

  await assert.rejects(
    executor.execute(claimFixture(), new AbortController().signal),
    (error) => error instanceof ResourceTaskAdapterError
      && error.code === "RESOURCE_ADAPTER_OUTPUT_INVALID",
  );
});

test("rejects invalid MIME, Unicode, textual bytes, and total output budget before staging", async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const cases: Array<{ claim: GenerationTaskAttemptClaim; output: ResourceGenerationAdapterOutput }> = [
    { claim: claimFixture(), output: outputFixture({ mimeType: "text/plain; charset=utf-8" }) },
    { claim: claimFixture(), output: outputFixture({ summary: "broken-\ud800" }) },
    { claim: claimFixture(), output: outputFixture({ bytes: Uint8Array.of(0xff) }) },
    { claim: claimFixture(), output: outputFixture({ metadata: cyclic }) },
    { claim: claimWithOutputBudget(32), output: outputFixture() },
  ];
  for (const { claim, output } of cases) {
    let staged = false;
    const executor = new ResourceTaskExecutor({
      adapters: new VersionedResourceGenerationAdapterRegistry([{
        ...adapterFixture(),
        async generate() { return output; },
      }]),
      staging: {
        async find() { return null; },
        async stage(input) { staged = true; return receiptFor(input); },
        async cleanupIfUnreferenced() { return false; },
      },
    });
    await assert.rejects(
      executor.execute(claim, new AbortController().signal),
      (error) => error instanceof ResourceTaskAdapterError
        && error.code === "RESOURCE_ADAPTER_OUTPUT_INVALID",
    );
    assert.equal(staged, false);
  }
});

test("rejects prototype-pollution keys in adapter-authored JSON records", async () => {
  for (const key of ["__proto__", "prototype", "constructor"]) {
    const metadata = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(metadata, key, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: { polluted: true },
    });
    let staged = false;
    const executor = new ResourceTaskExecutor({
      adapters: new VersionedResourceGenerationAdapterRegistry([{
        ...adapterFixture(),
        async generate() { return outputFixture({ metadata }); },
      }]),
      staging: {
        async find() { return null; },
        async stage(input) { staged = true; return receiptFor(input); },
        async cleanupIfUnreferenced() { return false; },
      },
    });

    await assert.rejects(
      executor.execute(claimFixture(), new AbortController().signal),
      (error) => error instanceof ResourceTaskAdapterError
        && error.code === "RESOURCE_ADAPTER_OUTPUT_INVALID",
      `expected ${key} to be rejected`,
    );
    assert.equal(staged, false);
  }
});

test("replays an attempt-scoped receipt after the payload stage committed but its response was lost", async () => {
  const stored: { value: ResourceTaskPayloadReceipt | null } = { value: null };
  let adapterCalls = 0;
  let stageCalls = 0;
  const executor = new ResourceTaskExecutor({
    adapters: new VersionedResourceGenerationAdapterRegistry([{
      ...adapterFixture(),
      async generate() { adapterCalls += 1; return outputFixture(); },
    }]),
    staging: {
      async find() { return stored.value; },
      async stage(input) {
        stageCalls += 1;
        stored.value = receiptFor(input);
        throw new Error("payload receipt response lost after commit");
      },
      async cleanupIfUnreferenced() { return false; },
    },
  });
  const claim = claimFixture();

  await assert.rejects(
    executor.execute(claim, new AbortController().signal),
    (error) => error instanceof ResourceTaskPayloadError
      && error.failureClass === "storage"
      && error.code === "RESOURCE_PAYLOAD_STAGE_FAILED",
  );
  const replay = await executor.execute(claim, new AbortController().signal);

  assert.equal(adapterCalls, 1);
  assert.equal(stageCalls, 1);
  assert.ok(stored.value);
  assert.equal(replay.revision.revisionId, stored.value.revisionId);
  assert.equal(replay.revision.parentRevisionId, claim.attempt.baseRevisionId);
});

test("rejects a forged staged receipt and asks only the staging boundary for orphan-safe cleanup", async () => {
  let cleanupCalls = 0;
  const cleanup: { receipt: ResourceTaskPayloadReceipt | null } = { receipt: null };
  const executor = new ResourceTaskExecutor({
    adapters: new VersionedResourceGenerationAdapterRegistry([adapterFixture()]),
    staging: {
      async find() { return null; },
      async stage(input) {
        return { ...receiptFor(input), parentRevisionId: "forged-parent" };
      },
      async cleanupIfUnreferenced(receipt) {
        cleanupCalls += 1;
        cleanup.receipt = receipt;
        // A production implementation may delete only after confirming there
        // is no candidate or Resource Revision reference.
        return false;
      },
    },
  });

  await assert.rejects(
    executor.execute(claimFixture(), new AbortController().signal),
    (error) => error instanceof ResourceTaskPayloadError
      && error.code === "RESOURCE_PAYLOAD_RECEIPT_INVALID",
  );
  assert.equal(cleanupCalls, 1);
  assert.ok(cleanup.receipt);
  assert.equal(cleanup.receipt.parentRevisionId, "forged-parent");
});

test("fails closed on a forged replay receipt without invoking the adapter or deleting unknown storage", async () => {
  const claim = claimFixture();
  const validInput: ResourceTaskPayloadStageInput = {
    taskId: claim.task.id,
    attempt: claim.attempt.attempt,
    inputHash: claim.attempt.inputHash,
    workspaceId: claim.task.workspaceId,
    resourceId: RESOURCE_ID,
    revisionId: "00000000-0000-5000-8000-000000000000",
    parentRevisionId: claim.attempt.baseRevisionId,
    adapter: { id: "dezin.resource-adapter.asset", version: 1, kind: "asset" },
    maxOutputBytes: claim.task.resourceLimits.maxOutputBytes,
    lease: claim.lease,
    bytes: new TextEncoder().encode("generated hero"),
    mimeType: "text/plain",
    summary: "Generated hero asset",
    metadata: { width: 1440 },
    provenance: { model: "image-model-v3" },
    evidence: { accepted: true },
    signal: new AbortController().signal,
  };
  const forged = {
    ...receiptFor(validInput),
    revisionId: "adapter-substituted-revision",
    manifestPath: "../../escape/manifest.json",
  };
  let adapterCalls = 0;
  let cleanupCalls = 0;
  const executor = new ResourceTaskExecutor({
    adapters: new VersionedResourceGenerationAdapterRegistry([{
      ...adapterFixture(),
      async generate() { adapterCalls += 1; return outputFixture(); },
    }]),
    staging: {
      async find() { return forged; },
      async stage(input) { return receiptFor(input); },
      async cleanupIfUnreferenced() { cleanupCalls += 1; return true; },
    },
  });

  await assert.rejects(
    executor.execute(claim, new AbortController().signal),
    (error) => error instanceof ResourceTaskPayloadError
      && error.code === "RESOURCE_PAYLOAD_RECEIPT_INVALID",
  );
  assert.equal(adapterCalls, 0);
  assert.equal(cleanupCalls, 0);
});

test("honors AbortSignal before generation, after adapter output, and after staging", async () => {
  const pre = new AbortController();
  const preReason = new DOMException("pre-aborted", "AbortError");
  pre.abort(preReason);
  let preSideEffects = 0;
  const preExecutor = new ResourceTaskExecutor({
    adapters: new VersionedResourceGenerationAdapterRegistry([adapterFixture()]),
    staging: {
      async find() { preSideEffects += 1; return null; },
      async stage(input) { preSideEffects += 1; return receiptFor(input); },
      async cleanupIfUnreferenced() { preSideEffects += 1; return false; },
    },
  });
  await assert.rejects(preExecutor.execute(claimFixture(), pre.signal), (error) => error === preReason);
  assert.equal(preSideEffects, 0);

  const afterAdapter = new AbortController();
  const adapterReason = new DOMException("adapter-aborted", "AbortError");
  let adapterStages = 0;
  const adapterExecutor = new ResourceTaskExecutor({
    adapters: new VersionedResourceGenerationAdapterRegistry([{
      ...adapterFixture(),
      async generate() { afterAdapter.abort(adapterReason); return outputFixture(); },
    }]),
    staging: {
      async find() { return null; },
      async stage(input) { adapterStages += 1; return receiptFor(input); },
      async cleanupIfUnreferenced() { return false; },
    },
  });
  await assert.rejects(
    adapterExecutor.execute(claimFixture(), afterAdapter.signal),
    (error) => error === adapterReason,
  );
  assert.equal(adapterStages, 0);

  const afterStage = new AbortController();
  const stageReason = new DOMException("stage-aborted", "AbortError");
  let cleanups = 0;
  const stageExecutor = new ResourceTaskExecutor({
    adapters: new VersionedResourceGenerationAdapterRegistry([adapterFixture()]),
    staging: {
      async find() { return null; },
      async stage(input) { afterStage.abort(stageReason); return receiptFor(input); },
      async cleanupIfUnreferenced() { cleanups += 1; return false; },
    },
  });
  await assert.rejects(
    stageExecutor.execute(claimFixture(), afterStage.signal),
    (error) => error === stageReason,
  );
  assert.equal(cleanups, 1);
});

test("pins adapter identity and implementation at registry construction", async () => {
  const identity: { id: string; version: number; kind: "asset" | "effect" } = {
    id: "dezin.resource-adapter.asset",
    version: 1,
    kind: "asset",
  };
  const adapter = {
    identity,
    async generate() { return outputFixture({ summary: "Pinned implementation" }); },
  };
  const registry = new VersionedResourceGenerationAdapterRegistry([adapter]);
  identity.id = "dezin.resource-adapter.effect";
  identity.kind = "effect";
  adapter.generate = async () => outputFixture({ summary: "Mutated implementation" });

  const pinned = registry.require({
    id: "dezin.resource-adapter.asset",
    version: 1,
    kind: "asset",
  });
  const result = await pinned.generate({ signal: new AbortController().signal } as never);
  assert.deepEqual(pinned.identity, {
    id: "dezin.resource-adapter.asset",
    version: 1,
    kind: "asset",
  });
  assert.equal(result.summary, "Pinned implementation");
});

test("pins executor composition instead of following later options mutation", async () => {
  let originalStages = 0;
  let substitutedStages = 0;
  const options = {
    adapters: new VersionedResourceGenerationAdapterRegistry([adapterFixture()]),
    staging: {
      async find() { return null; },
      async stage(input: ResourceTaskPayloadStageInput) {
        originalStages += 1;
        return receiptFor(input);
      },
      async cleanupIfUnreferenced() { return false; },
    },
  };
  const executor = new ResourceTaskExecutor(options);
  options.staging = {
    async find() { return null; },
    async stage(input) { substitutedStages += 1; return receiptFor(input); },
    async cleanupIfUnreferenced() { return false; },
  };

  await executor.execute(claimFixture(), new AbortController().signal);
  assert.equal(originalStages, 1);
  assert.equal(substitutedStages, 0);
});

test("rejects accessor-backed payload, adapter output, and receipt fields without invoking them", async () => {
  let payloadGetterCalls = 0;
  const task = taskFixture();
  const payload = structuredClone(task.payload) as Record<string, unknown>;
  Object.defineProperty(payload, "version", {
    enumerable: true,
    get() { payloadGetterCalls += 1; return 2; },
  });
  assert.throws(
    () => parseResourceGenerationTaskPayloadV2({ ...task, payload }),
    (error) => error instanceof ResourceTaskContractError,
  );
  assert.equal(payloadGetterCalls, 0);

  let outputGetterCalls = 0;
  const output = outputFixture() as unknown as Record<string, unknown>;
  Object.defineProperty(output, "bytes", {
    enumerable: true,
    get() { outputGetterCalls += 1; return new TextEncoder().encode("generated hero"); },
  });
  const outputExecutor = new ResourceTaskExecutor({
    adapters: new VersionedResourceGenerationAdapterRegistry([{
      ...adapterFixture(),
      async generate() { return output as unknown as ResourceGenerationAdapterOutput; },
    }]),
    staging: {
      async find() { return null; },
      async stage(input) { return receiptFor(input); },
      async cleanupIfUnreferenced() { return false; },
    },
  });
  await assert.rejects(
    outputExecutor.execute(claimFixture(), new AbortController().signal),
    (error) => error instanceof ResourceTaskAdapterError,
  );
  assert.equal(outputGetterCalls, 0);

  const receiptClaim = claimFixture();
  let capturedScope: ResourceTaskPayloadStageInput | null = null;
  const captureExecutor = new ResourceTaskExecutor({
    adapters: new VersionedResourceGenerationAdapterRegistry([adapterFixture()]),
    staging: {
      async find() { return null; },
      async stage(input) { capturedScope = input; return receiptFor(input); },
      async cleanupIfUnreferenced() { return false; },
    },
  });
  await captureExecutor.execute(receiptClaim, new AbortController().signal);
  assert.ok(capturedScope);
  const receipt = receiptFor(capturedScope);
  let receiptGetterCalls = 0;
  Object.defineProperty(receipt, "summary", {
    enumerable: true,
    get() { receiptGetterCalls += 1; return "Generated hero asset"; },
  });
  const receiptExecutor = new ResourceTaskExecutor({
    adapters: new VersionedResourceGenerationAdapterRegistry([adapterFixture()]),
    staging: {
      async find() { return receipt; },
      async stage(input) { return receiptFor(input); },
      async cleanupIfUnreferenced() { return false; },
    },
  });
  await assert.rejects(
    receiptExecutor.execute(receiptClaim, new AbortController().signal),
    (error) => error instanceof ResourceTaskPayloadError,
  );
  assert.equal(receiptGetterCalls, 0);
});
