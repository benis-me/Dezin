import assert from "node:assert/strict";
import test from "node:test";

import type { GenerationTaskContextRequest } from "../src/orchestration/generation-plan-service.ts";
import {
  createProductionResourceExecutionProfileLoader,
  freezeResourceExecutionProfile,
  hydrateResourceImageGeneration,
  hydrateResourceReviewerExecution,
  requireResourceExecutionProfile,
  type FrozenResourceExecutionProfile,
} from "../src/orchestration/production-generation-context.ts";
import {
  checksumBytes,
  estimateContextTokens,
  stableStringify,
  type ContextPack,
} from "../src/context/context-types.ts";
import type { Settings, Store } from "../../../packages/core/src/index.ts";

const OWNERSHIP = Object.freeze({
  projectId: "project-1",
  workspaceId: "workspace-1",
  planId: "plan-1",
  taskId: "task-resource-1",
  targetResourceId: "resource-1",
});

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    agentCommand: "claude",
    model: "claude-sonnet-4-6",
    apiBaseUrl: "https://api.anthropic.example/v1",
    apiKey: "must-never-enter-context",
    defaultDesignSystemId: "modern-minimal",
    customInstructions: "",
    imageApiBaseUrl: "",
    imageApiKey: "image-secret",
    imageModel: "",
    removeBackgroundModel: "",
    editRegionModel: "",
    extractLayerModel: "",
    videoApiBaseUrl: "",
    videoApiKey: "video-secret",
    videoModel: "",
    aiProviderId: "anthropic",
    aiProviderEnabled: true,
    aiProviderModels: "claude-sonnet-4-6",
    aiProviderOrganization: "org-frozen",
    aiProviderProfiles: JSON.stringify({
      anthropic: {
        enabled: true,
        baseUrl: "https://api.anthropic.example/v1",
        apiKey: "profile-secret",
        models: "claude-sonnet-4-6",
        organization: "org-frozen",
      },
    }),
    visualQaEnabled: false,
    autoFixLiveRuntimeErrors: false,
    sharinganAffirmed: false,
    visualQaAgentCommand: "",
    visualQaModel: "",
    researchEnabled: true,
    researchAgentCommand: "",
    researchModel: "",
    autoImproveEnabled: true,
    autoImproveMaxRounds: 2,
    ...overrides,
  };
}

function profile(
  kind: "research" | "moodboard" | "sharingan-capture" = "research",
  currentSettings = settings(),
): FrozenResourceExecutionProfile {
  return freezeResourceExecutionProfile({
    ownership: OWNERSHIP,
    resourceKind: kind,
    adapter: { id: `dezin.resource-adapter.${kind}`, version: 1, kind },
    settings: currentSettings,
  });
}

function targetContent(executionProfile: FrozenResourceExecutionProfile): string {
  const kind = executionProfile.resource.kind;
  return stableStringify({
    protocol: "dezin.generation-target-context.v2",
    projectId: OWNERSHIP.projectId,
    workspaceId: OWNERSHIP.workspaceId,
    planId: OWNERSHIP.planId,
    taskId: OWNERSHIP.taskId,
    taskKind: "resource",
    target: { type: "resource", workspaceId: OWNERSHIP.workspaceId, id: OWNERSHIP.targetResourceId },
    payload: {
      version: 2,
      operation: {
        operation: "create",
        nodeId: "resource-node-1",
        resourceId: OWNERSHIP.targetResourceId,
        kind,
        title: "Resource",
        revisionPolicy: { kind: "generate" },
      },
      brief: {
        proposalRationale: "Produce one exact resource.",
        assumptions: [],
        targetInstructions: { operation: "create", kind, title: "Resource" },
      },
      capabilityDescriptors: [],
      adapter: executionProfile.adapter,
    },
    capabilities: [],
    qaProfile: {
      requiredFrameIds: [], blockingSeverities: [], requireRuntimeChecks: false, requireVisualReview: false,
    },
    resourceLimits: {
      timeoutMs: 60_000, maxAgentTurns: 1, maxRepairRounds: 0, maxOutputBytes: 1024 * 1024,
      capacityClasses: kind === "sharingan-capture" ? ["browser"] : ["agent"],
    },
    expectedSnapshotId: "snapshot-1",
    graphRevision: 1,
    kernelRevisionId: "kernel-1",
    resourceExecutionProfile: executionProfile,
  });
}

