import type { DatabaseSync } from "node:sqlite";

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
`;

/** Additive migrations for databases created before a column existed. */
export function migrateStoreSchema(db: DatabaseSync): void {
  const ensureColumn = (table: string, column: string, decl: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${decl}`);
    }
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

