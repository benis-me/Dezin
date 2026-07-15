import assert from "node:assert/strict";
import { test } from "node:test";

import { Store } from "../src/store.ts";

interface ClaimFixture {
  capacityClaimKeys: string[];
  planId: string;
  projectId: string;
  taskId: string;
  workspaceId: string;
  writerClaimKey: string | null;
}

function hexId(value: string): string {
  return Buffer.from(value, "utf8").toString("hex");
}

function createQueuedWorkspaceAttempt(
  store: Store,
  suffix: string,
  kind: "prototype-validation" | "checkpoint" = "prototype-validation",
): ClaimFixture {
  const project = store.createProject({ name: `Claim schema ${suffix}`, mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const proposalId = `claim-schema-proposal-${suffix}`;
  const planId = `claim-schema-plan-${suffix}`;
  const taskId = `claim-schema-task-${suffix}`;

  store.db.prepare(
    `INSERT INTO workspace_proposals (
       id, workspace_id, base_graph_revision, base_snapshot_id, revision, kind, status,
       operations_json, layout_id, base_layout_checksum, base_layout_json,
       layout_operations_json, rationale, assumptions_json, generation_payload_json,
       review_json, created_by_run_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 1, 'workspace-generation', 'draft', '[]', 'default',
       'layout-checksum', '{}', '[]', 'claim schema fixture', '[]',
       '{"kind":"workspace-generation"}', '{"kind":"none"}', NULL, 10, 10)`,
  ).run(proposalId, workspace.id, workspace.graphRevision, workspace.activeSnapshotId);
  store.db.prepare(
    `INSERT INTO workspace_proposal_audit (proposal_id, revision, payload_json, created_at)
     VALUES (?, 1, '{}', 11)`,
  ).run(proposalId);
  store.db.prepare(
    `UPDATE workspace_proposals
     SET status = 'approved', review_json = '{"kind":"approved","mode":"generate"}', updated_at = 12
     WHERE id = ?`,
  ).run(proposalId);
  store.db.prepare(
    `INSERT INTO generation_plans (
       id, workspace_id, proposal_id, proposal_revision, base_snapshot_id, status,
       construction_sealed, compile_error_json, created_at, finished_at
     ) VALUES (?, ?, ?, 1, ?, 'approved', 0, NULL, 13, NULL)`,
  ).run(planId, workspace.id, proposalId, workspace.activeSnapshotId);
  store.db.prepare(
    `INSERT INTO generation_tasks (
       id, workspace_id, plan_id, ordinal, kind, target_type, target_id,
       target_artifact_id, target_track_id, target_resource_id,
       payload_json, intent_hash, capabilities_json, qa_profile_json, resource_limits_json,
       idempotency_key, status, created_at
     ) VALUES (?, ?, ?, 0, ?, 'workspace', ?, NULL, NULL, NULL,
       '{}', ?, '[]', '{}', ?, ?, 'materialization-pending', 20)`,
  ).run(
    taskId,
    workspace.id,
    planId,
    kind,
    workspace.id,
    `intent-${suffix}`,
    JSON.stringify({
      timeoutMs: kind === "checkpoint" ? 30_000 : 180_000,
      maxAgentTurns: 1,
      maxRepairRounds: 0,
      maxOutputBytes: kind === "checkpoint" ? 1024 * 1024 : 4 * 1024 * 1024,
      capacityClasses: kind === "checkpoint" ? [] : ["render-qa"],
    }),
    `generation-task:${suffix}`,
  );
  store.db.prepare(
    `UPDATE generation_plans SET construction_sealed = 1, status = 'queued'
     WHERE id = ? AND workspace_id = ?`,
  ).run(planId, workspace.id);
  store.db.prepare(
    `INSERT INTO generation_plan_events (
       plan_id, workspace_id, sequence, task_id, type, payload_json, created_at
     ) VALUES (?, ?, 1, NULL, 'plan-queued', '{"taskCount":1,"dependencyCount":0}', 30)`,
  ).run(planId, workspace.id);
  store.db.prepare(
    `INSERT INTO generation_task_attempts (
       task_id, plan_id, workspace_id, attempt, target_artifact_id, target_track_id,
       target_resource_id, base_revision_id, expected_snapshot_id, context_pack_id,
       kernel_revision_id, execution_mode, payload_json, input_hash,
       pinned_resource_revision_ids_json, component_dependency_revision_ids_json,
       retry_context_policy, status, created_at
     ) VALUES (?, ?, ?, 1, NULL, NULL, NULL, NULL, ?, NULL, ?, 'full', '{}', ?,
       '[]', '[]', 'same-context', 'queued', 50)`,
  ).run(
    taskId,
    planId,
    workspace.id,
    workspace.activeSnapshotId,
    workspace.activeKernelRevisionId,
    `input-${suffix}`,
  );
  store.db.prepare(
    `UPDATE generation_task_attempts SET materialization_sealed = 1
     WHERE task_id = ? AND attempt = 1`,
  ).run(taskId);
  store.db.prepare(
    `UPDATE generation_tasks SET status = 'queued'
     WHERE id = ? AND plan_id = ? AND current_attempt = 1`,
  ).run(taskId, planId);
  store.db.prepare(
    `INSERT INTO generation_plan_events (
       plan_id, workspace_id, sequence, task_id, type, payload_json, created_at
     ) VALUES (?, ?, 2, ?, 'task-materialized', ?, 60)`,
  ).run(
    planId,
    workspace.id,
    taskId,
    JSON.stringify({
      attempt: 1,
      inputHash: `input-${suffix}`,
      expectedSnapshotId: workspace.activeSnapshotId,
      baseRevisionId: null,
      contextPackId: null,
      kernelRevisionId: workspace.activeKernelRevisionId,
      retryContextPolicy: "same-context",
      executionMode: "full",
    }),
  );

  return {
    capacityClaimKeys: kind === "checkpoint" ? [] : ["capacity:render-qa:1"],
    planId,
    projectId: project.id,
    taskId,
    workspaceId: workspace.id,
    writerClaimKey: kind === "checkpoint" ? `writer:checkpoint:${hexId(workspace.id)}` : null,
  };
}

function insertClaim(
  store: Store,
  fixture: ClaimFixture,
  input: {
    claimKey: string;
    claimKind?: "capacity" | "writer";
    createdAt?: number;
    leaseExpiresAt?: number;
    leaseToken?: string;
    ownerId?: string;
  },
): void {
  store.db.prepare(
    `INSERT INTO generation_task_claims (
       claim_key, claim_kind, task_id, plan_id, attempt, workspace_id,
       owner_id, lease_token, lease_expires_at, created_at
     ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    input.claimKey,
    input.claimKind ?? (input.claimKey.startsWith("capacity:") ? "capacity" : "writer"),
    fixture.taskId,
    fixture.planId,
    fixture.workspaceId,
    input.ownerId ?? "worker-a",
    input.leaseToken ?? "lease-a",
    input.leaseExpiresAt ?? 150,
    input.createdAt ?? 100,
  );
}

function insertExactClaims(store: Store, fixture: ClaimFixture): void {
  for (const claimKey of fixture.capacityClaimKeys) insertClaim(store, fixture, { claimKey });
  if (fixture.writerClaimKey !== null) {
    insertClaim(store, fixture, { claimKey: fixture.writerClaimKey });
  }
}

test("Generation Task claim schema rejects malformed claims and incomplete running transitions", () => {
  const store = new Store();
  try {
    const fixture = createQueuedWorkspaceAttempt(store, "entry");

    assert.throws(
      () => insertClaim(store, fixture, {
        claimKey: "capacity:render-qa:1",
        createdAt: 100,
        leaseExpiresAt: 100,
      }),
      /claim|lease|expiry/i,
    );
    assert.throws(
      () => insertClaim(store, fixture, { claimKey: "capacity:render-qa:0" }),
      /claim|capacity|canonical/i,
    );
    assert.throws(
      () => insertClaim(store, fixture, {
        claimKey: `writer:checkpoint:${fixture.workspaceId}`,
      }),
      /claim|writer|canonical/i,
    );

    assert.throws(
      () => store.db.prepare(
        "UPDATE generation_tasks SET status = 'running' WHERE id = ? AND plan_id = ?",
      ).run(fixture.taskId, fixture.planId),
      /task|attempt|claim|running/i,
    );
    assert.throws(
      () => store.db.prepare(
        `UPDATE generation_task_attempts
         SET status = 'running', owner_id = 'worker-a', lease_token = 'lease-a',
             lease_expires_at = 150, heartbeat_at = 100, started_at = 100
         WHERE task_id = ? AND attempt = 1`,
      ).run(fixture.taskId),
      /attempt|claim|lease|running/i,
    );

    insertExactClaims(store, fixture);
    store.db.prepare(
      `UPDATE generation_task_attempts
       SET status = 'running', owner_id = 'worker-a', lease_token = 'lease-a',
           lease_expires_at = 150, heartbeat_at = 100, started_at = 100
       WHERE task_id = ? AND attempt = 1`,
    ).run(fixture.taskId);
    store.db.prepare(
      "UPDATE generation_tasks SET status = 'running' WHERE id = ? AND plan_id = ?",
    ).run(fixture.taskId, fixture.planId);

    const running = store.db.prepare(
      `SELECT task.status AS task_status, attempt.status AS attempt_status
       FROM generation_tasks task
       JOIN generation_task_attempts attempt
         ON attempt.task_id = task.id AND attempt.attempt = task.current_attempt
       WHERE task.id = ?`,
    ).get(fixture.taskId) as { attempt_status: string; task_status: string };
    assert.deepEqual({ ...running }, { task_status: "running", attempt_status: "running" });
  } finally {
    store.close();
  }
});

test("Generation Task claim schema keeps one fence across claims, heartbeats, and release", () => {
  const store = new Store();
  try {
    const fixture = createQueuedWorkspaceAttempt(store, "fence", "checkpoint");
    assert.ok(fixture.writerClaimKey);
    insertClaim(store, fixture, { claimKey: fixture.writerClaimKey });
    assert.throws(
      () => insertClaim(store, fixture, {
        claimKey: "capacity:agent:1",
        ownerId: "worker-b",
        leaseToken: "lease-b",
      }),
      /claim|fence|owner|lease/i,
    );
    store.db.prepare(
      `UPDATE generation_task_attempts
       SET status = 'running', owner_id = 'worker-a', lease_token = 'lease-a',
           lease_expires_at = 150, heartbeat_at = 100, started_at = 100
       WHERE task_id = ? AND attempt = 1`,
    ).run(fixture.taskId);
    store.db.prepare(
      "UPDATE generation_tasks SET status = 'running' WHERE id = ? AND plan_id = ?",
    ).run(fixture.taskId, fixture.planId);

    assert.throws(
      () => store.db.prepare(
        "UPDATE generation_task_claims SET lease_expires_at = 150 WHERE task_id = ? AND attempt = 1",
      ).run(fixture.taskId),
      /claim|lease|increase|expiry/i,
    );
    assert.throws(
      () => store.db.prepare(
        `UPDATE generation_task_attempts
         SET owner_id = 'worker-b', lease_token = 'lease-b'
         WHERE task_id = ? AND attempt = 1`,
      ).run(fixture.taskId),
      /attempt|fence|lease|owner|token/i,
    );
    assert.throws(
      () => store.db.prepare(
        "DELETE FROM generation_task_claims WHERE task_id = ? AND attempt = 1",
      ).run(fixture.taskId),
      /claim|live|lease|release/i,
    );

    store.db.prepare(
      "UPDATE generation_task_claims SET lease_expires_at = 200 WHERE task_id = ? AND attempt = 1",
    ).run(fixture.taskId);
    store.db.prepare(
      `UPDATE generation_task_attempts SET lease_expires_at = 200, heartbeat_at = 120
       WHERE task_id = ? AND attempt = 1`,
    ).run(fixture.taskId);

    const lease = store.db.prepare(
      `SELECT lease_expires_at, heartbeat_at, owner_id, lease_token
       FROM generation_task_attempts WHERE task_id = ? AND attempt = 1`,
    ).get(fixture.taskId);
    assert.deepEqual({ ...(lease as Record<string, unknown>) }, {
      lease_expires_at: 200,
      heartbeat_at: 120,
      owner_id: "worker-a",
      lease_token: "lease-a",
    });
    assert.deepEqual(
      store.db.prepare(
        `SELECT DISTINCT owner_id, lease_token, lease_expires_at
         FROM generation_task_claims WHERE task_id = ? AND attempt = 1`,
      ).all(fixture.taskId).map((row) => ({ ...row })),
      [{ owner_id: "worker-a", lease_token: "lease-a", lease_expires_at: 200 }],
    );

    store.deleteProject(fixture.projectId);
    assert.equal(
      (store.db.prepare(
        "SELECT COUNT(*) AS count FROM generation_task_claims WHERE task_id = ?",
      ).get(fixture.taskId) as { count: number }).count,
      0,
    );
  } finally {
    store.close();
  }
});

test("Generation Task claim guards are restored by additive migration", () => {
  const store = new Store();
  try {
    const expected = [
      "generation_task_claim_insert_guard",
      "generation_task_claim_lease_update_guard",
      "generation_task_claim_delete_live_guard",
      "generation_task_attempt_running_entry_guard",
      "generation_task_attempt_lease_fence_guard",
      "generation_task_running_entry_guard",
    ];
    const actual = new Set(
      (store.db.prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'trigger' AND (
           name LIKE 'generation_task%claim%guard'
           OR name IN (
              'generation_task_attempt_running_entry_guard',
              'generation_task_attempt_lease_fence_guard',
              'generation_task_running_entry_guard'
           )
         )`,
      ).all() as Array<{ name: string }>).map(({ name }) => name),
    );
    assert.deepEqual(expected.filter((name) => !actual.has(name)), []);
  } finally {
    store.close();
  }
});