function pack(executionProfile: FrozenResourceExecutionProfile): ContextPack {
  const content = targetContent(executionProfile);
  const item = {
    ordinal: 0,
    contextClass: "target" as const,
    ref: { kind: "inline" as const, id: OWNERSHIP.targetResourceId },
    resolvedKind: "inline" as const,
    content,
    checksum: checksumBytes(content),
    reason: "exact immutable Generation Task target contract and Resource execution profile",
    trustLevel: "trusted" as const,
    capabilities: [],
    boundary: {
      source: `generation-task:${OWNERSHIP.taskId}`,
      readOnly: true as const,
      mayGrantCapabilities: false as const,
    },
    tokenEstimate: estimateContextTokens(content),
    provenance: {
      projectId: OWNERSHIP.projectId,
      workspaceId: OWNERSHIP.workspaceId,
      planId: OWNERSHIP.planId,
      taskId: OWNERSHIP.taskId,
      targetResourceId: OWNERSHIP.targetResourceId,
      resourceExecutionProfileChecksum: executionProfile.checksum,
      expectedSnapshotId: "snapshot-1",
      graphRevision: 1,
      kernelRevisionId: "kernel-1",
    },
    provided: true as const,
  };
  const body = {
    protocol: "dezin-context-pack-v1" as const,
    workspaceId: OWNERSHIP.workspaceId,
    graphRevision: 1,
    target: { type: "resource" as const, id: OWNERSHIP.targetResourceId },
    intent: "generate" as const,
    messageChecksum: "a".repeat(64),
    items: [item],
    omissions: [],
    tokenEstimate: item.tokenEstimate,
  };
  const hash = checksumBytes(stableStringify(body));
  return {
    ...body,
    id: `context-pack-${hash}`,
    manifestPath: `context-packs/${hash}.json`,
    hash,
    createdAt: 1,
  };
}

function resourceRequest(kind: "research" | "moodboard" | "sharingan-capture" = "research"): GenerationTaskContextRequest {
  const task = {
    id: OWNERSHIP.taskId,
    planId: OWNERSHIP.planId,
    workspaceId: OWNERSHIP.workspaceId,
    kind: "resource",
    target: { type: "resource", workspaceId: OWNERSHIP.workspaceId, id: OWNERSHIP.targetResourceId },
    payload: {
      version: 2,
      operation: {
        operation: "create",
        nodeId: "resource-node-1",
        resourceId: OWNERSHIP.targetResourceId,
        kind,
        title: "Resource",
        revisionPolicy: { kind: "generate" },
      },
      brief: {
        proposalRationale: "Produce one exact resource.", assumptions: [],
        targetInstructions: { operation: "create", kind, title: "Resource" },
      },
      capabilityDescriptors: [],
      adapter: { id: `dezin.resource-adapter.${kind}`, version: 1, kind },
    },
    capabilities: [],
    qaProfile: {
      requiredFrameIds: [], blockingSeverities: [], requireRuntimeChecks: false, requireVisualReview: false,
    },
    resourceLimits: {
      timeoutMs: 60_000, maxAgentTurns: 1, maxRepairRounds: 0, maxOutputBytes: 1024 * 1024,
      capacityClasses: kind === "sharingan-capture" ? ["browser"] : ["agent"],
    },
  };
  return {
    projectId: OWNERSHIP.projectId,
    planId: OWNERSHIP.planId,
    task,
    observation: {
      taskId: task.id,
      planId: task.planId,
      workspaceId: task.workspaceId,
      attempt: 1,
      target: task.target,
      baseRevisionId: null,
      expectedSnapshotId: "snapshot-1",
      kernelRevisionId: "kernel-1",
      payload: task.payload,
      dependencyOutputs: [],
      resourcePins: [],
      componentPins: [],
    },
  } as unknown as GenerationTaskContextRequest;
}

