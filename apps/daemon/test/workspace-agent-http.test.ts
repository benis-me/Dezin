import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ScopedAgentTurnConflictError,
  Store,
  WorkspaceAgentTurnConflictError,
  type GenerationTask,
  type WorkspaceProposalRecord,
} from "../../../packages/core/src/index.ts";
import { BlockedContextError, type AgentTurnRequest } from "../src/context/context-types.ts";
import { createApp, createRuntimeSupervisor } from "../src/app.ts";
import type { ProductionAgentTurnPort } from "../src/orchestration/production-agent-orchestrator.ts";
import { createProductionWorkspaceAgentOrchestrator } from "../src/orchestration/production-workspace-agent.ts";

const CONTEXT_PACK_ID = `context-pack-${"c".repeat(64)}`;

function seedArtifactSource(input: {
  dataDir: string;
  projectId: string;
  sourceRoot: string;
  designNodeId: string;
}): { commitHash: string; treeHash: string } {
  const repository = join(input.dataDir, "projects", input.projectId);
  const sourceDirectory = input.sourceRoot === "." ? repository : join(repository, input.sourceRoot);
  mkdirSync(sourceDirectory, { recursive: true });
  writeFileSync(
    join(sourceDirectory, "index.html"),
    `<main><button data-dezin-id="${input.designNodeId}">Continue</button></main>\n`,
    "utf8",
  );
  execFileSync("git", ["init"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "dezin-test@example.invalid"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Dezin Test"], { cwd: repository });
  execFileSync("git", ["add", "--all"], { cwd: repository });
  execFileSync("git", ["commit", "-m", "seed immutable artifact selection"], {
    cwd: repository,
    stdio: "ignore",
  });
  return {
    commitHash: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
    treeHash: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repository, encoding: "utf8" }).trim(),
  };
}

