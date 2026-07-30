import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

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
import {
  createResearchRevisionFixture,
  persistResearchRevisionFixtureContextPack,
} from "./support/research-resource-fixture.ts";

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

type ResearchRevisionFixture = ReturnType<typeof createResearchRevisionFixture>;
type ResearchFixtureDirection = ResearchRevisionFixture["bundle"]["directions"][number];

async function artifactResearchValidationFixture(
  t: TestContext,
  mutateDirection: (direction: ResearchFixtureDirection) => void,
  legacyVersion?: 1 | 2,
) {
  const root = await mkdtemp(join(tmpdir(), "dezin-artifact-research-validation-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const store = new Store(join(root, "store.db"));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const designSystem = {
    id: "research-validation-system",
    name: "Research Validation System",
    category: "Editorial",
    summary: "Evidence-led restraint",
    designMd: "# Research Validation System\nKeep evidence adjacent to decisions.",
    tokensCss: ":root { --color-accent: #123456; }",
    craft: { applies: [] },
  };
  const project = store.createProject({
    name: "Research validation",
    mode: "standard",
    designSystemId: designSystem.id,
  });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const created = store.workspace.createResourceForProject(project.id, {
    kind: "research",
    title: "Pinned Research",
    defaultPinPolicy: "pin-current",
    baseGraphRevision: workspace.graphRevision,
    expectedSnapshotId: workspace.activeSnapshotId,
  });
  const researchContextPack = persistResearchRevisionFixtureContextPack({
    store,
    manifestRoot: dataDir,
    workspaceId: workspace.id,
    resourceId: created.resource.id,
    graphRevision: store.workspace.getWorkspace(project.id)!.graphRevision,
  });
  const researchFixture = createResearchRevisionFixture({
    workspaceId: workspace.id,
    resourceId: created.resource.id,
    contextPack: researchContextPack,
  });
  const selectedDirection = researchFixture.bundle.directions[0]!;
  mutateDirection(selectedDirection);
  const payload = legacyVersion === undefined
    ? researchFixture.bundle
    : {
        format: researchFixture.bundle.format,
        version: legacyVersion,
        scope: {
          workspaceId: workspace.id,
          resourceId: created.resource.id,
        },
        directions: researchFixture.bundle.directions.map((direction) => {
          const {
            evidenceStatus: _evidenceStatus,
            evidenceFindingIds: _evidenceFindingIds,
            hypothesisFindingIds: _hypothesisFindingIds,
            ...legacyDirection
          } = direction;
          return legacyVersion === 1 ? legacyDirection : direction;
        }),
      };
  const revisionId = "research-revision-evidence-validation";
  const sealed = await sealResourceRevisionPayload({
    storageRoot: dataDir,
    workspaceId: workspace.id,
    resourceId: created.resource.id,
    revisionId,
    mimeType: "application/json",
    bytes: Buffer.from(`${stableStringify(payload)}\n`, "utf8"),
  });
  const revision = store.workspace.createResourceRevisionCandidateForProject(
    project.id,
    created.resource.id,
    {
      revisionId,
      parentRevisionId: null,
      manifestPath: sealed.manifestPath,
      summary: "Pinned Research",
      metadata: {
        ...researchFixture.metadata,
        mimeType: sealed.mimeType,
        byteSize: sealed.byteSize,
        payloadChecksum: sealed.payloadChecksum,
      },
      checksum: sealed.manifestChecksum,
      provenance: researchFixture.provenance,
    },
  );
  store.workspace.publishResourceRevisionForProject(project.id, created.resource.id, revision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: created.snapshot.id,
    reason: "research-validation-fixture",
  });
  const loader = createProductionArtifactExecutionProfileLoader({
    store,
    dataDir,
    designRegistry: new DesignRegistry([designSystem]),
    repositoryDirForWorkspace: () => root,
  });
  const request = {
    projectId: project.id,
    planId: PLAN_ID,
    task: {
      id: TASK_ID,
      planId: PLAN_ID,
      workspaceId: workspace.id,
      kind: "page",
      target: {
        type: "artifact",
        workspaceId: workspace.id,
        id: ARTIFACT_ID,
        trackId: "track-profile",
      },
      payload: {
        artifactPlan: {
          researchDirectionSelection: {
            protocol: "dezin.research-direction-selection.v1",
            version: 1,
            resourceId: created.resource.id,
            revisionId: revision.id,
            directionId: selectedDirection.id,
          },
        },
        brief: { proposalRationale: "Use only grounded Research evidence." },
      },
      qaProfile: { requireVisualReview: false },
    },
    observation: {
      resourcePins: [{
        resourceId: created.resource.id,
        revisionId: revision.id,
        sourceTaskId: null,
      }],
    },
  } as unknown as Parameters<typeof loader>[0];
  return { loader, request, store };
}

function samePlanGeneratedResearchRequest(
  request: Parameters<ReturnType<typeof createProductionArtifactExecutionProfileLoader>>[0],
  instructions: string,
  artifact: {
    kind?: "component" | "page";
    name?: string;
  } = {},
) {
  const next = structuredClone(request);
  const kind = artifact.kind ?? "page";
  const name = artifact.name ?? "Checkout";
  next.task.kind = kind;
  const payload = next.task.payload as Record<string, unknown>;
  const artifactPlan = payload.artifactPlan as Record<string, unknown>;
  delete artifactPlan.researchDirectionSelection;
  artifactPlan.kind = kind;
  artifactPlan.name = name;
  artifactPlan.instructions = instructions;
  const brief = payload.brief as Record<string, unknown>;
  brief.targetInstructions = {
    operation: "create",
    kind,
    name,
    instructions,
  };
  const observation = next.observation as {
    dependencyOutputs?: Array<{
      taskId: string;
      resultRevisionId: string | null;
      resultResourceRevisionId: string | null;
      resultSnapshotId: string | null;
    }>;
    resourcePins: Array<{
      resourceId: string;
      revisionId: string;
      sourceTaskId: string | null;
    }>;
  };
  next.task.dependencyIds = ["generated-research-task"];
  observation.resourcePins = observation.resourcePins.map((pin) => ({
    ...pin,
    sourceTaskId: "generated-research-task",
  }));
  observation.dependencyOutputs = [{
    taskId: "generated-research-task",
    resultRevisionId: null,
    resultResourceRevisionId: observation.resourcePins[0]!.revisionId,
    resultSnapshotId: "generated-research-snapshot",
  }];
  return next;
}

