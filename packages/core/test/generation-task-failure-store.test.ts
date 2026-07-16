import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  GenerationTaskLeaseFenceError,
  Store,
  type GenerationTaskAttempt,
  type GenerationTaskAttemptClaim,
  type GenerationTaskAttemptLease,
  type GenerationTaskFailureClass,
  type StoreClock,
} from "../src/index.ts";

interface ControlledClock {
  clock: StoreClock;
  set(now: number): void;
}

interface FinishGenerationTaskFailureInput {
  lease: GenerationTaskAttemptLease;
  failure: {
    failureClass: GenerationTaskFailureClass;
    error: Record<string, unknown>;
  };
}

interface GenerationTaskFailureStoreContract {
  finishGenerationTaskAttemptForProject(
    projectId: string,
    planId: string,
    input: FinishGenerationTaskFailureInput,
  ): unknown;
}

function failureApi(store: Store): GenerationTaskFailureStoreContract {
  return store.workspace as unknown as GenerationTaskFailureStoreContract;
}

function controlledClock(prefix: string): ControlledClock {
  let now = 50_000;
  let id = 0;
  return {
    clock: {
      now: () => now,
      id: () => `${prefix}-${++id}`,
    },
    set(value: number) {
      now = value;
    },
  };
}

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function emptyGeneration() {
  return {
    kind: "workspace-generation" as const,
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
  };
}

function createClaimedPageFixture(label: string) {
  const control = controlledClock(`task-failure-${label}`);
  const store = new Store(":memory:", control.clock);
  const project = store.createProject({ name: `Task failure ${label}`, mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);
  const layout = store.workspace.getLayout(project.id);
  const artifactId = `failure-page-${label}`;
  const trackId = `failure-page-track-${label}`;
  const nodeId = `failure-page-node-${label}`;
  const proposal = store.workspace.createProposal({
    projectId: project.id,
    kind: "workspace-generation",
    baseGraphRevision: foundation.graphRevision,
    baseSnapshotId: foundation.activeSnapshotId,
    layoutId: layout.layoutId,
    baseLayoutChecksum: layout.checksum,
    operations: [{
      id: `add-failure-page-${label}`,
      type: "add-node",
      node: {
        id: nodeId,
        kind: "page",
        name: `Failure Page ${label}`,
        artifactId,
        createIdentity: { initialTrackId: trackId },
      },
    }],
    layoutOperations: [],
    generation: {
      ...emptyGeneration(),
      artifactPlans: [{
        operation: "create",
        nodeId,
        artifactId,
        kind: "page",
        name: `Failure Page ${label}`,
        trackId,
        baseRevisionId: null,
        dependsOnArtifactIds: [],
        capabilityIds: [],
        responsiveFrameIds: [],
      }],
    },
    rationale: `Exercise fenced execution failure ${label}`,
    assumptions: [],
  });
  const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
  assert.ok(approved.plan);
  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id);
  const task = compiled.tasks.find((candidate) => candidate.kind === "page");
  const validation = compiled.tasks.find((candidate) => candidate.kind === "prototype-validation");
  const checkpoint = compiled.tasks.find((candidate) => candidate.kind === "checkpoint");
  assert.ok(task);
  assert.ok(validation);
  assert.ok(checkpoint);
  assert.deepEqual(validation.dependencyIds, [task.id]);
  assert.deepEqual(checkpoint.dependencyIds, [validation.id]);

  const observation = store.workspace.observeGenerationTaskMaterializationForProject(
    project.id,
    compiled.plan.id,
    task.id,
  );
  assert.equal(observation.baseRevisionId, null);
  const workspace = store.workspace.getWorkspace(project.id)!;
  const kernel = store.workspace.getKernelRevision(observation.kernelRevisionId);
  assert.ok(kernel);
  const contextPack = store.workspace.persistContextPack({
    id: `failure-context-${label}`,
    workspaceId: workspace.id,
    graphRevision: workspace.graphRevision,
    target: { type: "artifact", id: artifactId },
    intent: "generate",
    messageChecksum: checksum(`failure-message-${label}`),
    items: [{
      ref: { kind: "kernel", id: kernel.id, revisionId: kernel.id },
      resolvedKind: "kernel-revision",
      kernelRevisionId: kernel.id,
      checksum: kernel.checksum,
      reason: "design-kernel",
      trustLevel: "system",
      boundary: {},
      tokenEstimate: 1,
      provenance: {},
      provided: true,
    }],
    omissions: [],
    tokenEstimate: 1,
    manifestPath: `context-packs/failure-${label}.json`,
    hash: checksum(`failure-context-${label}`),
  });
  const attempt = store.workspace.createGenerationTaskAttemptForProject(
    project.id,
    compiled.plan.id,
    {
      ...observation,
      contextPackId: contextPack.id,
      retryContextPolicy: "same-context",
      executionMode: "full",
    },
  );
  const claim = store.workspace.tryClaimGenerationTaskAttempt({
    taskId: task.id,
    attempt: attempt.attempt,
    ownerId: `failure-worker-${label}`,
    now: 100_000,
    leaseMs: 30_000,
  });
  assert.ok(claim);
  control.set(100_001);
  return {
    control,
    store,
    project,
    workspace,
    plan: compiled.plan,
    task,
    validation,
    checkpoint,
    attempt,
    claim,
  };
}

