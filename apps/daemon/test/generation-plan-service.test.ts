import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeGenerationTaskIntent,
  type ArtifactQualityProfile,
  type CreateGenerationTaskAttemptInput,
  type GenerationPlan,
  type GenerationPlanDetail,
  type GenerationTask,
  type GenerationTaskAttempt,
  type GenerationTaskKind,
  type GenerationTaskMaterializationFailure,
  type GenerationTaskMaterializationObservation,
  type GenerationTaskTarget,
  type RecordGenerationTaskMaterializationFailureInput,
} from "../../../packages/core/src/index.ts";
import { BlockedContextError } from "../src/context/context-types.ts";
import { GenerationPlanService } from "../src/orchestration/generation-plan-service.ts";

const QUALITY_PROFILE: ArtifactQualityProfile = {
  requiredFrameIds: ["desktop"],
  blockingSeverities: ["P0", "P1"],
  requireRuntimeChecks: true,
  requireVisualReview: true,
};
const SOURCE_COMMIT_HASH = "a".repeat(40);
const SOURCE_TREE_HASH = "b".repeat(40);

function sourceBaseForTask(task: GenerationTask): {
  sourceCommitHash: string | null;
  sourceTreeHash: string | null;
} {
  return task.target.type === "artifact"
    ? { sourceCommitHash: SOURCE_COMMIT_HASH, sourceTreeHash: SOURCE_TREE_HASH }
    : { sourceCommitHash: null, sourceTreeHash: null };
}

function defaultSourceBaseResolver(): {
  resolve(): Promise<{ sourceCommitHash: string; sourceTreeHash: string }>;
} {
  return {
    resolve: async () => ({ sourceCommitHash: SOURCE_COMMIT_HASH, sourceTreeHash: SOURCE_TREE_HASH }),
  };
}

function planFixture(input: {
  id: string;
  workspaceId: string;
  status?: GenerationPlan["status"];
}): GenerationPlan {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    proposalId: `proposal-${input.id}`,
    proposalRevision: 1,
    baseSnapshotId: `snapshot-${input.workspaceId}`,
    status: input.status ?? "queued",
    constructionSealed: true,
    compileError: null,
    createdAt: 10_000,
    finishedAt: null,
  };
}

