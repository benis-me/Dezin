import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { GenerationTaskContextRequest } from "../src/orchestration/generation-plan-service.ts";
import type { WorkspaceGraph, WorkspaceSnapshot } from "../../../packages/core/src/index.ts";
import {
  freezeArtifactExecutionProfile,
  freezeResourceExecutionProfile,
  type GenerationContextWorkspacePort,
} from "../src/orchestration/production-generation-context.ts";
import {
  ContextPackStore,
} from "../src/context/context-pack-store.ts";
import {
  checksumBytes,
  estimateContextTokens,
  stableStringify,
  type ContextPack,
  type ContextPackItemUsage,
  type ContextPackRepository,
  type ResourceRevisionSnapshot,
} from "../src/context/context-types.ts";
import { resourceAdapters } from "../src/context/adapters/index.ts";

class MemoryContextPackRepository implements ContextPackRepository {
  readonly packs = new Map<string, ContextPack>();

  findByHash(workspaceId: string, hash: string): ContextPack | null {
    return [...this.packs.values()].find(
      (pack) => pack.workspaceId === workspaceId && pack.hash === hash,
    ) ?? null;
  }

  insert(pack: ContextPack): ContextPack {
    this.packs.set(pack.id, pack);
    return pack;
  }

  get(workspaceId: string, id: string): ContextPack | null {
    const pack = this.packs.get(id) ?? null;
    return pack?.workspaceId === workspaceId ? pack : null;
  }

  appendUsage(): ContextPackItemUsage {
    throw new Error("unused");
  }

  listUsage(): readonly ContextPackItemUsage[] {
    return [];
  }
}

const WORKSPACE_ID = "workspace-1";
const PROJECT_ID = "project-1";
const TARGET_ARTIFACT_ID = "artifact-page";
const TARGET_TRACK_ID = "track-page";
const KERNEL_REVISION_ID = "kernel-revision-1";
const KERNEL_CHECKSUM = "1".repeat(64);

function executionProfile(projectName: string, hasExactSharinganCapture = false) {
  const settings = {
    agentCommand: "codex",
    model: "gpt-5.4",
    apiBaseUrl: "https://api.example.test/v1",
    apiKey: "must-not-persist",
    defaultDesignSystemId: "modern-minimal",
    customInstructions: "",
    imageApiBaseUrl: "",
    imageApiKey: "",
    imageModel: "",
    removeBackgroundModel: "",
    editRegionModel: "",
    extractLayerModel: "",
    videoApiBaseUrl: "",
    videoApiKey: "",
    videoModel: "",
    aiProviderId: "openai",
    aiProviderEnabled: true,
    aiProviderModels: "gpt-5.4",
    aiProviderOrganization: "",
    aiProviderProfiles: "{}",
    visualQaEnabled: true,
    autoFixLiveRuntimeErrors: false,
    sharinganAffirmed: true,
    visualQaAgentCommand: "codex",
    visualQaModel: "gpt-5.4-reviewer",
    researchEnabled: true,
    researchAgentCommand: "codex",
    researchModel: "gpt-5.4",
    autoImproveEnabled: true,
    autoImproveMaxRounds: 2,
  };
  return freezeArtifactExecutionProfile({
    ownership: {
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      planId: "plan-1",
      taskId: "task-page",
      targetArtifactId: TARGET_ARTIFACT_ID,
    },
    hasExactSharinganCapture,
    project: {
      id: PROJECT_ID,
      name: projectName,
      skillId: null,
      designSystemId: null,
      mode: "standard",
      sharingan: false,
      sourceUrl: null,
    },
    settings,
    agent: { command: "codex", providerId: "codex", model: "gpt-5.4" },
    designSystem: hasExactSharinganCapture ? null : {
      requestedId: "modern-minimal",
      resolvedId: "modern-minimal",
      content: {
        id: "modern-minimal",
        name: "Modern Minimal",
        category: "Modern",
        summary: "Precise restraint",
        designMd: "# Modern Minimal\nUse a disciplined grid.",
        tokensCss: ":root { --color-ink: #111111; }",
        craft: { applies: [] },
      },
    },
    skill: null,
    researchDirection: {
      directionId: "checkout",
      content: "Editorial checkout with clear hierarchy.",
      resourceId: "resource-research",
      revisionId: "revision-research",
      revisionChecksum: snapshotsChecksumPlaceholder,
      payloadChecksum: "b".repeat(64),
    },
    prompt: {
      rendererProtocol: "dezin.project-agent-prompt.v1",
      rendererVersion: 1,
      systemPrompt: `Frozen prompt for ${projectName}`,
    },
    quality: {
      visualQaEnabled: true,
      reviewer: { command: "claude", providerId: "claude", model: null },
      expectedSharinganRequestedUrl: hasExactSharinganCapture
        ? "https://example.com/checkout"
        : null,
      ignores: [],
    },
    imageGenerationEnabled: false,
  });
}

