import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Store } from "../../../packages/core/src/index.ts";
import { DesignRegistry } from "../../../packages/design/src/index.ts";
import { resourceAdapters } from "../src/context/adapters/index.ts";
import { sealResourceRevisionPayload } from "../src/context/adapters/file.ts";
import { buildVisualReviewerEnv } from "../src/agent-env.ts";
import type { ContextPack, ResolvedContextItem } from "../src/context/context-types.ts";
import { parseProviderProfiles } from "../src/provider-profile-config.ts";
import { reviewerAgentCommand, reviewerModel } from "../src/run-policy.ts";
import {
  BlockedContextError,
  checksumBytes,
  stableStringify,
} from "../src/context/context-types.ts";
import {
  freezeArtifactExecutionProfile,
  createProductionArtifactExecutionProfileLoader,
  hydrateArtifactImageGeneration,
  hydrateArtifactExecutionSettings,
  requireArtifactExecutionProfile,
  type FrozenArtifactExecutionProfile,
} from "../src/orchestration/production-generation-context.ts";
import { bindArtifactExecutionProfile } from "../src/orchestration/production-artifact-generation.ts";
import {
  encodeSharinganCaptureResourceBundle,
} from "../src/orchestration/sharingan-capture-resource-bundle.ts";
import {
  semanticSharinganCaptureFiles,
  type SemanticSharinganFixtureOptions,
} from "./support/sharingan-capture-fixture.ts";

const PROJECT_ID = "project-profile";
const WORKSPACE_ID = "workspace-profile";
const PLAN_ID = "plan-profile";
const TASK_ID = "task-profile";
const ARTIFACT_ID = "artifact-profile";

function sharinganCaptureBundle(input: {
  workspaceId: string;
  resourceId: string;
  requestedUrl: string;
  semantic?: Omit<SemanticSharinganFixtureOptions, "requestedUrl" | "finalUrl">;
}): Uint8Array {
  return encodeSharinganCaptureResourceBundle({
    scope: {
      taskId: "capture-task-profile",
      planId: "capture-plan-profile",
      attempt: 1,
      inputHash: "a".repeat(64),
      workspaceId: input.workspaceId,
      resourceId: input.resourceId,
      parentRevisionId: null,
      contextPackId: "context-pack-capture-profile",
      operation: "create",
      nodeId: "capture-node-profile",
      title: "Pinned source",
      resourceKind: "sharingan-capture",
    },
    source: {
      requestedUrl: input.requestedUrl,
      finalUrl: input.requestedUrl,
      capturedAt: 1,
    },
    exporter: { id: "profile-fixture", version: 1 },
    files: semanticSharinganCaptureFiles({
      ...input.semantic,
      requestedUrl: input.requestedUrl,
      finalUrl: input.requestedUrl,
      marker: "Pinned source",
    }),
    maxOutputBytes: 1024 * 1024,
  }).bytes;
}

function settings() {
  return {
    agentCommand: "codex",
    model: "gpt-5.4",
    apiBaseUrl: "https://api.example.test/v1",
    apiKey: "super-secret-agent-key",
    defaultDesignSystemId: "test-system",
    customInstructions: "Use restrained motion.",
    imageApiBaseUrl: "https://images.example.test/v1",
    imageApiKey: "super-secret-image-key",
    imageModel: "image-v1",
    removeBackgroundModel: "remove-v1",
    editRegionModel: "edit-v1",
    extractLayerModel: "extract-v1",
    videoApiBaseUrl: "https://video.example.test/v1",
    videoApiKey: "super-secret-video-key",
    videoModel: "video-v1",
    aiProviderId: "openai",
    aiProviderEnabled: true,
    aiProviderModels: "gpt-5.4",
    aiProviderOrganization: "org-frozen",
    aiProviderProfiles: JSON.stringify({
      openai: {
        enabled: true,
        baseUrl: "https://profiles.example.test/v1",
        apiKey: "super-secret-profile-key",
        models: "gpt-5.4",
        organization: "org-profile",
      },
    }),
    visualQaEnabled: true,
    autoFixLiveRuntimeErrors: false,
    sharinganAffirmed: true,
    visualQaAgentCommand: "claude",
    visualQaModel: "reviewer-frozen",
    researchEnabled: true,
    researchAgentCommand: "gemini",
    researchModel: "research-frozen",
    autoImproveEnabled: true,
    autoImproveMaxRounds: 3,
  };
}

function profile(overrides: {
  projectName?: string;
  direction?: string;
  model?: string;
  agentCommand?: string;
  agentApiKey?: string;
  agentApiBaseUrl?: string;
  agentOrganization?: string;
  visualQaSetting?: boolean;
  effectiveVisualQa?: boolean;
  visualQaAgentCommand?: string;
  visualQaModel?: string;
  imageModel?: string;
  imageProviderId?: string;
  imageProviderBaseUrl?: string;
  imageApiVersion?: string;
  imageEnabled?: boolean;
  anthropicReviewerBaseUrl?: string;
  anthropicReviewerApiKey?: string;
} = {}): FrozenArtifactExecutionProfile {
  const providerProfiles = JSON.parse(settings().aiProviderProfiles) as Record<string, {
    enabled: boolean;
    baseUrl: string;
    apiKey: string;
    models: string;
    organization: string;
  }>;
  if (!providerProfiles.openai) throw new Error("OpenAI test profile is unavailable");
  providerProfiles.openai.baseUrl = overrides.imageProviderBaseUrl
    ?? providerProfiles.openai.baseUrl;
  providerProfiles.openai.organization = overrides.imageApiVersion
    ?? providerProfiles.openai.organization;
  if (overrides.anthropicReviewerBaseUrl) {
    providerProfiles.anthropic = {
      enabled: true,
      baseUrl: overrides.anthropicReviewerBaseUrl,
      apiKey: overrides.anthropicReviewerApiKey ?? "frozen-reviewer-key",
      models: "claude-sonnet-4-6",
      organization: "reviewer-org-frozen",
    };
  }
  const currentSettings = {
    ...settings(),
    agentCommand: overrides.agentCommand ?? settings().agentCommand,
    model: overrides.model ?? settings().model,
    apiBaseUrl: overrides.agentApiBaseUrl ?? settings().apiBaseUrl,
    apiKey: overrides.agentApiKey ?? settings().apiKey,
    aiProviderOrganization: overrides.agentOrganization ?? settings().aiProviderOrganization,
    visualQaEnabled: overrides.visualQaSetting ?? settings().visualQaEnabled,
    visualQaAgentCommand: overrides.visualQaAgentCommand ?? settings().visualQaAgentCommand,
    visualQaModel: overrides.visualQaModel ?? settings().visualQaModel,
    imageModel: overrides.imageModel ?? settings().imageModel,
    aiProviderId: overrides.imageProviderId ?? settings().aiProviderId,
    aiProviderProfiles: JSON.stringify(providerProfiles),
  };
  const command = currentSettings.agentCommand || "claude";
  const frozenReviewerCommand = reviewerAgentCommand(currentSettings, command);
  return freezeArtifactExecutionProfile({
    ownership: {
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      planId: PLAN_ID,
      taskId: TASK_ID,
      targetArtifactId: ARTIFACT_ID,
    },
    hasExactSharinganCapture: false,
    project: {
      id: PROJECT_ID,
      name: overrides.projectName ?? "Frozen checkout",
      skillId: "frontend-design",
      designSystemId: "test-system",
      mode: "standard",
      sharingan: false,
      sourceUrl: null,
    },
    settings: currentSettings,
    agent: {
      command,
      providerId: command === "claude" ? "claude" : "codex",
      model: currentSettings.model,
    },
    designSystem: {
      requestedId: "test-system",
      resolvedId: "test-system",
      content: {
        id: "test-system",
        name: "Test System",
        category: "Editorial",
        summary: "Quiet precision",
        designMd: "# Exact design system\nUse a strict grid.",
        tokensCss: ":root { --color-accent: #123456; }",
        craft: { applies: ["typography"] },
      },
    },
    skill: {
      id: "frontend-design",
      content: {
        id: "frontend-design",
        name: "Frontend Design",
        description: "Build deliberate interfaces",
        mode: "prototype",
        craft: ["typography"],
        triggers: ["web interface"],
        libraries: ["react"],
        designSystem: true,
        body: "Use the frozen skill body only.",
      },
    },
    researchDirection: {
      directionId: "quiet-checkout",
      content: overrides.direction ?? "Editorial checkout with progressive disclosure.",
      resourceId: "resource-research",
      revisionId: "revision-research",
      revisionChecksum: "a".repeat(64),
      payloadChecksum: "f".repeat(64),
    },
    prompt: {
      rendererProtocol: "dezin.project-agent-prompt.v1",
      rendererVersion: 1,
      systemPrompt: "Exact frozen system prompt with design, craft, and skill semantics.",
    },
    quality: {
      visualQaEnabled: overrides.effectiveVisualQa ?? true,
      reviewer: {
        command: frozenReviewerCommand,
        providerId: "claude",
        model: reviewerModel(currentSettings, currentSettings.model) ?? null,
      },
      expectedSharinganRequestedUrl: null,
      ignores: [{ ruleId: "intentional-density", selector: ".checkout-summary" }],
    },
    imageGenerationEnabled: overrides.imageEnabled ?? true,
  });
}

