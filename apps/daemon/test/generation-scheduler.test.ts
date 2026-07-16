import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GenerationTaskLeaseFenceError,
  normalizeGenerationTaskIntent,
  type GenerationTask,
  type GenerationTaskAttempt,
  type GenerationTaskAttemptClaim,
  type GenerationTaskRecoverySummary,
} from "../../../packages/core/src/index.ts";
import { GenerationScheduler } from "../src/orchestration/generation-scheduler.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function emptyRecoverySummary(): GenerationTaskRecoverySummary {
  return {
    planIds: [],
    retriedTaskIds: [],
    needsRebaseTaskIds: [],
    cancelledTaskIds: [],
    failedTaskIds: [],
  };
}

function queuedAttemptFixture(): GenerationTaskAttempt {
  return {
    taskId: "task-page-home",
    planId: "plan-1",
    workspaceId: "workspace-1",
    attempt: 1,
    target: {
      type: "artifact",
      workspaceId: "workspace-1",
      id: "artifact-home",
      trackId: "track-main",
    },
    baseRevisionId: null,
    sourceCommitHash: "a".repeat(40),
    sourceTreeHash: "b".repeat(40),
    expectedSnapshotId: "snapshot-1",
    contextPackId: null,
    kernelRevisionId: "kernel-1",
    payload: { prompt: "Design the home page" },
    dependencyOutputs: [],
    resourcePins: [],
    componentPins: [],
    retryContextPolicy: "same-context",
    executionMode: "full",
    inputHash: "input-hash-1",
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

function claimedAttemptFixture(attempt = queuedAttemptFixture()): GenerationTaskAttemptClaim {
  const lease = {
    taskId: attempt.taskId,
    workspaceId: attempt.workspaceId,
    attempt: attempt.attempt,
    ownerId: "daemon-owner-1",
    leaseToken: "lease-token-1",
  } as const;
  const leaseExpiresAt = 40_000;
  const task: GenerationTask = {
    ...normalizeGenerationTaskIntent({
      id: attempt.taskId,
      ordinal: 0,
      workspaceId: attempt.workspaceId,
      planId: attempt.planId,
      kind: "page",
      target: attempt.target,
      dependencyIds: [],
      payload: attempt.payload,
      capabilities: ["generate"],
      qaProfile: {
        requiredFrameIds: [],
        blockingSeverities: [],
        requireRuntimeChecks: false,
        requireVisualReview: false,
      },
      resourceLimits: {
        timeoutMs: 120_000,
        maxAgentTurns: 8,
        maxRepairRounds: 2,
        maxOutputBytes: 8_000_000,
        capacityClasses: ["agent"],
      },
    }),
    status: "running",
    blockedReason: null,
    blockedByTaskId: null,
    pendingContextPolicy: null,
    currentAttempt: attempt.attempt,
    materializationFailures: 0,
    failureClass: null,
    error: null,
    nextEligibleAt: null,
    resultRevisionId: null,
    resultResourceRevisionId: null,
    resultSnapshotId: null,
    createdAt: attempt.createdAt,
    finishedAt: null,
  };
  return {
    task,
    attempt: {
      ...attempt,
      status: "running",
      lease,
      leaseExpiresAt,
      heartbeatAt: 10_000,
      startedAt: 10_000,
    },
    lease,
    claims: [
      {
        ...lease,
        planId: attempt.planId,
        claimKey: "capacity:agent:1",
        claimKind: "capacity",
        leaseExpiresAt,
        createdAt: 10_000,
      },
      {
        ...lease,
        planId: attempt.planId,
        claimKey: "writer:artifact:61727469666163742d686f6d65:747261636b2d6d61696e",
        claimKind: "writer",
        leaseExpiresAt,
        createdAt: 10_000,
      },
    ],
  };
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

test("GenerationScheduler coalesces startup-barrier wakeups without touching durable admission before start", async () => {
  const attempt = queuedAttemptFixture();
  const claim = claimedAttemptFixture(attempt);
  const allowStartupRecovery = deferred();
  const calls = {
    recover: 0,
    reconcile: 0,
    materialize: 0,
    listReady: 0,
    registerOperation: 0,
    claim: 0,
    execute: 0,
    release: 0,
  };
  const scheduler = new GenerationScheduler({
    store: {
      recoverExpiredGenerationTaskAttempts() {
        calls.recover += 1;
        return emptyRecoverySummary();
      },
      listReadyGenerationTaskAttempts() {
        calls.listReady += 1;
        return [attempt];
      },
      tryClaimGenerationTaskAttempt() {
        calls.claim += 1;
        return claim;
      },
      heartbeatGenerationTaskAttempt: () => claim,
      releaseGenerationTaskAttemptClaims() {
        calls.release += 1;
        return true;
      },
    },
    planService: {
      async reconcileNeedsRebaseTasks() {
        calls.reconcile += 1;
        return { planIds: [] };
      },
      async materializeReadyTaskAttempts() {
        calls.materialize += 1;
        return { planIds: [] };
      },
    },
    runtimeSupervisor: {
      trackOperation(_scope, start) {
        calls.registerOperation += 1;
        return Promise.resolve().then(() => start(new AbortController().signal));
      },
    },
    executor: {
      async execute() {
        calls.execute += 1;
      },
    },
    events: { notify() {} },
    projectIdForWorkspace: () => "project-1",
    ownerId: "daemon-owner-1",
    clock: { now: () => 10_000 },
    leaseMs: 30_000,
    heartbeatMs: 10_000,
  });
  const startup = allowStartupRecovery.promise.then(() => scheduler.start());

  scheduler.requestTick();
  scheduler.requestTick();
  await Promise.all([scheduler.tick(), scheduler.tick()]);

  assert.deepEqual(calls, {
    recover: 0,
    reconcile: 0,
    materialize: 0,
    listReady: 0,
    registerOperation: 0,
    claim: 0,
    execute: 0,
    release: 0,
  });

  allowStartupRecovery.resolve();
  await startup;
  scheduler.start();
  await scheduler.tick();
  await waitFor(() => calls.release === 1, "the coalesced startup wake did not settle");
  await scheduler.stop();

  assert.deepEqual(calls, {
    recover: 1,
    reconcile: 1,
    materialize: 1,
    listReady: 1,
    registerOperation: 1,
    claim: 1,
    execute: 1,
    release: 1,
  });
});

test("GenerationScheduler stop before start permanently fences admission and remains idempotent", async () => {
  let storeCalls = 0;
  const scheduler = new GenerationScheduler({
    store: {
      recoverExpiredGenerationTaskAttempts() {
        storeCalls += 1;
        return emptyRecoverySummary();
      },
      listReadyGenerationTaskAttempts() {
        storeCalls += 1;
        return [];
      },
      tryClaimGenerationTaskAttempt() {
        storeCalls += 1;
        return null;
      },
      heartbeatGenerationTaskAttempt: () => claimedAttemptFixture(),
      releaseGenerationTaskAttemptClaims: () => true,
    },
    planService: {
      reconcileNeedsRebaseTasks: async () => ({ planIds: [] }),
      materializeReadyTaskAttempts: async () => ({ planIds: [] }),
    },
    runtimeSupervisor: {
      trackOperation(_scope, start) {
        return Promise.resolve().then(() => start(new AbortController().signal));
      },
    },
    executor: { execute: async () => {} },
    events: { notify() {} },
    projectIdForWorkspace: () => "project-1",
    ownerId: "daemon-owner-1",
    clock: { now: () => 10_000 },
    leaseMs: 30_000,
    heartbeatMs: 10_000,
  });

  scheduler.requestTick();
  await scheduler.tick();
  await Promise.all([scheduler.stop(), scheduler.stop()]);
  scheduler.requestTick();
  await scheduler.tick();
  assert.throws(() => scheduler.start(), /cannot restart after stop/i);
  await scheduler.stop();

  assert.equal(storeCalls, 0);
});

test("GenerationScheduler stop aborts an in-flight maintenance pass even when its port never settles", {
  timeout: 1_000,
}, async () => {
  const entered = deferred();
  const maintenanceSignals: AbortSignal[] = [];
  let reportedErrors = 0;
  let materializationCalls = 0;
  let readyReads = 0;
  const scheduler = new GenerationScheduler({
    store: {
      recoverExpiredGenerationTaskAttempts: emptyRecoverySummary,
      listReadyGenerationTaskAttempts() {
        readyReads += 1;
        return [];
      },
      tryClaimGenerationTaskAttempt: () => null,
      heartbeatGenerationTaskAttempt: () => claimedAttemptFixture(),
      releaseGenerationTaskAttemptClaims: () => true,
    },
    planService: {
      reconcileNeedsRebaseTasks(signal) {
        maintenanceSignals.push(signal);
        entered.resolve();
        return new Promise(() => {});
      },
      async materializeReadyTaskAttempts() {
        materializationCalls += 1;
        return { planIds: [] };
      },
    },
    runtimeSupervisor: {
      trackOperation(_scope, start) {
        return Promise.resolve().then(() => start(new AbortController().signal));
      },
    },
    executor: { execute: async () => {} },
    events: { notify() {} },
    projectIdForWorkspace: () => "project-1",
    ownerId: "daemon-owner-1",
    clock: { now: () => 10_000 },
    leaseMs: 30_000,
    heartbeatMs: 10_000,
    onError: () => {
      reportedErrors += 1;
    },
  });

  scheduler.start();
  await entered.promise;
  await scheduler.stop();

  assert.equal(maintenanceSignals.length, 1);
  assert.equal(maintenanceSignals[0]?.aborted, true);
  assert.equal(materializationCalls, 0);
  assert.equal(readyReads, 0);
  assert.equal(reportedErrors, 0);
});

test("GenerationScheduler coalesces concurrent ticks and orders recovery, reconciliation, materialization, then claim", async () => {
  const order: string[] = [];
  const materializationEntered = deferred();
  const allowMaterialization = deferred();
  const attempt = queuedAttemptFixture();
  const claim = claimedAttemptFixture(attempt);
  const runtimeController = new AbortController();
  const scheduler = new GenerationScheduler({
    store: {
      recoverExpiredGenerationTaskAttempts(now: number) {
        assert.equal(now, 10_000);
        order.push("recover");
        return emptyRecoverySummary();
      },
      listReadyGenerationTaskAttempts() {
        order.push("list-ready");
        return [attempt];
      },
      tryClaimGenerationTaskAttempt(input: {
        taskId: string;
        attempt: number;
        ownerId: string;
        now: number;
        leaseMs: number;
      }) {
        order.push("claim");
        assert.deepEqual(input, {
          taskId: attempt.taskId,
          attempt: attempt.attempt,
          ownerId: "daemon-owner-1",
          now: 10_000,
          leaseMs: 30_000,
        });
        return claim;
      },
      heartbeatGenerationTaskAttempt() {
        return claim;
      },
      releaseGenerationTaskAttemptClaims() {
        order.push("release");
        return true;
      },
    },
    planService: {
      async reconcileNeedsRebaseTasks() {
        order.push("reconcile");
        return { planIds: [] };
      },
      async materializeReadyTaskAttempts() {
        order.push("materialize");
        materializationEntered.resolve();
        await allowMaterialization.promise;
        return { planIds: [] };
      },
    },
    runtimeSupervisor: {
      trackOperation(scope, start) {
        order.push("register-operation");
        assert.deepEqual(scope, {
          projectId: "project-1",
          planId: attempt.planId,
          taskId: attempt.taskId,
          artifactId: "artifact-home",
        });
        return Promise.resolve().then(() => start(runtimeController.signal));
      },
    },
    executor: {
      async execute(actualClaim, signal) {
        order.push("execute");
        assert.equal(actualClaim, claim);
        assert.equal(signal.aborted, false);
      },
    },
    events: { notify() {} },
    projectIdForWorkspace(workspaceId: string) {
      assert.equal(workspaceId, attempt.workspaceId);
      return "project-1";
    },
    ownerId: "daemon-owner-1",
    clock: { now: () => 10_000 },
    leaseMs: 30_000,
    heartbeatMs: 10_000,
  });

  scheduler.start();
  const first = scheduler.tick();
  await materializationEntered.promise;
  const second = scheduler.tick();
  allowMaterialization.resolve();
  await Promise.all([first, second]);
  await waitFor(() => order.includes("release"), "the admitted task did not settle");
  await scheduler.stop();

  assert.deepEqual(order, [
    "recover",
    "reconcile",
    "materialize",
    "list-ready",
    "register-operation",
    "claim",
    "execute",
    "release",
  ]);
});

test("GenerationScheduler preserves a requestTick wake that arrives during an active pass", async () => {
  const firstMaterialization = deferred();
  const allowFirstPass = deferred();
  let recoveryPasses = 0;
  let materializationPasses = 0;
  const scheduler = new GenerationScheduler({
    store: {
      recoverExpiredGenerationTaskAttempts() {
        recoveryPasses += 1;
        return emptyRecoverySummary();
      },
      listReadyGenerationTaskAttempts: () => [],
      tryClaimGenerationTaskAttempt: () => null,
      heartbeatGenerationTaskAttempt: () => claimedAttemptFixture(),
      releaseGenerationTaskAttemptClaims: () => true,
    },
    planService: {
      reconcileNeedsRebaseTasks: async () => ({ planIds: [] }),
      async materializeReadyTaskAttempts() {
        materializationPasses += 1;
        if (materializationPasses === 1) {
          firstMaterialization.resolve();
          await allowFirstPass.promise;
        }
        return { planIds: [] };
      },
    },
    runtimeSupervisor: {
      trackOperation(_scope, start) {
        return Promise.resolve().then(() => start(new AbortController().signal));
      },
    },
    executor: { execute: async () => {} },
    events: { notify() {} },
    projectIdForWorkspace: () => "project-1",
    ownerId: "daemon-owner-1",
    clock: { now: () => 10_000 },
    leaseMs: 30_000,
    heartbeatMs: 10_000,
  });

  scheduler.start();
  const activePass = scheduler.tick();
  await firstMaterialization.promise;
  scheduler.requestTick();
  allowFirstPass.resolve();
  await activePass;
  await scheduler.stop();

  assert.equal(recoveryPasses, 2);
  assert.equal(materializationPasses, 2);
});

test("GenerationScheduler registers RuntimeSupervisor ownership before it attempts a durable claim", async () => {
  const order: string[] = [];
  const attempt = queuedAttemptFixture();
  const claim = claimedAttemptFixture(attempt);
  const scheduler = new GenerationScheduler({
    store: {
      recoverExpiredGenerationTaskAttempts: emptyRecoverySummary,
      listReadyGenerationTaskAttempts: () => [attempt],
      tryClaimGenerationTaskAttempt() {
        order.push("claim");
        return claim;
      },
      heartbeatGenerationTaskAttempt: () => claim,
      releaseGenerationTaskAttemptClaims: () => true,
    },
    planService: {
      reconcileNeedsRebaseTasks: async () => ({ planIds: [] }),
      materializeReadyTaskAttempts: async () => ({ planIds: [] }),
    },
    runtimeSupervisor: {
      trackOperation(_scope, start) {
        order.push("register-operation");
        return Promise.resolve().then(() => start(new AbortController().signal));
      },
    },
    executor: { execute: async () => {} },
    events: { notify() {} },
    projectIdForWorkspace: () => "project-1",
    ownerId: "daemon-owner-1",
    clock: { now: () => 10_000 },
    leaseMs: 30_000,
    heartbeatMs: 10_000,
  });

  scheduler.start();
  await scheduler.tick();
  await waitFor(() => order.includes("claim"), "the scheduler did not attempt the claim");
  await scheduler.stop();

  assert.deepEqual(order.slice(0, 2), ["register-operation", "claim"]);
});

test("GenerationScheduler treats event notification as a best-effort wake after the durable claim", async () => {
  const attempt = queuedAttemptFixture();
  const claim = claimedAttemptFixture(attempt);
  const executed = deferred();
  let reportedErrors = 0;
  const scheduler = new GenerationScheduler({
    store: {
      recoverExpiredGenerationTaskAttempts: emptyRecoverySummary,
      listReadyGenerationTaskAttempts: () => [attempt],
      tryClaimGenerationTaskAttempt: () => claim,
      heartbeatGenerationTaskAttempt: () => claim,
      releaseGenerationTaskAttemptClaims: () => true,
    },
    planService: {
      reconcileNeedsRebaseTasks: async () => ({ planIds: [] }),
      materializeReadyTaskAttempts: async () => ({ planIds: [] }),
    },
    runtimeSupervisor: {
      trackOperation(_scope, start) {
        return Promise.resolve().then(() => start(new AbortController().signal));
      },
    },
    executor: {
      async execute() {
        executed.resolve();
      },
    },
    events: {
      notify() {
        throw new Error("listener unavailable");
      },
    },
    projectIdForWorkspace: () => "project-1",
    ownerId: "daemon-owner-1",
    clock: { now: () => 10_000 },
    leaseMs: 30_000,
    heartbeatMs: 10_000,
    onError: () => {
      reportedErrors += 1;
    },
  });

  scheduler.start();
  await scheduler.tick();
  await executed.promise;
  await scheduler.stop();

  assert.equal(reportedErrors, 2);
});

test("GenerationScheduler notifies again when an executor rejects after a durable write may have committed", async () => {
  const attempt = queuedAttemptFixture();
  const claim = claimedAttemptFixture(attempt);
  let notifications = 0;
  let reportedErrors = 0;
  const scheduler = new GenerationScheduler({
    store: {
      recoverExpiredGenerationTaskAttempts: emptyRecoverySummary,
      listReadyGenerationTaskAttempts: () => [attempt],
      tryClaimGenerationTaskAttempt: () => claim,
      heartbeatGenerationTaskAttempt: () => claim,
      releaseGenerationTaskAttemptClaims: () => false,
    },
    planService: {
      reconcileNeedsRebaseTasks: async () => ({ planIds: [] }),
      materializeReadyTaskAttempts: async () => ({ planIds: [] }),
    },
    runtimeSupervisor: {
      trackOperation(_scope, start) {
        return Promise.resolve().then(() => start(new AbortController().signal));
      },
    },
    executor: {
      async execute() {
        throw new Error("publication response was lost");
      },
    },
    events: {
      notify() {
        notifications += 1;
      },
    },
    projectIdForWorkspace: () => "project-1",
    ownerId: "daemon-owner-1",
    clock: { now: () => 10_000 },
    leaseMs: 30_000,
    heartbeatMs: 10_000,
    onError: () => {
      reportedErrors += 1;
    },
  });

  scheduler.start();
  await scheduler.tick();
  await scheduler.stop();

  assert.equal(notifications, 2);
  assert.equal(reportedErrors, 1);
});

test("GenerationScheduler registers a claimed controller before a notification can stop admission", async () => {
  const attempt = queuedAttemptFixture();
  const claim = claimedAttemptFixture(attempt);
  let scheduler!: GenerationScheduler;
  let stopPromise: Promise<void> | null = null;
  let executorCalls = 0;
  let releaseCalls = 0;
  scheduler = new GenerationScheduler({
    store: {
      recoverExpiredGenerationTaskAttempts: emptyRecoverySummary,
      listReadyGenerationTaskAttempts: () => [attempt],
      tryClaimGenerationTaskAttempt: () => claim,
      heartbeatGenerationTaskAttempt: () => claim,
      releaseGenerationTaskAttemptClaims() {
        releaseCalls += 1;
        return false;
      },
    },
    planService: {
      reconcileNeedsRebaseTasks: async () => ({ planIds: [] }),
      materializeReadyTaskAttempts: async () => ({ planIds: [] }),
    },
    runtimeSupervisor: {
      trackOperation(_scope, start) {
        return Promise.resolve().then(() => start(new AbortController().signal));
      },
    },
    executor: {
      async execute() {
        executorCalls += 1;
      },
    },
    events: {
      notify() {
        stopPromise = scheduler.stop();
      },
    },
    projectIdForWorkspace: () => "project-1",
    ownerId: "daemon-owner-1",
    clock: { now: () => 10_000 },
    leaseMs: 30_000,
    heartbeatMs: 10_000,
  });

  scheduler.start();
  await scheduler.tick();
  assert.ok(stopPromise);
  await stopPromise;

  assert.equal(executorCalls, 0);
  assert.equal(releaseCalls, 1);
});

test("GenerationScheduler aborts execution when heartbeat loses the lease fence", async () => {
  const attempt = queuedAttemptFixture();
  const claim = claimedAttemptFixture(attempt);
  const executionStarted = deferred();
  const executionAborted = deferred();
  let heartbeatCalls = 0;
  let releaseCalls = 0;
  const scheduler = new GenerationScheduler({
    store: {
      recoverExpiredGenerationTaskAttempts: emptyRecoverySummary,
      listReadyGenerationTaskAttempts: () => [attempt],
      tryClaimGenerationTaskAttempt: () => claim,
      heartbeatGenerationTaskAttempt() {
        heartbeatCalls += 1;
        throw new GenerationTaskLeaseFenceError(attempt.taskId, attempt.attempt, "superseded in test");
      },
      releaseGenerationTaskAttemptClaims() {
        releaseCalls += 1;
        return false;
      },
    },
    planService: {
      reconcileNeedsRebaseTasks: async () => ({ planIds: [] }),
      materializeReadyTaskAttempts: async () => ({ planIds: [] }),
    },
    runtimeSupervisor: {
      trackOperation(_scope, start) {
        return Promise.resolve().then(() => start(new AbortController().signal));
      },
    },
    executor: {
      execute(_claim, signal) {
        executionStarted.resolve();
        return new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            executionAborted.resolve();
            resolve();
          }, { once: true });
        });
      },
    },
    events: { notify() {} },
    projectIdForWorkspace: () => "project-1",
    ownerId: "daemon-owner-1",
    clock: { now: () => 10_001 },
    leaseMs: 30_000,
    heartbeatMs: 5,
  });

  scheduler.start();
  await scheduler.tick();
  await executionStarted.promise;
  await Promise.race([
    executionAborted.promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("heartbeat fence loss did not abort execution")), 500);
    }),
  ]);
  await waitFor(() => releaseCalls === 1, "the fenced execution did not run exact-lease cleanup");
  await scheduler.stop();

  assert.equal(heartbeatCalls, 1);
  assert.equal(releaseCalls, 1);
});