const snapshotsChecksumPlaceholder = "a".repeat(64);

function request(): GenerationTaskContextRequest {
  const value = {
    projectId: PROJECT_ID,
    planId: "plan-1",
    task: {
      id: "task-page",
      planId: "plan-1",
      workspaceId: WORKSPACE_ID,
      kind: "page",
      target: {
        type: "artifact",
        workspaceId: WORKSPACE_ID,
        id: TARGET_ARTIFACT_ID,
        trackId: TARGET_TRACK_ID,
      },
      payload: {
        version: 2,
        artifactPlan: {
          operation: "create",
          nodeId: "node-page",
          artifactId: TARGET_ARTIFACT_ID,
          kind: "page",
          name: "Checkout",
          trackId: TARGET_TRACK_ID,
          baseRevisionId: null,
          dependsOnArtifactIds: ["artifact-component"],
          capabilityIds: ["browser", "visual"],
          responsiveFrameIds: ["desktop"],
        },
        dependencyPlans: [],
        responsiveFrames: [{ id: "desktop", name: "Desktop", width: 1440, height: 900 }],
        brief: {
          proposalRationale: "Create a precise checkout flow",
          assumptions: ["Desktop first"],
          targetInstructions: { operation: "create", kind: "page", name: "Checkout" },
        },
        capabilityDescriptors: [
          { id: "browser", kind: "browser", required: true },
          { id: "visual", kind: "visual-qa", required: true },
        ],
      },
      capabilities: ["browser", "visual"],
      qaProfile: {
        requiredFrameIds: ["desktop"],
        blockingSeverities: ["P0", "P1"],
        requireRuntimeChecks: true,
        requireVisualReview: true,
      },
      resourceLimits: {
        timeoutMs: 60_000,
        maxAgentTurns: 3,
        maxRepairRounds: 2,
        maxOutputBytes: 4 * 1024 * 1024,
        capacityClasses: ["agent", "render-qa"],
      },
    },
    observation: {
      taskId: "task-page",
      planId: "plan-1",
      workspaceId: WORKSPACE_ID,
      attempt: 1,
      target: {
        type: "artifact",
        workspaceId: WORKSPACE_ID,
        id: TARGET_ARTIFACT_ID,
        trackId: TARGET_TRACK_ID,
      },
      baseRevisionId: null,
      expectedSnapshotId: "snapshot-1",
      kernelRevisionId: KERNEL_REVISION_ID,
      payload: {},
      dependencyOutputs: [],
      resourcePins: [
        { resourceId: "resource-moodboard", revisionId: "revision-moodboard", sourceTaskId: null },
        { resourceId: "resource-research", revisionId: "revision-research", sourceTaskId: null },
        { resourceId: "resource-capture", revisionId: "revision-capture", sourceTaskId: null },
      ],
      componentPins: [{
        instanceId: "instance-header",
        ownerArtifactId: TARGET_ARTIFACT_ID,
        componentArtifactId: "artifact-component",
        revisionId: "revision-component",
        sourceTaskId: null,
        variantKey: null,
        stateKey: null,
        sourceLocator: { designNodeId: "header" },
        overrides: {},
        status: "linked",
      }],
    },
  } as unknown as GenerationTaskContextRequest;
  value.observation.payload = value.task.payload;
  return value;
}

