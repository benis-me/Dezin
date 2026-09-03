import type { DatabaseSync } from "node:sqlite";

/**
 * SQLite now owns only independent app domains plus Sharingan capture history.
 * New Design Canvas projects, nodes, versions, conversations, and exports live
 * in their filesystem project store and deliberately have no rows here.
 */
export const STORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'standard' CHECK(mode = 'standard'),
  sharingan INTEGER NOT NULL DEFAULT 1 CHECK(sharingan = 1),
  source_url TEXT NOT NULL CHECK(length(source_url) > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  agent_command TEXT,
  model TEXT,
  api_base_url TEXT,
  api_key TEXT,
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
  ai_provider_enabled INTEGER NOT NULL DEFAULT 0 CHECK(ai_provider_enabled IN (0, 1)),
  ai_provider_models TEXT,
  ai_provider_organization TEXT,
  ai_provider_profiles TEXT,
  sharingan_affirmed INTEGER NOT NULL DEFAULT 0 CHECK(sharingan_affirmed IN (0, 1)),
  web_resources INTEGER NOT NULL DEFAULT 1 CHECK(web_resources IN (0, 1)),
  quality_lint INTEGER NOT NULL DEFAULT 1 CHECK(quality_lint IN (0, 1)),
  visual_review INTEGER NOT NULL DEFAULT 0 CHECK(visual_review IN (0, 1))
);