function failureInput(
  claim: GenerationTaskAttemptClaim,
  failureClass: GenerationTaskFailureClass,
  error: Record<string, unknown>,
): FinishGenerationTaskFailureInput {
  return { lease: claim.lease, failure: { failureClass, error } };
}

function rawRows(store: Store, sql: string, ...params: Array<string | number | null>): Array<Record<string, unknown>> {
  return (store.db.prepare(sql).all(...params) as Array<Record<string, unknown>>).map((row) => ({ ...row }));
}

function durableFailureState(store: Store, planId: string) {
  return {
    plan: rawRows(store, "SELECT * FROM generation_plans WHERE id = ?", planId),
    tasks: rawRows(store, "SELECT * FROM generation_tasks WHERE plan_id = ? ORDER BY ordinal", planId),
    attempts: rawRows(
      store,
      "SELECT * FROM generation_task_attempts WHERE plan_id = ? ORDER BY task_id, attempt",
      planId,
    ),
    dependencyOutputs: rawRows(
      store,
      `SELECT output.* FROM generation_task_attempt_dependency_outputs output
       JOIN generation_tasks task ON task.id = output.task_id
       WHERE task.plan_id = ? ORDER BY output.task_id, output.attempt, output.ordinal`,
      planId,
    ),
    resourcePins: rawRows(
      store,
      `SELECT pin.* FROM generation_task_attempt_resource_pins pin
       JOIN generation_tasks task ON task.id = pin.task_id
       WHERE task.plan_id = ? ORDER BY pin.task_id, pin.attempt, pin.ordinal`,
      planId,
    ),
    componentPins: rawRows(
      store,
      `SELECT pin.* FROM generation_task_attempt_component_pins pin
       JOIN generation_tasks task ON task.id = pin.task_id
       WHERE task.plan_id = ? ORDER BY pin.task_id, pin.attempt, pin.ordinal`,
      planId,
    ),
    claims: rawRows(
      store,
      `SELECT claim.* FROM generation_task_claims claim
       JOIN generation_tasks task ON task.id = claim.task_id
       WHERE task.plan_id = ? ORDER BY claim.task_id, claim.attempt, claim.claim_key`,
      planId,
    ),
    events: rawRows(store, "SELECT * FROM generation_plan_events WHERE plan_id = ? ORDER BY sequence", planId),
  };
}

function taskRow(store: Store, taskId: string) {
  const row = store.db.prepare(
    `SELECT status, current_attempt, failure_class, error_json, next_eligible_at,
            blocked_reason, blocked_by_task_id, finished_at
     FROM generation_tasks WHERE id = ?`,
  ).get(taskId) as Record<string, unknown> | undefined;
  assert.ok(row);
  return { ...row };
}

function attemptFor(store: Store, fixture: ReturnType<typeof createClaimedPageFixture>, attempt: number) {
  const value = store.workspace.getGenerationTaskAttemptForProject(
    fixture.project.id,
    fixture.plan.id,
    fixture.task.id,
    attempt,
  );
  assert.ok(value);
  return value;
}

function retryInput(attempt: GenerationTaskAttempt) {
  return {
    target: attempt.target,
    baseRevisionId: attempt.baseRevisionId,
    expectedSnapshotId: attempt.expectedSnapshotId,
    contextPackId: attempt.contextPackId,
    kernelRevisionId: attempt.kernelRevisionId,
    payload: attempt.payload,
    dependencyOutputs: attempt.dependencyOutputs,
    resourcePins: attempt.resourcePins,
    componentPins: attempt.componentPins,
    retryContextPolicy: attempt.retryContextPolicy,
    executionMode: attempt.executionMode,
  };
}