function profile(overrides: {
  projectName?: string;
  direction?: string;
  model?: string;
  agentCommand?: string;
  agentApiKey?: string;
  agentApiBaseUrl?: string;
  agentOrganization?: string;
  aiProviderId?: string;
  aiProviderEnabled?: boolean;
  aiProviderProfiles?: string;
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
    aiProviderId: overrides.aiProviderId ?? overrides.imageProviderId ?? settings().aiProviderId,
    aiProviderEnabled: overrides.aiProviderEnabled ?? settings().aiProviderEnabled,
    visualQaEnabled: overrides.visualQaSetting ?? settings().visualQaEnabled,
    visualQaAgentCommand: overrides.visualQaAgentCommand ?? settings().visualQaAgentCommand,
    visualQaModel: overrides.visualQaModel ?? settings().visualQaModel,
    imageModel: overrides.imageModel ?? settings().imageModel,
    aiProviderProfiles: overrides.aiProviderProfiles ?? JSON.stringify(providerProfiles),
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
      providerId: command === "claude" ? "claude" : command === "codebuddy" ? "codebuddy" : "codex",
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
        providerId: frozenReviewerCommand,
        model: reviewerModel(
          currentSettings,
          currentSettings.model,
          currentSettings.agentCommand,
        ) ?? null,
      },
      expectedSharinganRequestedUrl: null,
      ignores: [{ ruleId: "intentional-density", selector: ".checkout-summary" }],
    },
    imageGenerationEnabled: overrides.imageEnabled ?? true,
  });
}