CREATE TABLE IF NOT EXISTS extension_credentials (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  extension_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_extension_credentials_token_hash
  ON extension_credentials(token_hash);

CREATE TABLE IF NOT EXISTS moodboards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  cover_asset_id TEXT,
  status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('starting', 'ready'))
);
CREATE TABLE IF NOT EXISTS moodboard_nodes (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES moodboards(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('image', 'image-generator', 'note', 'section', 'video')),
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
  kind TEXT NOT NULL CHECK(kind IN ('image', 'video')),
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  source TEXT NOT NULL CHECK(source IN ('upload', 'generated', 'edited')),
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
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moodboard_nodes_board ON moodboard_nodes(board_id);
CREATE INDEX IF NOT EXISTS idx_moodboard_assets_board ON moodboard_assets(board_id);
CREATE INDEX IF NOT EXISTS idx_moodboard_conversations_board ON moodboard_conversations(board_id);
CREATE INDEX IF NOT EXISTS idx_moodboard_messages_board ON moodboard_messages(board_id);

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
CREATE TABLE IF NOT EXISTS workspace_graph_revisions (
  workspace_id TEXT NOT NULL REFERENCES project_workspaces(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  nodes_json TEXT NOT NULL,
  edges_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, revision)
);
CREATE TABLE IF NOT EXISTS shared_design_kernel_revisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES project_workspaces(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  parent_revision_id TEXT,
  payload_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(parent_revision_id, workspace_id)
    REFERENCES shared_design_kernel_revisions(id, workspace_id),
  UNIQUE(id, workspace_id),
  UNIQUE(workspace_id, sequence)
);
CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES project_workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind = 'sharingan-capture'),
  title TEXT NOT NULL,
  head_revision_id TEXT,
  default_pin_policy TEXT NOT NULL DEFAULT 'pin-current' CHECK(default_pin_policy = 'pin-current'),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(head_revision_id, id, workspace_id)
    REFERENCES resource_revisions(id, resource_id, workspace_id)
    DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(id, workspace_id),
  UNIQUE(workspace_id)
);
CREATE TABLE IF NOT EXISTS resource_revisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  parent_revision_id TEXT,
  manifest_path TEXT NOT NULL,
  summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(resource_id, workspace_id)
    REFERENCES resources(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(parent_revision_id, resource_id, workspace_id)
    REFERENCES resource_revisions(id, resource_id, workspace_id),
  UNIQUE(id, resource_id, workspace_id),
  UNIQUE(id, workspace_id),
  UNIQUE(resource_id, sequence)
);
CREATE TABLE IF NOT EXISTS workspace_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES project_workspaces(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  parent_snapshot_id TEXT,
  graph_revision INTEGER NOT NULL,
  kernel_revision_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_resources_workspace ON resources(workspace_id);
CREATE INDEX IF NOT EXISTS idx_resource_revisions_workspace ON resource_revisions(workspace_id, sequence);
CREATE INDEX IF NOT EXISTS idx_workspace_graph_revisions_workspace
  ON workspace_graph_revisions(workspace_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_snapshots_workspace
  ON workspace_snapshots(workspace_id, sequence DESC);
CREATE INDEX IF NOT EXISTS idx_snapshot_resources_owner
  ON workspace_snapshot_resources(resource_id, workspace_id);

CREATE TRIGGER IF NOT EXISTS project_identity_update_immutable
BEFORE UPDATE OF id, mode, sharingan, source_url ON projects
WHEN NEW.id IS NOT OLD.id OR NEW.mode IS NOT OLD.mode
  OR NEW.sharingan IS NOT OLD.sharingan OR NEW.source_url IS NOT OLD.source_url
BEGIN SELECT RAISE(ABORT, 'Sharingan Project identity is immutable'); END;

CREATE TRIGGER IF NOT EXISTS project_workspace_identity_update_immutable
BEFORE UPDATE OF id, project_id ON project_workspaces
WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id
BEGIN SELECT RAISE(ABORT, 'Sharingan Workspace identity is immutable'); END;

CREATE TRIGGER IF NOT EXISTS workspace_graph_revision_update_immutable
BEFORE UPDATE ON workspace_graph_revisions
BEGIN SELECT RAISE(ABORT, 'Sharingan graph Revisions are immutable'); END;

CREATE TRIGGER IF NOT EXISTS kernel_revision_update_immutable
BEFORE UPDATE ON shared_design_kernel_revisions
BEGIN SELECT RAISE(ABORT, 'Sharingan kernel Revisions are immutable'); END;

CREATE TRIGGER IF NOT EXISTS kernel_parent_insert_guard
BEFORE INSERT ON shared_design_kernel_revisions
WHEN NEW.parent_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM shared_design_kernel_revisions parent
  WHERE parent.id = NEW.parent_revision_id
    AND parent.workspace_id = NEW.workspace_id
    AND parent.sequence < NEW.sequence
)
BEGIN SELECT RAISE(ABORT, 'Sharingan kernel Revision parent is invalid'); END;

CREATE TRIGGER IF NOT EXISTS resource_identity_update_immutable
BEFORE UPDATE OF id, workspace_id, kind, default_pin_policy ON resources
WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.kind IS NOT OLD.kind OR NEW.default_pin_policy IS NOT OLD.default_pin_policy
BEGIN SELECT RAISE(ABORT, 'Sharingan Resource identity is immutable'); END;

CREATE TRIGGER IF NOT EXISTS resource_head_update_ownership
BEFORE UPDATE OF head_revision_id ON resources
WHEN NEW.head_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM resource_revisions revision
  WHERE revision.id = NEW.head_revision_id
    AND revision.resource_id = NEW.id
    AND revision.workspace_id = NEW.workspace_id
)
BEGIN SELECT RAISE(ABORT, 'Sharingan Resource Head ownership violation'); END;

CREATE TRIGGER IF NOT EXISTS resource_head_lineage_guard
BEFORE UPDATE OF head_revision_id ON resources
WHEN NEW.head_revision_id IS NOT OLD.head_revision_id AND (
  NEW.head_revision_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM resource_revisions revision
    WHERE revision.id = NEW.head_revision_id
      AND revision.resource_id = NEW.id
      AND revision.workspace_id = NEW.workspace_id
      AND revision.parent_revision_id IS OLD.head_revision_id
  )
)
BEGIN SELECT RAISE(ABORT, 'Sharingan Resource Head must advance to a direct child Revision'); END;

CREATE TRIGGER IF NOT EXISTS resource_revision_parent_insert_guard
BEFORE INSERT ON resource_revisions
WHEN (NEW.parent_revision_id IS NULL AND NEW.sequence <> 1)
  OR (NEW.parent_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM resource_revisions parent
    WHERE parent.id = NEW.parent_revision_id
      AND parent.resource_id = NEW.resource_id
      AND parent.workspace_id = NEW.workspace_id
      AND parent.sequence + 1 = NEW.sequence
  ))