function packWithProfile(executionProfile: FrozenArtifactExecutionProfile): ContextPack {
  const targetContent = stableStringify({
    protocol: "dezin.generation-target-context.v2",
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    planId: PLAN_ID,
    taskId: TASK_ID,
    taskKind: "page",
    target: {
      type: "artifact",
      workspaceId: WORKSPACE_ID,
      id: ARTIFACT_ID,
      trackId: "track-profile",
    },
    payload: { version: 2 },
    capabilities: [],
    qaProfile: {
      requiredFrameIds: [],
      blockingSeverities: [],
      requireRuntimeChecks: true,
      requireVisualReview: true,
    },
    resourceLimits: {
      timeoutMs: 60_000,
      maxAgentTurns: 3,
      maxRepairRounds: 2,
      maxOutputBytes: 4_194_304,
      capacityClasses: ["agent"],
    },
    expectedSnapshotId: "snapshot-profile",
    graphRevision: 1,
    kernelRevisionId: "kernel-profile",
    artifactExecutionProfile: executionProfile,
  });
  const target: ResolvedContextItem = {
    ordinal: 0,
    contextClass: "target",
    ref: { kind: "inline", id: ARTIFACT_ID },
    resolvedKind: "inline",
    content: targetContent,
    checksum: checksumBytes(targetContent),
    reason: "exact immutable Generation Task target contract and Artifact execution profile",
    trustLevel: "trusted",
    capabilities: [],
    boundary: {
      source: `generation-task:${TASK_ID}`,
      readOnly: true,
      mayGrantCapabilities: false,
    },
    tokenEstimate: 1,
    provenance: {
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      planId: PLAN_ID,
      taskId: TASK_ID,
      targetArtifactId: ARTIFACT_ID,
      executionProfileChecksum: executionProfile.checksum,
    },
    provided: true,
  };
  const research: ResolvedContextItem = {
    ordinal: 1,
    contextClass: "explicit",
    ref: {
      kind: "resource",
      id: executionProfile.researchDirection!.resourceId,
      resourceKind: "research",
      revisionId: executionProfile.researchDirection!.revisionId,
    },
    resolvedKind: "resource-revision",
    content: "Frozen Research Revision context.",
    checksum: executionProfile.researchDirection!.revisionChecksum,
    reason: "exact pinned Research Revision",
    trustLevel: "untrusted",
    capabilities: [],
    boundary: {
      source: `resource-revision:${executionProfile.researchDirection!.revisionId}`,
      readOnly: true,
      mayGrantCapabilities: false,
    },
    tokenEstimate: 1,
    provenance: {
      workspaceId: WORKSPACE_ID,
      resourceId: executionProfile.researchDirection!.resourceId,
      resourceRevisionId: executionProfile.researchDirection!.revisionId,
      resourceKind: "research",
      manifestChecksum: executionProfile.researchDirection!.revisionChecksum,
      payloadChecksum: executionProfile.researchDirection!.payloadChecksum,
    },
    provided: true,
  };
  return sealContextPack({
    workspaceId: WORKSPACE_ID,
    graphRevision: 1,
    target: { type: "artifact", id: ARTIFACT_ID },
    intent: "generate",
    messageChecksum: "c".repeat(64),
    items: [target, research],
    omissions: [],
    tokenEstimate: 2,
  });
}

function sealContextPack(
  draft: Pick<
    ContextPack,
    "workspaceId" | "graphRevision" | "target" | "intent" | "messageChecksum" | "items" | "omissions" | "tokenEstimate"
  >,
): ContextPack {
  const hash = checksumBytes(stableStringify({
    protocol: "dezin-context-pack-v1",
    workspaceId: draft.workspaceId,
    graphRevision: draft.graphRevision,
    target: draft.target,
    intent: draft.intent,
    messageChecksum: draft.messageChecksum,
    items: draft.items,
    omissions: draft.omissions,
    tokenEstimate: draft.tokenEstimate,
  }));
  return {
    ...draft,
    id: `context-pack-${hash}`,
    manifestPath: `context-packs/${hash}.json`,
    hash,
    createdAt: 1,
  };
}