function taskFixture(input: {
  id: string;
  planId: string;
  workspaceId: string;
  kind?: GenerationTaskKind;
  target?: GenerationTaskTarget;
  status?: GenerationTask["status"];
  pendingContextPolicy?: GenerationTask["pendingContextPolicy"];
  currentAttempt?: number;
  materializationFailures?: number;
}): GenerationTask {
  const kind = input.kind ?? "page";
  const target = input.target ?? {
    type: "artifact",
    workspaceId: input.workspaceId,
    id: `artifact-${input.id}`,
    trackId: `track-${input.id}`,
  };
  return {
    ...normalizeGenerationTaskIntent({
      id: input.id,
      ordinal: 0,
      workspaceId: input.workspaceId,
      planId: input.planId,
      kind,
      target,
      dependencyIds: [],
      payload: { prompt: `Generate ${input.id}` },
      capabilities: kind === "checkpoint" ? [] : ["generate"],
      qaProfile: { ...QUALITY_PROFILE },
      resourceLimits: {
        timeoutMs: 120_000,
        maxAgentTurns: 8,
        maxRepairRounds: 2,
        maxOutputBytes: 8_000_000,
        capacityClasses: kind === "checkpoint" ? [] : ["agent"],
      },
    }),
    status: input.status ?? "materialization-pending",
    blockedReason: null,
    blockedByTaskId: null,
    pendingContextPolicy: input.pendingContextPolicy ?? null,
    currentAttempt: input.currentAttempt ?? 0,
    materializationFailures: input.materializationFailures ?? 0,
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

function observationFixture(task: GenerationTask): GenerationTaskMaterializationObservation {
  return {
    taskId: task.id,
    planId: task.planId,
    workspaceId: task.workspaceId,
    attempt: task.currentAttempt + 1,
    target: task.target,
    baseRevisionId: task.target.type === "workspace" ? null : `base-${task.id}`,
    expectedSnapshotId: `snapshot-${task.workspaceId}`,
    kernelRevisionId: `kernel-${task.workspaceId}`,
    payload: task.payload,
    dependencyOutputs: [],
    resourcePins: [],
    componentPins: [],
  };
}

function attemptFixture(input: CreateGenerationTaskAttemptInput): GenerationTaskAttempt {
  return {
    ...input,
    dependencyOutputs: [],
    resourcePins: [],
    componentPins: [],
    inputHash: `hash-${input.taskId}`,
    attemptOrigin: "materialized",
    predecessorAttempt: null,
    automaticRetryIndex: 0,
    status: "queued",
    blockedReason: null,
    failureClass: null,
    error: null,
    nextEligibleAt: null,
    candidateRevisionId: null,
    candidateResourceRevisionId: null,
    candidateEvidence: null,
    candidateEvidenceHash: null,
    lease: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    createdAt: 10_000,
    startedAt: null,
    finishedAt: null,
  };
}

function failureFixture(
  task: GenerationTask,
  input: RecordGenerationTaskMaterializationFailureInput,
): GenerationTaskMaterializationFailure {
  return {
    taskId: task.id,
    planId: task.planId,
    workspaceId: task.workspaceId,
    sequence: input.expectedFailureCount + 1,
    failureClass: input.failureClass,
    error: input.error,
    nextEligibleAt: input.nextEligibleAt,
    createdAt: 10_000,
  };
}

interface TestGenerationPlanStorePort {
  compileApprovedGenerationPlanForProject(projectId: string, planId: string): GenerationPlanDetail;
  listActiveGenerationPlanIdsForProject(projectId: string): string[];
  listGenerationTaskIdsReadyForMaterializationForProject(projectId: string, planId: string): string[];
  getGenerationPlanDetailForProject(projectId: string, planId: string): GenerationPlanDetail;
  observeGenerationTaskMaterializationForProject(
    projectId: string,
    planId: string,
    taskId: string,
  ): GenerationTaskMaterializationObservation;
  createGenerationTaskAttemptForProject(
    projectId: string,
    planId: string,
    input: CreateGenerationTaskAttemptInput,
  ): GenerationTaskAttempt;
  recordGenerationTaskMaterializationFailureForProject(
    projectId: string,
    planId: string,
    input: RecordGenerationTaskMaterializationFailureInput,
  ): GenerationTaskMaterializationFailure;
  getGenerationTaskAttemptForProject(
    projectId: string,
    planId: string,
    taskId: string,
    attempt: number,
  ): GenerationTaskAttempt | null;
}

function storePort(
  overrides: Partial<TestGenerationPlanStorePort>,
): TestGenerationPlanStorePort {
  const unused = (operation: string): never => assert.fail(`unexpected ${operation}`);
  return {
    compileApprovedGenerationPlanForProject: () => unused("compile"),
    listActiveGenerationPlanIdsForProject: () => [],
    listGenerationTaskIdsReadyForMaterializationForProject: () => [],
    getGenerationPlanDetailForProject: () => unused("Plan detail read"),
    observeGenerationTaskMaterializationForProject: () => unused("Task observation"),
    createGenerationTaskAttemptForProject: () => unused("Attempt creation"),
    recordGenerationTaskMaterializationFailureForProject: () => unused("materialization failure write"),
    getGenerationTaskAttemptForProject: () => null,
    ...overrides,
  };
}

function idleRebaseReconciler(): {
  reconcileNeedsRebaseTasks(): Promise<{ planIds: string[] }>;
} {
  return {
    reconcileNeedsRebaseTasks: async () => ({ planIds: [] }),
  };
}

function materializationConflict(message: string): Error {
  const error = new Error(message);
  error.name = "GenerationTaskMaterializationConflictError";
  return error;
}

test("GenerationPlanService immediately delegates every approved-shell compilation to Core's idempotent transaction", () => {
  const plan = planFixture({ id: "plan-approved", workspaceId: "workspace-1" });
  const detail: GenerationPlanDetail = { plan, tasks: [], dependencies: [] };
  const lookups: string[] = [];
  const compilations: Array<{ projectId: string; planId: string }> = [];
  const service = new GenerationPlanService({
    store: storePort({
      compileApprovedGenerationPlanForProject(projectId: string, planId: string) {
        compilations.push({ projectId, planId });
        return detail;
      },
    }),
    projectLookup: {
      listProjectIds: () => [],
      projectIdForPlan(planId: string) {
        lookups.push(planId);
        return "project-1";
      },
    },
    contextResolver: { resolve: async () => ({ id: "unused" }) },
    sourceBaseResolver: defaultSourceBaseResolver(),
    rebaseReconciler: idleRebaseReconciler(),
  });

  const first = service.compileAndEnqueueApprovedShell(plan.id);
  const replay = service.compileAndEnqueueApprovedShell(plan.id);

  assert.strictEqual(first, plan);
  assert.strictEqual(replay, plan);
  assert.deepEqual(lookups, [plan.id, plan.id]);
  assert.deepEqual(compilations, [
    { projectId: "project-1", planId: plan.id },
    { projectId: "project-1", planId: plan.id },
  ]);
});

test("GenerationPlanService scans only active Plan ids and avoids full detail reads when no Task is ready", async () => {
  const readyChecks: string[] = [];
  let detailReads = 0;
  const service = new GenerationPlanService({
    store: storePort({
      listActiveGenerationPlanIdsForProject: () => ["plan-active", "plan-active"],
      listGenerationTaskIdsReadyForMaterializationForProject(_projectId, planId) {
        readyChecks.push(planId);
        return [];
      },
      getGenerationPlanDetailForProject() {
        detailReads += 1;
        return assert.fail("inactive or idle Plan detail must not be decoded");
      },
    }),
    projectLookup: {
      listProjectIds: () => ["project-1"],
      projectIdForPlan: () => "project-1",
    },
    contextResolver: { resolve: async () => ({ id: "unused" }) },
    sourceBaseResolver: defaultSourceBaseResolver(),
    rebaseReconciler: idleRebaseReconciler(),
  });

  assert.deepEqual(await service.materializeReadyTaskAttempts(), { planIds: [] });
  assert.deepEqual(readyChecks, ["plan-active"]);
  assert.equal(detailReads, 0);
});

test("GenerationPlanService isolates exact Context and Attempt materialization by project, Plan, and Task", async () => {
  const planA = planFixture({ id: "plan-a", workspaceId: "workspace-a" });
  const planB = planFixture({ id: "plan-b", workspaceId: "workspace-b" });
  const taskA = taskFixture({ id: "task-page-a", planId: planA.id, workspaceId: planA.workspaceId });
  const taskB = taskFixture({
    id: "task-resource-b",
    planId: planB.id,
    workspaceId: planB.workspaceId,
    kind: "resource",
    target: {
      type: "resource",
      workspaceId: planB.workspaceId,
      id: "resource-b",
    },
  });
  const detailByPlan = new Map<string, GenerationPlanDetail>([
    [planA.id, { plan: planA, tasks: [taskA], dependencies: [] }],
    [planB.id, { plan: planB, tasks: [taskB], dependencies: [] }],
  ]);
  const observations = new Map([
    [taskA.id, observationFixture(taskA)],
    [taskB.id, observationFixture(taskB)],
  ]);
  const contextCalls: Array<Record<string, unknown>> = [];
  const sourceBaseCalls: Array<Record<string, unknown>> = [];
  const attemptCalls: Array<{
    projectId: string;
    planId: string;
    input: CreateGenerationTaskAttemptInput;
  }> = [];
  const order: string[] = [];
  const projectPlans = new Map([
    ["project-a", [planA.id]],
    ["project-b", [planB.id]],
  ]);
  const service = new GenerationPlanService({
    store: storePort({
      listActiveGenerationPlanIdsForProject(projectId: string) {
        return projectPlans.get(projectId) ?? [];
      },
      listGenerationTaskIdsReadyForMaterializationForProject(_projectId: string, planId: string) {
        return detailByPlan.get(planId)?.tasks.map((task) => task.id) ?? [];
      },
      getGenerationPlanDetailForProject(_projectId: string, planId: string) {
        return detailByPlan.get(planId)!;
      },
      observeGenerationTaskMaterializationForProject(_projectId: string, _planId: string, taskId: string) {
        order.push(`observe:${taskId}`);
        return observations.get(taskId)!;
      },
      createGenerationTaskAttemptForProject(
        projectId: string,
        planId: string,
        input: CreateGenerationTaskAttemptInput,
      ) {
        order.push(`create:${input.taskId}`);
        attemptCalls.push({ projectId, planId, input });
        return attemptFixture(input);
      },
    }),
    projectLookup: {
      listProjectIds: () => ["project-b", "project-a"],
      projectIdForPlan: () => "unused",
    },
    contextResolver: {
      async resolve(input: Record<string, unknown>) {
        const task = input.task as GenerationTask;
        order.push(`context:${task.id}`);
        contextCalls.push(input);
        await Promise.resolve();
        return { id: `context-pack-${task.id}` };
      },
    },
    sourceBaseResolver: {
      async resolve(input: Record<string, unknown>) {
        const task = input.task as GenerationTask;
        order.push(`source:${task.id}`);
        sourceBaseCalls.push(input);
        return { sourceCommitHash: SOURCE_COMMIT_HASH, sourceTreeHash: SOURCE_TREE_HASH };
      },
    },
    rebaseReconciler: idleRebaseReconciler(),
  });

  const summary = await service.materializeReadyTaskAttempts();

  assert.deepEqual(summary, { planIds: [planA.id, planB.id] });
  for (const task of [taskA, taskB]) {
    const observedAt = order.indexOf(`observe:${task.id}`);
    const contextAt = order.indexOf(`context:${task.id}`);
    const sourceAt = order.indexOf(`source:${task.id}`);
    const createdAt = order.indexOf(`create:${task.id}`);
    if (task.target.type === "artifact") {
      assert.ok(observedAt >= 0 && contextAt > observedAt && sourceAt > contextAt && createdAt > sourceAt);
    } else {
      assert.ok(observedAt >= 0 && contextAt > observedAt && sourceAt === -1 && createdAt > contextAt);
    }
  }
  assert.equal(contextCalls.length, 2);
  assert.deepEqual(sourceBaseCalls, [{
    projectId: "project-a",
    planId: planA.id,
    task: taskA,
    observation: observations.get(taskA.id),
  }]);
  for (const [projectId, plan, task] of [
    ["project-a", planA, taskA],
    ["project-b", planB, taskB],
  ] as const) {
    const observation = observations.get(task.id)!;
    const contextCall = contextCalls.find((call) => call.task === task);
    assert.deepEqual(contextCall, { projectId, planId: plan.id, task, observation });
    assert.deepEqual(attemptCalls.find((call) => call.input.taskId === task.id), {
      projectId,
      planId: plan.id,
      input: {
        ...observation,
        contextPackId: `context-pack-${task.id}`,
        ...sourceBaseForTask(task),
        retryContextPolicy: "same-context",
        executionMode: "full",
      },
    });
  }
});

test("GenerationPlanService propagates maintenance cancellation without recording a false failure", {
  timeout: 1_000,
}, async () => {
  const plan = planFixture({ id: "plan-cancel-maintenance", workspaceId: "workspace-1" });
  const task = taskFixture({
    id: "task-cancel-maintenance",
    planId: plan.id,
    workspaceId: plan.workspaceId,
  });
  const observation = observationFixture(task);
  let resolveEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    resolveEntered = resolve;
  });
  let resolverSignal: AbortSignal | null = null;
  let attemptWrites = 0;
  let failureWrites = 0;
  let reportedErrors = 0;
  const service = new GenerationPlanService({
    store: storePort({
      listActiveGenerationPlanIdsForProject: () => [plan.id],
      listGenerationTaskIdsReadyForMaterializationForProject: () => [task.id],
      getGenerationPlanDetailForProject: () => ({ plan, tasks: [task], dependencies: [] }),
      observeGenerationTaskMaterializationForProject: () => observation,
      createGenerationTaskAttemptForProject(_projectId, _planId, input) {
        attemptWrites += 1;
        return attemptFixture(input);
      },
      recordGenerationTaskMaterializationFailureForProject(_projectId, _planId, input) {
        failureWrites += 1;
        return failureFixture(task, input);
      },
    }),
    projectLookup: {
      listProjectIds: () => ["project-1"],
      projectIdForPlan: () => "project-1",
    },
    contextResolver: {
      resolve(_input, signal) {
        resolverSignal = signal;
        resolveEntered();
        return new Promise(() => {});
      },
    },
    sourceBaseResolver: {
      resolve: async () => assert.fail("Source Base resolution must not follow an aborted Context"),
    },
    rebaseReconciler: idleRebaseReconciler(),
    onError: () => {
      reportedErrors += 1;
    },
  });
  const controller = new AbortController();
  const materialization = service.materializeReadyTaskAttempts(controller.signal);
  await entered;
  const reason = new Error("daemon shutdown");
  controller.abort(reason);

  await assert.rejects(materialization, (error: unknown) => error === reason);
  assert.strictEqual(resolverSignal, controller.signal);
  assert.equal(attemptWrites, 0);
  assert.equal(failureWrites, 0);
  assert.equal(reportedErrors, 0);
});

