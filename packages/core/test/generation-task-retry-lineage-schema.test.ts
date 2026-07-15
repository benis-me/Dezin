import assert from "node:assert/strict";
import { test } from "node:test";

import { Store } from "../src/store.ts";

function insertWorkspaceTask(
  store: Store,
  input: { id: string; planId: string; workspaceId: string; ordinal: number },
): void {
  store.db.prepare(
    `INSERT INTO generation_tasks (
       id, workspace_id, plan_id, ordinal, kind, target_type, target_id,
       target_artifact_id, target_track_id, target_resource_id,
       payload_json, intent_hash, capabilities_json, qa_profile_json, resource_limits_json,
       idempotency_key, status, created_at
     ) VALUES (?, ?, ?, ?, 'prototype-validation', 'workspace', ?, NULL, NULL, NULL,
       '{}', ?, '[]', '{}', '{"capacityClasses":["render-qa"]}', ?,
       'materialization-pending', 20)`,
  ).run(
    input.id,
    input.workspaceId,
    input.planId,
    input.ordinal,
    input.workspaceId,
    `intent-${input.id}`,
    `idempotency-${input.id}`,
  );
}

test("retry lineage preserves the active-Snapshot gate and seals only exact historical successors", () => {
  const store = new Store();
  try {
    const project = store.createProject({ name: "Retry lineage schema", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    const proposalId = "retry-lineage-proposal";
    const planId = "retry-lineage-plan";
    const retryTaskId = "retry-lineage-task";
    const materializedTaskId = "retry-lineage-materialized-control";

    store.db.prepare(
      `INSERT INTO workspace_proposals (
         id, workspace_id, base_graph_revision, base_snapshot_id, revision, kind, status,
         operations_json, layout_id, base_layout_checksum, base_layout_json,
         layout_operations_json, rationale, assumptions_json, generation_payload_json,
         review_json, created_by_run_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 1, 'workspace-generation', 'draft', '[]', 'default',
         'layout-checksum', '{}', '[]', 'retry lineage fixture', '[]',
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
    insertWorkspaceTask(store, { id: retryTaskId, planId, workspaceId: workspace.id, ordinal: 0 });
    insertWorkspaceTask(store, { id: materializedTaskId, planId, workspaceId: workspace.id, ordinal: 1 });
    store.db.prepare(
      "UPDATE generation_plans SET construction_sealed = 1, status = 'queued' WHERE id = ?",
    ).run(planId);
    store.db.prepare(
      `INSERT INTO generation_plan_events (
         plan_id, workspace_id, sequence, task_id, type, payload_json, created_at
       ) VALUES (?, ?, 1, NULL, 'plan-queued', '{}', 30)`,
    ).run(planId, workspace.id);

    const insertAttempt = store.db.prepare(
      `INSERT INTO generation_task_attempts (
         task_id, plan_id, workspace_id, attempt, attempt_origin, predecessor_attempt,
         automatic_retry_index, target_artifact_id, target_track_id, target_resource_id,
         base_revision_id, expected_snapshot_id, context_pack_id, kernel_revision_id,
         execution_mode, payload_json, input_hash, pinned_resource_revision_ids_json,
         component_dependency_revision_ids_json, retry_context_policy, status,
         materialization_sealed, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL, ?, ?, ?, ?,
         '[]', '[]', 'same-context', 'queued', 0, ?)`,
    );
    insertAttempt.run(
      retryTaskId,
      planId,
      workspace.id,
      1,
      "materialized",
      null,
      0,
      workspace.activeSnapshotId,
      workspace.activeKernelRevisionId,
      "full",
      "{}",
      "input-attempt-1",
      40,
    );
    store.db.prepare(
      `UPDATE generation_task_attempts SET materialization_sealed = 1
       WHERE task_id = ? AND attempt = 1`,
    ).run(retryTaskId);
    store.db.prepare("UPDATE generation_tasks SET status = 'queued' WHERE id = ?").run(retryTaskId);

    store.db.prepare(
      `INSERT INTO workspace_graph_revisions (
         workspace_id, revision, nodes_json, edges_json, checksum, created_at
       ) SELECT workspace_id, 1, nodes_json, edges_json, 'retry-lineage-graph-1', 50
         FROM workspace_graph_revisions WHERE workspace_id = ? AND revision = 0`,
    ).run(workspace.id);
    store.db.prepare(
      `INSERT INTO workspace_snapshots (
         id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
         reason, provenance_json, created_by_run_id, created_at, sealed
       ) VALUES ('retry-lineage-snapshot-2', ?, 2, ?, 1, ?, 'lineage-test', '{}', NULL, 51, 1)`,
    ).run(workspace.id, workspace.activeSnapshotId, workspace.activeKernelRevisionId);
    store.db.prepare(
      `UPDATE project_workspaces
       SET active_snapshot_id = 'retry-lineage-snapshot-2', graph_revision = 1
       WHERE id = ?`,
    ).run(workspace.id);

    assert.throws(
      () => insertAttempt.run(
        materializedTaskId,
        planId,
        workspace.id,
        1,
        "materialized",
        null,
        0,
        workspace.activeSnapshotId,
        workspace.activeKernelRevisionId,
        "full",
        "{}",
        "stale-materialized-input",
        60,
      ),
      /snapshot|input|ownership/i,
      "ordinary materialization must remain pinned to the active Snapshot",
    );

    store.db.prepare(
      `UPDATE generation_task_attempts
       SET status = 'retryable-failed', failure_class = 'build-infrastructure',
           error_json = '{"code":"lease-expired"}', next_eligible_at = 1000,
           started_at = 100, finished_at = 200
       WHERE task_id = ? AND attempt = 1`,
    ).run(retryTaskId);
    store.db.prepare(
      `UPDATE generation_tasks
       SET status = 'retry-wait', failure_class = 'build-infrastructure',
           error_json = '{"code":"lease-expired"}', next_eligible_at = 1000
       WHERE id = ?`,
    ).run(retryTaskId);

    assert.throws(
      () => insertAttempt.run(
        retryTaskId,
        planId,
        workspace.id,
        2,
        "same-input-retry",
        1,
        1,
        workspace.activeSnapshotId,
        workspace.activeKernelRevisionId,
        "full",
        '{"diverged":true}',
        "input-attempt-2-diverged",
        201,
      ),
      /exact|successor|retry/i,
    );
    insertAttempt.run(
      retryTaskId,
      planId,
      workspace.id,
      2,
      "same-input-retry",
      1,
      1,
      workspace.activeSnapshotId,
      workspace.activeKernelRevisionId,
      "full",
      "{}",
      "input-attempt-2",
      201,
    );
    store.db.prepare(
      `UPDATE generation_task_attempts SET materialization_sealed = 1
       WHERE task_id = ? AND attempt = 2`,
    ).run(retryTaskId);
    assert.equal(
      Number((store.db.prepare(
        `SELECT current_attempt FROM generation_tasks WHERE id = ?`,
      ).get(retryTaskId) as { current_attempt: number }).current_attempt),
      2,
    );
    assert.throws(
      () => store.db.prepare(
        `UPDATE generation_task_attempts SET predecessor_attempt = NULL
         WHERE task_id = ? AND attempt = 2`,
      ).run(retryTaskId),
      /immutable/i,
    );

    store.db.prepare(
      `UPDATE generation_task_attempts
       SET status = 'needs-rebase', failure_class = 'publication-conflict',
           error_json = '{"code":"head-moved"}', next_eligible_at = NULL,
           started_at = 300, finished_at = 301
       WHERE task_id = ? AND attempt = 2`,
    ).run(retryTaskId);
    store.db.prepare(
      `UPDATE generation_tasks
       SET status = 'needs-rebase', failure_class = 'publication-conflict',
           error_json = '{"code":"head-moved"}', next_eligible_at = NULL
       WHERE id = ?`,
    ).run(retryTaskId);
    insertAttempt.run(
      retryTaskId,
      planId,
      workspace.id,
      3,
      "publication-retry",
      2,
      2,
      workspace.activeSnapshotId,
      workspace.activeKernelRevisionId,
      "publication-only",
      "{}",
      "input-attempt-3",
      302,
    );
    store.db.prepare(
      `UPDATE generation_task_attempts SET materialization_sealed = 1
       WHERE task_id = ? AND attempt = 3`,
    ).run(retryTaskId);
    assert.deepEqual(
      { ...(store.db.prepare(
        `SELECT attempt_origin, predecessor_attempt, automatic_retry_index, expected_snapshot_id,
                candidate_revision_id, candidate_resource_revision_id, candidate_evidence_json,
                candidate_evidence_hash
         FROM generation_task_attempts WHERE task_id = ? AND attempt = 3`,
      ).get(retryTaskId) as Record<string, unknown>) },
      {
        attempt_origin: "publication-retry",
        predecessor_attempt: 2,
        automatic_retry_index: 2,
        expected_snapshot_id: workspace.activeSnapshotId,
        candidate_revision_id: null,
        candidate_resource_revision_id: null,
        candidate_evidence_json: null,
        candidate_evidence_hash: null,
      },
    );
  } finally {
    store.close();
  }
});