function packWithProfile(executionProfile: FrozenArtifactExecutionProfile): ContextPack {
  const targetContent = stableStringify({
    protocol: "dezin.generation-target-context.v3",
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
    relevantPrototypeRelations: [],
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

  assert.equal(frozen.protocol, "dezin.artifact-execution-profile.v5");
  assert.equal(frozen.hasExactSharinganCapture, false);
  assert.equal(frozen.settings.value.apiKey, "");
  assert.equal(frozen.settings.value.apiKeyConfigured, true);
  assert.equal(frozen.settings.value.imageApiKey, "");
  assert.equal(frozen.settings.value.imageApiKeyConfigured, true);
  assert.equal(frozen.settings.value.videoApiKey, "");
  assert.equal(frozen.settings.value.videoApiKeyConfigured, true);
  assert.deepEqual(frozen.agent, {
    command: "codex",
    providerId: "codex",
    model: "gpt-5.4",
    credentialProviderId: "openai",
    credentialSource: "session",
    baseUrl: "",
    organization: "",
    credentialRequired: false,
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

test("Codex reviewer settings remain Codex while unsupported Gemini falls back to the frozen Codex Agent", () => {
  for (const legacyCommand of ["codex", "gemini"] as const) {
    const frozen = profile({
      visualQaAgentCommand: legacyCommand,
      visualQaModel: legacyCommand === "codex" ? "gpt-5-reviewer" : "gemini-2.5-pro",
    });
    const expectedReviewer = legacyCommand === "codex"
      ? { command: "codex", providerId: "codex", model: "gpt-5-reviewer" }
      : { command: "codex", providerId: "codex", model: "gpt-5.4" };
    assert.deepEqual(frozen.quality.reviewer, expectedReviewer);

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

    assert.equal(bound.qualitySettings.visualQaAgentCommand, expectedReviewer.command);
    assert.equal(bound.qualitySettings.visualQaModel, expectedReviewer.model ?? "");
    assert.equal(bound.environment.ANTHROPIC_API_KEY, undefined);
    assert.deepEqual(buildVisualReviewerEnv(bound.qualitySettings, expectedReviewer.command), {});
  }
});

test("CodeBuddy Artifact binding keeps the frozen model and never injects API credentials", () => {
  const frozen = profile({
    agentCommand: "codebuddy",
    model: "gpt-5.6-sol",
    agentApiKey: "snapshot-secret-must-not-bind",
    agentApiBaseUrl: "",
    visualQaAgentCommand: "",
    visualQaModel: "",
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
      agentCommand: "codebuddy",
      model: "global-model-must-not-win",
      apiBaseUrl: "",
      apiKey: "live-secret-must-not-bind",
    },
  });

  assert.deepEqual(frozen.agent, {
    command: "codebuddy",
    providerId: "codebuddy",
    model: "gpt-5.6-sol",
    credentialProviderId: "codebuddy",
    credentialSource: "session",
    baseUrl: "",
    organization: "",
    credentialRequired: false,
  });
  assert.equal(bound.agentCommand, "codebuddy");
  assert.equal(bound.providerId, "codebuddy");
  assert.equal(bound.model, "gpt-5.6-sol");
  assert.deepEqual(frozen.quality.reviewer, {
    command: "codebuddy",
    providerId: "codebuddy",
    model: "gpt-5.6-sol",
  });
  assert.equal(bound.qualitySettings.visualQaAgentCommand, "codebuddy");
  assert.equal(bound.qualitySettings.visualQaModel, "gpt-5.6-sol");
  assert.deepEqual(buildVisualReviewerEnv(bound.qualitySettings, "codebuddy"), {});
  assert.equal(bound.settings.apiKey, "");
  assert.equal(bound.environment.ANTHROPIC_API_KEY, undefined);
  assert.equal(bound.environment.CODEBUDDY_API_KEY, undefined);
  assert.equal(bound.environment.CODEBUDDY_AUTH_TOKEN, undefined);
});

test("Codex Artifact execution settings retain frozen semantics and use only host login", () => {
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
  assert.equal(hydrated.apiBaseUrl, "");
  assert.equal(hydrated.aiProviderOrganization, "");
  assert.equal(hydrated.visualQaAgentCommand, "claude");
  assert.equal(hydrated.visualQaModel, "reviewer-frozen");
  assert.equal(
    hydrated.visualQaEnabled,
    true,
    "the immutable effective Task QA policy overrides the raw user preference",
  );
  assert.equal(hydrated.customInstructions, "Use restrained motion.");
  assert.equal(hydrated.apiKey, "");
  assert.equal(hydrated.imageApiKey, "", "unrelated image credentials are not admitted to the Artifact process");
  assert.equal(hydrated.videoApiKey, "", "unrelated video credentials are not admitted to the Artifact process");
  assert.doesNotMatch(hydrated.aiProviderProfiles, /fresh-profile-key/);
  assert.doesNotMatch(hydrated.aiProviderProfiles, /mutated-profile\.example/);
  assert.doesNotMatch(hydrated.aiProviderProfiles, /must-not-cross-provider-boundary/);
});

test("Artifact execution settings rotate one exact provider credential and reject source or endpoint substitution", () => {
  const endpoint = "https://anthropic.example.test/v1";
  const anthropicProfiles = (baseUrl: string, apiKey: string) => JSON.stringify({
    anthropic: {
      enabled: true,
      baseUrl,
      apiKey,
      models: "claude-sonnet-4-6",
      organization: "reviewer-org-frozen",
    },
  });
  const frozen = profile({
    agentCommand: "claude",
    model: "claude-sonnet-4-6",
    agentApiBaseUrl: endpoint,
    anthropicReviewerBaseUrl: endpoint,
    anthropicReviewerApiKey: "frozen-secret",
  });
  const base = {
    ...settings(),
    agentCommand: "gemini",
    model: "mutated-model",
    aiProviderProfiles: anthropicProfiles(endpoint, "current-secret"),
  };

  const exact = hydrateArtifactExecutionSettings(frozen, base);
  assert.equal(exact.agentCommand, "claude");
  assert.equal(exact.model, "claude-sonnet-4-6");
  assert.equal(exact.apiKey, "current-secret");

  for (const live of [
    {
      ...base,
      aiProviderProfiles: anthropicProfiles("https://drifted.example.test/v1", "current-secret"),
    },
    { ...base, aiProviderProfiles: "{}" },
    { ...base, aiProviderProfiles: anthropicProfiles(endpoint, "") },
  ]) {
    assert.throws(
      () => hydrateArtifactExecutionSettings(frozen, live),
      /credential for the frozen Artifact Agent provider, source, endpoint, and organization is unavailable/i,
    );
  }
});

test("Artifact execution rejects credential-requirement drift for the same provider profile", () => {
  const endpoint = "https://anthropic.example.test/v1";
  const anthropicProfiles = (apiKey: string) => JSON.stringify({
    anthropic: {
      enabled: true,
      baseUrl: endpoint,
      apiKey,
      models: "claude-sonnet-4-6",
      organization: "org-frozen",
    },
  });
  const frozen = profile({
    agentCommand: "claude",
    model: "claude-sonnet-4-6",
    aiProviderProfiles: anthropicProfiles(""),
  });

  assert.equal(frozen.agent.credentialSource, "provider-profile");
  assert.equal(frozen.agent.credentialRequired, false);
  assert.throws(
    () => hydrateArtifactExecutionSettings(frozen, {
      ...settings(),
      agentCommand: "claude",
      model: "claude-sonnet-4-6",
      aiProviderProfiles: anthropicProfiles("newly-configured-key"),
    }),
    /credential for the frozen Artifact Agent provider, source, endpoint, and organization is unavailable/i,
  );
});

test("legacy Claude key-only Artifact authority persists no secret and hydrates the same source", () => {
  const frozen = profile({
    agentCommand: "claude",
    model: "claude-sonnet-4-6",
    agentApiBaseUrl: "",
    agentApiKey: "legacy-key-only-secret",
    aiProviderId: "",
    aiProviderEnabled: false,
    aiProviderProfiles: "",
    imageEnabled: false,
  });

  assert.equal(frozen.agent.credentialSource, "agent");
  assert.equal(frozen.agent.credentialRequired, true);
  assert.equal(frozen.settings.value.apiKey, "");
  assert.equal(frozen.settings.value.apiKeyConfigured, true);
  assert.doesNotMatch(stableStringify(frozen), /legacy-key-only-secret/);

  const hydrated = hydrateArtifactExecutionSettings(frozen, {
    ...settings(),
    agentCommand: "claude",
    model: "claude-sonnet-4-6",
    apiBaseUrl: "",
    apiKey: "rotated-key-only-secret",
    aiProviderId: "",
    aiProviderEnabled: false,
    aiProviderProfiles: "",
  });
  assert.equal(hydrated.apiKey, "rotated-key-only-secret");
  assert.equal(hydrated.apiBaseUrl, "");
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
  assert.equal(hydrated.apiBaseUrl, "");
  assert.equal(hydrated.aiProviderOrganization, "");
});

test("ambiguous legacy Codex Artifact BYOK profiles fail closed", () => {
  const current = profile();
  const legacyBodyWithOldChecksum = {
    ...structuredClone(current),
    agent: {
      ...structuredClone(current.agent),
      baseUrl: current.settings.value.apiBaseUrl,
      organization: current.settings.value.aiProviderOrganization,
      credentialRequired: true,
    },
  };
  const { checksum: _oldChecksum, ...legacyBody } = legacyBodyWithOldChecksum;
  const legacy = {
    ...legacyBody,
    checksum: checksumBytes(stableStringify(legacyBody)),
  } as FrozenArtifactExecutionProfile;

  assert.throws(
    () => hydrateArtifactExecutionSettings(legacy, {
      ...settings(),
      agentCommand: "codex",
      apiBaseUrl: "https://another-project-provider.example.test/v1",
      apiKey: "must-not-enter-codex",
      aiProviderOrganization: "another-org",
    }),
    /credential semantic does not match frozen settings/i,
  );

  const substitutedBodyWithOldChecksum = {
    ...structuredClone(legacy),
    agent: {
      ...structuredClone(legacy.agent),
      baseUrl: "https://substituted-provider.example.test/v1",
    },
  };
  const { checksum: _legacyChecksum, ...substitutedBody } = substitutedBodyWithOldChecksum;
  const substituted = {
    ...substitutedBody,
    checksum: checksumBytes(stableStringify(substitutedBody)),
  } as FrozenArtifactExecutionProfile;
  assert.throws(
    () => hydrateArtifactExecutionSettings(substituted, settings()),
    /credential semantic does not match frozen settings/i,
  );

  const tamperedCredentialBodyWithOldChecksum = {
    ...structuredClone(legacy),
    agent: {
      ...structuredClone(legacy.agent),
      credentialRequired: false,
    },
  };
  const {
    checksum: _tamperedCredentialChecksum,
    ...tamperedCredentialBody
  } = tamperedCredentialBodyWithOldChecksum;
  const tamperedCredential = {
    ...tamperedCredentialBody,
    checksum: checksumBytes(stableStringify(tamperedCredentialBody)),
  } as FrozenArtifactExecutionProfile;
  assert.throws(
    () => hydrateArtifactExecutionSettings(tamperedCredential, settings()),
    /credential semantic does not match frozen settings/i,
  );
});

test("checksum-valid legacy Artifact v4 Context fails closed without credential-source authority", () => {
  const current = structuredClone(profile()) as any;
  current.protocol = "dezin.artifact-execution-profile.v4";
  delete current.agent.credentialSource;
  const { checksum: _currentChecksum, ...legacyBody } = current;
  const legacy = {
    ...legacyBody,
    checksum: checksumBytes(stableStringify(legacyBody)),
  } as FrozenArtifactExecutionProfile;
  const ownership = {
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    planId: PLAN_ID,
    taskId: TASK_ID,
    targetArtifactId: ARTIFACT_ID,
  };
  assert.throws(
    () => requireArtifactExecutionProfile(packWithProfile(legacy), ownership),
    /protocol or checksum is invalid/i,
  );
});

test("Artifact execution canonicalizes a credential-free image provider URL from Settings", () => {
  const frozen = profile({ imageProviderBaseUrl: "https://images.example.test" });

  assert.equal(frozen.imageGeneration.baseUrl, "https://images.example.test/");
});

test("Artifact execution rejects credentials, query, or fragment in every persisted Agent endpoint", () => {
  for (const unsafeBaseUrl of [
    "https://user:pass@api.example.test/v1",
    "https://api.example.test/v1?token=secret",
    "https://api.example.test/v1#credential",
  ]) {
    assert.throws(
      () => profile({ agentApiBaseUrl: unsafeBaseUrl }),
      /must be canonical and credential-free/i,
      unsafeBaseUrl,
    );

    const providerProfiles = JSON.parse(settings().aiProviderProfiles) as Record<string, unknown>;
    providerProfiles.anthropic = {
      enabled: true,
      baseUrl: unsafeBaseUrl,
      apiKey: "provider-key",
      models: "claude-sonnet-4-6",
      organization: "",
    };
    assert.throws(
      () => profile({
        agentCommand: "claude",
        aiProviderProfiles: JSON.stringify(providerProfiles),
      }),
      /must be canonical and credential-free/i,
      unsafeBaseUrl,
    );
  }
});

test("Artifact execution rejects image provider URLs with broader non-canonical rewrites", () => {
  for (const imageProviderBaseUrl of [
    "HTTP://images.example.test",
    "http://0x7f000001",
    "https://images.example.test:443",
    "https://images.example.test/a/../",
    "https://images.example.test\t/",
  ]) {
    assert.throws(
      () => profile({ imageProviderBaseUrl }),
      /must be canonical and credential-free/i,
      imageProviderBaseUrl,
    );
  }
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
  const resealTarget = (nextTarget: Record<string, unknown>): ContextPack => {
    const content = stableStringify(nextTarget);
    return sealContextPack({
      ...pack,
      items: [{ ...target, content, checksum: checksumBytes(content) }, ...pack.items.slice(1)],
    });
  };
  assert.throws(
    () => requireArtifactExecutionProfile(resealTarget({ ...parsed, unexpectedField: true }), expected),
    /target Context fields are invalid/i,
  );
  const plannedRelation = (edgeId: string) => ({
    edgeId,
    source: {
      nodeId: "node-profile",
      artifactId: ARTIFACT_ID,
      kind: "page",
      name: "Profile",
      revisionId: "revision-profile",
    },
    target: {
      nodeId: "node-peer",
      artifactId: "artifact-peer",
      kind: "component",
      name: "Peer",
      revisionId: null,
    },
    targetArtifactRole: "source",
    status: "planned",
    binding: null,
    transition: null,
    brokenReason: null,
  });
  assert.throws(
    () => requireArtifactExecutionProfile(resealTarget({
      ...parsed,
      relevantPrototypeRelations: [{ ...plannedRelation("edge-a"), unexpectedField: true }],
    }), expected),
    /prototype relation.*fields are invalid/i,
  );
  assert.throws(
    () => requireArtifactExecutionProfile(resealTarget({
      ...parsed,
      relevantPrototypeRelations: [plannedRelation("edge-b"), plannedRelation("edge-a")],
    }), expected),
    /canonical edge-id order/i,
  );
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
  assert.equal(bound.environment.OPENAI_API_KEY, undefined);
  assert.equal(bound.environment.OPENAI_BASE_URL, undefined);
  assert.equal(bound.environment.OPENAI_ORG_ID, undefined);
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

  assert.equal(bound.environment.OPENAI_API_KEY, undefined);
  assert.equal(bound.environment.ANTHROPIC_API_KEY, undefined);
  assert.equal(bound.settings.apiKey, "");
  assert.equal(bound.settings.apiBaseUrl, "");
  assert.equal(bound.settings.aiProviderOrganization, "");
  assert.equal(bound.qualitySettings.apiKey, "");
  assert.equal(bound.qualitySettings.visualQaAgentCommand, "claude");
  assert.equal(bound.qualitySettings.visualQaModel, "reviewer-frozen");
  assert.deepEqual(buildVisualReviewerEnv(bound.qualitySettings), {
    ANTHROPIC_API_KEY: "fresh-reviewer-key",
    ANTHROPIC_BASE_URL: "https://frozen-anthropic.example.test/",
    ANTHROPIC_AUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
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

  assert.equal(bound.environment.OPENAI_API_KEY, undefined);
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
  const researchContextPack = persistResearchRevisionFixtureContextPack({
    store,
    manifestRoot: dataDir,
    workspaceId: workspace.id,
    resourceId: created.resource.id,
    graphRevision: store.workspace.getWorkspace(project.id)!.graphRevision,
  });
  const researchFixture = createResearchRevisionFixture({
    workspaceId: workspace.id,
    resourceId: created.resource.id,
    contextPack: researchContextPack,
  });
  const immutableDirection = researchFixture.bundle.directions[0]!;
  await writeFile(
    join(repositoryDir, "research-resource.json"),
    `${stableStringify(researchFixture.bundle)}\n`,
    "utf8",
  );
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
    provenance: researchFixture.provenance,
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
      metadata: {
        ...researchFixture.metadata,
        mimeType: snapshot.mimeType,
        byteSize: snapshot.byteSize,
        payloadChecksum: snapshot.payloadChecksum,
      },
      checksum: snapshot.checksum,
      provenance: researchFixture.provenance,
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
  const otherResearchContextPack = persistResearchRevisionFixtureContextPack({
    store,
    manifestRoot: dataDir,
    workspaceId: workspace.id,
    resourceId: otherCreated.resource.id,
    graphRevision: store.workspace.getWorkspace(project.id)!.graphRevision,
  });
  const otherResearchFixture = createResearchRevisionFixture({
    workspaceId: workspace.id,
    resourceId: otherCreated.resource.id,
    contextPack: otherResearchContextPack,
  });
  const sameNamedOtherDirection = {
    ...otherResearchFixture.bundle.directions[0]!,
    thesis: "A different pinned Revision happens to reuse the same local direction id.",
  };
  otherResearchFixture.bundle.directions[0] = sameNamedOtherDirection;
  await writeFile(
    join(repositoryDir, "other-research-resource.json"),
    `${stableStringify(otherResearchFixture.bundle)}\n`,
    "utf8",
  );
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
    provenance: otherResearchFixture.provenance,
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
      metadata: {
        ...otherResearchFixture.metadata,
        mimeType: otherSnapshot.mimeType,
        byteSize: otherSnapshot.byteSize,
        payloadChecksum: otherSnapshot.payloadChecksum,
      },
      checksum: otherSnapshot.checksum,
      provenance: otherResearchFixture.provenance,
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
        agent: {
          providerId: "codebuddy",
          command: "codebuddy",
          model: "gpt-5.6-sol",
        },
        reviewer: {
          providerId: "claude",
          command: "claude",
          model: "reviewer-frozen",
        },
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
  assert.deepEqual(frozen.agent, {
    command: "codebuddy",
    providerId: "codebuddy",
    model: "gpt-5.6-sol",
    credentialProviderId: "codebuddy",
    credentialSource: "session",
    baseUrl: "",
    organization: "",
    credentialRequired: false,
  });
  assert.equal(frozen.designSystem?.content.designMd, designSystem.designMd);
  assert.equal(frozen.skill?.id, "frontend-design");
  assert.match(frozen.skill?.content.body ?? "", /frontend/i);
  assert.equal(frozen.researchDirection?.resourceId, created.resource.id);
  assert.equal(frozen.researchDirection?.revisionId, revision.id);
  assert.equal(frozen.researchDirection?.payloadChecksum, snapshot.payloadChecksum);
  assert.equal(frozen.researchDirection?.content, stableStringify(immutableDirection));
  assert.doesNotMatch(frozen.researchDirection?.content ?? "", /Mutable legacy shadow/);
  assert.deepEqual(frozen.quality.ignores, [{ ruleId: "intentional-density", selector: ".summary" }]);
  assert.deepEqual(frozen.quality.reviewer, {
    command: "claude",
    providerId: "claude",
    model: "reviewer-frozen",
  });
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
  assert.equal(frozen.agent.command, "codebuddy");
  assert.match(frozen.researchDirection?.content ?? "", /persistent order rail/);
  assert.equal(frozen.imageGeneration.model, "image-frozen");
  const rematerialized = await loader(request, new AbortController().signal);
  assert.notEqual(rematerialized.checksum, frozen.checksum);
  assert.equal(rematerialized.project.name, "Mutated checkout");
  assert.equal(rematerialized.agent.command, "codebuddy");
  assert.equal(rematerialized.agent.model, "gpt-5.6-sol");
  assert.deepEqual(rematerialized.quality.reviewer, frozen.quality.reviewer);
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

test("same-Plan generated Research freezes one exact direction matched by immutable Artifact instructions", async (t) => {
  const fixture = await artifactResearchValidationFixture(t, () => {});
  const request = samePlanGeneratedResearchRequest(
    fixture.request,
    'Use the exact Research direction "Quiet confidence" with id "quiet-confidence" for Checkout.',
  );

  const frozen = await fixture.loader(request, new AbortController().signal);
  assert.ok(frozen.researchDirection);
  assert.equal(frozen.researchDirection.directionId, "quiet-confidence");
  assert.equal(
    frozen.researchDirection.resourceId,
    request.observation.resourcePins[0]!.resourceId,
  );
  assert.equal(
    frozen.researchDirection.revisionId,
    request.observation.resourcePins[0]!.revisionId,
  );
  const direction = JSON.parse(frozen.researchDirection.content) as {
    id: string;
    title: string;
  };
  assert.equal(direction.id, "quiet-confidence");
  assert.equal(direction.title, "Quiet confidence");
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(Object.isFrozen(frozen.researchDirection), true);

  const repeated = await fixture.loader(
    structuredClone(request),
    new AbortController().signal,
  );
  assert.equal(repeated.checksum, frozen.checksum);
  assert.deepEqual(repeated.researchDirection, frozen.researchDirection);
});

test("legacy same-Plan Page binds one immutable Research direction by matching ordinal and Page title", async (t) => {
  const fixture = await artifactResearchValidationFixture(t, () => {});
  const frozen = await fixture.loader(
    samePlanGeneratedResearchRequest(
      fixture.request,
      "Required explicit Page scope — Direction: Direction 2; Page: Checkout. Build the exact approved checkout flow.",
      { kind: "page", name: "Direction 2 Checkout" },
    ),
    new AbortController().signal,
  );

  assert.ok(frozen.researchDirection);
  assert.equal(frozen.researchDirection.directionId, "expressive-confirmation");
  assert.equal(frozen.researchDirection.directionIds, undefined);
  const direction = JSON.parse(frozen.researchDirection.content) as {
    id: string;
    title: string;
  };
  assert.deepEqual(
    { id: direction.id, title: direction.title },
    { id: "expressive-confirmation", title: "Expressive confirmation" },
  );
});

test("legacy Page refuses automatic Research selection when the pin is not an exact same-Plan dependency output", async (t) => {
  const fixture = await artifactResearchValidationFixture(t, () => {});
  const request = samePlanGeneratedResearchRequest(
    fixture.request,
    "Required explicit Page scope — Direction: Direction 1; Page: Checkout. Build the exact approved checkout flow.",
    { kind: "page", name: "Direction 1 Checkout" },
  );
  request.observation.resourcePins[0]!.sourceTaskId = "other-plan-research-task";

  await assert.rejects(
    async () => fixture.loader(request, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof BlockedContextError);
      assert.match(error.message, /same Plan/i);
      assert.ok(error.missing.some((item) => item.endsWith(":direction-selection")));
      return true;
    },
  );
});

test("legacy same-Plan Page blocks an ordinal outside the immutable Research direction set", async (t) => {
  const fixture = await artifactResearchValidationFixture(t, () => {});
  const request = samePlanGeneratedResearchRequest(
    fixture.request,
    "Required explicit Page scope — Direction: Direction 3; Page: Checkout. Build the exact approved checkout flow.",
    { kind: "page", name: "Direction 3 Checkout" },
  );

  await assert.rejects(
    async () => fixture.loader(request, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof BlockedContextError);
      assert.match(error.message, /Research direction.*no exact match/i);
      return true;
    },
  );
});

test("legacy same-Plan Page blocks mismatched ordinal-title authority", async (t) => {
  const fixture = await artifactResearchValidationFixture(t, () => {});
  const request = samePlanGeneratedResearchRequest(
    fixture.request,
    "Required explicit Page scope — Direction: Direction 1; Page: Home. Build the exact approved home flow.",
    { kind: "page", name: "Direction 1 Checkout" },
  );

  await assert.rejects(
    async () => fixture.loader(request, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof BlockedContextError);
      assert.match(error.message, /Research direction.*no exact match/i);
      return true;
    },
  );
});

test("legacy same-Plan Page blocks more than one ordinal-title clause", async (t) => {
  const fixture = await artifactResearchValidationFixture(t, () => {});
  const request = samePlanGeneratedResearchRequest(
    fixture.request,
    [
      "Required explicit Page scope — Direction: Direction 1; Page: Checkout.",
      "Direction: Direction 2; Page: Checkout.",
    ].join(" "),
    { kind: "page", name: "Direction 1 Checkout" },
  );

  await assert.rejects(
    async () => fixture.loader(request, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof BlockedContextError);
      assert.match(error.message, /Research direction.*no exact match/i);
      return true;
    },
  );
});

test("legacy same-Plan Page blocks an ambiguous immutable Research title set", async (t) => {
  const fixture = await artifactResearchValidationFixture(t, (direction) => {
    direction.title = "Expressive confirmation";
  });
  const request = samePlanGeneratedResearchRequest(
    fixture.request,
    "Required explicit Page scope — Direction: Direction 1; Page: Checkout. Build the exact approved checkout flow.",
    { kind: "page", name: "Direction 1 Checkout" },
  );

  await assert.rejects(
    async () => fixture.loader(request, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof BlockedContextError);
      assert.match(error.message, /Research direction.*no exact match/i);
      return true;
    },
  );
});

test("exact reused Research selection freezes its ordered immutable direction set for one Artifact", async (t) => {
  const fixture = await artifactResearchValidationFixture(t, () => {});
  const request = structuredClone(fixture.request);
  const selection = (request.task.payload.artifactPlan as Record<string, any>)
    .researchDirectionSelection;
  selection.directionId = "expressive-confirmation";
  selection.directionIds = ["expressive-confirmation", "quiet-confidence"];

  const frozen = await fixture.loader(request, new AbortController().signal);

  assert.ok(frozen.researchDirection);
  assert.equal(frozen.researchDirection.directionId, "expressive-confirmation");
  assert.deepEqual(frozen.researchDirection.directionIds, [
    "expressive-confirmation",
    "quiet-confidence",
  ]);
  const directions = JSON.parse(frozen.researchDirection.content) as Array<{
    id: string;
    title: string;
  }>;
  assert.deepEqual(directions.map(({ id, title }) => ({ id, title })), [
    { id: "expressive-confirmation", title: "Expressive confirmation" },
    { id: "quiet-confidence", title: "Quiet confidence" },
  ]);
  assert.equal(Object.isFrozen(frozen.researchDirection.directionIds), true);
});

test("exact reused Research selection rejects structurally invalid direction sets", async (t) => {
  const fixture = await artifactResearchValidationFixture(t, () => {});
  for (const [directionIds, pattern] of [
    [["quiet-confidence", "quiet-confidence"], /direction ids.*unique/i],
    [["expressive-confirmation", "quiet-confidence"], /first.*directionId/i],
    [["quiet-confidence"], /between 2 and 16/i],
  ] as const) {
    const request = structuredClone(fixture.request);
    const selection = (request.task.payload.artifactPlan as Record<string, any>)
      .researchDirectionSelection;
    selection.directionIds = directionIds;
    await assert.rejects(
      async () => fixture.loader(request, new AbortController().signal),
      pattern,
    );
  }
});

test("exact reused Research selection rejects a set member missing from the immutable Revision", async (t) => {
  const fixture = await artifactResearchValidationFixture(t, () => {});
  const request = structuredClone(fixture.request);
  const selection = (request.task.payload.artifactPlan as Record<string, any>)
    .researchDirectionSelection;
  selection.directionIds = ["quiet-confidence", "missing-direction"];

  await assert.rejects(
    async () => fixture.loader(request, new AbortController().signal),
    /missing or ambiguous in its pinned Revision/i,
  );
});

test("same-Plan generated Research lets direction-agnostic shared KITE Components inherit every immutable direction", async (t) => {
  const fixture = await artifactResearchValidationFixture(t, () => {});
  const cases = [
    {
      name: "KITE Checkout Form",
      instructions: "Reusable attendee/payment form for Checkout pages; show contact fields, promo code, totals, payment CTA, and validation-error, payment-processing, and confirmation states. Keep the form real and legible.",
    },
    {
      name: "KITE Schedule Row",
      instructions: "Reusable schedule row for Schedule pages; show day, film, time, venue, runtime, format, and availability. Support day-filtered and sold-out states with direction-specific styling.",
    },
    {
      name: "KITE Ticket Selector",
      instructions: "Reusable ticket/pass selector for Film, Schedule, and Checkout pages; show quantities, tiers, selection feedback, and sold-out/validation states. Keep it compact and direction-aware.",
    },
  ];

  for (const candidate of cases) {
    const frozen = await fixture.loader(
      samePlanGeneratedResearchRequest(fixture.request, candidate.instructions, {
        kind: "component",
        name: candidate.name,
      }),
      new AbortController().signal,
    );
    assert.ok(frozen.researchDirection);
    assert.deepEqual(frozen.researchDirection.directionIds, [
      "quiet-confidence",
      "expressive-confirmation",
    ], candidate.name);
    const directions = JSON.parse(frozen.researchDirection.content) as Array<{
      id: string;
      title: string;
    }>;
    assert.deepEqual(
      directions.map(({ id, title }) => ({ id, title })),
      [
        { id: "quiet-confidence", title: "Quiet confidence" },
        { id: "expressive-confirmation", title: "Expressive confirmation" },
      ],
      candidate.name,
    );
  }
});

test("same-Plan generated Research keeps a direction-specific Component pinned to its one exact immutable direction", async (t) => {
  const fixture = await artifactResearchValidationFixture(t, () => {});
  const frozen = await fixture.loader(
    samePlanGeneratedResearchRequest(
      fixture.request,
      'Build this Component only for the exact Research direction "Quiet confidence" with id "quiet-confidence".',
      { kind: "component", name: "Direction-specific KITE Hero" },
    ),
    new AbortController().signal,
  );

  assert.ok(frozen.researchDirection);
  assert.equal(frozen.researchDirection.directionId, "quiet-confidence");
  assert.equal(frozen.researchDirection.directionIds, undefined);
  const direction = JSON.parse(frozen.researchDirection.content) as {
    id: string;
    title: string;
  };
  assert.deepEqual(
    { id: direction.id, title: direction.title },
    { id: "quiet-confidence", title: "Quiet confidence" },
  );
});

test("same-Plan generated Research freezes explicit multi-direction and all-direction contracts as one deterministic set", async (t) => {
  const fixture = await artifactResearchValidationFixture(t, () => {});
  const cases = [
    'Use both exact Research directions: "Quiet confidence" (quiet-confidence) and "Expressive confirmation" (expressive-confirmation).',
    "Use all directions from the exact generated Research Revision.",
  ];
  let expectedContent: string | null = null;

  for (const instructions of cases) {
    const frozen = await fixture.loader(
      samePlanGeneratedResearchRequest(fixture.request, instructions),
      new AbortController().signal,
    );
    assert.ok(frozen.researchDirection);
    const directionSet = frozen.researchDirection as typeof frozen.researchDirection & {
      directionIds: readonly string[];
    };
    assert.deepEqual(directionSet.directionIds, [
      "quiet-confidence",
      "expressive-confirmation",
    ]);
    const directions = JSON.parse(directionSet.content) as Array<{ id: string; title: string }>;
    assert.deepEqual(
      directions.map(({ id, title }) => ({ id, title })),
      [
        { id: "quiet-confidence", title: "Quiet confidence" },
        { id: "expressive-confirmation", title: "Expressive confirmation" },
      ],
    );
    assert.equal(directionSet.content, stableStringify(directions));
    if (expectedContent === null) expectedContent = directionSet.content;
    else assert.equal(directionSet.content, expectedContent);
  }
});

test("same-Plan generated Research keeps Pages fail-closed for typoed and absent direction matches", async (t) => {
  const fixture = await artifactResearchValidationFixture(t, () => {});
  for (const instructions of [
    'Use the exact Research direction "Quiet confidence" with typoed id "quiet-confidenc" for Checkout.',
    "Use a restrained editorial direction for Checkout.",
  ]) {
    const request = samePlanGeneratedResearchRequest(
      fixture.request,
      instructions,
      { kind: "page", name: "KITE Checkout" },
    );
    await assert.rejects(
      async () => fixture.loader(request, new AbortController().signal),
      (error: unknown) => {
        assert.ok(error instanceof BlockedContextError);
        assert.match(error.message, /Research direction.*(?:no exact match|does not match)/i);
        return true;
      },
      instructions,
    );
  }
});

test("same-Plan generated Research rechecks the immutable Component inheritance contract after materialization", async (t) => {
  const fixture = await artifactResearchValidationFixture(t, () => {});
  const request = samePlanGeneratedResearchRequest(
    fixture.request,
    'Build this Artifact for the exact Research direction "Quiet confidence" with id "quiet-confidence".',
    { kind: "component", name: "KITE Contract Fence" },
  );
  const originalRevisionRead = fixture.store.workspace.getResourceRevisionForProject
    .bind(fixture.store.workspace);
  Object.defineProperty(fixture.store.workspace, "getResourceRevisionForProject", {
    configurable: true,
    value(...args: Parameters<typeof originalRevisionRead>) {
      request.task.kind = "page";
      const payload = request.task.payload as Record<string, unknown>;
      (payload.artifactPlan as Record<string, unknown>).kind = "page";
      const brief = payload.brief as Record<string, unknown>;
      (brief.targetInstructions as Record<string, unknown>).kind = "page";
      return originalRevisionRead(...args);
    },
  });

  try {
    await assert.rejects(
      async () => fixture.loader(request, new AbortController().signal),
      /generated Research direction contract changed during materialization/i,
    );
  } finally {
    delete (fixture.store.workspace as unknown as Record<string, unknown>)
      .getResourceRevisionForProject;
  }
});

test("legacy Page rechecks same-Plan dependency authority after Research payload materialization", async (t) => {
  const fixture = await artifactResearchValidationFixture(t, () => {});
  const request = samePlanGeneratedResearchRequest(
    fixture.request,
    "Required explicit Page scope — Direction: Direction 1; Page: Checkout. Build the exact approved checkout flow.",
    { kind: "page", name: "Direction 1 Checkout" },
  );
  const originalRevisionRead = fixture.store.workspace.getResourceRevisionForProject
    .bind(fixture.store.workspace);
  Object.defineProperty(fixture.store.workspace, "getResourceRevisionForProject", {
    configurable: true,
    value(...args: Parameters<typeof originalRevisionRead>) {
      request.observation.dependencyOutputs[0]!.taskId = "cross-plan-research-task";
      return originalRevisionRead(...args);
    },
  });

  try {
    await assert.rejects(
      async () => fixture.loader(request, new AbortController().signal),
      /generated Research direction contract changed during materialization/i,
    );
  } finally {
    delete (fixture.store.workspace as unknown as Record<string, unknown>)
      .getResourceRevisionForProject;
  }
});

test("Artifact execution rejects a Research direction that references a missing finding", async (t) => {
  const fixture = await artifactResearchValidationFixture(t, (direction) => {
    direction.findingIds = ["finding-missing"];
    direction.evidenceStatus = "evidence";
    direction.evidenceFindingIds = ["finding-missing"];
    direction.hypothesisFindingIds = [];
  });

  await assert.rejects(
    async () => await fixture.loader(fixture.request, new AbortController().signal),
    /Research direction quiet-confidence finding evidence is inconsistent/i,
  );
});

test("Artifact execution rejects a Research direction that relabels a hypothesis finding as evidence", async (t) => {
  const fixture = await artifactResearchValidationFixture(t, (direction) => {
    direction.findingIds = ["finding-celebration"];
    direction.evidenceStatus = "evidence";
    direction.evidenceFindingIds = ["finding-celebration"];
    direction.hypothesisFindingIds = [];
  });

  await assert.rejects(
    async () => await fixture.loader(fixture.request, new AbortController().signal),
    /Research direction quiet-confidence finding evidence is inconsistent/i,
  );
});

test("Artifact execution keeps pinned legacy Research v1/v2 directions usable as hypotheses", async (t) => {
  for (const version of [1, 2] as const) {
    const fixture = await artifactResearchValidationFixture(t, () => {}, version);
    const frozen = await fixture.loader(fixture.request, new AbortController().signal);
    const direction = JSON.parse(frozen.researchDirection!.content) as ResearchFixtureDirection;
    assert.equal(direction.id, "quiet-confidence");
    assert.equal(direction.evidenceStatus, "hypothesis");
    assert.deepEqual(direction.evidenceFindingIds, []);
    assert.deepEqual(direction.hypothesisFindingIds, ["finding-comparison", "finding-summary"]);
  }
});

test("Artifact execution preserves an explicit no-design-system selection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dezin-no-design-system-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const designSystem = {
    id: "global-default-system",
    name: "Global Default System",
    category: "Editorial",
    summary: "Must not constrain this Task",
    designMd: "# Global Default System\nUse only one visual direction.",
    tokensCss: ":root { --color-accent: #123456; }",
    craft: { applies: [] },
  };
  const project = store.createProject({
    name: "Three unconstrained directions",
    mode: "standard",
    skillId: "frontend-design",
    designSystemId: "__dezin_no_design_system__",
  });
  store.updateSettings({ defaultDesignSystemId: designSystem.id, visualQaEnabled: false });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
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
      target: {
        type: "artifact",
        workspaceId: workspace.id,
        id: ARTIFACT_ID,
        trackId: "track-profile",
      },
      payload: { brief: { proposalRationale: "Create three intentionally different visual directions." } },
      qaProfile: { requireVisualReview: false },
    },
    observation: { resourcePins: [] },
  } as never, new AbortController().signal);

  assert.equal(frozen.designSystem, null);
  assert.doesNotMatch(frozen.prompt.systemPrompt, /Active design system/);
  assert.doesNotMatch(frozen.prompt.systemPrompt, /Global Default System/);
});