test("GenerationPlanService materializes validation and checkpoint Tasks without resolving Agent Context", async () => {
  const plan = planFixture({ id: "plan-non-agent", workspaceId: "workspace-1" });
  const workspaceTarget: GenerationTaskTarget = {
    type: "workspace",
    workspaceId: plan.workspaceId,
    id: plan.workspaceId,
  };
  const validation = taskFixture({
    id: "task-validation",
    planId: plan.id,
    workspaceId: plan.workspaceId,
    kind: "prototype-validation",
    target: workspaceTarget,
  });
  const checkpoint = taskFixture({
    id: "task-checkpoint",
    planId: plan.id,
    workspaceId: plan.workspaceId,
    kind: "checkpoint",
    target: workspaceTarget,
  });
  const tasks = [validation, checkpoint];
  const observations = new Map(tasks.map((task) => [task.id, observationFixture(task)]));
  const attemptInputs: CreateGenerationTaskAttemptInput[] = [];
  let contextCalls = 0;
  let sourceBaseCalls = 0;
  const service = new GenerationPlanService({
    store: storePort({
      listActiveGenerationPlanIdsForProject: () => [plan.id],
      listGenerationTaskIdsReadyForMaterializationForProject: () => tasks.map((task) => task.id),
      getGenerationPlanDetailForProject: () => ({ plan, tasks, dependencies: [] }),
      observeGenerationTaskMaterializationForProject(_projectId: string, _planId: string, taskId: string) {
        return observations.get(taskId)!;
      },
      createGenerationTaskAttemptForProject(
        _projectId: string,
        _planId: string,
        input: CreateGenerationTaskAttemptInput,
      ) {
        attemptInputs.push(input);
        return attemptFixture(input);
      },
    }),
    projectLookup: {
      listProjectIds: () => ["project-1"],
      projectIdForPlan: () => "project-1",
    },
    contextResolver: {
      async resolve() {
        contextCalls += 1;
        throw new Error("non-Agent Tasks must not request Context");
      },
    },
    sourceBaseResolver: {
      async resolve() {
        sourceBaseCalls += 1;
        throw new Error("non-Artifact Tasks must not resolve a Git Source Base");
      },
    },
    rebaseReconciler: idleRebaseReconciler(),
  });

  const summary = await service.materializeReadyTaskAttempts();

  assert.deepEqual(summary, { planIds: [plan.id] });
  assert.equal(contextCalls, 0);
  assert.equal(sourceBaseCalls, 0);
  assert.deepEqual(attemptInputs, tasks.map((task) => ({
    ...observations.get(task.id)!,
    contextPackId: null,
    sourceCommitHash: null,
    sourceTreeHash: null,
    retryContextPolicy: "same-context",
    executionMode: "full",
  })));
});

