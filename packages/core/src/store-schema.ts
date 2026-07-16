import type { DatabaseSync } from "node:sqlite";

const TASK12_GENERATION_TABLE_SCHEMA = `
CREATE TABLE IF NOT EXISTS generation_tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal <= 9007199254740991),
  kind TEXT NOT NULL CHECK(kind IN (
    'resource','component','page','prototype-validation','checkpoint',
    'propagation-candidate','propagation-publish'
  )),
  target_type TEXT NOT NULL CHECK(target_type IN ('artifact','resource','workspace')),
  target_id TEXT NOT NULL,
  target_artifact_id TEXT,
  target_track_id TEXT,
  target_resource_id TEXT,
  payload_json TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  qa_profile_json TEXT NOT NULL,
  resource_limits_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN (
    'materialization-pending','retry-wait','blocked-context','queued','running',
    'candidate-ready','needs-rebase','awaiting-context-refresh','cancel-requested',
    'succeeded','failed','blocked','cancelled'
  )),
  blocked_reason TEXT,
  blocked_by_task_id TEXT,
  pending_context_policy TEXT CHECK(pending_context_policy IN ('same-context','latest-context')),
  current_attempt INTEGER NOT NULL DEFAULT 0
    CHECK(current_attempt >= 0 AND current_attempt <= 9007199254740991),
  materialization_failures INTEGER NOT NULL DEFAULT 0
    CHECK(materialization_failures >= 0 AND materialization_failures <= 9007199254740991),
  failure_class TEXT CHECK(failure_class IN (
    'context','adapter','storage','provider','agent-transport','build-infrastructure',
    'design','build','qa','publication-conflict','cancelled','unknown'
  )),
  error_json TEXT,
  next_eligible_at INTEGER,
  result_revision_id TEXT,
  result_resource_revision_id TEXT,
  result_snapshot_id TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  FOREIGN KEY(plan_id, workspace_id)
    REFERENCES generation_plans(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(target_artifact_id, workspace_id)
    REFERENCES workspace_artifacts(id, workspace_id),
  FOREIGN KEY(target_track_id, target_artifact_id)
    REFERENCES artifact_tracks(id, artifact_id),
  FOREIGN KEY(target_resource_id, workspace_id)
    REFERENCES resources(id, workspace_id),
  FOREIGN KEY(blocked_by_task_id, plan_id, workspace_id)
    REFERENCES generation_tasks(id, plan_id, workspace_id),
  FOREIGN KEY(result_revision_id, target_artifact_id, target_track_id, workspace_id)
    REFERENCES artifact_revisions(id, artifact_id, track_id, workspace_id),
  FOREIGN KEY(result_resource_revision_id, target_resource_id, workspace_id)
    REFERENCES resource_revisions(id, resource_id, workspace_id),
  FOREIGN KEY(result_snapshot_id, workspace_id)
    REFERENCES workspace_snapshots(id, workspace_id),
  CHECK(
    (target_type = 'artifact' AND target_artifact_id = target_id
      AND target_track_id IS NOT NULL AND target_resource_id IS NULL) OR
    (target_type = 'resource' AND target_resource_id = target_id
      AND target_artifact_id IS NULL AND target_track_id IS NULL) OR
    (target_type = 'workspace' AND target_id = workspace_id
      AND target_artifact_id IS NULL AND target_track_id IS NULL AND target_resource_id IS NULL)
  ),
  CHECK(
    (result_revision_id IS NULL OR target_artifact_id IS NOT NULL)
    AND (result_resource_revision_id IS NULL OR target_resource_id IS NOT NULL)
  ),
  CHECK(json_valid(payload_json) = 1 AND json_type(payload_json) = 'object'),
  CHECK(json_valid(capabilities_json) = 1 AND json_type(capabilities_json) = 'array'),
  CHECK(json_valid(qa_profile_json) = 1 AND json_type(qa_profile_json) = 'object'),
  CHECK(json_valid(resource_limits_json) = 1 AND json_type(resource_limits_json) = 'object'),
  CHECK(error_json IS NULL OR json_valid(error_json) = 1),
  UNIQUE(id, workspace_id),
  UNIQUE(id, plan_id),
  UNIQUE(id, plan_id, workspace_id),
  UNIQUE(plan_id, ordinal),
  UNIQUE(id, target_artifact_id, workspace_id),
  UNIQUE(id, target_artifact_id, target_track_id, workspace_id),
  UNIQUE(id, target_resource_id, workspace_id)
);
CREATE TABLE IF NOT EXISTS generation_task_dependencies (
  plan_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  dependency_task_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal <= 9007199254740991),
  FOREIGN KEY(plan_id, workspace_id)
    REFERENCES generation_plans(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(task_id, plan_id, workspace_id)
    REFERENCES generation_tasks(id, plan_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(dependency_task_id, plan_id, workspace_id)
    REFERENCES generation_tasks(id, plan_id, workspace_id) ON DELETE CASCADE,
  CHECK(task_id <> dependency_task_id),
  PRIMARY KEY(task_id, dependency_task_id),
  UNIQUE(task_id, ordinal)
);
CREATE TABLE IF NOT EXISTS generation_task_attempts (
  task_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK(attempt > 0 AND attempt <= 9007199254740991),
  target_artifact_id TEXT,
  target_track_id TEXT,
  target_resource_id TEXT,
  base_revision_id TEXT,
  source_commit_hash TEXT,
  source_tree_hash TEXT,
  expected_snapshot_id TEXT NOT NULL,
  context_pack_id TEXT,
  kernel_revision_id TEXT NOT NULL,
  execution_mode TEXT NOT NULL CHECK(execution_mode IN ('full','publication-only')),
  payload_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  pinned_resource_revision_ids_json TEXT NOT NULL,
  component_dependency_revision_ids_json TEXT NOT NULL,
  materialization_sealed INTEGER NOT NULL DEFAULT 0 CHECK(materialization_sealed IN (0, 1)),
  attempt_origin TEXT NOT NULL DEFAULT 'materialized' CHECK(attempt_origin IN (
    'materialized','same-input-retry','publication-retry'
  )),
  predecessor_attempt INTEGER CHECK(
    predecessor_attempt > 0 AND predecessor_attempt <= 9007199254740991
  ),
  automatic_retry_index INTEGER NOT NULL DEFAULT 0 CHECK(
    automatic_retry_index >= 0 AND automatic_retry_index <= 3
  ),
  retry_context_policy TEXT NOT NULL CHECK(retry_context_policy IN ('same-context','latest-context')),
  status TEXT NOT NULL CHECK(status IN (
    'queued','running','cancel-requested','candidate-ready','succeeded','retryable-failed',
    'failed','needs-rebase','cancelled'
  )),
  blocked_reason TEXT,
  failure_class TEXT CHECK(failure_class IN (
    'context','adapter','storage','provider','agent-transport','build-infrastructure',
    'design','build','qa','publication-conflict','cancelled','unknown'
  )),
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
  FOREIGN KEY(task_id, plan_id, workspace_id)
    REFERENCES generation_tasks(id, plan_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(task_id, target_artifact_id, target_track_id, workspace_id)
    REFERENCES generation_tasks(id, target_artifact_id, target_track_id, workspace_id),
  FOREIGN KEY(task_id, target_resource_id, workspace_id)
    REFERENCES generation_tasks(id, target_resource_id, workspace_id),
  FOREIGN KEY(expected_snapshot_id, workspace_id)
    REFERENCES workspace_snapshots(id, workspace_id),
  FOREIGN KEY(context_pack_id, workspace_id)
    REFERENCES context_packs(id, workspace_id),
  FOREIGN KEY(kernel_revision_id, workspace_id)
    REFERENCES shared_design_kernel_revisions(id, workspace_id),
  FOREIGN KEY(candidate_revision_id, target_artifact_id, target_track_id, workspace_id)
    REFERENCES artifact_revisions(id, artifact_id, track_id, workspace_id),
  FOREIGN KEY(candidate_resource_revision_id, target_resource_id, workspace_id)
    REFERENCES resource_revisions(id, resource_id, workspace_id),
  FOREIGN KEY(task_id, predecessor_attempt)
    REFERENCES generation_task_attempts(task_id, attempt),
  CHECK(
    (target_artifact_id IS NOT NULL AND target_track_id IS NOT NULL AND target_resource_id IS NULL) OR
    (target_artifact_id IS NULL AND target_track_id IS NULL)
  ),
  CHECK((source_commit_hash IS NULL) = (source_tree_hash IS NULL)),
  CHECK(target_artifact_id IS NOT NULL OR source_commit_hash IS NULL),
  CHECK(source_commit_hash IS NULL OR (
    length(source_commit_hash) IN (40, 64)
    AND length(source_tree_hash) = length(source_commit_hash)
    AND source_commit_hash NOT GLOB '*[^0-9a-f]*'
    AND source_tree_hash NOT GLOB '*[^0-9a-f]*'
  )),
  CHECK(
    (candidate_revision_id IS NULL AND candidate_resource_revision_id IS NULL
      AND candidate_evidence_json IS NULL AND candidate_evidence_hash IS NULL) OR
    (candidate_revision_id IS NOT NULL AND target_artifact_id IS NOT NULL
      AND candidate_resource_revision_id IS NULL
      AND candidate_evidence_json IS NOT NULL AND candidate_evidence_hash IS NOT NULL) OR
    (candidate_resource_revision_id IS NOT NULL AND target_resource_id IS NOT NULL
      AND candidate_revision_id IS NULL
      AND candidate_evidence_json IS NOT NULL AND candidate_evidence_hash IS NOT NULL)
  ),
  CHECK(
    (owner_id IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND heartbeat_at IS NULL) OR
    (owner_id IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CHECK(json_valid(payload_json) = 1 AND json_type(payload_json) = 'object'),
  CHECK(json_valid(pinned_resource_revision_ids_json) = 1
    AND json_type(pinned_resource_revision_ids_json) = 'array'),
  CHECK(json_valid(component_dependency_revision_ids_json) = 1
    AND json_type(component_dependency_revision_ids_json) = 'array'),
  CHECK(error_json IS NULL OR json_valid(error_json) = 1),
  CHECK(candidate_evidence_json IS NULL OR json_valid(candidate_evidence_json) = 1),
  PRIMARY KEY(task_id, attempt),
  UNIQUE(task_id, attempt, workspace_id),
  UNIQUE(task_id, attempt, plan_id, workspace_id)
);
CREATE TABLE IF NOT EXISTS resource_payload_staging_journal (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK(attempt > 0 AND attempt <= 9007199254740991),
  input_hash TEXT NOT NULL CHECK(length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
  workspace_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  manifest_path TEXT NOT NULL,
  payload_checksum TEXT NOT NULL CHECK(length(payload_checksum) = 64 AND payload_checksum NOT GLOB '*[^0-9a-f]*'),
  manifest_checksum TEXT NOT NULL CHECK(length(manifest_checksum) = 64 AND manifest_checksum NOT GLOB '*[^0-9a-f]*'),
  receipt_checksum TEXT NOT NULL CHECK(length(receipt_checksum) = 64 AND receipt_checksum NOT GLOB '*[^0-9a-f]*'),
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0 AND byte_size <= 9007199254740991),
  mime_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('prepared','receipt-committed')),
  storage_disposition TEXT CHECK(storage_disposition IN ('owned-created','preexisting')),
  created_at INTEGER NOT NULL CHECK(created_at >= 0 AND created_at <= 9007199254740991),
  classified_at INTEGER CHECK(classified_at >= 0 AND classified_at <= 9007199254740991),
  receipt_committed_at INTEGER CHECK(receipt_committed_at >= 0 AND receipt_committed_at <= 9007199254740991),
  FOREIGN KEY(task_id, attempt, plan_id, workspace_id)
    REFERENCES generation_task_attempts(task_id, attempt, plan_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(task_id, resource_id, workspace_id)
    REFERENCES generation_tasks(id, target_resource_id, workspace_id),
  FOREIGN KEY(resource_id, workspace_id)
    REFERENCES resources(id, workspace_id),
  CHECK(
    (storage_disposition IS NULL AND classified_at IS NULL)
    OR (storage_disposition IS NOT NULL AND classified_at IS NOT NULL AND classified_at >= created_at)
  ),
  CHECK(
    (status = 'prepared' AND receipt_committed_at IS NULL)
    OR (status = 'receipt-committed' AND storage_disposition IS NOT NULL
      AND receipt_committed_at IS NOT NULL AND receipt_committed_at >= classified_at)
  ),
  UNIQUE(task_id, attempt),
  UNIQUE(task_id, attempt, workspace_id, resource_id, revision_id)
);
CREATE TABLE IF NOT EXISTS resource_payload_cleanup_claims (
  revision_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK(attempt > 0 AND attempt <= 9007199254740991),
  input_hash TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('claimed','completed')),
  claimed_at INTEGER NOT NULL CHECK(claimed_at >= 0 AND claimed_at <= 9007199254740991),
  completed_at INTEGER CHECK(completed_at >= 0 AND completed_at <= 9007199254740991),
  FOREIGN KEY(task_id, attempt, plan_id, workspace_id)
    REFERENCES generation_task_attempts(task_id, attempt, plan_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(task_id, resource_id, workspace_id)
    REFERENCES generation_tasks(id, target_resource_id, workspace_id),
  FOREIGN KEY(resource_id, workspace_id)
    REFERENCES resources(id, workspace_id),
  CHECK(
    (status = 'claimed' AND completed_at IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL AND completed_at >= claimed_at)
  ),
  UNIQUE(task_id, attempt),
  UNIQUE(task_id, attempt, workspace_id, resource_id, revision_id)
);
CREATE TABLE IF NOT EXISTS generation_task_attempt_dependency_outputs (
  task_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal <= 9007199254740991),
  dependency_task_id TEXT NOT NULL,
  result_revision_id TEXT,
  result_resource_revision_id TEXT,
  result_snapshot_id TEXT,
  FOREIGN KEY(task_id, attempt, plan_id, workspace_id)
    REFERENCES generation_task_attempts(task_id, attempt, plan_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(task_id, dependency_task_id)
    REFERENCES generation_task_dependencies(task_id, dependency_task_id),
  FOREIGN KEY(dependency_task_id, plan_id, workspace_id)
    REFERENCES generation_tasks(id, plan_id, workspace_id),
  FOREIGN KEY(result_revision_id, workspace_id)
    REFERENCES artifact_revisions(id, workspace_id),
  FOREIGN KEY(result_resource_revision_id, workspace_id)
    REFERENCES resource_revisions(id, workspace_id),
  FOREIGN KEY(result_snapshot_id, workspace_id)
    REFERENCES workspace_snapshots(id, workspace_id),
  PRIMARY KEY(task_id, attempt, dependency_task_id),
  UNIQUE(task_id, attempt, ordinal)
);
CREATE TABLE IF NOT EXISTS generation_task_attempt_resource_pins (
  task_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal <= 9007199254740991),
  resource_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  source_task_id TEXT,
  FOREIGN KEY(task_id, attempt, plan_id, workspace_id)
    REFERENCES generation_task_attempts(task_id, attempt, plan_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(revision_id, resource_id, workspace_id)
    REFERENCES resource_revisions(id, resource_id, workspace_id),
  FOREIGN KEY(source_task_id, plan_id)
    REFERENCES generation_tasks(id, plan_id),
  PRIMARY KEY(task_id, attempt, resource_id),
  UNIQUE(task_id, attempt, ordinal)
);
CREATE TABLE IF NOT EXISTS generation_task_attempt_component_pins (
  task_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal <= 9007199254740991),
  instance_id TEXT NOT NULL,
  owner_artifact_id TEXT NOT NULL,
  component_artifact_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  source_task_id TEXT,
  variant_key TEXT,
  state_key TEXT,
  design_node_id TEXT NOT NULL,
  source_locator_json TEXT NOT NULL,
  overrides_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('linked','detached')),
  FOREIGN KEY(task_id, attempt, plan_id, workspace_id)
    REFERENCES generation_task_attempts(task_id, attempt, plan_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(task_id, owner_artifact_id, workspace_id)
    REFERENCES generation_tasks(id, target_artifact_id, workspace_id),
  FOREIGN KEY(instance_id, owner_artifact_id, component_artifact_id, workspace_id)
    REFERENCES component_instances(id, owner_artifact_id, component_artifact_id, workspace_id),
  FOREIGN KEY(revision_id, component_artifact_id, workspace_id)
    REFERENCES artifact_revisions(id, artifact_id, workspace_id),
  FOREIGN KEY(source_task_id, plan_id)
    REFERENCES generation_tasks(id, plan_id),
  CHECK(json_valid(source_locator_json) = 1 AND json_type(source_locator_json) = 'object'),
  CHECK(json_valid(overrides_json) = 1 AND json_type(overrides_json) = 'object'),
  PRIMARY KEY(task_id, attempt, instance_id),
  UNIQUE(task_id, attempt, ordinal)
);
CREATE TABLE IF NOT EXISTS generation_task_validation_results (
  task_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK(attempt > 0 AND attempt <= 9007199254740991),
  snapshot_id TEXT NOT NULL,
  graph_revision INTEGER NOT NULL CHECK(graph_revision >= 0 AND graph_revision <= 9007199254740991),
  artifact_revision_ids_json TEXT NOT NULL,
  resource_revision_ids_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  validation_fence_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at >= 0 AND created_at <= 9007199254740991),
  FOREIGN KEY(task_id, attempt, plan_id, workspace_id)
    REFERENCES generation_task_attempts(task_id, attempt, plan_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(snapshot_id, workspace_id)
    REFERENCES workspace_snapshots(id, workspace_id) ON DELETE CASCADE,
  CHECK(json_valid(artifact_revision_ids_json) = 1
    AND json_type(artifact_revision_ids_json) = 'array'),
  CHECK(json_valid(resource_revision_ids_json) = 1
    AND json_type(resource_revision_ids_json) = 'array'),
  CHECK(json_valid(evidence_json) = 1 AND json_type(evidence_json) = 'object'),
  CHECK(length(evidence_hash) = 64 AND evidence_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(validation_fence_hash) = 64 AND validation_fence_hash NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(task_id, attempt),
  UNIQUE(task_id, attempt, workspace_id)
);
CREATE TABLE IF NOT EXISTS generation_task_materialization_failures (
  task_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence > 0 AND sequence <= 9007199254740991),
  failure_class TEXT NOT NULL CHECK(failure_class IN (
    'context','adapter','storage','provider','agent-transport','build-infrastructure',
    'design','build','qa','publication-conflict','cancelled','unknown'
  )),
  error_json TEXT NOT NULL CHECK(json_valid(error_json) = 1),
  next_eligible_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(task_id, plan_id, workspace_id)
    REFERENCES generation_tasks(id, plan_id, workspace_id) ON DELETE CASCADE,
  PRIMARY KEY(task_id, sequence)
);
CREATE TABLE IF NOT EXISTS generation_task_claims (
  claim_key TEXT PRIMARY KEY,
  claim_kind TEXT NOT NULL CHECK(claim_kind IN ('capacity','writer')),
  task_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(task_id, attempt, plan_id, workspace_id)
    REFERENCES generation_task_attempts(task_id, attempt, plan_id, workspace_id) ON DELETE CASCADE,
  CHECK(lease_expires_at > created_at)
);
CREATE TABLE IF NOT EXISTS generation_plan_events (
  plan_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence > 0 AND sequence <= 9007199254740991),
  task_id TEXT,
  type TEXT NOT NULL CHECK(type IN (
    'plan-queued','plan-compile-failed','task-materialization-failed','task-blocked-context',
    'task-materialized','task-running','task-candidate-ready','task-needs-rebase',
    'task-retry-wait','task-succeeded','task-failed','task-blocked','task-cancel-requested',
    'task-cancelled','plan-succeeded','plan-failed','plan-cancelled'
  )),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json) = 1),
  created_at INTEGER NOT NULL,
  FOREIGN KEY(plan_id, workspace_id)
    REFERENCES generation_plans(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(task_id, plan_id, workspace_id)
    REFERENCES generation_tasks(id, plan_id, workspace_id) ON DELETE CASCADE,
  CHECK(
    (type LIKE 'task-%' AND task_id IS NOT NULL) OR
    (type LIKE 'plan-%' AND task_id IS NULL)
  ),
  PRIMARY KEY(plan_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_generation_tasks_plan_status
  ON generation_tasks(plan_id, status, next_eligible_at, id);
CREATE INDEX IF NOT EXISTS idx_generation_tasks_workspace_status
  ON generation_tasks(workspace_id, status, next_eligible_at, id);
CREATE INDEX IF NOT EXISTS idx_generation_task_dependencies_dependency
  ON generation_task_dependencies(dependency_task_id, task_id);
CREATE INDEX IF NOT EXISTS idx_generation_task_attempts_status
  ON generation_task_attempts(workspace_id, status, next_eligible_at, task_id, attempt);
CREATE INDEX IF NOT EXISTS idx_resource_payload_cleanup_claims_status
  ON resource_payload_cleanup_claims(status, revision_id);
CREATE INDEX IF NOT EXISTS idx_resource_payload_staging_journal_recovery
  ON resource_payload_staging_journal(sequence, status, revision_id);
CREATE INDEX IF NOT EXISTS idx_generation_attempt_dependency_outputs_source
  ON generation_task_attempt_dependency_outputs(dependency_task_id, task_id, attempt);
CREATE INDEX IF NOT EXISTS idx_generation_attempt_resource_pins_revision
  ON generation_task_attempt_resource_pins(revision_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_generation_attempt_component_pins_revision
  ON generation_task_attempt_component_pins(revision_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_generation_materialization_failures_task
  ON generation_task_materialization_failures(task_id, sequence DESC);
CREATE INDEX IF NOT EXISTS idx_generation_task_claims_task
  ON generation_task_claims(task_id, attempt);
CREATE INDEX IF NOT EXISTS idx_generation_task_claims_expiry
  ON generation_task_claims(lease_expires_at, claim_key);
CREATE INDEX IF NOT EXISTS idx_generation_plan_events_plan
  ON generation_plan_events(plan_id, sequence);
`;