test("Resource execution profile freezes one settings observation without persisting credentials", async () => {
  let current = settings();
  let reads = 0;
  const fakeStore = {
    getProject: () => ({ id: OWNERSHIP.projectId, archivedAt: null }),
    getSettings: () => { reads += 1; return current; },
    workspace: {
      getWorkspace: () => ({ id: OWNERSHIP.workspaceId, projectId: OWNERSHIP.projectId }),
      getResourceForProject: () => ({
        id: OWNERSHIP.targetResourceId,
        workspaceId: OWNERSHIP.workspaceId,
        kind: "research",
        archivedAt: null,
      }),
    },
  } as unknown as Store;
  const load = createProductionResourceExecutionProfileLoader({ store: fakeStore });

  const first = await load(resourceRequest(), new AbortController().signal);
  current = settings({
    agentCommand: "codex",
    model: "gpt-5.4",
    apiBaseUrl: "https://api.openai.example/v1",
    apiKey: "new-secret",
    aiProviderId: "openai",
    aiProviderProfiles: JSON.stringify({ openai: { apiKey: "new-profile-secret", baseUrl: "", models: "", organization: "" } }),
  });
  const second = await load(resourceRequest(), new AbortController().signal);

  assert.equal(reads, 2, "each Context materialization observes Settings exactly once");
  assert.deepEqual(first.agent, {
    command: "claude",
    providerId: "claude",
    model: "claude-sonnet-4-6",
    baseUrl: "https://api.anthropic.example/v1",
    organization: "org-frozen",
    credentialProviderId: "anthropic",
    credentialRequired: true,
  });
  assert.deepEqual(first.reviewer, {
    command: "claude",
    providerId: "claude",
    model: null,
    baseUrl: "https://api.anthropic.example/v1",
    credentialSource: "anthropic-profile",
    credentialRequired: true,
  });
  assert.equal(first.implementation.requestProtocol, "dezin.resource-agent-request.v1");
  assert.equal(first.implementation.promptProtocol, "dezin.research-generation-prompt.v3");
  assert.equal(first.implementation.contractProtocol, "dezin.research-generation.v3");
  assert.doesNotMatch(stableStringify(first), /must-never-enter-context|profile-secret|image-secret|video-secret/);
  assert.notEqual(first.checksum, second.checksum);
  assert.notEqual(pack(first).hash, pack(second).hash, "rematerialized execution semantics change Context Pack/input identity");
  assert.throws(
    () => profile("research", settings({ apiBaseUrl: "https://user:secret@example.test/v1" })),
    /credential-free/i,
  );
});

test("Resource quality reviewer restores only the exact frozen Claude reviewer credential", () => {
  const frozenSettings = settings({ visualQaModel: "claude-sonnet-4-6" });
  const exact = profile("research", frozenSettings);
  const rotatedProfiles = JSON.stringify({
    anthropic: {
      enabled: true,
      baseUrl: "https://api.anthropic.example/v1",
      apiKey: "rotated-review-secret",
      models: "claude-sonnet-4-6",
      organization: "org-frozen",
    },
  });
  const hydrated = hydrateResourceReviewerExecution(exact, {
    ...frozenSettings,
    aiProviderProfiles: rotatedProfiles,
  });
  assert.equal(hydrated.apiKey, "rotated-review-secret");
  assert.equal(hydrated.model, "claude-sonnet-4-6");
  assert.doesNotMatch(stableStringify(exact), /profile-secret|rotated-review-secret/);

  for (const drift of [
    { visualQaModel: "claude-opus-4-8" },
    { aiProviderProfiles: JSON.stringify({
      anthropic: {
        enabled: true,
        baseUrl: "https://other.example.test/v1",
        apiKey: "rotated-review-secret",
        models: "claude-sonnet-4-6",
        organization: "org-frozen",
      },
    }) },
    { aiProviderId: "openai", aiProviderEnabled: false, aiProviderProfiles: "" },
  ] satisfies Partial<Settings>[]) {
    assert.throws(
      () => hydrateResourceReviewerExecution(exact, { ...frozenSettings, ...drift }),
      /does not match the frozen Attempt/,
    );
  }
});

