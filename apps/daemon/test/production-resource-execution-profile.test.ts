import assert from "node:assert/strict";
import test from "node:test";

import type { GenerationTaskContextRequest } from "../src/orchestration/generation-plan-service.ts";
import {
  createProductionResourceExecutionProfileLoader,
  freezeResourceExecutionProfile,
  hydrateResourceAgentExecution,
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
import type {
  Settings,
  Store,
  WorkspaceGenerationAgentSelection,
} from "../../../packages/core/src/index.ts";
import { workspaceMoodboardImageAuthority } from "../src/orchestration/moodboard-image-execution-authority.ts";

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
    ...(kind === "moodboard"
      ? { moodboardImageAuthority: workspaceMoodboardImageAuthority(currentSettings) }
      : {}),
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
      ...(executionProfile.imageGeneration === null ? {} : {
        moodboardImageAuthority: {
          kind: "moodboard-image",
          protocol: "dezin.workspace-moodboard-image-authority.v1",
          providerId: executionProfile.imageGeneration.providerId,
          baseUrl: executionProfile.imageGeneration.baseUrl,
          model: executionProfile.imageGeneration.model,
          apiVersion: executionProfile.imageGeneration.apiVersion,
          credentialSource: executionProfile.imageGeneration.credentialSource,
          credentialRequired: executionProfile.imageGeneration.credentialRequired,
        },
      }),
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

function resourceRequest(
  kind: "research" | "moodboard" | "sharingan-capture" = "research",
  agent?: WorkspaceGenerationAgentSelection,
  reviewer?: WorkspaceGenerationAgentSelection,
  reviewerAuthorityAgent?: WorkspaceGenerationAgentSelection,
  moodboardImageAuthority?: ReturnType<typeof workspaceMoodboardImageAuthority>,
): GenerationTaskContextRequest {
  const task = {
    id: OWNERSHIP.taskId,
    planId: OWNERSHIP.planId,
    workspaceId: OWNERSHIP.workspaceId,
    kind: "resource",
    target: { type: "resource", workspaceId: OWNERSHIP.workspaceId, id: OWNERSHIP.targetResourceId },
    payload: {
      version: 2,
      ...(agent === undefined ? {} : { agent }),
      ...(reviewerAuthorityAgent === undefined ? {} : { reviewerAuthorityAgent }),
      ...(reviewer === undefined ? {} : { reviewer }),
      ...(moodboardImageAuthority === undefined ? {} : { moodboardImageAuthority }),
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

test("Resource execution profile preserves frozen Research and reviewer principals across mutable settings", async () => {
  let current = settings({
    visualQaAgentCommand: "claude",
    visualQaModel: "legacy-reviewer-must-not-override-the-frozen-task",
  });
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

  const frozenAgent = {
    providerId: "codex" as const,
    command: "codex" as const,
    model: "gpt-5.6-sol",
    executionAuthority: {
      kind: "generator" as const,
      baseUrl: "",
      organization: "",
      credentialProviderId: "openai",
      credentialSource: "session" as const,
      credentialRequired: false,
    },
  };
  const frozenReviewer = {
    providerId: "claude" as const,
    command: "claude" as const,
    model: "claude-opus-4-8",
    executionAuthority: {
      kind: "reviewer" as const,
      baseUrl: "https://api.anthropic.example/v1",
      credentialSource: "anthropic-profile" as const,
      credentialRequired: true,
    },
  };
  const first = await load(
    resourceRequest("research", frozenAgent, frozenReviewer),
    new AbortController().signal,
  );
  current = settings({
    agentCommand: "codex",
    model: "gpt-5.4",
    apiBaseUrl: "https://api.openai.example/v1",
    apiKey: "new-secret",
    aiProviderId: "openai",
    aiProviderProfiles: JSON.stringify({
      anthropic: {
        enabled: true,
        baseUrl: "https://api.anthropic.example/v1",
        apiKey: "rotated-profile-secret",
        models: "claude-sonnet-4-6",
        organization: "org-frozen",
      },
    }),
  });
  const second = await load(
    resourceRequest("research", frozenAgent, frozenReviewer),
    new AbortController().signal,
  );

  assert.equal(reads, 2, "each Context materialization observes Settings exactly once");
  assert.deepEqual(first.agent, {
    command: "codex",
    providerId: "codex",
    model: "gpt-5.6-sol",
    baseUrl: "",
    organization: "",
    credentialProviderId: "openai",
    credentialSource: "session",
    credentialRequired: false,
  });
  assert.deepEqual(first.reviewer, {
    command: "claude",
    providerId: "claude",
    model: "claude-opus-4-8",
    baseUrl: "https://api.anthropic.example/v1",
    credentialSource: "anthropic-profile",
    credentialRequired: true,
    credentialAuthority: null,
  });
  assert.equal(first.implementation.requestProtocol, "dezin.resource-agent-request.v1");
  assert.equal(first.implementation.promptProtocol, "dezin.research-generation-prompt.v3");
  assert.equal(first.implementation.contractProtocol, "dezin.research-generation.v3");
  assert.doesNotMatch(stableStringify(first), /must-never-enter-context|profile-secret|image-secret|video-secret/);
  assert.deepEqual(hydrateResourceAgentExecution(second, current), {
    ...second.agent,
    apiKey: "",
  });
  assert.deepEqual(hydrateResourceReviewerExecution(second, current), {
    ...second.reviewer,
    apiKey: "rotated-profile-secret",
  });
  assert.equal(first.checksum, second.checksum);
  assert.equal(
    pack(first).hash,
    pack(second).hash,
    "mutable unrelated provider settings cannot change frozen split authority",
  );
  assert.throws(
    () => profile("research", settings({
      apiBaseUrl: "https://user:secret@example.test/v1",
      aiProviderId: "",
      aiProviderProfiles: "",
    })),
    /credential-free/i,
  );
  current = settings({
    aiProviderProfiles: JSON.stringify({
      anthropic: {
        enabled: true,
        baseUrl: "https://drifted-reviewer.example/v1",
        apiKey: "rotated-profile-secret",
        models: "claude-sonnet-4-6",
        organization: "org-frozen",
      },
    }),
  });
  await assert.rejects(
    async () => load(
      resourceRequest("research", frozenAgent, frozenReviewer),
      new AbortController().signal,
    ),
    /changed the frozen Task reviewer endpoint, credential source, or credential requirement/i,
  );
  current = settings();
  await assert.rejects(
    async () => load(
      resourceRequest("research", {
        ...frozenAgent,
        executionAuthority: {
          ...frozenAgent.executionAuthority,
          baseUrl: "https://substituted-research.example/v1",
        },
      }, frozenReviewer),
      new AbortController().signal,
    ),
    /session source cannot carry an endpoint, organization, or require a credential/i,
  );
});

test("Research materialization retains the Proposal generator as reviewer credential authority", async () => {
  let current = settings({
    agentCommand: "claude",
    model: "claude-sonnet-4-6",
    apiBaseUrl: "https://api.anthropic.example/v1",
    apiKey: "proposal-agent-secret",
    aiProviderOrganization: "proposal-agent-org",
    aiProviderId: "",
    aiProviderEnabled: false,
    aiProviderProfiles: "",
    researchAgentCommand: "codex",
    researchModel: "gpt-5.6-sol",
    visualQaAgentCommand: "claude",
    visualQaModel: "claude-opus-4-8",
  });
  const fakeStore = {
    getProject: () => ({ id: OWNERSHIP.projectId, archivedAt: null }),
    getSettings: () => current,
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
  const researchAgent = {
    providerId: "codex" as const,
    command: "codex" as const,
    model: "gpt-5.6-sol",
    executionAuthority: {
      kind: "generator" as const,
      baseUrl: "",
      organization: "",
      credentialProviderId: "openai",
      credentialSource: "session" as const,
      credentialRequired: false,
    },
  };
  const proposalAgent = {
    providerId: "claude" as const,
    command: "claude" as const,
    model: "claude-sonnet-4-6",
    executionAuthority: {
      kind: "generator" as const,
      baseUrl: "https://api.anthropic.example/v1",
      organization: "proposal-agent-org",
      credentialProviderId: "anthropic",
      credentialSource: "agent" as const,
      credentialRequired: true,
    },
  };
  const reviewer = {
    providerId: "claude" as const,
    command: "claude" as const,
    model: "claude-opus-4-8",
    executionAuthority: {
      kind: "reviewer" as const,
      baseUrl: "https://api.anthropic.example/v1",
      credentialSource: "agent" as const,
      credentialRequired: true,
    },
  };
  const load = createProductionResourceExecutionProfileLoader({ store: fakeStore });
  const request = resourceRequest("research", researchAgent, reviewer, proposalAgent);
  const first = await load(request, new AbortController().signal);
  assert.deepEqual(first.agent, {
    command: "codex",
    providerId: "codex",
    model: "gpt-5.6-sol",
    baseUrl: "",
    organization: "",
    credentialProviderId: "openai",
    credentialSource: "session",
    credentialRequired: false,
  });
  assert.deepEqual(first.reviewer, {
    command: "claude",
    providerId: "claude",
    model: "claude-opus-4-8",
    baseUrl: "https://api.anthropic.example/v1",
    credentialSource: "agent",
    credentialRequired: true,
    credentialAuthority: {
      owner: "proposal-generator",
      providerId: "claude",
      baseUrl: "https://api.anthropic.example/v1",
      organization: "",
      credentialProviderId: "anthropic",
      credentialSource: "agent",
      credentialRequired: true,
    },
  });
  current = { ...current, apiKey: "rotated-proposal-agent-secret" };
  const rotated = await load(request, new AbortController().signal);
  assert.equal(rotated.checksum, first.checksum);
  assert.deepEqual(hydrateResourceReviewerExecution(rotated, current), {
    ...rotated.reviewer,
    apiKey: "rotated-proposal-agent-secret",
  });
});

test("Research execution profile freezes the configured Codex researcher and an independent reviewer", () => {
  const exact = profile("research", settings({
    agentCommand: "claude",
    model: "claude-sonnet-4-6",
    researchAgentCommand: "codex",
    researchModel: "gpt-5.6-sol",
    visualQaAgentCommand: "claude",
    visualQaModel: "claude-opus-4-8",
  }));

  assert.deepEqual(exact.agent, {
    command: "codex",
    providerId: "codex",
    model: "gpt-5.6-sol",
    baseUrl: "",
    organization: "",
    credentialProviderId: "openai",
    credentialSource: "session",
    credentialRequired: false,
  });
  assert.deepEqual(exact.reviewer, {
    command: "claude",
    providerId: "claude",
    model: "claude-opus-4-8",
    baseUrl: "https://api.anthropic.example/v1",
    credentialSource: "anthropic-profile",
    credentialRequired: true,
    credentialAuthority: null,
  });
  assert.notEqual(exact.agent.providerId, exact.reviewer.providerId);

  const { checksum, ...body } = exact;
  assert.equal(checksum, checksumBytes(stableStringify(body)));
  assert.deepEqual(requireResourceExecutionProfile(pack(exact), {
    ...OWNERSHIP,
    resourceKind: "research",
    adapter: exact.adapter,
  }), exact);

  const tampered = structuredClone(exact) as any;
  tampered.agent.model = "substituted-research-model";
  assert.throws(
    () => requireResourceExecutionProfile(pack(tampered), {
      ...OWNERSHIP,
      resourceKind: "research",
      adapter: exact.adapter,
    }),
    /checksum/i,
  );
});

test("Research execution profile falls back to the global Agent only when Research overrides are empty", () => {
  const fallbackSettings = settings({
    agentCommand: "codebuddy",
    model: "gpt-5.6-terra",
    researchAgentCommand: "   ",
    researchModel: "   ",
  });
  const research = profile("research", fallbackSettings);
  const moodboard = profile("moodboard", {
    ...fallbackSettings,
    researchAgentCommand: "codex",
    researchModel: "research-model-must-not-affect-moodboard",
    aiProviderId: "fal",
    aiProviderEnabled: true,
    imageApiBaseUrl: "https://images.example.test/v1",
    imageApiKey: "image-key",
    imageModel: "fal-ai/flux/dev",
  });

  assert.deepEqual(research.agent, {
    command: "codebuddy",
    providerId: "codebuddy",
    model: "gpt-5.6-terra",
    baseUrl: "",
    organization: "",
    credentialProviderId: "codebuddy",
    credentialSource: "session",
    credentialRequired: false,
  });
  assert.deepEqual(moodboard.agent, research.agent);
  assert.notEqual(
    research.checksum,
    moodboard.checksum,
    "the Resource kind remains part of the exact frozen profile hash",
  );
});

test("Resource quality reviewer restores only the exact frozen Claude reviewer credential", () => {
  const frozenSettings = settings({
    visualQaAgentCommand: "claude",
    visualQaModel: "claude-sonnet-4-6",
  });
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
  assert.equal(hydrateResourceReviewerExecution(exact, {
    ...frozenSettings,
    visualQaAgentCommand: "codex",
    visualQaModel: "mutable-selection-must-not-replace-frozen-reviewer",
  }).apiKey, "profile-secret");

  for (const drift of [
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
      /unavailable|incompatible/,
    );
  }
});

test("Resource Agent and reviewer reject same-source credential-requirement drift", () => {
  const endpoint = "https://api.anthropic.example/v1";
  const anthropicProfiles = (apiKey: string) => JSON.stringify({
    anthropic: {
      enabled: true,
      baseUrl: endpoint,
      apiKey,
      models: "claude-sonnet-4-6",
      organization: "org-frozen",
    },
  });
  const frozenSettings = settings({
    apiKey: "",
    aiProviderProfiles: anthropicProfiles(""),
    visualQaAgentCommand: "claude",
  });
  const frozen = profile("research", frozenSettings);
  const live = {
    ...frozenSettings,
    aiProviderProfiles: anthropicProfiles("newly-configured-key"),
  };

  assert.equal(frozen.agent.credentialSource, "provider-profile");
  assert.equal(frozen.agent.credentialRequired, false);
  assert.equal(frozen.reviewer.credentialSource, "anthropic-profile");
  assert.equal(frozen.reviewer.credentialRequired, false);
  assert.throws(
    () => hydrateResourceAgentExecution(frozen, live),
    /credential.*unavailable/i,
  );
  assert.throws(
    () => hydrateResourceReviewerExecution(frozen, live),
    /unavailable|incompatible/i,
  );
});

test("Resource execution profile keeps an explicitly frozen reviewer independent from the Task Agent", async () => {
  const current = settings({
    agentCommand: "claude",
    model: "stale-global-model",
    visualQaAgentCommand: "claude",
    visualQaModel: "stale-global-reviewer",
    aiProviderId: "fal",
    aiProviderEnabled: true,
    imageApiBaseUrl: "https://images.example.test/v1",
    imageApiKey: "image-key",
    imageModel: "fal-ai/flux/dev",
  });
  const fakeStore = {
    getProject: () => ({ id: OWNERSHIP.projectId, archivedAt: null }),
    getSettings: () => current,
    workspace: {
      getWorkspace: () => ({ id: OWNERSHIP.workspaceId, projectId: OWNERSHIP.projectId }),
      getResourceForProject: () => ({
        id: OWNERSHIP.targetResourceId,
        workspaceId: OWNERSHIP.workspaceId,
        kind: "moodboard",
        archivedAt: null,
      }),
    },
  } as unknown as Store;
  const frozen = await createProductionResourceExecutionProfileLoader({ store: fakeStore })(
    resourceRequest("moodboard", {
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
    }, {
      providerId: "claude",
      command: "claude",
      model: "claude-opus-4-8",
      executionAuthority: {
        kind: "reviewer",
        baseUrl: "https://api.anthropic.example/v1",
        credentialSource: "anthropic-profile",
        credentialRequired: true,
      },
    }, undefined, workspaceMoodboardImageAuthority(current)),
    new AbortController().signal,
  );

  assert.deepEqual(frozen.reviewer, {
    command: "claude",
    providerId: "claude",
    model: "claude-opus-4-8",
    baseUrl: "https://api.anthropic.example/v1",
    credentialSource: "anthropic-profile",
    credentialRequired: true,
    credentialAuthority: null,
  });
  assert.deepEqual(frozen.agent, {
    command: "codex",
    providerId: "codex",
    model: "gpt-5.4-mini",
    baseUrl: "",
    organization: "",
    credentialProviderId: "openai",
    credentialSource: "session",
    credentialRequired: false,
  });
  assert.doesNotMatch(stableStringify(frozen), /must-never-enter-context|api\\.anthropic/);
  assert.deepEqual(hydrateResourceReviewerExecution(frozen, {
    ...current,
    agentCommand: "codex",
    model: "gpt-5.4-mini",
    visualQaAgentCommand: "codex",
    visualQaModel: "gpt-5.4-mini",
  }), {
    ...frozen.reviewer,
    apiKey: "profile-secret",
  });
});

test("Codex Resource execution freezes host login even when project provider BYOK is configured", () => {
  const projectProviderSettings = settings({
    agentCommand: "codex",
    model: "gpt-5.4-mini",
    apiBaseUrl: "https://azure-provider.example.test/v1",
    apiKey: "project-provider-secret",
    aiProviderId: "azure-openai",
    aiProviderEnabled: true,
    aiProviderOrganization: "project-provider-org",
  });
  const frozen = profile("research", projectProviderSettings);

  assert.deepEqual(frozen.agent, {
    command: "codex",
    providerId: "codex",
    model: "gpt-5.4-mini",
    baseUrl: "",
    organization: "",
    credentialProviderId: "openai",
    credentialSource: "session",
    credentialRequired: false,
  });
  assert.doesNotMatch(
    stableStringify(frozen),
    /azure-provider|project-provider-secret|project-provider-org/,
  );
  assert.deepEqual(hydrateResourceAgentExecution(frozen, {
    ...projectProviderSettings,
    apiBaseUrl: "",
    apiKey: "",
    aiProviderOrganization: "",
  }), {
    ...frozen.agent,
    apiKey: "",
  });
});

test("ambiguous legacy Codex Resource profiles fail closed instead of reusing frozen BYOK", () => {
  const current = profile("research", settings({
    agentCommand: "codex",
    model: "gpt-5.4-mini",
  }));
  const legacy = structuredClone(current) as any;
  legacy.agent.baseUrl = "https://legacy-provider.example.test/v1";
  legacy.agent.organization = "legacy-provider-org";
  legacy.agent.credentialRequired = true;
  const { checksum: _checksum, ...legacyBody } = legacy;
  legacy.checksum = checksumBytes(stableStringify(legacyBody));

  assert.throws(
    () => hydrateResourceAgentExecution(legacy, settings({
      agentCommand: "codex",
      model: "gpt-5.4-mini",
      apiBaseUrl: "",
      apiKey: "",
      aiProviderOrganization: "",
    })),
    /Resource execution Agent identity is invalid/i,
  );
});

test("Resource execution profile rejects a mismatched frozen Task Agent identity", () => {
  const current = settings();
  const fakeStore = {
    getProject: () => ({ id: OWNERSHIP.projectId, archivedAt: null }),
    getSettings: () => current,
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

  assert.throws(
    () => createProductionResourceExecutionProfileLoader({ store: fakeStore })(
      resourceRequest("research", {
        providerId: "claude",
        command: "codex",
        model: "gpt-5.4-mini",
      }),
      new AbortController().signal,
    ),
    /Agent identity|provider.*command|does not match/i,
  );
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
    protocol: "dezin.resource-image-generation.v2",
    enabled: true,
    providerId: "fal",
    baseUrl: "https://images.example.test/v1",
    model: "fal-ai/flux/dev",
    apiVersion: "image-api-v1",
    credentialSource: "global-image",
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
      /match the frozen Moodboard image/,
    );
  }
  assert.throws(
    () => hydrateResourceImageGeneration(exact, {
      ...frozenSettings,
      aiProviderProfiles: JSON.stringify({
        fal: {
          enabled: true,
          baseUrl: frozenSettings.imageApiBaseUrl,
          apiKey: "new-profile-secret",
          models: frozenSettings.imageModel,
          organization: frozenSettings.aiProviderOrganization,
        },
      }),
    }),
    /credential source/,
  );
  assert.throws(
    () => hydrateResourceImageGeneration(exact, {
      ...frozenSettings,
      imageApiKey: "",
      imageApiKeyConfigured: false,
    }),
    /configured credential|credential.*unavailable/i,
  );

  const profileCredentialSettings = settings({
    aiProviderId: "fal",
    aiProviderEnabled: true,
    aiProviderProfiles: JSON.stringify({
      fal: {
        enabled: true,
        baseUrl: "https://images.example.test/v1",
        apiKey: "profile-secret",
        models: "fal-ai/flux/dev",
        organization: "image-api-v1",
      },
    }),
    imageApiBaseUrl: "https://images.example.test/v1",
    imageApiKey: "global-fallback-must-not-be-used",
    imageModel: "fal-ai/flux/dev",
  });
  const profileCredential = profile("moodboard", profileCredentialSettings);
  assert.equal(profileCredential.imageGeneration?.credentialSource, "provider-profile");
  assert.throws(
    () => hydrateResourceImageGeneration(profileCredential, {
      ...profileCredentialSettings,
      aiProviderProfiles: JSON.stringify({
        fal: {
          enabled: true,
          baseUrl: "https://images.example.test/v1",
          apiKey: "",
          models: "fal-ai/flux/dev",
          organization: "image-api-v1",
        },
      }),
    }),
    /credential source|unavailable/i,
  );
});

test("Moodboard execution profile rejects a checksum-valid disabled image policy at the Context boundary", () => {
  const exact = profile("moodboard", settings({
    aiProviderId: "fal",
    aiProviderEnabled: true,
    imageApiBaseUrl: "",
    imageApiKey: "image-secret",
    imageModel: "fal-ai/flux/dev",
  }));
  const disabled = structuredClone(exact) as any;
  disabled.imageGeneration.enabled = false;
  const { checksum: _oldChecksum, ...body } = disabled;
  disabled.checksum = checksumBytes(stableStringify(body));

  assert.throws(
    () => requireResourceExecutionProfile(pack(disabled), {
      ...OWNERSHIP,
      resourceKind: "moodboard",
      adapter: exact.adapter,
    }),
    /enabled|image generation/i,
  );
  assert.throws(
    () => hydrateResourceImageGeneration(disabled, settings({
      aiProviderId: "fal",
      aiProviderEnabled: true,
      imageApiBaseUrl: "",
      imageApiKey: "image-secret",
      imageModel: "fal-ai/flux/dev",
    })),
    /enabled|image generation/i,
  );
});

test("Moodboard Context extraction binds the checksum-valid profile to the exact Task image authority", () => {
  const exact = profile("moodboard", settings({
    aiProviderId: "fal",
    aiProviderEnabled: true,
    imageApiBaseUrl: "",
    imageApiKey: "image-secret",
    imageModel: "fal-ai/flux/dev",
  }));
  const mismatched = structuredClone(pack(exact));
  const target = JSON.parse(mismatched.items[0]!.content) as any;
  target.payload.moodboardImageAuthority.model = "fal-ai/flux/pro";
  mismatched.items[0]!.content = stableStringify(target);
  mismatched.items[0]!.checksum = checksumBytes(mismatched.items[0]!.content);
  const body = {
    protocol: "dezin-context-pack-v1" as const,
    workspaceId: mismatched.workspaceId,
    graphRevision: mismatched.graphRevision,
    target: mismatched.target,
    intent: mismatched.intent,
    messageChecksum: mismatched.messageChecksum,
    items: mismatched.items,
    omissions: mismatched.omissions,
    tokenEstimate: mismatched.tokenEstimate,
  };
  mismatched.hash = checksumBytes(stableStringify(body));
  mismatched.id = `context-pack-${mismatched.hash}`;

  assert.throws(
    () => requireResourceExecutionProfile(mismatched, {
      ...OWNERSHIP,
      resourceKind: "moodboard",
      adapter: exact.adapter,
    }),
    /does not match the exact Task Moodboard image authority/i,
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