test("GenerationScheduler stops renewing and aborts a cancel-requested Attempt", async () => {
  const attempt = queuedAttemptFixture();
  const claim = claimedAttemptFixture(attempt);
  const cancelRequestedClaim: GenerationTaskAttemptClaim = {
    ...claim,
    task: { ...claim.task, status: "cancel-requested" },
    attempt: { ...claim.attempt, status: "cancel-requested" },
  };
  const executionStarted = deferred();
  const executionAborted = deferred<unknown>();
  let heartbeatCalls = 0;
  let releaseCalls = 0;
  const scheduler = new GenerationScheduler({
    store: {
      recoverExpiredGenerationTaskAttempts: emptyRecoverySummary,
      listReadyGenerationTaskAttempts: () => [attempt],
      tryClaimGenerationTaskAttempt: () => claim,
      heartbeatGenerationTaskAttempt() {
        heartbeatCalls += 1;
        return cancelRequestedClaim;
      },
      releaseGenerationTaskAttemptClaims() {
        releaseCalls += 1;
        return false;
      },
    },
    planService: {
      reconcileNeedsRebaseTasks: async () => ({ planIds: [] }),
      materializeReadyTaskAttempts: async () => ({ planIds: [] }),
    },
    runtimeSupervisor: {
      trackOperation(_scope, start) {
        return Promise.resolve().then(() => start(new AbortController().signal));
      },
    },
    executor: {
      execute(_claim, signal) {
        executionStarted.resolve();
        return new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            executionAborted.resolve(signal.reason);
            resolve();
          }, { once: true });
        });
      },
    },
    events: { notify() {} },
    projectIdForWorkspace: () => "project-1",
    ownerId: "daemon-owner-1",
    clock: { now: () => 10_001 },
    leaseMs: 30_000,
    heartbeatMs: 5,
  });

  scheduler.start();
  await scheduler.tick();
  await executionStarted.promise;
  const reason = await Promise.race([
    executionAborted.promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("cancel-requested heartbeat did not abort execution")), 500);
    }),
  ]);
  await waitFor(() => releaseCalls === 1, "the cancelled execution did not run exact-lease cleanup");
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  await scheduler.stop();

  assert.match(String(reason), /cancellation requested/i);
  assert.equal(heartbeatCalls, 1);
  assert.equal(releaseCalls, 1);
});

