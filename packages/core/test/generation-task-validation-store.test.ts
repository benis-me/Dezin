import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GenerationTaskLeaseFenceError,
  Store,
  type GenerationTaskAttemptClaim,
  type CompleteGenerationTaskValidationInput,
  type StoreClock,
} from "../src/index.ts";

interface ControlledClock {
  clock: StoreClock;
  set(now: number): void;
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

function createFixture(label: string) {
  const control = controlledClock(`validation-publication-${label}`);
  const store = new Store(":memory:", control.clock);
  const project = store.createProject({ name: `Validation publication ${label}`, mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const layout = store.workspace.getLayout(project.id);
  const proposal = store.workspace.createProposal({
    projectId: project.id,
    kind: "workspace-generation",
    baseGraphRevision: workspace.graphRevision,
    baseSnapshotId: workspace.activeSnapshotId,
    layoutId: layout.layoutId,
    baseLayoutChecksum: layout.checksum,
    operations: [],
    layoutOperations: [],
    generation: emptyGeneration(),
    rationale: `Validate immutable Snapshot ${label}`,
    assumptions: [],
  });
  const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
  assert.ok(approved.plan);
  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id);
  const task = compiled.tasks.find((candidate) => candidate.kind === "prototype-validation");
  assert.ok(task);
  const observation = store.workspace.observeGenerationTaskMaterializationForProject(
    project.id,
    compiled.plan.id,
    task.id,
  );
  const attempt = store.workspace.createGenerationTaskAttemptForProject(project.id, compiled.plan.id, {
    ...observation,
    contextPackId: null,
    sourceCommitHash: null,
    sourceTreeHash: null,
    retryContextPolicy: "same-context",
    executionMode: "full",
  });
  const claim = store.workspace.tryClaimGenerationTaskAttempt({
    taskId: task.id,
    attempt: attempt.attempt,
    ownerId: `validation-owner-${label}`,
    now: 100_000,
    leaseMs: 30_000,
  });
  assert.ok(claim);
  const snapshot = store.workspace.listSnapshots(project.id)
    .find((candidate) => candidate.id === attempt.expectedSnapshotId);
  assert.ok(snapshot);
  control.set(100_001);
  const input: CompleteGenerationTaskValidationInput = {
    lease: claim.lease,
    validation: {
      snapshotId: snapshot.id,
      graphRevision: snapshot.graphRevision,
      artifactRevisionIds: [],
      resourceRevisionIds: [],
      evidence: {
        protocol: "dezin-prototype-validation-v1",
        snapshot: {
          id: snapshot.id,
          graphRevision: snapshot.graphRevision,
          kernelRevisionId: snapshot.kernelRevisionId,
        },
        dependencies: [],
        artifacts: [],
        resources: [],
        prototypeEdges: [],
        frames: [],
      },
    },
  };
  return { control, store, project, workspace, plan: compiled.plan, task, attempt, claim, snapshot, input };
}

function claimCount(store: Store, claim: GenerationTaskAttemptClaim): number {
  return Number((store.db.prepare(
    "SELECT COUNT(*) AS count FROM generation_task_claims WHERE task_id = ? AND attempt = ?",
  ).get(claim.task.id, claim.attempt.attempt) as { count: number }).count);
}

test("prototype validation success atomically records its exact immutable Snapshot and evidence", () => {
  const fixture = createFixture("success");
  try {
    const result = fixture.store.workspace.completeGenerationTaskValidationForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.input,
    );

    assert.equal(result.status, "succeeded");
    assert.equal(result.task.status, "succeeded");
    assert.equal(result.attempt.status, "succeeded");
    assert.equal(result.task.resultSnapshotId, fixture.snapshot.id);
    assert.equal(result.snapshot.id, fixture.snapshot.id);
    assert.match(result.evidenceHash, /^[0-9a-f]{64}$/);
    assert.equal(claimCount(fixture.store, fixture.claim), 0);
    assert.equal(
      fixture.store.workspace.getGenerationPlanForProject(fixture.project.id, fixture.plan.id).status,
      "running",
      "the checkpoint remains responsible for successful Plan terminalization",
    );
    const events = fixture.store.workspace.listGenerationPlanEventsForProject(
      fixture.project.id,
      fixture.plan.id,
      { after: 0, limit: 1_000 },
    ).filter((event) => event.type === "task-succeeded" && event.taskId === fixture.task.id);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.payload.resultSnapshotId, fixture.snapshot.id);
    assert.equal(events[0]?.payload.validationEvidenceHash, result.evidenceHash);
    assert.equal(Object.hasOwn(events[0]!.payload, "validationEvidence"), false);
    const validation = fixture.store.workspace.getGenerationTaskValidationResultForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.task.id,
      fixture.attempt.attempt,
    );
    assert.deepEqual(validation, result.validation);
    assert.deepEqual(validation?.evidence, fixture.input.validation.evidence);
  } finally {
    fixture.store.close();
  }
});

