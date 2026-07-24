import assert from "node:assert/strict";
import test from "node:test";

import type {
  CreateWorkspaceProposalInput,
  GenerationTask,
  WorkspaceProposal,
} from "../../../packages/core/src/index.ts";
import type {
  AgentTurnRequest,
  ContextPack,
} from "../src/context/context-types.ts";

const CONTEXT_HASH = "c".repeat(64);

function request(type: "workspace" | "artifact" | "resource", intent: AgentTurnRequest["intent"]): AgentTurnRequest {
  return {
    scope: { type, workspaceId: "workspace-1", id: type === "workspace" ? "workspace-1" : `${type}-1` },
    intent,
    agent: { providerId: "claude", command: "claude", model: null },
    message: "Use the approved direction.",
    explicitContext: [],
    graphRevision: 7,
    ...(type === "workspace" ? {
      turnId: "turn-00000000-0000-4000-8000-000000000010",
    } : {
      turnId: type === "artifact"
        ? "turn-00000000-0000-4000-8000-000000000001"
        : "turn-00000000-0000-4000-8000-000000000002",
      baseRevisionId: `${type}-revision-base`,
    }),
  };
}

function pack(type: "workspace" | "artifact" | "resource"): ContextPack {
  return {
    id: `context-pack-${CONTEXT_HASH}`,
    workspaceId: "workspace-1",
    graphRevision: 7,
    target: { type, id: type === "workspace" ? "workspace-1" : `${type}-1` },
    intent: type === "workspace" ? "plan" : "generate",
    messageChecksum: "d".repeat(64),
    items: [],
    omissions: [],
    tokenEstimate: 0,
    manifestPath: `context-packs/workspace-1/${CONTEXT_HASH}.json`,
    hash: CONTEXT_HASH,
    createdAt: 1,
  };
}

function proposalInput(): CreateWorkspaceProposalInput {
  return {
    projectId: "project-1",
    kind: "workspace-generation",
    baseGraphRevision: 7,
    baseSnapshotId: "snapshot-1",
    baseLayoutChecksum: "a".repeat(64),
    operations: [],
    generation: {
      kind: "workspace-generation",
      resourceOperations: [],
      artifactPlans: [],
      dependencyPlans: [],
      prototypeIntents: [],
      capabilities: [],
      responsiveFrames: [],
      qualityProfile: {
        requiredFrameIds: [],
        blockingSeverities: ["P0", "P1"],
        requireRuntimeChecks: true,
        requireVisualReview: true,
      },
    },
    rationale: "Create a coherent workspace",
    assumptions: [],
  };
}