test("GenerationPlanService reuses Context but resolves the observed Artifact Source Base for same-context materialization", async () => {
  const plan = planFixture({ id: "plan-same-context", workspaceId: "workspace-1" });
  const task = taskFixture({
    id: "task-page-same-context",
    planId: plan.id,
    workspaceId: plan.workspaceId,
    currentAttempt: 1,
    pendingContextPolicy: "same-context",
  });
  const observation = {
    ...observationFixture(task),
    baseRevisionId: "revision-after-head-drift",
  };
  const priorAttempt: GenerationTaskAttempt = {
    ...attemptFixture({
      ...observation,
      attempt: 1,
      contextPackId: "context-pack-prior",
      baseRevisionId: "revision-before-head-drift",
      sourceCommitHash: SOURCE_COMMIT_HASH,
      sourceTreeHash: SOURCE_TREE_HASH,
      retryContextPolicy: "same-context",
      executionMode: "full",
    }),
    status: "failed",
    finishedAt: 9_999,
  };
  const created: CreateGenerationTaskAttemptInput[] = [];
  let contextCalls = 0;
  let sourceBaseCalls = 0;
  const service = new GenerationPlanService({
    store: storePort({
      listActiveGenerationPlanIdsForProject: () => [plan.id],
      listGenerationTaskIdsReadyForMaterializationForProject: () => [task.id],
      getGenerationPlanDetailForProject: () => ({ plan, tasks: [task], dependencies: [] }),
      observeGenerationTaskMaterializationForProject: () => observation,
      getGenerationTaskAttemptForProject(projectId, planId, taskId, attempt) {
        assert.deepEqual(
          { projectId, planId, taskId, attempt },
          { projectId: "project-1", planId: plan.id, taskId: task.id, attempt: 1 },
        );
        return priorAttempt;
      },
      createGenerationTaskAttemptForProject(_projectId, _planId, input) {
        created.push(input);
        return attemptFixture(input);
      },
    }),
    projectLookup: {
      listProjectIds: () => ["project-1"],
      projectIdForPlan: () => "project-1",
    },
    contextResolver: {
      async resolve() {
        contextCalls += 1;
        return { id: "context-pack-must-not-be-used" };
      },
    },
    sourceBaseResolver: {
      async resolve(request) {
        sourceBaseCalls += 1;
        assert.equal(request.observation, observation);
        return { sourceCommitHash: "c".repeat(40), sourceTreeHash: "d".repeat(40) };
      },
    },
    rebaseReconciler: idleRebaseReconciler(),
  });

  await service.materializeReadyTaskAttempts();

  assert.equal(contextCalls, 0);
  assert.equal(sourceBaseCalls, 1);
  assert.deepEqual(created, [{
    ...observation,
    contextPackId: priorAttempt.contextPackId,
    sourceCommitHash: "c".repeat(40),
    sourceTreeHash: "d".repeat(40),
    retryContextPolicy: "same-context",
    executionMode: "full",
  }]);
});