test("production Context resolution freezes Task Snapshot pins including Research, Moodboard, Sharingan, and prototype neighbors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dezin-production-context-"));
  const resourceRoot = join(root, "resources");
  const sourceRoot = join(root, "source");
  await Promise.all([mkdir(resourceRoot), mkdir(sourceRoot)]);
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(join(sourceRoot, "research.md"), "Users compare delivery dates before payment.\n", "utf8");
  await writeFile(
    join(sourceRoot, "capture.json"),
    JSON.stringify({ requestedSourceUrl: "https://example.com/checkout", pages: [{ id: "desktop" }] }),
    "utf8",
  );

  const snapshots = new Map<string, ResourceRevisionSnapshot>();
  snapshots.set("revision-moodboard", await resourceAdapters.require("moodboard").snapshot({
    workspaceId: WORKSPACE_ID,
    resourceId: "resource-moodboard",
    revisionId: "revision-moodboard",
    kind: "moodboard",
    workspaceRoot: sourceRoot,
    snapshotRoot: resourceRoot,
    source: {
      type: "moodboard-bundle",
      board: { id: "board-1", name: "Checkout direction" },
      nodes: [],
      messages: [],
      assets: [],
    },
    provenance: { source: "fixture" },
    createdAt: 10,
  }));
  snapshots.set("revision-research", await resourceAdapters.require("research").snapshot({
    workspaceId: WORKSPACE_ID,
    resourceId: "resource-research",
    revisionId: "revision-research",
    kind: "research",
    workspaceRoot: sourceRoot,
    snapshotRoot: resourceRoot,
    source: { type: "owned-file", path: "research.md", mimeType: "text/markdown" },
    provenance: { source: "fixture" },
    createdAt: 11,
  }));
  snapshots.set("revision-dispatch-extra", await resourceAdapters.require("research").snapshot({
    workspaceId: WORKSPACE_ID,
    resourceId: "resource-dispatch-extra",
    revisionId: "revision-dispatch-extra",
    kind: "research",
    workspaceRoot: sourceRoot,
    snapshotRoot: resourceRoot,
    source: { type: "owned-file", path: "research.md", mimeType: "text/markdown" },
    provenance: { source: "dispatch-fixture" },
    createdAt: 13,
  }));
  snapshots.set("revision-capture", await resourceAdapters.require("sharingan-capture").snapshot({
    workspaceId: WORKSPACE_ID,
    resourceId: "resource-capture",
    revisionId: "revision-capture",
    kind: "sharingan-capture",
    workspaceRoot: sourceRoot,
    snapshotRoot: resourceRoot,
    source: { type: "owned-file", path: "capture.json", mimeType: "application/json" },
    provenance: { source: "fixture" },
    createdAt: 12,
  }));

  const artifactChecksums = new Map([
    ["revision-component", checksumBytes("component-context")],
    ["revision-neighbor", checksumBytes("neighbor-context")],
  ]);
  const artifactRevisions = new Map([
    ["revision-component", {
      id: "revision-component",
      workspaceId: WORKSPACE_ID,
      artifactId: "artifact-component",
      trackId: "track-component",
      sequence: 1,
      parentRevisionId: null,
      sourceCommitHash: "a".repeat(40),
      sourceTreeHash: "b".repeat(40),
      artifactRoot: "workspaces/component",
      kernelRevisionId: KERNEL_REVISION_ID,
      renderSpec: {},
      quality: {},
      contextPackHash: null,
      producedByRunId: null,
      legacyRunId: null,
      createdAt: 20,
    }],
    ["revision-neighbor", {
      id: "revision-neighbor",
      workspaceId: WORKSPACE_ID,
      artifactId: "artifact-confirmation",
      trackId: "track-confirmation",
      sequence: 1,
      parentRevisionId: null,
      sourceCommitHash: "c".repeat(40),
      sourceTreeHash: "d".repeat(40),
      artifactRoot: "workspaces/confirmation",
      kernelRevisionId: KERNEL_REVISION_ID,
      renderSpec: {},
      quality: {},
      contextPackHash: null,
      producedByRunId: null,
      legacyRunId: null,
      createdAt: 21,
    }],
  ]);
  const resources = new Map<string, "moodboard" | "research" | "sharingan-capture">([
    ["resource-moodboard", "moodboard"],
    ["resource-research", "research"],
    ["resource-capture", "sharingan-capture"],
    ["resource-dispatch-extra", "research"],
  ]);
  const exactGraph: WorkspaceGraph = {
    workspaceId: WORKSPACE_ID,
    revision: 7,
    nodes: [
      { id: "node-page", workspaceId: WORKSPACE_ID, kind: "page", name: "Checkout", artifactId: TARGET_ARTIFACT_ID },
      { id: "node-confirmation", workspaceId: WORKSPACE_ID, kind: "page", name: "Confirmation", artifactId: "artifact-confirmation" },
    ],
    edges: [{
      id: "edge-confirmation",
      workspaceId: WORKSPACE_ID,
      sourceNodeId: "node-page",
      targetNodeId: "node-confirmation",
      kind: "prototype",
      prototype: { status: "planned" },
    }],
  };
  const snapshot: WorkspaceSnapshot = {
    id: "snapshot-1",
    workspaceId: WORKSPACE_ID,
    sequence: 1,
    parentSnapshotId: null,
    graphRevision: 7,
    kernelRevisionId: KERNEL_REVISION_ID,
    reason: "proposal-approval",
    provenance: { kind: "proposal-approval", proposalId: "proposal-1", proposalRevision: 1 },
    createdByRunId: null,
    createdAt: 30,
    graph: exactGraph,
    artifactTracks: {
      [TARGET_ARTIFACT_ID]: TARGET_TRACK_ID,
      "artifact-confirmation": "track-confirmation",
      "artifact-component": "track-component",
    },
    artifactRevisions: {
      [TARGET_ARTIFACT_ID]: null,
      "artifact-confirmation": "revision-neighbor",
      "artifact-component": "revision-component",
    },
    resourceRevisions: {
      "resource-moodboard": "revision-moodboard",
      "resource-research": "revision-research",
      "resource-capture": "revision-capture",
    },
  };
  const availableSnapshots: WorkspaceSnapshot[] = [snapshot];
  const graphByRevision = new Map<number, WorkspaceGraph>([[exactGraph.revision, exactGraph]]);
  const graphReads: number[] = [];
  const workspace = {
    getWorkspace: () => ({
      id: WORKSPACE_ID,
      projectId: PROJECT_ID,
      graphRevision: 999,
      activeSnapshotId: "live-snapshot-must-not-be-read",
      activeKernelRevisionId: "live-kernel-must-not-be-read",
    }),
    getSnapshotForProject: (_projectId: string, snapshotId: string) => (
      availableSnapshots.find((candidate) => candidate.id === snapshotId) ?? null
    ),
    listSnapshots: () => assert.fail("Generation Context must read one exact Snapshot"),
    getGraphRevision: (_projectId: string, revision: number) => {
      graphReads.push(revision);
      const graph = graphByRevision.get(revision);
      if (!graph) throw new Error(`missing graph Revision ${revision}`);
      return graph;
    },
    getKernelRevision: (id: string) => id === KERNEL_REVISION_ID ? {
      id,
      workspaceId: WORKSPACE_ID,
      sequence: 1,
      parentRevisionId: null,
      tokens: { color: "#111111" },
      typography: { family: "Inter" },
      sharedAssetRevisionIds: [],
      brief: "Clear, calm, precise",
      terminology: {},
      exclusions: ["generic dashboard cards"],
      responsiveFrames: [{ id: "desktop", name: "Desktop", width: 1440, height: 900 }],
      qualityProfile: {
        requiredFrameIds: ["desktop"],
        blockingSeverities: ["P0", "P1"],
        requireRuntimeChecks: true,
        requireVisualReview: true,
      },
      checksum: KERNEL_CHECKSUM,
      createdAt: 1,
    } : null,
    getArtifact: (id: string) => ({
      id,
      workspaceId: WORKSPACE_ID,
      kind: id === "artifact-component" ? "component" : "page",
      name: id,
      sourceRoot: `workspaces/${id}`,
      legacyWrapped: false,
      activeTrackId: id === TARGET_ARTIFACT_ID ? TARGET_TRACK_ID : `track-${id}`,
      archivedAt: null,
      createdAt: 1,
      updatedAt: 1,
    }),
    getArtifactRevision: (id: string) => artifactRevisions.get(id) ?? null,
    getArtifactRevisionContextChecksum: (id: string) => artifactChecksums.get(id) ?? null,
    listArtifactRevisionDependencies: () => [],
    listArtifactRevisionResourcePins: () => [],
    getResourceForProject: (_projectId: string, id: string) => {
      const kind = resources.get(id);
      return kind ? {
        id,
        workspaceId: WORKSPACE_ID,
        kind,
        title: id,
        headRevisionId: snapshot.resourceRevisions[id] ?? null,
        defaultPinPolicy: "pin-current",
        archivedAt: null,
        createdAt: 1,
        updatedAt: 1,
      } : null;
    },
    getResourceRevisionForProject: (_projectId: string, resourceId: string, revisionId: string) => {
      const exact = snapshots.get(revisionId);
      return exact?.resourceId === resourceId ? {
        id: revisionId,
        workspaceId: WORKSPACE_ID,
        resourceId,
        sequence: 1,
        parentRevisionId: null,
        manifestPath: exact.manifestPath,
        summary: resourceId,
        metadata: { mimeType: exact.mimeType },
        checksum: exact.checksum,
        provenance: exact.provenance,
        createdByRunId: null,
        createdAt: exact.createdAt,
      } : null;
    },
  } as unknown as GenerationContextWorkspacePort;
  const repository = new MemoryContextPackRepository();
  const packStore = new ContextPackStore({
    manifestRoot: join(root, "context-packs"),
    repository,
    now: () => 40,
  });
  const dispatchMessage = "Create a precise checkout flow";
  const dispatchKernelContent = stableStringify({
    protocol: "dezin.workspace-agent-kernel.v1",
    revisionId: KERNEL_REVISION_ID,
  });
  const dispatchTargetContent = stableStringify({
    protocol: "dezin.workspace-agent-artifact-revision.v1",
    artifactId: TARGET_ARTIFACT_ID,
    revisionId: "revision-target-base",
  });
  const dispatchSelectionContent = stableStringify({
    protocol: "dezin.workspace-agent-element-selection.v1",
    artifactId: TARGET_ARTIFACT_ID,
    artifactRevisionId: "revision-target-base",
    designNodeId: "cta-button",
  });
  const dispatchExplicitContent = stableStringify({
    protocol: "dezin.workspace-agent-resource-selection.v1",
    resourceId: "resource-dispatch-extra",
    revisionId: "revision-dispatch-extra",
  });
  const dispatchItems = [
    {
      ordinal: 0,
      contextClass: "system-kernel" as const,
      ref: { kind: "kernel" as const, id: KERNEL_REVISION_ID, revisionId: KERNEL_REVISION_ID },
      resolvedKind: "kernel-revision" as const,
      content: dispatchKernelContent,
      checksum: KERNEL_CHECKSUM,
      reason: "exact immutable Shared Design Kernel Revision",
      trustLevel: "system" as const,
      capabilities: [],
      boundary: { source: `kernel-revision:${KERNEL_REVISION_ID}`, readOnly: true as const, mayGrantCapabilities: false as const },
      tokenEstimate: estimateContextTokens(dispatchKernelContent),
      provenance: { workspaceId: WORKSPACE_ID, kernelRevisionId: KERNEL_REVISION_ID },
      provided: true as const,
    },
    {
      ordinal: 1,
      contextClass: "target" as const,
      ref: { kind: "artifact" as const, id: TARGET_ARTIFACT_ID, revisionId: "revision-target-base" },
      resolvedKind: "artifact-revision" as const,
      content: dispatchTargetContent,
      checksum: checksumBytes(dispatchTargetContent),
      reason: "exact scoped Artifact Revision",
      trustLevel: "trusted" as const,
      capabilities: [],
      boundary: { source: "artifact-revision:revision-target-base", readOnly: true as const, mayGrantCapabilities: false as const },
      tokenEstimate: estimateContextTokens(dispatchTargetContent),
      provenance: {
        workspaceId: WORKSPACE_ID,
        graphRevision: 7,
        snapshotId: "snapshot-1",
        layoutId: "default",
        layoutChecksum: "2".repeat(64),
      },
      provided: true as const,
    },
    {
      ordinal: 2,
      contextClass: "selection" as const,
      ref: { kind: "inline" as const, id: "cta-button" },
      resolvedKind: "inline" as const,
      content: dispatchSelectionContent,
      checksum: checksumBytes(dispatchSelectionContent),
      reason: "exact selected design element",
      trustLevel: "trusted" as const,
      capabilities: [],
      boundary: { source: "artifact-element:revision-target-base:cta-button", readOnly: true as const, mayGrantCapabilities: false as const },
      tokenEstimate: estimateContextTokens(dispatchSelectionContent),
      provenance: {
        workspaceId: WORKSPACE_ID,
        artifactId: TARGET_ARTIFACT_ID,
        artifactRevisionId: "revision-target-base",
        designNodeId: "cta-button",
      },
      provided: true as const,
    },
    {
      ordinal: 3,
      contextClass: "explicit" as const,
      ref: {
        kind: "resource" as const,
        id: "resource-dispatch-extra",
        resourceKind: "research" as const,
        revisionId: "revision-dispatch-extra",
      },
      resolvedKind: "resource-revision" as const,
      content: dispatchExplicitContent,
      checksum: snapshots.get("revision-dispatch-extra")!.checksum,
      reason: "exact extra dispatch Resource Revision",
      trustLevel: "untrusted" as const,
      capabilities: [],
      boundary: { source: "resource-revision:revision-dispatch-extra", readOnly: true as const, mayGrantCapabilities: false as const },
      tokenEstimate: estimateContextTokens(dispatchExplicitContent),
      provenance: {
        workspaceId: WORKSPACE_ID,
        resourceId: "resource-dispatch-extra",
        resourceRevisionId: "revision-dispatch-extra",
      },
      provided: true as const,
    },
  ];
  const dispatchPack = packStore.persist({
    workspaceId: WORKSPACE_ID,
    graphRevision: 7,
    target: { type: "artifact", id: TARGET_ARTIFACT_ID },
    intent: "edit",
    messageChecksum: checksumBytes(dispatchMessage),
    items: dispatchItems,
    omissions: [],
    tokenEstimate: dispatchItems.reduce((total, item) => total + item.tokenEstimate, 0),
  });
  let frozenExecution = executionProfile("Frozen checkout", true);
  const module = await import("../src/orchestration/production-generation-context.ts");
  const resolver = new module.ProductionGenerationTaskContextResolver({
    workspace,
    packStore,
    resourceStorageRoot: resourceRoot,
    dispatchContextPacks: repository,
    loadResourceSnapshot: async ({ revisionId }: { revisionId: string }) => snapshots.get(revisionId) ?? null,
    loadArtifactExecutionProfile: async () => frozenExecution,
  });

  const dispatchedRequest = request();
  (dispatchedRequest.task.payload.artifactPlan as Record<string, unknown>).dispatchContextPackId = dispatchPack.id;
  dispatchedRequest.observation.payload = dispatchedRequest.task.payload;
  const first = await resolver.resolve(dispatchedRequest, new AbortController().signal);
  const replay = await resolver.resolve(dispatchedRequest, new AbortController().signal);
  frozenExecution = executionProfile("Mutated checkout", true);
  const rematerialized = await resolver.resolve(dispatchedRequest, new AbortController().signal);

  assert.equal(first.id, replay.id, "same immutable Task facts deduplicate to one Context Pack");
  assert.deepEqual(graphReads, [7, 7, 7], "resolution reads the frozen graph revision, never the live head");
  assert.notEqual(rematerialized.hash, first.hash, "execution semantic drift creates a new immutable Context Pack");
  assert.equal(first.graphRevision, 7);
  assert.deepEqual(first.target, { type: "artifact", id: TARGET_ARTIFACT_ID });
  assert.ok(first.items.some((item) => item.contextClass === "system-kernel"
    && item.ref.kind === "kernel" && item.ref.revisionId === KERNEL_REVISION_ID
    && item.checksum === KERNEL_CHECKSUM));
  assert.ok(first.items.some((item) => item.contextClass === "target"
    && item.ref.kind === "inline" && item.ref.id === TARGET_ARTIFACT_ID
    && item.content.includes("Create a precise checkout flow")
    && item.content.includes("dezin.artifact-execution-profile.v4")
    && item.content.includes(frozenExecution.prompt.rendererProtocol)));
  assert.ok(!first.items.some((item) => item.content.includes("must-not-persist")));
  for (const [resourceId, revisionId, kind] of [
    ["resource-moodboard", "revision-moodboard", "moodboard"],
    ["resource-research", "revision-research", "research"],
    ["resource-capture", "revision-capture", "sharingan-capture"],
  ] as const) {
    assert.ok(first.items.some((item) => item.contextClass === "explicit"
      && item.ref.kind === "resource" && item.ref.id === resourceId
      && item.ref.resourceKind === kind && item.ref.revisionId === revisionId
      && item.trustLevel === "untrusted" && item.boundary.mayGrantCapabilities === false));
  }
  assert.ok(first.items.some((item) => item.contextClass === "explicit"
    && item.ref.kind === "artifact" && item.ref.id === "artifact-component"
    && item.ref.revisionId === "revision-component"));
  assert.ok(first.items.some((item) => item.contextClass === "prototype-neighbor"
    && item.ref.kind === "artifact" && item.ref.id === "artifact-confirmation"
    && item.ref.revisionId === "revision-neighbor"));
  const dispatchEvidence = first.items.filter((item) => item.contextClass === "selection"
    || (item.contextClass === "explicit" && item.ref.id === "resource-dispatch-extra"));
  assert.equal(dispatchEvidence.length, 2);
  for (const expected of dispatchItems.filter((item) => item.contextClass === "selection"
    || item.contextClass === "explicit")) {
    const actual = dispatchEvidence.find((item) => item.contextClass === expected.contextClass
      && item.ref.id === expected.ref.id);
    assert.ok(actual);
    assert.equal(actual.content, expected.content);
    assert.equal(actual.checksum, expected.checksum);
    assert.equal(actual.trustLevel, expected.trustLevel);
    assert.deepEqual(actual.boundary, expected.boundary);
    assert.deepEqual(actual.provenance, expected.provenance);
  }

  const missingDispatch = structuredClone(dispatchedRequest);
  (missingDispatch.task.payload.artifactPlan as Record<string, unknown>).dispatchContextPackId =
    `context-pack-${"f".repeat(64)}`;
  missingDispatch.observation.payload = missingDispatch.task.payload;
  await assert.rejects(
    () => resolver.resolve(missingDispatch, new AbortController().signal),
    /dispatch Context Pack is missing|hash-substituted/i,
  );

  const foreignDispatchPack = packStore.persist({
    workspaceId: "workspace-foreign",
    graphRevision: 7,
    target: { type: "artifact", id: TARGET_ARTIFACT_ID },
    intent: "edit",
    messageChecksum: checksumBytes(dispatchMessage),
    items: dispatchItems,
    omissions: [],
    tokenEstimate: dispatchItems.reduce((total, item) => total + item.tokenEstimate, 0),
  });
  const foreignDispatch = structuredClone(dispatchedRequest);
  (foreignDispatch.task.payload.artifactPlan as Record<string, unknown>).dispatchContextPackId =
    foreignDispatchPack.id;
  foreignDispatch.observation.payload = foreignDispatch.task.payload;
  await assert.rejects(
    () => resolver.resolve(foreignDispatch, new AbortController().signal),
    /dispatch Context Pack is missing|hash-substituted/i,
  );

  const substitutedTargetPack = packStore.persist({
    workspaceId: WORKSPACE_ID,
    graphRevision: 7,
    target: { type: "artifact", id: "artifact-substituted" },
    intent: "edit",
    messageChecksum: checksumBytes(dispatchMessage),
    items: dispatchItems.map((item) => item.contextClass === "target"
      ? { ...item, ref: { ...item.ref, id: "artifact-substituted" } }
      : item),
    omissions: [],
    tokenEstimate: dispatchItems.reduce((total, item) => total + item.tokenEstimate, 0),
  });
  const substitutedTarget = structuredClone(dispatchedRequest);
  (substitutedTarget.task.payload.artifactPlan as Record<string, unknown>).dispatchContextPackId =
    substitutedTargetPack.id;
  substitutedTarget.observation.payload = substitutedTarget.task.payload;
  await assert.rejects(
    () => resolver.resolve(substitutedTarget, new AbortController().signal),
    /owner, target, intent, or message lineage/i,
  );

  repository.packs.set(dispatchPack.id, {
    ...structuredClone(dispatchPack),
    items: dispatchPack.items.map((item) => item.contextClass === "selection"
      ? { ...structuredClone(item), content: `${item.content}\nsubstituted` }
      : structuredClone(item)),
  });
  await assert.rejects(
    () => resolver.resolve(dispatchedRequest, new AbortController().signal),
    /dispatch Context Pack is missing|hash-substituted/i,
  );
  repository.packs.set(dispatchPack.id, dispatchPack);

  const wrongMessage = structuredClone(dispatchedRequest);
  (wrongMessage.task.payload.brief as Record<string, unknown>).proposalRationale = "Substituted message";
  wrongMessage.observation.payload = wrongMessage.task.payload;
  await assert.rejects(
    () => resolver.resolve(wrongMessage, new AbortController().signal),
    /message lineage/i,
  );

  const planIntentPack = packStore.persist({
    workspaceId: WORKSPACE_ID,
    graphRevision: 7,
    target: { type: "artifact", id: TARGET_ARTIFACT_ID },
    intent: "plan",
    messageChecksum: checksumBytes(dispatchMessage),
    items: dispatchItems,
    omissions: [],
    tokenEstimate: dispatchItems.reduce((total, item) => total + item.tokenEstimate, 0),
  });
  const wrongIntent = structuredClone(dispatchedRequest);
  (wrongIntent.task.payload.artifactPlan as Record<string, unknown>).dispatchContextPackId = planIntentPack.id;
  wrongIntent.observation.payload = wrongIntent.task.payload;
  await assert.rejects(
    () => resolver.resolve(wrongIntent, new AbortController().signal),
    /intent.*lineage/i,
  );

  const latestGraph: WorkspaceGraph = { ...exactGraph, revision: 8 };
  const latestSnapshot: WorkspaceSnapshot = {
    ...snapshot,
    id: "snapshot-2",
    sequence: 2,
    parentSnapshotId: snapshot.id,
    graphRevision: latestGraph.revision,
    reason: "graph-command",
    provenance: { kind: "graph-command", commandIds: ["latest-context-test"] },
    graph: latestGraph,
  };
  graphByRevision.set(latestGraph.revision, latestGraph);
  availableSnapshots.push(latestSnapshot);
  const latestRequest = structuredClone(dispatchedRequest);
  latestRequest.task.currentAttempt = 1;
  latestRequest.task.pendingContextPolicy = "latest-context";
  latestRequest.observation.attempt = 2;
  latestRequest.observation.expectedSnapshotId = latestSnapshot.id;
  const latestPack = await resolver.resolve(latestRequest, new AbortController().signal);
  assert.equal(latestPack.graphRevision, latestGraph.revision);
  assert.equal(latestPack.items.find((item) => item.contextClass === "selection")?.content, dispatchSelectionContent);
  assert.equal(
    latestPack.items.find((item) => item.contextClass === "explicit"
      && item.ref.id === "resource-dispatch-extra")?.content,
    dispatchExplicitContent,
  );
  assert.deepEqual(graphReads, [7, 7, 7, 7, 7, 7, 7, 7, 7, 8]);

  const resourceTask = structuredClone(request()) as any;
  resourceTask.task = {
    ...resourceTask.task,
    id: "task-resource",
    kind: "resource",
    target: { type: "resource", workspaceId: WORKSPACE_ID, id: "resource-research" },
    payload: {
      version: 2,
      operation: {
        operation: "revise", nodeId: "node-research", resourceId: "resource-research",
        kind: "research", title: "Decision research", revisionPolicy: { kind: "generate" },
      },
      brief: {
        proposalRationale: "Refresh the exact evidence.", assumptions: [],
        targetInstructions: { operation: "revise", kind: "research", title: "Decision research" },
      },
      capabilityDescriptors: [],
      adapter: { id: "dezin.resource-adapter.research", version: 1, kind: "research" },
    },
    capabilities: [],
  };
  resourceTask.observation = {
    ...resourceTask.observation,
    taskId: "task-resource",
    target: resourceTask.task.target,
    payload: resourceTask.task.payload,
    baseRevisionId: "revision-research",
    resourcePins: [],
    componentPins: [],
  };
  let resourceModel = "gpt-5.4";
  const resourceResolver = new module.ProductionGenerationTaskContextResolver({
    workspace,
    packStore,
    resourceStorageRoot: resourceRoot,
    loadResourceSnapshot: async ({ revisionId }: { revisionId: string }) => snapshots.get(revisionId) ?? null,
    loadResourceExecutionProfile: async () => freezeResourceExecutionProfile({
      ownership: {
        projectId: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        planId: "plan-1",
        taskId: "task-resource",
        targetResourceId: "resource-research",
      },
      resourceKind: "research",
      adapter: { id: "dezin.resource-adapter.research", version: 1, kind: "research" },
      settings: { ...executionProfile("unused").settings.value, model: resourceModel, apiKey: "resource-secret" },
    }),
  });
  const resourceFirst = await resourceResolver.resolve(resourceTask, new AbortController().signal);
  resourceModel = "gpt-5.5";
  const resourceRematerialized = await resourceResolver.resolve(resourceTask, new AbortController().signal);
  assert.notEqual(resourceFirst.hash, resourceRematerialized.hash);
  assert.ok(resourceFirst.items.some((item) => item.contextClass === "target"
    && item.content.includes("dezin.resource-execution-profile.v3")
    && item.content.includes("dezin.research-generation-prompt.v3")));
  assert.ok(!resourceFirst.items.some((item) => item.content.includes("resource-secret")));
});