test("Artifact execution profile freezes every output and QA semantic without persisting credentials", () => {
  const frozen = profile();
  const serialized = stableStringify(frozen);

  assert.equal(frozen.protocol, "dezin.artifact-execution-profile.v4");
  assert.equal(frozen.hasExactSharinganCapture, false);
  assert.equal(frozen.settings.value.apiKey, "");
  assert.equal(frozen.settings.value.imageApiKey, "");
  assert.equal(frozen.settings.value.videoApiKey, "");
  assert.deepEqual(frozen.agent, {
    command: "codex",
    providerId: "codex",
    model: "gpt-5.4",
    credentialProviderId: "openai",
    baseUrl: "https://api.example.test/v1",
    organization: "org-frozen",
    credentialRequired: true,
  });
  assert.doesNotMatch(serialized, /super-secret/);
  assert.equal(frozen.designSystem?.revision, frozen.designSystem?.checksum);
  assert.equal(frozen.skill?.revision, frozen.skill?.checksum);
  assert.equal(frozen.researchDirection?.revision, frozen.researchDirection?.checksum);
  assert.equal(frozen.prompt.checksum, checksumBytes(frozen.prompt.systemPrompt));
  assert.deepEqual(frozen.imageGeneration, {
    protocol: "dezin.artifact-image-generation.v2",
    enabled: true,
    providerId: "openai",
    baseUrl: "https://profiles.example.test/v1",
    model: "image-v1",
    apiVersion: "org-profile",
    credentialRequired: true,
    checksum: frozen.imageGeneration.checksum,
  });
  assert.equal(
    frozen.imageGeneration.checksum,
    checksumBytes(stableStringify({
      protocol: "dezin.artifact-image-generation.v2",
      enabled: true,
      providerId: "openai",
      baseUrl: "https://profiles.example.test/v1",
      model: "image-v1",
      apiVersion: "org-profile",
      credentialRequired: true,
    })),
  );
  assert.equal(frozen.checksum.length, 64);

  assert.notEqual(profile({ projectName: "Mutated checkout" }).checksum, frozen.checksum);
  assert.notEqual(profile({ direction: "A different direction." }).checksum, frozen.checksum);
  assert.notEqual(profile({ model: "gpt-5.5" }).checksum, frozen.checksum);
  for (const changed of [
    profile({ imageModel: "image-v2" }),
    profile({ imageProviderId: "google" }),
    profile({ imageProviderBaseUrl: "https://other-images.example.test/v1" }),
    profile({ imageApiVersion: "2026-07-18" }),
    profile({ imageEnabled: false }),
  ]) {
    assert.notEqual(changed.imageGeneration.checksum, frozen.imageGeneration.checksum);
    assert.notEqual(changed.checksum, frozen.checksum);
  }
  assert.equal(profile({ agentCommand: "" }).agent.command, "claude");
});

test("legacy Codex and Gemini reviewer settings freeze and bind as Claude without a foreign model or key", () => {
  for (const legacyCommand of ["codex", "gemini"] as const) {
    const frozen = profile({
      visualQaAgentCommand: legacyCommand,
      visualQaModel: legacyCommand === "codex" ? "gpt-5-reviewer" : "gemini-2.5-pro",
    });
    assert.deepEqual(frozen.quality.reviewer, {
      command: "claude",
      providerId: "claude",
      model: null,
    });

    const bound = bindArtifactExecutionProfile({
      contextPack: packWithProfile(frozen),
      ownership: {
        projectId: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        planId: PLAN_ID,
        taskId: TASK_ID,
        targetArtifactId: ARTIFACT_ID,
      },
      liveSettings: {
        ...settings(),
        visualQaAgentCommand: legacyCommand,
        visualQaModel: frozen.settings.value.visualQaModel,
      },
    });

    assert.equal(bound.qualitySettings.visualQaAgentCommand, "claude");
    assert.equal(bound.qualitySettings.visualQaModel, "");
    assert.equal(bound.environment.ANTHROPIC_API_KEY, undefined);
    assert.deepEqual(buildVisualReviewerEnv(bound.qualitySettings), {});
  }
});

test("Artifact execution settings retain frozen semantics and hydrate only current credentials", () => {
  const frozen = profile({ visualQaSetting: false, effectiveVisualQa: true });
  const live = {
    ...settings(),
    agentCommand: "codex",
    model: "mutated-model",
    apiBaseUrl: "https://api.example.test/v1",
    apiKey: "fresh-agent-key",
    aiProviderOrganization: "org-frozen",
    visualQaAgentCommand: "codex",
    visualQaModel: "mutated-reviewer",
    customInstructions: "MUTATED",
    aiProviderProfiles: JSON.stringify({
      openai: {
        enabled: false,
        baseUrl: "https://mutated-profile.example.test/v1",
        apiKey: "fresh-profile-key",
        models: "mutated-model",
        organization: "mutated-org",
      },
      foreign: { apiKey: "must-not-cross-provider-boundary" },
    }),
  };

  const hydrated = hydrateArtifactExecutionSettings(frozen, live);

  assert.equal(hydrated.agentCommand, "codex");
  assert.equal(hydrated.model, "gpt-5.4");
  assert.equal(hydrated.apiBaseUrl, "https://api.example.test/v1");
  assert.equal(hydrated.visualQaAgentCommand, "claude");
  assert.equal(hydrated.visualQaModel, "reviewer-frozen");
  assert.equal(
    hydrated.visualQaEnabled,
    true,
    "the immutable effective Task QA policy overrides the raw user preference",
  );
  assert.equal(hydrated.customInstructions, "Use restrained motion.");
  assert.equal(hydrated.apiKey, "fresh-agent-key");
  assert.equal(hydrated.imageApiKey, "", "unrelated image credentials are not admitted to the Artifact process");
  assert.equal(hydrated.videoApiKey, "", "unrelated video credentials are not admitted to the Artifact process");
  assert.doesNotMatch(hydrated.aiProviderProfiles, /fresh-profile-key/);
  assert.doesNotMatch(hydrated.aiProviderProfiles, /mutated-profile\.example/);
  assert.doesNotMatch(hydrated.aiProviderProfiles, /must-not-cross-provider-boundary/);
});

test("Artifact execution settings reject cross-provider and endpoint credential substitution", () => {
  const frozen = profile();
  const base = { ...settings(), apiKey: "current-secret" };
  for (const live of [
    { ...base, agentCommand: "gemini" },
    { ...base, apiBaseUrl: "https://drifted.example.test/v1" },
    { ...base, aiProviderOrganization: "drifted-org" },
    { ...base, apiKey: "" },
  ]) {
    assert.throws(
      () => hydrateArtifactExecutionSettings(frozen, live),
      /credential for the frozen Artifact Agent provider, endpoint, and organization is unavailable/i,
    );
  }
});

test("Artifact execution settings allow credential-free local auth without borrowing a foreign key", () => {
  const frozen = profile({ agentApiKey: "" });
  const hydrated = hydrateArtifactExecutionSettings(frozen, {
    ...settings(),
    agentCommand: "gemini",
    apiBaseUrl: "https://foreign.example.test/v1",
    apiKey: "foreign-provider-secret",
  });

  assert.equal(frozen.agent.credentialRequired, false);
  assert.equal(hydrated.apiKey, "");
  assert.equal(hydrated.agentCommand, "codex");
  assert.equal(hydrated.apiBaseUrl, "https://api.example.test/v1");
});