test("Artifact reviewer authority admits same-source secret rotation and rejects endpoint or source drift", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dezin-artifact-reviewer-authority-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({
    name: "Frozen reviewer authority",
    mode: "standard",
    designSystemId: "__dezin_no_design_system__",
  });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const reviewerProfiles = (baseUrl: string, apiKey: string, enabled = true) => JSON.stringify({
    anthropic: {
      enabled,
      baseUrl,
      apiKey,
      models: "claude-opus-4-8",
      organization: "reviewer-org",
    },
  });
  store.updateSettings({
    agentCommand: "codex",
    model: "gpt-5.4",
    aiProviderId: "openai",
    aiProviderEnabled: true,
    aiProviderProfiles: reviewerProfiles(
      "https://reviewer-authority.example/v1",
      "proposal-time-secret",
    ),
    visualQaEnabled: true,
    visualQaAgentCommand: "claude",
    visualQaModel: "claude-opus-4-8",
  });
  const loader = createProductionArtifactExecutionProfileLoader({
    store,
    dataDir: root,
    designRegistry: new DesignRegistry([]),
    repositoryDirForWorkspace: () => root,
  });
  const request = {
    projectId: project.id,
    planId: PLAN_ID,
    task: {
      id: TASK_ID,
      planId: PLAN_ID,
      workspaceId: workspace.id,
      kind: "page",
      target: {
        type: "artifact",
        workspaceId: workspace.id,
        id: ARTIFACT_ID,
        trackId: "track-reviewer-authority",
      },
      payload: {
        version: 2,
        agent: {
          providerId: "codex",
          command: "codex",
          model: "gpt-5.4",
          executionAuthority: {
            kind: "generator",
            baseUrl: "",
            organization: "",
            credentialProviderId: "openai",
            credentialSource: "session",
            credentialRequired: false,
          },
        },
        reviewer: {
          providerId: "claude",
          command: "claude",
          model: "claude-opus-4-8",
          executionAuthority: {
            kind: "reviewer",
            baseUrl: "https://reviewer-authority.example/v1",
            credentialSource: "anthropic-profile",
            credentialRequired: true,
          },
        },
        brief: { proposalRationale: "Build with one independently frozen reviewer." },
      },
      qaProfile: { requireVisualReview: true },
    },
    observation: { resourcePins: [] },
  } as never;

  const first = await loader(request, new AbortController().signal);
  store.updateSettings({
    aiProviderProfiles: reviewerProfiles(
      "https://reviewer-authority.example/v1",
      "rotated-same-source-secret",
    ),
  });
  const rotated = await loader(request, new AbortController().signal);
  assert.equal(rotated.checksum, first.checksum);
  assert.deepEqual(rotated.quality.reviewer, first.quality.reviewer);

  store.updateSettings({
    aiProviderProfiles: reviewerProfiles(
      "https://drifted-reviewer.example/v1",
      "rotated-same-source-secret",
    ),
  });
  await assert.rejects(
    async () => loader(request, new AbortController().signal),
    /changed the frozen Task reviewer endpoint, credential source, or credential requirement/i,
  );

  store.updateSettings({
    aiProviderProfiles: reviewerProfiles(
      "https://reviewer-authority.example/v1",
      "rotated-same-source-secret",
      false,
    ),
  });
  await assert.rejects(
    async () => loader(request, new AbortController().signal),
    /changed the frozen Task reviewer endpoint, credential source, or credential requirement/i,
  );
});