test("a lost validation response replays only for the exact lease and result fence", () => {
  const fixture = createFixture("replay");
  try {
    const first = fixture.store.workspace.completeGenerationTaskValidationForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.input,
    );
    const replay = fixture.store.workspace.completeGenerationTaskValidationForProject(
      fixture.project.id,
      fixture.plan.id,
      structuredClone(fixture.input),
    );
    assert.deepEqual(replay, first);

    assert.throws(
      () => fixture.store.workspace.completeGenerationTaskValidationForProject(
        fixture.project.id,
        fixture.plan.id,
        { ...fixture.input, lease: { ...fixture.input.lease, leaseToken: "wrong-replay-token" } },
      ),
      GenerationTaskLeaseFenceError,
    );
    assert.throws(
      () => fixture.store.workspace.completeGenerationTaskValidationForProject(
        fixture.project.id,
        fixture.plan.id,
        {
          ...fixture.input,
          validation: { ...fixture.input.validation, graphRevision: fixture.input.validation.graphRevision + 1 },
        },
      ),
      GenerationTaskLeaseFenceError,
    );
    const events = fixture.store.workspace.listGenerationPlanEventsForProject(
      fixture.project.id,
      fixture.plan.id,
      { after: 0, limit: 1_000 },
    ).filter((event) => event.type === "task-succeeded" && event.taskId === fixture.task.id);
    assert.equal(events.length, 1);
  } finally {
    fixture.store.close();
  }
});

test("validation rejects semantic drift without changing the live Attempt or its claims", () => {
  const fixture = createFixture("drift");
  try {
    assert.throws(
      () => fixture.store.workspace.completeGenerationTaskValidationForProject(
        fixture.project.id,
        fixture.plan.id,
        {
          ...fixture.input,
          validation: {
            ...fixture.input.validation,
            artifactRevisionIds: ["foreign-artifact-revision"],
          },
        },
      ),
      /Revision set|dependency|validation/i,
    );
    assert.equal(
      fixture.store.workspace.getGenerationPlanDetailForProject(
        fixture.project.id,
        fixture.plan.id,
      ).tasks.find((task) => task.id === fixture.task.id)?.status,
      "running",
    );
    assert.equal(claimCount(fixture.store, fixture.claim), fixture.claim.claims.length);
  } finally {
    fixture.store.close();
  }
});

test("validation rejects incomplete deterministic evidence without writing terminal state", () => {
  const fixture = createFixture("incomplete-evidence");
  try {
    const evidence = structuredClone(fixture.input.validation.evidence);
    delete evidence.frames;
    assert.throws(
      () => fixture.store.workspace.completeGenerationTaskValidationForProject(
        fixture.project.id,
        fixture.plan.id,
        {
          ...fixture.input,
          validation: { ...fixture.input.validation, evidence },
        },
      ),
      /validation|evidence|frames/i,
    );
    const task = fixture.store.workspace.getGenerationPlanDetailForProject(
      fixture.project.id,
      fixture.plan.id,
    ).tasks.find((candidate) => candidate.id === fixture.task.id);
    assert.equal(task?.status, "running");
    assert.equal(claimCount(fixture.store, fixture.claim), fixture.claim.claims.length);
    assert.equal(Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM generation_task_validation_results WHERE task_id = ?",
    ).get(fixture.task.id) as { count: number }).count), 0);
  } finally {
    fixture.store.close();
  }
});

test("validation rejects tampered prototype edge and Frame evidence without writing terminal state", async (t) => {
  for (const [label, field, value] of [
    ["prototype-edge", "prototypeEdges", [{ edgeId: "unvalidated-edge" }]],
    ["frame", "frames", [{ id: "unvalidated-frame" }]],
  ] as const) {
    await t.test(label, () => {
      const fixture = createFixture(`tampered-${label}`);
      try {
        assert.throws(
          () => fixture.store.workspace.completeGenerationTaskValidationForProject(
            fixture.project.id,
            fixture.plan.id,
            {
              ...fixture.input,
              validation: {
                ...fixture.input.validation,
                evidence: {
                  ...fixture.input.validation.evidence,
                  [field]: value,
                },
              },
            },
          ),
          /validation|evidence|prototype|frame/i,
        );
        const task = fixture.store.workspace.getGenerationPlanDetailForProject(
          fixture.project.id,
          fixture.plan.id,
        ).tasks.find((candidate) => candidate.id === fixture.task.id);
        assert.equal(task?.status, "running");
        assert.equal(claimCount(fixture.store, fixture.claim), fixture.claim.claims.length);
        assert.equal(Number((fixture.store.db.prepare(
          "SELECT COUNT(*) AS count FROM generation_task_validation_results WHERE task_id = ?",
        ).get(fixture.task.id) as { count: number }).count), 0);
      } finally {
        fixture.store.close();
      }
    });
  }
});