test("Artifact image postprocessing hydrates only the exact frozen provider credential", () => {
  const frozen = profile();
  const exactLive = {
    ...settings(),
    imageApiKey: "ignored-selected-fallback-key",
    aiProviderProfiles: JSON.stringify({
      openai: {
        enabled: true,
        baseUrl: "https://profiles.example.test/v1",
        apiKey: "fresh-frozen-provider-key",
        models: "gpt-5.4",
        organization: "org-profile",
      },
    }),
  };

  const bound = hydrateArtifactImageGeneration(frozen, exactLive);

  assert.equal(bound.enabled, true);
  assert.equal(bound.providerId, "openai");
  assert.equal(bound.baseUrl, "https://profiles.example.test/v1");
  assert.equal(bound.model, "image-v1");
  assert.equal(bound.apiVersion, "org-profile");
  assert.equal(bound.apiKey, "fresh-frozen-provider-key");
  assert.doesNotMatch(stableStringify(frozen), /fresh-frozen-provider-key/);

  const exactProfile = JSON.parse(exactLive.aiProviderProfiles).openai;
  for (const drift of [
    { ...exactLive, aiProviderId: "google" },
    { ...exactLive, imageModel: "mutated-image-model" },
    { ...exactLive, aiProviderProfiles: JSON.stringify({ openai: { ...exactProfile, baseUrl: "https://mutated-frozen-provider.example.test/v1" } }) },
    { ...exactLive, aiProviderProfiles: JSON.stringify({ openai: { ...exactProfile, organization: "mutated-api-version" } }) },
    { ...exactLive, aiProviderProfiles: JSON.stringify({ openai: { ...exactProfile, enabled: false } }) },
    {
      ...exactLive,
      apiKey: "generic-agent-key-must-not-be-borrowed",
      imageApiKey: "",
      imageApiKeyConfigured: false,
      aiProviderProfiles: JSON.stringify({ openai: { ...exactProfile, apiKey: "", apiKeyConfigured: false } }),
    },
  ]) {
    assert.throws(
      () => hydrateArtifactImageGeneration(frozen, drift),
      /frozen Artifact image provider|credential/i,
    );
  }

  const disabledLive = {
    ...exactLive,
    aiProviderProfiles: JSON.stringify({ openai: { ...exactProfile, enabled: false } }),
  };
  const disabled = hydrateArtifactImageGeneration(
    profile({ imageEnabled: false }),
    disabledLive,
  );
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.apiKey, "", "disabled Tasks do not receive image credentials");
});

test("Artifact execution profile extraction is exact-owned and fails closed on protocol or hash drift", () => {
  const frozen = profile();
  const pack = packWithProfile(frozen);
  const expected = {
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    planId: PLAN_ID,
    taskId: TASK_ID,
    targetArtifactId: ARTIFACT_ID,
  };

  assert.deepEqual(requireArtifactExecutionProfile(pack, expected), frozen);

  const target = pack.items[0]!;
  const parsed = JSON.parse(target.content) as Record<string, unknown>;
  const tamperedProfile = structuredClone(parsed.artifactExecutionProfile) as Record<string, unknown>;
  tamperedProfile.checksum = "d".repeat(64);
  parsed.artifactExecutionProfile = tamperedProfile;
  const tamperedContent = stableStringify(parsed);
  const unsealedTamperedPack = {
    ...pack,
    items: [{ ...target, content: tamperedContent, checksum: checksumBytes(tamperedContent) }],
  };
  assert.throws(
    () => requireArtifactExecutionProfile(unsealedTamperedPack, expected),
    /Context Pack hash/i,
  );
  const tamperedPack = sealContextPack(unsealedTamperedPack);
  assert.throws(
    () => requireArtifactExecutionProfile(tamperedPack, expected),
    /execution profile checksum/i,
  );

  assert.throws(
    () => requireArtifactExecutionProfile(pack, { ...expected, taskId: "foreign-task" }),
    /ownership/i,
  );

  assert.throws(
    () => requireArtifactExecutionProfile(
      sealContextPack({ ...pack, items: [pack.items[0]!], tokenEstimate: 1 }),
      expected,
    ),
    /Research Revision/i,
  );

  const substitutedResearchPack = sealContextPack({
    ...pack,
    items: [
      pack.items[0]!,
      {
        ...pack.items[1]!,
        provenance: {
          ...pack.items[1]!.provenance,
          payloadChecksum: "e".repeat(64),
        },
      },
    ],
  });
  assert.throws(
    () => requireArtifactExecutionProfile(substitutedResearchPack, expected),
    /Research Revision identity/i,
  );

  const capturePack = sealContextPack({
    ...pack,
    items: [
      ...pack.items,
      {
        ...pack.items[1]!,
        ordinal: 2,
        ref: {
          kind: "resource",
          id: "capture-linked-after-freeze",
          resourceKind: "sharingan-capture",
          revisionId: "capture-revision-linked-after-freeze",
        },
        checksum: "e".repeat(64),
        boundary: {
          source: "resource-revision:capture-revision-linked-after-freeze",
          readOnly: true,
          mayGrantCapabilities: false,
        },
      },
    ],
    tokenEstimate: 3,
  });
  assert.throws(
    () => requireArtifactExecutionProfile(capturePack, expected),
    /Sharingan semantic does not match the exact Context Pack/i,
  );
});

test("Artifact runner, environment, prompt, direction, and reviewer bind one frozen profile", () => {
  const frozen = profile();
  const live = {
    ...settings(),
    agentCommand: "codex",
    model: "mutated-model",
    apiBaseUrl: "https://api.example.test/v1",
    apiKey: "fresh-agent-key",
    aiProviderOrganization: "org-frozen",
    visualQaAgentCommand: "gemini",
    visualQaModel: "mutated-reviewer",
    customInstructions: "MUTATED",
    aiProviderProfiles: JSON.stringify({
      openai: {
        enabled: true,
        baseUrl: "https://profiles.example.test/v1",
        apiKey: "fresh-image-key",
        models: "gpt-5.4",
        organization: "org-profile",
      },
    }),
  };
  const bound = bindArtifactExecutionProfile({
    contextPack: packWithProfile(frozen),
    ownership: {
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      planId: PLAN_ID,
      taskId: TASK_ID,
      targetArtifactId: ARTIFACT_ID,
    },
    liveSettings: live,
  });

  assert.equal(bound.agentCommand, "codex");
  assert.equal(bound.model, "gpt-5.4");
  assert.equal(bound.providerId, "codex");
  assert.equal(bound.hasExactSharinganCapture, false);
  assert.equal(bound.baseSystemPrompt, frozen.prompt.systemPrompt);
  assert.equal(bound.directionSpec, frozen.researchDirection?.content);
  assert.equal(bound.expectedSharinganRequestedUrl, undefined);
  assert.deepEqual(bound.qualityIgnores, frozen.quality.ignores);
  assert.equal(bound.settings.visualQaAgentCommand, "claude");
  assert.equal(bound.settings.visualQaModel, "reviewer-frozen");
  assert.equal(bound.environment.OPENAI_API_KEY, "fresh-agent-key");
  assert.equal(bound.environment.OPENAI_BASE_URL, "https://api.example.test/v1");
  assert.equal(bound.environment.DEZIN_DAEMON_TOKEN, undefined);
  assert.equal(Object.hasOwn(bound.environment, "DEZIN_DAEMON_TOKEN"), true);
  assert.equal(bound.imageGeneration.providerId, "openai");
  assert.equal(bound.imageGeneration.baseUrl, "https://profiles.example.test/v1");
  assert.equal(bound.imageGeneration.model, "image-v1");
  assert.equal(bound.imageGeneration.apiVersion, "org-profile");
  assert.equal(bound.imageGeneration.apiKey, "fresh-image-key");
});