BEGIN SELECT RAISE(ABORT, 'Sharingan Resource Revision ancestry is invalid'); END;

CREATE TRIGGER IF NOT EXISTS resource_revision_update_immutable
BEFORE UPDATE ON resource_revisions
BEGIN SELECT RAISE(ABORT, 'Sharingan Resource Revisions are immutable'); END;

CREATE TRIGGER IF NOT EXISTS workspace_snapshot_update_immutable
BEFORE UPDATE OF id, workspace_id, sequence, parent_snapshot_id, graph_revision,
  kernel_revision_id, reason, provenance_json, created_at
ON workspace_snapshots
BEGIN SELECT RAISE(ABORT, 'Sharingan Workspace Snapshots are immutable'); END;

CREATE TRIGGER IF NOT EXISTS workspace_snapshot_seal_transition_guard
BEFORE UPDATE OF sealed ON workspace_snapshots
WHEN OLD.sealed <> 0 OR NEW.sealed <> 1
BEGIN SELECT RAISE(ABORT, 'Sharingan Workspace Snapshot seal is immutable after construction'); END;

CREATE TRIGGER IF NOT EXISTS workspace_snapshot_resource_insert_guard
BEFORE INSERT ON workspace_snapshot_resources
WHEN NOT EXISTS (
  SELECT 1 FROM workspace_snapshots snapshot
  WHERE snapshot.id = NEW.snapshot_id
    AND snapshot.workspace_id = NEW.workspace_id
    AND snapshot.sealed = 0
) OR NOT EXISTS (
  SELECT 1 FROM resource_revisions revision
  WHERE revision.id = NEW.revision_id
    AND revision.resource_id = NEW.resource_id
    AND revision.workspace_id = NEW.workspace_id
)
BEGIN SELECT RAISE(ABORT, 'Sharingan Snapshot Resource mapping is invalid or sealed'); END;

CREATE TRIGGER IF NOT EXISTS workspace_snapshot_resource_update_immutable
BEFORE UPDATE ON workspace_snapshot_resources
BEGIN SELECT RAISE(ABORT, 'Sharingan Snapshot Resource mappings are immutable'); END;
`;

const CURRENT_STORE_TABLES = [
  "projects",
  "settings",
  "extension_credentials",
  "moodboards",
  "moodboard_nodes",
  "moodboard_assets",
  "moodboard_conversations",
  "moodboard_messages",
  "custom_effects",
  "project_workspaces",
  "workspace_graph_revisions",
  "shared_design_kernel_revisions",
  "resources",
  "resource_revisions",
  "workspace_snapshots",
  "workspace_snapshot_resources",
] as const;

const LEGACY_DESIGN_TABLES = [
  "generation_tasks",
  "generation_task_dependencies",
  "generation_task_attempts",
  "resource_payload_staging_journal",
  "resource_payload_cleanup_claims",
  "generation_task_attempt_dependency_outputs",
  "generation_task_attempt_resource_pins",
  "generation_task_attempt_component_pins",
  "generation_task_validation_results",
  "generation_task_materialization_failures",
  "generation_task_claims",
  "generation_plan_events",
  "scoped_agent_turns",
  "workspace_agent_turns",
  "resource_materialization_receipts",
  "research_direction_artifact_intents",
  "conversations",
  "messages",
  "runs",
  "artifacts",
  "variants",
  "workspace_artifacts",
  "artifact_tracks",
  "artifact_revisions",
  "component_instances",
  "artifact_revision_dependencies",
  "artifact_revision_resources",
  "workspace_nodes",
  "workspace_edges",
  "workspace_graph_commands",
  "workspace_layout_nodes",
  "workspace_layout_viewports",
  "workspace_snapshot_artifacts",
  "context_packs",
  "context_pack_items",
  "context_pack_item_usage",
  "workspace_proposals",
  "workspace_proposal_audit",
  "generation_plans",
  "quality_ignores",
] as const;

type SchemaNameRow = { name: string };

function applicationTables(db: DatabaseSync): string[] {
  return (db.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as SchemaNameRow[]).map((row) => row.name);
}

function tableHasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as SchemaNameRow[])
    .some((row) => row.name === column);
}

function dropSchemaObjects(db: DatabaseSync, type: "index" | "trigger" | "view"): void {
  const rows = db.prepare(
    `SELECT name FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).all(type) as SchemaNameRow[];
  for (const row of rows) db.exec(`DROP ${type.toUpperCase()} IF EXISTS "${row.name.replaceAll('"', '""')}"`);
}