const TASK12_GENERATION_TRIGGER_SCHEMA = `
DROP TRIGGER IF EXISTS generation_plan_construction_seal_guard;
DROP TRIGGER IF EXISTS generation_plan_execution_requires_seal;
DROP TRIGGER IF EXISTS generation_plan_initial_state_guard;
DROP TRIGGER IF EXISTS generation_plan_status_transition_guard;
DROP TRIGGER IF EXISTS generation_plan_terminal_state_guard;
DROP TRIGGER IF EXISTS generation_task_insert_guard;
DROP TRIGGER IF EXISTS generation_task_intent_update_immutable;
DROP TRIGGER IF EXISTS generation_task_delete_history_guard;
DROP TRIGGER IF EXISTS generation_task_dependency_insert_guard;
DROP TRIGGER IF EXISTS generation_task_dependency_update_immutable;
DROP TRIGGER IF EXISTS generation_task_dependency_delete_history_guard;
DROP TRIGGER IF EXISTS generation_task_current_attempt_guard;
DROP TRIGGER IF EXISTS generation_task_result_write_once;
DROP TRIGGER IF EXISTS generation_task_attempt_insert_guard;
DROP TRIGGER IF EXISTS generation_task_attempt_retry_insert_guard;
DROP TRIGGER IF EXISTS generation_task_attempt_materialization_seal_guard;
DROP TRIGGER IF EXISTS generation_task_attempt_retry_materialization_seal_guard;
DROP TRIGGER IF EXISTS generation_task_attempt_advance_current;
DROP TRIGGER IF EXISTS generation_task_attempt_input_update_immutable;
DROP TRIGGER IF EXISTS generation_task_attempt_candidate_write_once;
DROP TRIGGER IF EXISTS generation_task_attempt_delete_history_guard;
DROP TRIGGER IF EXISTS generation_task_validation_result_insert_guard;
DROP TRIGGER IF EXISTS generation_task_validation_result_update_immutable;
DROP TRIGGER IF EXISTS generation_task_validation_result_delete_history_guard;
DROP TRIGGER IF EXISTS generation_attempt_dependency_output_insert_guard;
DROP TRIGGER IF EXISTS generation_attempt_dependency_output_update_immutable;
DROP TRIGGER IF EXISTS generation_attempt_dependency_output_delete_history_guard;
DROP TRIGGER IF EXISTS generation_attempt_resource_pin_insert_guard;
DROP TRIGGER IF EXISTS generation_attempt_resource_pin_update_immutable;
DROP TRIGGER IF EXISTS generation_attempt_resource_pin_delete_history_guard;
DROP TRIGGER IF EXISTS generation_attempt_component_pin_insert_guard;
DROP TRIGGER IF EXISTS generation_attempt_component_pin_update_immutable;
DROP TRIGGER IF EXISTS generation_attempt_component_pin_delete_history_guard;
DROP TRIGGER IF EXISTS generation_materialization_failure_insert_guard;
DROP TRIGGER IF EXISTS generation_materialization_failure_advance_count;
DROP TRIGGER IF EXISTS generation_materialization_failure_update_immutable;
DROP TRIGGER IF EXISTS generation_materialization_failure_delete_history_guard;
DROP TRIGGER IF EXISTS generation_plan_event_insert_guard;
DROP TRIGGER IF EXISTS generation_plan_event_update_immutable;
DROP TRIGGER IF EXISTS generation_plan_event_delete_history_guard;
DROP TRIGGER IF EXISTS generation_task_claim_insert_guard;
DROP TRIGGER IF EXISTS generation_task_claim_identity_update_immutable;
DROP TRIGGER IF EXISTS generation_task_claim_lease_update_guard;
DROP TRIGGER IF EXISTS generation_task_claim_delete_live_guard;
DROP TRIGGER IF EXISTS generation_task_attempt_running_entry_guard;
DROP TRIGGER IF EXISTS generation_task_attempt_lease_fence_guard;
DROP TRIGGER IF EXISTS generation_task_running_entry_guard;
DROP TRIGGER IF EXISTS generation_run_insert_ownership;
DROP TRIGGER IF EXISTS generation_run_update_immutable;
DROP TRIGGER IF EXISTS generation_resource_payload_staging_insert_guard;
DROP TRIGGER IF EXISTS generation_resource_payload_staging_identity_update_immutable;
DROP TRIGGER IF EXISTS generation_resource_payload_staging_transition_guard;
DROP TRIGGER IF EXISTS generation_resource_payload_staging_delete_history_guard;
DROP TRIGGER IF EXISTS resource_payload_cleanup_insert_guard;
DROP TRIGGER IF EXISTS resource_payload_cleanup_identity_update_immutable;
DROP TRIGGER IF EXISTS resource_payload_cleanup_completion_guard;
DROP TRIGGER IF EXISTS resource_revision_cleanup_tombstone_insert_guard;
DROP TRIGGER IF EXISTS generation_resource_payload_cleanup_insert_guard;
DROP TRIGGER IF EXISTS generation_resource_payload_cleanup_identity_update_immutable;
DROP TRIGGER IF EXISTS generation_resource_payload_cleanup_completion_guard;
DROP TRIGGER IF EXISTS generation_resource_revision_cleanup_tombstone_insert_guard;

CREATE TRIGGER generation_resource_payload_staging_insert_guard
BEFORE INSERT ON resource_payload_staging_journal
WHEN NEW.status <> 'prepared'
  OR NEW.storage_disposition IS NOT NULL
  OR NEW.classified_at IS NOT NULL
  OR NEW.receipt_committed_at IS NOT NULL
  OR NOT EXISTS (
    SELECT 1
    FROM generation_task_attempts attempt
    JOIN generation_tasks task
      ON task.id = attempt.task_id
     AND task.plan_id = attempt.plan_id
     AND task.workspace_id = attempt.workspace_id
    WHERE attempt.task_id = NEW.task_id
      AND attempt.plan_id = NEW.plan_id
      AND attempt.attempt = NEW.attempt
      AND attempt.input_hash = NEW.input_hash
      AND attempt.workspace_id = NEW.workspace_id
      AND attempt.target_resource_id = NEW.resource_id
      AND attempt.status IN ('running','cancel-requested')
      AND attempt.owner_id = NEW.owner_id
      AND attempt.lease_token = NEW.lease_token
      AND attempt.lease_expires_at IS NOT NULL
      AND attempt.lease_expires_at > NEW.created_at
      AND task.kind = 'resource'
      AND task.target_type = 'resource'
      AND task.target_resource_id = NEW.resource_id
      AND task.workspace_id = NEW.workspace_id
  )
  OR EXISTS (
    SELECT 1 FROM resource_revisions revision WHERE revision.id = NEW.revision_id
  )
  OR EXISTS (
    SELECT 1 FROM generation_task_attempts candidate
    WHERE candidate.candidate_resource_revision_id = NEW.revision_id
  )
  OR EXISTS (
    SELECT 1 FROM generation_tasks result
    WHERE result.result_resource_revision_id = NEW.revision_id
  )
BEGIN SELECT RAISE(ABORT, 'Resource payload staging journal is not an exact active Resource Attempt'); END;

CREATE TRIGGER generation_resource_payload_staging_identity_update_immutable
BEFORE UPDATE OF revision_id, task_id, plan_id, attempt, input_hash, workspace_id,
  resource_id, owner_id, lease_token, manifest_path, payload_checksum, manifest_checksum, receipt_checksum,
  byte_size, mime_type, created_at ON resource_payload_staging_journal
WHEN NEW.revision_id IS NOT OLD.revision_id
  OR NEW.task_id IS NOT OLD.task_id
  OR NEW.plan_id IS NOT OLD.plan_id
  OR NEW.attempt IS NOT OLD.attempt
  OR NEW.input_hash IS NOT OLD.input_hash
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.resource_id IS NOT OLD.resource_id
  OR NEW.owner_id IS NOT OLD.owner_id
  OR NEW.lease_token IS NOT OLD.lease_token
  OR NEW.manifest_path IS NOT OLD.manifest_path
  OR NEW.payload_checksum IS NOT OLD.payload_checksum
  OR NEW.manifest_checksum IS NOT OLD.manifest_checksum
  OR NEW.receipt_checksum IS NOT OLD.receipt_checksum
  OR NEW.byte_size IS NOT OLD.byte_size
  OR NEW.mime_type IS NOT OLD.mime_type
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'Resource payload staging journal identity is immutable'); END;

CREATE TRIGGER generation_resource_payload_staging_transition_guard
BEFORE UPDATE OF status, storage_disposition, classified_at, receipt_committed_at
ON resource_payload_staging_journal
WHEN NOT (
  OLD.status = 'prepared'
  AND NEW.status = 'prepared'
  AND OLD.storage_disposition IS NULL
  AND OLD.classified_at IS NULL
  AND NEW.storage_disposition IN ('owned-created','preexisting')
  AND NEW.classified_at IS NOT NULL
  AND NEW.classified_at >= OLD.created_at
  AND NEW.receipt_committed_at IS NULL
  AND EXISTS (
    SELECT 1 FROM generation_task_attempts attempt
    WHERE attempt.task_id = OLD.task_id
      AND attempt.attempt = OLD.attempt
      AND attempt.workspace_id = OLD.workspace_id
      AND attempt.owner_id = OLD.owner_id
      AND attempt.lease_token = OLD.lease_token
      AND attempt.status IN ('running','cancel-requested')
      AND attempt.lease_expires_at > NEW.classified_at
  )
) AND NOT (
  OLD.status = 'prepared'
  AND OLD.storage_disposition IS NOT NULL
  AND OLD.classified_at IS NOT NULL
  AND NEW.status = 'receipt-committed'
  AND NEW.storage_disposition IS OLD.storage_disposition
  AND NEW.classified_at IS OLD.classified_at
  AND NEW.receipt_committed_at IS NOT NULL
  AND NEW.receipt_committed_at >= OLD.classified_at
  AND EXISTS (
    SELECT 1 FROM generation_task_attempts attempt
    WHERE attempt.task_id = OLD.task_id
      AND attempt.attempt = OLD.attempt
      AND attempt.workspace_id = OLD.workspace_id
      AND attempt.owner_id = OLD.owner_id
      AND attempt.lease_token = OLD.lease_token
      AND attempt.status IN ('running','cancel-requested')
      AND attempt.lease_expires_at > NEW.receipt_committed_at
  )
)
BEGIN SELECT RAISE(ABORT, 'Resource payload staging journal transition is not append-only'); END;

CREATE TRIGGER generation_resource_payload_staging_delete_history_guard
BEFORE DELETE ON resource_payload_staging_journal
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Resource payload staging journal is durable history'); END;

CREATE TRIGGER generation_resource_payload_cleanup_insert_guard
BEFORE INSERT ON resource_payload_cleanup_claims
WHEN NEW.status <> 'claimed'
  OR NEW.completed_at IS NOT NULL
  OR NOT EXISTS (
    SELECT 1
    FROM generation_task_attempts attempt
    JOIN generation_tasks task
      ON task.id = attempt.task_id
     AND task.plan_id = attempt.plan_id
     AND task.workspace_id = attempt.workspace_id
    WHERE attempt.task_id = NEW.task_id
      AND attempt.plan_id = NEW.plan_id
      AND attempt.attempt = NEW.attempt
      AND attempt.input_hash = NEW.input_hash
      AND attempt.workspace_id = NEW.workspace_id
      AND attempt.target_resource_id = NEW.resource_id
      AND task.kind = 'resource'
      AND task.target_type = 'resource'
      AND task.target_resource_id = NEW.resource_id
      AND task.workspace_id = NEW.workspace_id
      AND attempt.status IN ('succeeded','retryable-failed','failed','needs-rebase','cancelled')
      AND attempt.materialization_sealed = 1
      AND attempt.candidate_revision_id IS NULL
      AND attempt.candidate_resource_revision_id IS NULL
      AND attempt.candidate_evidence_json IS NULL
      AND attempt.candidate_evidence_hash IS NULL
      AND attempt.owner_id IS NULL
      AND attempt.lease_token IS NULL
      AND attempt.lease_expires_at IS NULL
      AND attempt.heartbeat_at IS NULL
      AND attempt.finished_at IS NOT NULL
  )
  OR NOT EXISTS (
    SELECT 1 FROM resource_payload_staging_journal journal
    WHERE journal.revision_id = NEW.revision_id
      AND journal.task_id = NEW.task_id
      AND journal.plan_id = NEW.plan_id
      AND journal.attempt = NEW.attempt
      AND journal.input_hash = NEW.input_hash
      AND journal.workspace_id = NEW.workspace_id
      AND journal.resource_id = NEW.resource_id
  )
  OR EXISTS (
    SELECT 1 FROM generation_task_claims claim
    WHERE claim.task_id = NEW.task_id AND claim.attempt = NEW.attempt
  )
  OR EXISTS (
    SELECT 1 FROM resource_revisions revision
    WHERE revision.id = NEW.revision_id
       OR (revision.workspace_id = NEW.workspace_id
           AND revision.resource_id = NEW.resource_id
           AND revision.id = NEW.revision_id)
  )
  OR EXISTS (
    SELECT 1 FROM generation_task_attempts candidate
    WHERE candidate.candidate_resource_revision_id = NEW.revision_id
  )
  OR EXISTS (
    SELECT 1 FROM generation_tasks result
    WHERE result.result_resource_revision_id = NEW.revision_id
  )
BEGIN SELECT RAISE(ABORT, 'Resource payload cleanup claim is not an exact unreferenced terminal Attempt'); END;

CREATE TRIGGER generation_resource_payload_cleanup_identity_update_immutable
BEFORE UPDATE OF revision_id, task_id, plan_id, attempt, input_hash,
  workspace_id, resource_id, claimed_at ON resource_payload_cleanup_claims
WHEN NEW.revision_id IS NOT OLD.revision_id
  OR NEW.task_id IS NOT OLD.task_id
  OR NEW.plan_id IS NOT OLD.plan_id
  OR NEW.attempt IS NOT OLD.attempt
  OR NEW.input_hash IS NOT OLD.input_hash
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.resource_id IS NOT OLD.resource_id
  OR NEW.claimed_at IS NOT OLD.claimed_at
BEGIN SELECT RAISE(ABORT, 'Resource payload cleanup claim identity is immutable'); END;

CREATE TRIGGER generation_resource_payload_cleanup_completion_guard
BEFORE UPDATE OF status, completed_at ON resource_payload_cleanup_claims
WHEN NOT (
  OLD.status = 'claimed' AND OLD.completed_at IS NULL
  AND NEW.status = 'completed' AND NEW.completed_at IS NOT NULL
  AND NEW.completed_at >= OLD.claimed_at
)
BEGIN SELECT RAISE(ABORT, 'Resource payload cleanup completion is append-only'); END;

CREATE TRIGGER generation_resource_revision_cleanup_tombstone_insert_guard
BEFORE INSERT ON resource_revisions
WHEN EXISTS (
  SELECT 1 FROM resource_payload_cleanup_claims cleanup
  WHERE cleanup.revision_id = NEW.id
)
BEGIN SELECT RAISE(ABORT, 'Resource Revision payload is tombstoned for cleanup'); END;

CREATE TRIGGER generation_plan_construction_seal_guard
BEFORE UPDATE OF construction_sealed ON generation_plans
WHEN NEW.construction_sealed IS NOT OLD.construction_sealed AND NOT (
  OLD.construction_sealed = 0
  AND NEW.construction_sealed = 1
  AND OLD.status = 'approved'
  AND EXISTS (SELECT 1 FROM generation_tasks task WHERE task.plan_id = OLD.id)
  AND NOT EXISTS (
    SELECT 1
    FROM generation_tasks task
    WHERE task.plan_id = OLD.id
      AND (task.status <> 'materialization-pending' OR task.current_attempt <> 0)
  )
  AND (
    SELECT COUNT(*) FROM generation_tasks task WHERE task.plan_id = OLD.id
  ) = (
    SELECT COALESCE(MAX(task.ordinal), -1) + 1
    FROM generation_tasks task WHERE task.plan_id = OLD.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM generation_tasks task
    WHERE task.plan_id = OLD.id
      AND (
        SELECT COUNT(*) FROM generation_task_dependencies dependency
        WHERE dependency.task_id = task.id
      ) <> (
        SELECT COALESCE(MAX(dependency.ordinal), -1) + 1
        FROM generation_task_dependencies dependency
        WHERE dependency.task_id = task.id
      )
  )
)
BEGIN SELECT RAISE(ABORT, 'Generation Plan construction seal is invalid or immutable'); END;

CREATE TRIGGER generation_plan_execution_requires_seal
BEFORE UPDATE OF status ON generation_plans
WHEN NEW.status IN ('queued','running','succeeded','failed','requires-new-impact')
  AND NEW.construction_sealed <> 1
BEGIN SELECT RAISE(ABORT, 'Generation Plan must be sealed before execution'); END;

CREATE TRIGGER generation_plan_initial_state_guard
BEFORE INSERT ON generation_plans
WHEN NEW.status <> 'approved'
  OR NEW.construction_sealed <> 0
  OR NEW.compile_error_json IS NOT NULL
  OR NEW.finished_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Generation Plan must begin as an unsealed approved compilation shell'); END;

CREATE TRIGGER generation_plan_status_transition_guard
BEFORE UPDATE OF status ON generation_plans
WHEN NEW.status IS NOT OLD.status AND NOT (
  (OLD.status = 'approved' AND NEW.status IN ('queued','compile-failed')) OR
  (OLD.status = 'queued' AND NEW.status IN ('running','failed','cancelled')) OR
  (OLD.status = 'running' AND NEW.status IN ('succeeded','failed','requires-new-impact','cancelled')) OR
  (OLD.status IN ('failed','requires-new-impact') AND NEW.status = 'queued')
)
BEGIN SELECT RAISE(ABORT, 'Generation Plan status transition is invalid or terminal'); END;

CREATE TRIGGER generation_plan_terminal_state_guard
BEFORE UPDATE OF status, construction_sealed, compile_error_json, finished_at ON generation_plans
WHEN
  (NEW.status = 'succeeded' AND (
    NEW.finished_at IS NULL OR
    NOT EXISTS (SELECT 1 FROM generation_tasks task WHERE task.plan_id = NEW.id) OR
    EXISTS (SELECT 1 FROM generation_tasks task WHERE task.plan_id = NEW.id AND task.status <> 'succeeded')
  )) OR
  (NEW.status = 'failed' AND (
    NEW.finished_at IS NULL OR
    NOT EXISTS (
      SELECT 1 FROM generation_tasks task
      WHERE task.plan_id = NEW.id AND task.status IN ('failed','blocked')
    ) OR
    EXISTS (
      SELECT 1 FROM generation_tasks task
      WHERE task.plan_id = NEW.id AND task.status NOT IN ('succeeded','failed','blocked','cancelled')
    )
  )) OR
  (NEW.status = 'cancelled' AND (
    NEW.finished_at IS NULL OR
    NOT EXISTS (SELECT 1 FROM generation_tasks task WHERE task.plan_id = NEW.id AND task.status = 'cancelled') OR
    EXISTS (
      SELECT 1 FROM generation_tasks task
      WHERE task.plan_id = NEW.id AND task.status NOT IN ('succeeded','failed','blocked','cancelled')
    )
  )) OR
  (NEW.status = 'compile-failed' AND (
    NEW.construction_sealed <> 0 OR NEW.compile_error_json IS NULL OR NEW.finished_at IS NULL OR
    EXISTS (SELECT 1 FROM generation_tasks task WHERE task.plan_id = NEW.id)
  )) OR
  (NEW.status IN ('approved','queued','running','requires-new-impact') AND NEW.finished_at IS NOT NULL) OR
  (NEW.status <> 'compile-failed' AND NEW.compile_error_json IS NOT NULL) OR
  (
    OLD.status IN ('succeeded','failed','compile-failed','cancelled')
    AND NEW.status IS OLD.status
    AND (
      NEW.construction_sealed IS NOT OLD.construction_sealed
      OR NEW.compile_error_json IS NOT OLD.compile_error_json
      OR NEW.finished_at IS NOT OLD.finished_at
    )
  )
BEGIN SELECT RAISE(ABORT, 'Generation Plan status does not match its durable execution state'); END;

CREATE TRIGGER generation_task_insert_guard
BEFORE INSERT ON generation_tasks
WHEN NEW.current_attempt <> 0
  OR NEW.materialization_failures <> 0
  OR NEW.status <> 'materialization-pending'
  OR NEW.result_revision_id IS NOT NULL
  OR NEW.result_resource_revision_id IS NOT NULL
  OR NEW.result_snapshot_id IS NOT NULL
  OR NOT EXISTS (
    SELECT 1 FROM generation_plans plan
    WHERE plan.id = NEW.plan_id
      AND plan.workspace_id = NEW.workspace_id
      AND plan.status = 'approved'
      AND plan.construction_sealed = 0
  )
BEGIN SELECT RAISE(ABORT, 'Generation Task must be inserted as immutable intent before Plan seal'); END;

CREATE TRIGGER generation_task_intent_update_immutable
BEFORE UPDATE OF id, workspace_id, plan_id, ordinal, kind, target_type, target_id,
  target_artifact_id, target_track_id, target_resource_id, payload_json, intent_hash,
  capabilities_json, qa_profile_json, resource_limits_json, idempotency_key, created_at
ON generation_tasks
BEGIN SELECT RAISE(ABORT, 'Generation Task intent is immutable'); END;

CREATE TRIGGER generation_task_delete_history_guard
BEFORE DELETE ON generation_tasks
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Generation Task history is immutable'); END;

CREATE TRIGGER generation_task_dependency_insert_guard
BEFORE INSERT ON generation_task_dependencies
WHEN NOT EXISTS (
  SELECT 1 FROM generation_plans plan
  WHERE plan.id = NEW.plan_id
    AND plan.workspace_id = NEW.workspace_id
    AND plan.status = 'approved'
    AND plan.construction_sealed = 0
)
OR EXISTS (
  WITH RECURSIVE reachable(task_id) AS (
    SELECT dependency_task_id
    FROM generation_task_dependencies
    WHERE task_id = NEW.dependency_task_id AND plan_id = NEW.plan_id
    UNION
    SELECT dependency.dependency_task_id
    FROM generation_task_dependencies dependency
    JOIN reachable ON reachable.task_id = dependency.task_id
    WHERE dependency.plan_id = NEW.plan_id
  )
  SELECT 1 FROM reachable WHERE task_id = NEW.task_id
)
BEGIN SELECT RAISE(ABORT, 'Generation Task dependency is sealed, foreign, or cyclic'); END;

CREATE TRIGGER generation_task_dependency_update_immutable
BEFORE UPDATE ON generation_task_dependencies
BEGIN SELECT RAISE(ABORT, 'Generation Task dependencies are immutable'); END;

CREATE TRIGGER generation_task_dependency_delete_history_guard
BEFORE DELETE ON generation_task_dependencies
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Generation Task dependencies are immutable'); END;

CREATE TRIGGER generation_task_current_attempt_guard
BEFORE UPDATE OF current_attempt ON generation_tasks
WHEN NEW.current_attempt <> OLD.current_attempt AND (
  NEW.current_attempt <> OLD.current_attempt + 1
  OR NOT EXISTS (
    SELECT 1 FROM generation_task_attempts attempt
    WHERE attempt.task_id = OLD.id
      AND attempt.workspace_id = OLD.workspace_id
      AND attempt.attempt = NEW.current_attempt
      AND attempt.materialization_sealed = 1
  )
)
BEGIN SELECT RAISE(ABORT, 'Generation Task current attempt must advance to its exact successor'); END;

CREATE TRIGGER generation_task_result_write_once
BEFORE UPDATE OF result_revision_id, result_resource_revision_id, result_snapshot_id ON generation_tasks
WHEN (OLD.result_revision_id IS NOT NULL AND NEW.result_revision_id IS NOT OLD.result_revision_id)
  OR (OLD.result_resource_revision_id IS NOT NULL
    AND NEW.result_resource_revision_id IS NOT OLD.result_resource_revision_id)
  OR (OLD.result_snapshot_id IS NOT NULL AND NEW.result_snapshot_id IS NOT OLD.result_snapshot_id)
BEGIN SELECT RAISE(ABORT, 'Generation Task result is write-once'); END;

CREATE TRIGGER generation_task_attempt_insert_guard
BEFORE INSERT ON generation_task_attempts
WHEN NEW.attempt_origin = 'materialized' AND (
  NEW.predecessor_attempt IS NOT NULL
  OR NEW.automatic_retry_index <> 0
  OR (NEW.source_commit_hash IS NULL) <> (NEW.source_tree_hash IS NULL)
  OR (NEW.target_artifact_id IS NULL AND NEW.source_commit_hash IS NOT NULL)
  OR (NEW.target_artifact_id IS NOT NULL AND NEW.source_commit_hash IS NULL)
  OR (NEW.source_commit_hash IS NOT NULL AND (
    length(NEW.source_commit_hash) NOT IN (40, 64)
    OR length(NEW.source_tree_hash) <> length(NEW.source_commit_hash)
    OR NEW.source_commit_hash GLOB '*[^0-9a-f]*'
    OR NEW.source_tree_hash GLOB '*[^0-9a-f]*'
  ))
  OR NEW.materialization_sealed <> 0
  OR NEW.status <> 'queued'
  OR NEW.owner_id IS NOT NULL
  OR NEW.lease_token IS NOT NULL
  OR NEW.lease_expires_at IS NOT NULL
  OR NEW.heartbeat_at IS NOT NULL
  OR NEW.started_at IS NOT NULL
  OR NEW.finished_at IS NOT NULL
  OR NOT EXISTS (
    SELECT 1 FROM generation_tasks task
    JOIN generation_plans plan
      ON plan.id = task.plan_id AND plan.workspace_id = task.workspace_id
    JOIN project_workspaces workspace
      ON workspace.id = task.workspace_id
    JOIN workspace_snapshots snapshot
      ON snapshot.id = NEW.expected_snapshot_id
     AND snapshot.workspace_id = NEW.workspace_id
    WHERE task.id = NEW.task_id
      AND task.plan_id = NEW.plan_id
      AND task.workspace_id = NEW.workspace_id
      AND plan.construction_sealed = 1
      AND plan.status IN ('queued','running')
      AND task.status IN ('materialization-pending','retry-wait','awaiting-context-refresh','needs-rebase')
      AND NEW.attempt = task.current_attempt + 1
      AND NOT EXISTS (
        SELECT 1 FROM generation_task_attempts current_attempt
        WHERE current_attempt.task_id = task.id
          AND current_attempt.plan_id = task.plan_id
          AND current_attempt.workspace_id = task.workspace_id
          AND current_attempt.attempt = task.current_attempt
          AND current_attempt.materialization_sealed = 1
          AND current_attempt.status = 'queued'
      )
      AND workspace.active_snapshot_id = NEW.expected_snapshot_id
      AND snapshot.sealed = 1
      AND snapshot.kernel_revision_id = NEW.kernel_revision_id
      AND task.target_artifact_id IS NEW.target_artifact_id
      AND task.target_track_id IS NEW.target_track_id
      AND task.target_resource_id IS NEW.target_resource_id
      AND (
        (task.target_type = 'workspace' AND NEW.base_revision_id IS NULL) OR
        (task.target_type = 'artifact' AND (
          NEW.base_revision_id IS NULL OR EXISTS (
            SELECT 1 FROM artifact_revisions revision
            WHERE revision.id = NEW.base_revision_id
              AND revision.artifact_id = task.target_artifact_id
              AND revision.track_id = task.target_track_id
              AND revision.workspace_id = task.workspace_id
              AND revision.source_commit_hash = NEW.source_commit_hash
              AND revision.source_tree_hash = NEW.source_tree_hash
              AND revision.sealed = 1
          )
        )) OR
        (task.target_type = 'resource' AND (
          NEW.base_revision_id IS NULL OR EXISTS (
            SELECT 1 FROM resource_revisions revision
            WHERE revision.id = NEW.base_revision_id
              AND revision.resource_id = task.target_resource_id
              AND revision.workspace_id = task.workspace_id
          )
        ))
      )
      AND (
        (task.kind = 'resource' AND EXISTS (
          SELECT 1 FROM context_packs pack
          WHERE pack.id = NEW.context_pack_id
            AND pack.workspace_id = NEW.workspace_id
            AND pack.scope_type = 'resource'
            AND pack.scope_id = task.target_resource_id
            AND pack.graph_revision = snapshot.graph_revision
            AND pack.intent = 'generate'
            AND pack.sealed = 1
        )) OR
        (task.kind IN ('component','page','propagation-candidate') AND EXISTS (
          SELECT 1 FROM context_packs pack
          WHERE pack.id = NEW.context_pack_id
            AND pack.workspace_id = NEW.workspace_id
            AND pack.scope_type = 'artifact'
            AND pack.scope_id = task.target_artifact_id
            AND pack.graph_revision = snapshot.graph_revision
            AND pack.intent = 'generate'
            AND pack.sealed = 1
        )) OR
        (task.kind IN ('prototype-validation','checkpoint','propagation-publish')
          AND NEW.context_pack_id IS NULL)
      )
  )
)
BEGIN SELECT RAISE(ABORT, 'Generation Task Attempt input or target ownership is invalid'); END;

CREATE TRIGGER generation_task_attempt_retry_insert_guard
BEFORE INSERT ON generation_task_attempts
WHEN NEW.attempt_origin IN ('same-input-retry','publication-retry') AND (
  NEW.materialization_sealed <> 0
  OR (NEW.source_commit_hash IS NULL) <> (NEW.source_tree_hash IS NULL)
  OR (NEW.target_artifact_id IS NULL AND NEW.source_commit_hash IS NOT NULL)
  OR (NEW.target_artifact_id IS NOT NULL AND NEW.source_commit_hash IS NULL)
  OR (NEW.source_commit_hash IS NOT NULL AND (
    length(NEW.source_commit_hash) NOT IN (40, 64)
    OR length(NEW.source_tree_hash) <> length(NEW.source_commit_hash)
    OR NEW.source_commit_hash GLOB '*[^0-9a-f]*'
    OR NEW.source_tree_hash GLOB '*[^0-9a-f]*'
  ))
  OR NEW.status <> 'queued'
  OR NEW.predecessor_attempt IS NULL
  OR NEW.predecessor_attempt <> NEW.attempt - 1
  OR NEW.automatic_retry_index < 1
  OR NEW.automatic_retry_index > 3
  OR NEW.blocked_reason IS NOT NULL
  OR NEW.failure_class IS NOT NULL
  OR NEW.error_json IS NOT NULL
  OR NEW.next_eligible_at IS NOT NULL
  OR NEW.owner_id IS NOT NULL
  OR NEW.lease_token IS NOT NULL
  OR NEW.lease_expires_at IS NOT NULL
  OR NEW.heartbeat_at IS NOT NULL
  OR NEW.started_at IS NOT NULL
  OR NEW.finished_at IS NOT NULL
  OR NOT EXISTS (
    SELECT 1
    FROM generation_tasks task
    JOIN generation_plans plan
      ON plan.id = task.plan_id AND plan.workspace_id = task.workspace_id
    JOIN generation_task_attempts predecessor
      ON predecessor.task_id = task.id
     AND predecessor.plan_id = task.plan_id
     AND predecessor.workspace_id = task.workspace_id
     AND predecessor.attempt = NEW.predecessor_attempt
    JOIN workspace_snapshots snapshot
      ON snapshot.id = predecessor.expected_snapshot_id
     AND snapshot.workspace_id = predecessor.workspace_id
    WHERE task.id = NEW.task_id
      AND task.plan_id = NEW.plan_id
      AND task.workspace_id = NEW.workspace_id
      AND task.current_attempt = predecessor.attempt
      AND NEW.attempt = predecessor.attempt + 1
      AND plan.construction_sealed = 1
      AND plan.status IN ('queued','running')
      AND predecessor.materialization_sealed = 1
      AND predecessor.finished_at IS NOT NULL
      AND predecessor.owner_id IS NULL
      AND predecessor.lease_token IS NULL
      AND predecessor.lease_expires_at IS NULL
      AND predecessor.heartbeat_at IS NULL
      AND snapshot.sealed = 1
      AND NEW.automatic_retry_index = predecessor.automatic_retry_index + 1
      AND NEW.target_artifact_id IS predecessor.target_artifact_id
      AND NEW.target_track_id IS predecessor.target_track_id
      AND NEW.target_resource_id IS predecessor.target_resource_id
      AND NEW.base_revision_id IS predecessor.base_revision_id
      AND NEW.source_commit_hash IS predecessor.source_commit_hash
      AND NEW.source_tree_hash IS predecessor.source_tree_hash
      AND NEW.expected_snapshot_id IS predecessor.expected_snapshot_id
      AND NEW.context_pack_id IS predecessor.context_pack_id
      AND NEW.kernel_revision_id IS predecessor.kernel_revision_id
      AND snapshot.kernel_revision_id IS NEW.kernel_revision_id
      AND NEW.payload_json IS predecessor.payload_json
      AND NEW.input_hash IS NOT predecessor.input_hash
      AND NEW.pinned_resource_revision_ids_json IS predecessor.pinned_resource_revision_ids_json
      AND NEW.component_dependency_revision_ids_json IS predecessor.component_dependency_revision_ids_json
      AND NEW.retry_context_policy IS predecessor.retry_context_policy
      AND (
        (
          NEW.attempt_origin = 'same-input-retry'
          AND predecessor.status = 'retryable-failed'
          AND task.status = 'retry-wait'
          AND NEW.execution_mode IS predecessor.execution_mode
          AND predecessor.candidate_revision_id IS NULL
          AND predecessor.candidate_resource_revision_id IS NULL
          AND predecessor.candidate_evidence_json IS NULL
          AND predecessor.candidate_evidence_hash IS NULL
          AND NEW.candidate_revision_id IS NULL
          AND NEW.candidate_resource_revision_id IS NULL
          AND NEW.candidate_evidence_json IS NULL
          AND NEW.candidate_evidence_hash IS NULL
        ) OR (
          NEW.attempt_origin = 'publication-retry'
          AND predecessor.status = 'needs-rebase'
          AND task.status = 'needs-rebase'
          AND NEW.execution_mode = 'publication-only'
          AND (
            (
              predecessor.candidate_revision_id IS NULL
              AND predecessor.candidate_resource_revision_id IS NULL
              AND predecessor.candidate_evidence_json IS NULL
              AND predecessor.candidate_evidence_hash IS NULL
              AND NEW.candidate_revision_id IS NULL
              AND NEW.candidate_resource_revision_id IS NULL
              AND NEW.candidate_evidence_json IS NULL
              AND NEW.candidate_evidence_hash IS NULL
            ) OR (
              predecessor.candidate_evidence_json IS NOT NULL
              AND predecessor.candidate_evidence_hash IS NOT NULL
              AND NEW.candidate_revision_id IS predecessor.candidate_revision_id
              AND NEW.candidate_resource_revision_id IS predecessor.candidate_resource_revision_id
              AND NEW.candidate_evidence_json IS predecessor.candidate_evidence_json
              AND NEW.candidate_evidence_hash IS NOT NULL
              AND NEW.candidate_evidence_hash IS NOT predecessor.candidate_evidence_hash
            )
          )
        )
      )
  )
)
BEGIN SELECT RAISE(ABORT, 'Generation Task retry Attempt must be an exact fenced successor'); END;

CREATE TRIGGER generation_task_attempt_materialization_seal_guard
BEFORE UPDATE OF materialization_sealed ON generation_task_attempts
WHEN NEW.attempt_origin = 'materialized'
AND NEW.materialization_sealed IS NOT OLD.materialization_sealed AND NOT (
  OLD.materialization_sealed = 0
  AND NEW.materialization_sealed = 1
  AND OLD.status = 'queued'
  AND NEW.status = 'queued'
  AND EXISTS (
    SELECT 1 FROM generation_tasks task
    JOIN generation_plans plan
      ON plan.id = task.plan_id AND plan.workspace_id = task.workspace_id
    JOIN project_workspaces workspace
      ON workspace.id = task.workspace_id
    JOIN workspace_snapshots snapshot
      ON snapshot.id = NEW.expected_snapshot_id
     AND snapshot.workspace_id = NEW.workspace_id
    WHERE task.id = NEW.task_id
      AND task.plan_id = NEW.plan_id
      AND task.workspace_id = NEW.workspace_id
      AND plan.construction_sealed = 1
      AND plan.status IN ('queued','running')
      AND task.status IN ('materialization-pending','retry-wait','awaiting-context-refresh','needs-rebase')
      AND NEW.attempt = task.current_attempt + 1
      AND NOT EXISTS (
        SELECT 1 FROM generation_task_attempts current_attempt
        WHERE current_attempt.task_id = task.id
          AND current_attempt.plan_id = task.plan_id
          AND current_attempt.workspace_id = task.workspace_id
          AND current_attempt.attempt = task.current_attempt
          AND current_attempt.materialization_sealed = 1
          AND current_attempt.status = 'queued'
      )
      AND workspace.active_snapshot_id = NEW.expected_snapshot_id
      AND snapshot.sealed = 1
      AND snapshot.kernel_revision_id = NEW.kernel_revision_id
      AND (
        (task.kind = 'resource' AND EXISTS (
          SELECT 1 FROM context_packs pack
          WHERE pack.id = NEW.context_pack_id
            AND pack.workspace_id = NEW.workspace_id
            AND pack.scope_type = 'resource'
            AND pack.scope_id = task.target_resource_id
            AND pack.graph_revision = snapshot.graph_revision
            AND pack.intent = 'generate'
            AND pack.sealed = 1
        )) OR
        (task.kind IN ('component','page','propagation-candidate') AND EXISTS (
          SELECT 1 FROM context_packs pack
          WHERE pack.id = NEW.context_pack_id
            AND pack.workspace_id = NEW.workspace_id
            AND pack.scope_type = 'artifact'
            AND pack.scope_id = task.target_artifact_id
            AND pack.graph_revision = snapshot.graph_revision
            AND pack.intent = 'generate'
            AND pack.sealed = 1
        )) OR
        (task.kind IN ('prototype-validation','checkpoint','propagation-publish')
          AND NEW.context_pack_id IS NULL)
      )
  )
  AND (
    SELECT COUNT(*) FROM generation_task_attempt_resource_pins pin
    WHERE pin.task_id = NEW.task_id AND pin.attempt = NEW.attempt
  ) = (
    SELECT COALESCE(MAX(pin.ordinal), -1) + 1
    FROM generation_task_attempt_resource_pins pin
    WHERE pin.task_id = NEW.task_id AND pin.attempt = NEW.attempt
  )
  AND json_array_length(NEW.pinned_resource_revision_ids_json) = (
    SELECT COUNT(*) FROM generation_task_attempt_resource_pins pin
    WHERE pin.task_id = NEW.task_id AND pin.attempt = NEW.attempt
  )
  AND NOT EXISTS (
    SELECT 1 FROM json_each(NEW.pinned_resource_revision_ids_json) summary
    LEFT JOIN generation_task_attempt_resource_pins pin
      ON pin.task_id = NEW.task_id
     AND pin.attempt = NEW.attempt
     AND pin.ordinal = CAST(summary.key AS INTEGER)
    WHERE summary.type <> 'text'
      OR pin.revision_id IS NULL
      OR summary.value IS NOT pin.revision_id
  )
  AND (
    SELECT COUNT(*) FROM generation_task_attempt_component_pins pin
    WHERE pin.task_id = NEW.task_id AND pin.attempt = NEW.attempt
  ) = (
    SELECT COALESCE(MAX(pin.ordinal), -1) + 1
    FROM generation_task_attempt_component_pins pin
    WHERE pin.task_id = NEW.task_id AND pin.attempt = NEW.attempt
  )
  AND json_array_length(NEW.component_dependency_revision_ids_json) = (
    SELECT COUNT(*) FROM generation_task_attempt_component_pins pin
    WHERE pin.task_id = NEW.task_id AND pin.attempt = NEW.attempt
  )
  AND NOT EXISTS (
    SELECT 1 FROM json_each(NEW.component_dependency_revision_ids_json) summary
    LEFT JOIN generation_task_attempt_component_pins pin
      ON pin.task_id = NEW.task_id
     AND pin.attempt = NEW.attempt
     AND pin.ordinal = CAST(summary.key AS INTEGER)
    WHERE summary.type <> 'text'
      OR pin.revision_id IS NULL
      OR summary.value IS NOT pin.revision_id
  )
  AND (
    SELECT COUNT(*) FROM generation_task_dependencies dependency
    WHERE dependency.task_id = NEW.task_id
  ) = (
    SELECT COUNT(*) FROM generation_task_attempt_dependency_outputs output
    WHERE output.task_id = NEW.task_id AND output.attempt = NEW.attempt
  )
  AND (
    SELECT COUNT(*) FROM generation_task_attempt_dependency_outputs output
    WHERE output.task_id = NEW.task_id AND output.attempt = NEW.attempt
  ) = (
    SELECT COALESCE(MAX(output.ordinal), -1) + 1
    FROM generation_task_attempt_dependency_outputs output
    WHERE output.task_id = NEW.task_id AND output.attempt = NEW.attempt
  )
  AND NOT EXISTS (
    SELECT 1
    FROM generation_task_dependencies dependency
    LEFT JOIN generation_task_attempt_dependency_outputs output
      ON output.task_id = dependency.task_id
     AND output.attempt = NEW.attempt
     AND output.dependency_task_id = dependency.dependency_task_id
    LEFT JOIN generation_tasks source
      ON source.id = dependency.dependency_task_id
     AND source.plan_id = dependency.plan_id
     AND source.workspace_id = dependency.workspace_id
    LEFT JOIN generation_task_attempts source_attempt
      ON source_attempt.task_id = source.id
     AND source_attempt.plan_id = source.plan_id
     AND source_attempt.workspace_id = source.workspace_id
     AND source_attempt.attempt = source.current_attempt
    WHERE dependency.task_id = NEW.task_id
      AND dependency.plan_id = NEW.plan_id
      AND dependency.workspace_id = NEW.workspace_id
      AND (
        output.dependency_task_id IS NULL
        OR output.ordinal <> dependency.ordinal
        OR source.status IS NOT 'succeeded'
        OR source_attempt.materialization_sealed IS NOT 1
        OR source_attempt.status IS NOT 'succeeded'
        OR output.result_revision_id IS NOT source.result_revision_id
        OR output.result_resource_revision_id IS NOT source.result_resource_revision_id
        OR output.result_snapshot_id IS NOT source.result_snapshot_id
      )
  )
)
BEGIN SELECT RAISE(ABORT, 'Generation Task Attempt materialization seal is incomplete or stale'); END;

CREATE TRIGGER generation_task_attempt_retry_materialization_seal_guard
BEFORE UPDATE OF materialization_sealed ON generation_task_attempts
WHEN NEW.attempt_origin IN ('same-input-retry','publication-retry')
AND NEW.materialization_sealed IS NOT OLD.materialization_sealed AND NOT (
  OLD.materialization_sealed = 0
  AND NEW.materialization_sealed = 1
  AND OLD.status = 'queued'
  AND NEW.status = 'queued'
  AND EXISTS (
    SELECT 1
    FROM generation_tasks task
    JOIN generation_plans plan
      ON plan.id = task.plan_id AND plan.workspace_id = task.workspace_id
    JOIN generation_task_attempts predecessor
      ON predecessor.task_id = task.id
     AND predecessor.plan_id = task.plan_id
     AND predecessor.workspace_id = task.workspace_id
     AND predecessor.attempt = NEW.predecessor_attempt
    JOIN workspace_snapshots snapshot
      ON snapshot.id = predecessor.expected_snapshot_id
     AND snapshot.workspace_id = predecessor.workspace_id
    WHERE task.id = NEW.task_id
      AND task.plan_id = NEW.plan_id
      AND task.workspace_id = NEW.workspace_id
      AND task.current_attempt = predecessor.attempt
      AND NEW.predecessor_attempt = NEW.attempt - 1
      AND plan.construction_sealed = 1
      AND plan.status IN ('queued','running')
      AND predecessor.materialization_sealed = 1
      AND predecessor.finished_at IS NOT NULL
      AND predecessor.owner_id IS NULL
      AND predecessor.lease_token IS NULL
      AND predecessor.lease_expires_at IS NULL
      AND predecessor.heartbeat_at IS NULL
      AND snapshot.sealed = 1
      AND NEW.automatic_retry_index = predecessor.automatic_retry_index + 1
      AND NEW.target_artifact_id IS predecessor.target_artifact_id
      AND NEW.target_track_id IS predecessor.target_track_id
      AND NEW.target_resource_id IS predecessor.target_resource_id
      AND NEW.base_revision_id IS predecessor.base_revision_id
      AND NEW.source_commit_hash IS predecessor.source_commit_hash
      AND NEW.source_tree_hash IS predecessor.source_tree_hash
      AND NEW.expected_snapshot_id IS predecessor.expected_snapshot_id
      AND NEW.context_pack_id IS predecessor.context_pack_id
      AND NEW.kernel_revision_id IS predecessor.kernel_revision_id
      AND snapshot.kernel_revision_id IS NEW.kernel_revision_id
      AND NEW.payload_json IS predecessor.payload_json
      AND NEW.input_hash IS NOT predecessor.input_hash
      AND NEW.pinned_resource_revision_ids_json IS predecessor.pinned_resource_revision_ids_json
      AND NEW.component_dependency_revision_ids_json IS predecessor.component_dependency_revision_ids_json
      AND NEW.retry_context_policy IS predecessor.retry_context_policy
      AND (
        (
          NEW.attempt_origin = 'same-input-retry'
          AND predecessor.status = 'retryable-failed'
          AND task.status = 'retry-wait'
          AND NEW.execution_mode IS predecessor.execution_mode
          AND predecessor.candidate_revision_id IS NULL
          AND predecessor.candidate_resource_revision_id IS NULL
          AND predecessor.candidate_evidence_json IS NULL
          AND predecessor.candidate_evidence_hash IS NULL
          AND NEW.candidate_revision_id IS NULL
          AND NEW.candidate_resource_revision_id IS NULL
          AND NEW.candidate_evidence_json IS NULL
          AND NEW.candidate_evidence_hash IS NULL
        ) OR (
          NEW.attempt_origin = 'publication-retry'
          AND predecessor.status = 'needs-rebase'
          AND task.status = 'needs-rebase'
          AND NEW.execution_mode = 'publication-only'
          AND (
            (
              predecessor.candidate_revision_id IS NULL
              AND predecessor.candidate_resource_revision_id IS NULL
              AND predecessor.candidate_evidence_json IS NULL
              AND predecessor.candidate_evidence_hash IS NULL
              AND NEW.candidate_revision_id IS NULL
              AND NEW.candidate_resource_revision_id IS NULL
              AND NEW.candidate_evidence_json IS NULL
              AND NEW.candidate_evidence_hash IS NULL
            ) OR (
              predecessor.candidate_evidence_json IS NOT NULL
              AND predecessor.candidate_evidence_hash IS NOT NULL
              AND NEW.candidate_revision_id IS predecessor.candidate_revision_id
              AND NEW.candidate_resource_revision_id IS predecessor.candidate_resource_revision_id
              AND NEW.candidate_evidence_json IS predecessor.candidate_evidence_json
              AND NEW.candidate_evidence_hash IS NOT NULL
              AND NEW.candidate_evidence_hash IS NOT predecessor.candidate_evidence_hash
            )
          )
        )
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM (
      SELECT ordinal, dependency_task_id, result_revision_id,
        result_resource_revision_id, result_snapshot_id
      FROM generation_task_attempt_dependency_outputs
      WHERE task_id = NEW.task_id AND attempt = NEW.attempt
      EXCEPT
      SELECT ordinal, dependency_task_id, result_revision_id,
        result_resource_revision_id, result_snapshot_id
      FROM generation_task_attempt_dependency_outputs
      WHERE task_id = NEW.task_id AND attempt = NEW.predecessor_attempt
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM (
      SELECT ordinal, dependency_task_id, result_revision_id,
        result_resource_revision_id, result_snapshot_id
      FROM generation_task_attempt_dependency_outputs
      WHERE task_id = NEW.task_id AND attempt = NEW.predecessor_attempt
      EXCEPT
      SELECT ordinal, dependency_task_id, result_revision_id,
        result_resource_revision_id, result_snapshot_id
      FROM generation_task_attempt_dependency_outputs
      WHERE task_id = NEW.task_id AND attempt = NEW.attempt
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM (
      SELECT ordinal, resource_id, revision_id, source_task_id
      FROM generation_task_attempt_resource_pins
      WHERE task_id = NEW.task_id AND attempt = NEW.attempt
      EXCEPT
      SELECT ordinal, resource_id, revision_id, source_task_id
      FROM generation_task_attempt_resource_pins
      WHERE task_id = NEW.task_id AND attempt = NEW.predecessor_attempt
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM (
      SELECT ordinal, resource_id, revision_id, source_task_id
      FROM generation_task_attempt_resource_pins
      WHERE task_id = NEW.task_id AND attempt = NEW.predecessor_attempt
      EXCEPT
      SELECT ordinal, resource_id, revision_id, source_task_id
      FROM generation_task_attempt_resource_pins
      WHERE task_id = NEW.task_id AND attempt = NEW.attempt
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM (
      SELECT ordinal, instance_id, owner_artifact_id, component_artifact_id, revision_id,
        source_task_id, variant_key, state_key, design_node_id, source_locator_json,
        overrides_json, status
      FROM generation_task_attempt_component_pins
      WHERE task_id = NEW.task_id AND attempt = NEW.attempt
      EXCEPT
      SELECT ordinal, instance_id, owner_artifact_id, component_artifact_id, revision_id,
        source_task_id, variant_key, state_key, design_node_id, source_locator_json,
        overrides_json, status
      FROM generation_task_attempt_component_pins
      WHERE task_id = NEW.task_id AND attempt = NEW.predecessor_attempt
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM (
      SELECT ordinal, instance_id, owner_artifact_id, component_artifact_id, revision_id,
        source_task_id, variant_key, state_key, design_node_id, source_locator_json,
        overrides_json, status
      FROM generation_task_attempt_component_pins
      WHERE task_id = NEW.task_id AND attempt = NEW.predecessor_attempt
      EXCEPT
      SELECT ordinal, instance_id, owner_artifact_id, component_artifact_id, revision_id,
        source_task_id, variant_key, state_key, design_node_id, source_locator_json,
        overrides_json, status
      FROM generation_task_attempt_component_pins
      WHERE task_id = NEW.task_id AND attempt = NEW.attempt
    )
  )
)
BEGIN SELECT RAISE(ABORT, 'Generation Task retry Attempt seal diverges from its immutable predecessor'); END;

CREATE TRIGGER generation_task_attempt_advance_current
AFTER UPDATE OF materialization_sealed ON generation_task_attempts
WHEN OLD.materialization_sealed = 0 AND NEW.materialization_sealed = 1
BEGIN
  UPDATE generation_tasks
  SET current_attempt = NEW.attempt
  WHERE id = NEW.task_id AND workspace_id = NEW.workspace_id;
END;

CREATE TRIGGER generation_task_attempt_input_update_immutable
BEFORE UPDATE OF task_id, plan_id, workspace_id, attempt, target_artifact_id, target_track_id,
  target_resource_id, base_revision_id, source_commit_hash, source_tree_hash,
  expected_snapshot_id, context_pack_id,
  kernel_revision_id, execution_mode, payload_json, input_hash,
  pinned_resource_revision_ids_json, component_dependency_revision_ids_json,
  attempt_origin, predecessor_attempt, automatic_retry_index,
  retry_context_policy, created_at
ON generation_task_attempts
BEGIN SELECT RAISE(ABORT, 'Generation Task Attempt input is immutable'); END;

CREATE TRIGGER generation_task_attempt_candidate_write_once
BEFORE UPDATE OF candidate_revision_id, candidate_resource_revision_id,
  candidate_evidence_json, candidate_evidence_hash ON generation_task_attempts
WHEN (OLD.candidate_revision_id IS NOT NULL AND NEW.candidate_revision_id IS NOT OLD.candidate_revision_id)
  OR (OLD.candidate_resource_revision_id IS NOT NULL
    AND NEW.candidate_resource_revision_id IS NOT OLD.candidate_resource_revision_id)
  OR (OLD.candidate_evidence_json IS NOT NULL
    AND NEW.candidate_evidence_json IS NOT OLD.candidate_evidence_json)
  OR (OLD.candidate_evidence_hash IS NOT NULL
    AND NEW.candidate_evidence_hash IS NOT OLD.candidate_evidence_hash)
BEGIN SELECT RAISE(ABORT, 'Generation Task Attempt candidate evidence is write-once'); END;

CREATE TRIGGER generation_task_attempt_delete_history_guard
BEFORE DELETE ON generation_task_attempts
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Generation Task Attempt history is immutable'); END;

CREATE TRIGGER generation_task_validation_result_insert_guard
BEFORE INSERT ON generation_task_validation_results
WHEN typeof(NEW.created_at) <> 'integer'
  OR typeof(NEW.graph_revision) <> 'integer'
  OR NEW.created_at < 0 OR NEW.created_at > 9007199254740991
  OR NEW.graph_revision < 0 OR NEW.graph_revision > 9007199254740991
  OR length(NEW.evidence_hash) <> 64 OR NEW.evidence_hash GLOB '*[^0-9a-f]*'
  OR length(NEW.validation_fence_hash) <> 64 OR NEW.validation_fence_hash GLOB '*[^0-9a-f]*'
  OR json_type(NEW.artifact_revision_ids_json) <> 'array'
  OR json_type(NEW.resource_revision_ids_json) <> 'array'
  OR json_type(NEW.evidence_json) <> 'object'
  OR json_extract(NEW.evidence_json, '$.protocol') IS NOT 'dezin-prototype-validation-v1'
  OR NOT EXISTS (
    SELECT 1
    FROM generation_task_attempts attempt
    JOIN generation_tasks task
      ON task.id = attempt.task_id
     AND task.plan_id = attempt.plan_id
     AND task.workspace_id = attempt.workspace_id
    JOIN generation_plans plan
      ON plan.id = task.plan_id AND plan.workspace_id = task.workspace_id
    JOIN workspace_snapshots snapshot
      ON snapshot.id = attempt.expected_snapshot_id
     AND snapshot.workspace_id = attempt.workspace_id
    WHERE attempt.task_id = NEW.task_id
      AND attempt.plan_id = NEW.plan_id
      AND attempt.workspace_id = NEW.workspace_id
      AND attempt.attempt = NEW.attempt
      AND attempt.materialization_sealed = 1
      AND attempt.status = 'running'
      AND attempt.execution_mode = 'full'
      AND attempt.context_pack_id IS NULL
      AND attempt.candidate_revision_id IS NULL
      AND attempt.candidate_resource_revision_id IS NULL
      AND attempt.candidate_evidence_json IS NULL
      AND attempt.candidate_evidence_hash IS NULL
      AND attempt.owner_id IS NOT NULL
      AND attempt.lease_token IS NOT NULL
      AND attempt.lease_expires_at > NEW.created_at
      AND task.kind = 'prototype-validation'
      AND task.target_type = 'workspace'
      AND task.target_id = task.workspace_id
      AND task.current_attempt = attempt.attempt
      AND task.status = 'running'
      AND task.result_revision_id IS NULL
      AND task.result_resource_revision_id IS NULL
      AND task.result_snapshot_id IS NULL
      AND length(CAST(NEW.evidence_json AS BLOB)) <= min(
        1048576,
        json_extract(task.resource_limits_json, '$.maxOutputBytes')
      )
      AND plan.status = 'running'
      AND NEW.snapshot_id = attempt.expected_snapshot_id
      AND NEW.graph_revision = snapshot.graph_revision
      AND snapshot.kernel_revision_id = attempt.kernel_revision_id
      AND json_extract(NEW.evidence_json, '$.snapshot.id') = snapshot.id
      AND json_extract(NEW.evidence_json, '$.snapshot.graphRevision') = snapshot.graph_revision
      AND json_extract(NEW.evidence_json, '$.snapshot.kernelRevisionId') = snapshot.kernel_revision_id
      AND json_array_length(NEW.artifact_revision_ids_json) = (
        SELECT COUNT(*) FROM generation_task_attempt_dependency_outputs output
        WHERE output.task_id = attempt.task_id
          AND output.plan_id = attempt.plan_id
          AND output.workspace_id = attempt.workspace_id
          AND output.attempt = attempt.attempt
          AND output.result_revision_id IS NOT NULL
      )
      AND json_array_length(NEW.resource_revision_ids_json) = (
        SELECT COUNT(*) FROM generation_task_attempt_dependency_outputs output
        WHERE output.task_id = attempt.task_id
          AND output.plan_id = attempt.plan_id
          AND output.workspace_id = attempt.workspace_id
          AND output.attempt = attempt.attempt
          AND output.result_resource_revision_id IS NOT NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.artifact_revision_ids_json) candidate
        WHERE candidate.type <> 'text' OR NOT EXISTS (
          SELECT 1 FROM generation_task_attempt_dependency_outputs output
          WHERE output.task_id = attempt.task_id
            AND output.plan_id = attempt.plan_id
            AND output.workspace_id = attempt.workspace_id
            AND output.attempt = attempt.attempt
            AND output.result_revision_id = candidate.value
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.resource_revision_ids_json) candidate
        WHERE candidate.type <> 'text' OR NOT EXISTS (
          SELECT 1 FROM generation_task_attempt_dependency_outputs output
          WHERE output.task_id = attempt.task_id
            AND output.plan_id = attempt.plan_id
            AND output.workspace_id = attempt.workspace_id
            AND output.attempt = attempt.attempt
            AND output.result_resource_revision_id = candidate.value
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM generation_task_attempt_dependency_outputs output
        WHERE output.task_id = attempt.task_id
          AND output.plan_id = attempt.plan_id
          AND output.workspace_id = attempt.workspace_id
          AND output.attempt = attempt.attempt
          AND output.result_revision_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM json_each(NEW.artifact_revision_ids_json) candidate
            WHERE candidate.type = 'text' AND candidate.value = output.result_revision_id
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM generation_task_attempt_dependency_outputs output
        WHERE output.task_id = attempt.task_id
          AND output.plan_id = attempt.plan_id
          AND output.workspace_id = attempt.workspace_id
          AND output.attempt = attempt.attempt
          AND output.result_resource_revision_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM json_each(NEW.resource_revision_ids_json) candidate
            WHERE candidate.type = 'text' AND candidate.value = output.result_resource_revision_id
          )
      )
  )
BEGIN SELECT RAISE(ABORT, 'Generation Task validation result is stale or inconsistent'); END;

CREATE TRIGGER generation_task_validation_result_update_immutable
BEFORE UPDATE ON generation_task_validation_results
BEGIN SELECT RAISE(ABORT, 'Generation Task validation results are immutable'); END;

CREATE TRIGGER generation_task_validation_result_delete_history_guard
BEFORE DELETE ON generation_task_validation_results
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Generation Task validation results are immutable'); END;

CREATE TRIGGER generation_attempt_dependency_output_insert_guard
BEFORE INSERT ON generation_task_attempt_dependency_outputs
WHEN NEW.ordinal <> COALESCE((
    SELECT MAX(output.ordinal) + 1 FROM generation_task_attempt_dependency_outputs output
    WHERE output.task_id = NEW.task_id AND output.attempt = NEW.attempt
  ), 0)
  OR NOT EXISTS (
    SELECT 1 FROM generation_task_attempts attempt
    JOIN generation_tasks task
      ON task.id = attempt.task_id AND task.workspace_id = attempt.workspace_id
    JOIN generation_plans plan
      ON plan.id = task.plan_id AND plan.workspace_id = task.workspace_id
    WHERE attempt.task_id = NEW.task_id
      AND attempt.attempt = NEW.attempt
      AND attempt.plan_id = NEW.plan_id
      AND attempt.workspace_id = NEW.workspace_id
      AND attempt.status = 'queued'
      AND attempt.materialization_sealed = 0
      AND task.current_attempt + 1 = attempt.attempt
      AND (
        (attempt.attempt_origin = 'materialized'
          AND task.status IN ('materialization-pending','retry-wait','awaiting-context-refresh','needs-rebase'))
        OR (attempt.attempt_origin = 'same-input-retry' AND task.status = 'retry-wait')
        OR (attempt.attempt_origin = 'publication-retry' AND task.status = 'needs-rebase')
      )
      AND plan.construction_sealed = 1
      AND plan.status IN ('queued','running')
  )
  OR NOT EXISTS (
    SELECT 1
    FROM generation_task_dependencies dependency
    JOIN generation_tasks source
      ON source.id = dependency.dependency_task_id
     AND source.plan_id = dependency.plan_id
     AND source.workspace_id = dependency.workspace_id
    JOIN generation_task_attempts source_attempt
      ON source_attempt.task_id = source.id
     AND source_attempt.plan_id = source.plan_id
     AND source_attempt.workspace_id = source.workspace_id
     AND source_attempt.attempt = source.current_attempt
    WHERE dependency.task_id = NEW.task_id
      AND dependency.plan_id = NEW.plan_id
      AND dependency.workspace_id = NEW.workspace_id
      AND dependency.dependency_task_id = NEW.dependency_task_id
      AND dependency.ordinal = NEW.ordinal
      AND source.status = 'succeeded'
      AND source_attempt.materialization_sealed = 1
      AND source_attempt.status = 'succeeded'
      AND NEW.result_revision_id IS source.result_revision_id
      AND NEW.result_resource_revision_id IS source.result_resource_revision_id
      AND NEW.result_snapshot_id IS source.result_snapshot_id
  )
BEGIN SELECT RAISE(ABORT, 'Generation Task dependency output must freeze an exact succeeded predecessor result'); END;

CREATE TRIGGER generation_attempt_dependency_output_update_immutable
BEFORE UPDATE ON generation_task_attempt_dependency_outputs
BEGIN SELECT RAISE(ABORT, 'Generation Task dependency outputs are immutable'); END;

CREATE TRIGGER generation_attempt_dependency_output_delete_history_guard
BEFORE DELETE ON generation_task_attempt_dependency_outputs
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Generation Task dependency outputs are immutable'); END;

CREATE TRIGGER generation_attempt_resource_pin_insert_guard
BEFORE INSERT ON generation_task_attempt_resource_pins
WHEN NEW.ordinal <> COALESCE((
    SELECT MAX(pin.ordinal) + 1 FROM generation_task_attempt_resource_pins pin
    WHERE pin.task_id = NEW.task_id AND pin.attempt = NEW.attempt
  ), 0)
  OR NOT EXISTS (
    SELECT 1 FROM generation_task_attempts attempt
    JOIN generation_tasks task
      ON task.id = attempt.task_id AND task.workspace_id = attempt.workspace_id
    WHERE attempt.task_id = NEW.task_id
      AND attempt.attempt = NEW.attempt
      AND attempt.plan_id = NEW.plan_id
      AND attempt.workspace_id = NEW.workspace_id
      AND attempt.status = 'queued'
      AND attempt.materialization_sealed = 0
      AND task.current_attempt + 1 = attempt.attempt
      AND (
        (attempt.attempt_origin = 'materialized'
          AND task.status IN ('materialization-pending','retry-wait','awaiting-context-refresh','needs-rebase'))
        OR (attempt.attempt_origin = 'same-input-retry' AND task.status = 'retry-wait')
        OR (attempt.attempt_origin = 'publication-retry' AND task.status = 'needs-rebase')
      )
  )
BEGIN SELECT RAISE(ABORT, 'Generation Task Resource pins must be constructed contiguously before materialization seal'); END;

CREATE TRIGGER generation_attempt_resource_pin_update_immutable
BEFORE UPDATE ON generation_task_attempt_resource_pins
BEGIN SELECT RAISE(ABORT, 'Generation Task Resource pins are immutable'); END;

CREATE TRIGGER generation_attempt_resource_pin_delete_history_guard
BEFORE DELETE ON generation_task_attempt_resource_pins
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Generation Task Resource pins are immutable'); END;

CREATE TRIGGER generation_attempt_component_pin_insert_guard
BEFORE INSERT ON generation_task_attempt_component_pins
WHEN NEW.ordinal <> COALESCE((
    SELECT MAX(pin.ordinal) + 1 FROM generation_task_attempt_component_pins pin
    WHERE pin.task_id = NEW.task_id AND pin.attempt = NEW.attempt
  ), 0)
  OR NOT EXISTS (
    SELECT 1 FROM generation_task_attempts attempt
    JOIN generation_tasks task
      ON task.id = attempt.task_id AND task.workspace_id = attempt.workspace_id
    WHERE attempt.task_id = NEW.task_id
      AND attempt.attempt = NEW.attempt
      AND attempt.plan_id = NEW.plan_id
      AND attempt.workspace_id = NEW.workspace_id
      AND attempt.status = 'queued'
      AND attempt.materialization_sealed = 0
      AND task.current_attempt + 1 = attempt.attempt
      AND (
        (attempt.attempt_origin = 'materialized'
          AND task.status IN ('materialization-pending','retry-wait','awaiting-context-refresh','needs-rebase'))
        OR (attempt.attempt_origin = 'same-input-retry' AND task.status = 'retry-wait')
        OR (attempt.attempt_origin = 'publication-retry' AND task.status = 'needs-rebase')
      )
  )
BEGIN SELECT RAISE(ABORT, 'Generation Task Component pins must be constructed contiguously before materialization seal'); END;

CREATE TRIGGER generation_attempt_component_pin_update_immutable
BEFORE UPDATE ON generation_task_attempt_component_pins
BEGIN SELECT RAISE(ABORT, 'Generation Task Component pins are immutable'); END;

CREATE TRIGGER generation_attempt_component_pin_delete_history_guard
BEFORE DELETE ON generation_task_attempt_component_pins
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Generation Task Component pins are immutable'); END;

CREATE TRIGGER generation_materialization_failure_insert_guard
BEFORE INSERT ON generation_task_materialization_failures
WHEN NEW.sequence <> COALESCE((
    SELECT MAX(failure.sequence) + 1 FROM generation_task_materialization_failures failure
    WHERE failure.task_id = NEW.task_id
  ), 1)
  OR NOT EXISTS (
    SELECT 1 FROM generation_tasks task
    JOIN generation_plans plan
      ON plan.id = task.plan_id AND plan.workspace_id = task.workspace_id
    WHERE task.id = NEW.task_id
      AND task.plan_id = NEW.plan_id
      AND task.workspace_id = NEW.workspace_id
      AND task.status IN ('materialization-pending','retry-wait','awaiting-context-refresh','needs-rebase')
      AND plan.construction_sealed = 1
      AND plan.status IN ('queued','running')
      AND NOT EXISTS (
        SELECT 1 FROM generation_task_attempts attempt
        WHERE attempt.task_id = task.id
          AND attempt.plan_id = task.plan_id
          AND attempt.workspace_id = task.workspace_id
          AND attempt.materialization_sealed = 0
      )
  )
BEGIN SELECT RAISE(ABORT, 'Generation Task materialization failure ownership, state, or sequence is invalid'); END;

CREATE TRIGGER generation_materialization_failure_advance_count
AFTER INSERT ON generation_task_materialization_failures
BEGIN
  UPDATE generation_tasks
  SET materialization_failures = NEW.sequence
  WHERE id = NEW.task_id AND workspace_id = NEW.workspace_id;
END;

CREATE TRIGGER generation_materialization_failure_update_immutable
BEFORE UPDATE ON generation_task_materialization_failures
BEGIN SELECT RAISE(ABORT, 'Generation Task materialization failures are append-only'); END;

CREATE TRIGGER generation_materialization_failure_delete_history_guard
BEFORE DELETE ON generation_task_materialization_failures
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Generation Task materialization failures are append-only'); END;

CREATE TRIGGER generation_plan_event_insert_guard
BEFORE INSERT ON generation_plan_events
WHEN NEW.sequence <> COALESCE((
    SELECT MAX(event.sequence) + 1 FROM generation_plan_events event
    WHERE event.plan_id = NEW.plan_id
  ), 1)
BEGIN SELECT RAISE(ABORT, 'Generation Plan events are append-only and contiguous'); END;

CREATE TRIGGER generation_plan_event_update_immutable
BEFORE UPDATE ON generation_plan_events
BEGIN SELECT RAISE(ABORT, 'Generation Plan events are append-only'); END;

CREATE TRIGGER generation_plan_event_delete_history_guard
BEFORE DELETE ON generation_plan_events
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Generation Plan events are append-only'); END;

CREATE TRIGGER generation_task_claim_insert_guard
BEFORE INSERT ON generation_task_claims
WHEN typeof(NEW.created_at) <> 'integer'
  OR typeof(NEW.lease_expires_at) <> 'integer'
  OR NEW.created_at < 0
  OR NEW.created_at > 9007199254740991
  OR NEW.lease_expires_at > 9007199254740991
  OR NEW.lease_expires_at <= NEW.created_at
  OR length(trim(NEW.owner_id)) = 0
  OR NEW.owner_id IS NOT trim(NEW.owner_id)
  OR length(trim(NEW.lease_token)) = 0
  OR NEW.lease_token IS NOT trim(NEW.lease_token)
  OR NOT EXISTS (
    SELECT 1
    FROM generation_task_attempts attempt
    JOIN generation_tasks task
      ON task.id = attempt.task_id
     AND task.plan_id = attempt.plan_id
     AND task.workspace_id = attempt.workspace_id
    JOIN generation_plans plan
      ON plan.id = task.plan_id AND plan.workspace_id = task.workspace_id
    WHERE attempt.task_id = NEW.task_id
      AND attempt.plan_id = NEW.plan_id
      AND attempt.workspace_id = NEW.workspace_id
      AND attempt.attempt = NEW.attempt
      AND attempt.materialization_sealed = 1
      AND attempt.status = 'queued'
      AND attempt.owner_id IS NULL
      AND attempt.lease_token IS NULL
      AND attempt.lease_expires_at IS NULL
      AND attempt.heartbeat_at IS NULL
      AND attempt.started_at IS NULL
      AND attempt.finished_at IS NULL
      AND task.current_attempt = attempt.attempt
      AND task.status = 'queued'
      AND plan.construction_sealed = 1
      AND plan.status IN ('queued','running')
      AND json_type(task.resource_limits_json, '$.capacityClasses') = 'array'
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(task.resource_limits_json, '$.capacityClasses') capacity
        WHERE capacity.type <> 'text'
          OR capacity.value NOT IN ('agent','render-qa','image')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM generation_task_dependencies dependency
        LEFT JOIN generation_tasks predecessor
          ON predecessor.id = dependency.dependency_task_id
         AND predecessor.plan_id = dependency.plan_id
         AND predecessor.workspace_id = dependency.workspace_id
        LEFT JOIN generation_task_attempts predecessor_attempt
          ON predecessor_attempt.task_id = predecessor.id
         AND predecessor_attempt.plan_id = predecessor.plan_id
         AND predecessor_attempt.workspace_id = predecessor.workspace_id
         AND predecessor_attempt.attempt = predecessor.current_attempt
        WHERE dependency.task_id = task.id
          AND dependency.plan_id = task.plan_id
          AND dependency.workspace_id = task.workspace_id
          AND (
            predecessor.status IS NOT 'succeeded'
            OR predecessor_attempt.materialization_sealed IS NOT 1
            OR predecessor_attempt.status IS NOT 'succeeded'
          )
      )
      AND EXISTS (
        SELECT 1 FROM generation_plan_events event
        WHERE event.plan_id = task.plan_id
          AND event.workspace_id = task.workspace_id
          AND event.task_id = task.id
          AND event.type = 'task-materialized'
          AND json_extract(event.payload_json, '$.attempt') = attempt.attempt
      )
      AND NOT EXISTS (
        SELECT 1 FROM generation_task_claims existing
        WHERE existing.task_id = NEW.task_id
          AND existing.attempt = NEW.attempt
          AND (
            existing.plan_id IS NOT NEW.plan_id
            OR existing.workspace_id IS NOT NEW.workspace_id
            OR existing.owner_id IS NOT NEW.owner_id
            OR existing.lease_token IS NOT NEW.lease_token
            OR existing.lease_expires_at IS NOT NEW.lease_expires_at
            OR existing.created_at IS NOT NEW.created_at
          )
      )
      AND (
        (
          NEW.claim_kind = 'capacity'
          AND (
            (
              NEW.claim_key IN ('capacity:agent:1','capacity:agent:2','capacity:agent:3')
              AND EXISTS (
                SELECT 1 FROM json_each(task.resource_limits_json, '$.capacityClasses') capacity
                WHERE capacity.type = 'text' AND capacity.value = 'agent'
              )
              AND NOT EXISTS (
                SELECT 1 FROM generation_task_claims existing
                WHERE existing.task_id = NEW.task_id AND existing.attempt = NEW.attempt
                  AND existing.claim_key IN (
                    'capacity:agent:1','capacity:agent:2','capacity:agent:3'
                  )
              )
            )
            OR (
              NEW.claim_key IN ('capacity:render-qa:1','capacity:render-qa:2')
              AND EXISTS (
                SELECT 1 FROM json_each(task.resource_limits_json, '$.capacityClasses') capacity
                WHERE capacity.type = 'text' AND capacity.value = 'render-qa'
              )
              AND NOT EXISTS (
                SELECT 1 FROM generation_task_claims existing
                WHERE existing.task_id = NEW.task_id AND existing.attempt = NEW.attempt
                  AND existing.claim_key IN ('capacity:render-qa:1','capacity:render-qa:2')
              )
            )
            OR (
              NEW.claim_key IN ('capacity:image:1','capacity:image:2')
              AND EXISTS (
                SELECT 1 FROM json_each(task.resource_limits_json, '$.capacityClasses') capacity
                WHERE capacity.type = 'text' AND capacity.value = 'image'
              )
              AND NOT EXISTS (
                SELECT 1 FROM generation_task_claims existing
                WHERE existing.task_id = NEW.task_id AND existing.attempt = NEW.attempt
                  AND existing.claim_key IN ('capacity:image:1','capacity:image:2')
              )
            )
          )
        )
        OR (
          NEW.claim_kind = 'writer'
          AND NEW.claim_key = CASE
            WHEN task.target_type = 'artifact' THEN
              'writer:artifact:' || lower(hex(CAST(task.workspace_id AS BLOB))) || ':' ||
              lower(hex(CAST(task.target_artifact_id AS BLOB)))
            WHEN task.target_type = 'resource' THEN
              'writer:resource:' || lower(hex(CAST(task.workspace_id AS BLOB))) || ':' ||
              lower(hex(CAST(task.target_resource_id AS BLOB)))
            WHEN task.kind = 'checkpoint' THEN
              'writer:checkpoint:' || lower(hex(CAST(task.workspace_id AS BLOB)))
          END
          AND NOT EXISTS (
            SELECT 1 FROM generation_task_claims existing
            WHERE existing.task_id = NEW.task_id
              AND existing.attempt = NEW.attempt
              AND existing.claim_kind = 'writer'
          )
        )
      )
  )
BEGIN SELECT RAISE(ABORT, 'Generation Task Claim is stale, non-canonical, or has an invalid lease fence'); END;

CREATE TRIGGER generation_task_claim_identity_update_immutable
BEFORE UPDATE OF claim_key, claim_kind, task_id, plan_id, attempt, workspace_id,
  owner_id, lease_token, created_at ON generation_task_claims
BEGIN SELECT RAISE(ABORT, 'Generation Task Claim identity and fence are immutable'); END;

CREATE TRIGGER generation_task_claim_lease_update_guard
BEFORE UPDATE OF lease_expires_at ON generation_task_claims
WHEN NEW.lease_expires_at <= OLD.lease_expires_at
  OR NEW.lease_expires_at > 9007199254740991
  OR NOT EXISTS (
    SELECT 1 FROM generation_task_attempts attempt
    WHERE attempt.task_id = OLD.task_id
      AND attempt.plan_id = OLD.plan_id
      AND attempt.workspace_id = OLD.workspace_id
      AND attempt.attempt = OLD.attempt
      AND attempt.status IN ('running','candidate-ready','cancel-requested')
      AND attempt.owner_id = OLD.owner_id
      AND attempt.lease_token = OLD.lease_token
      AND attempt.lease_expires_at = OLD.lease_expires_at
      AND attempt.heartbeat_at IS NOT NULL
      AND OLD.lease_expires_at > attempt.heartbeat_at
  )
BEGIN SELECT RAISE(ABORT, 'Generation Task Claim lease can only increase under its live fence'); END;

CREATE TRIGGER generation_task_claim_delete_live_guard
BEFORE DELETE ON generation_task_claims
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
AND EXISTS (
  SELECT 1 FROM generation_task_attempts attempt
  WHERE attempt.task_id = OLD.task_id
    AND attempt.plan_id = OLD.plan_id
    AND attempt.workspace_id = OLD.workspace_id
    AND attempt.attempt = OLD.attempt
    AND attempt.owner_id = OLD.owner_id
    AND attempt.lease_token = OLD.lease_token
)
BEGIN SELECT RAISE(ABORT, 'Generation Task Claim cannot be released while its lease is live'); END;

CREATE TRIGGER generation_task_attempt_running_entry_guard
BEFORE UPDATE OF status ON generation_task_attempts
WHEN OLD.status = 'queued' AND NEW.status = 'running' AND NOT (
  OLD.materialization_sealed = 1
  AND NEW.materialization_sealed = 1
  AND OLD.owner_id IS NULL
  AND OLD.lease_token IS NULL
  AND OLD.lease_expires_at IS NULL
  AND OLD.heartbeat_at IS NULL
  AND OLD.started_at IS NULL
  AND NEW.owner_id IS NOT NULL
  AND length(trim(NEW.owner_id)) > 0
  AND NEW.owner_id IS trim(NEW.owner_id)
  AND NEW.lease_token IS NOT NULL
  AND length(trim(NEW.lease_token)) > 0
  AND NEW.lease_token IS trim(NEW.lease_token)
  AND NEW.heartbeat_at IS NOT NULL
  AND NEW.started_at IS NEW.heartbeat_at
  AND NEW.started_at >= NEW.created_at
  AND NEW.started_at <= 9007199254740991
  AND NEW.lease_expires_at <= 9007199254740991
  AND NEW.lease_expires_at > NEW.heartbeat_at
  AND NEW.finished_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM generation_tasks task
    JOIN generation_plans plan
      ON plan.id = task.plan_id AND plan.workspace_id = task.workspace_id
    WHERE task.id = NEW.task_id
      AND task.plan_id = NEW.plan_id
      AND task.workspace_id = NEW.workspace_id
      AND task.current_attempt = NEW.attempt
      AND task.status = 'queued'
      AND plan.construction_sealed = 1
      AND plan.status IN ('queued','running')
      AND json_type(task.resource_limits_json, '$.capacityClasses') = 'array'
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(task.resource_limits_json, '$.capacityClasses') capacity
        WHERE capacity.type <> 'text'
          OR capacity.value NOT IN ('agent','render-qa','image')
      )
      AND json_array_length(task.resource_limits_json, '$.capacityClasses')
        + CASE
            WHEN task.target_type IN ('artifact','resource') OR task.kind = 'checkpoint' THEN 1
            ELSE 0
          END > 0
      AND (
        SELECT COUNT(*) FROM generation_task_claims claim
        WHERE claim.task_id = NEW.task_id AND claim.attempt = NEW.attempt
      ) = json_array_length(task.resource_limits_json, '$.capacityClasses')
        + CASE
            WHEN task.target_type IN ('artifact','resource') OR task.kind = 'checkpoint' THEN 1
            ELSE 0
          END
      AND (
        SELECT COUNT(*) FROM generation_task_claims claim
        WHERE claim.task_id = NEW.task_id
          AND claim.attempt = NEW.attempt
          AND claim.claim_kind = 'capacity'
      ) = json_array_length(task.resource_limits_json, '$.capacityClasses')
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(task.resource_limits_json, '$.capacityClasses') capacity
        WHERE (
          SELECT COUNT(*) FROM generation_task_claims claim
          WHERE claim.task_id = NEW.task_id
            AND claim.attempt = NEW.attempt
            AND claim.claim_kind = 'capacity'
            AND (
              (capacity.value = 'agent' AND claim.claim_key IN (
                'capacity:agent:1','capacity:agent:2','capacity:agent:3'
              ))
              OR (capacity.value = 'render-qa' AND claim.claim_key IN (
                'capacity:render-qa:1','capacity:render-qa:2'
              ))
              OR (capacity.value = 'image' AND claim.claim_key IN (
                'capacity:image:1','capacity:image:2'
              ))
            )
        ) <> 1
      )
      AND (
        SELECT COUNT(*) FROM generation_task_claims claim
        WHERE claim.task_id = NEW.task_id
          AND claim.attempt = NEW.attempt
          AND claim.claim_kind = 'writer'
      ) = CASE
            WHEN task.target_type IN ('artifact','resource') OR task.kind = 'checkpoint' THEN 1
            ELSE 0
          END
      AND NOT EXISTS (
        SELECT 1 FROM generation_task_claims claim
        WHERE claim.task_id = NEW.task_id
          AND claim.attempt = NEW.attempt
          AND claim.claim_kind = 'writer'
          AND claim.claim_key IS NOT CASE
            WHEN task.target_type = 'artifact' THEN
              'writer:artifact:' || lower(hex(CAST(task.workspace_id AS BLOB))) || ':' ||
              lower(hex(CAST(task.target_artifact_id AS BLOB)))
            WHEN task.target_type = 'resource' THEN
              'writer:resource:' || lower(hex(CAST(task.workspace_id AS BLOB))) || ':' ||
              lower(hex(CAST(task.target_resource_id AS BLOB)))
            WHEN task.kind = 'checkpoint' THEN
              'writer:checkpoint:' || lower(hex(CAST(task.workspace_id AS BLOB)))
          END
      )
      AND NOT EXISTS (
        SELECT 1 FROM generation_task_claims claim
        WHERE claim.task_id = NEW.task_id
          AND claim.attempt = NEW.attempt
          AND (
            claim.plan_id IS NOT NEW.plan_id
            OR claim.workspace_id IS NOT NEW.workspace_id
            OR claim.owner_id IS NOT NEW.owner_id
            OR claim.lease_token IS NOT NEW.lease_token
            OR claim.lease_expires_at IS NOT NEW.lease_expires_at
            OR claim.created_at IS NOT NEW.started_at
          )
      )
  )
)
BEGIN SELECT RAISE(ABORT, 'Generation Task Attempt cannot run without its exact durable claims'); END;

CREATE TRIGGER generation_task_attempt_lease_fence_guard
BEFORE UPDATE OF owner_id, lease_token, lease_expires_at, heartbeat_at, started_at
ON generation_task_attempts
WHEN (
  NEW.owner_id IS NOT OLD.owner_id
  OR NEW.lease_token IS NOT OLD.lease_token
  OR NEW.lease_expires_at IS NOT OLD.lease_expires_at
  OR NEW.heartbeat_at IS NOT OLD.heartbeat_at
  OR (
    OLD.status IN ('running','candidate-ready','cancel-requested')
    AND NEW.started_at IS NOT OLD.started_at
  )
)
AND NOT (
  (OLD.status = 'queued' AND NEW.status = 'running')
  OR (
    OLD.status IN ('running','candidate-ready','cancel-requested')
    AND NEW.status IS OLD.status
    AND NEW.owner_id IS OLD.owner_id
    AND NEW.lease_token IS OLD.lease_token
    AND NEW.started_at IS OLD.started_at
    AND OLD.owner_id IS NOT NULL
    AND OLD.lease_token IS NOT NULL
    AND OLD.lease_expires_at IS NOT NULL
    AND OLD.heartbeat_at IS NOT NULL
    AND NEW.heartbeat_at > OLD.heartbeat_at
    AND OLD.lease_expires_at > NEW.heartbeat_at
    AND NEW.lease_expires_at > OLD.lease_expires_at
    AND EXISTS (
      SELECT 1 FROM generation_task_claims claim
      WHERE claim.task_id = OLD.task_id
        AND claim.attempt = OLD.attempt
        AND claim.workspace_id = OLD.workspace_id
        AND claim.owner_id = OLD.owner_id
        AND claim.lease_token = OLD.lease_token
    )
    AND NOT EXISTS (
      SELECT 1 FROM generation_task_claims claim
      WHERE claim.task_id = OLD.task_id
        AND claim.attempt = OLD.attempt
        AND (
          claim.plan_id IS NOT OLD.plan_id
          OR claim.workspace_id IS NOT OLD.workspace_id
          OR claim.owner_id IS NOT OLD.owner_id
          OR claim.lease_token IS NOT OLD.lease_token
          OR claim.lease_expires_at IS NOT NEW.lease_expires_at
        )
    )
  )
  OR (
    OLD.status IN ('running','candidate-ready','cancel-requested')
    AND NEW.status IN ('succeeded','retryable-failed','failed','needs-rebase','cancelled')
    AND NEW.owner_id IS NULL
    AND NEW.lease_token IS NULL
    AND NEW.lease_expires_at IS NULL
    AND NEW.heartbeat_at IS NULL
    AND NEW.started_at IS OLD.started_at
  )
)
BEGIN SELECT RAISE(ABORT, 'Generation Task Attempt lease fence is stale or internally inconsistent'); END;

CREATE TRIGGER generation_task_running_entry_guard
BEFORE UPDATE OF status ON generation_tasks
WHEN OLD.status = 'queued' AND NEW.status = 'running' AND NOT EXISTS (
  SELECT 1
  FROM generation_task_attempts attempt
  JOIN generation_plans plan
    ON plan.id = attempt.plan_id AND plan.workspace_id = attempt.workspace_id
  WHERE attempt.task_id = NEW.id
    AND attempt.plan_id = NEW.plan_id
    AND attempt.workspace_id = NEW.workspace_id
    AND attempt.attempt = NEW.current_attempt
    AND attempt.materialization_sealed = 1
    AND attempt.status = 'running'
    AND attempt.owner_id IS NOT NULL
    AND attempt.lease_token IS NOT NULL
    AND attempt.lease_expires_at IS NOT NULL
    AND attempt.heartbeat_at IS NOT NULL
    AND attempt.started_at IS NOT NULL
    AND plan.construction_sealed = 1
    AND plan.status IN ('queued','running')
    AND EXISTS (
      SELECT 1 FROM generation_task_claims claim
      WHERE claim.task_id = attempt.task_id
        AND claim.attempt = attempt.attempt
        AND claim.workspace_id = attempt.workspace_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM generation_task_claims claim
      WHERE claim.task_id = attempt.task_id
        AND claim.attempt = attempt.attempt
        AND (
          claim.plan_id IS NOT attempt.plan_id
          OR claim.workspace_id IS NOT attempt.workspace_id
          OR claim.owner_id IS NOT attempt.owner_id
          OR claim.lease_token IS NOT attempt.lease_token
          OR claim.lease_expires_at IS NOT attempt.lease_expires_at
        )
    )
)
BEGIN SELECT RAISE(ABORT, 'Generation Task cannot run before its current Attempt owns exact claims'); END;

CREATE TRIGGER generation_run_insert_ownership
BEFORE INSERT ON runs
WHEN (NEW.plan_id IS NULL) <> (NEW.task_id IS NULL)
  OR (NEW.plan_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM generation_tasks task
    JOIN generation_task_attempts attempt
      ON attempt.task_id = task.id
     AND attempt.plan_id = task.plan_id
     AND attempt.workspace_id = task.workspace_id
     AND attempt.attempt = NEW.attempt
    JOIN project_workspaces workspace
      ON workspace.id = task.workspace_id AND workspace.project_id = NEW.project_id
    LEFT JOIN context_packs pack
      ON pack.id = attempt.context_pack_id AND pack.workspace_id = attempt.workspace_id
    WHERE task.id = NEW.task_id
      AND task.plan_id = NEW.plan_id
      AND NEW.artifact_id IS attempt.target_artifact_id
      AND NEW.artifact_track_id IS attempt.target_track_id
      AND NEW.base_revision_id IS attempt.base_revision_id
      AND NEW.context_pack_id IS attempt.context_pack_id
      AND NEW.context_pack_hash IS pack.hash
  ))
BEGIN SELECT RAISE(ABORT, 'Run Generation Task attribution ownership is invalid'); END;

CREATE TRIGGER generation_run_update_immutable
BEFORE UPDATE OF project_id, plan_id, task_id, attempt, artifact_id, artifact_track_id,
  base_revision_id, context_pack_id, context_pack_hash ON runs
WHEN NEW.project_id IS NOT OLD.project_id
  OR NEW.plan_id IS NOT OLD.plan_id
  OR NEW.task_id IS NOT OLD.task_id
  OR NEW.attempt IS NOT OLD.attempt
  OR NEW.artifact_id IS NOT OLD.artifact_id
  OR NEW.artifact_track_id IS NOT OLD.artifact_track_id
  OR NEW.base_revision_id IS NOT OLD.base_revision_id
  OR NEW.context_pack_id IS NOT OLD.context_pack_id
  OR NEW.context_pack_hash IS NOT OLD.context_pack_hash
BEGIN SELECT RAISE(ABORT, 'Run Generation Task attribution is immutable'); END;
`;

