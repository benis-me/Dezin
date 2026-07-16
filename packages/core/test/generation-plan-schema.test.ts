import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { migrateStoreSchema, STORE_SCHEMA } from "../src/store-schema.ts";
import { Store } from "../src/store.ts";

const GENERATION_TABLES = [
  "generation_tasks",
  "generation_task_dependencies",
  "generation_task_attempts",
  "generation_task_attempt_dependency_outputs",
  "generation_task_attempt_resource_pins",
  "generation_task_attempt_component_pins",
  "generation_task_materialization_failures",
  "generation_task_claims",
  "generation_plan_events",
] as const;

function openFreshDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(STORE_SCHEMA);
  migrateStoreSchema(db);
  return db;
}

function tableNames(db: DatabaseSync): Set<string> {
  return new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      ({ name }) => name,
    ),
  );
}

test("fresh schema installs the normalized Generation Plan execution model", () => {
  const db = openFreshDatabase();
  try {
    const names = tableNames(db);
    for (const table of GENERATION_TABLES) assert.ok(names.has(table), `missing ${table}`);

    const planColumns = new Set(
      (db.prepare("PRAGMA table_info(generation_plans)").all() as Array<{ name: string }>).map(({ name }) => name),
    );
    assert.ok(planColumns.has("construction_sealed"));

    const taskColumns = new Set(
      (db.prepare("PRAGMA table_info(generation_tasks)").all() as Array<{ name: string }>).map(({ name }) => name),
    );
    assert.deepEqual(
      [...[
        "ordinal",
        "target_track_id",
        "intent_hash",
        "capabilities_json",
        "qa_profile_json",
        "resource_limits_json",
        "blocked_by_task_id",
        "pending_context_policy",
      ]]
        .filter((column) => !taskColumns.has(column)),
      [],
    );

    const attemptColumns = new Map(
      (db.prepare("PRAGMA table_info(generation_task_attempts)").all() as Array<{
        dflt_value: string | null;
        name: string;
        notnull: number;
      }>).map(({ name, notnull, dflt_value }) => [name, { dflt_value, notnull }]),
    );
    assert.equal(attemptColumns.get("context_pack_id")?.notnull, 0);
    assert.deepEqual(attemptColumns.get("source_commit_hash"), { dflt_value: null, notnull: 0 });
    assert.deepEqual(attemptColumns.get("source_tree_hash"), { dflt_value: null, notnull: 0 });
    assert.equal(attemptColumns.has("candidate_evidence_hash"), true);
    assert.deepEqual(attemptColumns.get("materialization_sealed"), { dflt_value: "0", notnull: 1 });

    const dependencyOutputColumns = new Set(
      (db.prepare("PRAGMA table_info(generation_task_attempt_dependency_outputs)").all() as Array<{
        name: string;
      }>).map(({ name }) => name),
    );
    assert.deepEqual(
      [
        "task_id",
        "plan_id",
        "attempt",
        "workspace_id",
        "ordinal",
        "dependency_task_id",
        "result_revision_id",
        "result_resource_revision_id",
        "result_snapshot_id",
      ].filter((column) => !dependencyOutputColumns.has(column)),
      [],
    );

    const resourcePinColumns = new Set(
      (db.prepare("PRAGMA table_info(generation_task_attempt_resource_pins)").all() as Array<{ name: string }>).map(
        ({ name }) => name,
      ),
    );
    assert.equal(resourcePinColumns.has("source_task_id"), true);
  } finally {
    db.close();
  }
});

interface PlanFixture {
  kernelRevisionId: string;
  planId: string;
  projectId: string;
  snapshotId: string;
  workspaceId: string;
}

