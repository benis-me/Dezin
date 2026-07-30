import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GenerationTaskQualityGateError,
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
const DISPATCH_CONTEXT_PACK_ID = `context-pack-${"a".repeat(64)}`;
const RESOURCE_INSTRUCTIONS = [
  "Generate exactly three evidence-backed hero directions.",
  "Compare cinematic, editorial, and cobalt-grid treatments before recommending one.",
].join(" ");

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
          instructions: RESOURCE_INSTRUCTIONS,
          revisionPolicy: { kind: "generate" },
          dispatchContextPackId: DISPATCH_CONTEXT_PACK_ID,
        },
        brief: {
          proposalRationale: "Create a focused visual hero for the approved concept.",
          assumptions: ["The output is an immutable generated asset."],
          targetInstructions: {
            operation: "revise",
            kind: "asset",
            title: "Generated hero",
            instructions: RESOURCE_INSTRUCTIONS,
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
    contextPackId: `context-pack-${"c".repeat(64)}`,
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

function researchClaimFixture(): GenerationTaskAttemptClaim {
  const claim = claimFixture();
  const payload = structuredClone(claim.task.payload) as Record<string, any>;
  payload.adapter = {
    id: "dezin.resource-adapter.research",
    version: 1,
    kind: "research",
  };
  payload.operation = {
    ...payload.operation,
    kind: "research",
    title: "KITE Research",
  };
  payload.brief = {
    ...payload.brief,
    targetInstructions: {
      ...payload.brief.targetInstructions,
      kind: "research",
      title: "KITE Research",
      instructions: [
        "Use decision-grade verified Web evidence.",
        "Require at least two independent evidence findings and one evidence-backed design direction.",
      ].join(" "),
    },
  };
  payload.operation.instructions = payload.brief.targetInstructions.instructions;
  return {
    ...claim,
    task: { ...claim.task, payload },
    attempt: { ...claim.attempt, payload: structuredClone(payload) },
  };
}

function rejectedResearchDecisionGradeMetadata(): Record<string, unknown> {
  return {
    format: "dezin-research-resource-bundle",
    version: 3,
    qualityState: "needs-review",
    decisionGradeGate: {
      protocol: "dezin.research-decision-grade-gate.v2",
      criteria: {
        minimumVerifiedWebSourceCount: 2,
        minimumEvidenceFindingCount: 2,
        minimumEvidenceDirectionCount: 1,
        requiresGroundednessVerifier: true,
      },
      observed: {
        verifiedWebSourceCount: 2,
        evidenceFindingCount: 2,
        evidenceDirectionCount: 0,
        groundednessVerifierAvailable: true,
      },
      accepted: false,
      blockers: ["insufficient-evidence-directions"],
    },
  };
}

function acceptedResearchDecisionGradeMetadata(): Record<string, unknown> {
  const metadata = structuredClone(rejectedResearchDecisionGradeMetadata()) as Record<string, any>;
  metadata.qualityState = "grounded";
  metadata.decisionGradeGate.observed.evidenceDirectionCount = 1;
  metadata.decisionGradeGate.accepted = true;
  metadata.decisionGradeGate.blockers = [];
  return metadata;
}

function researchRepairDiagnosticFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    decision: "changed-unresolved",
    optionCount: 1,
    quoteCount: 3,
    matchingOptionCount: 0,
    candidateExcerptByteLength: 96,
    candidateExcerptIdentityHash: "a".repeat(64),
    sourceIdentityHash: "b".repeat(64),
    requestedUrlHash: "c".repeat(64),
    sourceIdSameAsFirstPass: true,
    requestedUrlSameAsFirstPass: true,
    selectedOptionIdentityHash: null,
    canonicalUrlSameAsFirstPass: true,
    canonicalTextChecksumSameAsFirstPass: true,
    receiptReason: "excerpt-mismatch",
    ...overrides,
  };
}

function researchEvidenceCoverageFixture(): Record<string, unknown> {
  return {
    protocol: "dezin.research-evidence-coverage.v1",
    repairMode: "full-replacement",
    firstPassGate: {
      observed: {
        verifiedWebSourceCount: 0,
        evidenceFindingCount: 2,
        evidenceDirectionCount: 0,
        groundednessVerifierAvailable: true,
      },
      blockers: [
        "insufficient-verified-web-sources",
        "insufficient-evidence-directions",
      ],
    },
    finalPass: {
      webSourceCount: 3,
      verifiedWebReceiptCount: 2,
      unverifiedWebReceiptCount: 1,
      verifiedWebSupportReceiptCount: 3,
      groundednessSelectedWebSupportReceiptCount: 2,
      groundednessSelectedWebSourceCount: 2,
      groundednessSelectedWebCanonicalComponentCount: 2,
      evidenceFindingCount: 2,
      evidenceDirectionCount: 1,
      qualifyingDecisionGradeDirectionCount: 0,
      maximumDirectionEvidenceFindingCount: 1,
      maximumDirectionVerifiedWebComponentCount: 1,
    },
  };
}