function stageName(table: string): string {
  return `__dezin_retained_${table}`;
}

function copyRetainedStoreRows(db: DatabaseSync, hadRunRevisionColumn: boolean, hadRunSnapshotColumn: boolean): void {
  const staged = (table: string): string => `"${stageName(table)}"`;
  const revisionRunFence = hadRunRevisionColumn ? "AND revision.created_by_run_id IS NULL" : "";
  const snapshotRunFence = hadRunSnapshotColumn ? "AND snapshot.created_by_run_id IS NULL" : "";

  db.exec(`
    INSERT INTO settings (
      id, agent_command, model, api_base_url, api_key, custom_instructions,
      image_api_base_url, image_api_key, image_model, remove_background_model,
      edit_region_model, extract_layer_model, video_api_base_url, video_api_key,
      video_model, ai_provider_id, ai_provider_enabled, ai_provider_models,
      ai_provider_organization, ai_provider_profiles, sharingan_affirmed
    )
    SELECT id, agent_command, model, api_base_url, api_key, custom_instructions,
      image_api_base_url, image_api_key, image_model, remove_background_model,
      edit_region_model, extract_layer_model, video_api_base_url, video_api_key,
      video_model, ai_provider_id, ai_provider_enabled, ai_provider_models,
      ai_provider_organization, ai_provider_profiles, sharingan_affirmed
    FROM ${staged("settings")};

    INSERT INTO extension_credentials
      (id, token_hash, extension_id, scopes_json, created_at, last_used_at, revoked_at)
    SELECT id, token_hash, extension_id, scopes_json, created_at, last_used_at, revoked_at
    FROM ${staged("extension_credentials")};

    INSERT INTO moodboards
      (id, name, created_at, updated_at, archived_at, cover_asset_id, status)
    SELECT id, name, created_at, updated_at, archived_at, cover_asset_id, status
    FROM ${staged("moodboards")};
    INSERT INTO moodboard_nodes
      (id, board_id, type, x, y, width, height, rotation, z_index, data_json, created_at, updated_at)
    SELECT id, board_id, type, x, y, width, height, rotation, z_index, data_json, created_at, updated_at
    FROM ${staged("moodboard_nodes")};
    INSERT INTO moodboard_assets
      (id, board_id, kind, file_name, mime_type, width, height, source, created_at)
    SELECT id, board_id, kind, file_name, mime_type, width, height, source, created_at
    FROM ${staged("moodboard_assets")};
    INSERT INTO moodboard_conversations (id, board_id, title, created_at)
    SELECT id, board_id, title, created_at FROM ${staged("moodboard_conversations")};
    INSERT INTO moodboard_messages (id, board_id, conversation_id, role, content, created_at)
    SELECT id, board_id, conversation_id, role, content, created_at
    FROM ${staged("moodboard_messages")};

    INSERT INTO custom_effects
      (id, name, category, summary, code, parameters_json, presets_json, created_at, updated_at)
    SELECT id, name, category, summary, code, parameters_json, presets_json, created_at, updated_at
    FROM ${staged("custom_effects")};

    INSERT INTO projects (id, name, mode, sharingan, source_url, created_at, updated_at, archived_at)
    SELECT id, name, 'standard', 1, source_url, created_at, updated_at, archived_at
    FROM ${staged("projects")}
    WHERE sharingan = 1 AND mode = 'standard' AND source_url IS NOT NULL AND length(source_url) > 0;

    INSERT INTO project_workspaces (
      id, project_id, graph_revision, active_snapshot_id, active_kernel_revision_id, created_at, updated_at
    )
    SELECT workspace.id, workspace.project_id, workspace.graph_revision,
      workspace.active_snapshot_id, workspace.active_kernel_revision_id,
      workspace.created_at, workspace.updated_at
    FROM ${staged("project_workspaces")} workspace
    WHERE workspace.project_id IN (SELECT id FROM projects)
      AND EXISTS (
        SELECT 1 FROM ${staged("workspace_graph_revisions")} graph
        WHERE graph.workspace_id = workspace.id AND graph.revision = workspace.graph_revision
      )
      AND EXISTS (
        SELECT 1 FROM ${staged("shared_design_kernel_revisions")} kernel
        WHERE kernel.workspace_id = workspace.id AND kernel.id = workspace.active_kernel_revision_id
      )
      AND EXISTS (
        SELECT 1 FROM ${staged("workspace_snapshots")} snapshot
        WHERE snapshot.workspace_id = workspace.id AND snapshot.id = workspace.active_snapshot_id
          ${snapshotRunFence}
      );

    INSERT INTO workspace_graph_revisions
      (workspace_id, revision, nodes_json, edges_json, checksum, created_at)
    SELECT workspace_id, revision, nodes_json, edges_json, checksum, created_at
    FROM ${staged("workspace_graph_revisions")}
    WHERE workspace_id IN (SELECT id FROM project_workspaces)
    ORDER BY workspace_id, revision;

    INSERT INTO shared_design_kernel_revisions
      (id, workspace_id, sequence, parent_revision_id, payload_json, checksum, created_at)
    SELECT id, workspace_id, sequence, parent_revision_id, payload_json, checksum, created_at
    FROM ${staged("shared_design_kernel_revisions")}
    WHERE workspace_id IN (SELECT id FROM project_workspaces)
    ORDER BY workspace_id, sequence;

    INSERT INTO resources
      (id, workspace_id, kind, title, head_revision_id, default_pin_policy, archived_at, created_at, updated_at)
    SELECT resource.id, resource.workspace_id, resource.kind, resource.title,
      resource.head_revision_id, resource.default_pin_policy,
      resource.archived_at, resource.created_at, resource.updated_at
    FROM ${staged("resources")} resource
    WHERE resource.workspace_id IN (SELECT id FROM project_workspaces)
      AND resource.kind = 'sharingan-capture'
      AND resource.default_pin_policy = 'pin-current'
      AND (resource.head_revision_id IS NULL OR EXISTS (
        SELECT 1 FROM ${staged("resource_revisions")} revision
        WHERE revision.id = resource.head_revision_id
          AND revision.resource_id = resource.id
          AND revision.workspace_id = resource.workspace_id
          ${revisionRunFence}
      ));

    INSERT INTO resource_revisions (
      id, workspace_id, resource_id, sequence, parent_revision_id, manifest_path,
      summary, metadata_json, checksum, provenance_json, created_at
    )
    SELECT revision.id, revision.workspace_id, revision.resource_id, revision.sequence,
      revision.parent_revision_id, revision.manifest_path, revision.summary,
      revision.metadata_json, revision.checksum, revision.provenance_json, revision.created_at
    FROM ${staged("resource_revisions")} revision
    WHERE revision.workspace_id IN (SELECT id FROM project_workspaces)
      AND revision.resource_id IN (SELECT id FROM resources)
      ${revisionRunFence}
    ORDER BY revision.resource_id, revision.sequence;

    INSERT INTO workspace_snapshots (
      id, workspace_id, sequence, parent_snapshot_id, graph_revision,
      kernel_revision_id, reason, provenance_json, created_at, sealed
    )
    SELECT snapshot.id, snapshot.workspace_id, snapshot.sequence, snapshot.parent_snapshot_id,
      snapshot.graph_revision, snapshot.kernel_revision_id, snapshot.reason,
      snapshot.provenance_json, snapshot.created_at, 0
    FROM ${staged("workspace_snapshots")} snapshot
    WHERE snapshot.workspace_id IN (SELECT id FROM project_workspaces)
      ${snapshotRunFence}
    ORDER BY snapshot.workspace_id, snapshot.sequence;

    INSERT INTO workspace_snapshot_resources
      (workspace_id, snapshot_id, resource_id, revision_id)
    SELECT pin.workspace_id, pin.snapshot_id, pin.resource_id, pin.revision_id
    FROM ${staged("workspace_snapshot_resources")} pin
    WHERE pin.workspace_id IN (SELECT id FROM project_workspaces)
      AND pin.snapshot_id IN (SELECT id FROM workspace_snapshots)
      AND pin.resource_id IN (SELECT id FROM resources)
      AND pin.revision_id IN (SELECT id FROM resource_revisions);

    UPDATE workspace_snapshots SET sealed = 1 WHERE sealed = 0;
  `);
}