function claimAttempt(
  fixture: ReturnType<typeof createClaimedPageFixture>,
  attempt: GenerationTaskAttempt,
  now: number,
): GenerationTaskAttemptClaim {
  const claim = fixture.store.workspace.tryClaimGenerationTaskAttempt({
    taskId: attempt.taskId,
    attempt: attempt.attempt,
    ownerId: `failure-worker-${attempt.attempt}`,
    now,
    leaseMs: 30_000,
  });
  assert.ok(claim);
  return claim;
}

test("execution failure requires the exact unexpired lease and complete claim set", async (t) => {
  await t.test("wrong token", () => {
    const fixture = createClaimedPageFixture("wrong-token");
    try {
      const before = durableFailureState(fixture.store, fixture.plan.id);
      assert.throws(
        () => failureApi(fixture.store).finishGenerationTaskAttemptForProject(
          fixture.project.id,
          fixture.plan.id,
          failureInput(
            { ...fixture.claim, lease: { ...fixture.claim.lease, leaseToken: `${fixture.claim.lease.leaseToken}-wrong` } },
            "design",
            { code: "design-invalid" },
          ),
        ),
        (error) => error instanceof GenerationTaskLeaseFenceError,
      );
      assert.deepEqual(durableFailureState(fixture.store, fixture.plan.id), before);
    } finally {
      fixture.store.close();
    }
  });

  await t.test("expiry equality", () => {
    const fixture = createClaimedPageFixture("expired");
    try {
      assert.ok(fixture.claim.attempt.leaseExpiresAt);
      fixture.control.set(fixture.claim.attempt.leaseExpiresAt);
      const before = durableFailureState(fixture.store, fixture.plan.id);
      assert.throws(
        () => failureApi(fixture.store).finishGenerationTaskAttemptForProject(
          fixture.project.id,
          fixture.plan.id,
          failureInput(fixture.claim, "qa", { code: "qa-failed" }),
        ),
        (error) => error instanceof GenerationTaskLeaseFenceError,
      );
      assert.deepEqual(durableFailureState(fixture.store, fixture.plan.id), before);
    } finally {
      fixture.store.close();
    }
  });

  await t.test("missing required claim", () => {
    const fixture = createClaimedPageFixture("missing-claim");
    try {
      fixture.store.db.exec("DROP TRIGGER generation_task_claim_delete_live_guard");
      const deleted = fixture.store.db.prepare(
        `DELETE FROM generation_task_claims
         WHERE task_id = ? AND attempt = ? AND claim_key = (
           SELECT claim_key FROM generation_task_claims
           WHERE task_id = ? AND attempt = ? ORDER BY claim_key LIMIT 1
         )`,
      ).run(fixture.task.id, fixture.attempt.attempt, fixture.task.id, fixture.attempt.attempt);
      assert.equal(Number(deleted.changes), 1);
      const before = durableFailureState(fixture.store, fixture.plan.id);
      assert.throws(
        () => failureApi(fixture.store).finishGenerationTaskAttemptForProject(
          fixture.project.id,
          fixture.plan.id,
          failureInput(fixture.claim, "context", { code: "context-integrity" }),
        ),
        /claim|lease|fence/i,
      );
      assert.deepEqual(durableFailureState(fixture.store, fixture.plan.id), before);
    } finally {
      fixture.store.close();
    }
  });
});

