import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ScopedAgentTurnConflictError,
  Store,
} from "../../../packages/core/src/index.ts";
import { getProvider } from "../../../packages/agent/src/index.ts";
import { DesignRegistry } from "../../../packages/design/src/index.ts";
import {
  ContextPackStore,
  createWorkspaceContextPackRepository,
} from "../src/context/context-pack-store.ts";
import { resourceAdapters } from "../src/context/adapters/index.ts";
import {
  checksumBytes,
  estimateContextTokens,
  stableStringify,
  type AgentTurnRequest,
  type ContextPack,
} from "../src/context/context-types.ts";
import { createProductionScopedAgentTaskQueue } from "../src/orchestration/production-scoped-agent-task-queue.ts";
import { GenerationPlanService } from "../src/orchestration/generation-plan-service.ts";
import {
  ProductionGenerationTaskContextResolver,
  freezeArtifactExecutionProfile,
} from "../src/orchestration/production-generation-context.ts";
import { createProductionWorkspaceAgentOrchestrator } from "../src/orchestration/production-workspace-agent.ts";
import { reviewerAgentCommand, reviewerModel } from "../src/run-policy.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dezin-scoped-agent-queue-"));
  const store = new Store(join(root, "store.db"));
  const project = store.createProject({ name: "Scoped Agent queue", mode: "standard" });
  const initial = store.workspace.ensureWorkspaceRecord(project.id);
  const mutation = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: initial.graphRevision,
    expectedSnapshotId: initial.activeSnapshotId,
    commands: [
      {
        id: "add-scoped-page",
        type: "add-node",
        node: {
          id: "scoped-page-node",
          kind: "page",
          name: "Checkout",
          artifactId: "scoped-page",
          createIdentity: { initialTrackId: "scoped-page-track" },
        },
      },
      {
        id: "add-scoped-research",
        type: "add-node",
        node: {
          id: "scoped-research-node",
          kind: "resource",
          name: "Checkout research",
          resourceId: "scoped-research",
          createIdentity: { resourceKind: "research", defaultPinPolicy: "pin-current" },
        },
      },
      {
        id: "add-scoped-file",
        type: "add-node",
        node: {
          id: "scoped-file-node",
          kind: "resource",
          name: "Imported brief",
          resourceId: "scoped-file",
          createIdentity: { resourceKind: "file", defaultPinPolicy: "pin-current" },
        },
      },
      {
        id: "add-empty-page",
        type: "add-node",
        node: {
          id: "empty-page-node",
          kind: "page",
          name: "Unreviewed page",
          artifactId: "empty-page",
          createIdentity: { initialTrackId: "empty-page-track" },
        },
      },
      {
        id: "add-empty-research",
        type: "add-node",
        node: {
          id: "empty-research-node",
          kind: "resource",
          name: "Unreviewed research",
          resourceId: "empty-research",
          createIdentity: { resourceKind: "research", defaultPinPolicy: "pin-current" },
        },
      },
    ],
  });
  const pageRevision = store.workspace.createArtifactRevision({
    artifactId: "scoped-page",
    trackId: "scoped-page-track",
    parentRevisionId: null,
    sourceCommitHash: "1".repeat(40),
    sourceTreeHash: "2".repeat(40),
    kernelRevisionId: initial.activeKernelRevisionId,
    renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
    quality: { state: "passed", score: 100, findings: [] },
    contextPackHash: null,
    dependencies: [],
    resourcePins: [],
  });
  const pageSnapshot = store.workspace.publishArtifactRevision(pageRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: mutation.snapshot.id,
  });
  const sourceRoot = join(root, "source");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(sourceRoot, "research.md"), "Checkout evidence from an exact source.\n", "utf8");
  const researchPayload = await resourceAdapters.require("research").snapshot({
    workspaceId: initial.id,
    resourceId: "scoped-research",
    revisionId: "scoped-research-revision-base",
    kind: "research",
    workspaceRoot: sourceRoot,
    snapshotRoot: root,
    source: { type: "owned-file", path: "research.md", mimeType: "text/markdown" },
    provenance: { source: "production-scoped-agent-task-queue-test" },
    createdAt: 20,
  });
  const researchRevision = store.workspace.createResourceRevisionCandidateForProject(
    project.id,
    "scoped-research",
    {
      revisionId: "scoped-research-revision-base",
      parentRevisionId: null,
      manifestPath: researchPayload.manifestPath,
      summary: "Initial checkout research",
      metadata: {
        fixture: "production-scoped-agent-task-queue",
        mimeType: researchPayload.mimeType,
        byteLength: researchPayload.byteSize,
        payloadChecksum: researchPayload.payloadChecksum,
      },
      checksum: researchPayload.checksum,
      provenance: researchPayload.provenance,
    },
  );
  store.workspace.publishResourceRevisionForProject(
    project.id,
    "scoped-research",
    researchRevision.id,
    {
      expectedHeadRevisionId: null,
      expectedSnapshotId: pageSnapshot.id,
      reason: "Seed scoped Research target",
    },
  );
  const workspace = store.workspace.getWorkspace(project.id)!;
  const wakes: string[] = [];
  const queue = createProductionScopedAgentTaskQueue({
    store,
    planService: {
      compileAndEnqueueApprovedShell(planId) {
        return store.workspace.compileApprovedGenerationPlanForProject(project.id, planId).plan;
      },
    },
    wakePlan(planId) {
      wakes.push(planId);
    },
  });
  return {
    root,
    store,
    project,
    workspace,
    queue,
    wakes,
    pageRevision,
    researchRevision,
    async close() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function request(input: {
  workspaceId: string;
  graphRevision: number;
  type: "artifact" | "resource";
  id: string;
  intent?: "generate" | "edit" | "repair";
  baseRevisionId?: string;
}): AgentTurnRequest {
  const turnSuffix = createHash("sha256")
    .update(`${input.type}:${input.id}:${input.intent ?? "edit"}:${input.baseRevisionId ?? "none"}`)
    .digest("hex")
    .slice(0, 12);
  return {
    scope: { type: input.type, id: input.id, workspaceId: input.workspaceId },
    intent: input.intent ?? "edit",
    message: `Improve ${input.id} while preserving the shared design system.`,
    explicitContext: [],
    graphRevision: input.graphRevision,
    turnId: `turn-00000000-0000-4000-8000-${turnSuffix}`,
    ...(input.baseRevisionId === undefined ? {} : { baseRevisionId: input.baseRevisionId }),
  };
}

function pack(
  turn: AgentTurnRequest,
  anchor: { snapshotId: string; layoutId: string; layoutChecksum: string },
): ContextPack {
  const content = stableStringify({ target: turn.scope, anchor });
  const item = {
    ordinal: 0,
    contextClass: "target" as const,
    ref: { kind: "inline" as const, id: turn.scope.id },
    resolvedKind: "inline" as const,
    content,
    checksum: checksumBytes(content),
    reason: "exact scoped target",
    trustLevel: "trusted" as const,
    capabilities: [],
    boundary: {
      source: `generation-task:scoped-${turn.scope.type}:${turn.scope.id}`,
      readOnly: true as const,
      mayGrantCapabilities: false as const,
    },
    tokenEstimate: estimateContextTokens(content),
    provenance: {
      workspaceId: turn.scope.workspaceId,
      graphRevision: turn.graphRevision,
      ...anchor,
    },
    provided: true as const,
  };
  const body = {
    protocol: "dezin-context-pack-v1" as const,
    workspaceId: turn.scope.workspaceId,
    graphRevision: turn.graphRevision,
    target: { type: turn.scope.type, id: turn.scope.id },
    intent: turn.intent,
    messageChecksum: checksumBytes(turn.message),
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

function persistPack(
  f: Awaited<ReturnType<typeof fixture>>,
  turn: AgentTurnRequest,
  anchor: { snapshotId: string; layoutId: string; layoutChecksum: string },
): ContextPack {
  const candidate = pack(turn, anchor);
  f.store.workspace.persistContextPack({
    id: candidate.id,
    workspaceId: candidate.workspaceId,
    graphRevision: candidate.graphRevision,
    target: candidate.target,
    intent: candidate.intent,
    messageChecksum: candidate.messageChecksum,
    items: candidate.items.map((item) => ({
      ref: item.ref,
      resolvedKind: item.resolvedKind,
      artifactRevisionId: null,
      resourceRevisionId: null,
      kernelRevisionId: null,
      checksum: item.checksum,
      reason: item.reason,
      trustLevel: item.trustLevel,
      boundary: { ...item.boundary },
      tokenEstimate: item.tokenEstimate,
      provenance: item.provenance,
      provided: item.provided,
    })),
    omissions: candidate.omissions.map((item) => ({
      ref: item.ref,
      reason: item.reason,
      tokenEstimate: item.tokenEstimate,
    })),
    tokenEstimate: candidate.tokenEstimate,
    manifestPath: candidate.manifestPath,
    hash: candidate.hash,
  });
  return candidate;
}

test("scoped Page Agent compiles exactly one target-owned immutable leaf and wakes its Plan", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const layout = f.store.workspace.getLayout(f.project.id);
  const turn = request({
    workspaceId: f.workspace.id,
    graphRevision: f.workspace.graphRevision,
    type: "artifact",
    id: "scoped-page",
    intent: "edit",
    baseRevisionId: f.pageRevision.id,
  });
  const contextPack = persistPack(f, turn, {
    snapshotId: f.workspace.activeSnapshotId,
    layoutId: layout.layoutId,
    layoutChecksum: layout.checksum,
  });

  const receipt = await f.queue.enqueue({
    projectId: f.project.id,
    request: turn,
    contextPack,
  }, new AbortController().signal);

  assert.equal(receipt.contextPackId, contextPack.id);
  assert.equal(receipt.task.kind, "page");
  assert.deepEqual(receipt.task.target, {
    type: "artifact",
    workspaceId: f.workspace.id,
    id: "scoped-page",
    trackId: "scoped-page-track",
  });
  assert.equal(receipt.task.status, "materialization-pending");
  assert.equal(
    (receipt.task.payload.artifactPlan as Record<string, unknown>).dispatchContextPackId,
    contextPack.id,
  );
  assert.deepEqual(f.wakes, [receipt.task.planId]);
  const detail = f.store.workspace.getGenerationPlanDetailForProject(f.project.id, receipt.task.planId);
  assert.equal(detail.plan.status, "queued");
  assert.equal(detail.plan.constructionSealed, true);
  assert.deepEqual(detail.tasks.map((task) => task.kind), ["page", "prototype-validation", "checkpoint"]);
  const proposal = f.store.workspace.getProposalForProject(f.project.id, detail.plan.proposalId);
  assert.equal(proposal.status, "approved");
  assert.equal(proposal.review.kind, "approved");
  assert.equal(proposal.rationale, turn.message);
  assert.equal(proposal.generation.kind, "workspace-generation");
  if (proposal.generation.kind !== "workspace-generation") assert.fail("expected Workspace generation");
  assert.deepEqual(proposal.generation.artifactPlans.map((plan) => plan.artifactId), ["scoped-page"]);
  assert.equal(proposal.generation.artifactPlans[0]?.dispatchContextPackId, contextPack.id);
});

test("scoped Agent queue replays a lost response after Store reopen without a second Plan or wake", async (t) => {
  const f = await fixture();
  let activeStore = f.store;
  t.after(async () => {
    activeStore.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const layout = f.store.workspace.getLayout(f.project.id);
  const turn = request({
    workspaceId: f.workspace.id,
    graphRevision: f.workspace.graphRevision,
    type: "artifact",
    id: "scoped-page",
    intent: "edit",
    baseRevisionId: f.pageRevision.id,
  });
  const contextPack = persistPack(f, turn, {
    snapshotId: f.workspace.activeSnapshotId,
    layoutId: layout.layoutId,
    layoutChecksum: layout.checksum,
  });

  const first = await f.queue.enqueue({
    projectId: f.project.id,
    request: turn,
    contextPack,
  }, new AbortController().signal);
  assert.deepEqual(f.wakes, [first.task.planId]);
  assert.equal(f.store.workspace.listProposals(f.project.id).length, 1);
  assert.equal(f.store.workspace.listGenerationPlans(f.project.id).length, 1);

  f.store.close();
  activeStore = new Store(join(f.root, "store.db"));
  const restartWakes: string[] = [];
  const restartedQueue = createProductionScopedAgentTaskQueue({
    store: activeStore,
    planService: {
      compileAndEnqueueApprovedShell(planId) {
        return activeStore.workspace.compileApprovedGenerationPlanForProject(f.project.id, planId).plan;
      },
    },
    wakePlan(planId) {
      restartWakes.push(planId);
    },
  });

  const replay = await restartedQueue.replay({
    projectId: f.project.id,
    request: turn,
  }, new AbortController().signal);
  assert.ok(replay);
  assert.equal(replay.task.id, first.task.id);
  assert.equal(replay.contextPackId, first.contextPackId);
  const duplicate = await restartedQueue.enqueue({
    projectId: f.project.id,
    request: turn,
    contextPack,
  }, new AbortController().signal);
  assert.equal(duplicate.task.id, first.task.id);
  assert.equal(duplicate.contextPackId, first.contextPackId);
  assert.deepEqual(restartWakes, []);
  assert.equal(activeStore.workspace.listProposals(f.project.id).length, 1);
  assert.equal(activeStore.workspace.listGenerationPlans(f.project.id).length, 1);

  for (const divergent of [
    { ...turn, message: `${turn.message} Divergent retry.` },
    {
      ...turn,
      selection: [{ kind: "element" as const, id: "different-element", revisionId: f.pageRevision.id }],
    },
    {
      ...turn,
      explicitContext: [{
        kind: "artifact" as const,
        id: "scoped-page",
        revisionId: f.pageRevision.id,
      }],
    },
  ]) {
    await assert.rejects(
      () => restartedQueue.replay({
        projectId: f.project.id,
        request: divergent,
      }, new AbortController().signal),
      (error: unknown) => error instanceof ScopedAgentTurnConflictError
        && error.turnId === turn.turnId,
    );
  }
  assert.deepEqual(restartWakes, []);
  assert.equal(activeStore.workspace.listProposals(f.project.id).length, 1);
  assert.equal(activeStore.workspace.listGenerationPlans(f.project.id).length, 1);
});

test("scoped Resource Agent creates one generated Resource leaf and rejects imported Resource kinds", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const layout = f.store.workspace.getLayout(f.project.id);
  const researchTurn = request({
    workspaceId: f.workspace.id,
    graphRevision: f.workspace.graphRevision,
    type: "resource",
    id: "scoped-research",
    intent: "generate",
    baseRevisionId: f.researchRevision.id,
  });
  const anchor = {
    snapshotId: f.workspace.activeSnapshotId,
    layoutId: layout.layoutId,
    layoutChecksum: layout.checksum,
  };
  const receipt = await f.queue.enqueue({
    projectId: f.project.id,
    request: researchTurn,
    contextPack: persistPack(f, researchTurn, anchor),
  }, new AbortController().signal);
  assert.equal(receipt.task.kind, "resource");
  assert.equal(receipt.task.target.id, "scoped-research");
  assert.equal(
    (receipt.task.payload.operation as Record<string, unknown>).dispatchContextPackId,
    receipt.contextPackId,
  );

  const proposalsBefore = f.store.workspace.listProposals(f.project.id).length;
  const fileTurn = request({
    workspaceId: f.workspace.id,
    graphRevision: f.workspace.graphRevision,
    type: "resource",
    id: "scoped-file",
    intent: "generate",
    baseRevisionId: "unpublished-imported-resource",
  });
  await assert.rejects(
    () => f.queue.enqueue({
      projectId: f.project.id,
      request: fileTurn,
      contextPack: persistPack(f, fileTurn, anchor),
    }, new AbortController().signal),
    /imported immutably|cannot be regenerated/i,
  );
  assert.equal(f.store.workspace.listProposals(f.project.id).length, proposalsBefore);
});

test("scoped Agent queue never silently rebinds a stale Snapshot/layout anchor", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const layout = f.store.workspace.getLayout(f.project.id);
  const turn = request({
    workspaceId: f.workspace.id,
    graphRevision: f.workspace.graphRevision,
    type: "artifact",
    id: "scoped-page",
    baseRevisionId: f.pageRevision.id,
  });
  const stale = persistPack(f, turn, {
    snapshotId: "stale-snapshot",
    layoutId: layout.layoutId,
    layoutChecksum: layout.checksum,
  });
  await assert.rejects(
    () => f.queue.enqueue({ projectId: f.project.id, request: turn, contextPack: stale }, new AbortController().signal),
    /Snapshot or layout changed/i,
  );
  assert.deepEqual(f.store.workspace.listProposals(f.project.id), []);
  assert.deepEqual(f.wakes, []);
});

test("scoped Agent queue preserves pre-dispatch cancellation without durable side effects", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const layout = f.store.workspace.getLayout(f.project.id);
  const turn = request({
    workspaceId: f.workspace.id,
    graphRevision: f.workspace.graphRevision,
    type: "artifact",
    id: "scoped-page",
    baseRevisionId: f.pageRevision.id,
  });
  const controller = new AbortController();
  const reason = new Error("cancel scoped dispatch");
  controller.abort(reason);
  await assert.rejects(
    () => f.queue.enqueue({
      projectId: f.project.id,
      request: turn,
      contextPack: persistPack(f, turn, {
        snapshotId: f.workspace.activeSnapshotId,
        layoutId: layout.layoutId,
        layoutChecksum: layout.checksum,
      }),
    }, controller.signal),
    (error: unknown) => error === reason,
  );
  assert.deepEqual(f.store.workspace.listProposals(f.project.id), []);
  assert.deepEqual(f.wakes, []);
});

test("scoped Agent queue rejects empty targets before creating an internal Proposal or Plan", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const layout = f.store.workspace.getLayout(f.project.id);
  const anchor = {
    snapshotId: f.workspace.activeSnapshotId,
    layoutId: layout.layoutId,
    layoutChecksum: layout.checksum,
  };
  for (const turn of [
    request({
      workspaceId: f.workspace.id,
      graphRevision: f.workspace.graphRevision,
      type: "artifact",
      id: "empty-page",
      intent: "generate",
      baseRevisionId: "missing-empty-page-base",
    }),
    request({
      workspaceId: f.workspace.id,
      graphRevision: f.workspace.graphRevision,
      type: "resource",
      id: "empty-research",
      intent: "generate",
      baseRevisionId: "missing-empty-research-base",
    }),
  ]) {
    await assert.rejects(
      () => f.queue.enqueue({
        projectId: f.project.id,
        request: turn,
        contextPack: persistPack(f, turn, anchor),
      }, new AbortController().signal),
      /Head changed|existing published base Revision|reviewed Workspace Proposal/i,
    );
  }
  assert.deepEqual(f.store.workspace.listProposals(f.project.id), []);
  assert.deepEqual(f.wakes, []);
});