/**
 * The Canvas rebuild has no compatibility mode for Standard Design data. When
 * any retired table or retired column is present, rebuild the active SQLite
 * file atomically: copy only independent app domains and valid Sharingan rows,
 * recreate the exact current schema, and leave every legacy Design row behind.
 */
export function discardLegacyDesignStore(db: DatabaseSync): string | null {
  const tables = applicationTables(db);
  const present = new Set(tables);
  const hasLegacyTable = LEGACY_DESIGN_TABLES.some((table) => present.has(table));
  const hadRunRevisionColumn = present.has("resource_revisions")
    && tableHasColumn(db, "resource_revisions", "created_by_run_id");
  const hadRunSnapshotColumn = present.has("workspace_snapshots")
    && tableHasColumn(db, "workspace_snapshots", "created_by_run_id");
  const hasRetiredSettings = present.has("settings")
    && tableHasColumn(db, "settings", "default_design_system_id");
  const shouldRebuild = hasLegacyTable || hadRunRevisionColumn || hadRunSnapshotColumn || hasRetiredSettings;
  if (!shouldRebuild) return null;

  const known = new Set<string>([...CURRENT_STORE_TABLES, ...LEGACY_DESIGN_TABLES]);
  const unknown = tables.filter((table) => !known.has(table));
  if (unknown.length > 0) {
    throw new Error(`Cannot discard legacy Design schema with unknown application tables: ${unknown.join(", ")}`);
  }
  const missingRetained = CURRENT_STORE_TABLES.filter((table) => !present.has(table));
  if (missingRetained.length > 0) {
    throw new Error(`Cannot preserve independent store domains; legacy database is missing: ${missingRetained.join(", ")}`);
  }

  const database = (db.prepare("PRAGMA database_list").all() as Array<{ name?: unknown; file?: unknown }>)
    .find((entry) => entry.name === "main");
  const databasePath = typeof database?.file === "string" ? database.file : "";
  if (!databasePath) {
    throw new Error("Cannot discard legacy Design schema without a file-backed backup");
  }
  const backupPath = `${databasePath}.legacy-design-backup-${Date.now()}-${process.pid}.sqlite`;
  const quotedBackupPath = backupPath.replaceAll("'", "''");
  try {
    db.exec(`VACUUM main INTO '${quotedBackupPath}'`);
  } catch (error) {
    throw new Error(
      `Cannot discard legacy Design schema because its backup failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    dropSchemaObjects(db, "view");
    dropSchemaObjects(db, "trigger");
    dropSchemaObjects(db, "index");
    for (const table of CURRENT_STORE_TABLES) {
      db.exec(`ALTER TABLE "${table}" RENAME TO "${stageName(table)}"`);
    }
    for (const table of LEGACY_DESIGN_TABLES) {
      if (present.has(table)) db.exec(`DROP TABLE "${table}"`);
    }
    db.exec(STORE_SCHEMA);
    copyRetainedStoreRows(db, hadRunRevisionColumn, hadRunSnapshotColumn);
    for (const table of [...CURRENT_STORE_TABLES].reverse()) {
      db.exec(`DROP TABLE "${stageName(table)}"`);
    }
    const foreignKeyFailures = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyFailures.length > 0) {
      throw new Error(`Retained independent store data violates ${foreignKeyFailures.length} foreign key constraint(s)`);
    }
    const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
    if (integrity?.integrity_check !== "ok") throw new Error("Rebuilt store failed SQLite integrity_check");
    db.exec("COMMIT");
    return backupPath;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the exact rebuild error if SQLite already closed the transaction.
    }
    throw new Error(
      `Could not atomically discard legacy Standard Design data: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