test("production Artifact binding exposes the exact reviewer credential only to isolated quality settings", () => {
  const frozen = profile({
    anthropicReviewerBaseUrl: "https://frozen-anthropic.example.test",
    anthropicReviewerApiKey: "secret-that-must-be-redacted",
  });
  const live = {
    ...settings(),
    apiKey: "fresh-builder-key",
    aiProviderProfiles: JSON.stringify({
      openai: {
        enabled: true,
        baseUrl: "https://profiles.example.test/v1",
        apiKey: "fresh-image-key",
        models: "mutated-openai-model",
        organization: "org-profile",
      },
      anthropic: {
        enabled: true,
        baseUrl: "https://frozen-anthropic.example.test",
        apiKey: "fresh-reviewer-key",
        models: "mutated-live-reviewer-model",
        organization: "mutated-live-reviewer-org",
      },
    }),
  };
  const bound = bindArtifactExecutionProfile({
    contextPack: packWithProfile(frozen),
    ownership: {
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      planId: PLAN_ID,
      taskId: TASK_ID,
      targetArtifactId: ARTIFACT_ID,
    },
    liveSettings: live,
  });

  assert.equal(bound.environment.OPENAI_API_KEY, "fresh-builder-key");
  assert.equal(bound.environment.ANTHROPIC_API_KEY, undefined);
  assert.equal(bound.settings.apiKey, "fresh-builder-key");
  assert.equal(bound.qualitySettings.apiKey, "");
  assert.equal(bound.qualitySettings.visualQaAgentCommand, "claude");
  assert.equal(bound.qualitySettings.visualQaModel, "reviewer-frozen");
  assert.deepEqual(buildVisualReviewerEnv(bound.qualitySettings), {
    ANTHROPIC_API_KEY: "fresh-reviewer-key",
    ANTHROPIC_BASE_URL: "https://frozen-anthropic.example.test",
  });
  const reviewer = parseProviderProfiles(bound.qualitySettings.aiProviderProfiles).anthropic;
  assert.equal(reviewer?.models, "claude-sonnet-4-6");
  assert.equal(reviewer?.organization, "reviewer-org-frozen");
});

test("production Artifact binding fails reviewer credential resolution when the live endpoint drifts", () => {
  const frozen = profile({
    anthropicReviewerBaseUrl: "https://frozen-anthropic.example.test",
    anthropicReviewerApiKey: "secret-that-must-be-redacted",
  });
  const bound = bindArtifactExecutionProfile({
    contextPack: packWithProfile(frozen),
    ownership: {
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      planId: PLAN_ID,
      taskId: TASK_ID,
      targetArtifactId: ARTIFACT_ID,
    },
    liveSettings: {
      ...settings(),
      apiKey: "fresh-builder-key",
      aiProviderProfiles: JSON.stringify({
        openai: {
          enabled: true,
          baseUrl: "https://profiles.example.test/v1",
          apiKey: "fresh-image-key",
          models: "gpt-5.4",
          organization: "org-profile",
        },
        anthropic: {
          enabled: true,
          baseUrl: "https://mutated-anthropic.example.test",
          apiKey: "wrong-endpoint-key",
          models: "claude-sonnet-4-6",
          organization: "",
        },
      }),
    },
  });

  assert.equal(bound.environment.OPENAI_API_KEY, "fresh-builder-key");
  assert.equal(bound.environment.ANTHROPIC_API_KEY, undefined);
  assert.equal(
    parseProviderProfiles(bound.qualitySettings.aiProviderProfiles).anthropic?.apiKey,
    "",
  );
  assert.throws(
    () => buildVisualReviewerEnv(bound.qualitySettings),
    /credential for the frozen Anthropic visual reviewer is unavailable/i,
  );
});