test("validation event persistence failure rolls state and claim release back", () => {
  const fixture = createFixture("rollback");
  try {
    fixture.store.db.exec(`
      CREATE TRIGGER reject_validation_success_event
      BEFORE INSERT ON generation_plan_events
      WHEN NEW.type = 'task-succeeded' AND NEW.task_id = '${fixture.task.id}'
      BEGIN SELECT RAISE(ABORT, 'reject validation success event'); END;
    `);
    assert.throws(
      () => fixture.store.workspace.completeGenerationTaskValidationForProject(
        fixture.project.id,
        fixture.plan.id,
        fixture.input,
      ),
      /reject validation success event/i,
    );
    const task = fixture.store.workspace.getGenerationPlanDetailForProject(
      fixture.project.id,
      fixture.plan.id,
    ).tasks.find((candidate) => candidate.id === fixture.task.id)!;
    assert.equal(task.status, "running");
    assert.equal(task.resultSnapshotId, null);
    assert.equal(claimCount(fixture.store, fixture.claim), fixture.claim.claims.length);
  } finally {
    fixture.store.close();
  }
});

test("validation completion rejects the exact lease expiry boundary", () => {
  const fixture = createFixture("expiry");
  try {
    fixture.control.set(130_000);
    assert.throws(
      () => fixture.store.workspace.completeGenerationTaskValidationForProject(
        fixture.project.id,
        fixture.plan.id,
        fixture.input,
      ),
      GenerationTaskLeaseFenceError,
    );
    assert.equal(claimCount(fixture.store, fixture.claim), fixture.claim.claims.length);
  } finally {
    fixture.store.close();
  }
});

test("validation result history is immutable but Project root deletion still cascades", () => {
  const fixture = createFixture("history-cascade");
  try {
    fixture.store.workspace.completeGenerationTaskValidationForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.input,
    );
    assert.throws(
      () => fixture.store.db.prepare(
        "UPDATE generation_task_validation_results SET graph_revision = graph_revision + 1 WHERE task_id = ?",
      ).run(fixture.task.id),
      /immutable/i,
    );
    assert.throws(
      () => fixture.store.db.prepare(
        "DELETE FROM generation_task_validation_results WHERE task_id = ?",
      ).run(fixture.task.id),
      /immutable/i,
    );

    fixture.store.deleteProject(fixture.project.id);
    assert.equal(fixture.store.getProject(fixture.project.id), null);
    assert.equal(Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM generation_task_validation_results WHERE task_id = ?",
    ).get(fixture.task.id) as { count: number }).count), 0);
  } finally {
    fixture.store.close();
  }
});

test("schema replay reopens a persistent Store after installing validation triggers", () => {
  const directory = mkdtempSync(join(tmpdir(), "dezin-validation-schema-"));
  const file = join(directory, "store.sqlite");
  try {
    new Store(file, controlledClock("validation-schema-first").clock).close();
    new Store(file, controlledClock("validation-schema-second").clock).close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite rejects an oversized direct validation result before it can poison the Attempt", () => {
  const fixture = createFixture("direct-oversize");
  try {
    const oversizedEvidence = JSON.stringify({
      protocol: "dezin-prototype-validation-v1",
      snapshot: {
        id: fixture.snapshot.id,
        graphRevision: fixture.snapshot.graphRevision,
        kernelRevisionId: fixture.snapshot.kernelRevisionId,
      },
      padding: "x".repeat(1024 * 1024),
    });
    assert.throws(
      () => fixture.store.db.prepare(
        `INSERT INTO generation_task_validation_results (
           task_id, plan_id, workspace_id, attempt, snapshot_id, graph_revision,
           artifact_revision_ids_json, resource_revision_ids_json, evidence_json,
           evidence_hash, validation_fence_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?, ?)`,
      ).run(
        fixture.task.id,
        fixture.plan.id,
        fixture.workspace.id,
        fixture.attempt.attempt,
        fixture.snapshot.id,
        fixture.snapshot.graphRevision,
        oversizedEvidence,
        "d".repeat(64),
        "e".repeat(64),
        100_001,
      ),
      /stale|inconsistent/i,
    );
    assert.equal(Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM generation_task_validation_results WHERE task_id = ?",
    ).get(fixture.task.id) as { count: number }).count), 0);
  } finally {
    fixture.store.close();
  }
});