function createPlanFixture(store: Store, suffix: string): PlanFixture {
  const project = store.createProject({ name: `Plan ${suffix}`, mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const proposalId = `proposal-${suffix}`;
  const planId = `plan-${suffix}`;

  store.db.prepare(
    `INSERT INTO workspace_proposals (
       id, workspace_id, base_graph_revision, base_snapshot_id, revision, kind, status,
       operations_json, layout_id, base_layout_checksum, base_layout_json,
       layout_operations_json, rationale, assumptions_json, generation_payload_json,
       review_json, created_by_run_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 1, 'workspace-generation', 'draft', '[]', 'default',
       'layout-checksum', '{}', '[]', 'test', '[]', '{"kind":"workspace-generation"}',
       '{"kind":"none"}', NULL, 10, 10)`,
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

  return {
    kernelRevisionId: workspace.activeKernelRevisionId,
    planId,
    projectId: project.id,
    snapshotId: workspace.activeSnapshotId,
    workspaceId: workspace.id,
  };
}

test("additive migration restores Generation Plan execution tables and the construction seal", () => {
  const db = openFreshDatabase();
  try {
    const triggerNames = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'trigger' AND (name LIKE 'generation_%' OR name LIKE 'generation\_%' ESCAPE '\\')`,
    ).all() as Array<{ name: string }>;
    for (const { name } of triggerNames) db.exec(`DROP TRIGGER "${name}"`);
    db.exec(`
      DROP TABLE generation_task_attempt_dependency_outputs;
      ALTER TABLE generation_task_attempts DROP COLUMN materialization_sealed;
      ALTER TABLE generation_plans DROP COLUMN construction_sealed;
    `);

    // Store opens every existing file by replaying idempotent DDL before the
    // additive column migration. Keep that exact ordering under test.
    db.exec(STORE_SCHEMA);
    migrateStoreSchema(db);

    const names = tableNames(db);
    for (const table of GENERATION_TABLES) assert.ok(names.has(table), `migration missed ${table}`);
    const columns = new Set(
      (db.prepare("PRAGMA table_info(generation_plans)").all() as Array<{ name: string }>).map(({ name }) => name),
    );
    assert.ok(columns.has("construction_sealed"));
    const attemptColumns = new Set(
      (db.prepare("PRAGMA table_info(generation_task_attempts)").all() as Array<{ name: string }>).map(
        ({ name }) => name,
      ),
    );
    assert.ok(attemptColumns.has("materialization_sealed"));
    assert.equal(
      (db.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = 'generation_task_intent_update_immutable'",
      ).get() as { count: number }).count,
      1,
    );
  } finally {
    db.close();
  }
});

test("additive migration installs retry lineage after replaying the pre-lineage Attempt table", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE generation_task_attempts (
        task_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        target_artifact_id TEXT,
        target_track_id TEXT,
        target_resource_id TEXT,
        base_revision_id TEXT,
        expected_snapshot_id TEXT NOT NULL,
        context_pack_id TEXT,
        kernel_revision_id TEXT NOT NULL,
        execution_mode TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        pinned_resource_revision_ids_json TEXT NOT NULL,
        component_dependency_revision_ids_json TEXT NOT NULL,
        materialization_sealed INTEGER NOT NULL DEFAULT 0,
        retry_context_policy TEXT NOT NULL,
        status TEXT NOT NULL,
        blocked_reason TEXT,
        failure_class TEXT,
        error_json TEXT,
        next_eligible_at INTEGER,
        candidate_revision_id TEXT,
        candidate_resource_revision_id TEXT,
        candidate_evidence_json TEXT,
        candidate_evidence_hash TEXT,
        owner_id TEXT,
        lease_token TEXT,
        lease_expires_at INTEGER,
        heartbeat_at INTEGER,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        PRIMARY KEY(task_id, attempt),
        UNIQUE(task_id, attempt, workspace_id),
        UNIQUE(task_id, attempt, plan_id, workspace_id)
      );
    `);
    db.prepare(
      `INSERT INTO generation_task_attempts (
         task_id, plan_id, workspace_id, attempt, target_artifact_id, target_track_id,
         base_revision_id, expected_snapshot_id, kernel_revision_id, execution_mode,
         payload_json, input_hash, pinned_resource_revision_ids_json,
         component_dependency_revision_ids_json, materialization_sealed,
         retry_context_policy, status, created_at
       ) VALUES ('legacy-task', 'legacy-plan', 'legacy-workspace', 1,
         'legacy-artifact', 'legacy-track', 'legacy-revision', 'legacy-snapshot',
         'legacy-kernel', 'full', '{}', 'legacy-input-hash', '[]', '[]', 1,
         'same-context', 'failed', 10)`,
    ).run();

    // Store replays idempotent DDL before additive ALTERs. No index or trigger
    // in the replay may reference the new lineage columns until migration adds
    // them to this pre-lineage table.
    assert.doesNotThrow(() => db.exec(STORE_SCHEMA));
    assert.doesNotThrow(() => migrateStoreSchema(db));

    const attemptColumns = new Set(
      (db.prepare("PRAGMA table_info(generation_task_attempts)").all() as Array<{ name: string }>).map(
        ({ name }) => name,
      ),
    );
    assert.deepEqual(
      [
        "attempt_origin",
        "predecessor_attempt",
        "automatic_retry_index",
        "source_commit_hash",
        "source_tree_hash",
      ].filter(
        (column) => !attemptColumns.has(column),
      ),
      [],
    );
    assert.deepEqual(
      { ...(db.prepare(
        `SELECT source_commit_hash AS sourceCommitHash, source_tree_hash AS sourceTreeHash
         FROM generation_task_attempts WHERE task_id = 'legacy-task' AND attempt = 1`,
      ).get() as Record<string, unknown>) },
      { sourceCommitHash: null, sourceTreeHash: null },
      "additive migration must preserve a readable nullable disposition for historical Attempts",
    );
    assert.equal(
      Number((db.prepare(
        `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE type = 'index' AND name = 'idx_generation_task_attempt_retry_predecessor'`,
      ).get() as { count: number }).count),
      1,
    );
  } finally {
    db.close();
  }
});

function insertWorkspaceTask(
  db: DatabaseSync,
  fixture: PlanFixture,
  input: { id: string; kind: "prototype-validation" | "checkpoint"; ordinal: number },
): void {
  db.prepare(
    `INSERT INTO generation_tasks (
       id, workspace_id, plan_id, ordinal, kind, target_type, target_id,
       target_artifact_id, target_track_id, target_resource_id,
       payload_json, intent_hash, capabilities_json, qa_profile_json, resource_limits_json,
       idempotency_key, status, created_at
     ) VALUES (?, ?, ?, ?, ?, 'workspace', ?, NULL, NULL, NULL,
       '{}', ?, '[]', '{}', '{}', ?, 'materialization-pending', 20)`,
  ).run(
    input.id,
    fixture.workspaceId,
    fixture.planId,
    input.ordinal,
    input.kind,
    fixture.workspaceId,
    `intent-${input.id}`,
    `idempotency-${input.id}`,
  );
}

function insertTaskAttempt(
  db: DatabaseSync,
  fixture: PlanFixture,
  input: {
    baseRevisionId?: string | null;
    componentRevisionIds?: string[];
    contextPackId?: string | null;
    expectedSnapshotId?: string;
    kernelRevisionId?: string;
    resourceRevisionIds?: string[];
    targetArtifactId?: string | null;
    targetResourceId?: string | null;
    targetTrackId?: string | null;
    taskId: string;
  },
): void {
  db.prepare(
    `INSERT INTO generation_task_attempts (
       task_id, plan_id, workspace_id, attempt, target_artifact_id, target_track_id,
       target_resource_id, base_revision_id, expected_snapshot_id, context_pack_id,
       kernel_revision_id, execution_mode, payload_json, input_hash,
       pinned_resource_revision_ids_json, component_dependency_revision_ids_json,
       retry_context_policy, status, created_at
     ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'full', '{}', ?, ?, ?,
       'same-context', 'queued', 50)`,
  ).run(
    input.taskId,
    fixture.planId,
    fixture.workspaceId,
    input.targetArtifactId ?? null,
    input.targetTrackId ?? null,
    input.targetResourceId ?? null,
    input.baseRevisionId ?? null,
    input.expectedSnapshotId ?? fixture.snapshotId,
    input.contextPackId ?? null,
    input.kernelRevisionId ?? fixture.kernelRevisionId,
    `input-${input.taskId}`,
    JSON.stringify(input.resourceRevisionIds ?? []),
    JSON.stringify(input.componentRevisionIds ?? []),
  );
}

test("construction seal freezes task intent and append-only Plan history", () => {
  const store = new Store();
  try {
    const fixture = createPlanFixture(store, "sealed");
    insertWorkspaceTask(store.db, fixture, { id: "validate-sealed", kind: "prototype-validation", ordinal: 0 });
    insertWorkspaceTask(store.db, fixture, { id: "checkpoint-sealed", kind: "checkpoint", ordinal: 1 });
    store.db.prepare(
      `INSERT INTO generation_task_dependencies
         (plan_id, workspace_id, task_id, dependency_task_id, ordinal)
       VALUES (?, ?, 'checkpoint-sealed', 'validate-sealed', 0)`,
    ).run(fixture.planId, fixture.workspaceId);

    assert.throws(
      () => store.db.prepare(
        `INSERT INTO generation_task_materialization_failures (
           task_id, plan_id, workspace_id, sequence, failure_class, error_json,
           next_eligible_at, created_at
         ) VALUES ('validate-sealed', ?, ?, 1, 'context', '{}', NULL, 29)`,
      ).run(fixture.planId, fixture.workspaceId),
      /materialization|plan|state|sealed/i,
    );

    store.db.prepare("UPDATE generation_plans SET construction_sealed = 1 WHERE id = ?").run(fixture.planId);
    store.db.prepare("UPDATE generation_plans SET status = 'queued' WHERE id = ?").run(fixture.planId);
    store.db.prepare(
      `INSERT INTO generation_plan_events
         (plan_id, workspace_id, sequence, task_id, type, payload_json, created_at)
       VALUES (?, ?, 1, NULL, 'plan-queued', '{}', 30)`,
    ).run(fixture.planId, fixture.workspaceId);

    assert.throws(
      () => store.db.prepare("UPDATE generation_tasks SET payload_json = '{\"rewritten\":true}' WHERE id = 'validate-sealed'").run(),
      /immutable|sealed/i,
    );
    assert.throws(
      () => store.db.prepare("DELETE FROM generation_task_dependencies WHERE task_id = 'checkpoint-sealed'").run(),
      /immutable|sealed/i,
    );
    assert.throws(
      () => store.db.prepare("UPDATE generation_plans SET construction_sealed = 0 WHERE id = ?").run(fixture.planId),
      /seal|immutable/i,
    );
    assert.throws(
      () => store.db.prepare(
        "UPDATE generation_plans SET status = 'succeeded', finished_at = 31 WHERE id = ?",
      ).run(fixture.planId),
      /status|transition|execution state/i,
    );
    assert.throws(
      () => store.db.prepare(
        "UPDATE generation_plans SET finished_at = 31 WHERE id = ?",
      ).run(fixture.planId),
      /status|execution state/i,
    );
    assert.throws(
      () => store.db.prepare(
        "UPDATE generation_plans SET compile_error_json = '{}' WHERE id = ?",
      ).run(fixture.planId),
      /status|execution state/i,
    );
    assert.throws(
      () => store.db.prepare(
        `INSERT INTO generation_plan_events
           (plan_id, workspace_id, sequence, task_id, type, payload_json, created_at)
         VALUES (?, ?, 3, NULL, 'plan-failed', '{}', 31)`,
      ).run(fixture.planId, fixture.workspaceId),
      /append-only|sequence|contiguous/i,
    );
    assert.throws(
      () => store.db.prepare("UPDATE generation_plan_events SET payload_json = '{\"changed\":true}' WHERE plan_id = ?").run(fixture.planId),
      /append-only|immutable/i,
    );
  } finally {
    store.close();
  }
});

test("attempt sealing advances current only after the exact succeeded dependency outputs are frozen", () => {
  const store = new Store();
  try {
    const fixture = createPlanFixture(store, "dependency-output");
    insertWorkspaceTask(store.db, fixture, { id: "checkpoint-source", kind: "checkpoint", ordinal: 0 });
    insertWorkspaceTask(store.db, fixture, { id: "checkpoint-dependent", kind: "checkpoint", ordinal: 1 });
    store.db.prepare(
      `INSERT INTO generation_task_dependencies
         (plan_id, workspace_id, task_id, dependency_task_id, ordinal)
       VALUES (?, ?, 'checkpoint-dependent', 'checkpoint-source', 0)`,
    ).run(fixture.planId, fixture.workspaceId);
    store.db.prepare("UPDATE generation_plans SET construction_sealed = 1, status = 'queued' WHERE id = ?")
      .run(fixture.planId);

    insertTaskAttempt(store.db, fixture, { taskId: "checkpoint-source" });
    assert.equal(
      (store.db.prepare("SELECT current_attempt FROM generation_tasks WHERE id = 'checkpoint-source'").get() as {
        current_attempt: number;
      }).current_attempt,
      0,
    );
    store.db.prepare(
      `UPDATE generation_task_attempts SET materialization_sealed = 1
       WHERE task_id = 'checkpoint-source' AND attempt = 1`,
    ).run();
    insertTaskAttempt(store.db, fixture, { taskId: "checkpoint-dependent" });

    assert.throws(
      () => store.db.prepare(
        `INSERT INTO generation_task_attempt_dependency_outputs (
           task_id, plan_id, attempt, workspace_id, ordinal, dependency_task_id,
           result_revision_id, result_resource_revision_id, result_snapshot_id
         ) VALUES ('checkpoint-dependent', ?, 1, ?, 0, 'checkpoint-source', NULL, NULL, NULL)`,
      ).run(fixture.planId, fixture.workspaceId),
      /dependency|succeeded|result|materialization/i,
    );
    assert.throws(
      () => store.db.prepare(
        `UPDATE generation_task_attempts SET materialization_sealed = 1
         WHERE task_id = 'checkpoint-dependent' AND attempt = 1`,
      ).run(),
      /dependency|materialization|seal/i,
    );

    store.db.prepare(
      `UPDATE generation_task_attempts
       SET status = 'succeeded', finished_at = 60
       WHERE task_id = 'checkpoint-source' AND attempt = 1`,
    ).run();
    store.db.prepare(
      `UPDATE generation_tasks
       SET status = 'succeeded', result_snapshot_id = ?, finished_at = 60
       WHERE id = 'checkpoint-source'`,
    ).run(fixture.snapshotId);
    assert.throws(
      () => store.db.prepare(
        `INSERT INTO generation_task_attempt_dependency_outputs (
           task_id, plan_id, attempt, workspace_id, ordinal, dependency_task_id,
           result_revision_id, result_resource_revision_id, result_snapshot_id
         ) VALUES ('checkpoint-dependent', ?, 1, ?, 0, 'checkpoint-source', NULL, NULL, NULL)`,
      ).run(fixture.planId, fixture.workspaceId),
      /dependency|succeeded|result|materialization/i,
    );
    store.db.prepare(
      `INSERT INTO generation_task_attempt_dependency_outputs (
         task_id, plan_id, attempt, workspace_id, ordinal, dependency_task_id,
         result_revision_id, result_resource_revision_id, result_snapshot_id
       ) VALUES ('checkpoint-dependent', ?, 1, ?, 0, 'checkpoint-source', NULL, NULL, ?)`,
    ).run(fixture.planId, fixture.workspaceId, fixture.snapshotId);
    assert.equal(
      (store.db.prepare("SELECT current_attempt FROM generation_tasks WHERE id = 'checkpoint-dependent'").get() as {
        current_attempt: number;
      }).current_attempt,
      0,
    );
    store.db.prepare(
      `UPDATE generation_task_attempts SET materialization_sealed = 1
       WHERE task_id = 'checkpoint-dependent' AND attempt = 1`,
    ).run();
    assert.equal(
      (store.db.prepare("SELECT current_attempt FROM generation_tasks WHERE id = 'checkpoint-dependent'").get() as {
        current_attempt: number;
      }).current_attempt,
      1,
    );
    assert.throws(
      () => store.db.prepare(
        `DELETE FROM generation_task_attempt_dependency_outputs
         WHERE task_id = 'checkpoint-dependent' AND attempt = 1`,
      ).run(),
      /dependency|immutable|seal/i,
    );
  } finally {
    store.close();
  }
});

test("attempt construction rejects inactive Snapshots and incorrect Context target, intent, or non-agent use", () => {
  const store = new Store();
  try {
    const fixture = createPlanFixture(store, "attempt-context");
    insertWorkspaceTask(store.db, fixture, { id: "validate-context", kind: "prototype-validation", ordinal: 0 });
    store.db.prepare(
      `INSERT INTO resources (
         id, workspace_id, kind, title, head_revision_id, default_pin_policy,
         archived_at, created_at, updated_at
       ) VALUES ('resource-context', ?, 'research', 'Context research', NULL,
         'follow-head', NULL, 20, 20)`,
    ).run(fixture.workspaceId);
    store.db.prepare(
      `INSERT INTO generation_tasks (
         id, workspace_id, plan_id, ordinal, kind, target_type, target_id,
         target_artifact_id, target_track_id, target_resource_id,
         payload_json, intent_hash, capabilities_json, qa_profile_json, resource_limits_json,
         idempotency_key, status, created_at
       ) VALUES ('resource-task-context', ?, ?, 1, 'resource', 'resource', 'resource-context',
         NULL, NULL, 'resource-context', '{}', 'resource-context-intent', '[]', '{}', '{}',
         'resource-context-idempotency', 'materialization-pending', 21)`,
    ).run(fixture.workspaceId, fixture.planId);
    store.db.prepare(
      `INSERT INTO context_packs (
         id, workspace_id, scope_type, scope_id, graph_revision, intent, message_checksum,
         manifest_path, token_estimate, omissions_json, hash, created_at, sealed
       ) VALUES
         ('pack-context-correct', ?, 'resource', 'resource-context', 0, 'generate', 'message-correct',
           'pack-context-correct.json', 0, '[]', 'pack-context-correct-hash', 22, 0),
         ('pack-context-target', ?, 'workspace', ?, 0, 'generate', 'message-target',
           'pack-context-target.json', 0, '[]', 'pack-context-target-hash', 22, 0),
         ('pack-context-intent', ?, 'resource', 'resource-context', 0, 'edit', 'message-intent',
           'pack-context-intent.json', 0, '[]', 'pack-context-intent-hash', 22, 0)`,
    ).run(fixture.workspaceId, fixture.workspaceId, fixture.workspaceId, fixture.workspaceId);
    store.db.prepare(
      `UPDATE context_packs SET sealed = 1
       WHERE id IN ('pack-context-correct', 'pack-context-target', 'pack-context-intent')`,
    ).run();
    store.db.prepare(
      `INSERT INTO workspace_snapshots (
         id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
         reason, provenance_json, created_by_run_id, created_at, sealed
       ) VALUES ('snapshot-context-inactive', ?, 2, ?, 0, ?, 'inactive-test', '{}', NULL, 23, 1)`,
    ).run(fixture.workspaceId, fixture.snapshotId, fixture.kernelRevisionId);
    store.db.prepare("UPDATE generation_plans SET construction_sealed = 1, status = 'queued' WHERE id = ?")
      .run(fixture.planId);

    assert.throws(
      () => insertTaskAttempt(store.db, fixture, {
        contextPackId: "pack-context-correct",
        expectedSnapshotId: "snapshot-context-inactive",
        targetResourceId: "resource-context",
        taskId: "resource-task-context",
      }),
      /active|snapshot|input|ownership/i,
    );
    assert.throws(
      () => insertTaskAttempt(store.db, fixture, {
        contextPackId: "pack-context-target",
        targetResourceId: "resource-context",
        taskId: "resource-task-context",
      }),
      /context|target|input|ownership/i,
    );
    assert.throws(
      () => insertTaskAttempt(store.db, fixture, {
        contextPackId: "pack-context-intent",
        targetResourceId: "resource-context",
        taskId: "resource-task-context",
      }),
      /context|intent|input|ownership/i,
    );
    assert.throws(
      () => insertTaskAttempt(store.db, fixture, {
        contextPackId: "pack-context-target",
        taskId: "validate-context",
      }),
      /context|non-agent|input|ownership/i,
    );

    insertTaskAttempt(store.db, fixture, {
      contextPackId: "pack-context-correct",
      targetResourceId: "resource-context",
      taskId: "resource-task-context",
    });
    assert.throws(
      () => store.db.prepare(
        `INSERT INTO generation_task_materialization_failures (
           task_id, plan_id, workspace_id, sequence, failure_class, error_json,
           next_eligible_at, created_at
         ) VALUES ('resource-task-context', ?, ?, 1, 'storage', '{}', 1000, 60)`,
      ).run(fixture.planId, fixture.workspaceId),
      /materialization|attempt|state|sealed/i,
    );
    store.db.prepare(
      `INSERT INTO workspace_graph_revisions
         (workspace_id, revision, nodes_json, edges_json, checksum, created_at)
       SELECT workspace_id, 1, nodes_json, edges_json, 'context-next-graph', 61
       FROM workspace_graph_revisions WHERE workspace_id = ? AND revision = 0`,
    ).run(fixture.workspaceId);
    store.db.prepare(
      `INSERT INTO workspace_snapshots (
         id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
         reason, provenance_json, created_by_run_id, created_at, sealed
       ) VALUES ('snapshot-context-next', ?, 3, ?, 1, ?, 'advance-test', '{}', NULL, 62, 1)`,
    ).run(fixture.workspaceId, fixture.snapshotId, fixture.kernelRevisionId);
    store.db.prepare(
      `UPDATE project_workspaces
       SET active_snapshot_id = 'snapshot-context-next', graph_revision = 1
       WHERE id = ?`,
    ).run(fixture.workspaceId);
    assert.throws(
      () => store.db.prepare(
        `UPDATE generation_task_attempts SET materialization_sealed = 1
         WHERE task_id = 'resource-task-context' AND attempt = 1`,
      ).run(),
      /active|snapshot|materialization|seal/i,
    );
    assert.equal(
      (store.db.prepare("SELECT current_attempt FROM generation_tasks WHERE id = 'resource-task-context'").get() as {
        current_attempt: number;
      }).current_attempt,
      0,
    );
  } finally {
    store.close();
  }
});

test("attempt input ownership, current pointer, and candidate evidence are database-enforced", () => {
  const store = new Store();
  try {
    const fixture = createPlanFixture(store, "attempt");
    insertWorkspaceTask(store.db, fixture, { id: "validate-attempt", kind: "prototype-validation", ordinal: 0 });

    store.db.prepare(
      `INSERT INTO resources (
         id, workspace_id, kind, title, head_revision_id, default_pin_policy,
         archived_at, created_at, updated_at
       ) VALUES ('resource-attempt', ?, 'research', 'Research', NULL, 'follow-head', NULL, 20, 20)`,
    ).run(fixture.workspaceId);
    store.db.prepare(
      `INSERT INTO resource_revisions (
         id, workspace_id, resource_id, sequence, parent_revision_id, manifest_path, summary,
         metadata_json, checksum, provenance_json, created_by_run_id, created_at
       ) VALUES ('resource-revision-attempt', ?, 'resource-attempt', 1, NULL,
         'resource-attempt.json', 'Research', '{}', 'resource-checksum', '{}', NULL, 21)`,
    ).run(fixture.workspaceId);
    store.db.prepare(
      `INSERT INTO generation_tasks (
         id, workspace_id, plan_id, ordinal, kind, target_type, target_id,
         target_artifact_id, target_track_id, target_resource_id,
         payload_json, intent_hash, capabilities_json, qa_profile_json, resource_limits_json,
         idempotency_key, status, created_at
       ) VALUES ('resource-task-attempt', ?, ?, 1, 'resource', 'resource', 'resource-attempt',
         NULL, NULL, 'resource-attempt', '{}', 'resource-intent', '[]', '{}', '{}',
         'resource-idempotency', 'materialization-pending', 22)`,
    ).run(fixture.workspaceId, fixture.planId);
    store.db.prepare(
      `INSERT INTO context_packs (
         id, workspace_id, scope_type, scope_id, graph_revision, intent, message_checksum,
         manifest_path, token_estimate, omissions_json, hash, created_at, sealed
       ) VALUES ('pack-attempt', ?, 'resource', 'resource-attempt', 0, 'generate', 'message-checksum',
         'pack-attempt.json', 0, '[]', 'pack-hash-attempt', 23, 0)`,
    ).run(fixture.workspaceId);
    store.db.prepare("UPDATE context_packs SET sealed = 1 WHERE id = 'pack-attempt'").run();
    store.db.prepare("UPDATE generation_plans SET construction_sealed = 1, status = 'queued' WHERE id = ?")
      .run(fixture.planId);

    store.db.prepare(
      `INSERT INTO shared_design_kernel_revisions (
         id, workspace_id, sequence, parent_revision_id, payload_json, checksum, created_at
       )
       SELECT 'kernel-attempt-mismatch', workspace_id, sequence + 1, id, payload_json, checksum, created_at + 1
       FROM shared_design_kernel_revisions WHERE id = ?`,
    ).run(fixture.kernelRevisionId);
    assert.throws(
      () => store.db.prepare(
        `INSERT INTO generation_task_attempts (
           task_id, plan_id, workspace_id, attempt, target_artifact_id, target_track_id,
           target_resource_id, base_revision_id, expected_snapshot_id, context_pack_id,
           kernel_revision_id, execution_mode, payload_json, input_hash,
           pinned_resource_revision_ids_json, component_dependency_revision_ids_json,
           retry_context_policy, status, created_at
         ) VALUES ('resource-task-attempt', ?, ?, 1, NULL, NULL, 'resource-attempt',
           'resource-revision-attempt', ?, 'pack-attempt', 'kernel-attempt-mismatch', 'full', '{}',
           'mismatched-kernel-input', '["resource-revision-attempt"]', '[]',
           'same-context', 'queued', 24)`,
      ).run(fixture.planId, fixture.workspaceId, fixture.snapshotId),
      /input|ownership|snapshot|kernel/i,
    );
    assert.equal(
      (store.db.prepare(
        "SELECT current_attempt FROM generation_tasks WHERE id = 'resource-task-attempt'",
      ).get() as { current_attempt: number }).current_attempt,
      0,
    );

    store.db.prepare(
      `INSERT INTO generation_task_attempts (
         task_id, plan_id, workspace_id, attempt, target_artifact_id, target_track_id,
         target_resource_id, base_revision_id, expected_snapshot_id, context_pack_id,
         kernel_revision_id, execution_mode, payload_json, input_hash,
         pinned_resource_revision_ids_json, component_dependency_revision_ids_json,
         retry_context_policy, status, created_at
       ) VALUES ('validate-attempt', ?, ?, 1, NULL, NULL, NULL, NULL, ?, NULL, ?,
         'full', '{}', 'validation-input', '[]', '[]', 'same-context', 'queued', 24)`,
    ).run(fixture.planId, fixture.workspaceId, fixture.snapshotId, fixture.kernelRevisionId);
    assert.equal(
      (store.db.prepare("SELECT current_attempt FROM generation_tasks WHERE id = 'validate-attempt'").get() as {
        current_attempt: number;
      }).current_attempt,
      0,
    );
    store.db.prepare(
      `UPDATE generation_task_attempts SET materialization_sealed = 1
       WHERE task_id = 'validate-attempt' AND attempt = 1`,
    ).run();
    assert.equal(
      (store.db.prepare("SELECT current_attempt FROM generation_tasks WHERE id = 'validate-attempt'").get() as {
        current_attempt: number;
      }).current_attempt,
      1,
    );
    assert.throws(
      () => store.db.prepare("UPDATE generation_task_attempts SET input_hash = 'rewritten' WHERE task_id = 'validate-attempt'").run(),
      /input.*immutable/i,
    );
    assert.throws(
      () => store.db.prepare("UPDATE generation_tasks SET current_attempt = 3 WHERE id = 'validate-attempt'").run(),
      /exact successor/i,
    );

    store.db.prepare(
      `INSERT INTO generation_task_attempts (
         task_id, plan_id, workspace_id, attempt, target_artifact_id, target_track_id,
         target_resource_id, base_revision_id, expected_snapshot_id, context_pack_id,
         kernel_revision_id, execution_mode, payload_json, input_hash,
         pinned_resource_revision_ids_json, component_dependency_revision_ids_json,
         retry_context_policy, status, created_at
       ) VALUES ('resource-task-attempt', ?, ?, 1, NULL, NULL, 'resource-attempt',
         'resource-revision-attempt', ?, 'pack-attempt', ?, 'full', '{}', 'resource-input',
         '["resource-revision-attempt"]', '[]', 'same-context', 'queued', 25)`,
    ).run(fixture.planId, fixture.workspaceId, fixture.snapshotId, fixture.kernelRevisionId);
    assert.equal(
      (store.db.prepare(
        "SELECT current_attempt FROM generation_tasks WHERE id = 'resource-task-attempt'",
      ).get() as { current_attempt: number }).current_attempt,
      0,
    );
    assert.throws(
      () => store.db.prepare(
        `UPDATE generation_task_attempts SET materialization_sealed = 1
         WHERE task_id = 'resource-task-attempt' AND attempt = 1`,
      ).run(),
      /materialization|pin|summary|seal/i,
    );
    store.db.prepare(
      `INSERT INTO generation_task_attempt_resource_pins (
         task_id, plan_id, attempt, workspace_id, ordinal, resource_id, revision_id, source_task_id
       ) VALUES ('resource-task-attempt', ?, 1, ?, 0, 'resource-attempt',
         'resource-revision-attempt', NULL)`,
    ).run(fixture.planId, fixture.workspaceId);
    store.db.prepare(
      `UPDATE generation_task_attempts SET materialization_sealed = 1
       WHERE task_id = 'resource-task-attempt' AND attempt = 1`,
    ).run();
    assert.equal(
      (store.db.prepare(
        "SELECT current_attempt FROM generation_tasks WHERE id = 'resource-task-attempt'",
      ).get() as { current_attempt: number }).current_attempt,
      1,
    );
    assert.throws(
      () => store.db.prepare(
        `INSERT INTO generation_task_attempt_resource_pins (
           task_id, plan_id, attempt, workspace_id, ordinal, resource_id, revision_id, source_task_id
         ) VALUES ('resource-task-attempt', ?, 1, ?, 1, 'resource-attempt',
           'resource-revision-attempt', NULL)`,
      ).run(fixture.planId, fixture.workspaceId),
      /materialization|immutable|seal/i,
    );
    store.db.prepare(
      `UPDATE generation_task_attempts
       SET candidate_resource_revision_id = 'resource-revision-attempt',
           candidate_evidence_json = '{"qa":"passed"}',
           candidate_evidence_hash = 'evidence-hash'
       WHERE task_id = 'resource-task-attempt' AND attempt = 1`,
    ).run();
    assert.throws(
      () => store.db.prepare(
        `UPDATE generation_task_attempts
         SET candidate_evidence_json = '{"qa":"rewritten"}'
         WHERE task_id = 'resource-task-attempt' AND attempt = 1`,
      ).run(),
      /write-once/i,
    );
    store.db.prepare(
      `UPDATE generation_task_attempts SET status = 'succeeded', finished_at = 70
       WHERE task_id = 'resource-task-attempt' AND attempt = 1`,
    ).run();
    store.db.prepare(
      `UPDATE generation_tasks
       SET status = 'succeeded', result_resource_revision_id = 'resource-revision-attempt',
           result_snapshot_id = ?, finished_at = 70
       WHERE id = 'resource-task-attempt'`,
    ).run(fixture.snapshotId);
    assert.deepEqual(
      { ...store.db.prepare(
        `SELECT result_resource_revision_id, result_snapshot_id
         FROM generation_tasks WHERE id = 'resource-task-attempt'`,
      ).get() },
      {
        result_resource_revision_id: "resource-revision-attempt",
        result_snapshot_id: fixture.snapshotId,
      },
    );
  } finally {
    store.close();
  }
});