test("retryable provider failures append exact successors with 1s, 4s, and 16s backoff", () => {
  const fixture = createClaimedPageFixture("retry-backoff");
  const delays = [1_000, 4_000, 16_000] as const;
  let claim = fixture.claim;
  let finishAt = 100_001;
  try {
    for (let index = 0; index <= delays.length; index += 1) {
      const source = claim.attempt;
      const error = { code: "provider-temporary", round: index + 1 };
      fixture.control.set(finishAt);
      failureApi(fixture.store).finishGenerationTaskAttemptForProject(
        fixture.project.id,
        fixture.plan.id,
        failureInput(claim, "provider", error),
      );
      const finished = attemptFor(fixture.store, fixture, source.attempt);
      assert.equal(finished.failureClass, "provider");
      assert.deepEqual(finished.error, error);
      assert.equal(finished.lease, null);
      assert.equal(
        Number((fixture.store.db.prepare(
          "SELECT COUNT(*) AS count FROM generation_task_claims WHERE task_id = ? AND attempt = ?",
        ).get(source.taskId, source.attempt) as { count: number }).count),
        0,
      );

      if (index < delays.length) {
        const nextEligibleAt = finishAt + delays[index]!;
        assert.equal(finished.status, "retryable-failed");
        assert.equal(finished.nextEligibleAt, nextEligibleAt);
        const successor = attemptFor(fixture.store, fixture, source.attempt + 1);
        assert.equal(successor.status, "queued");
        assert.equal(successor.attemptOrigin, "same-input-retry");
        assert.equal(successor.predecessorAttempt, source.attempt);
        assert.equal(successor.automaticRetryIndex, index + 1);
        assert.deepEqual(retryInput(successor), retryInput(source));
        assert.notEqual(successor.inputHash, source.inputHash);
        assert.deepEqual(taskRow(fixture.store, fixture.task.id), {
          status: "retry-wait",
          current_attempt: successor.attempt,
          failure_class: "provider",
          error_json: JSON.stringify(error),
          next_eligible_at: nextEligibleAt,
          blocked_reason: null,
          blocked_by_task_id: null,
          finished_at: null,
        });
        const retryEvents = fixture.store.workspace.listGenerationPlanEventsForProject(
          fixture.project.id,
          fixture.plan.id,
          { after: 0, limit: 1_000 },
        ).filter((event) => event.type === "task-retry-wait" && event.taskId === fixture.task.id);
        assert.equal(retryEvents.length, index + 1);
        assert.equal(retryEvents.at(-1)?.payload.failureClass, "provider");
        assert.deepEqual(retryEvents.at(-1)?.payload.error, error);
        claim = claimAttempt(fixture, successor, nextEligibleAt);
        finishAt = nextEligibleAt + 1;
        continue;
      }

      assert.equal(finished.status, "failed");
      assert.equal(finished.nextEligibleAt, null);
      assert.equal(
        Number((fixture.store.db.prepare(
          "SELECT COUNT(*) AS count FROM generation_task_attempts WHERE task_id = ?",
        ).get(fixture.task.id) as { count: number }).count),
        4,
      );
      assert.equal(taskRow(fixture.store, fixture.task.id).status, "failed");
      assert.equal(taskRow(fixture.store, fixture.validation.id).status, "blocked");
      assert.equal(taskRow(fixture.store, fixture.checkpoint.id).status, "blocked");
      assert.equal(fixture.store.workspace.getGenerationPlanForProject(fixture.project.id, fixture.plan.id).status, "failed");
    }
  } finally {
    fixture.store.close();
  }
});

test("a terminal execution failure atomically releases claims, blocks every descendant, and fails the Plan", () => {
  const fixture = createClaimedPageFixture("terminal");
  const error = { code: "design-contract-failed", findingIds: ["contrast", "hierarchy"] };
  try {
    failureApi(fixture.store).finishGenerationTaskAttemptForProject(
      fixture.project.id,
      fixture.plan.id,
      failureInput(fixture.claim, "design", error),
    );
    const attempt = attemptFor(fixture.store, fixture, fixture.attempt.attempt);
    assert.equal(attempt.status, "failed");
    assert.equal(attempt.failureClass, "design");
    assert.deepEqual(attempt.error, error);
    assert.equal(attempt.lease, null);
    assert.deepEqual(taskRow(fixture.store, fixture.task.id), {
      status: "failed",
      current_attempt: fixture.attempt.attempt,
      failure_class: "design",
      error_json: JSON.stringify(error),
      next_eligible_at: null,
      blocked_reason: null,
      blocked_by_task_id: null,
      finished_at: 100_001,
    });
    for (const descendant of [fixture.validation, fixture.checkpoint]) {
      const row = taskRow(fixture.store, descendant.id);
      assert.equal(row.status, "blocked");
      assert.equal(row.blocked_by_task_id, fixture.task.id);
      assert.equal(row.finished_at, 100_001);
    }
    assert.deepEqual(rawRows(
      fixture.store,
      "SELECT * FROM generation_task_claims WHERE task_id = ?",
      fixture.task.id,
    ), []);
    const plan = fixture.store.workspace.getGenerationPlanForProject(fixture.project.id, fixture.plan.id);
    assert.equal(plan.status, "failed");
    assert.equal(plan.finishedAt, 100_001);
    const terminalEvents = fixture.store.workspace.listGenerationPlanEventsForProject(
      fixture.project.id,
      fixture.plan.id,
      { after: 0, limit: 1_000 },
    ).filter((event) => event.type === "task-failed" || event.type === "task-blocked" || event.type === "plan-failed");
    assert.deepEqual(terminalEvents.map((event) => [event.type, event.taskId]), [
      ["task-failed", fixture.task.id],
      ["task-blocked", fixture.validation.id],
      ["task-blocked", fixture.checkpoint.id],
      ["plan-failed", null],
    ]);
    assert.equal(terminalEvents[0]?.payload.failureClass, "design");
    assert.deepEqual(terminalEvents[0]?.payload.error, error);
    assert.equal(terminalEvents.at(-1)?.payload.failureClass, "design");
  } finally {
    fixture.store.close();
  }
});