function scopedTask(store: Store, request: AgentTurnRequest): GenerationTask {
  assert.notEqual(request.scope.type, "workspace");
  const projectId = store.listProjects().find(
    (project) => store.workspace.getWorkspace(project.id)?.id === request.scope.workspaceId,
  )?.id;
  assert.ok(projectId);
  const bundle = store.workspace.getBundleByProjectId(projectId);
  assert.ok(bundle);
  const artifact = request.scope.type === "artifact"
    ? bundle.artifacts.find((candidate) => candidate.id === request.scope.id)
    : null;
  assert.ok(request.scope.type === "resource" || artifact?.activeTrackId);
  return {
    id: `task-${request.scope.type}`,
    ordinal: 0,
    workspaceId: request.scope.workspaceId,
    planId: `plan-${request.scope.type}`,
    kind: request.scope.type === "artifact" ? artifact!.kind : "resource",
    target: request.scope.type === "artifact"
      ? {
          type: "artifact",
          workspaceId: request.scope.workspaceId,
          id: request.scope.id,
          trackId: artifact!.activeTrackId!,
        }
      : { type: "resource", workspaceId: request.scope.workspaceId, id: request.scope.id },
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

async function withServer(run: (input: {
  base: string;
  dataDir: string;
  store: Store;
  turns: AgentTurnRequest[];
}) => Promise<void>, options: {
  productionScopedContext?: boolean;
  workspaceAgentFactory?: (input: {
    store: Store;
    turns: AgentTurnRequest[];
  }) => ProductionAgentTurnPort;
} = {}): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-workspace-agent-http-"));
  const store = new Store(join(dataDir, "store.db"));
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  const turns: AgentTurnRequest[] = [];
  const workspaceAgent = options.workspaceAgentFactory?.({ store, turns }) ?? (options.productionScopedContext
    ? createProductionWorkspaceAgentOrchestrator({
        store,
        dataDir,
        scopedTasks: {
          async enqueue(input) {
            turns.push(input.request);
            return {
              task: scopedTask(store, input.request),
              contextPackId: input.contextPack.id,
            };
          },
        },
      })
    : {
        async turn(request: AgentTurnRequest, signal: AbortSignal) {
          assert.equal(signal.aborted, false);
          turns.push(request);
          if (request.message === "missing context") {
            throw new BlockedContextError(["resource-missing"], "Required reference is unavailable");
          }
          if (request.scope.type !== "workspace") {
            return {
              kind: "task" as const,
              task: scopedTask(store, request),
              contextPackId: CONTEXT_PACK_ID,
            };
          }
          const projectId = store.listProjects().find(
            (project) => store.workspace.getWorkspace(project.id)?.id === request.scope.workspaceId,
          )?.id;
          assert.ok(projectId);
          const workspace = store.workspace.getWorkspace(projectId);
          const layout = store.workspace.getLayout(projectId);
          assert.ok(workspace);
          const proposal = store.workspace.createProposal({
            projectId,
            kind: "workspace-generation",
            baseGraphRevision: request.graphRevision,
            baseSnapshotId: workspace.activeSnapshotId,
            layoutId: layout.layoutId,
            baseLayoutChecksum: layout.checksum,
            operations: [],
            layoutOperations: [],
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
                blockingSeverities: [],
                requireRuntimeChecks: false,
                requireVisualReview: false,
              },
            },
            rationale: "HTTP-created draft",
            assumptions: [],
          });
          return { kind: "proposal" as const, proposal };
        },
      });
  const server = createApp({
    store,
    dataDir,
    runtimeSupervisor,
    workspaceAgent,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run({ base: `http://127.0.0.1:${port}`, dataDir, store, turns });
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
}

test("Workspace Agent HTTP owns scope, returns the persisted draft, and rejects caller-owned capability fields", async () => {
  await withServer(async ({ base, store, turns }) => {
    const project = store.createProject({ name: "Workspace Agent HTTP", mode: "standard" });
    const readyResponse = await fetch(`${base}/api/projects/${project.id}/workspace`);
    assert.equal(readyResponse.status, 200);
    const ready = await readyResponse.json() as {
      workspace: { id: string };
      graph: { revision: number };
    };
    const endpoint = `${base}/api/projects/${project.id}/workspace/agent/turns`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        turnId: "turn-00000000-0000-4000-8000-000000000031",
        message: "Plan a pricing page",
        explicitContext: [],
        graphRevision: ready.graph.revision,
        selection: [{ kind: "node", id: "selected-node" }],
      }),
    });

    const responseBody = await response.text();
    assert.equal(response.status, 201, responseBody);
    const proposal = JSON.parse(responseBody) as { workspaceId: string; status: string; review: { kind: string } };
    assert.equal(proposal.workspaceId, ready.workspace.id);
    assert.equal(proposal.status, "draft");
    assert.equal(proposal.review.kind, "none");
    assert.deepEqual(turns[0], {
      scope: { type: "workspace", id: ready.workspace.id, workspaceId: ready.workspace.id },
      intent: "plan",
      turnId: "turn-00000000-0000-4000-8000-000000000031",
      message: "Plan a pricing page",
      explicitContext: [],
      graphRevision: ready.graph.revision,
      selection: [{ kind: "node", id: "selected-node" }],
    });

    const foreign = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        turnId: "turn-00000000-0000-4000-8000-000000000032",
        scope: { type: "workspace", id: "foreign" },
        message: "Plan a foreign workspace",
        explicitContext: [],
        graphRevision: ready.graph.revision,
      }),
    });
    assert.equal(foreign.status, 400);
    assert.equal(turns.length, 1);

    for (const turnId of [
      undefined,
      "turn-00000000-0000-1000-8000-000000000033",
      "turn-00000000-0000-4000-8000-00000000003A",
    ]) {
      const invalid = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(turnId === undefined ? {} : { turnId }),
          message: "Invalid turn identity",
          explicitContext: [],
          graphRevision: ready.graph.revision,
        }),
      });
      assert.equal(invalid.status, 400);
    }
    assert.equal(turns.length, 1);
  });
});