test("production materialization freezes Project, settings, design, skill, Research direction, and QA before later mutation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dezin-artifact-profile-loader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const repositoryDir = join(root, "project");
  const dataDir = join(root, "data");
  const directionDir = join(repositoryDir, ".research", "directions", "quiet-checkout");
  await Promise.all([
    mkdir(directionDir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
  ]);
  await writeFile(
    join(directionDir, "direction.md"),
    "# Mutable legacy shadow\n\nThis file must select only the direction id; its body must never execute.\n",
    "utf8",
  );
  const designSystem = {
    id: "test-system",
    name: "Test System",
    category: "Editorial",
    summary: "Quiet precision",
    designMd: "# Test System\nUse exact editorial rhythm.",
    tokensCss: ":root { --color-accent: #123456; }",
    craft: { applies: ["typography"] },
  };
  const project = store.createProject({
    name: "Frozen checkout",
    mode: "standard",
    skillId: "frontend-design",
    designSystemId: designSystem.id,
  });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const created = store.workspace.createResourceForProject(project.id, {
    kind: "research",
    title: "Frozen Research",
    defaultPinPolicy: "pin-current",
    baseGraphRevision: workspace.graphRevision,
    expectedSnapshotId: workspace.activeSnapshotId,
  });
  const immutableDirection = {
    id: "quiet-checkout",
    title: "Quiet checkout",
    thesis: "Editorial calm with a persistent order rail.",
    visualLanguage: ["restrained contrast", "precise typographic hierarchy"],
    interactionPrinciples: ["progressive disclosure"],
    risks: ["density may hide urgency"],
    findingIds: ["finding-order-comparison"],
    evidenceStatus: "evidence",
    evidenceFindingIds: ["finding-order-comparison"],
    hypothesisFindingIds: [],
  };
  await writeFile(join(repositoryDir, "research-resource.json"), `${stableStringify({
    format: "dezin-research-resource-bundle",
    version: 2,
    scope: {
      workspaceId: workspace.id,
      resourceId: created.resource.id,
    },
    directions: [immutableDirection],
  })}\n`, "utf8");
  const snapshot = await resourceAdapters.require("research").snapshot({
    workspaceId: workspace.id,
    resourceId: created.resource.id,
    revisionId: "research-revision-profile",
    kind: "research",
    workspaceRoot: repositoryDir,
    snapshotRoot: dataDir,
    source: {
      type: "owned-file",
      path: "research-resource.json",
      mimeType: "application/json",
    },
    provenance: { source: "test" },
    createdAt: 1,
  });
  const revision = store.workspace.createResourceRevisionCandidateForProject(
    project.id,
    created.resource.id,
    {
      revisionId: "research-revision-profile",
      parentRevisionId: null,
      manifestPath: snapshot.manifestPath,
      summary: "Frozen Research",
      metadata: { mimeType: snapshot.mimeType },
      checksum: snapshot.checksum,
      provenance: { source: "test" },
    },
  );
  store.workspace.publishResourceRevisionForProject(project.id, created.resource.id, revision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: created.snapshot.id,
    reason: "test",
  });
  const workspaceAfterFirstResearch = store.workspace.getWorkspace(project.id);
  assert.ok(workspaceAfterFirstResearch);
  const otherCreated = store.workspace.createResourceForProject(project.id, {
    kind: "research",
    title: "Other Frozen Research",
    defaultPinPolicy: "pin-current",
    baseGraphRevision: workspaceAfterFirstResearch.graphRevision,
    expectedSnapshotId: workspaceAfterFirstResearch.activeSnapshotId,
  });
  const sameNamedOtherDirection = {
    ...immutableDirection,
    thesis: "A different pinned Revision happens to reuse the same local direction id.",
  };
  await writeFile(join(repositoryDir, "other-research-resource.json"), `${stableStringify({
    format: "dezin-research-resource-bundle",
    version: 2,
    scope: {
      workspaceId: workspace.id,
      resourceId: otherCreated.resource.id,
    },
    directions: [sameNamedOtherDirection],
  })}\n`, "utf8");
  const otherSnapshot = await resourceAdapters.require("research").snapshot({
    workspaceId: workspace.id,
    resourceId: otherCreated.resource.id,
    revisionId: "other-research-revision-profile",
    kind: "research",
    workspaceRoot: repositoryDir,
    snapshotRoot: dataDir,
    source: {
      type: "owned-file",
      path: "other-research-resource.json",
      mimeType: "application/json",
    },
    provenance: { source: "test" },
    createdAt: 2,
  });
  const otherRevision = store.workspace.createResourceRevisionCandidateForProject(
    project.id,
    otherCreated.resource.id,
    {
      revisionId: "other-research-revision-profile",
      parentRevisionId: null,
      manifestPath: otherSnapshot.manifestPath,
      summary: "Other Frozen Research",
      metadata: { mimeType: otherSnapshot.mimeType },
      checksum: otherSnapshot.checksum,
      provenance: { source: "test" },
    },
  );
  store.workspace.publishResourceRevisionForProject(project.id, otherCreated.resource.id, otherRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: otherCreated.snapshot.id,
    reason: "test",
  });
  store.updateSettings({
    agentCommand: "codex",
    model: "gpt-5.4",
    apiKey: "old-secret",
    customInstructions: "Keep provenance adjacent.",
    imageApiBaseUrl: "https://images.example.test/v1",
    imageApiKey: "image-secret",
    imageModel: "image-frozen",
    aiProviderId: "openai",
    aiProviderEnabled: true,
    aiProviderOrganization: "image-api-version-frozen",
    visualQaEnabled: true,
    visualQaAgentCommand: "claude",
    visualQaModel: "reviewer-frozen",
  });
  store.addQualityIgnore(project.id, "intentional-density", ".summary");
  let legacyRepositorySelectionReads = 0;
  const loader = createProductionArtifactExecutionProfileLoader({
    store,
    dataDir,
    designRegistry: new DesignRegistry([designSystem]),
    repositoryDirForWorkspace: () => {
      legacyRepositorySelectionReads += 1;
      return repositoryDir;
    },
  });
  const request = {
    projectId: project.id,
    planId: PLAN_ID,
    task: {
      id: TASK_ID,
      planId: PLAN_ID,
      workspaceId: workspace.id,
      kind: "page",
      target: { type: "artifact", workspaceId: workspace.id, id: ARTIFACT_ID, trackId: "track-profile" },
      payload: {
        artifactPlan: {
          researchDirectionSelection: {
            protocol: "dezin.research-direction-selection.v1",
            version: 1,
            resourceId: created.resource.id,
            revisionId: revision.id,
            directionId: immutableDirection.id,
          },
        },
        brief: { proposalRationale: "Design a precise checkout." },
      },
    },
    observation: {
      resourcePins: [
        {
          resourceId: created.resource.id,
          revisionId: revision.id,
          sourceTaskId: null,
        },
        {
          resourceId: otherCreated.resource.id,
          revisionId: otherRevision.id,
          sourceTaskId: null,
        },
      ],
    },
  } as unknown as Parameters<typeof loader>[0];

  const frozen = await loader(request, new AbortController().signal);
  const serialized = stableStringify(frozen);
  assert.equal(frozen.project.name, "Frozen checkout");
  assert.equal(frozen.agent.command, "codex");
  assert.equal(frozen.agent.model, "gpt-5.4");
  assert.equal(frozen.designSystem?.content.designMd, designSystem.designMd);
  assert.equal(frozen.skill?.id, "frontend-design");
  assert.match(frozen.skill?.content.body ?? "", /frontend/i);
  assert.equal(frozen.researchDirection?.resourceId, created.resource.id);
  assert.equal(frozen.researchDirection?.revisionId, revision.id);
  assert.equal(frozen.researchDirection?.payloadChecksum, snapshot.payloadChecksum);
  assert.equal(frozen.researchDirection?.content, stableStringify(immutableDirection));
  assert.doesNotMatch(frozen.researchDirection?.content ?? "", /Mutable legacy shadow/);
  assert.deepEqual(frozen.quality.ignores, [{ ruleId: "intentional-density", selector: ".summary" }]);
  assert.equal(frozen.quality.reviewer.model, "reviewer-frozen");
  assert.deepEqual(frozen.imageGeneration, {
    protocol: "dezin.artifact-image-generation.v2",
    enabled: true,
    providerId: "openai",
    baseUrl: "https://images.example.test/v1",
    model: "image-frozen",
    apiVersion: "image-api-version-frozen",
    credentialRequired: true,
    checksum: frozen.imageGeneration.checksum,
  });
  assert.match(frozen.prompt.systemPrompt, /Use exact editorial rhythm/);
  assert.match(frozen.prompt.systemPrompt, /frozen selected skill revision/i);
  assert.match(frozen.prompt.systemPrompt, /earlier Available skills filesystem paths are disabled/i);
  assert.doesNotMatch(serialized, /old-secret|image-secret/);

  store.updateProject(project.id, { name: "Mutated checkout", skillId: "dashboard" });
  store.updateSettings({
    agentCommand: "gemini",
    model: "gemini-mutated",
    customInstructions: "MUTATED",
    imageApiBaseUrl: "https://mutated-images.example.test/v1",
    imageModel: "image-mutated",
    aiProviderOrganization: "image-api-version-mutated",
    visualQaAgentCommand: "gemini",
    visualQaModel: "reviewer-mutated",
  });
  await writeFile(
    join(directionDir, "direction.md"),
    "# Mutated\n\nConcept: loud.\nStructure: flat.\nDistinctive move: neon takeover.\n",
    "utf8",
  );

  assert.equal(frozen.project.name, "Frozen checkout", "already-materialized semantics remain immutable");
  assert.equal(frozen.agent.command, "codex");
  assert.match(frozen.researchDirection?.content ?? "", /persistent order rail/);
  assert.equal(frozen.imageGeneration.model, "image-frozen");
  const rematerialized = await loader(request, new AbortController().signal);
  assert.notEqual(rematerialized.checksum, frozen.checksum);
  assert.equal(rematerialized.project.name, "Mutated checkout");
  assert.equal(rematerialized.agent.command, "gemini");
  assert.equal(rematerialized.imageGeneration.model, "image-mutated");
  assert.equal(
    rematerialized.imageGeneration.baseUrl,
    "https://mutated-images.example.test/v1",
  );
  assert.equal(rematerialized.researchDirection?.content, stableStringify(immutableDirection));
  assert.doesNotMatch(rematerialized.researchDirection?.content ?? "", /neon takeover/);

  await writeFile(join(repositoryDir, ".research", "chosen"), "not-in-pinned-revision\n", "utf8");
  const exactAfterLegacyMutation = await loader(request, new AbortController().signal);
  assert.equal(exactAfterLegacyMutation.researchDirection?.directionId, immutableDirection.id);

  const otherSelectedRequest = structuredClone(request) as typeof request;
  const otherSelection = (otherSelectedRequest.task.payload.artifactPlan as Record<string, any>)
    .researchDirectionSelection;
  otherSelection.resourceId = otherCreated.resource.id;
  otherSelection.revisionId = otherRevision.id;
  const otherSelected = await loader(otherSelectedRequest, new AbortController().signal);
  assert.equal(otherSelected.researchDirection?.resourceId, otherCreated.resource.id);
  assert.equal(otherSelected.researchDirection?.revisionId, otherRevision.id);
  assert.equal(otherSelected.researchDirection?.content, stableStringify(sameNamedOtherDirection));

  const substitutedRevisionRequest = structuredClone(request) as typeof request;
  const substitutedSelection = (substitutedRevisionRequest.task.payload.artifactPlan as Record<string, any>)
    .researchDirectionSelection;
  substitutedSelection.revisionId = otherRevision.id;
  await assert.rejects(
    async () => loader(substitutedRevisionRequest, new AbortController().signal),
    /selection is not pinned by this exact Attempt/i,
  );

  const missingDirectionRequest = structuredClone(request) as typeof request;
  (missingDirectionRequest.task.payload.artifactPlan as Record<string, any>)
    .researchDirectionSelection.directionId = "same-slug-but-not-this-revision";
  await assert.rejects(
    async () => loader(missingDirectionRequest, new AbortController().signal),
    /missing or ambiguous in its pinned Revision/i,
  );

  const fencedRequest = structuredClone(request) as typeof request;
  const originalRevisionRead = store.workspace.getResourceRevisionForProject.bind(store.workspace);
  Object.defineProperty(store.workspace, "getResourceRevisionForProject", {
    configurable: true,
    value(...args: Parameters<typeof originalRevisionRead>) {
      (fencedRequest.task.payload.artifactPlan as Record<string, any>)
        .researchDirectionSelection.directionId = "changed-while-materializing";
      return originalRevisionRead(...args);
    },
  });
  try {
    await assert.rejects(
      async () => loader(fencedRequest, new AbortController().signal),
      /selection changed during materialization/i,
    );
  } finally {
    delete (store.workspace as unknown as Record<string, unknown>).getResourceRevisionForProject;
  }

  const unselectedRequest = structuredClone(request) as typeof request;
  delete (unselectedRequest.task.payload.artifactPlan as Record<string, unknown>).researchDirectionSelection;
  await writeFile(join(repositoryDir, ".research", "chosen"), `${immutableDirection.id}\n`, "utf8");
  await assert.rejects(
    async () => loader(unselectedRequest, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof BlockedContextError);
      assert.match(error.message, /explicit immutable Research direction selection is required/i);
      assert.deepEqual(error.missing, [
        `research:${created.resource.id}@${revision.id}:direction-selection`,
        `research:${otherCreated.resource.id}@${otherRevision.id}:direction-selection`,
      ].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))));
      return true;
    },
    "a Project-level legacy slug must never impersonate an exact immutable Research selection or let the Artifact Agent choose silently",
  );
  assert.equal(
    legacyRepositorySelectionReads,
    0,
    "multi-artifact direction selection never consults the legacy mutable Project repository",
  );
});