test("GenerationPlanService resolves a fresh Context Pack for latest-context materialization", async () => {
  const plan = planFixture({ id: "plan-latest-context", workspaceId: "workspace-1" });
  const task = taskFixture({
    id: "task-page-latest-context",
    planId: plan.id,
    workspaceId: plan.workspaceId,
    currentAttempt: 1,
    pendingContextPolicy: "latest-context",
  });
  const observation = observationFixture(task);
  const priorAttempt = attemptFixture({
    ...observation,
    attempt: 1,
    contextPackId: "context-pack-prior",
    sourceCommitHash: "1".repeat(40),
    sourceTreeHash: "2".repeat(40),
    retryContextPolicy: "same-context",
    executionMode: "full",
  });
  const contextRequests: Array<Record<string, unknown>> = [];
  const sourceBaseRequests: Array<Record<string, unknown>> = [];
  const created: CreateGenerationTaskAttemptInput[] = [];
  const service = new GenerationPlanService({
    store: storePort({
      listActiveGenerationPlanIdsForProject: () => [plan.id],
      listGenerationTaskIdsReadyForMaterializationForProject: () => [task.id],
      getGenerationPlanDetailForProject: () => ({ plan, tasks: [task], dependencies: [] }),
      observeGenerationTaskMaterializationForProject: () => observation,
      getGenerationTaskAttemptForProject: () => priorAttempt,
      createGenerationTaskAttemptForProject(_projectId, _planId, input) {
        created.push(input);
        return attemptFixture(input);
      },
    }),
    projectLookup: {
      listProjectIds: () => ["project-1"],
      projectIdForPlan: () => "project-1",
    },
    contextResolver: {
      async resolve(input: Record<string, unknown>) {
        contextRequests.push(input);
        return { id: "context-pack-fresh" };
      },
    },
    sourceBaseResolver: {
      async resolve(input: Record<string, unknown>) {
        sourceBaseRequests.push(input);
        return { sourceCommitHash: SOURCE_COMMIT_HASH, sourceTreeHash: SOURCE_TREE_HASH };
      },
    },
    rebaseReconciler: idleRebaseReconciler(),
  });

  await service.materializeReadyTaskAttempts();

  assert.deepEqual(contextRequests, [{ projectId: "project-1", planId: plan.id, task, observation }]);
  assert.deepEqual(sourceBaseRequests, [{ projectId: "project-1", planId: plan.id, task, observation }]);
  assert.deepEqual(created, [{
    ...observation,
    contextPackId: "context-pack-fresh",
    sourceCommitHash: SOURCE_COMMIT_HASH,
    sourceTreeHash: SOURCE_TREE_HASH,
    retryContextPolicy: "latest-context",
    executionMode: "full",
  }]);
});

test("GenerationPlanService rejects a non-exact Source Base resolver result before Attempt creation", async () => {
  const plan = planFixture({ id: "plan-invalid-source-base", workspaceId: "workspace-1" });
  const task = taskFixture({
    id: "task-invalid-source-base",
    planId: plan.id,
    workspaceId: plan.workspaceId,
  });
  const observation = observationFixture(task);
  const failures: RecordGenerationTaskMaterializationFailureInput[] = [];
  let createCalls = 0;
  const service = new GenerationPlanService({
    store: storePort({
      listActiveGenerationPlanIdsForProject: () => [plan.id],
      listGenerationTaskIdsReadyForMaterializationForProject: () => [task.id],
      getGenerationPlanDetailForProject: () => ({ plan, tasks: [task], dependencies: [] }),
      observeGenerationTaskMaterializationForProject: () => observation,
      createGenerationTaskAttemptForProject() {
        createCalls += 1;
        throw new Error("Attempt creation must not receive an invalid Source Base");
      },
      recordGenerationTaskMaterializationFailureForProject(_projectId, _planId, input) {
        failures.push(input);
        return failureFixture(task, input);
      },
    }),
    projectLookup: {
      listProjectIds: () => ["project-1"],
      projectIdForPlan: () => "project-1",
    },
    contextResolver: { resolve: async () => ({ id: "context-pack-valid" }) },
    sourceBaseResolver: {
      resolve: async () => ({
        sourceCommitHash: "A".repeat(40),
        sourceTreeHash: SOURCE_TREE_HASH,
        unexpected: true,
      }),
    },
    rebaseReconciler: idleRebaseReconciler(),
  });

  await service.materializeReadyTaskAttempts();

  assert.equal(createCalls, 0);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]?.error.message), /Source Base resolver.*invalid|exact Git object/i);
});

test("GenerationPlanService rejects a mixed SHA-1/SHA-256 Source Base before Attempt creation", async () => {
  const plan = planFixture({ id: "plan-mixed-source-base", workspaceId: "workspace-1" });
  const task = taskFixture({
    id: "task-mixed-source-base",
    planId: plan.id,
    workspaceId: plan.workspaceId,
  });
  const observation = observationFixture(task);
  const failures: RecordGenerationTaskMaterializationFailureInput[] = [];
  let createCalls = 0;
  const service = new GenerationPlanService({
    store: storePort({
      listActiveGenerationPlanIdsForProject: () => [plan.id],
      listGenerationTaskIdsReadyForMaterializationForProject: () => [task.id],
      getGenerationPlanDetailForProject: () => ({ plan, tasks: [task], dependencies: [] }),
      observeGenerationTaskMaterializationForProject: () => observation,
      createGenerationTaskAttemptForProject() {
        createCalls += 1;
        throw new Error("Attempt creation must not receive a mixed-format Source Base");
      },
      recordGenerationTaskMaterializationFailureForProject(_projectId, _planId, input) {
        failures.push(input);
        return failureFixture(task, input);
      },
    }),
    projectLookup: {
      listProjectIds: () => ["project-1"],
      projectIdForPlan: () => "project-1",
    },
    contextResolver: { resolve: async () => ({ id: "context-pack-valid" }) },
    sourceBaseResolver: {
      resolve: async () => ({
        sourceCommitHash: "a".repeat(40),
        sourceTreeHash: "b".repeat(64),
      }),
    },
    rebaseReconciler: idleRebaseReconciler(),
  });

  await service.materializeReadyTaskAttempts();

  assert.equal(createCalls, 0);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]?.error.message), /Source Base.*invalid|Git object/i);
});

