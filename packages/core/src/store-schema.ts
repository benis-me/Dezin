import type { DatabaseSync } from "node:sqlite";

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
  manifest_path TEXT NOT NULL,
  summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_by_run_id TEXT REFERENCES runs(id),
  created_at INTEGER NOT NULL,
  FOREIGN KEY(resource_id, workspace_id)
    REFERENCES resources(id, workspace_id) ON DELETE CASCADE,
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
  review_json TEXT NOT NULL DEFAULT '{}',
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
  compile_error_json TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  FOREIGN KEY(proposal_id, workspace_id)
    REFERENCES workspace_proposals(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(proposal_id, proposal_revision)
    REFERENCES workspace_proposal_audit(proposal_id, revision),
  FOREIGN KEY(base_snapshot_id, workspace_id)
    REFERENCES workspace_snapshots(id, workspace_id),
  UNIQUE(id, workspace_id)
);

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
CREATE INDEX IF NOT EXISTS idx_workspace_proposals_workspace
  ON workspace_proposals(workspace_id, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_generation_plans_workspace
  ON generation_plans(workspace_id, created_at DESC, id);

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
CREATE TRIGGER IF NOT EXISTS workspace_proposal_delete_history_guard
BEFORE DELETE ON workspace_proposals
WHEN EXISTS (SELECT 1 FROM project_workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'Workspace Proposal history is immutable and cannot be deleted'); END;
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

/** Additive migrations for databases created before a column existed. */
export function migrateStoreSchema(db: DatabaseSync): void {
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
  ensureColumn("runs", "model", "model TEXT");
  ensureColumn("runs", "agent_command", "agent_command TEXT");
  ensureColumn("runs", "skill_id", "skill_id TEXT");
  ensureColumn("runs", "feedback", "feedback TEXT");
  ensureColumn("runs", "owner_id", "owner_id TEXT");
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
  db.exec(TASK4_OWNERSHIP_TRIGGER_UPGRADE_SCHEMA);
  db.exec(TASK5_LEGACY_WRAPPER_TRIGGER_UPGRADE_SCHEMA);
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