test("scoped element and explicit Resource evidence survives Plan compilation into the materialized Attempt Pack", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const bundle = f.store.workspace.getBundleByProjectId(f.project.id);
  const artifact = bundle?.artifacts.find((candidate) => candidate.id === "scoped-page");
  assert.ok(bundle && artifact?.activeTrackId);
  const repositoryRoot = join(f.root, "projects", f.project.id);
  const sourceDirectory = artifact.sourceRoot === "."
    ? repositoryRoot
    : join(repositoryRoot, artifact.sourceRoot);
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(
    join(sourceDirectory, "index.html"),
    '<main><button data-dezin-id="cta-button">Continue</button></main>\n',
    "utf8",
  );
  execFileSync("git", ["init"], { cwd: repositoryRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "dezin-test@example.invalid"], { cwd: repositoryRoot });
  execFileSync("git", ["config", "user.name", "Dezin Test"], { cwd: repositoryRoot });
  execFileSync("git", ["add", "--all"], { cwd: repositoryRoot });
  execFileSync("git", ["commit", "-m", "seed exact scoped selection"], {
    cwd: repositoryRoot,
    stdio: "ignore",
  });
  const verifiedRevision = f.store.workspace.createArtifactRevision({
    artifactId: artifact.id,
    trackId: artifact.activeTrackId,
    parentRevisionId: f.pageRevision.id,
    sourceCommitHash: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim(),
    sourceTreeHash: execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim(),
    kernelRevisionId: bundle.activeKernelRevision.id,
    renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
    quality: { state: "passed", score: 100, findings: [] },
    contextPackHash: null,
    dependencies: [],
    resourcePins: [],
  });
  f.store.workspace.publishArtifactRevision(verifiedRevision.id, {
    expectedHeadRevisionId: f.pageRevision.id,
    expectedSnapshotId: f.workspace.activeSnapshotId,
  });
  const liveWorkspace = f.store.workspace.getWorkspace(f.project.id)!;
  const repository = createWorkspaceContextPackRepository(f.store.workspace, { manifestRoot: f.root });
  const packStore = new ContextPackStore({ manifestRoot: f.root, repository });
  const designRegistry = new DesignRegistry();
  const materializationErrors: unknown[] = [];
  const contextResolver = new ProductionGenerationTaskContextResolver({
    workspace: f.store.workspace,
    packStore,
    dispatchContextPacks: repository,
    resourceStorageRoot: f.root,
    loadResourceSnapshot: async () => null,
    async loadArtifactExecutionProfile(input) {
      if (input.task.target.type !== "artifact") throw new Error("expected Artifact Task");
      const project = f.store.getProject(f.project.id)!;
      const settings = f.store.getSettings();
      const command = settings.agentCommand.trim() || "claude";
      const model = settings.model.trim() || null;
      const requestedDesignSystemId = (project.designSystemId ?? settings.defaultDesignSystemId) || null;
      const designSystem = requestedDesignSystemId
        ? (designRegistry.get(requestedDesignSystemId) ?? designRegistry.default())
        : designRegistry.default();
      if (!designSystem) throw new Error("test Design System is unavailable");
      const reviewerCommand = reviewerAgentCommand(settings, command);
      const reviewerModelId = reviewerModel(settings, model ?? undefined) ?? null;
      return freezeArtifactExecutionProfile({
        ownership: {
          projectId: f.project.id,
          workspaceId: input.task.workspaceId,
          planId: input.planId,
          taskId: input.task.id,
          targetArtifactId: input.task.target.id,
        },
        hasExactSharinganCapture: false,
        project: {
          id: project.id,
          name: project.name,
          skillId: project.skillId,
          designSystemId: project.designSystemId,
          mode: project.mode,
          sharingan: project.sharingan,
          sourceUrl: project.sourceUrl ?? null,
        },
        settings,
        agent: {
          command,
          providerId: getProvider(command)?.id ?? command,
          model,
        },
        designSystem: {
          requestedId: requestedDesignSystemId,
          resolvedId: designSystem.id,
          content: designSystem,
        },
        skill: null,
        researchDirection: null,
        prompt: {
          rendererProtocol: "dezin.project-agent-prompt.v1",
          rendererVersion: 1,
          systemPrompt: "Execute the exact scoped design edit.",
        },
        quality: {
          visualQaEnabled: settings.visualQaEnabled,
          reviewer: {
            command: reviewerCommand,
            providerId: getProvider(reviewerCommand)?.id ?? reviewerCommand,
            model: reviewerModelId,
          },
          expectedSharinganRequestedUrl: null,
          ignores: [],
        },
        imageGenerationEnabled: false,
      });
    },
  });
  const service = new GenerationPlanService({
    store: f.store.workspace,
    projectLookup: {
      listProjectIds: () => [f.project.id],
      projectIdForPlan: () => f.project.id,
    },
    contextResolver,
    sourceBaseResolver: {
      async resolve(input) {
        const revisionId = input.observation.baseRevisionId;
        const revision = revisionId === null ? null : f.store.workspace.getArtifactRevision(revisionId);
        if (!revision) throw new Error("materialization base Revision is unavailable");
        return {
          sourceCommitHash: revision.sourceCommitHash,
          sourceTreeHash: revision.sourceTreeHash,
        };
      },
    },
    rebaseReconciler: {
      reconcileNeedsRebaseTasks: async () => ({ planIds: [] }),
    },
    onError(error) {
      materializationErrors.push(error);
    },
  });
  const queue = createProductionScopedAgentTaskQueue({
    store: f.store,
    planService: service,
    wakePlan() {},
  });
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store: f.store,
    dataDir: f.root,
    scopedTasks: queue,
  });
  const turn: AgentTurnRequest = {
    scope: { type: "artifact", id: "scoped-page", workspaceId: f.workspace.id },
    intent: "edit",
    message: "Make the checkout CTA unmistakable and follow the exact attached research.",
    explicitContext: [{
      kind: "resource",
      id: "scoped-research",
      resourceKind: "research",
      revisionId: f.researchRevision.id,
    }],
    graphRevision: liveWorkspace.graphRevision,
    turnId: "turn-00000000-0000-4000-8000-000000000001",
    baseRevisionId: verifiedRevision.id,
    selection: [{ kind: "element", id: "cta-button", revisionId: verifiedRevision.id }],
  };
  const result = await orchestrator.turn(turn, new AbortController().signal);
  assert.equal(result.kind, "task");
  if (result.kind !== "task") assert.fail("expected scoped Task result");
  const dispatchPack = repository.get(f.workspace.id, result.contextPackId);
  assert.ok(dispatchPack);
  assert.equal(
    (result.task.payload.artifactPlan as Record<string, unknown>).dispatchContextPackId,
    dispatchPack.id,
  );

  await service.materializeReadyTaskAttempts();
  assert.deepEqual(materializationErrors, []);
  const attempt = f.store.workspace.getGenerationTaskAttemptForProject(
    f.project.id,
    result.task.planId,
    result.task.id,
    1,
  );
  assert.ok(attempt);
  assert.notEqual(attempt.contextPackId, dispatchPack.id);
  assert.ok(attempt.contextPackId);
  const attemptPack = repository.get(f.workspace.id, attempt.contextPackId);
  assert.ok(attemptPack);
  assert.equal(attemptPack.intent, "generate");
  const expectedEvidence = dispatchPack.items.filter((item) => item.contextClass === "selection"
    || (item.contextClass === "explicit" && item.ref.id === "scoped-research"));
  const actualEvidence = attemptPack.items.filter((item) => item.contextClass === "selection"
    || (item.contextClass === "explicit" && item.ref.id === "scoped-research"));
  assert.equal(expectedEvidence.length, 2);
  assert.equal(actualEvidence.length, 2);
  for (const expected of expectedEvidence) {
    const actual = actualEvidence.find((item) => item.contextClass === expected.contextClass
      && item.ref.id === expected.ref.id);
    assert.ok(actual);
    assert.equal(actual.content, expected.content);
    assert.equal(actual.checksum, expected.checksum);
    assert.equal(actual.trustLevel, expected.trustLevel);
    assert.deepEqual(actual.boundary, expected.boundary);
    assert.deepEqual(actual.provenance, expected.provenance);
  }
});