test("GenerationPlanService resolves a current Source Base when a same-context predecessor is legacy-nullable", async () => {
  const plan = planFixture({ id: "plan-legacy-source-base", workspaceId: "workspace-1" });
  const task = taskFixture({
    id: "task-legacy-source-base",
    planId: plan.id,
    workspaceId: plan.workspaceId,
    currentAttempt: 1,
    pendingContextPolicy: "same-context",
  });
  const observation = observationFixture(task);
  const priorAttempt: GenerationTaskAttempt = {
    ...attemptFixture({
      ...observation,
      attempt: 1,
      contextPackId: "context-pack-legacy",
      sourceCommitHash: null,
      sourceTreeHash: null,
      retryContextPolicy: "same-context",
      executionMode: "full",
    }),
    status: "failed",
    finishedAt: 9_999,
  };
  const failures: RecordGenerationTaskMaterializationFailureInput[] = [];
  let sourceBaseCalls = 0;
  const created: CreateGenerationTaskAttemptInput[] = [];
  const service = new GenerationPlanService({
    store: storePort({
      listActiveGenerationPlanIdsForProject: () => [plan.id],
      listGenerationTaskIdsReadyForMaterializationForProject: () => [task.id],
      getGenerationPlanDetailForProject: () => ({ plan, tasks: [task], dependencies: [] }),
      observeGenerationTaskMaterializationForProject: () => observation,
      getGenerationTaskAttemptForProject: () => priorAttempt,
      createGenerationTaskAttemptForProject(_projectId, _planId, input) {
        created.push(input);
        return attemptFixture(input);
      },
      recordGenerationTaskMaterializationFailureForProject(_projectId, _planId, input) {
        failures.push(input);
        return failureFixture(task, input);
      },
    }),
    projectLookup: {
      listProjectIds: () => ["project-1"],
      projectIdForPlan: () => "project-1",
    },
    contextResolver: { resolve: async () => ({ id: "unused" }) },
    sourceBaseResolver: {
      async resolve() {
        sourceBaseCalls += 1;
        return { sourceCommitHash: SOURCE_COMMIT_HASH, sourceTreeHash: SOURCE_TREE_HASH };
      },
    },
    rebaseReconciler: idleRebaseReconciler(),
  });

  await service.materializeReadyTaskAttempts();

  assert.equal(sourceBaseCalls, 1);
  assert.equal(failures.length, 0);
  assert.deepEqual(created, [{
    ...observation,
    contextPackId: priorAttempt.contextPackId,
    sourceCommitHash: SOURCE_COMMIT_HASH,
    sourceTreeHash: SOURCE_TREE_HASH,
    retryContextPolicy: "same-context",
    executionMode: "full",
  }]);
});

test("GenerationPlanService records a deterministic materialization conflict when the durable Task is still ready", async () => {
  const plan = planFixture({ id: "plan-deterministic-conflict", workspaceId: "workspace-1" });
  const task = taskFixture({
    id: "task-still-ready",
    planId: plan.id,
    workspaceId: plan.workspaceId,
    materializationFailures: 1,
  });
  let detailReads = 0;
  const failures: RecordGenerationTaskMaterializationFailureInput[] = [];
  const conflict = materializationConflict("Context Pack is scoped to another target");
  const service = new GenerationPlanService({
    store: storePort({
      listActiveGenerationPlanIdsForProject: () => [plan.id],
      listGenerationTaskIdsReadyForMaterializationForProject: () => [task.id],
      getGenerationPlanDetailForProject() {
        detailReads += 1;
        return { plan, tasks: [task], dependencies: [] };
      },
      observeGenerationTaskMaterializationForProject() {
        throw conflict;
      },
      recordGenerationTaskMaterializationFailureForProject(_projectId, _planId, input) {
        failures.push(input);
        return failureFixture(task, input);
      },
    }),
    projectLookup: {
      listProjectIds: () => ["project-1"],
      projectIdForPlan: () => "project-1",
    },
    contextResolver: { resolve: async () => ({ id: "unused" }) },
    sourceBaseResolver: defaultSourceBaseResolver(),
    rebaseReconciler: idleRebaseReconciler(),
  });

  await service.materializeReadyTaskAttempts();

  assert.equal(detailReads, 2, "the conflict must re-read durable Task state before deciding it is benign");
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.taskId, task.id);
  assert.equal(failures[0]?.expectedFailureCount, task.materializationFailures);
  assert.equal(failures[0]?.error.name, conflict.name);
  assert.equal(failures[0]?.error.message, conflict.message);
});

test("GenerationPlanService treats a materialization conflict as benign only after a concurrent winner advances the Task", async () => {
  const plan = planFixture({ id: "plan-concurrent-winner", workspaceId: "workspace-1" });
  const task = taskFixture({ id: "task-raced", planId: plan.id, workspaceId: plan.workspaceId });
  const advanced: GenerationTask = {
    ...task,
    status: "queued",
    currentAttempt: 1,
  };
  let detailReads = 0;
  let reportedErrors = 0;
  const service = new GenerationPlanService({
    store: storePort({
      listActiveGenerationPlanIdsForProject: () => [plan.id],
      listGenerationTaskIdsReadyForMaterializationForProject: () => [task.id],
      getGenerationPlanDetailForProject() {
        detailReads += 1;
        return { plan, tasks: [detailReads === 1 ? task : advanced], dependencies: [] };
      },
      observeGenerationTaskMaterializationForProject() {
        throw materializationConflict("the concurrent winner already created Attempt 1");
      },
    }),
    projectLookup: {
      listProjectIds: () => ["project-1"],
      projectIdForPlan: () => "project-1",
    },
    contextResolver: { resolve: async () => ({ id: "unused" }) },
    sourceBaseResolver: defaultSourceBaseResolver(),
    rebaseReconciler: idleRebaseReconciler(),
    onError: () => {
      reportedErrors += 1;
    },
  });

  await service.materializeReadyTaskAttempts();

  assert.equal(detailReads, 2);
  assert.equal(reportedErrors, 0);
});