test("a failed retry or terminal event append rolls the entire failure transition back", async (t) => {
  await t.test("retry event", () => {
    const fixture = createClaimedPageFixture("retry-event-rollback");
    try {
      fixture.store.db.exec(
        `CREATE TRIGGER reject_task_retry_wait_event
         BEFORE INSERT ON generation_plan_events WHEN NEW.type = 'task-retry-wait'
         BEGIN SELECT RAISE(ABORT, 'injected task-retry-wait failure'); END`,
      );
      const before = durableFailureState(fixture.store, fixture.plan.id);
      assert.throws(
        () => failureApi(fixture.store).finishGenerationTaskAttemptForProject(
          fixture.project.id,
          fixture.plan.id,
          failureInput(fixture.claim, "provider", { code: "provider-temporary" }),
        ),
        /injected task-retry-wait failure/,
      );
      assert.deepEqual(durableFailureState(fixture.store, fixture.plan.id), before);
    } finally {
      fixture.store.close();
    }
  });

  await t.test("terminal event", () => {
    const fixture = createClaimedPageFixture("terminal-event-rollback");
    try {
      fixture.store.db.exec(
        `CREATE TRIGGER reject_task_failed_event
         BEFORE INSERT ON generation_plan_events WHEN NEW.type = 'task-failed'
         BEGIN SELECT RAISE(ABORT, 'injected task-failed failure'); END`,
      );
      const before = durableFailureState(fixture.store, fixture.plan.id);
      assert.throws(
        () => failureApi(fixture.store).finishGenerationTaskAttemptForProject(
          fixture.project.id,
          fixture.plan.id,
          failureInput(fixture.claim, "qa", { code: "qa-failed" }),
        ),
        /injected task-failed failure/,
      );
      assert.deepEqual(durableFailureState(fixture.store, fixture.plan.id), before);
    } finally {
      fixture.store.close();
    }
  });
});

test("an exact lost-response replay is idempotent and a different failure is rejected", () => {
  const fixture = createClaimedPageFixture("lost-response");
  const input = failureInput(fixture.claim, "design", { code: "design-failed", round: 1 });
  try {
    failureApi(fixture.store).finishGenerationTaskAttemptForProject(
      fixture.project.id,
      fixture.plan.id,
      input,
    );
    const afterFirst = durableFailureState(fixture.store, fixture.plan.id);
    assert.doesNotThrow(() => failureApi(fixture.store).finishGenerationTaskAttemptForProject(
      fixture.project.id,
      fixture.plan.id,
      input,
    ));
    assert.deepEqual(durableFailureState(fixture.store, fixture.plan.id), afterFirst);
    assert.throws(() => failureApi(fixture.store).finishGenerationTaskAttemptForProject(
      fixture.project.id,
      fixture.plan.id,
      failureInput(fixture.claim, "qa", { code: "different-failure" }),
    ));
    assert.deepEqual(durableFailureState(fixture.store, fixture.plan.id), afterFirst);
  } finally {
    fixture.store.close();
  }
});

test("context, design, and qa failure classifications survive Attempt, Task, and event persistence", async (t) => {
  for (const failureClass of ["context", "design", "qa"] as const) {
    await t.test(failureClass, () => {
      const fixture = createClaimedPageFixture(`classification-${failureClass}`);
      const error = { code: `${failureClass}-failure`, details: { source: "executor" } };
      try {
        failureApi(fixture.store).finishGenerationTaskAttemptForProject(
          fixture.project.id,
          fixture.plan.id,
          failureInput(fixture.claim, failureClass, error),
        );
        const attempt = attemptFor(fixture.store, fixture, fixture.attempt.attempt);
        assert.equal(attempt.failureClass, failureClass);
        assert.deepEqual(attempt.error, error);
        assert.equal(taskRow(fixture.store, fixture.task.id).failure_class, failureClass);
        assert.deepEqual(
          JSON.parse(String(taskRow(fixture.store, fixture.task.id).error_json)),
          error,
        );
        const events = fixture.store.workspace.listGenerationPlanEventsForProject(
          fixture.project.id,
          fixture.plan.id,
          { after: 0, limit: 1_000 },
        );
        const failed = events.find((event) => event.type === "task-failed" && event.taskId === fixture.task.id);
        const planFailed = events.find((event) => event.type === "plan-failed");
        assert.equal(failed?.payload.failureClass, failureClass);
        assert.deepEqual(failed?.payload.error, error);
        assert.equal(planFailed?.payload.failureClass, failureClass);
      } finally {
        fixture.store.close();
      }
    });
  }
});