test("GenerationScheduler stop prevents admission after an in-flight maintenance pass", async () => {
  const attempt = queuedAttemptFixture();
  const materializationEntered = deferred();
  const allowMaterialization = deferred();
  let claimCalls = 0;
  let operationRegistrations = 0;
  const scheduler = new GenerationScheduler({
    store: {
      recoverExpiredGenerationTaskAttempts: emptyRecoverySummary,
      listReadyGenerationTaskAttempts: () => [attempt],
      tryClaimGenerationTaskAttempt: () => {
        claimCalls += 1;
        return claimedAttemptFixture(attempt);
      },
      heartbeatGenerationTaskAttempt: () => claimedAttemptFixture(attempt),
      releaseGenerationTaskAttemptClaims: () => true,
    },
    planService: {
      reconcileNeedsRebaseTasks: async () => ({ planIds: [] }),
      async materializeReadyTaskAttempts() {
        materializationEntered.resolve();
        await allowMaterialization.promise;
        return { planIds: [] };
      },
    },
    runtimeSupervisor: {
      trackOperation(_scope, start) {
        operationRegistrations += 1;
        return Promise.resolve().then(() => start(new AbortController().signal));
      },
    },
    executor: { execute: async () => {} },
    events: { notify() {} },
    projectIdForWorkspace: () => "project-1",
    ownerId: "daemon-owner-1",
    clock: { now: () => 10_000 },
    leaseMs: 30_000,
    heartbeatMs: 10_000,
  });

  scheduler.start();
  const ticking = scheduler.tick();
  await materializationEntered.promise;
  const stopping = scheduler.stop();
  allowMaterialization.resolve();
  await Promise.all([ticking, stopping]);
  await scheduler.tick();

  assert.equal(operationRegistrations, 0);
  assert.equal(claimCalls, 0);
});