test("GenerationPlanService treats a stale materialization conflict as benign after the Plan execution epoch advances", {
  timeout: 1_000,
}, async () => {
  const observedPlan: GenerationPlan = {
    ...planFixture({ id: "plan-concurrent-retry", workspaceId: "workspace-1" }),
    executionEpoch: 1,
  };
  const retriedPlan: GenerationPlan = { ...observedPlan, executionEpoch: 2 };
  const task = taskFixture({
    id: "task-stale-materialization",
    planId: observedPlan.id,
    workspaceId: observedPlan.workspaceId,
  });
  const observation: GenerationTaskMaterializationObservation = {
    ...observationFixture(task),
    executionEpoch: 1,
  };
  let currentPlan = observedPlan;
  let resolveSource!: () => void;
  let markSourceEntered!: () => void;
  const sourceEntered = new Promise<void>((resolve) => {
    markSourceEntered = resolve;
  });
  const releaseSource = new Promise<void>((resolve) => {
    resolveSource = resolve;
  });
  let detailReads = 0;
  let createCalls = 0;
  let failureWrites = 0;
  let reportedErrors = 0;
  const service = new GenerationPlanService({
    store: storePort({
      listActiveGenerationPlanIdsForProject: () => [observedPlan.id],
      listGenerationTaskIdsReadyForMaterializationForProject: () => [task.id],
      getGenerationPlanDetailForProject() {
        detailReads += 1;
        return { plan: currentPlan, tasks: [task], dependencies: [] };
      },
      observeGenerationTaskMaterializationForProject: () => observation,
      createGenerationTaskAttemptForProject() {
        createCalls += 1;
        throw materializationConflict("manual retry advanced the Plan execution epoch");
      },
      recordGenerationTaskMaterializationFailureForProject(_projectId, _planId, input) {
        failureWrites += 1;
        return failureFixture(task, input);
      },
    }),
    projectLookup: {
      listProjectIds: () => ["project-1"],
      projectIdForPlan: () => "project-1",
    },
    contextResolver: { resolve: async () => ({ id: "context-pack-stale" }) },
    sourceBaseResolver: {
      async resolve() {
        markSourceEntered();
        await releaseSource;
        return { sourceCommitHash: SOURCE_COMMIT_HASH, sourceTreeHash: SOURCE_TREE_HASH };
      },
    },
    rebaseReconciler: idleRebaseReconciler(),
    onError: () => {
      reportedErrors += 1;
    },
  });

  const materialization = service.materializeReadyTaskAttempts();
  await sourceEntered;
  currentPlan = retriedPlan;
  resolveSource();
  await materialization;

  assert.equal(detailReads, 2, "the stale create conflict must re-read the current Plan epoch");
  assert.equal(createCalls, 1);
  assert.equal(failureWrites, 0);
  assert.equal(reportedErrors, 0);
});

test("GenerationPlanService discards a stale Context failure after the Plan execution epoch advances", {
  timeout: 1_000,
}, async () => {
  const observedPlan: GenerationPlan = {
    ...planFixture({ id: "plan-context-concurrent-retry", workspaceId: "workspace-1" }),
    executionEpoch: 1,
  };
  const task = taskFixture({
    id: "task-stale-context",
    planId: observedPlan.id,
    workspaceId: observedPlan.workspaceId,
  });
  const observation: GenerationTaskMaterializationObservation = {
    ...observationFixture(task),
    executionEpoch: 1,
  };
  let currentPlan = observedPlan;
  let releaseContext!: () => void;
  let markContextEntered!: () => void;
  const contextEntered = new Promise<void>((resolve) => { markContextEntered = resolve; });
  const contextRelease = new Promise<void>((resolve) => { releaseContext = resolve; });
  let failureWrites = 0;
  let reportedErrors = 0;
  const service = new GenerationPlanService({
    store: storePort({
      listActiveGenerationPlanIdsForProject: () => [observedPlan.id],
      listGenerationTaskIdsReadyForMaterializationForProject: () => [task.id],
      getGenerationPlanDetailForProject: () => ({ plan: currentPlan, tasks: [task], dependencies: [] }),
      observeGenerationTaskMaterializationForProject: () => observation,
      recordGenerationTaskMaterializationFailureForProject(_projectId, _planId, input) {
        failureWrites += 1;
        return failureFixture(task, input);
      },
    }),
    projectLookup: {
      listProjectIds: () => ["project-1"],
      projectIdForPlan: () => "project-1",
    },
    contextResolver: {
      async resolve() {
        markContextEntered();
        await contextRelease;
        throw new BlockedContextError(["resource-stale"], "old epoch context is unavailable");
      },
    },
    sourceBaseResolver: defaultSourceBaseResolver(),
    rebaseReconciler: idleRebaseReconciler(),
    onError: () => { reportedErrors += 1; },
  });

  const materialization = service.materializeReadyTaskAttempts();
  await contextEntered;
  currentPlan = { ...observedPlan, executionEpoch: 2 };
  releaseContext();
  await materialization;

  assert.equal(failureWrites, 0);
  assert.equal(reportedErrors, 0);
});