function persistedProposal(): WorkspaceProposal {
  return {
    id: "proposal-1",
    workspaceId: "workspace-1",
    revision: 1,
    kind: "workspace-generation",
    baseGraphRevision: 7,
    baseSnapshotId: "snapshot-1",
    baseGraph: { workspaceId: "workspace-1", revision: 7, nodes: [], edges: [] },
    layoutId: "layout-1",
    baseLayoutChecksum: "a".repeat(64),
    baseLayout: {
      workspaceId: "workspace-1",
      layoutId: "layout-1",
      objects: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      checksum: "a".repeat(64),
    },
    status: "draft",
    operations: [],
    layoutOperations: [],
    rationale: "Create a coherent workspace",
    assumptions: [],
    generation: proposalInput().generation,
    review: { kind: "none" },
    createdByRunId: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function scopedTask(type: "artifact" | "resource"): GenerationTask {
  return {
    id: `task-${type}`,
    ordinal: 0,
    workspaceId: "workspace-1",
    planId: "plan-scoped-1",
    kind: type === "artifact" ? "page" : "resource",
    target: type === "artifact"
      ? { type, workspaceId: "workspace-1", id: "artifact-1", trackId: "track-main" }
      : { type, workspaceId: "workspace-1", id: "resource-1" },
    dependencyIds: [],
    payload: {},
    capabilities: [],
    qaProfile: {
      requiredFrameIds: [],
      blockingSeverities: ["P0", "P1"],
      requireRuntimeChecks: true,
      requireVisualReview: true,
    },
    resourceLimits: {
      timeoutMs: 60_000,
      maxAgentTurns: 3,
      maxRepairRounds: 2,
      maxOutputBytes: 4 * 1024 * 1024,
      capacityClasses: ["agent"],
    },
    intentHash: "e".repeat(64),
    idempotencyKey: "f".repeat(64),
    status: "materialization-pending",
    blockedReason: null,
    blockedByTaskId: null,
    pendingContextPolicy: null,
    currentAttempt: 0,
    materializationFailures: 0,
    failureClass: null,
    error: null,
    nextEligibleAt: null,
    resultRevisionId: null,
    resultResourceRevisionId: null,
    resultSnapshotId: null,
    createdAt: 1,
    finishedAt: null,
  };
}

function unusedWorkspaceTurns() {
  return {
    async replay() {
      return null;
    },
    async commit() {
      assert.fail("Scoped Agent dispatch must not touch the Workspace turn store");
    },
  };
}

test("production AgentOrchestrator sends Workspace turns only through draft Proposal planning", async () => {
  const calls: string[] = [];
  const module = await import("../src/orchestration/production-agent-orchestrator.ts");
  const orchestrator = new module.ProductionAgentOrchestrator({
    workspace: { getWorkspace: () => ({ id: "workspace-1", projectId: "project-1" }) },
    contextResolver: {
      async resolve(turn) {
        calls.push(`context:${turn.scope.type}`);
        return pack("workspace");
      },
    },
    workspacePlanner: {
      async propose(input) {
        calls.push(`planner:${input.contextPack.id}`);
        return proposalInput();
      },
    },
    workspaceTurns: {
      async replay() {
        return null;
      },
      async commit(input) {
        calls.push(`persist:${input.projectId}`);
        return { proposal: persistedProposal(), contextPackId: input.contextPack.id };
      },
    },
    scopedTasks: {
      async enqueue() {
        assert.fail("Workspace Agent must never enqueue a source-writing scoped Task");
      },
    },
  });

  const result = await orchestrator.turn(request("workspace", "plan"), new AbortController().signal);

  assert.equal(result.kind, "proposal");
  assert.equal(result.proposal.status, "draft");
  assert.deepEqual(calls, [
    "context:workspace",
    `planner:context-pack-${CONTEXT_HASH}`,
    "persist:project-1",
  ]);
});

test("production AgentOrchestrator fails closed when the durable Workspace turn store is absent", async () => {
  let contextCalls = 0;
  let fallbackProposalCalls = 0;
  const module = await import("../src/orchestration/production-agent-orchestrator.ts");
  const orchestrator = new module.ProductionAgentOrchestrator({
    workspace: { getWorkspace: () => ({ id: "workspace-1", projectId: "project-1" }) },
    contextResolver: {
      async resolve() {
        contextCalls += 1;
        return pack("workspace");
      },
    },
    workspacePlanner: { propose: async () => proposalInput() },
    proposals: {
      createProposal() {
        fallbackProposalCalls += 1;
        return persistedProposal();
      },
    },
    scopedTasks: { async enqueue() { assert.fail("Workspace turn cannot enqueue a scoped Task"); } },
  } as unknown as ConstructorParameters<typeof module.ProductionAgentOrchestrator>[0]);

  await assert.rejects(
    orchestrator.turn(request("workspace", "plan"), new AbortController().signal),
    /durable turn store.*not configured/i,
  );
  assert.equal(contextCalls, 0);
  assert.equal(fallbackProposalCalls, 0);
});

test("production AgentOrchestrator replays a committed Workspace Proposal before Context and Planner work", async () => {
  let committed: { proposal: WorkspaceProposal; contextPackId: string } | null = null;
  let contextCalls = 0;
  let plannerCalls = 0;
  let commitCalls = 0;
  const module = await import("../src/orchestration/production-agent-orchestrator.ts");
  const orchestrator = new module.ProductionAgentOrchestrator({
    workspace: { getWorkspace: () => ({ id: "workspace-1", projectId: "project-1" }) },
    contextResolver: {
      async resolve() {
        contextCalls += 1;
        return pack("workspace");
      },
    },
    workspacePlanner: {
      async propose() {
        plannerCalls += 1;
        return proposalInput();
      },
    },
    workspaceTurns: {
      async replay() {
        return committed;
      },
      async commit(input) {
        commitCalls += 1;
        committed = { proposal: persistedProposal(), contextPackId: input.contextPack.id };
        return committed;
      },
    },
    scopedTasks: {
      async enqueue() {
        assert.fail("Workspace Agent cannot enter the scoped Task queue");
      },
    },
  });
  const turn = request("workspace", "plan");

  const first = await orchestrator.turn(turn, new AbortController().signal);
  const replay = await orchestrator.turn(turn, new AbortController().signal);

  assert.equal(first.kind, "proposal");
  assert.deepEqual(replay, first);
  assert.equal(contextCalls, 1);
  assert.equal(plannerCalls, 1);
  assert.equal(commitCalls, 1);
});

test("production AgentOrchestrator sends Artifact and Resource turns only to exact scoped Task enqueue", async () => {
  for (const type of ["artifact", "resource"] as const) {
    let plannerCalls = 0;
    const module = await import("../src/orchestration/production-agent-orchestrator.ts");
    const orchestrator = new module.ProductionAgentOrchestrator({
      workspace: { getWorkspace: () => ({ id: "workspace-1", projectId: "project-1" }) },
      contextResolver: { resolve: async () => pack(type) },
      workspacePlanner: {
        async propose() {
          plannerCalls += 1;
          return proposalInput();
        },
      },
      workspaceTurns: unusedWorkspaceTurns(),
      scopedTasks: {
        async enqueue(input) {
          assert.equal(input.projectId, "project-1");
          assert.equal(input.contextPack.id, `context-pack-${CONTEXT_HASH}`);
          assert.equal(input.request.scope.type, type);
          return { task: scopedTask(type), contextPackId: input.contextPack.id };
        },
      },
    });

    const result = await orchestrator.turn(request(type, "generate"), new AbortController().signal);
    assert.equal(result.kind, "task");
    assert.equal(result.task.target.type, type);
    assert.equal(result.contextPackId, `context-pack-${CONTEXT_HASH}`);
    assert.equal(plannerCalls, 0);
  }
});

test("production AgentOrchestrator replays a committed scoped receipt before Context resolution or enqueue", async () => {
  let replayCalls = 0;
  let contextCalls = 0;
  let enqueueCalls = 0;
  const module = await import("../src/orchestration/production-agent-orchestrator.ts");
  const orchestrator = new module.ProductionAgentOrchestrator({
    workspace: { getWorkspace: () => ({ id: "workspace-1", projectId: "project-1" }) },
    contextResolver: {
      async resolve() {
        contextCalls += 1;
        return pack("artifact");
      },
    },
    workspacePlanner: { propose: async () => proposalInput() },
    workspaceTurns: unusedWorkspaceTurns(),
    scopedTasks: {
      async replay(input) {
        replayCalls += 1;
        assert.equal(input.projectId, "project-1");
        assert.equal(input.request.turnId, "turn-00000000-0000-4000-8000-000000000001");
        return {
          task: scopedTask("artifact"),
          contextPackId: `context-pack-${CONTEXT_HASH}`,
        };
      },
      async enqueue() {
        enqueueCalls += 1;
        assert.fail("a committed scoped turn must not enqueue again");
      },
    },
  });
  const turn = request("artifact", "edit");

  const preflight = await orchestrator.replayScoped(turn, new AbortController().signal);
  assert.equal(preflight?.kind, "task");
  const result = await orchestrator.turn(turn, new AbortController().signal);

  assert.equal(result.kind, "task");
  assert.equal(result.task.id, "task-artifact");
  assert.equal(result.contextPackId, `context-pack-${CONTEXT_HASH}`);
  assert.equal(replayCalls, 2);
  assert.equal(contextCalls, 0);
  assert.equal(enqueueCalls, 0);
});

test("production AgentOrchestrator rejects substituted Context and cross-target enqueue receipts", async () => {
  const module = await import("../src/orchestration/production-agent-orchestrator.ts");
  const base = {
    workspace: { getWorkspace: () => ({ id: "workspace-1", projectId: "project-1" }) },
    workspacePlanner: { propose: async () => proposalInput() },
    workspaceTurns: unusedWorkspaceTurns(),
  };
  const substitutedContext = new module.ProductionAgentOrchestrator({
    ...base,
    contextResolver: { resolve: async () => pack("resource") },
    scopedTasks: { enqueue: async () => ({ task: scopedTask("artifact"), contextPackId: `context-pack-${CONTEXT_HASH}` }) },
  });
  await assert.rejects(
    substitutedContext.turn(request("artifact", "generate"), new AbortController().signal),
    /Context Pack.*scope|target.*Context|substitut/i,
  );

  const foreignReceipt = new module.ProductionAgentOrchestrator({
    ...base,
    contextResolver: { resolve: async () => pack("artifact") },
    scopedTasks: { enqueue: async () => ({ task: scopedTask("resource"), contextPackId: `context-pack-${CONTEXT_HASH}` }) },
  });
  await assert.rejects(
    foreignReceipt.turn(request("artifact", "generate"), new AbortController().signal),
    /Task.*target|cross-target|scope/i,
  );
});
