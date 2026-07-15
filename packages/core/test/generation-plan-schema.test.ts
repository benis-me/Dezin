import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { migrateStoreSchema, STORE_SCHEMA } from "../src/store-schema.ts";
import { Store } from "../src/store.ts";

const GENERATION_TABLES = [
  "generation_tasks",
  "generation_task_dependencies",
  "generation_task_attempts",
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
        name: string;
        notnull: number;
      }>).map(({ name, notnull }) => [name, notnull]),
    );
    assert.equal(attemptColumns.get("context_pack_id"), 0);
    assert.equal(attemptColumns.has("candidate_evidence_hash"), true);

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
    db.exec(`
      DROP TRIGGER generation_plan_construction_seal_guard;
      DROP TRIGGER generation_plan_execution_requires_seal;
      DROP TRIGGER generation_plan_initial_state_guard;
      DROP TRIGGER generation_plan_status_transition_guard;
      DROP TRIGGER generation_plan_terminal_state_guard;
      DROP TRIGGER generation_run_insert_ownership;
      DROP TRIGGER generation_run_update_immutable;
      DROP TABLE generation_task_claims;
      DROP TABLE generation_task_attempt_component_pins;
      DROP TABLE generation_task_attempt_resource_pins;
      DROP TABLE generation_task_materialization_failures;
      DROP TABLE generation_plan_events;
      DROP TABLE generation_task_attempts;
      DROP TABLE generation_task_dependencies;
      DROP TABLE generation_tasks;
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
       ) VALUES ('pack-attempt', ?, 'workspace', ?, 0, 'generate', 'message-checksum',
         'pack-attempt.json', 0, '[]', 'pack-hash-attempt', 23, 0)`,
    ).run(fixture.workspaceId, fixture.workspaceId);
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
  } finally {
    store.close();
  }
});