test("selects the exact frozen adapter while the executor authors durable Resource identity", async () => {
  const claim = claimFixture();
  const adapterInputs: unknown[] = [];
  const stageInputs: ResourceTaskPayloadStageInput[] = [];
  const cleanupReceipts: ResourceTaskPayloadReceipt[] = [];
  const progress: Array<{ claim: GenerationTaskAttemptClaim; phase: string }> = [];
  const adapters = new VersionedResourceGenerationAdapterRegistry([{
    identity: { id: "dezin.resource-adapter.asset", version: 1, kind: "asset" },
    async generate(input) {
      adapterInputs.push(input);
      await input.reportProgress?.("generating");
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
    progress: {
      record(progressClaim, phase) {
        progress.push({ claim: progressClaim, phase });
      },
    },
  });

  const result = await executor.execute(claim, new AbortController().signal);

  assert.equal(adapterInputs.length, 1);
  assert.deepEqual(progress.map((entry) => entry.phase), ["generating", "publishing"]);
  assert.ok(progress.every((entry) => entry.claim === claim));
  assert.equal(
    (adapterInputs[0] as { taskTimeoutMs?: number }).taskTimeoutMs,
    claim.task.resourceLimits.timeoutMs,
    "the adapter receives the exact immutable outer Task timeout instead of relying only on its AbortSignal",
  );
  assert.equal(
    (adapterInputs[0] as { maxOutputBytes?: number }).maxOutputBytes,
    claim.task.resourceLimits.maxOutputBytes,
    "the adapter receives the exact immutable output budget instead of silently applying a smaller global default",
  );
  assert.equal(
    (adapterInputs[0] as { maxRepairRounds?: number }).maxRepairRounds,
    claim.task.resourceLimits.maxRepairRounds,
    "the adapter receives the exact immutable repair budget instead of inventing an internal retry count",
  );
  assert.equal(
    (adapterInputs[0] as {
      brief?: { targetInstructions?: { instructions?: string } };
    }).brief?.targetInstructions?.instructions,
    RESOURCE_INSTRUCTIONS,
    "the exact approved Resource leaf brief reaches the generation adapter boundary",
  );
  assert.equal(stageInputs.length, 1);
  assert.deepEqual(stageInputs[0]?.adapter, {
    id: "dezin.resource-adapter.asset",
    version: 1,
    kind: "asset",
  });
  assert.equal(stageInputs[0]?.contextPackId, claim.attempt.contextPackId);
  assert.equal(stageInputs[0]?.contextPackHash, "c".repeat(64));
  assert.match(result.revision.revisionId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(result.revision.parentRevisionId, claim.attempt.baseRevisionId);
  assert.equal(
    result.revision.manifestPath,
    resourceRevisionManifestRelativePath(WORKSPACE_ID, result.revision.revisionId),
  );
  assert.equal(result.revision.checksum, "a".repeat(64));
  assert.deepEqual(result.revision.metadata, {
    mimeType: "text/plain",
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

test("accepts alias-free Moodboard reviewer evidence through portable adapter normalization", async () => {
  const claim = claimFixture();
  const stageInputs: ResourceTaskPayloadStageInput[] = [];
  const evidence = {
    qualityReviews: [{
      id: "asset-1",
      checksum: "c".repeat(64),
      reviewer: { id: "codex", model: "gpt-5.4-mini" },
      decision: "pass",
      semanticMatch: true,
      visualQuality: "pass",
    }],
    qualityReviewHistory: [{
      id: "asset-1",
      reviewer: { id: "codex", model: "gpt-5.4-mini" },
      reviews: [{
        round: 0,
        reviewer: { id: "codex", model: "gpt-5.4-mini" },
        promptChecksum: "d".repeat(64),
        imageChecksum: "c".repeat(64),
        decision: "pass",
        semanticMatch: true,
        visualQuality: "pass",
        findings: [],
      }],
    }],
  };
  const executor = new ResourceTaskExecutor({
    adapters: new VersionedResourceGenerationAdapterRegistry([{
      ...adapterFixture(),
      async generate() {
        return outputFixture({ evidence });
      },
    }]),
    staging: {
      async find() { return null; },
      async stage(input) {
        stageInputs.push(input);
        return receiptFor(input);
      },
      async cleanupIfUnreferenced() { return false; },
    },
  });

  const result = await executor.execute(claim, new AbortController().signal);

  assert.equal(stageInputs.length, 1);
  assert.deepEqual(stageInputs[0]!.evidence, evidence);
  assert.deepEqual(result.evidence.adapterEvidence, evidence);
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
      instructions: RESOURCE_INSTRUCTIONS,
      revisionPolicy: { kind: "generate" },
      dispatchContextPackId: DISPATCH_CONTEXT_PACK_ID,
    },
    brief: {
      proposalRationale: "Create a focused visual hero for the approved concept.",
      assumptions: ["The output is an immutable generated asset."],
      targetInstructions: {
        operation: "revise",
        kind: "asset",
        title: "Generated hero",
        instructions: RESOURCE_INSTRUCTIONS,
      },
    },
    capabilityDescriptors: [{ id: "image-generation", kind: "image", required: true }],
  });
});

test("rejects substituted or oversized Resource instructions while reading exact legacy pairs", () => {
  const base = taskFixture();
  const payload = structuredClone(base.payload) as Record<string, unknown>;
  const operation = payload.operation as Record<string, unknown>;
  const brief = payload.brief as Record<string, unknown>;
  const targetInstructions = brief.targetInstructions as Record<string, unknown>;

  assert.throws(
    () => parseResourceGenerationTaskPayloadV2({
      ...base,
      payload: {
        ...payload,
        brief: {
          ...brief,
          targetInstructions: { ...targetInstructions, instructions: "Substituted brief" },
        },
      },
    }),
    (error) => error instanceof ResourceTaskContractError
      && error.code === "RESOURCE_TASK_PAYLOAD_INVALID"
      && /target instructions do not match/i.test(error.message),
  );
  const oversized = "x".repeat(2_001);
  assert.throws(
    () => parseResourceGenerationTaskPayloadV2({
      ...base,
      payload: {
        ...payload,
        operation: { ...operation, instructions: oversized },
        brief: {
          ...brief,
          targetInstructions: { ...targetInstructions, instructions: oversized },
        },
      },
    }),
    (error) => error instanceof ResourceTaskContractError
      && error.code === "RESOURCE_TASK_PAYLOAD_INVALID",
  );

  const { instructions: _operationInstructions, ...legacyOperation } = operation;
  const { instructions: _targetInstructions, ...legacyTargetInstructions } = targetInstructions;
  const legacy = parseResourceGenerationTaskPayloadV2({
    ...base,
    payload: {
      ...payload,
      operation: legacyOperation,
      brief: { ...brief, targetInstructions: legacyTargetInstructions },
    },
  });
  assert.equal(legacy.operation.instructions, undefined);
  assert.equal(legacy.brief.targetInstructions.instructions, undefined);
});

test("preserves legacy v2 payloads without Agent and strictly parses every present execution authority", () => {
  const base = taskFixture();
  assert.equal(parseResourceGenerationTaskPayloadV2(base).agent, undefined);

  const payload = structuredClone(base.payload) as Record<string, unknown>;
  const agent = {
    providerId: "trae",
    command: "trae-cli",
    model: "doubao-seed-1.6",
    executionAuthority: {
      kind: "generator",
      baseUrl: "https://agents.example.test/v1/",
      organization: "dezin",
      credentialProviderId: "trae",
      credentialSource: "agent",
      credentialRequired: true,
    },
  };
  assert.deepEqual(
    parseResourceGenerationTaskPayloadV2({ ...base, payload: { ...payload, agent } }).agent,
    agent,
  );
  assert.throws(
    () => parseResourceGenerationTaskPayloadV2({
      ...base,
      payload: { ...payload, agent, reviewerAuthorityAgent: agent },
    }),
    (error) => error instanceof ResourceTaskContractError
      && error.code === "RESOURCE_TASK_PAYLOAD_INVALID"
      && /valid only for generated Research/i.test(error.message),
  );

  const invalidAgents: unknown[] = [
    { ...agent, extra: true },
    { providerId: agent.providerId, command: agent.command, model: agent.model },
    {
      ...agent,
      executionAuthority: { ...agent.executionAuthority, kind: "reviewer" },
    },
    {
      ...agent,
      executionAuthority: { ...agent.executionAuthority, credentialProviderId: "openai" },
    },
    {
      ...agent,
      executionAuthority: { ...agent.executionAuthority, baseUrl: "https://user:secret@example.test/" },
    },
    { ...agent, providerId: "" },
    { ...agent, providerId: " trae" },
    { ...agent, providerId: `trae\0forged` },
    { ...agent, providerId: "x".repeat(257) },
    { ...agent, command: "" },
    { ...agent, command: "trae-cli " },
    { ...agent, command: `trae-cli\0forged` },
    { ...agent, command: "x".repeat(257) },
    { ...agent, model: " doubao-seed-1.6 " },
    { ...agent, model: "gpt\0model" },
    { ...agent, model: "x".repeat(257) },
    undefined,
  ];
  for (const invalidAgent of invalidAgents) {
    assert.throws(
      () => parseResourceGenerationTaskPayloadV2({
        ...base,
        payload: { ...payload, agent: invalidAgent },
      }),
      (error) => error instanceof ResourceTaskContractError
        && error.code === "RESOURCE_TASK_PAYLOAD_INVALID",
    );
  }

  const accessorAgent = { ...agent };
  Object.defineProperty(accessorAgent, "model", {
    enumerable: true,
    get: () => "gpt-5.6-sol",
  });
  assert.throws(
    () => parseResourceGenerationTaskPayloadV2({
      ...base,
      payload: { ...payload, agent: accessorAgent },
    }),
    (error) => error instanceof ResourceTaskContractError
      && error.code === "RESOURCE_TASK_PAYLOAD_INVALID",
  );

  const reviewer = {
    providerId: "claude",
    command: "claude",
    model: "claude-opus-4-6",
    executionAuthority: {
      kind: "reviewer",
      baseUrl: "",
      credentialSource: "session",
      credentialRequired: false,
    },
  };
  assert.deepEqual(
    parseResourceGenerationTaskPayloadV2({
      ...base,
      payload: { ...payload, agent, reviewer },
    }).reviewer,
    reviewer,
  );
  for (const invalidReviewer of [
    { providerId: reviewer.providerId, command: reviewer.command, model: reviewer.model },
    {
      ...reviewer,
      executionAuthority: { ...reviewer.executionAuthority, credentialRequired: true },
    },
    {
      ...reviewer,
      executionAuthority: { ...reviewer.executionAuthority, credentialSource: "unknown" },
    },
  ]) {
    assert.throws(
      () => parseResourceGenerationTaskPayloadV2({
        ...base,
        payload: { ...payload, agent, reviewer: invalidReviewer },
      }),
      (error) => error instanceof ResourceTaskContractError
        && error.code === "RESOURCE_TASK_PAYLOAD_INVALID",
    );
  }

  const researchTask = researchClaimFixture().task;
  const researchPayload = structuredClone(researchTask.payload) as Record<string, unknown>;
  const researchAgent = {
    providerId: "codex",
    command: "codex",
    model: "gpt-5.4-mini",
    executionAuthority: {
      kind: "generator",
      baseUrl: "",
      organization: "",
      credentialProviderId: "openai",
      credentialSource: "session",
      credentialRequired: false,
    },
  };
  const reviewerAuthorityAgent = {
    providerId: "claude",
    command: "claude",
    model: null,
    executionAuthority: {
      kind: "generator",
      baseUrl: "https://agent.example.test/",
      organization: "dezin",
      credentialProviderId: "anthropic",
      credentialSource: "agent",
      credentialRequired: true,
    },
  };
  const agentSourceReviewer = {
    providerId: "claude",
    command: "claude",
    model: "claude-opus-4-6",
    executionAuthority: {
      kind: "reviewer",
      baseUrl: "https://agent.example.test/",
      credentialSource: "agent",
      credentialRequired: true,
    },
  };
  const parsedResearch = parseResourceGenerationTaskPayloadV2({
    ...researchTask,
    payload: {
      ...researchPayload,
      agent: researchAgent,
      reviewerAuthorityAgent,
      reviewer: agentSourceReviewer,
    },
  });
  assert.deepEqual(parsedResearch.agent, researchAgent);
  assert.deepEqual(parsedResearch.reviewerAuthorityAgent, reviewerAuthorityAgent);
  assert.deepEqual(parsedResearch.reviewer, agentSourceReviewer);

  assert.throws(
    () => parseResourceGenerationTaskPayloadV2({
      ...researchTask,
      payload: {
        ...researchPayload,
        agent: researchAgent,
        reviewer: agentSourceReviewer,
      },
    }),
    (error) => error instanceof ResourceTaskContractError
      && error.code === "RESOURCE_TASK_PAYLOAD_INVALID"
      && /must match the frozen Claude generator authority/i.test(error.message),
  );
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
    { ...payload, operation: { ...operation, dispatchContextPackId: `context-pack-${"A".repeat(64)}` } },
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

test("rejects a Research candidate whose decision-grade gate has no evidence-backed direction", async () => {
  const claim = researchClaimFixture();
  const output = outputFixture({
    mimeType: "application/json",
    bytes: new TextEncoder().encode(JSON.stringify({ format: "dezin-research-resource-bundle", version: 3 })),
    metadata: rejectedResearchDecisionGradeMetadata(),
    evidence: {
      receipts: [
        { sourceKind: "web", verification: "unverified", reason: "excerpt-mismatch" },
        { sourceKind: "web", verification: "unverified", reason: "network-failed" },
        { sourceKind: "web", verification: "unverified", reason: "excerpt-mismatch" },
        { sourceKind: "web", verification: "unverified", reason: "binding-unavailable" },
        { sourceKind: "web", verification: "unverified", reason: "binding-rejected" },
        { sourceKind: "web", verification: "unverified", reason: "binding-invalid" },
        { sourceKind: "context", verification: "verified" },
        { sourceKind: "web", verification: "verified" },
      ],
      canonicalExcerptRepairDiagnostics: [{
        decision: "changed-unresolved",
        optionCount: 1,
        quoteCount: 3,
        matchingOptionCount: 0,
        candidateExcerptByteLength: 96,
        candidateExcerptIdentityHash: "a".repeat(64),
        sourceIdentityHash: "b".repeat(64),
        requestedUrlHash: "c".repeat(64),
        sourceIdSameAsFirstPass: true,
        requestedUrlSameAsFirstPass: true,
        selectedOptionIdentityHash: null,
        canonicalUrlSameAsFirstPass: true,
        canonicalTextChecksumSameAsFirstPass: true,
        receiptReason: "excerpt-mismatch",
      }],
      researchEvidenceCoverage: researchEvidenceCoverageFixture(),
    },
  });
  let staged = false;
  const executor = new ResourceTaskExecutor({
    adapters: new VersionedResourceGenerationAdapterRegistry([{
      identity: {
        id: "dezin.resource-adapter.research",
        version: 1,
        kind: "research",
      },
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
    (error) => {
      assert.ok(error instanceof GenerationTaskQualityGateError);
      assert.equal(error.failureClass, "qa");
      assert.equal(error.code, "generation-task-quality-gate");
      assert.match(error.message, /insufficient-evidence-directions/i);
      assert.deepEqual(error.details, {
        protocol: "dezin.research-decision-grade-rejection.v1",
        criteria: {
          minimumVerifiedWebSourceCount: 2,
          minimumEvidenceFindingCount: 2,
          minimumEvidenceDirectionCount: 1,
          requiresGroundednessVerifier: true,
        },
        observed: {
          verifiedWebSourceCount: 2,
          evidenceFindingCount: 2,
          evidenceDirectionCount: 0,
          groundednessVerifierAvailable: true,
        },
        blockers: ["insufficient-evidence-directions"],
        webEvidenceFailureReasonCounts: {
          "network-failed": 1,
          "excerpt-mismatch": 2,
          "binding-unavailable": 1,
          "binding-rejected": 1,
          "binding-invalid": 1,
        },
        canonicalExcerptRepairDiagnostics: [{
          decision: "changed-unresolved",
          optionCount: 1,
          quoteCount: 3,
          matchingOptionCount: 0,
          candidateExcerptByteLength: 96,
          candidateExcerptIdentityHash: "a".repeat(64),
          sourceIdentityHash: "b".repeat(64),
          requestedUrlHash: "c".repeat(64),
          sourceIdSameAsFirstPass: true,
          requestedUrlSameAsFirstPass: true,
          selectedOptionIdentityHash: null,
          canonicalUrlSameAsFirstPass: true,
          canonicalTextChecksumSameAsFirstPass: true,
          receiptReason: "excerpt-mismatch",
        }],
        researchEvidenceCoverage: researchEvidenceCoverageFixture(),
      });
      assert.ok(Object.isFrozen(error.details?.researchEvidenceCoverage));
      assert.ok(Object.isFrozen(
        (error.details?.researchEvidenceCoverage as { finalPass: unknown }).finalPass,
      ));
      return true;
    },
  );
  assert.equal(staged, false);
});

test("rejects rejection-only repair diagnostics on an accepted grounded Research candidate before staging", async () => {
  let staged = false;
  const executor = new ResourceTaskExecutor({
    adapters: new VersionedResourceGenerationAdapterRegistry([{
      identity: {
        id: "dezin.resource-adapter.research",
        version: 1,
        kind: "research",
      },
      async generate() {
        return outputFixture({
          mimeType: "application/json",
          bytes: new TextEncoder().encode(JSON.stringify({
            format: "dezin-research-resource-bundle",
            version: 3,
          })),
          metadata: acceptedResearchDecisionGradeMetadata(),
          evidence: {
            canonicalExcerptRepairDiagnostics: [researchRepairDiagnosticFixture()],
          },
        });
      },
    }]),
    staging: {
      async find() { return null; },
      async validate() {},
      async stage(input) { staged = true; return receiptFor(input); },
      async cleanupIfUnreferenced() { return false; },
    },
  });

  await assert.rejects(
    executor.execute(researchClaimFixture(), new AbortController().signal),
    (error) => error instanceof ResourceTaskAdapterError
      && error.code === "RESOURCE_ADAPTER_OUTPUT_INVALID"
      && /rejection-only.*diagnostic/i.test(error.message),
  );
  assert.equal(staged, false);
});

test("rejects rejection-only Research evidence coverage on an accepted grounded candidate", async () => {
  const coverage = structuredClone(researchEvidenceCoverageFixture()) as Record<string, any>;
  coverage.finalPass.evidenceDirectionCount = 1;
  coverage.finalPass.qualifyingDecisionGradeDirectionCount = 1;
  coverage.finalPass.maximumDirectionEvidenceFindingCount = 2;
  coverage.finalPass.maximumDirectionVerifiedWebComponentCount = 2;
  let staged = false;
  const executor = new ResourceTaskExecutor({
    adapters: new VersionedResourceGenerationAdapterRegistry([{
      identity: {
        id: "dezin.resource-adapter.research",
        version: 1,
        kind: "research",
      },
      async generate() {
        return outputFixture({
          mimeType: "application/json",
          bytes: new TextEncoder().encode(JSON.stringify({
            format: "dezin-research-resource-bundle",
            version: 3,
          })),
          metadata: acceptedResearchDecisionGradeMetadata(),
          evidence: { researchEvidenceCoverage: coverage },
        });
      },
    }]),
    staging: {
      async find() { return null; },
      async validate() {},
      async stage(input) { staged = true; return receiptFor(input); },
      async cleanupIfUnreferenced() { return false; },
    },
  });

  await assert.rejects(
    executor.execute(researchClaimFixture(), new AbortController().signal),
    (error) => error instanceof ResourceTaskAdapterError
      && error.code === "RESOURCE_ADAPTER_OUTPUT_INVALID"
      && /accepted.*rejection-only/i.test(error.message),
  );
  assert.equal(staged, false);
});

test("rejects proxied Research evidence coverage before it can become a durable error detail", async () => {
  let staged = false;
  const executor = new ResourceTaskExecutor({
    adapters: new VersionedResourceGenerationAdapterRegistry([{
      identity: {
        id: "dezin.resource-adapter.research",
        version: 1,
        kind: "research",
      },
      async generate() {
        return outputFixture({
          mimeType: "application/json",
          bytes: new TextEncoder().encode(JSON.stringify({
            format: "dezin-research-resource-bundle",
            version: 3,
          })),
          metadata: rejectedResearchDecisionGradeMetadata(),
          evidence: {
            researchEvidenceCoverage: new Proxy(researchEvidenceCoverageFixture(), {}),
          },
        });
      },
    }]),
    staging: {
      async find() { return null; },
      async stage(input) { staged = true; return receiptFor(input); },
      async cleanupIfUnreferenced() { return false; },
    },
  });

  await assert.rejects(
    executor.execute(researchClaimFixture(), new AbortController().signal),
    (error) => error instanceof ResourceTaskAdapterError
      && error.code === "RESOURCE_ADAPTER_OUTPUT_INVALID",
  );
  assert.equal(staged, false);
});

test("rejects malformed, extended, or unbounded Research evidence coverage", async () => {
  const malformedProtocol = structuredClone(researchEvidenceCoverageFixture()) as Record<string, any>;
  malformedProtocol.protocol = "dezin.research-evidence-coverage.v2";
  const noneWithFirstPass = structuredClone(researchEvidenceCoverageFixture()) as Record<string, any>;
  noneWithFirstPass.repairMode = "none";
  const repairWithoutFirstPass = structuredClone(researchEvidenceCoverageFixture()) as Record<string, any>;
  repairWithoutFirstPass.firstPassGate = null;
  const unknownBlocker = structuredClone(researchEvidenceCoverageFixture()) as Record<string, any>;
  unknownBlocker.firstPassGate.blockers = ["agent-authentication-secret"];
  const negativeCount = structuredClone(researchEvidenceCoverageFixture()) as Record<string, any>;
  negativeCount.finalPass.webSourceCount = -1;
  const unboundedCount = structuredClone(researchEvidenceCoverageFixture()) as Record<string, any>;
  unboundedCount.finalPass.webSourceCount = 1_000_001;
  const extendedFinalPass = structuredClone(researchEvidenceCoverageFixture()) as Record<string, any>;
  extendedFinalPass.finalPass.rawSourceUrls = ["https://secret.example.invalid"];
  const inconsistentReceiptTotals = structuredClone(researchEvidenceCoverageFixture()) as Record<string, any>;
  inconsistentReceiptTotals.finalPass.verifiedWebReceiptCount = 3;
  const inconsistentFinalGate = structuredClone(researchEvidenceCoverageFixture()) as Record<string, any>;
  inconsistentFinalGate.finalPass.groundednessSelectedWebCanonicalComponentCount = 1;
  const inconsistentFirstPassGate = structuredClone(researchEvidenceCoverageFixture()) as Record<string, any>;
  inconsistentFirstPassGate.firstPassGate.blockers = ["insufficient-evidence-directions"];
  const cases = [
    ["unsupported protocol", malformedProtocol],
    ["none with first pass", noneWithFirstPass],
    ["repair without first pass", repairWithoutFirstPass],
    ["unknown blocker", unknownBlocker],
    ["negative count", negativeCount],
    ["unbounded count", unboundedCount],
    ["extra field", extendedFinalPass],
    ["inconsistent receipt totals", inconsistentReceiptTotals],
    ["inconsistent final gate", inconsistentFinalGate],
    ["inconsistent first-pass gate", inconsistentFirstPassGate],
  ] as const;

  for (const [label, researchEvidenceCoverage] of cases) {
    let staged = false;
    const executor = new ResourceTaskExecutor({
      adapters: new VersionedResourceGenerationAdapterRegistry([{
        identity: {
          id: "dezin.resource-adapter.research",
          version: 1,
          kind: "research",
        },
        async generate() {
          return outputFixture({
            mimeType: "application/json",
            bytes: new TextEncoder().encode(JSON.stringify({
              format: "dezin-research-resource-bundle",
              version: 3,
            })),
            metadata: rejectedResearchDecisionGradeMetadata(),
            evidence: { researchEvidenceCoverage },
          });
        },
      }]),
      staging: {
        async find() { return null; },
        async stage(input) { staged = true; return receiptFor(input); },
        async cleanupIfUnreferenced() { return false; },
      },
    });

    await assert.rejects(
      executor.execute(researchClaimFixture(), new AbortController().signal),
      (error) => {
        assert.ok(
          error instanceof ResourceTaskAdapterError,
          `${label}: ${error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error)}`,
        );
        assert.equal(error.code, "RESOURCE_ADAPTER_OUTPUT_INVALID", label);
        assert.match(error.message, /evidence coverage/i, label);
        return true;
      },
    );
    assert.equal(staged, false, label);
  }
});

test("rejects malformed Research decision-grade diagnostics before they can become durable details", async () => {
  const metadata = structuredClone(rejectedResearchDecisionGradeMetadata()) as Record<string, any>;
  metadata.decisionGradeGate.criteria.minimumEvidenceDirectionCount = 0;
  let staged = false;
  const executor = new ResourceTaskExecutor({
    adapters: new VersionedResourceGenerationAdapterRegistry([{
      identity: {
        id: "dezin.resource-adapter.research",
        version: 1,
        kind: "research",
      },
      async generate() {
        return outputFixture({
          mimeType: "application/json",
          bytes: new TextEncoder().encode(JSON.stringify({
            format: "dezin-research-resource-bundle",
            version: 3,
          })),
          metadata,
        });
      },
    }]),
    staging: {
      async find() { return null; },
      async stage(input) { staged = true; return receiptFor(input); },
      async cleanupIfUnreferenced() { return false; },
    },
  });

  await assert.rejects(
    executor.execute(researchClaimFixture(), new AbortController().signal),
    (error) => error instanceof ResourceTaskAdapterError
      && error.code === "RESOURCE_ADAPTER_OUTPUT_INVALID",
  );
  assert.equal(staged, false);
});

test("rejects unbounded or unknown Research Web failure diagnostics", async () => {
  const malformedReceipts = [
    Array.from({ length: 65 }, () => ({
      sourceKind: "web",
      verification: "unverified",
      reason: "excerpt-mismatch",
    })),
    [{
      sourceKind: "web",
      verification: "unverified",
      reason: "agent-authentication-secret",
    }],
  ];
  for (const receipts of malformedReceipts) {
    let staged = false;
    const executor = new ResourceTaskExecutor({
      adapters: new VersionedResourceGenerationAdapterRegistry([{
        identity: {
          id: "dezin.resource-adapter.research",
          version: 1,
          kind: "research",
        },
        async generate() {
          return outputFixture({
            mimeType: "application/json",
            bytes: new TextEncoder().encode(JSON.stringify({
              format: "dezin-research-resource-bundle",
              version: 3,
            })),
            metadata: rejectedResearchDecisionGradeMetadata(),
            evidence: { receipts },
          });
        },
      }]),
      staging: {
        async find() { return null; },
        async stage(input) { staged = true; return receiptFor(input); },
        async cleanupIfUnreferenced() { return false; },
      },
    });

    await assert.rejects(
      executor.execute(researchClaimFixture(), new AbortController().signal),
      (error) => error instanceof ResourceTaskAdapterError
        && error.code === "RESOURCE_ADAPTER_OUTPUT_INVALID"
        && /Web evidence failure diagnostics/i.test(error.message),
    );
    assert.equal(staged, false);
  }
});

test("rejects raw, checksum-invalid, or unbounded canonical excerpt repair diagnostics", async () => {
  const rawUrl = "https://secret.example.invalid/raw-evidence";
  const malformedDiagnostics: Array<{ label: string; value: unknown }> = [
    { label: "raw field", value: [researchRepairDiagnosticFixture({ rawUrl })] },
    {
      label: "invalid checksum",
      value: [researchRepairDiagnosticFixture({ candidateExcerptIdentityHash: "a".repeat(63) })],
    },
    {
      label: "unbounded count",
      value: Array.from({ length: 17 }, () => researchRepairDiagnosticFixture()),
    },
  ];
  for (const { label, value: canonicalExcerptRepairDiagnostics } of malformedDiagnostics) {
    let staged = false;
    const executor = new ResourceTaskExecutor({
      adapters: new VersionedResourceGenerationAdapterRegistry([{
        identity: {
          id: "dezin.resource-adapter.research",
          version: 1,
          kind: "research",
        },
        async generate() {
          return outputFixture({
            mimeType: "application/json",
            bytes: new TextEncoder().encode(JSON.stringify({
              format: "dezin-research-resource-bundle",
              version: 3,
            })),
            metadata: rejectedResearchDecisionGradeMetadata(),
            evidence: { canonicalExcerptRepairDiagnostics },
          });
        },
      }]),
      staging: {
        async find() { return null; },
        async stage(input) { staged = true; return receiptFor(input); },
        async cleanupIfUnreferenced() { return false; },
      },
    });

    await assert.rejects(
      executor.execute(researchClaimFixture(), new AbortController().signal),
      (error) => {
        assert.ok(
          error instanceof ResourceTaskAdapterError,
          `${label}: ${error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error)}`,
        );
        assert.equal(error.code, "RESOURCE_ADAPTER_OUTPUT_INVALID");
        assert.match(error.message, /canonical excerpt repair diagnostic/i);
        assert.equal(JSON.stringify(error).includes(rawUrl), false);
        return true;
      },
    );
    assert.equal(staged, false);
  }
});

test("rejects a metadata-only Research v4 bundle without complete payload validation", async () => {
  const payloadBytes = new TextEncoder().encode(JSON.stringify({
    format: "dezin-research-resource-bundle",
    version: 4,
  }));
  const metadata = {
    ...acceptedResearchDecisionGradeMetadata(),
    version: 4,
  };
  let staged = false;
  const executor = new ResourceTaskExecutor({
    adapters: new VersionedResourceGenerationAdapterRegistry([{
      identity: {
        id: "dezin.resource-adapter.research",
        version: 1,
        kind: "research",
      },
      async generate() {
        return outputFixture({
          bytes: payloadBytes,
          mimeType: "application/json",
          summary: "KITE Research direction repair",
          metadata,
          provenance: { model: "gpt-5.4-mini" },
          evidence: { accepted: true },
        });
      },
    }]),
    staging: {
      async find() { return null; },
      async stage(input) {
        staged = true;
        return receiptFor(input);
      },
      async cleanupIfUnreferenced() { return false; },
    },
  });

  await assert.rejects(
    executor.execute(researchClaimFixture(), new AbortController().signal),
    (error) => error instanceof ResourceTaskAdapterError
      && error.code === "RESOURCE_ADAPTER_OUTPUT_INVALID"
      && /complete payload validation/i.test(error.message),
  );
  assert.equal(staged, false);
});

test("rejects a replayed Research payload whose rejected decision-grade gate was staged before publication", async () => {
  const claim = researchClaimFixture();
  const payloadBytes = new TextEncoder().encode(JSON.stringify({
    format: "dezin-research-resource-bundle",
    version: 3,
  }));
  let replay: ResourceTaskPayloadReceipt | null = null;
  const setupExecutor = new ResourceTaskExecutor({
    adapters: new VersionedResourceGenerationAdapterRegistry([{
      identity: {
        id: "dezin.resource-adapter.research",
        version: 1,
        kind: "research",
      },
      async generate() {
        return outputFixture({
          bytes: payloadBytes,
          mimeType: "application/json",
          summary: "KITE Research",
          metadata: acceptedResearchDecisionGradeMetadata(),
          provenance: { model: "gpt-5.4-mini" },
          evidence: { accepted: true },
        });
      },
    }]),
    staging: {
      async find() { return null; },
      async validate() {},
      async stage(input) {
        replay = receiptFor(input);
        return replay;
      },
      async cleanupIfUnreferenced() { return false; },
    },
  });
  await setupExecutor.execute(claim, new AbortController().signal);
  assert.ok(replay);
  const stagedReplay = replay as unknown as ResourceTaskPayloadReceipt;
  assert.equal(
    "canonicalExcerptRepairDiagnostics" in stagedReplay.evidence,
    false,
    "accepted Research staging must not persist rejection-only diagnostics",
  );
  replay = {
    ...stagedReplay,
    metadata: rejectedResearchDecisionGradeMetadata(),
    evidence: { accepted: false },
  };

  let adapterCalls = 0;
  let stageCalls = 0;
  const executor = new ResourceTaskExecutor({
    adapters: new VersionedResourceGenerationAdapterRegistry([{
      identity: {
        id: "dezin.resource-adapter.research",
        version: 1,
        kind: "research",
      },
      async generate() {
        adapterCalls += 1;
        return outputFixture();
      },
    }]),
    staging: {
      async find() { return replay; },
      async stage(input) { stageCalls += 1; return receiptFor(input); },
      async cleanupIfUnreferenced() { return false; },
    },
  });

  await assert.rejects(
    executor.execute(claim, new AbortController().signal),
    (error) => error instanceof GenerationTaskQualityGateError
      && /insufficient-evidence-directions/i.test(error.message),
  );
  assert.equal(adapterCalls, 0);
  assert.equal(stageCalls, 0);
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
    contextPackId: claim.attempt.contextPackId as string,
    contextPackHash: (claim.attempt.contextPackId as string).slice("context-pack-".length),
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