test("Workspace Agent HTTP classifies blocked immutable context without creating a draft", async () => {
  await withServer(async ({ base, store }) => {
    const project = store.createProject({ name: "Workspace Agent blocked", mode: "standard" });
    const readyResponse = await fetch(`${base}/api/projects/${project.id}/workspace`);
    assert.equal(readyResponse.status, 200);
    const ready = await readyResponse.json() as { graph: { revision: number } };
    const response = await fetch(`${base}/api/projects/${project.id}/workspace/agent/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        turnId: "turn-00000000-0000-4000-8000-000000000034",
        message: "missing context",
        explicitContext: [],
        graphRevision: ready.graph.revision,
      }),
    });

    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      error: "Required reference is unavailable",
      code: "workspace_agent_context_blocked",
      missing: ["resource-missing"],
    });
    assert.deepEqual(store.workspace.listProposals(project.id), []);
  });
});

test("Workspace Agent HTTP replays the current terminal Proposal before the current graph fence", async () => {
  const turnId = "turn-00000000-0000-4000-8000-000000000035";
  const committedMessage = "Plan the committed checkout system";
  let committedProposal: WorkspaceProposalRecord | null = null;
  let replayCalls = 0;
  let turnCalls = 0;
  await withServer(async ({ base, store }) => {
    const project = store.createProject({ name: "Workspace Agent terminal replay", mode: "standard" });
    const readyResponse = await fetch(`${base}/api/projects/${project.id}/workspace`);
    assert.equal(readyResponse.status, 200);
    const ready = await readyResponse.json() as {
      workspace: { id: string };
      graph: { revision: number; nodes: Array<{ id: string }> };
      activeSnapshot: { id: string };
    };
    const workspace = store.workspace.getWorkspace(project.id);
    assert.ok(workspace);
    const layout = store.workspace.getLayout(project.id);
    const draft = store.workspace.createProposal({
      projectId: project.id,
      kind: "workspace-generation",
      baseGraphRevision: ready.graph.revision,
      baseSnapshotId: workspace.activeSnapshotId,
      layoutId: layout.layoutId,
      baseLayoutChecksum: layout.checksum,
      operations: [],
      layoutOperations: [],
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
          blockingSeverities: [],
          requireRuntimeChecks: false,
          requireVisualReview: false,
        },
      },
      rationale: "Committed Workspace Agent Proposal",
      assumptions: [],
    });
    committedProposal = store.workspace.rejectProposalForProject(project.id, draft.id);
    const node = ready.graph.nodes[0];
    assert.ok(node);
    store.workspace.applyGraphCommands(project.id, {
      baseGraphRevision: ready.graph.revision,
      expectedSnapshotId: ready.activeSnapshot.id,
      commands: [{
        id: "rename-after-workspace-agent-turn",
        type: "rename-node",
        nodeId: node.id,
        name: "Canvas changed after committed turn",
      }],
    });
    const endpoint = `${base}/api/projects/${project.id}/workspace/agent/turns`;
    const input = {
      turnId,
      message: committedMessage,
      explicitContext: [],
      graphRevision: ready.graph.revision,
      selection: [],
    };

    const replay = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const replayBody = await replay.text();
    assert.equal(replay.status, 201, replayBody);
    assert.deepEqual(JSON.parse(replayBody), committedProposal);
    assert.equal((committedProposal as WorkspaceProposalRecord).status, "rejected");
    assert.equal(replayCalls, 1);
    assert.equal(turnCalls, 0);

    const divergent = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, message: "Divergent retry" }),
    });
    assert.equal(divergent.status, 409);
    assert.deepEqual(await divergent.json(), {
      error: `Workspace Agent turn ${turnId} was already committed for a different immutable request`,
      code: "workspace_agent_turn_conflict",
      turnId,
    });
    assert.equal(replayCalls, 2);
    assert.equal(turnCalls, 0);
  }, {
    workspaceAgentFactory: () => ({
      async replayWorkspace(request) {
        replayCalls += 1;
        if (request.message !== committedMessage) {
          throw new WorkspaceAgentTurnConflictError(turnId, "a".repeat(64), "b".repeat(64));
        }
        assert.ok(committedProposal);
        return { kind: "proposal", proposal: committedProposal };
      },
      async turn() {
        turnCalls += 1;
        assert.fail("committed Workspace retries must replay before normal orchestration");
      },
    }),
  });
});

test("Artifact Agent HTTP proves an exact immutable element before returning the queued Task receipt", async () => {
  await withServer(async ({ base, dataDir, store, turns }) => {
    const project = store.createProject({ name: "Artifact Agent HTTP", mode: "standard" });
    const readyResponse = await fetch(`${base}/api/projects/${project.id}/workspace`);
    assert.equal(readyResponse.status, 200);
    const ready = await readyResponse.json() as {
      workspace: { id: string };
      graph: { revision: number };
      artifacts: Array<{ id: string }>;
      activeSnapshot: { artifactRevisions: Record<string, string> };
    };
    const artifact = ready.artifacts[0];
    assert.ok(artifact);
    const bundle = store.workspace.getBundleByProjectId(project.id);
    const storedArtifact = bundle?.artifacts.find((candidate) => candidate.id === artifact.id);
    assert.ok(bundle && storedArtifact?.activeTrackId);
    const source = seedArtifactSource({
      dataDir,
      projectId: project.id,
      sourceRoot: storedArtifact.sourceRoot,
      designNodeId: "hero-cta",
    });
    const baseRevision = store.workspace.createArtifactRevision({
      artifactId: storedArtifact.id,
      trackId: storedArtifact.activeTrackId,
      parentRevisionId: null,
      sourceCommitHash: source.commitHash,
      sourceTreeHash: source.treeHash,
      kernelRevisionId: bundle.activeKernelRevision.id,
      renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
      quality: { state: "passed", score: 100, findings: [] },
      contextPackHash: null,
      dependencies: [],
      resourcePins: [],
    });
    store.workspace.publishArtifactRevision(baseRevision.id, {
      expectedHeadRevisionId: null,
      expectedSnapshotId: bundle.activeSnapshot.id,
    });
    const baseRevisionId = baseRevision.id;
    const endpoint = `${base}/api/projects/${project.id}/artifacts/${artifact.id}/agent/turns`;
    const input = {
      turnId: "turn-00000000-0000-4000-8000-000000000001",
      intent: "edit",
      message: "Tighten the selected call to action",
      explicitContext: [],
      graphRevision: ready.graph.revision,
      baseRevisionId,
      selection: [{ kind: "element", id: "hero-cta", revisionId: baseRevisionId }],
    };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });

    const responseBody = await response.text();
    assert.equal(response.status, 202, responseBody);
    const receipt = JSON.parse(responseBody) as {
      task: GenerationTask;
      contextPackId: string;
    };
    assert.equal(receipt.task.planId, "plan-artifact");
    assert.deepEqual(receipt.task.target, {
      type: "artifact",
      workspaceId: ready.workspace.id,
      id: artifact.id,
      trackId: receipt.task.target.type === "artifact" ? receipt.task.target.trackId : "unreachable",
    });
    assert.equal(receipt.task.status, "materialization-pending");
    assert.match(receipt.contextPackId, /^context-pack-[0-9a-f]{64}$/);
    assert.deepEqual(turns.at(-1), {
      scope: { type: "artifact", id: artifact.id, workspaceId: ready.workspace.id },
      ...input,
    });

    const forged = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...input,
        turnId: "turn-00000000-0000-4000-8000-000000000002",
        message: "Edit a forged element",
        selection: [{ kind: "element", id: "forged-hero-cta", revisionId: baseRevisionId }],
      }),
    });
    assert.equal(forged.status, 422);
    assert.deepEqual(await forged.json(), {
      error: `Selected design element forged-hero-cta cannot be proven in immutable Artifact Revision ${baseRevisionId}`,
      code: "scoped_agent_context_blocked",
      scopeType: "artifact",
      targetId: artifact.id,
      missing: ["forged-hero-cta"],
    });
    assert.equal(turns.length, 1, "a forged element never reaches the scoped queue");

    const staleHead = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, baseRevisionId: "stale-revision" }),
    });
    assert.equal(staleHead.status, 409);
    assert.deepEqual(await staleHead.json(), {
      error: "Artifact Head changed before the Agent Task could be queued",
      code: "workspace_pointer_conflict",
      pointer: "artifact-head",
      ownerId: artifact.id,
      expectedId: "stale-revision",
      actualId: baseRevisionId,
    });

    for (const forbidden of [
      { scope: { type: "artifact", id: "foreign", workspaceId: "foreign" } },
      { capabilities: ["workspace-write"] },
      { targetId: "foreign" },
    ]) {
      const rejected = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, ...forbidden }),
      });
      assert.equal(rejected.status, 400);
    }
    for (const invalid of [
      { ...input, intent: "plan" },
      { ...input, baseRevisionId: undefined },
    ]) {
      const rejected = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(invalid),
      });
      assert.equal(rejected.status, 400);
    }
    assert.equal(turns.length, 1);
  }, { productionScopedContext: true });
});

test("Artifact Agent HTTP replays a committed receipt before stale graph and Head fences", async () => {
  const committedMessage = "Tighten the committed checkout call to action";
  let replayCalls = 0;
  let turnCalls = 0;
  await withServer(async ({ base, store }) => {
    const project = store.createProject({ name: "Artifact Agent HTTP replay", mode: "standard" });
    const readyResponse = await fetch(`${base}/api/projects/${project.id}/workspace`);
    assert.equal(readyResponse.status, 200);
    const ready = await readyResponse.json() as {
      workspace: { id: string };
      graph: { revision: number; nodes: Array<{ id: string; kind: string; artifactId?: string }> };
      activeSnapshot: { id: string };
      artifacts: Array<{ id: string; activeTrackId: string | null }>;
      activeKernelRevision: { id: string };
    };
    const artifact = ready.artifacts[0];
    assert.ok(artifact?.activeTrackId);
    const node = ready.graph.nodes.find((candidate) => candidate.artifactId === artifact.id);
    assert.ok(node);
    const firstRevision = store.workspace.createArtifactRevision({
      artifactId: artifact.id,
      trackId: artifact.activeTrackId,
      parentRevisionId: null,
      sourceCommitHash: "1".repeat(40),
      sourceTreeHash: "2".repeat(40),
      kernelRevisionId: ready.activeKernelRevision.id,
      renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
      quality: { state: "passed", score: 100, findings: [] },
      contextPackHash: null,
      dependencies: [],
      resourcePins: [],
    });
    const firstSnapshot = store.workspace.publishArtifactRevision(firstRevision.id, {
      expectedHeadRevisionId: null,
      expectedSnapshotId: ready.activeSnapshot.id,
    });
    const movedGraph = store.workspace.applyGraphCommands(project.id, {
      baseGraphRevision: ready.graph.revision,
      expectedSnapshotId: firstSnapshot.id,
      commands: [{
        id: "rename-after-agent-turn",
        type: "rename-node",
        nodeId: node.id,
        name: "Checkout after committed turn",
      }],
    });
    const secondRevision = store.workspace.createArtifactRevision({
      artifactId: artifact.id,
      trackId: artifact.activeTrackId,
      parentRevisionId: firstRevision.id,
      sourceCommitHash: "3".repeat(40),
      sourceTreeHash: "4".repeat(40),
      kernelRevisionId: ready.activeKernelRevision.id,
      renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
      quality: { state: "passed", score: 100, findings: [] },
      contextPackHash: null,
      dependencies: [],
      resourcePins: [],
    });
    store.workspace.publishArtifactRevision(secondRevision.id, {
      expectedHeadRevisionId: firstRevision.id,
      expectedSnapshotId: movedGraph.snapshot.id,
    });
    const endpoint = `${base}/api/projects/${project.id}/artifacts/${artifact.id}/agent/turns`;
    const input = {
      turnId: "turn-00000000-0000-4000-8000-000000000011",
      intent: "edit",
      message: committedMessage,
      explicitContext: [],
      graphRevision: ready.graph.revision,
      baseRevisionId: firstRevision.id,
      selection: [],
    };

    const replay = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const replayBody = await replay.text();
    assert.equal(replay.status, 202, replayBody);
    const receipt = JSON.parse(replayBody) as { task: GenerationTask; contextPackId: string };
    assert.equal(receipt.task.id, "task-artifact");
    assert.equal(receipt.contextPackId, CONTEXT_PACK_ID);
    assert.equal(replayCalls, 1);
    assert.equal(turnCalls, 0);

    const divergent = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, message: "Divergent retry" }),
    });
    assert.equal(divergent.status, 409);
    assert.deepEqual(await divergent.json(), {
      error: `Scoped Agent turn ${input.turnId} was already committed for a different immutable request`,
      code: "scoped_agent_turn_conflict",
      scopeType: "artifact",
      targetId: artifact.id,
      turnId: input.turnId,
    });
    assert.equal(replayCalls, 2);
    assert.equal(turnCalls, 0);
  }, {
    workspaceAgentFactory: ({ store }) => ({
      async replayScoped(request) {
        replayCalls += 1;
        if (request.message !== committedMessage) {
          throw new ScopedAgentTurnConflictError(
            request.turnId!,
            "a".repeat(64),
            "b".repeat(64),
          );
        }
        return {
          kind: "task",
          task: scopedTask(store, request),
          contextPackId: CONTEXT_PACK_ID,
        };
      },
      async turn() {
        turnCalls += 1;
        assert.fail("committed HTTP retries must replay before normal orchestration");
      },
    }),
  });
});

test("Resource Agent HTTP keeps Resource ownership in the path and classifies immutable Context blocks", async () => {
  await withServer(async ({ base, store, turns }) => {
    const project = store.createProject({ name: "Resource Agent HTTP", mode: "standard" });
    const readyResponse = await fetch(`${base}/api/projects/${project.id}/workspace`);
    assert.equal(readyResponse.status, 200);
    const ready = await readyResponse.json() as {
      workspace: { id: string };
      graph: { revision: number };
      activeSnapshot: { id: string };
    };
    const created = store.workspace.createResourceForProject(project.id, {
      kind: "research",
      title: "Market signals",
      defaultPinPolicy: "pin-current",
      baseGraphRevision: ready.graph.revision,
      expectedSnapshotId: ready.activeSnapshot.id,
    });
    const revision = store.workspace.createResourceRevisionCandidateForProject(
      project.id,
      created.resource.id,
      {
        revisionId: "research-v1",
        parentRevisionId: null,
        manifestPath: "resource-revisions/research-v1/manifest.json",
        summary: "Initial evidence",
        metadata: { mimeType: "application/json" },
        checksum: "9".repeat(64),
        provenance: { source: "workspace-agent-http-test" },
      },
    );
    const published = store.workspace.publishResourceRevisionForProject(
      project.id,
      created.resource.id,
      revision.id,
      {
        expectedHeadRevisionId: null,
        expectedSnapshotId: created.snapshot.id,
        reason: "Seed Resource Agent base",
      },
    );
    const endpoint = `${base}/api/projects/${project.id}/resources/${created.resource.id}/agent/turns`;
    const input = {
      turnId: "turn-00000000-0000-4000-8000-000000000021",
      intent: "repair",
      message: "Refresh the weak evidence",
      explicitContext: [],
      graphRevision: published.graphRevision,
      baseRevisionId: revision.id,
      selection: [{ kind: "resource", id: created.resource.id, revisionId: revision.id }],
    };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const responseBody = await response.text();
    assert.equal(response.status, 202, responseBody);
    const receipt = JSON.parse(responseBody) as { task: GenerationTask; contextPackId: string };
    assert.deepEqual(receipt.task.target, {
      type: "resource",
      workspaceId: ready.workspace.id,
      id: created.resource.id,
    });
    assert.equal(receipt.task.planId, "plan-resource");
    assert.equal(receipt.contextPackId, CONTEXT_PACK_ID);
    assert.deepEqual(turns.at(-1), {
      scope: { type: "resource", id: created.resource.id, workspaceId: ready.workspace.id },
      ...input,
    });

    const blocked = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...input,
        turnId: "turn-00000000-0000-4000-8000-000000000022",
        message: "missing context",
      }),
    });
    assert.equal(blocked.status, 422);
    assert.deepEqual(await blocked.json(), {
      error: "Required reference is unavailable",
      code: "scoped_agent_context_blocked",
      scopeType: "resource",
      targetId: created.resource.id,
      missing: ["resource-missing"],
    });

    const foreign = await fetch(`${base}/api/projects/${project.id}/resources/foreign/agent/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    assert.equal(foreign.status, 404);
  });
});