test("Artifact authority materializes a non-default Claude generator against Codex Settings without false drift", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dezin-artifact-nondefault-authority-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({
    name: "Non-default frozen Artifact Agent",
    mode: "standard",
    designSystemId: "__dezin_no_design_system__",
  });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  store.updateSettings({
    agentCommand: "codex",
    model: "gpt-5.4",
    apiBaseUrl: "https://must-not-be-relabelled.example/v1",
    apiKey: "must-not-be-relabelled",
    aiProviderId: "openai",
    visualQaEnabled: true,
    visualQaAgentCommand: "claude",
    visualQaModel: "claude-opus-4-8",
  });
  const loader = createProductionArtifactExecutionProfileLoader({
    store,
    dataDir: root,
    designRegistry: new DesignRegistry([]),
    repositoryDirForWorkspace: () => root,
  });
  const request = {
    projectId: project.id,
    planId: PLAN_ID,
    task: {
      id: TASK_ID,
      planId: PLAN_ID,
      workspaceId: workspace.id,
      kind: "page",
      target: {
        type: "artifact",
        workspaceId: workspace.id,
        id: ARTIFACT_ID,
        trackId: "track-nondefault-authority",
      },
      payload: {
        version: 2,
        agent: {
          providerId: "claude",
          command: "claude",
          model: "claude-sonnet-4-6",
          executionAuthority: {
            kind: "generator",
            baseUrl: "",
            organization: "",
            credentialProviderId: "anthropic",
            credentialSource: "session",
            credentialRequired: false,
          },
        },
        reviewer: {
          providerId: "claude",
          command: "claude",
          model: "claude-opus-4-8",
          executionAuthority: {
            kind: "reviewer",
            baseUrl: "",
            credentialSource: "session",
            credentialRequired: false,
          },
        },
        brief: { proposalRationale: "Use the explicitly selected Claude generator." },
      },
      qaProfile: { requireVisualReview: true },
    },
    observation: { resourcePins: [] },
  } as never;

  const frozen = await loader(request, new AbortController().signal);
  assert.deepEqual(frozen.agent, {
    command: "claude",
    providerId: "claude",
    model: "claude-sonnet-4-6",
    credentialProviderId: "anthropic",
    credentialSource: "session",
    baseUrl: "",
    organization: "",
    credentialRequired: false,
  });
  assert.deepEqual(frozen.quality.reviewer, {
    command: "claude",
    providerId: "claude",
    model: "claude-opus-4-8",
  });
  assert.doesNotMatch(JSON.stringify(frozen), /must-not-be-relabelled/);
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