test("GenerationPlanService delegates rebase disposition and materializes latest-context refresh only in that pass", async () => {
  const plan = planFixture({ id: "plan-rebase", workspaceId: "workspace-1" });
  const regular = taskFixture({ id: "task-regular", planId: plan.id, workspaceId: plan.workspaceId });
  const needsRebase = taskFixture({
    id: "task-needs-rebase",
    planId: plan.id,
    workspaceId: plan.workspaceId,
    status: "needs-rebase",
    currentAttempt: 1,
  });
  const awaitingRefresh = taskFixture({
    id: "task-awaiting-refresh",
    planId: plan.id,
    workspaceId: plan.workspaceId,
    status: "awaiting-context-refresh",
    currentAttempt: 1,
    pendingContextPolicy: "latest-context",
  });
  const tasks = [regular, needsRebase, awaitingRefresh];
  const regularObservation = observationFixture(regular);
  const refreshObservation = observationFixture(awaitingRefresh);
  const createdTaskIds: string[] = [];
  let rebaseCalls = 0;
  const service = new GenerationPlanService({
    store: storePort({
      listActiveGenerationPlanIdsForProject: () => [plan.id],
      listGenerationTaskIdsReadyForMaterializationForProject: () => tasks.map((task) => task.id),
      getGenerationPlanDetailForProject: () => ({ plan, tasks, dependencies: [] }),
      observeGenerationTaskMaterializationForProject(_projectId, _planId, taskId) {
        if (taskId === regular.id) return regularObservation;
        if (taskId === awaitingRefresh.id) return refreshObservation;
        return assert.fail("needs-rebase must receive a durable disposition before materialization");
      },
      createGenerationTaskAttemptForProject(_projectId, _planId, input) {
        createdTaskIds.push(input.taskId);
        return attemptFixture(input);
      },
    }),
    projectLookup: {
      listProjectIds: () => ["project-1"],
      projectIdForPlan: () => "project-1",
    },
    contextResolver: {
      resolve: async ({ task }: { task: GenerationTask }) => ({ id: `context-pack-${task.id}` }),
    },
    sourceBaseResolver: defaultSourceBaseResolver(),
    rebaseReconciler: {
      async reconcileNeedsRebaseTasks() {
        rebaseCalls += 1;
        return { planIds: ["plan-rebased-by-dedicated-port"] };
      },
    },
  });

  const materialized = await service.materializeReadyTaskAttempts();
  assert.deepEqual(materialized, { planIds: [plan.id] });
  assert.deepEqual(createdTaskIds, [regular.id]);

  const reconciled = await service.reconcileNeedsRebaseTasks();
  assert.equal(rebaseCalls, 1);
  assert.deepEqual(reconciled, {
    planIds: ["plan-rebased-by-dedicated-port", plan.id].sort(),
  });
  assert.deepEqual(
    createdTaskIds,
    [regular.id, awaitingRefresh.id],
    "latest-context refresh must materialize only after the dedicated rebase disposition",
  );
});

for (const contextFailure of [
  {
    label: "blocked",
    failureClass: "context",
    error: new BlockedContextError(
      ["resource-required"],
      "Required Context resource-required could not be resolved",
    ),
  },
  {
    label: "transient adapter",
    failureClass: "adapter",
    error: new Error("Context adapter timed out"),
  },
] as const) {
  test(`GenerationPlanService durably records one ${contextFailure.label} Context failure and still materializes its sibling`, async () => {
    const plan = planFixture({ id: `plan-${contextFailure.label}`, workspaceId: "workspace-1" });
    const failing = taskFixture({
      id: "task-context-failure",
      planId: plan.id,
      workspaceId: plan.workspaceId,
      materializationFailures: 2,
    });
    const sibling = taskFixture({ id: "task-sibling", planId: plan.id, workspaceId: plan.workspaceId });
    const tasks = [failing, sibling];
    const observations = new Map(tasks.map((task) => [task.id, observationFixture(task)]));
    const failures: Array<{
      projectId: string;
      planId: string;
      input: RecordGenerationTaskMaterializationFailureInput;
    }> = [];
    const materialized: CreateGenerationTaskAttemptInput[] = [];
    const service = new GenerationPlanService({
      store: storePort({
        listActiveGenerationPlanIdsForProject: () => [plan.id],
        listGenerationTaskIdsReadyForMaterializationForProject: () => tasks.map((task) => task.id),
        getGenerationPlanDetailForProject: () => ({ plan, tasks, dependencies: [] }),
        observeGenerationTaskMaterializationForProject(_projectId: string, _planId: string, taskId: string) {
          return observations.get(taskId)!;
        },
        createGenerationTaskAttemptForProject(
          _projectId: string,
          _planId: string,
          input: CreateGenerationTaskAttemptInput,
        ) {
          materialized.push(input);
          return attemptFixture(input);
        },
        recordGenerationTaskMaterializationFailureForProject(
          projectId: string,
          planId: string,
          input: RecordGenerationTaskMaterializationFailureInput,
        ) {
          failures.push({ projectId, planId, input });
          return failureFixture(failing, input);
        },
      }),
      projectLookup: {
        listProjectIds: () => ["project-1"],
        projectIdForPlan: () => "project-1",
      },
      contextResolver: {
        async resolve(input: { task: GenerationTask }) {
          if (input.task.id === failing.id) throw contextFailure.error;
          return { id: "context-pack-sibling" };
        },
      },
      sourceBaseResolver: defaultSourceBaseResolver(),
      rebaseReconciler: idleRebaseReconciler(),
    });

    const summary = await service.materializeReadyTaskAttempts();

    assert.deepEqual(summary, { planIds: [plan.id] });
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.projectId, "project-1");
    assert.equal(failures[0]?.planId, plan.id);
    assert.equal(failures[0]?.input.taskId, failing.id);
    assert.equal(failures[0]?.input.expectedFailureCount, 2);
    assert.equal(failures[0]?.input.failureClass, contextFailure.failureClass);
    assert.equal(failures[0]?.input.nextEligibleAt, null);
    assert.equal(failures[0]?.input.error.message, contextFailure.error.message);
    if (contextFailure.error instanceof BlockedContextError) {
      assert.deepEqual(failures[0]?.input.error.refs, ["resource-required"]);
    }
    assert.deepEqual(materialized, [{
      ...observations.get(sibling.id)!,
      contextPackId: "context-pack-sibling",
      ...sourceBaseForTask(sibling),
      retryContextPolicy: "same-context",
      executionMode: "full",
    }]);
  });
}