test("a Sharingan Project does not apply exact-Capture semantics to an unlinked Artifact Task", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dezin-sharingan-artifact-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const designSystem = {
    id: "mixed-project-system",
    name: "Mixed Project System",
    category: "Editorial",
    summary: "Deliberate new-design semantics",
    designMd: "# Mixed Project System\nUse the selected design language.",
    tokensCss: ":root { --color-accent: #123456; }",
    craft: { applies: [] },
  };
  const project = store.createProject({
    name: "Mixed design workspace",
    mode: "standard",
    skillId: "frontend-design",
    designSystemId: designSystem.id,
    sharingan: true,
    sourceUrl: "https://legacy-project-source.example/",
  });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  store.updateSettings({ visualQaEnabled: false });
  const loader = createProductionArtifactExecutionProfileLoader({
    store,
    dataDir: root,
    designRegistry: new DesignRegistry([designSystem]),
    repositoryDirForWorkspace: () => root,
  });
  const frozen = await loader({
    projectId: project.id,
    planId: PLAN_ID,
    task: {
      id: TASK_ID,
      planId: PLAN_ID,
      workspaceId: workspace.id,
      kind: "page",
      target: { type: "artifact", workspaceId: workspace.id, id: ARTIFACT_ID, trackId: "track-profile" },
      payload: { brief: { proposalRationale: "Design a new evidence-led landing page." } },
      qaProfile: { requireVisualReview: false },
    },
    observation: { resourcePins: [] },
  } as never, new AbortController().signal);

  assert.equal(frozen.hasExactSharinganCapture, false);
  assert.equal(frozen.designSystem?.resolvedId, designSystem.id);
  assert.equal(frozen.skill?.id, "frontend-design");
  assert.equal(frozen.quality.visualQaEnabled, false);
  assert.equal(frozen.quality.expectedSharinganRequestedUrl, null);
  assert.match(frozen.prompt.systemPrompt, /Mixed Project System/);
  assert.match(frozen.prompt.systemPrompt, /frozen selected skill revision/i);
  assert.doesNotMatch(frozen.prompt.systemPrompt, /public\/_assets|source-scaffold --stdout/);
});