const WORKSPACE_ACTIVE_STATE_TRANSITION_TRIGGER_SCHEMA = `
CREATE TRIGGER IF NOT EXISTS workspace_active_state_transition_guard
BEFORE UPDATE OF active_snapshot_id, graph_revision, active_kernel_revision_id ON project_workspaces
WHEN NEW.active_snapshot_id IS NOT NULL AND (
  NEW.active_snapshot_id IS OLD.active_snapshot_id
  OR NOT EXISTS (
    SELECT 1
    FROM workspace_snapshots snapshot
    JOIN workspace_graph_revisions graph
      ON graph.workspace_id = snapshot.workspace_id
     AND graph.revision = snapshot.graph_revision
    WHERE snapshot.id = NEW.active_snapshot_id
      AND snapshot.workspace_id = NEW.id
      AND snapshot.parent_snapshot_id IS OLD.active_snapshot_id
      AND snapshot.graph_revision = NEW.graph_revision
      AND snapshot.kernel_revision_id = NEW.active_kernel_revision_id
      AND snapshot.sealed = 1
      AND json_type(graph.nodes_json) = 'array'
      AND json_type(graph.edges_json) = 'array'
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(graph.nodes_json) node
        WHERE json_type(node.value, '$.id') IS NOT 'text'
          OR length(trim(json_extract(node.value, '$.id'))) = 0
          OR json_type(node.value, '$.workspaceId') IS NOT 'text'
          OR json_extract(node.value, '$.workspaceId') IS NOT NEW.id
          OR json_type(node.value, '$.name') IS NOT 'text'
          OR length(trim(json_extract(node.value, '$.name'))) = 0
          OR COALESCE(json_extract(node.value, '$.kind'), '') NOT IN ('page', 'component', 'resource')
          OR (
            json_extract(node.value, '$.kind') IN ('page', 'component')
            AND (
              json_type(node.value, '$.artifactId') IS NOT 'text'
              OR length(trim(json_extract(node.value, '$.artifactId'))) = 0
            )
          )
          OR (
            json_extract(node.value, '$.kind') = 'resource'
            AND (
              json_type(node.value, '$.resourceId') IS NOT 'text'
              OR length(trim(json_extract(node.value, '$.resourceId'))) = 0
            )
          )
      )
      AND NOT EXISTS (
        SELECT json_extract(node.value, '$.id')
        FROM json_each(graph.nodes_json) node
        GROUP BY json_extract(node.value, '$.id')
        HAVING COUNT(*) > 1
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(graph.nodes_json) node
        LEFT JOIN workspace_artifacts artifact
          ON artifact.id = json_extract(node.value, '$.artifactId')
         AND artifact.workspace_id = NEW.id
         AND artifact.archived_at IS NULL
        LEFT JOIN artifact_tracks track
          ON track.id = artifact.active_track_id
         AND track.artifact_id = artifact.id
        LEFT JOIN workspace_snapshot_artifacts mapping
          ON mapping.workspace_id = NEW.id
         AND mapping.snapshot_id = snapshot.id
         AND mapping.artifact_id = json_extract(node.value, '$.artifactId')
        LEFT JOIN artifact_revisions pinned_revision
          ON pinned_revision.id = mapping.revision_id
         AND pinned_revision.workspace_id = mapping.workspace_id
         AND pinned_revision.artifact_id = mapping.artifact_id
         AND pinned_revision.track_id = mapping.track_id
         AND pinned_revision.sealed = 1
        WHERE json_extract(node.value, '$.kind') IN ('page', 'component')
          AND (
            artifact.id IS NULL
            OR artifact.kind IS NOT json_extract(node.value, '$.kind')
            OR artifact.name IS NOT json_extract(node.value, '$.name')
            OR track.id IS NULL
            OR mapping.artifact_id IS NULL
            OR mapping.track_id IS NOT artifact.active_track_id
            OR mapping.revision_id IS NOT track.head_revision_id
            OR (mapping.revision_id IS NOT NULL AND pinned_revision.id IS NULL)
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM workspace_snapshot_artifacts mapping
        WHERE mapping.workspace_id = NEW.id
          AND mapping.snapshot_id = snapshot.id
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(graph.nodes_json) node
            WHERE json_extract(node.value, '$.kind') IN ('page', 'component')
              AND json_extract(node.value, '$.artifactId') = mapping.artifact_id
          )
      )
      AND (
        SELECT COUNT(*)
        FROM json_each(graph.nodes_json) node
        WHERE json_extract(node.value, '$.kind') IN ('page', 'component')
      ) = (
        SELECT COUNT(*)
        FROM workspace_snapshot_artifacts mapping
        WHERE mapping.workspace_id = NEW.id
          AND mapping.snapshot_id = snapshot.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(graph.nodes_json) node
        LEFT JOIN resources resource
          ON resource.id = json_extract(node.value, '$.resourceId')
         AND resource.workspace_id = NEW.id
         AND resource.archived_at IS NULL
        LEFT JOIN workspace_snapshot_resources mapping
          ON mapping.workspace_id = NEW.id
         AND mapping.snapshot_id = snapshot.id
         AND mapping.resource_id = json_extract(node.value, '$.resourceId')
        LEFT JOIN resource_revisions pinned_revision
          ON pinned_revision.id = mapping.revision_id
         AND pinned_revision.workspace_id = mapping.workspace_id
         AND pinned_revision.resource_id = mapping.resource_id
        WHERE json_extract(node.value, '$.kind') = 'resource'
          AND (
            resource.id IS NULL
            OR resource.title IS NOT json_extract(node.value, '$.name')
            OR (resource.head_revision_id IS NOT NULL AND mapping.resource_id IS NULL)
            OR (mapping.resource_id IS NOT NULL AND pinned_revision.id IS NULL)
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM workspace_snapshot_resources mapping
        WHERE mapping.workspace_id = NEW.id
          AND mapping.snapshot_id = snapshot.id
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(graph.nodes_json) node
            WHERE json_extract(node.value, '$.kind') = 'resource'
              AND json_extract(node.value, '$.resourceId') = mapping.resource_id
          )
      )
      AND NOT EXISTS (
        SELECT json_extract(node.value, '$.resourceId')
        FROM json_each(graph.nodes_json) node
        WHERE json_extract(node.value, '$.kind') = 'resource'
        GROUP BY json_extract(node.value, '$.resourceId')
        HAVING COUNT(*) > 1
      )
  )
)
BEGIN SELECT RAISE(ABORT, 'workspace active state must advance to a coherent direct child Snapshot'); END;
`;