test("Moodboard execution profile freezes image semantics and hydrates only the exact current provider credential", () => {
  const frozenSettings = settings({
    aiProviderId: "fal",
    aiProviderEnabled: true,
    aiProviderModels: "fal-ai/flux/dev",
    aiProviderOrganization: "image-api-v1",
    aiProviderProfiles: "",
    imageApiBaseUrl: "https://images.example.test/v1",
    imageApiKey: "frozen-current-secret",
    imageModel: "fal-ai/flux/dev",
  });
  const exact = profile("moodboard", frozenSettings);
  assert.deepEqual(exact.imageGeneration, {
    protocol: "dezin.resource-image-generation.v1",
    enabled: true,
    providerId: "fal",
    baseUrl: "https://images.example.test/v1",
    model: "fal-ai/flux/dev",
    apiVersion: "image-api-v1",
    credentialRequired: true,
  });
  assert.doesNotMatch(stableStringify(exact), /frozen-current-secret/);
  assert.equal(hydrateResourceImageGeneration(exact, {
    ...frozenSettings,
    imageApiKey: "rotated-current-secret",
  }).apiKey, "rotated-current-secret");

  for (const drift of [
    { imageModel: "fal-ai/flux/pro" },
    { imageApiBaseUrl: "https://other.example.test/v1" },
    { aiProviderOrganization: "image-api-v2" },
    { aiProviderId: "gemini", aiProviderProfiles: "" },
  ] satisfies Partial<Settings>[]) {
    assert.throws(
      () => hydrateResourceImageGeneration(exact, { ...frozenSettings, ...drift }),
      /does not match the frozen Attempt/,
    );
  }
  assert.throws(
    () => hydrateResourceImageGeneration(exact, {
      ...frozenSettings,
      imageApiKey: "",
      imageApiKeyConfigured: false,
    }),
    /credential.*unavailable/i,
  );
});

test("Resource execution profile extraction rejects cross-scope and checksum tampering", () => {
  const exact = profile();
  const exactPack = pack(exact);
  assert.deepEqual(requireResourceExecutionProfile(exactPack, {
    ...OWNERSHIP,
    resourceKind: "research",
    adapter: exact.adapter,
  }), exact);
  assert.throws(() => requireResourceExecutionProfile(exactPack, {
    ...OWNERSHIP,
    planId: "plan-other",
    resourceKind: "research",
    adapter: exact.adapter,
  }), /ownership|Task/i);

  const tampered = structuredClone(exactPack);
  const target = JSON.parse(tampered.items[0]!.content) as any;
  target.resourceExecutionProfile.agent.model = "substituted-model";
  tampered.items[0]!.content = stableStringify(target);
  tampered.items[0]!.checksum = checksumBytes(tampered.items[0]!.content);
  const body = {
    protocol: "dezin-context-pack-v1",
    workspaceId: tampered.workspaceId,
    graphRevision: tampered.graphRevision,
    target: tampered.target,
    intent: tampered.intent,
    messageChecksum: tampered.messageChecksum,
    items: tampered.items,
    omissions: tampered.omissions,
    tokenEstimate: tampered.tokenEstimate,
  };
  tampered.hash = checksumBytes(stableStringify(body));
  tampered.id = `context-pack-${tampered.hash}`;
  assert.throws(() => requireResourceExecutionProfile(tampered, {
    ...OWNERSHIP,
    resourceKind: "research",
    adapter: exact.adapter,
  }), /checksum/i);
});

test("Sharingan Resource execution profile freezes and enforces bundle, source, and exporter protocols", () => {
  const exact = profile("sharingan-capture");
  assert.deepEqual(exact.sharingan, {
    bundleProtocol: "dezin.sharingan-capture-resource-bundle.v2",
    sourceProtocol: "dezin.sharingan-pages.v2",
    sourceSchemaVersion: 2,
    exporterId: "dezin-sharingan-capture",
    exporterVersion: 1,
    exportRequestProtocol: "dezin.sharingan-capture-export-request.v1",
    exportResultProtocol: "dezin.sharingan-capture-export.v1",
  });

  const incompatible = structuredClone(exact) as any;
  incompatible.sharingan.sourceProtocol = "dezin.sharingan-pages.v3";
  const { checksum: _oldChecksum, ...body } = incompatible;
  incompatible.checksum = checksumBytes(stableStringify(body));
  assert.throws(() => requireResourceExecutionProfile(pack(incompatible), {
    ...OWNERSHIP,
    resourceKind: "sharingan-capture",
    adapter: exact.adapter,
  }), /Sharingan|protocol/i);
});