test("an exact linked Capture gives a non-Sharingan Project Task one frozen reconstruction profile", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dezin-linked-sharingan-artifact-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const designSystem = {
    id: "must-not-leak-into-capture",
    name: "Must Not Leak Into Capture",
    category: "Editorial",
    summary: "Unrelated generation language",
    designMd: "# Unrelated design system",
    tokensCss: ":root { --color-accent: hotpink; }",
    craft: { applies: ["typography"] },
  };
  const project = store.createProject({
    name: "Mixed design workspace",
    mode: "standard",
    skillId: "frontend-design",
    designSystemId: designSystem.id,
    sharingan: false,
  });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const created = store.workspace.createResourceForProject(project.id, {
    kind: "sharingan-capture",
    title: "Pinned source",
    defaultPinPolicy: "pin-current",
    baseGraphRevision: workspace.graphRevision,
    expectedSnapshotId: workspace.activeSnapshotId,
  });
  const revisionId = "capture-revision-profile";
  const requestedUrl = "https://captured-source.example/checkout";
  const sealed = await sealResourceRevisionPayload({
    storageRoot: dataDir,
    workspaceId: workspace.id,
    resourceId: created.resource.id,
    revisionId,
    mimeType: "application/json",
    bytes: sharinganCaptureBundle({
      workspaceId: workspace.id,
      resourceId: created.resource.id,
      requestedUrl,
    }),
  });
  const revision = store.workspace.createResourceRevisionCandidateForProject(
    project.id,
    created.resource.id,
    {
      revisionId,
      parentRevisionId: null,
      manifestPath: sealed.manifestPath,
      summary: "Pinned source",
      metadata: {
        mimeType: sealed.mimeType,
        byteSize: sealed.byteSize,
        payloadChecksum: sealed.payloadChecksum,
      },
      checksum: sealed.manifestChecksum,
      provenance: { exporter: "profile-fixture" },
    },
  );
  store.workspace.publishResourceRevisionForProject(project.id, created.resource.id, revision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: created.snapshot.id,
    reason: "profile-fixture",
  });
  store.updateSettings({ visualQaEnabled: false });
  const loader = createProductionArtifactExecutionProfileLoader({
    store,
    dataDir,
    designRegistry: new DesignRegistry([designSystem]),
    repositoryDirForWorkspace: () => root,
  });
  const frozen = await loader({
    projectId: project.id,
    planId: PLAN_ID,
    task: {
      id: TASK_ID,
      planId: PLAN_ID,
      workspaceId: workspace.id,
      kind: "page",
      target: { type: "artifact", workspaceId: workspace.id, id: ARTIFACT_ID, trackId: "track-profile" },
      payload: { brief: { proposalRationale: "Reconstruct the exact linked Capture Revision." } },
      qaProfile: { requireVisualReview: false },
    },
    observation: {
      resourcePins: [{
        resourceId: created.resource.id,
        revisionId: revision.id,
        sourceTaskId: null,
      }],
    },
  } as never, new AbortController().signal);

  assert.equal(frozen.hasExactSharinganCapture, true);
  assert.equal(frozen.project.sharingan, false, "the immutable Project fact remains independent");
  assert.equal(frozen.designSystem, null);
  assert.equal(frozen.skill, null);
  assert.equal(frozen.quality.visualQaEnabled, true);
  assert.equal(frozen.quality.expectedSharinganRequestedUrl, requestedUrl);
  assert.doesNotMatch(frozen.prompt.systemPrompt, /Must Not Leak Into Capture|frozen selected skill revision/i);
  assert.match(frozen.prompt.systemPrompt, /\.sharingan/);
  assert.match(frozen.prompt.systemPrompt, /public\/_assets/);
  assert.match(
    frozen.prompt.systemPrompt,
    /node \.sharingan\/probe\.mjs source-scaffold --stdout/,
  );
  assert.doesNotMatch(frozen.prompt.systemPrompt, /\.dezin\/sharingan-source/);
  assert.doesNotMatch(frozen.prompt.systemPrompt, /\.sharingan\/source-scaffold/);
  assert.doesNotMatch(frozen.prompt.systemPrompt, /probe\.mjs (?:navigate|capture)\b/);
  assert.match(frozen.prompt.systemPrompt, /candidate-owned path/i);
  assert.match(frozen.prompt.systemPrompt, /never mutate/i);
});

test("Artifact execution context rejects a structurally valid Revision whose Sharingan pixels are fake", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dezin-invalid-sharingan-artifact-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Invalid pinned capture", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const created = store.workspace.createResourceForProject(project.id, {
    kind: "sharingan-capture",
    title: "Pinned source",
    defaultPinPolicy: "pin-current",
    baseGraphRevision: workspace.graphRevision,
    expectedSnapshotId: workspace.activeSnapshotId,
  });
  const revisionId = "capture-revision-fake-pixels";
  const sealed = await sealResourceRevisionPayload({
    storageRoot: dataDir,
    workspaceId: workspace.id,
    resourceId: created.resource.id,
    revisionId,
    mimeType: "application/json",
    bytes: sharinganCaptureBundle({
      workspaceId: workspace.id,
      resourceId: created.resource.id,
      requestedUrl: "https://captured-source.example/checkout",
      semantic: { screenshotBytes: Buffer.from("fake PNG pixels") },
    }),
  });
  const revision = store.workspace.createResourceRevisionCandidateForProject(
    project.id,
    created.resource.id,
    {
      revisionId,
      parentRevisionId: null,
      manifestPath: sealed.manifestPath,
      summary: "Invalid source",
      metadata: { mimeType: sealed.mimeType },
      checksum: sealed.manifestChecksum,
      provenance: { exporter: "profile-fixture" },
    },
  );
  store.workspace.publishResourceRevisionForProject(project.id, created.resource.id, revision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: created.snapshot.id,
    reason: "profile-fixture",
  });
  const loader = createProductionArtifactExecutionProfileLoader({
    store,
    dataDir,
    designRegistry: new DesignRegistry([]),
    repositoryDirForWorkspace: () => root,
  });
  await assert.rejects(
    async () => await loader({
      projectId: project.id,
      planId: PLAN_ID,
      task: {
        id: TASK_ID,
        planId: PLAN_ID,
        workspaceId: workspace.id,
        kind: "page",
        target: { type: "artifact", workspaceId: workspace.id, id: ARTIFACT_ID, trackId: "track-profile" },
        payload: { brief: { proposalRationale: "Reconstruct the exact linked Capture Revision." } },
        qaProfile: { requireVisualReview: true },
      },
      observation: {
        resourcePins: [{ resourceId: created.resource.id, revisionId: revision.id, sourceTaskId: null }],
      },
    } as never, new AbortController().signal),
    /Sharingan Capture Revision changed or is invalid/,
  );
});