export const STORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  skill_id TEXT,
  design_system_id TEXT,
  mode TEXT,
  sharingan INTEGER NOT NULL DEFAULT 0,
  source_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  active_variant_id TEXT
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  scope_type TEXT CHECK(scope_type IN ('workspace','artifact','resource')),
  scope_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  variant_id TEXT,
  user_message_id TEXT,
  assistant_message_id TEXT,
  commit_hash TEXT,
  artifact_id TEXT,
  artifact_track_id TEXT,
  plan_id TEXT,
  task_id TEXT,
  base_revision_id TEXT,
  context_pack_id TEXT,
  context_pack_hash TEXT,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt > 0),
  owner_id TEXT,
  status TEXT NOT NULL,
  repair_rounds INTEGER NOT NULL DEFAULT 0,
  lint_passed INTEGER NOT NULL DEFAULT 0,
  score INTEGER,
  final_findings TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  model TEXT,
  agent_command TEXT,
  skill_id TEXT,
  feedback TEXT
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  lint_passed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS variants (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_id);
CREATE INDEX IF NOT EXISTS idx_variants_project ON variants(project_id);
CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  agent_command TEXT,
  model TEXT,
  api_base_url TEXT,
  api_key TEXT,
  default_design_system_id TEXT,
  custom_instructions TEXT,
  image_api_base_url TEXT,
  image_api_key TEXT,
  image_model TEXT,
  remove_background_model TEXT,
  edit_region_model TEXT,
  extract_layer_model TEXT,
  video_api_base_url TEXT,
  video_api_key TEXT,
  video_model TEXT,
  ai_provider_id TEXT,
  ai_provider_enabled INTEGER NOT NULL DEFAULT 0,
  ai_provider_models TEXT,
  ai_provider_organization TEXT,
  ai_provider_profiles TEXT,
  visual_qa_enabled INTEGER NOT NULL DEFAULT 0,
  auto_fix_live_runtime_errors INTEGER NOT NULL DEFAULT 0,
  sharingan_affirmed INTEGER NOT NULL DEFAULT 0,
  visual_qa_agent_command TEXT,
  visual_qa_model TEXT,
  auto_improve_enabled INTEGER NOT NULL DEFAULT 1,
  auto_improve_max_rounds INTEGER NOT NULL DEFAULT 8,
  research_enabled INTEGER NOT NULL DEFAULT 0,
  research_agent_command TEXT,
  research_model TEXT
);
CREATE TABLE IF NOT EXISTS moodboards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  cover_asset_id TEXT,
  status TEXT NOT NULL DEFAULT 'ready'
);
CREATE TABLE IF NOT EXISTS moodboard_nodes (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES moodboards(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  width REAL NOT NULL,
  height REAL NOT NULL,
  rotation REAL NOT NULL DEFAULT 0,
  z_index INTEGER NOT NULL DEFAULT 0,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS moodboard_assets (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES moodboards(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS moodboard_conversations (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES moodboards(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS moodboard_messages (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES moodboards(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES moodboard_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS custom_effects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  summary TEXT NOT NULL,
  code TEXT NOT NULL,
  parameters_json TEXT NOT NULL DEFAULT '[]',
  presets_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moodboard_nodes_board ON moodboard_nodes(board_id);
CREATE INDEX IF NOT EXISTS idx_moodboard_assets_board ON moodboard_assets(board_id);
CREATE INDEX IF NOT EXISTS idx_moodboard_conversations_board ON moodboard_conversations(board_id);
CREATE INDEX IF NOT EXISTS idx_moodboard_messages_board ON moodboard_messages(board_id);
CREATE TABLE IF NOT EXISTS extension_credentials (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  extension_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_extension_credentials_token_hash ON extension_credentials(token_hash);

-- Normalized multi-artifact workspace state. These tables are additive: legacy
-- Project/Run/Variant/Artifact rows remain the compatibility boundary.
CREATE TABLE IF NOT EXISTS project_workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  graph_revision INTEGER NOT NULL DEFAULT 0,
  active_snapshot_id TEXT,
  active_kernel_revision_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(id, graph_revision)
    REFERENCES workspace_graph_revisions(workspace_id, revision)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(active_snapshot_id, id)
    REFERENCES workspace_snapshots(id, workspace_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(active_kernel_revision_id, id)
    REFERENCES shared_design_kernel_revisions(id, workspace_id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE IF NOT EXISTS workspace_artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES project_workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('page','component')),
  name TEXT NOT NULL,
  source_root TEXT NOT NULL,
  legacy_wrapped INTEGER NOT NULL DEFAULT 0 CHECK(legacy_wrapped IN (0, 1)),
  active_track_id TEXT,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(active_track_id, id)
    REFERENCES artifact_tracks(id, artifact_id)
    DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(id, workspace_id)
);
CREATE TABLE IF NOT EXISTS artifact_tracks (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES workspace_artifacts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  head_revision_id TEXT,
  legacy_variant_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(head_revision_id, id, artifact_id)
    REFERENCES artifact_revisions(id, track_id, artifact_id)
    DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(id, artifact_id),
  UNIQUE(artifact_id, legacy_variant_id)
);
CREATE TABLE IF NOT EXISTS shared_design_kernel_revisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES project_workspaces(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  parent_revision_id TEXT,
  payload_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(parent_revision_id, workspace_id)
    REFERENCES shared_design_kernel_revisions(id, workspace_id),
  UNIQUE(id, workspace_id),
  UNIQUE(workspace_id, sequence)
);
CREATE TABLE IF NOT EXISTS artifact_revisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES project_workspaces(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  parent_revision_id TEXT,
  source_commit_hash TEXT NOT NULL,
  source_tree_hash TEXT NOT NULL,
  artifact_root TEXT NOT NULL,
  kernel_revision_id TEXT NOT NULL,
  render_spec_json TEXT NOT NULL,
  quality_json TEXT NOT NULL,
  context_pack_hash TEXT,
  produced_by_run_id TEXT REFERENCES runs(id),
  legacy_run_id TEXT,
  created_at INTEGER NOT NULL,
  sealed INTEGER NOT NULL DEFAULT 1 CHECK(sealed IN (0, 1)),
  FOREIGN KEY(artifact_id, workspace_id)
    REFERENCES workspace_artifacts(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(track_id, artifact_id)
    REFERENCES artifact_tracks(id, artifact_id) ON DELETE CASCADE,
  FOREIGN KEY(kernel_revision_id, workspace_id)
    REFERENCES shared_design_kernel_revisions(id, workspace_id),
  FOREIGN KEY(parent_revision_id, artifact_id, track_id, workspace_id)
    REFERENCES artifact_revisions(id, artifact_id, track_id, workspace_id),
  UNIQUE(id, artifact_id, track_id, workspace_id),
  UNIQUE(id, track_id, artifact_id),
  UNIQUE(id, artifact_id, workspace_id),
  UNIQUE(id, workspace_id),
  UNIQUE(track_id, sequence),
  UNIQUE(workspace_id, legacy_run_id)
);
CREATE TABLE IF NOT EXISTS component_instances (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES project_workspaces(id) ON DELETE CASCADE,
  owner_artifact_id TEXT NOT NULL,
  component_artifact_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(owner_artifact_id, workspace_id)
    REFERENCES workspace_artifacts(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(component_artifact_id, workspace_id)
    REFERENCES workspace_artifacts(id, workspace_id) ON DELETE CASCADE,
  UNIQUE(id, owner_artifact_id, workspace_id),
  UNIQUE(id, owner_artifact_id, component_artifact_id, workspace_id)
);
CREATE TABLE IF NOT EXISTS artifact_revision_dependencies (
  workspace_id TEXT NOT NULL,
  owner_artifact_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  component_artifact_id TEXT NOT NULL,
  component_revision_id TEXT NOT NULL,
  variant_key TEXT,
  state_key TEXT,
  design_node_id TEXT NOT NULL,
  source_locator_json TEXT NOT NULL,
  overrides_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('linked','detached')),
  FOREIGN KEY(revision_id, owner_artifact_id, workspace_id)
    REFERENCES artifact_revisions(id, artifact_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(instance_id, owner_artifact_id, component_artifact_id, workspace_id)
    REFERENCES component_instances(id, owner_artifact_id, component_artifact_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(component_revision_id, component_artifact_id, workspace_id)
    REFERENCES artifact_revisions(id, artifact_id, workspace_id) ON DELETE CASCADE,
  PRIMARY KEY(revision_id, instance_id)
);
CREATE TABLE IF NOT EXISTS artifact_revision_resources (
  workspace_id TEXT NOT NULL,
  owner_artifact_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_revision_id TEXT NOT NULL,
  FOREIGN KEY(revision_id, owner_artifact_id, workspace_id)
    REFERENCES artifact_revisions(id, artifact_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(resource_revision_id, resource_id, workspace_id)
    REFERENCES resource_revisions(id, resource_id, workspace_id) ON DELETE CASCADE,
  PRIMARY KEY(revision_id, resource_id)
);
CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES project_workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('research','moodboard','sharingan-capture','file','asset','effect','external-reference')),
  title TEXT NOT NULL,
  head_revision_id TEXT,
  default_pin_policy TEXT NOT NULL DEFAULT 'follow-head'
    CHECK(default_pin_policy IN ('follow-head','pin-current','manual')),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(head_revision_id, id, workspace_id)
    REFERENCES resource_revisions(id, resource_id, workspace_id)
    DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(id, workspace_id)
);
CREATE TABLE IF NOT EXISTS resource_revisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  parent_revision_id TEXT,
  manifest_path TEXT NOT NULL,
  summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_by_run_id TEXT REFERENCES runs(id),
  created_at INTEGER NOT NULL,
  FOREIGN KEY(resource_id, workspace_id)
    REFERENCES resources(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(parent_revision_id, resource_id, workspace_id)
    REFERENCES resource_revisions(id, resource_id, workspace_id),
  UNIQUE(id, resource_id, workspace_id),
  UNIQUE(id, workspace_id),
  UNIQUE(resource_id, sequence)
);
CREATE TABLE IF NOT EXISTS workspace_nodes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES project_workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('page','component','resource')),
  artifact_id TEXT,
  resource_id TEXT,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(artifact_id, workspace_id)
    REFERENCES workspace_artifacts(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(resource_id, workspace_id)
    REFERENCES resources(id, workspace_id) ON DELETE CASCADE,
  CHECK(
    (kind IN ('page','component') AND artifact_id IS NOT NULL AND resource_id IS NULL)
    OR (kind = 'resource' AND resource_id IS NOT NULL AND artifact_id IS NULL)
  ),
  UNIQUE(id, workspace_id),
  UNIQUE(workspace_id, artifact_id),
  UNIQUE(workspace_id, resource_id)
);
CREATE TABLE IF NOT EXISTS workspace_edges (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES project_workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('prototype','uses','informs','derives-from')),
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(source_node_id, workspace_id)
    REFERENCES workspace_nodes(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(target_node_id, workspace_id)
    REFERENCES workspace_nodes(id, workspace_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS workspace_graph_revisions (
  workspace_id TEXT NOT NULL REFERENCES project_workspaces(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  nodes_json TEXT NOT NULL,
  edges_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, revision)
);
CREATE TABLE IF NOT EXISTS workspace_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES project_workspaces(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  parent_snapshot_id TEXT,
  graph_revision INTEGER NOT NULL,
  kernel_revision_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_by_run_id TEXT REFERENCES runs(id),
  created_at INTEGER NOT NULL,
  sealed INTEGER NOT NULL DEFAULT 1 CHECK(sealed IN (0, 1)),
  FOREIGN KEY(workspace_id, graph_revision)
    REFERENCES workspace_graph_revisions(workspace_id, revision),
  FOREIGN KEY(kernel_revision_id, workspace_id)
    REFERENCES shared_design_kernel_revisions(id, workspace_id),
  FOREIGN KEY(parent_snapshot_id, workspace_id)
    REFERENCES workspace_snapshots(id, workspace_id),
  UNIQUE(id, workspace_id),
  UNIQUE(workspace_id, sequence)
);
CREATE TABLE IF NOT EXISTS workspace_graph_commands (
  workspace_id TEXT NOT NULL REFERENCES project_workspaces(id) ON DELETE CASCADE,
  command_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  result_revision INTEGER NOT NULL,
  expected_snapshot_id TEXT,
  batch_hash TEXT NOT NULL,
  batch_index INTEGER NOT NULL,
  batch_size INTEGER NOT NULL,
  result_snapshot_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(workspace_id, base_revision)
    REFERENCES workspace_graph_revisions(workspace_id, revision),
  FOREIGN KEY(workspace_id, result_revision)
    REFERENCES workspace_graph_revisions(workspace_id, revision),
  FOREIGN KEY(expected_snapshot_id, workspace_id)
    REFERENCES workspace_snapshots(id, workspace_id),
  FOREIGN KEY(result_snapshot_id, workspace_id)
    REFERENCES workspace_snapshots(id, workspace_id),
  PRIMARY KEY(workspace_id, command_id)
);
CREATE TABLE IF NOT EXISTS workspace_layout_nodes (
  workspace_id TEXT NOT NULL REFERENCES project_workspaces(id) ON DELETE CASCADE,
  layout_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_kind TEXT NOT NULL CHECK(object_kind IN ('node','group')),
  x REAL NOT NULL,
  y REAL NOT NULL,
  width REAL,
  height REAL,
  parent_group_id TEXT,
  label TEXT,
  collapsed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, layout_id, object_id)
);
CREATE TABLE IF NOT EXISTS workspace_layout_viewports (
  workspace_id TEXT NOT NULL REFERENCES project_workspaces(id) ON DELETE CASCADE,
  layout_id TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  zoom REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, layout_id)
);
CREATE TABLE IF NOT EXISTS workspace_snapshot_artifacts (
  workspace_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  revision_id TEXT,
  FOREIGN KEY(snapshot_id, workspace_id)
    REFERENCES workspace_snapshots(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(artifact_id, workspace_id)
    REFERENCES workspace_artifacts(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(track_id, artifact_id)
    REFERENCES artifact_tracks(id, artifact_id) ON DELETE CASCADE,
  FOREIGN KEY(revision_id, artifact_id, track_id, workspace_id)
    REFERENCES artifact_revisions(id, artifact_id, track_id, workspace_id) ON DELETE CASCADE,
  PRIMARY KEY(snapshot_id, artifact_id)
);
CREATE TABLE IF NOT EXISTS workspace_snapshot_resources (
  workspace_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  FOREIGN KEY(snapshot_id, workspace_id)
    REFERENCES workspace_snapshots(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(resource_id, workspace_id)
    REFERENCES resources(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(revision_id, resource_id, workspace_id)
    REFERENCES resource_revisions(id, resource_id, workspace_id) ON DELETE CASCADE,
  PRIMARY KEY(snapshot_id, resource_id)
);
CREATE TABLE IF NOT EXISTS context_packs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES project_workspaces(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK(scope_type IN ('workspace','artifact','resource')),
  scope_id TEXT NOT NULL,
  graph_revision INTEGER NOT NULL,
  intent TEXT NOT NULL CHECK(intent IN ('plan','generate','edit','repair','analyze-impact')),
  message_checksum TEXT NOT NULL,
  manifest_path TEXT NOT NULL,
  token_estimate INTEGER NOT NULL CHECK(token_estimate >= 0),
  omissions_json TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sealed INTEGER NOT NULL DEFAULT 0 CHECK(sealed IN (0, 1)),
  UNIQUE(id, workspace_id),
  UNIQUE(workspace_id, hash),
  FOREIGN KEY(workspace_id, graph_revision)
    REFERENCES workspace_graph_revisions(workspace_id, revision)
);
CREATE TABLE IF NOT EXISTS context_pack_items (
  context_pack_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  ref_json TEXT NOT NULL,
  resolved_kind TEXT NOT NULL CHECK(resolved_kind IN ('artifact-revision','resource-revision','kernel-revision','inline')),
  artifact_revision_id TEXT,
  resource_revision_id TEXT,
  kernel_revision_id TEXT,
  checksum TEXT NOT NULL,
  reason TEXT NOT NULL,
  trust_level TEXT NOT NULL CHECK(trust_level IN ('system','trusted','untrusted')),
  boundary_json TEXT NOT NULL,
  token_estimate INTEGER NOT NULL CHECK(token_estimate >= 0),
  provenance_json TEXT NOT NULL,
  provided INTEGER NOT NULL CHECK(provided IN (0, 1)),
  FOREIGN KEY(context_pack_id, workspace_id)
    REFERENCES context_packs(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(artifact_revision_id, workspace_id)
    REFERENCES artifact_revisions(id, workspace_id),
  FOREIGN KEY(resource_revision_id, workspace_id)
    REFERENCES resource_revisions(id, workspace_id),
  FOREIGN KEY(kernel_revision_id, workspace_id)
    REFERENCES shared_design_kernel_revisions(id, workspace_id),
  CHECK(
    (resolved_kind = 'artifact-revision' AND artifact_revision_id IS NOT NULL AND resource_revision_id IS NULL AND kernel_revision_id IS NULL) OR
    (resolved_kind = 'resource-revision' AND artifact_revision_id IS NULL AND resource_revision_id IS NOT NULL AND kernel_revision_id IS NULL) OR
    (resolved_kind = 'kernel-revision' AND artifact_revision_id IS NULL AND resource_revision_id IS NULL AND kernel_revision_id IS NOT NULL) OR
    (resolved_kind = 'inline' AND artifact_revision_id IS NULL AND resource_revision_id IS NULL AND kernel_revision_id IS NULL)
  ),
  PRIMARY KEY(context_pack_id, ordinal),
  UNIQUE(context_pack_id, ordinal, workspace_id)
);
CREATE TABLE IF NOT EXISTS context_pack_item_usage (
  context_pack_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  usage_kind TEXT NOT NULL CHECK(usage_kind IN ('observed-read','agent-declared-used')),
  run_id TEXT REFERENCES runs(id),
  evidence_json TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  FOREIGN KEY(context_pack_id, ordinal, workspace_id)
    REFERENCES context_pack_items(context_pack_id, ordinal, workspace_id) ON DELETE CASCADE,
  PRIMARY KEY(context_pack_id, ordinal, sequence)
);
CREATE TABLE IF NOT EXISTS workspace_proposals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES project_workspaces(id) ON DELETE CASCADE,
  base_graph_revision INTEGER NOT NULL,
  base_snapshot_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  kind TEXT NOT NULL CHECK(kind IN ('workspace-generation','component-propagation')),
  status TEXT NOT NULL CHECK(status IN ('draft','approved','rejected','superseded','conflicted')),
  operations_json TEXT NOT NULL,
  layout_id TEXT NOT NULL,
  base_layout_checksum TEXT NOT NULL,
  base_layout_json TEXT NOT NULL,
  layout_operations_json TEXT NOT NULL DEFAULT '[]',
  rationale TEXT NOT NULL,
  assumptions_json TEXT NOT NULL,
  generation_payload_json TEXT NOT NULL,
  review_json TEXT NOT NULL DEFAULT '{"kind":"none"}',
  created_by_run_id TEXT REFERENCES runs(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(workspace_id, base_graph_revision)
    REFERENCES workspace_graph_revisions(workspace_id, revision),
  FOREIGN KEY(base_snapshot_id, workspace_id)
    REFERENCES workspace_snapshots(id, workspace_id),
  UNIQUE(id, workspace_id)
);
CREATE TABLE IF NOT EXISTS workspace_proposal_audit (
  proposal_id TEXT NOT NULL REFERENCES workspace_proposals(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision > 0),
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(proposal_id, revision)
);
CREATE TABLE IF NOT EXISTS generation_plans (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES project_workspaces(id) ON DELETE CASCADE,
  proposal_id TEXT NOT NULL,
  proposal_revision INTEGER NOT NULL,
  base_snapshot_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'approved','queued','running','succeeded','failed','compile-failed','requires-new-impact','cancelled'
  )),
  construction_sealed INTEGER NOT NULL DEFAULT 0 CHECK(construction_sealed IN (0, 1)),
  compile_error_json TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  FOREIGN KEY(proposal_id, workspace_id)
    REFERENCES workspace_proposals(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(proposal_id, proposal_revision)
    REFERENCES workspace_proposal_audit(proposal_id, revision),
  FOREIGN KEY(base_snapshot_id, workspace_id)
    REFERENCES workspace_snapshots(id, workspace_id),
  UNIQUE(proposal_id, proposal_revision),
  UNIQUE(id, workspace_id)
);

${TASK12_GENERATION_TABLE_SCHEMA}
${TASK12_GENERATION_TRIGGER_SCHEMA}

CREATE INDEX IF NOT EXISTS idx_workspace_nodes_workspace ON workspace_nodes(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_edges_workspace ON workspace_edges(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_edges_source
  ON workspace_edges(source_node_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_edges_target
  ON workspace_edges(target_node_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_graph_revisions_workspace
  ON workspace_graph_revisions(workspace_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_artifacts_workspace ON workspace_artifacts(workspace_id);
CREATE INDEX IF NOT EXISTS idx_artifact_tracks_artifact ON artifact_tracks(artifact_id);
CREATE INDEX IF NOT EXISTS idx_artifact_revisions_track ON artifact_revisions(track_id, sequence DESC);
CREATE INDEX IF NOT EXISTS idx_kernel_revisions_workspace
  ON shared_design_kernel_revisions(workspace_id, sequence DESC);
CREATE INDEX IF NOT EXISTS idx_component_instances_owner
  ON component_instances(owner_artifact_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_component_instances_component
  ON component_instances(component_artifact_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_component_instances_workspace
  ON component_instances(workspace_id);
CREATE INDEX IF NOT EXISTS idx_artifact_revision_dependencies_instance
  ON artifact_revision_dependencies(instance_id, owner_artifact_id, component_artifact_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_artifact_revision_dependencies_component
  ON artifact_revision_dependencies(component_revision_id, component_artifact_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_artifact_revision_resources_revision
  ON artifact_revision_resources(revision_id, owner_artifact_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_artifact_revision_resources_resource
  ON artifact_revision_resources(resource_revision_id, resource_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_resources_workspace ON resources(workspace_id);
CREATE INDEX IF NOT EXISTS idx_resource_revisions_workspace ON resource_revisions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_snapshots_workspace ON workspace_snapshots(workspace_id, sequence DESC);
CREATE INDEX IF NOT EXISTS idx_snapshot_artifacts_owner
  ON workspace_snapshot_artifacts(artifact_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_snapshot_artifacts_track
  ON workspace_snapshot_artifacts(track_id, artifact_id);
CREATE INDEX IF NOT EXISTS idx_snapshot_artifacts_revision
  ON workspace_snapshot_artifacts(revision_id, artifact_id, track_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_snapshot_resources_owner
  ON workspace_snapshot_resources(resource_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_snapshot_resources_revision
  ON workspace_snapshot_resources(revision_id, resource_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_context_packs_workspace
  ON context_packs(workspace_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_context_pack_items_resource
  ON context_pack_items(resource_revision_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_context_pack_usage_run
  ON context_pack_item_usage(run_id);
CREATE INDEX IF NOT EXISTS idx_workspace_proposals_workspace
  ON workspace_proposals(workspace_id, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_generation_plans_workspace
  ON generation_plans(workspace_id, created_at DESC, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_plans_proposal_revision
  ON generation_plans(proposal_id, proposal_revision);

CREATE TRIGGER IF NOT EXISTS workspace_proposal_insert_immutable
BEFORE INSERT ON workspace_proposals
WHEN EXISTS (SELECT 1 FROM workspace_proposals existing WHERE existing.id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'Workspace Proposal identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS workspace_proposal_initial_state_guard
BEFORE INSERT ON workspace_proposals
WHEN NEW.status IS NOT 'draft'
  OR CASE
    WHEN json_valid(NEW.review_json) = 0 THEN 1
    WHEN json_type(NEW.review_json) IS NOT 'object' THEN 1
    WHEN json_extract(NEW.review_json, '$.kind') IS NOT 'none' THEN 1
    ELSE 0
  END
BEGIN SELECT RAISE(ABORT, 'Workspace Proposal must begin as an unreviewed draft'); END;
CREATE TRIGGER IF NOT EXISTS workspace_proposal_base_snapshot_insert_guard
BEFORE INSERT ON workspace_proposals
WHEN NOT EXISTS (
  SELECT 1 FROM workspace_snapshots snapshot
  WHERE snapshot.id = NEW.base_snapshot_id
    AND snapshot.workspace_id = NEW.workspace_id
    AND snapshot.graph_revision = NEW.base_graph_revision
    AND snapshot.sealed = 1
)
BEGIN SELECT RAISE(ABORT, 'Workspace Proposal base Snapshot must be sealed and match its base graph'); END;
CREATE TRIGGER IF NOT EXISTS workspace_proposal_run_insert_ownership
BEFORE INSERT ON workspace_proposals
WHEN NEW.created_by_run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM runs run
  JOIN project_workspaces workspace ON workspace.project_id = run.project_id
  WHERE run.id = NEW.created_by_run_id AND workspace.id = NEW.workspace_id
)
BEGIN SELECT RAISE(ABORT, 'Workspace Proposal Run belongs to another Project'); END;
CREATE TRIGGER IF NOT EXISTS workspace_proposal_identity_update_immutable
BEFORE UPDATE OF id, workspace_id, base_graph_revision, base_snapshot_id, kind, layout_id,
  base_layout_checksum, base_layout_json, created_by_run_id, created_at ON workspace_proposals
WHEN NEW.id IS NOT OLD.id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.base_graph_revision IS NOT OLD.base_graph_revision
  OR NEW.base_snapshot_id IS NOT OLD.base_snapshot_id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.layout_id IS NOT OLD.layout_id
  OR NEW.base_layout_checksum IS NOT OLD.base_layout_checksum
  OR NEW.base_layout_json IS NOT OLD.base_layout_json
  OR NEW.created_by_run_id IS NOT OLD.created_by_run_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'Workspace Proposal base identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS workspace_proposal_state_transition_guard
BEFORE UPDATE ON workspace_proposals
WHEN NEW.updated_at < OLD.updated_at
  OR (
    OLD.status IS NOT 'draft'
    AND (NEW.status IS NOT OLD.status OR NEW.review_json IS NOT OLD.review_json)
  )
  OR (
    OLD.status IS 'draft'
    AND CASE
      WHEN json_valid(NEW.review_json) = 0 THEN 1
      WHEN json_type(NEW.review_json) IS NOT 'object' THEN 1
      WHEN NEW.status IS 'draft'
        AND json_extract(NEW.review_json, '$.kind') IS 'none' THEN 0
      WHEN NEW.status IS 'approved'
        AND json_extract(NEW.review_json, '$.kind') IS 'approved'
        AND json_extract(NEW.review_json, '$.mode') IN ('structure-only', 'generate') THEN 0
      WHEN NEW.status IS 'rejected'
        AND json_extract(NEW.review_json, '$.kind') IS 'rejected' THEN 0
      WHEN NEW.status IS 'conflicted'
        AND json_extract(NEW.review_json, '$.kind') IS 'conflict' THEN 0
      WHEN NEW.status IS 'superseded'
        AND json_extract(NEW.review_json, '$.kind') IS 'none' THEN 0
      ELSE 1
    END
  )
BEGIN SELECT RAISE(ABORT, 'Workspace Proposal state transition is invalid or non-monotonic'); END;
CREATE TRIGGER IF NOT EXISTS workspace_proposal_delete_history_guard
BEFORE DELETE ON workspace_proposals
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Workspace Proposal history is immutable and cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS workspace_proposal_audit_insert_immutable
BEFORE INSERT ON workspace_proposal_audit
WHEN EXISTS (
  SELECT 1 FROM workspace_proposal_audit existing
  WHERE existing.proposal_id = NEW.proposal_id AND existing.revision = NEW.revision
)
BEGIN SELECT RAISE(ABORT, 'Workspace Proposal audit revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS workspace_proposal_audit_update_immutable
BEFORE UPDATE ON workspace_proposal_audit
BEGIN SELECT RAISE(ABORT, 'Workspace Proposal audit revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS workspace_proposal_audit_delete_history_guard
BEFORE DELETE ON workspace_proposal_audit
WHEN EXISTS (
  SELECT 1 FROM workspace_proposals proposal
  JOIN project_workspaces workspace ON workspace.id = proposal.workspace_id
  WHERE proposal.id = OLD.proposal_id
)
BEGIN SELECT RAISE(ABORT, 'Workspace Proposal audit history is immutable and cannot be deleted'); END;
DROP TRIGGER IF EXISTS generation_plan_insert_immutable;
CREATE TRIGGER generation_plan_insert_immutable
BEFORE INSERT ON generation_plans
WHEN EXISTS (
  SELECT 1 FROM generation_plans existing
  WHERE existing.id = NEW.id
    OR (
      existing.proposal_id = NEW.proposal_id
      AND existing.proposal_revision = NEW.proposal_revision
    )
)
BEGIN SELECT RAISE(ABORT, 'Generation Plan identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS generation_plan_identity_update_immutable
BEFORE UPDATE OF id, workspace_id, proposal_id, proposal_revision, base_snapshot_id, created_at ON generation_plans
WHEN NEW.id IS NOT OLD.id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.proposal_id IS NOT OLD.proposal_id
  OR NEW.proposal_revision IS NOT OLD.proposal_revision
  OR NEW.base_snapshot_id IS NOT OLD.base_snapshot_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'Generation Plan identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS generation_plan_delete_history_guard
BEFORE DELETE ON generation_plans
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Generation Plan history is immutable and cannot be deleted'); END;

-- Forward/cyclic ownership pointers cannot all be represented as composite FKs
-- without making the initial Workspace seed circular. Check both INSERT and
-- UPDATE paths at the database boundary instead.
CREATE TRIGGER IF NOT EXISTS workspace_active_snapshot_insert_ownership
BEFORE INSERT ON project_workspaces
WHEN NEW.active_snapshot_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_snapshots
  WHERE id = NEW.active_snapshot_id AND workspace_id = NEW.id AND sealed = 1
)
BEGIN SELECT RAISE(ABORT, 'workspace active snapshot ownership violation'); END;
CREATE TRIGGER IF NOT EXISTS workspace_active_snapshot_update_ownership
BEFORE UPDATE OF active_snapshot_id, id ON project_workspaces
WHEN NEW.active_snapshot_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_snapshots
  WHERE id = NEW.active_snapshot_id AND workspace_id = NEW.id AND sealed = 1
)
BEGIN SELECT RAISE(ABORT, 'workspace active snapshot ownership violation'); END;
CREATE TRIGGER IF NOT EXISTS workspace_active_snapshot_update_required
BEFORE UPDATE OF active_snapshot_id ON project_workspaces
WHEN NEW.active_snapshot_id IS NULL
BEGIN SELECT RAISE(ABORT, 'workspace active snapshot cannot be null'); END;
CREATE TRIGGER IF NOT EXISTS workspace_active_kernel_insert_ownership
BEFORE INSERT ON project_workspaces
WHEN NEW.active_kernel_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM shared_design_kernel_revisions
  WHERE id = NEW.active_kernel_revision_id AND workspace_id = NEW.id
)
BEGIN SELECT RAISE(ABORT, 'workspace active kernel ownership violation'); END;
CREATE TRIGGER IF NOT EXISTS workspace_active_kernel_update_ownership
BEFORE UPDATE OF active_kernel_revision_id, id ON project_workspaces
WHEN NEW.active_kernel_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM shared_design_kernel_revisions
  WHERE id = NEW.active_kernel_revision_id AND workspace_id = NEW.id
)
BEGIN SELECT RAISE(ABORT, 'workspace active kernel ownership violation'); END;
CREATE TRIGGER IF NOT EXISTS workspace_active_kernel_update_required
BEFORE UPDATE OF active_kernel_revision_id ON project_workspaces
WHEN NEW.active_kernel_revision_id IS NULL
BEGIN SELECT RAISE(ABORT, 'workspace active kernel cannot be null'); END;

${WORKSPACE_ACTIVE_STATE_TRANSITION_TRIGGER_SCHEMA}

CREATE TRIGGER IF NOT EXISTS workspace_active_kernel_lineage_guard
BEFORE UPDATE OF active_kernel_revision_id ON project_workspaces
WHEN NEW.active_kernel_revision_id IS NOT OLD.active_kernel_revision_id AND NOT EXISTS (
  SELECT 1 FROM shared_design_kernel_revisions revision
  WHERE revision.id = NEW.active_kernel_revision_id
    AND revision.workspace_id = NEW.id
    AND revision.parent_revision_id IS OLD.active_kernel_revision_id
)
BEGIN SELECT RAISE(ABORT, 'workspace active Kernel must advance to a direct child Revision'); END;

CREATE TRIGGER IF NOT EXISTS artifact_active_track_insert_ownership
BEFORE INSERT ON workspace_artifacts
WHEN NEW.active_track_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM artifact_tracks WHERE id = NEW.active_track_id AND artifact_id = NEW.id
)
BEGIN SELECT RAISE(ABORT, 'artifact active track ownership violation'); END;
CREATE TRIGGER IF NOT EXISTS artifact_active_track_update_ownership
BEFORE UPDATE OF active_track_id, id ON workspace_artifacts
WHEN NEW.active_track_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM artifact_tracks WHERE id = NEW.active_track_id AND artifact_id = NEW.id
)
BEGIN SELECT RAISE(ABORT, 'artifact active track ownership violation'); END;
CREATE TRIGGER IF NOT EXISTS artifact_active_track_clear_guard
BEFORE UPDATE OF active_track_id ON workspace_artifacts
WHEN OLD.active_track_id IS NOT NULL AND NEW.active_track_id IS NULL
BEGIN SELECT RAISE(ABORT, 'initialized Artifact active Track cannot be cleared'); END;

CREATE TRIGGER IF NOT EXISTS track_head_insert_ownership
BEFORE INSERT ON artifact_tracks
WHEN NEW.head_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM artifact_revisions
  WHERE id = NEW.head_revision_id AND artifact_id = NEW.artifact_id AND track_id = NEW.id AND sealed = 1
)
BEGIN SELECT RAISE(ABORT, 'track head ownership violation'); END;
CREATE TRIGGER IF NOT EXISTS track_head_update_ownership
BEFORE UPDATE OF head_revision_id, id, artifact_id ON artifact_tracks
WHEN NEW.head_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM artifact_revisions
  WHERE id = NEW.head_revision_id AND artifact_id = NEW.artifact_id AND track_id = NEW.id AND sealed = 1
)
BEGIN SELECT RAISE(ABORT, 'track head ownership violation'); END;
CREATE TRIGGER IF NOT EXISTS track_head_lineage_guard
BEFORE UPDATE OF head_revision_id ON artifact_tracks
WHEN NEW.head_revision_id IS NOT OLD.head_revision_id AND (
  NEW.head_revision_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM artifact_revisions revision
    WHERE revision.id = NEW.head_revision_id
      AND revision.track_id = NEW.id
      AND revision.artifact_id = NEW.artifact_id
      AND revision.parent_revision_id IS OLD.head_revision_id
      AND revision.sealed = 1
  )
)
BEGIN SELECT RAISE(ABORT, 'Artifact Track Head must advance to a direct child Revision'); END;

CREATE TRIGGER IF NOT EXISTS resource_head_insert_ownership
BEFORE INSERT ON resources
WHEN NEW.head_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM resource_revisions
  WHERE id = NEW.head_revision_id AND resource_id = NEW.id AND workspace_id = NEW.workspace_id
)
BEGIN SELECT RAISE(ABORT, 'resource head ownership violation'); END;
CREATE TRIGGER IF NOT EXISTS resource_head_update_ownership
BEFORE UPDATE OF head_revision_id, id, workspace_id ON resources
WHEN NEW.head_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM resource_revisions
  WHERE id = NEW.head_revision_id AND resource_id = NEW.id AND workspace_id = NEW.workspace_id
)
BEGIN SELECT RAISE(ABORT, 'resource head ownership violation'); END;

CREATE TRIGGER IF NOT EXISTS kernel_parent_insert_ownership
BEFORE INSERT ON shared_design_kernel_revisions
WHEN NEW.parent_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM shared_design_kernel_revisions
  WHERE id = NEW.parent_revision_id
    AND workspace_id = NEW.workspace_id
    AND sequence < NEW.sequence
)
BEGIN SELECT RAISE(ABORT, 'kernel parent ownership violation'); END;
CREATE TRIGGER IF NOT EXISTS kernel_parent_update_ownership
BEFORE UPDATE OF parent_revision_id, workspace_id ON shared_design_kernel_revisions
WHEN NEW.parent_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM shared_design_kernel_revisions
  WHERE id = NEW.parent_revision_id
    AND workspace_id = NEW.workspace_id
    AND sequence < NEW.sequence
)
BEGIN SELECT RAISE(ABORT, 'kernel parent ownership violation'); END;

CREATE TRIGGER IF NOT EXISTS artifact_revision_parent_insert_ownership
BEFORE INSERT ON artifact_revisions
WHEN NEW.parent_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM artifact_revisions
  WHERE id = NEW.parent_revision_id
    AND workspace_id = NEW.workspace_id
    AND artifact_id = NEW.artifact_id
    AND track_id = NEW.track_id
    AND sealed = 1
    AND sequence < NEW.sequence
)
BEGIN SELECT RAISE(ABORT, 'artifact revision parent ownership violation'); END;
CREATE TRIGGER IF NOT EXISTS artifact_revision_parent_update_ownership
BEFORE UPDATE OF parent_revision_id, workspace_id, artifact_id, track_id ON artifact_revisions
WHEN NEW.parent_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM artifact_revisions
  WHERE id = NEW.parent_revision_id
    AND workspace_id = NEW.workspace_id
    AND artifact_id = NEW.artifact_id
    AND track_id = NEW.track_id
    AND sealed = 1
    AND sequence < NEW.sequence
)
BEGIN SELECT RAISE(ABORT, 'artifact revision parent ownership violation'); END;
CREATE TRIGGER IF NOT EXISTS artifact_revision_root_insert_ownership
BEFORE INSERT ON artifact_revisions
WHEN NOT EXISTS (
  SELECT 1 FROM workspace_artifacts artifact
  WHERE artifact.id = NEW.artifact_id
    AND artifact.workspace_id = NEW.workspace_id
    AND artifact.source_root = NEW.artifact_root
)
BEGIN SELECT RAISE(ABORT, 'Artifact Revision root must match its owning Artifact source root'); END;

CREATE TRIGGER IF NOT EXISTS snapshot_parent_insert_ownership
BEFORE INSERT ON workspace_snapshots
WHEN NEW.parent_snapshot_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_snapshots
  WHERE id = NEW.parent_snapshot_id
    AND workspace_id = NEW.workspace_id
    AND sealed = 1
    AND sequence < NEW.sequence
)
BEGIN SELECT RAISE(ABORT, 'snapshot parent ownership violation'); END;
CREATE TRIGGER IF NOT EXISTS snapshot_parent_update_ownership
BEFORE UPDATE OF parent_snapshot_id, workspace_id ON workspace_snapshots
WHEN NEW.parent_snapshot_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_snapshots
  WHERE id = NEW.parent_snapshot_id
    AND workspace_id = NEW.workspace_id
    AND sealed = 1
    AND sequence < NEW.sequence
)
BEGIN SELECT RAISE(ABORT, 'snapshot parent ownership violation'); END;

CREATE TRIGGER IF NOT EXISTS workspace_node_artifact_kind_insert_ownership
BEFORE INSERT ON workspace_nodes
WHEN NEW.kind IN ('page', 'component') AND NOT EXISTS (
  SELECT 1 FROM workspace_artifacts
  WHERE id = NEW.artifact_id
    AND workspace_id = NEW.workspace_id
    AND kind = NEW.kind
)
BEGIN SELECT RAISE(ABORT, 'workspace node Artifact kind ownership violation'); END;
CREATE TRIGGER IF NOT EXISTS workspace_node_artifact_kind_update_ownership
BEFORE UPDATE OF kind, artifact_id, workspace_id ON workspace_nodes
WHEN NEW.kind IN ('page', 'component') AND NOT EXISTS (
  SELECT 1 FROM workspace_artifacts
  WHERE id = NEW.artifact_id
    AND workspace_id = NEW.workspace_id
    AND kind = NEW.kind
)
BEGIN SELECT RAISE(ABORT, 'workspace node Artifact kind ownership violation'); END;

CREATE TRIGGER IF NOT EXISTS workspace_artifact_kind_update_immutable
BEFORE UPDATE OF kind ON workspace_artifacts
WHEN NEW.kind IS NOT OLD.kind
BEGIN SELECT RAISE(ABORT, 'workspace Artifact kind is immutable'); END;
CREATE TRIGGER IF NOT EXISTS workspace_artifact_identity_update_immutable
BEFORE UPDATE OF id, workspace_id, kind, source_root ON workspace_artifacts
WHEN NEW.id IS NOT OLD.id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.source_root IS NOT OLD.source_root
BEGIN SELECT RAISE(ABORT, 'Workspace Artifact identity kind and source root are immutable'); END;
CREATE TRIGGER IF NOT EXISTS artifact_track_identity_update_immutable
BEFORE UPDATE OF id, artifact_id, legacy_variant_id ON artifact_tracks
WHEN NEW.id IS NOT OLD.id
  OR NEW.artifact_id IS NOT OLD.artifact_id
  OR NEW.legacy_variant_id IS NOT OLD.legacy_variant_id
BEGIN SELECT RAISE(ABORT, 'Artifact Track identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS resource_identity_update_immutable
BEFORE UPDATE OF id, workspace_id, kind ON resources
WHEN NEW.id IS NOT OLD.id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.kind IS NOT OLD.kind
BEGIN SELECT RAISE(ABORT, 'Resource identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS workspace_node_identity_update_immutable
BEFORE UPDATE OF id, workspace_id, kind, artifact_id, resource_id ON workspace_nodes
WHEN NEW.id IS NOT OLD.id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.artifact_id IS NOT OLD.artifact_id
  OR NEW.resource_id IS NOT OLD.resource_id
BEGIN SELECT RAISE(ABORT, 'Workspace Node identity is immutable'); END;

CREATE TRIGGER IF NOT EXISTS component_instance_component_kind_insert_ownership
BEFORE INSERT ON component_instances
WHEN NOT EXISTS (
  SELECT 1 FROM workspace_artifacts
  WHERE id = NEW.component_artifact_id
    AND workspace_id = NEW.workspace_id
    AND kind = 'component'
)
BEGIN SELECT RAISE(ABORT, 'component instance component kind ownership violation'); END;
CREATE TRIGGER IF NOT EXISTS component_instance_component_kind_update_ownership
BEFORE UPDATE OF component_artifact_id, workspace_id ON component_instances
WHEN NOT EXISTS (
  SELECT 1 FROM workspace_artifacts
  WHERE id = NEW.component_artifact_id
    AND workspace_id = NEW.workspace_id
    AND kind = 'component'
)
BEGIN SELECT RAISE(ABORT, 'component instance component kind ownership violation'); END;
CREATE TRIGGER IF NOT EXISTS component_instance_identity_update_immutable
BEFORE UPDATE OF id, workspace_id, owner_artifact_id, component_artifact_id ON component_instances
WHEN NEW.id IS NOT OLD.id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.owner_artifact_id IS NOT OLD.owner_artifact_id
  OR NEW.component_artifact_id IS NOT OLD.component_artifact_id
BEGIN SELECT RAISE(ABORT, 'Component Instance identity is immutable'); END;

CREATE TRIGGER IF NOT EXISTS artifact_revision_run_insert_ownership
BEFORE INSERT ON artifact_revisions
WHEN NEW.produced_by_run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM runs run
  JOIN project_workspaces workspace ON workspace.project_id = run.project_id
  WHERE run.id = NEW.produced_by_run_id AND workspace.id = NEW.workspace_id
)
BEGIN SELECT RAISE(ABORT, 'Artifact Revision Run belongs to another Project'); END;
CREATE TRIGGER IF NOT EXISTS resource_revision_run_insert_ownership
BEFORE INSERT ON resource_revisions
WHEN NEW.created_by_run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM runs run
  JOIN project_workspaces workspace ON workspace.project_id = run.project_id
  WHERE run.id = NEW.created_by_run_id AND workspace.id = NEW.workspace_id
)
BEGIN SELECT RAISE(ABORT, 'Resource Revision Run belongs to another Project'); END;
CREATE TRIGGER IF NOT EXISTS workspace_snapshot_run_insert_ownership
BEFORE INSERT ON workspace_snapshots
WHEN NEW.created_by_run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM runs run
  JOIN project_workspaces workspace ON workspace.project_id = run.project_id
  WHERE run.id = NEW.created_by_run_id AND workspace.id = NEW.workspace_id
)
BEGIN SELECT RAISE(ABORT, 'Workspace Snapshot Run belongs to another Project'); END;

CREATE TRIGGER IF NOT EXISTS workspace_node_layout_group_insert_collision
BEFORE INSERT ON workspace_nodes
WHEN EXISTS (
  SELECT 1 FROM workspace_layout_nodes layout
  WHERE layout.workspace_id = NEW.workspace_id
    AND layout.object_id = NEW.id
    AND layout.object_kind = 'group'
)
BEGIN SELECT RAISE(ABORT, 'layout group collides with semantic node identity'); END;
CREATE TRIGGER IF NOT EXISTS workspace_node_layout_group_update_collision
BEFORE UPDATE OF id, workspace_id ON workspace_nodes
WHEN EXISTS (
  SELECT 1 FROM workspace_layout_nodes layout
  WHERE layout.workspace_id = NEW.workspace_id
    AND layout.object_id = NEW.id
    AND layout.object_kind = 'group'
)
BEGIN SELECT RAISE(ABORT, 'layout group collides with semantic node identity'); END;
CREATE TRIGGER IF NOT EXISTS workspace_layout_group_node_insert_collision
BEFORE INSERT ON workspace_layout_nodes
WHEN NEW.object_kind = 'group' AND EXISTS (
  SELECT 1 FROM workspace_nodes node
  WHERE node.workspace_id = NEW.workspace_id AND node.id = NEW.object_id
)
BEGIN SELECT RAISE(ABORT, 'layout group collides with semantic node identity'); END;
CREATE TRIGGER IF NOT EXISTS workspace_layout_group_node_update_collision
BEFORE UPDATE OF workspace_id, object_id, object_kind ON workspace_layout_nodes
WHEN NEW.object_kind = 'group' AND EXISTS (
  SELECT 1 FROM workspace_nodes node
  WHERE node.workspace_id = NEW.workspace_id AND node.id = NEW.object_id
)
BEGIN SELECT RAISE(ABORT, 'layout group collides with semantic node identity'); END;

CREATE TRIGGER IF NOT EXISTS workspace_graph_revision_insert_immutable
BEFORE INSERT ON workspace_graph_revisions
WHEN EXISTS (
  SELECT 1 FROM workspace_graph_revisions existing
  WHERE existing.workspace_id = NEW.workspace_id AND existing.revision = NEW.revision
)
BEGIN SELECT RAISE(ABORT, 'workspace graph revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS workspace_graph_revision_update_immutable
BEFORE UPDATE ON workspace_graph_revisions
BEGIN SELECT RAISE(ABORT, 'workspace graph revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS workspace_graph_revision_delete_immutable
BEFORE DELETE ON workspace_graph_revisions
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace graph revisions are immutable'); END;

CREATE TRIGGER IF NOT EXISTS workspace_graph_command_insert_immutable
BEFORE INSERT ON workspace_graph_commands
WHEN EXISTS (
  SELECT 1 FROM workspace_graph_commands existing
  WHERE existing.workspace_id = NEW.workspace_id AND existing.command_id = NEW.command_id
)
BEGIN SELECT RAISE(ABORT, 'workspace graph commands are immutable'); END;
CREATE TRIGGER IF NOT EXISTS workspace_graph_command_update_immutable
BEFORE UPDATE ON workspace_graph_commands
BEGIN SELECT RAISE(ABORT, 'workspace graph commands are immutable'); END;
CREATE TRIGGER IF NOT EXISTS workspace_graph_command_delete_immutable
BEFORE DELETE ON workspace_graph_commands
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace graph commands are immutable'); END;

CREATE TRIGGER IF NOT EXISTS kernel_revision_insert_immutable
BEFORE INSERT ON shared_design_kernel_revisions
WHEN EXISTS (
  SELECT 1 FROM shared_design_kernel_revisions existing
  WHERE existing.id = NEW.id
     OR (existing.workspace_id = NEW.workspace_id AND existing.sequence = NEW.sequence)
)
BEGIN SELECT RAISE(ABORT, 'Shared Design Kernel Revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS kernel_revision_sequence_insert_guard
BEFORE INSERT ON shared_design_kernel_revisions
WHEN typeof(NEW.sequence) <> 'integer' OR NEW.sequence < 1 OR NEW.sequence > 9007199254740991
BEGIN SELECT RAISE(ABORT, 'Shared Design Kernel Revision sequence must be a positive safe integer'); END;
CREATE TRIGGER IF NOT EXISTS kernel_revision_update_immutable
BEFORE UPDATE ON shared_design_kernel_revisions
BEGIN SELECT RAISE(ABORT, 'Shared Design Kernel Revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS kernel_revision_delete_immutable
BEFORE DELETE ON shared_design_kernel_revisions
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Shared Design Kernel Revisions are immutable'); END;

CREATE TRIGGER IF NOT EXISTS artifact_revision_insert_immutable
BEFORE INSERT ON artifact_revisions
WHEN EXISTS (
  SELECT 1 FROM artifact_revisions existing
  WHERE existing.id = NEW.id
     OR (existing.track_id = NEW.track_id AND existing.sequence = NEW.sequence)
     OR (NEW.legacy_run_id IS NOT NULL
         AND existing.workspace_id = NEW.workspace_id
         AND existing.legacy_run_id = NEW.legacy_run_id)
)
BEGIN SELECT RAISE(ABORT, 'Artifact Revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS artifact_revision_sequence_insert_guard
BEFORE INSERT ON artifact_revisions
WHEN typeof(NEW.sequence) <> 'integer' OR NEW.sequence < 1 OR NEW.sequence > 9007199254740991
BEGIN SELECT RAISE(ABORT, 'Artifact Revision sequence must be a positive safe integer'); END;
CREATE TRIGGER IF NOT EXISTS artifact_revision_update_immutable
BEFORE UPDATE OF
  id, workspace_id, artifact_id, track_id, sequence, parent_revision_id,
  source_commit_hash, source_tree_hash, artifact_root, kernel_revision_id,
  render_spec_json, quality_json, context_pack_hash, produced_by_run_id,
  legacy_run_id, created_at
ON artifact_revisions
BEGIN SELECT RAISE(ABORT, 'Artifact Revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS artifact_revision_seal_transition_guard
BEFORE UPDATE OF sealed ON artifact_revisions
WHEN OLD.sealed <> 0 OR NEW.sealed <> 1
BEGIN SELECT RAISE(ABORT, 'Artifact Revision seal is immutable after construction'); END;
CREATE TRIGGER IF NOT EXISTS artifact_revision_delete_immutable
BEFORE DELETE ON artifact_revisions
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Artifact Revisions are immutable'); END;

CREATE TRIGGER IF NOT EXISTS artifact_revision_dependency_insert_immutable
BEFORE INSERT ON artifact_revision_dependencies
WHEN NOT EXISTS (
    SELECT 1 FROM artifact_revisions parent
    WHERE parent.id = NEW.revision_id
      AND parent.workspace_id = NEW.workspace_id
      AND parent.artifact_id = NEW.owner_artifact_id
      AND parent.sealed = 0
  ) OR NOT EXISTS (
    SELECT 1 FROM artifact_revisions component
    WHERE component.id = NEW.component_revision_id
      AND component.workspace_id = NEW.workspace_id
      AND component.artifact_id = NEW.component_artifact_id
      AND component.sealed = 1
  )
BEGIN SELECT RAISE(ABORT, 'Artifact Revision is sealed; dependencies are immutable'); END;
CREATE TRIGGER IF NOT EXISTS artifact_revision_dependency_update_immutable
BEFORE UPDATE ON artifact_revision_dependencies
BEGIN SELECT RAISE(ABORT, 'Artifact Revision dependencies are immutable'); END;
CREATE TRIGGER IF NOT EXISTS artifact_revision_dependency_delete_immutable
BEFORE DELETE ON artifact_revision_dependencies
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Artifact Revision dependencies are immutable'); END;

CREATE TRIGGER IF NOT EXISTS artifact_revision_resource_insert_immutable
BEFORE INSERT ON artifact_revision_resources
WHEN NOT EXISTS (
  SELECT 1 FROM artifact_revisions parent
  WHERE parent.id = NEW.revision_id
    AND parent.workspace_id = NEW.workspace_id
    AND parent.artifact_id = NEW.owner_artifact_id
    AND parent.sealed = 0
)
BEGIN SELECT RAISE(ABORT, 'Artifact Revision is sealed; Resource pins are immutable'); END;
CREATE TRIGGER IF NOT EXISTS artifact_revision_resource_update_immutable
BEFORE UPDATE ON artifact_revision_resources
BEGIN SELECT RAISE(ABORT, 'Artifact Revision Resource pins are immutable'); END;
CREATE TRIGGER IF NOT EXISTS artifact_revision_resource_delete_immutable
BEFORE DELETE ON artifact_revision_resources
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Artifact Revision Resource pins are immutable'); END;

CREATE TRIGGER IF NOT EXISTS resource_revision_insert_immutable
BEFORE INSERT ON resource_revisions
WHEN EXISTS (
  SELECT 1 FROM resource_revisions existing
  WHERE existing.id = NEW.id
     OR (existing.resource_id = NEW.resource_id AND existing.sequence = NEW.sequence)
)
BEGIN SELECT RAISE(ABORT, 'Resource Revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS resource_revision_sequence_insert_guard
BEFORE INSERT ON resource_revisions
WHEN typeof(NEW.sequence) <> 'integer' OR NEW.sequence < 1 OR NEW.sequence > 9007199254740991
BEGIN SELECT RAISE(ABORT, 'Resource Revision sequence must be a positive safe integer'); END;
CREATE TRIGGER IF NOT EXISTS resource_revision_update_immutable
BEFORE UPDATE ON resource_revisions
BEGIN SELECT RAISE(ABORT, 'Resource Revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS resource_revision_delete_immutable
BEFORE DELETE ON resource_revisions
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Resource Revisions are immutable'); END;

CREATE TRIGGER IF NOT EXISTS workspace_snapshot_insert_immutable
BEFORE INSERT ON workspace_snapshots
WHEN EXISTS (
  SELECT 1 FROM workspace_snapshots existing
  WHERE existing.id = NEW.id
     OR (existing.workspace_id = NEW.workspace_id AND existing.sequence = NEW.sequence)
)
BEGIN SELECT RAISE(ABORT, 'Workspace Snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS snapshot_sequence_insert_guard
BEFORE INSERT ON workspace_snapshots
WHEN typeof(NEW.sequence) <> 'integer' OR NEW.sequence < 1 OR NEW.sequence > 9007199254740991
BEGIN SELECT RAISE(ABORT, 'Workspace Snapshot sequence must be a positive safe integer'); END;
CREATE TRIGGER IF NOT EXISTS workspace_snapshot_update_immutable
BEFORE UPDATE OF
  id, workspace_id, sequence, parent_snapshot_id, graph_revision,
  kernel_revision_id, reason, provenance_json, created_by_run_id, created_at
ON workspace_snapshots
BEGIN SELECT RAISE(ABORT, 'Workspace Snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS workspace_snapshot_seal_transition_guard
BEFORE UPDATE OF sealed ON workspace_snapshots
WHEN OLD.sealed <> 0 OR NEW.sealed <> 1
BEGIN SELECT RAISE(ABORT, 'Workspace Snapshot seal is immutable after construction'); END;
CREATE TRIGGER IF NOT EXISTS workspace_snapshot_delete_immutable
BEFORE DELETE ON workspace_snapshots
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Workspace Snapshots are immutable'); END;

CREATE TRIGGER IF NOT EXISTS workspace_snapshot_artifact_insert_immutable
BEFORE INSERT ON workspace_snapshot_artifacts
WHEN NOT EXISTS (
    SELECT 1 FROM workspace_snapshots parent
    WHERE parent.id = NEW.snapshot_id
      AND parent.workspace_id = NEW.workspace_id
      AND parent.sealed = 0
  ) OR (NEW.revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM artifact_revisions revision
    WHERE revision.id = NEW.revision_id
      AND revision.workspace_id = NEW.workspace_id
      AND revision.artifact_id = NEW.artifact_id
      AND revision.track_id = NEW.track_id
      AND revision.sealed = 1
  ))
BEGIN SELECT RAISE(ABORT, 'Workspace Snapshot is sealed; Artifact mappings are immutable'); END;
CREATE TRIGGER IF NOT EXISTS workspace_snapshot_artifact_update_immutable
BEFORE UPDATE ON workspace_snapshot_artifacts
BEGIN SELECT RAISE(ABORT, 'Workspace Snapshot Artifact mappings are immutable'); END;
CREATE TRIGGER IF NOT EXISTS workspace_snapshot_artifact_delete_immutable
BEFORE DELETE ON workspace_snapshot_artifacts
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Workspace Snapshot Artifact mappings are immutable'); END;

CREATE TRIGGER IF NOT EXISTS workspace_snapshot_resource_insert_immutable
BEFORE INSERT ON workspace_snapshot_resources
WHEN NOT EXISTS (
  SELECT 1 FROM workspace_snapshots parent
  WHERE parent.id = NEW.snapshot_id
    AND parent.workspace_id = NEW.workspace_id
    AND parent.sealed = 0
)
BEGIN SELECT RAISE(ABORT, 'Workspace Snapshot is sealed; Resource mappings are immutable'); END;
CREATE TRIGGER IF NOT EXISTS workspace_snapshot_resource_update_immutable
BEFORE UPDATE ON workspace_snapshot_resources
BEGIN SELECT RAISE(ABORT, 'Workspace Snapshot Resource mappings are immutable'); END;
CREATE TRIGGER IF NOT EXISTS workspace_snapshot_resource_delete_immutable
BEFORE DELETE ON workspace_snapshot_resources
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Workspace Snapshot Resource mappings are immutable'); END;

CREATE TRIGGER IF NOT EXISTS workspace_artifact_delete_history_guard
BEFORE DELETE ON workspace_artifacts
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Workspace Artifacts must be archived; history cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS workspace_artifact_insert_history_guard
BEFORE INSERT ON workspace_artifacts
WHEN EXISTS (SELECT 1 FROM workspace_artifacts existing WHERE existing.id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'Workspace Artifact identity is immutable and cannot be replaced'); END;
CREATE TRIGGER IF NOT EXISTS artifact_track_delete_history_guard
BEFORE DELETE ON artifact_tracks
WHEN EXISTS (
  SELECT 1 FROM workspace_artifacts artifact
  JOIN project_workspaces workspace ON workspace.id = artifact.workspace_id
  WHERE artifact.id = OLD.artifact_id
)
BEGIN SELECT RAISE(ABORT, 'Artifact Tracks are history and cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS artifact_track_insert_history_guard
BEFORE INSERT ON artifact_tracks
WHEN EXISTS (
  SELECT 1 FROM artifact_tracks existing
  WHERE existing.id = NEW.id
     OR (NEW.legacy_variant_id IS NOT NULL
         AND existing.artifact_id = NEW.artifact_id
         AND existing.legacy_variant_id = NEW.legacy_variant_id)
)
BEGIN SELECT RAISE(ABORT, 'Artifact Track identity is immutable and cannot be replaced'); END;
CREATE TRIGGER IF NOT EXISTS resource_delete_history_guard
BEFORE DELETE ON resources
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Resources must be archived; history cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS resource_insert_history_guard
BEFORE INSERT ON resources
WHEN EXISTS (SELECT 1 FROM resources existing WHERE existing.id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'Resource identity is immutable and cannot be replaced'); END;
CREATE TRIGGER IF NOT EXISTS component_instance_delete_history_guard
BEFORE DELETE ON component_instances
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Component Instances are history and cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS component_instance_insert_history_guard
BEFORE INSERT ON component_instances
WHEN EXISTS (SELECT 1 FROM component_instances existing WHERE existing.id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'Component Instance identity is immutable and cannot be replaced'); END;
CREATE TRIGGER IF NOT EXISTS workspace_node_delete_history_guard
BEFORE DELETE ON workspace_nodes
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Workspace Nodes must be archived; graph identity cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS workspace_node_insert_history_guard
BEFORE INSERT ON workspace_nodes
WHEN EXISTS (
  SELECT 1 FROM workspace_nodes existing
  WHERE existing.id = NEW.id
     OR (NEW.artifact_id IS NOT NULL
         AND existing.workspace_id = NEW.workspace_id
         AND existing.artifact_id = NEW.artifact_id)
     OR (NEW.resource_id IS NOT NULL
         AND existing.workspace_id = NEW.workspace_id
         AND existing.resource_id = NEW.resource_id)
)
BEGIN SELECT RAISE(ABORT, 'Workspace Node identity is immutable and cannot be replaced'); END;

CREATE TRIGGER IF NOT EXISTS context_pack_insert_immutable
BEFORE INSERT ON context_packs
WHEN EXISTS (
  SELECT 1 FROM context_packs existing
  WHERE existing.id = NEW.id
     OR (existing.workspace_id = NEW.workspace_id AND existing.hash = NEW.hash)
)
BEGIN SELECT RAISE(ABORT, 'Context Pack identity and Workspace hash are immutable'); END;
CREATE TRIGGER IF NOT EXISTS context_pack_scope_insert_ownership
BEFORE INSERT ON context_packs
WHEN NOT (
  (NEW.scope_type = 'workspace' AND NEW.scope_id = NEW.workspace_id)
  OR (NEW.scope_type = 'artifact' AND EXISTS (
    SELECT 1 FROM workspace_artifacts artifact
    WHERE artifact.id = NEW.scope_id
      AND artifact.workspace_id = NEW.workspace_id
      AND artifact.archived_at IS NULL
  ))
  OR (NEW.scope_type = 'resource' AND EXISTS (
    SELECT 1 FROM resources resource
    WHERE resource.id = NEW.scope_id
      AND resource.workspace_id = NEW.workspace_id
      AND resource.archived_at IS NULL
  ))
)
BEGIN SELECT RAISE(ABORT, 'Context Pack target belongs to another Workspace or is archived'); END;
CREATE TRIGGER IF NOT EXISTS context_pack_update_immutable
BEFORE UPDATE OF
  id, workspace_id, scope_type, scope_id, graph_revision, manifest_path,
  token_estimate, omissions_json, hash, created_at
ON context_packs
BEGIN SELECT RAISE(ABORT, 'Context Packs are immutable'); END;
CREATE TRIGGER IF NOT EXISTS context_pack_seal_transition_guard
BEFORE UPDATE OF sealed ON context_packs
WHEN OLD.sealed <> 0 OR NEW.sealed <> 1
BEGIN SELECT RAISE(ABORT, 'Context Pack seal is immutable after construction'); END;
CREATE TRIGGER IF NOT EXISTS context_pack_delete_immutable
BEFORE DELETE ON context_packs
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Context Packs are immutable'); END;

CREATE TRIGGER IF NOT EXISTS context_pack_item_insert_guard
BEFORE INSERT ON context_pack_items
WHEN NOT EXISTS (
  SELECT 1 FROM context_packs pack
  WHERE pack.id = NEW.context_pack_id
    AND pack.workspace_id = NEW.workspace_id
    AND pack.sealed = 0
) OR EXISTS (
  SELECT 1 FROM context_pack_items existing
  WHERE existing.context_pack_id = NEW.context_pack_id
    AND existing.ordinal = NEW.ordinal
)
BEGIN SELECT RAISE(ABORT, 'Context Pack is sealed; items are immutable'); END;
CREATE TRIGGER IF NOT EXISTS context_pack_item_published_pin_guard
BEFORE INSERT ON context_pack_items
WHEN (
  NEW.resolved_kind = 'artifact-revision' AND NOT EXISTS (
    SELECT 1 FROM workspace_snapshot_artifacts mapping
    JOIN workspace_snapshots snapshot
      ON snapshot.id = mapping.snapshot_id AND snapshot.workspace_id = mapping.workspace_id
    WHERE mapping.revision_id = NEW.artifact_revision_id
      AND mapping.workspace_id = NEW.workspace_id AND snapshot.sealed = 1
  )
) OR (
  NEW.resolved_kind = 'resource-revision' AND NOT EXISTS (
    SELECT 1 FROM workspace_snapshot_resources mapping
    JOIN workspace_snapshots snapshot
      ON snapshot.id = mapping.snapshot_id AND snapshot.workspace_id = mapping.workspace_id
    WHERE mapping.revision_id = NEW.resource_revision_id
      AND mapping.workspace_id = NEW.workspace_id AND snapshot.sealed = 1
  )
) OR (
  NEW.resolved_kind = 'kernel-revision' AND NOT EXISTS (
    SELECT 1 FROM workspace_snapshots snapshot
    WHERE snapshot.kernel_revision_id = NEW.kernel_revision_id
      AND snapshot.workspace_id = NEW.workspace_id AND snapshot.sealed = 1
  )
)
BEGIN SELECT RAISE(ABORT, 'Context Pack item Revision ownership violation: pin must be published in the same Workspace'); END;
CREATE TRIGGER IF NOT EXISTS context_pack_item_update_immutable
BEFORE UPDATE ON context_pack_items
BEGIN SELECT RAISE(ABORT, 'Context Pack items are immutable'); END;
CREATE TRIGGER IF NOT EXISTS context_pack_item_delete_immutable
BEFORE DELETE ON context_pack_items
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Context Pack items are immutable'); END;

CREATE TRIGGER IF NOT EXISTS context_pack_usage_insert_guard
BEFORE INSERT ON context_pack_item_usage
WHEN NOT EXISTS (
  SELECT 1 FROM context_pack_items item
  JOIN context_packs pack
    ON pack.id = item.context_pack_id AND pack.workspace_id = item.workspace_id
  WHERE item.context_pack_id = NEW.context_pack_id
    AND item.workspace_id = NEW.workspace_id
    AND item.ordinal = NEW.ordinal
    AND item.provided = 1
    AND pack.sealed = 1
) OR EXISTS (
  SELECT 1 FROM context_pack_item_usage existing
  WHERE existing.context_pack_id = NEW.context_pack_id
    AND existing.ordinal = NEW.ordinal
    AND existing.sequence = NEW.sequence
) OR typeof(NEW.sequence) <> 'integer'
  OR NEW.sequence < 1
  OR NEW.sequence > 9007199254740991
  OR NEW.sequence <> COALESCE((
    SELECT MAX(existing.sequence) + 1
    FROM context_pack_item_usage existing
    WHERE existing.context_pack_id = NEW.context_pack_id
      AND existing.ordinal = NEW.ordinal
  ), 1)
BEGIN SELECT RAISE(ABORT, 'Context Pack usage evidence is append-only, contiguous, and requires a sealed provided item'); END;
CREATE TRIGGER IF NOT EXISTS context_pack_usage_run_ownership
BEFORE INSERT ON context_pack_item_usage
WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM runs run
  JOIN context_packs pack
    ON pack.id = NEW.context_pack_id AND pack.workspace_id = NEW.workspace_id
  JOIN project_workspaces workspace
    ON workspace.id = pack.workspace_id AND workspace.project_id = run.project_id
  WHERE run.id = NEW.run_id
    AND run.context_pack_id = pack.id
    AND run.context_pack_hash = pack.hash
)
BEGIN SELECT RAISE(ABORT, 'Context Pack usage Run is not bound to the exact Context Pack'); END;
CREATE TRIGGER IF NOT EXISTS context_pack_usage_update_immutable
BEFORE UPDATE ON context_pack_item_usage
BEGIN SELECT RAISE(ABORT, 'Context Pack usage evidence is append-only'); END;
CREATE TRIGGER IF NOT EXISTS context_pack_usage_delete_immutable
BEFORE DELETE ON context_pack_item_usage
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Context Pack usage evidence is append-only'); END;

CREATE TRIGGER IF NOT EXISTS project_workspace_identity_update_immutable
BEFORE UPDATE OF id, project_id ON project_workspaces
WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id
BEGIN SELECT RAISE(ABORT, 'Project Workspace identity and owning Project are immutable'); END;
CREATE TRIGGER IF NOT EXISTS run_project_update_immutable
BEFORE UPDATE OF project_id ON runs
WHEN NEW.project_id IS NOT OLD.project_id
BEGIN SELECT RAISE(ABORT, 'Run owning Project is immutable'); END;

CREATE TRIGGER IF NOT EXISTS project_workspace_insert_guard
BEFORE INSERT ON project_workspaces
WHEN EXISTS (
  SELECT 1 FROM project_workspaces existing
  WHERE existing.id = NEW.id OR existing.project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'cannot replace workspace while Project exists'); END;
CREATE TRIGGER IF NOT EXISTS project_workspace_delete_guard
BEFORE DELETE ON project_workspaces
WHEN EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)
BEGIN SELECT RAISE(ABORT, 'cannot delete workspace while owning project exists'); END;
`;

const TASK4_OWNERSHIP_TRIGGER_UPGRADE_SCHEMA = `
DROP TRIGGER IF EXISTS workspace_active_state_transition_guard;
DROP TRIGGER IF EXISTS workspace_active_snapshot_insert_ownership;
DROP TRIGGER IF EXISTS workspace_active_snapshot_update_ownership;
DROP TRIGGER IF EXISTS track_head_insert_ownership;
DROP TRIGGER IF EXISTS track_head_update_ownership;
DROP TRIGGER IF EXISTS kernel_parent_insert_ownership;
DROP TRIGGER IF EXISTS kernel_parent_update_ownership;
DROP TRIGGER IF EXISTS artifact_revision_parent_insert_ownership;
DROP TRIGGER IF EXISTS artifact_revision_parent_update_ownership;
DROP TRIGGER IF EXISTS snapshot_parent_insert_ownership;
DROP TRIGGER IF EXISTS snapshot_parent_update_ownership;

${WORKSPACE_ACTIVE_STATE_TRANSITION_TRIGGER_SCHEMA}
CREATE TRIGGER workspace_active_snapshot_insert_ownership
BEFORE INSERT ON project_workspaces
WHEN NEW.active_snapshot_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_snapshots
  WHERE id = NEW.active_snapshot_id AND workspace_id = NEW.id AND sealed = 1
)
BEGIN SELECT RAISE(ABORT, 'workspace active snapshot ownership violation'); END;
CREATE TRIGGER workspace_active_snapshot_update_ownership
BEFORE UPDATE OF active_snapshot_id, id ON project_workspaces
WHEN NEW.active_snapshot_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_snapshots
  WHERE id = NEW.active_snapshot_id AND workspace_id = NEW.id AND sealed = 1
)
BEGIN SELECT RAISE(ABORT, 'workspace active snapshot ownership violation'); END;
CREATE TRIGGER track_head_insert_ownership
BEFORE INSERT ON artifact_tracks
WHEN NEW.head_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM artifact_revisions
  WHERE id = NEW.head_revision_id AND artifact_id = NEW.artifact_id AND track_id = NEW.id AND sealed = 1
)
BEGIN SELECT RAISE(ABORT, 'track head ownership violation'); END;
CREATE TRIGGER track_head_update_ownership
BEFORE UPDATE OF head_revision_id, id, artifact_id ON artifact_tracks
WHEN NEW.head_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM artifact_revisions
  WHERE id = NEW.head_revision_id AND artifact_id = NEW.artifact_id AND track_id = NEW.id AND sealed = 1
)
BEGIN SELECT RAISE(ABORT, 'track head ownership violation'); END;
CREATE TRIGGER kernel_parent_insert_ownership
BEFORE INSERT ON shared_design_kernel_revisions
WHEN NEW.parent_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM shared_design_kernel_revisions
  WHERE id = NEW.parent_revision_id
    AND workspace_id = NEW.workspace_id
    AND sequence < NEW.sequence
)
BEGIN SELECT RAISE(ABORT, 'kernel parent ownership violation'); END;
CREATE TRIGGER kernel_parent_update_ownership
BEFORE UPDATE OF parent_revision_id, workspace_id ON shared_design_kernel_revisions
WHEN NEW.parent_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM shared_design_kernel_revisions
  WHERE id = NEW.parent_revision_id
    AND workspace_id = NEW.workspace_id
    AND sequence < NEW.sequence
)
BEGIN SELECT RAISE(ABORT, 'kernel parent ownership violation'); END;
CREATE TRIGGER artifact_revision_parent_insert_ownership
BEFORE INSERT ON artifact_revisions
WHEN NEW.parent_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM artifact_revisions
  WHERE id = NEW.parent_revision_id
    AND workspace_id = NEW.workspace_id
    AND artifact_id = NEW.artifact_id
    AND track_id = NEW.track_id
    AND sealed = 1
    AND sequence < NEW.sequence
)
BEGIN SELECT RAISE(ABORT, 'artifact revision parent ownership violation'); END;
CREATE TRIGGER artifact_revision_parent_update_ownership
BEFORE UPDATE OF parent_revision_id, workspace_id, artifact_id, track_id ON artifact_revisions
WHEN NEW.parent_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM artifact_revisions
  WHERE id = NEW.parent_revision_id
    AND workspace_id = NEW.workspace_id
    AND artifact_id = NEW.artifact_id
    AND track_id = NEW.track_id
    AND sealed = 1
    AND sequence < NEW.sequence
)
BEGIN SELECT RAISE(ABORT, 'artifact revision parent ownership violation'); END;
CREATE TRIGGER snapshot_parent_insert_ownership
BEFORE INSERT ON workspace_snapshots
WHEN NEW.parent_snapshot_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_snapshots
  WHERE id = NEW.parent_snapshot_id
    AND workspace_id = NEW.workspace_id
    AND sealed = 1
    AND sequence < NEW.sequence
)
BEGIN SELECT RAISE(ABORT, 'snapshot parent ownership violation'); END;
CREATE TRIGGER snapshot_parent_update_ownership
BEFORE UPDATE OF parent_snapshot_id, workspace_id ON workspace_snapshots
WHEN NEW.parent_snapshot_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_snapshots
  WHERE id = NEW.parent_snapshot_id
    AND workspace_id = NEW.workspace_id
    AND sealed = 1
    AND sequence < NEW.sequence
)
BEGIN SELECT RAISE(ABORT, 'snapshot parent ownership violation'); END;
`;

const TASK5_LEGACY_WRAPPER_TRIGGER_UPGRADE_SCHEMA = `
DROP TRIGGER IF EXISTS workspace_artifact_identity_update_immutable;
DROP TRIGGER IF EXISTS workspace_artifact_legacy_wrapper_insert_guard;
DROP TRIGGER IF EXISTS project_mode_legacy_workspace_guard;

CREATE TRIGGER workspace_artifact_identity_update_immutable
BEFORE UPDATE OF id, workspace_id, kind, source_root, legacy_wrapped ON workspace_artifacts
WHEN NEW.id IS NOT OLD.id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.source_root IS NOT OLD.source_root
  OR NEW.legacy_wrapped IS NOT OLD.legacy_wrapped
BEGIN SELECT RAISE(ABORT, 'Workspace Artifact identity kind source root and legacy marker are immutable'); END;

CREATE TRIGGER workspace_artifact_legacy_wrapper_insert_guard
BEFORE INSERT ON workspace_artifacts
WHEN (
  (NEW.legacy_wrapped = 1 AND (
    NEW.kind IS NOT 'page'
    OR NEW.source_root IS NOT '.'
    OR EXISTS (
      SELECT 1 FROM workspace_artifacts existing
      WHERE existing.workspace_id = NEW.workspace_id AND existing.legacy_wrapped = 1
    )
    OR NOT EXISTS (
      SELECT 1
      FROM project_workspaces workspace
      JOIN projects project ON project.id = workspace.project_id
      WHERE workspace.id = NEW.workspace_id AND project.mode = 'standard'
    )
  ))
  OR (NEW.legacy_wrapped = 0 AND NEW.source_root IS '.')
)
BEGIN SELECT RAISE(ABORT, 'legacy-wrapped Artifacts must be Standard Page roots at dot'); END;

CREATE TRIGGER project_mode_legacy_workspace_guard
BEFORE UPDATE OF mode ON projects
WHEN NEW.mode IS NOT 'standard' AND EXISTS (
  SELECT 1
  FROM project_workspaces workspace
  JOIN workspace_artifacts artifact ON artifact.workspace_id = workspace.id
  WHERE workspace.project_id = NEW.id AND artifact.legacy_wrapped = 1
)
BEGIN SELECT RAISE(ABORT, 'a legacy-wrapped Workspace must remain Standard'); END;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_artifacts_one_legacy_wrapper
  ON workspace_artifacts(workspace_id) WHERE legacy_wrapped = 1;
`;

const TASK11_CONTEXT_TRIGGER_UPGRADE_SCHEMA = `
DROP TRIGGER IF EXISTS resource_revision_parent_insert_guard;
DROP TRIGGER IF EXISTS conversation_scope_insert_ownership;
DROP TRIGGER IF EXISTS conversation_scope_legacy_backfill;
DROP TRIGGER IF EXISTS conversation_scope_update_immutable;
DROP TRIGGER IF EXISTS conversation_scope_update_ownership;
DROP TRIGGER IF EXISTS context_pack_scope_insert_ownership;
DROP TRIGGER IF EXISTS context_pack_insert_immutable;
DROP TRIGGER IF EXISTS context_pack_update_immutable;
DROP TRIGGER IF EXISTS context_pack_usage_insert_guard;
DROP TRIGGER IF EXISTS context_pack_usage_run_ownership;
DROP TRIGGER IF EXISTS run_context_pack_insert_immutable;
DROP TRIGGER IF EXISTS run_context_pack_insert_ownership;
DROP TRIGGER IF EXISTS run_context_pack_update_ownership;

CREATE TRIGGER resource_revision_parent_insert_guard
BEFORE INSERT ON resource_revisions
WHEN NEW.parent_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM resource_revisions parent
  WHERE parent.id = NEW.parent_revision_id
    AND parent.resource_id = NEW.resource_id
    AND parent.workspace_id = NEW.workspace_id
    AND parent.sequence < NEW.sequence
)
BEGIN SELECT RAISE(ABORT, 'Resource Revision parent ownership or order violation'); END;

CREATE TRIGGER conversation_scope_insert_ownership
BEFORE INSERT ON conversations
WHEN NEW.scope_type IS NOT NULL AND (
  NEW.scope_id IS NULL OR NOT (
    (NEW.scope_type = 'workspace' AND NEW.scope_id = NEW.project_id)
    OR (NEW.scope_type = 'artifact' AND EXISTS (
      SELECT 1 FROM project_workspaces workspace
      JOIN workspace_artifacts artifact ON artifact.workspace_id = workspace.id
      WHERE workspace.project_id = NEW.project_id AND artifact.id = NEW.scope_id
    ))
    OR (NEW.scope_type = 'resource' AND EXISTS (
      SELECT 1 FROM project_workspaces workspace
      JOIN resources resource ON resource.workspace_id = workspace.id
      WHERE workspace.project_id = NEW.project_id AND resource.id = NEW.scope_id
    ))
  )
)
BEGIN SELECT RAISE(ABORT, 'Conversation scope belongs to another Project'); END;
CREATE TRIGGER conversation_scope_legacy_backfill
AFTER INSERT ON conversations
WHEN NEW.scope_type IS NULL OR NEW.scope_id IS NULL
BEGIN
  UPDATE conversations
  SET scope_type = 'workspace', scope_id = NEW.project_id
  WHERE id = NEW.id AND (scope_type IS NULL OR scope_id IS NULL);
END;
CREATE TRIGGER conversation_scope_update_immutable
BEFORE UPDATE OF project_id, scope_type, scope_id ON conversations
WHEN OLD.scope_type IS NOT NULL AND OLD.scope_id IS NOT NULL AND (
  NEW.project_id IS NOT OLD.project_id
  OR NEW.scope_type IS NOT OLD.scope_type
  OR NEW.scope_id IS NOT OLD.scope_id
)
BEGIN SELECT RAISE(ABORT, 'Conversation scope is immutable'); END;
CREATE TRIGGER conversation_scope_update_ownership
BEFORE UPDATE OF project_id, scope_type, scope_id ON conversations
WHEN NEW.scope_type IS NULL OR NEW.scope_id IS NULL OR NOT (
  (NEW.scope_type = 'workspace' AND NEW.scope_id = NEW.project_id)
  OR (NEW.scope_type = 'artifact' AND EXISTS (
    SELECT 1 FROM project_workspaces workspace
    JOIN workspace_artifacts artifact ON artifact.workspace_id = workspace.id
    WHERE workspace.project_id = NEW.project_id AND artifact.id = NEW.scope_id
  ))
  OR (NEW.scope_type = 'resource' AND EXISTS (
    SELECT 1 FROM project_workspaces workspace
    JOIN resources resource ON resource.workspace_id = workspace.id
    WHERE workspace.project_id = NEW.project_id AND resource.id = NEW.scope_id
  ))
)
BEGIN SELECT RAISE(ABORT, 'Conversation scope belongs to another Project'); END;

CREATE TRIGGER context_pack_insert_immutable
BEFORE INSERT ON context_packs
WHEN EXISTS (
  SELECT 1 FROM context_packs existing
  WHERE existing.id = NEW.id
     OR (existing.workspace_id = NEW.workspace_id AND existing.hash = NEW.hash)
)
BEGIN SELECT RAISE(ABORT, 'Context Pack identity and Workspace hash are immutable'); END;
CREATE TRIGGER context_pack_scope_insert_ownership
BEFORE INSERT ON context_packs
WHEN NOT (
  (NEW.scope_type = 'workspace' AND NEW.scope_id = NEW.workspace_id)
  OR (NEW.scope_type = 'artifact' AND EXISTS (
    SELECT 1 FROM workspace_artifacts artifact
    WHERE artifact.id = NEW.scope_id
      AND artifact.workspace_id = NEW.workspace_id
      AND artifact.archived_at IS NULL
  ))
  OR (NEW.scope_type = 'resource' AND EXISTS (
    SELECT 1 FROM resources resource
    WHERE resource.id = NEW.scope_id
      AND resource.workspace_id = NEW.workspace_id
      AND resource.archived_at IS NULL
  ))
)
BEGIN SELECT RAISE(ABORT, 'Context Pack target belongs to another Workspace or is archived'); END;
CREATE TRIGGER context_pack_update_immutable
BEFORE UPDATE OF
  id, workspace_id, scope_type, scope_id, graph_revision, intent, message_checksum,
  manifest_path, token_estimate, omissions_json, hash, created_at
ON context_packs
BEGIN SELECT RAISE(ABORT, 'Context Packs are immutable'); END;

CREATE TRIGGER context_pack_usage_insert_guard
BEFORE INSERT ON context_pack_item_usage
WHEN NOT EXISTS (
  SELECT 1 FROM context_pack_items item
  JOIN context_packs pack
    ON pack.id = item.context_pack_id AND pack.workspace_id = item.workspace_id
  WHERE item.context_pack_id = NEW.context_pack_id
    AND item.workspace_id = NEW.workspace_id
    AND item.ordinal = NEW.ordinal
    AND item.provided = 1
    AND pack.sealed = 1
) OR EXISTS (
  SELECT 1 FROM context_pack_item_usage existing
  WHERE existing.context_pack_id = NEW.context_pack_id
    AND existing.ordinal = NEW.ordinal
    AND existing.sequence = NEW.sequence
) OR typeof(NEW.sequence) <> 'integer'
  OR NEW.sequence < 1
  OR NEW.sequence > 9007199254740991
  OR NEW.sequence <> COALESCE((
    SELECT MAX(existing.sequence) + 1
    FROM context_pack_item_usage existing
    WHERE existing.context_pack_id = NEW.context_pack_id
      AND existing.ordinal = NEW.ordinal
  ), 1)
BEGIN SELECT RAISE(ABORT, 'Context Pack usage evidence is append-only, contiguous, and requires a sealed provided item'); END;

CREATE TRIGGER context_pack_usage_run_ownership
BEFORE INSERT ON context_pack_item_usage
WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM runs run
  JOIN context_packs pack
    ON pack.id = NEW.context_pack_id AND pack.workspace_id = NEW.workspace_id
  JOIN project_workspaces workspace
    ON workspace.id = pack.workspace_id AND workspace.project_id = run.project_id
  WHERE run.id = NEW.run_id
    AND run.context_pack_id = pack.id
    AND run.context_pack_hash = pack.hash
)
BEGIN SELECT RAISE(ABORT, 'Context Pack usage Run is not bound to the exact Context Pack'); END;

CREATE TRIGGER run_context_pack_insert_ownership
BEFORE INSERT ON runs
WHEN (NEW.context_pack_id IS NULL) <> (NEW.context_pack_hash IS NULL)
  OR (NEW.context_pack_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM context_packs pack
    JOIN project_workspaces workspace ON workspace.id = pack.workspace_id
    WHERE pack.id = NEW.context_pack_id
      AND pack.hash = NEW.context_pack_hash
      AND workspace.project_id = NEW.project_id
      AND pack.sealed = 1
  ))
BEGIN SELECT RAISE(ABORT, 'Run Context Pack ownership or hash violation'); END;
CREATE TRIGGER run_context_pack_insert_immutable
BEFORE INSERT ON runs
WHEN EXISTS (
  SELECT 1 FROM runs existing
  WHERE existing.id = NEW.id AND (
    NEW.project_id IS NOT existing.project_id
    OR NEW.context_pack_id IS NOT existing.context_pack_id
    OR NEW.context_pack_hash IS NOT existing.context_pack_hash
  )
)
BEGIN SELECT RAISE(ABORT, 'Run Context Pack binding is immutable'); END;
CREATE TRIGGER run_context_pack_update_ownership
BEFORE UPDATE OF project_id, context_pack_id, context_pack_hash ON runs
WHEN NEW.project_id IS NOT OLD.project_id
  OR NEW.context_pack_id IS NOT OLD.context_pack_id
  OR NEW.context_pack_hash IS NOT OLD.context_pack_hash
BEGIN SELECT RAISE(ABORT, 'Run Context Pack binding is immutable'); END;
`;

/** Additive migrations for databases created before a column existed. */
export function migrateStoreSchema(db: DatabaseSync): void {
  // Replay installs current triggers before additive columns are restored.
  // Drop cleanup guards that read Attempt columns so legacy-table ALTERs can
  // run, then reinstall the complete trigger set after all columns exist.
  db.exec(`
    DROP TRIGGER IF EXISTS generation_resource_payload_staging_insert_guard;
    DROP TRIGGER IF EXISTS generation_resource_payload_staging_identity_update_immutable;
    DROP TRIGGER IF EXISTS generation_resource_payload_staging_transition_guard;
    DROP TRIGGER IF EXISTS generation_resource_payload_staging_delete_history_guard;
    DROP TRIGGER IF EXISTS resource_payload_cleanup_insert_guard;
    DROP TRIGGER IF EXISTS resource_payload_cleanup_identity_update_immutable;
    DROP TRIGGER IF EXISTS resource_payload_cleanup_completion_guard;
    DROP TRIGGER IF EXISTS resource_revision_cleanup_tombstone_insert_guard;
    DROP TRIGGER IF EXISTS generation_resource_payload_cleanup_insert_guard;
    DROP TRIGGER IF EXISTS generation_resource_payload_cleanup_identity_update_immutable;
    DROP TRIGGER IF EXISTS generation_resource_payload_cleanup_completion_guard;
    DROP TRIGGER IF EXISTS generation_resource_revision_cleanup_tombstone_insert_guard;
  `);
  const ensureColumn = (table: string, column: string, decl: string): boolean => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${decl}`);
      return true;
    }
    return false;
  };
  ensureColumn("runs", "score", "score INTEGER");
  ensureColumn("runs", "final_findings", "final_findings TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("projects", "mode", "mode TEXT");
  ensureColumn("projects", "sharingan", "sharingan INTEGER NOT NULL DEFAULT 0");
  ensureColumn("projects", "source_url", "source_url TEXT");
  ensureColumn("settings", "image_api_base_url", "image_api_base_url TEXT");
  ensureColumn("settings", "image_api_key", "image_api_key TEXT");
  ensureColumn("settings", "image_model", "image_model TEXT");
  ensureColumn("settings", "remove_background_model", "remove_background_model TEXT");
  ensureColumn("settings", "edit_region_model", "edit_region_model TEXT");
  ensureColumn("settings", "extract_layer_model", "extract_layer_model TEXT");
  ensureColumn("settings", "video_api_base_url", "video_api_base_url TEXT");
  ensureColumn("settings", "video_api_key", "video_api_key TEXT");
  ensureColumn("settings", "video_model", "video_model TEXT");
  ensureColumn("settings", "ai_provider_id", "ai_provider_id TEXT");
  ensureColumn("settings", "ai_provider_enabled", "ai_provider_enabled INTEGER NOT NULL DEFAULT 0");
  ensureColumn("settings", "ai_provider_models", "ai_provider_models TEXT");
  ensureColumn("settings", "ai_provider_organization", "ai_provider_organization TEXT");
  ensureColumn("settings", "ai_provider_profiles", "ai_provider_profiles TEXT");
  ensureColumn("settings", "visual_qa_enabled", "visual_qa_enabled INTEGER NOT NULL DEFAULT 0");
  ensureColumn("settings", "auto_fix_live_runtime_errors", "auto_fix_live_runtime_errors INTEGER NOT NULL DEFAULT 0");
  ensureColumn("settings", "sharingan_affirmed", "sharingan_affirmed INTEGER NOT NULL DEFAULT 0");
  ensureColumn("settings", "visual_qa_agent_command", "visual_qa_agent_command TEXT");
  ensureColumn("settings", "visual_qa_model", "visual_qa_model TEXT");
  ensureColumn("settings", "auto_improve_enabled", "auto_improve_enabled INTEGER NOT NULL DEFAULT 1");
  ensureColumn("settings", "auto_improve_max_rounds", "auto_improve_max_rounds INTEGER NOT NULL DEFAULT 8");
  ensureColumn("settings", "research_enabled", "research_enabled INTEGER NOT NULL DEFAULT 0");
  ensureColumn("settings", "research_agent_command", "research_agent_command TEXT");
  ensureColumn("settings", "research_model", "research_model TEXT");
  ensureColumn("projects", "archived_at", "archived_at INTEGER");
  ensureColumn("projects", "active_variant_id", "active_variant_id TEXT");
  ensureColumn("moodboards", "status", "status TEXT NOT NULL DEFAULT 'ready'");
  ensureColumn("runs", "variant_id", "variant_id TEXT");
  ensureColumn("runs", "user_message_id", "user_message_id TEXT");
  ensureColumn("runs", "assistant_message_id", "assistant_message_id TEXT");
  ensureColumn("runs", "commit_hash", "commit_hash TEXT");
  ensureColumn("runs", "artifact_id", "artifact_id TEXT");
  ensureColumn("runs", "artifact_track_id", "artifact_track_id TEXT");
  ensureColumn("runs", "plan_id", "plan_id TEXT");
  ensureColumn("runs", "task_id", "task_id TEXT");
  ensureColumn("runs", "base_revision_id", "base_revision_id TEXT");
  ensureColumn("runs", "context_pack_id", "context_pack_id TEXT");
  ensureColumn("runs", "context_pack_hash", "context_pack_hash TEXT");
  ensureColumn("runs", "attempt", "attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt > 0)");
  ensureColumn("runs", "model", "model TEXT");
  ensureColumn("runs", "agent_command", "agent_command TEXT");
  ensureColumn("runs", "skill_id", "skill_id TEXT");
  ensureColumn("runs", "feedback", "feedback TEXT");
  ensureColumn("runs", "owner_id", "owner_id TEXT");
  ensureColumn(
    "conversations",
    "scope_type",
    "scope_type TEXT CHECK(scope_type IN ('workspace','artifact','resource'))",
  );
  ensureColumn("conversations", "scope_id", "scope_id TEXT");
  ensureColumn("resource_revisions", "parent_revision_id", "parent_revision_id TEXT");
  ensureColumn(
    "context_packs",
    "intent",
    "intent TEXT NOT NULL DEFAULT 'generate' CHECK(intent IN ('plan','generate','edit','repair','analyze-impact'))",
  );
  ensureColumn(
    "context_packs",
    "message_checksum",
    `message_checksum TEXT NOT NULL DEFAULT '${"0".repeat(64)}'`,
  );
  db.prepare(
    `UPDATE conversations
     SET scope_type = 'workspace', scope_id = project_id
     WHERE scope_type IS NULL OR scope_id IS NULL`,
  ).run();
  ensureColumn(
    "artifact_revisions",
    "sealed",
    "sealed INTEGER NOT NULL DEFAULT 1 CHECK(sealed IN (0, 1))",
  );
  ensureColumn(
    "workspace_snapshots",
    "sealed",
    "sealed INTEGER NOT NULL DEFAULT 1 CHECK(sealed IN (0, 1))",
  );
  ensureColumn(
    "workspace_artifacts",
    "legacy_wrapped",
    "legacy_wrapped INTEGER NOT NULL DEFAULT 0 CHECK(legacy_wrapped IN (0, 1))",
  );
  ensureColumn(
    "generation_plans",
    "construction_sealed",
    "construction_sealed INTEGER NOT NULL DEFAULT 0 CHECK(construction_sealed IN (0, 1))",
  );
  ensureColumn(
    "generation_task_attempts",
    "materialization_sealed",
    "materialization_sealed INTEGER NOT NULL DEFAULT 0 CHECK(materialization_sealed IN (0, 1))",
  );
  ensureColumn(
    "generation_task_attempts",
    "attempt_origin",
    "attempt_origin TEXT NOT NULL DEFAULT 'materialized' CHECK(attempt_origin IN ('materialized','same-input-retry','publication-retry'))",
  );
  ensureColumn(
    "generation_task_attempts",
    "predecessor_attempt",
    "predecessor_attempt INTEGER CHECK(predecessor_attempt > 0 AND predecessor_attempt <= 9007199254740991)",
  );
  ensureColumn(
    "generation_task_attempts",
    "automatic_retry_index",
    "automatic_retry_index INTEGER NOT NULL DEFAULT 0 CHECK(automatic_retry_index >= 0 AND automatic_retry_index <= 3)",
  );
  ensureColumn("generation_task_attempts", "source_commit_hash", "source_commit_hash TEXT");
  ensureColumn("generation_task_attempts", "source_tree_hash", "source_tree_hash TEXT");
  // This index must be installed after the additive lineage columns. STORE_SCHEMA
  // is replayed before migrateStoreSchema() for an existing database, including
  // databases created by the claim/lease foundation that predate these columns.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_task_attempt_retry_predecessor
    ON generation_task_attempts(task_id, predecessor_attempt)
    WHERE predecessor_attempt IS NOT NULL`);
  db.exec(TASK12_GENERATION_TABLE_SCHEMA);
  db.exec(TASK12_GENERATION_TRIGGER_SCHEMA);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_context_packs_workspace_hash ON context_packs(workspace_id, hash)");
  db.exec(TASK4_OWNERSHIP_TRIGGER_UPGRADE_SCHEMA);
  db.exec(TASK5_LEGACY_WRAPPER_TRIGGER_UPGRADE_SCHEMA);
  db.exec(TASK11_CONTEXT_TRIGGER_UPGRADE_SCHEMA);
  db.exec(`CREATE TABLE IF NOT EXISTS moodboard_conversations (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES moodboards(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`);
  ensureColumn("moodboard_messages", "conversation_id", "conversation_id TEXT REFERENCES moodboard_conversations(id) ON DELETE CASCADE");
  // Persistent quality false-positive suppression (across runs). selector NULL = whole rule.
  db.exec(`CREATE TABLE IF NOT EXISTS quality_ignores (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    rule_id TEXT NOT NULL,
    selector TEXT,
    created_at INTEGER NOT NULL
  );`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_quality_ignores_project ON quality_ignores(project_id);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_runs_project_variant_status ON runs(project_id, variant_id, status);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_moodboard_conversations_board ON moodboard_conversations(board_id);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_moodboard_messages_conversation ON moodboard_messages(conversation_id);");
}
