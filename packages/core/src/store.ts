/**
 * Local-first metadata store backed by node:sqlite (Node ≥ 22.5, --experimental-sqlite).
 *
 * Deliberately tiny: ~5 tables, WAL, foreign keys on. Metadata only; the actual
 * generated artifacts live on disk, not here.
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type {
  Project,
  Conversation,
  Variant,
  Message,
  Run,
  RunFeedback,
  Artifact,
  Moodboard,
  MoodboardNode,
  MoodboardAsset,
  MoodboardConversation,
  MoodboardMessage,
  Effect,
  EffectParamDefinition,
  EffectPreset,
  MessageRole,
  QualityFinding,
  QualityIgnoreEntry,
  RunStatus,
  CreateProjectInput,
  CreateMoodboardInput,
  CreateEffectInput,
  SaveMoodboardNodeInput,
  Settings,
  UpdateEffectInput,
} from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  skill_id TEXT,
  design_system_id TEXT,
  mode TEXT,
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
  visual_qa_agent_command TEXT,
  visual_qa_model TEXT,
  auto_improve_enabled INTEGER NOT NULL DEFAULT 1,
  auto_improve_max_rounds INTEGER NOT NULL DEFAULT 8,
  research_enabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS moodboards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  cover_asset_id TEXT
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
`;

const DEFAULT_SETTINGS: Settings = {
  agentCommand: "claude",
  model: "",
  apiBaseUrl: "",
  apiKey: "",
  defaultDesignSystemId: "modern-minimal",
  customInstructions: "",
  imageApiBaseUrl: "",
  imageApiKey: "",
  imageModel: "",
  removeBackgroundModel: "",
  editRegionModel: "",
  extractLayerModel: "",
  videoApiBaseUrl: "",
  videoApiKey: "",
  videoModel: "",
  aiProviderId: "openai",
  aiProviderEnabled: false,
  aiProviderModels: "gpt-image-1",
  aiProviderOrganization: "",
  aiProviderProfiles: "",
  visualQaEnabled: false,
  autoFixLiveRuntimeErrors: false,
  visualQaAgentCommand: "",
  visualQaModel: "",
  autoImproveEnabled: true,
  autoImproveMaxRounds: 8,
  researchEnabled: false,
};

type Row = Record<string, unknown>;

function asProject(r: Row): Project {
  return {
    id: r.id as string,
    name: r.name as string,
    skillId: (r.skill_id as string | null) ?? null,
    designSystemId: (r.design_system_id as string | null) ?? null,
    mode: r.mode === "standard" ? "standard" : "prototype",
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    archivedAt: r.archived_at == null ? null : Number(r.archived_at),
  };
}
function asConversation(r: Row): Conversation {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    title: r.title as string,
    createdAt: Number(r.created_at),
  };
}
function asVariant(r: Row): Variant {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    name: r.name as string,
    createdAt: Number(r.created_at),
  };
}
function asMessage(r: Row): Message {
  return {
    id: r.id as string,
    conversationId: r.conversation_id as string,
    role: r.role as MessageRole,
    content: r.content as string,
    createdAt: Number(r.created_at),
  };
}
function asQualityFindings(value: unknown): QualityFinding[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((f): f is QualityFinding => {
      if (!f || typeof f !== "object") return false;
      const x = f as Record<string, unknown>;
      return (
        (x.severity === "P0" || x.severity === "P1" || x.severity === "P2") &&
        typeof x.id === "string" &&
        typeof x.message === "string" &&
        typeof x.fix === "string" &&
        (x.snippet === undefined || typeof x.snippet === "string")
      );
    });
  } catch {
    return [];
  }
}
function parseRunFeedback(value: unknown): RunFeedback | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const p = JSON.parse(value) as { verdict?: unknown; gap?: unknown };
    if (p.verdict === "up" || p.verdict === "down") return { verdict: p.verdict, gap: typeof p.gap === "string" ? p.gap : undefined };
  } catch {
    /* ignore malformed feedback */
  }
  return null;
}

function asRun(r: Row): Run {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    conversationId: r.conversation_id as string,
    userMessageId: (r.user_message_id as string | null | undefined) ?? null,
    assistantMessageId: (r.assistant_message_id as string | null | undefined) ?? null,
    variantId: (r.variant_id as string | null | undefined) ?? null,
    commitHash: (r.commit_hash as string | null | undefined) ?? null,
    status: r.status as RunStatus,
    repairRounds: Number(r.repair_rounds),
    lintPassed: Number(r.lint_passed) === 1,
    score: r.score == null ? null : Number(r.score),
    findings: asQualityFindings(r.final_findings),
    model: (r.model as string | null | undefined) ?? null,
    agentCommand: (r.agent_command as string | null | undefined) ?? null,
    skillId: (r.skill_id as string | null | undefined) ?? null,
    feedback: parseRunFeedback(r.feedback),
    createdAt: Number(r.created_at),
    finishedAt: r.finished_at == null ? null : Number(r.finished_at),
  };
}
function asArtifact(r: Row): Artifact {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    path: r.path as string,
    lintPassed: Number(r.lint_passed) === 1,
    createdAt: Number(r.created_at),
  };
}
function asJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
function asMoodboard(r: Row): Moodboard {
  return {
    id: r.id as string,
    name: r.name as string,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    archivedAt: r.archived_at == null ? null : Number(r.archived_at),
    coverAssetId: (r.cover_asset_id as string | null | undefined) ?? null,
  };
}
function asMoodboardNode(r: Row): MoodboardNode {
  const type =
    r.type === "video" || r.type === "note" || r.type === "section" || r.type === "image-generator"
      ? r.type
      : "image";
  return {
    id: r.id as string,
    boardId: r.board_id as string,
    type,
    x: Number(r.x),
    y: Number(r.y),
    width: Number(r.width),
    height: Number(r.height),
    rotation: Number(r.rotation ?? 0),
    zIndex: Number(r.z_index ?? 0),
    data: asJsonObject(r.data_json),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}
function asMoodboardAsset(r: Row): MoodboardAsset {
  return {
    id: r.id as string,
    boardId: r.board_id as string,
    kind: r.kind === "video" ? "video" : "image",
    fileName: r.file_name as string,
    mimeType: r.mime_type as string,
    width: r.width == null ? null : Number(r.width),
    height: r.height == null ? null : Number(r.height),
    source: r.source === "generated" ? "generated" : "upload",
    createdAt: Number(r.created_at),
  };
}
function asMoodboardConversation(r: Row): MoodboardConversation {
  return {
    id: r.id as string,
    boardId: r.board_id as string,
    title: r.title as string,
    createdAt: Number(r.created_at),
    ...(r.turns == null ? {} : { turns: Number(r.turns) }),
  };
}
function asMoodboardMessage(r: Row): MoodboardMessage {
  return {
    id: r.id as string,
    boardId: r.board_id as string,
    conversationId: (r.conversation_id as string | null) ?? undefined,
    role: r.role as MessageRole,
    content: r.content as string,
    createdAt: Number(r.created_at),
  };
}
function asEffectParamValue(value: unknown): string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : "";
}
function asEffectParameters(value: unknown): EffectParamDefinition[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((param): EffectParamDefinition[] => {
      const record = asJsonObject(JSON.stringify(param));
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const label = typeof record.label === "string" ? record.label.trim() : "";
      const type =
        record.type === "color" || record.type === "select" || record.type === "boolean" || record.type === "number"
          ? record.type
          : "number";
      if (!id || !label) return [];
      const options = Array.isArray(record.options)
        ? record.options.flatMap((option): Array<{ label: string; value: string }> => {
            const optionRecord = option && typeof option === "object" && !Array.isArray(option) ? (option as Record<string, unknown>) : {};
            const valueText = typeof optionRecord.value === "string" ? optionRecord.value : "";
            const labelText = typeof optionRecord.label === "string" ? optionRecord.label : valueText;
            return valueText ? [{ label: labelText, value: valueText }] : [];
          })
        : undefined;
      return [
        {
          id,
          label,
          type,
          defaultValue: asEffectParamValue(record.defaultValue),
          ...(typeof record.min === "number" ? { min: record.min } : {}),
          ...(typeof record.max === "number" ? { max: record.max } : {}),
          ...(typeof record.step === "number" ? { step: record.step } : {}),
          ...(options?.length ? { options } : {}),
          ...(typeof record.description === "string" ? { description: record.description } : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}
function asEffectPresets(value: unknown): EffectPreset[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((preset): EffectPreset[] => {
      const record = preset && typeof preset === "object" && !Array.isArray(preset) ? (preset as Record<string, unknown>) : {};
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const name = typeof record.name === "string" ? record.name.trim() : "";
      const rawValues = record.values && typeof record.values === "object" && !Array.isArray(record.values) ? (record.values as Record<string, unknown>) : {};
      if (!id || !name) return [];
      return [{ id, name, values: Object.fromEntries(Object.entries(rawValues).map(([key, val]) => [key, asEffectParamValue(val)])) }];
    });
  } catch {
    return [];
  }
}
function asEffect(r: Row): Effect {
  return {
    id: r.id as string,
    name: r.name as string,
    origin: "custom",
    category: r.category as string,
    summary: r.summary as string,
    code: r.code as string,
    parameters: asEffectParameters(r.parameters_json),
    presets: asEffectPresets(r.presets_json),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export interface StoreClock {
  now(): number;
  id(): string;
}

const DEFAULT_CLOCK: StoreClock = { now: () => Date.now(), id: () => randomUUID() };

export class Store {
  readonly db: DatabaseSync;
  private clock: StoreClock;

  constructor(path = ":memory:", clock: StoreClock = DEFAULT_CLOCK) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.migrate();
    this.clock = clock;
  }

  /** Additive migrations for databases created before a column existed. */
  private migrate(): void {
    const ensureColumn = (table: string, column: string, decl: string) => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${decl}`);
      }
    };
    ensureColumn("runs", "score", "score INTEGER");
    ensureColumn("runs", "final_findings", "final_findings TEXT NOT NULL DEFAULT '[]'");
    ensureColumn("projects", "mode", "mode TEXT");
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
    ensureColumn("settings", "visual_qa_agent_command", "visual_qa_agent_command TEXT");
    ensureColumn("settings", "visual_qa_model", "visual_qa_model TEXT");
    ensureColumn("settings", "auto_improve_enabled", "auto_improve_enabled INTEGER NOT NULL DEFAULT 1");
    ensureColumn("settings", "auto_improve_max_rounds", "auto_improve_max_rounds INTEGER NOT NULL DEFAULT 8");
    ensureColumn("settings", "research_enabled", "research_enabled INTEGER NOT NULL DEFAULT 0");
    ensureColumn("projects", "archived_at", "archived_at INTEGER");
    ensureColumn("projects", "active_variant_id", "active_variant_id TEXT");
    ensureColumn("runs", "variant_id", "variant_id TEXT");
    ensureColumn("runs", "user_message_id", "user_message_id TEXT");
    ensureColumn("runs", "assistant_message_id", "assistant_message_id TEXT");
    ensureColumn("runs", "commit_hash", "commit_hash TEXT");
    ensureColumn("runs", "model", "model TEXT");
    ensureColumn("runs", "agent_command", "agent_command TEXT");
    ensureColumn("runs", "skill_id", "skill_id TEXT");
    ensureColumn("runs", "feedback", "feedback TEXT");
    ensureColumn("runs", "owner_id", "owner_id TEXT");
    this.db.exec(`CREATE TABLE IF NOT EXISTS moodboard_conversations (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES moodboards(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );`);
    ensureColumn("moodboard_messages", "conversation_id", "conversation_id TEXT REFERENCES moodboard_conversations(id) ON DELETE CASCADE");
    // Persistent quality false-positive suppression (across runs). selector NULL = whole rule.
    this.db.exec(`CREATE TABLE IF NOT EXISTS quality_ignores (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      rule_id TEXT NOT NULL,
      selector TEXT,
      created_at INTEGER NOT NULL
    );`);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_quality_ignores_project ON quality_ignores(project_id);");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_runs_project_variant_status ON runs(project_id, variant_id, status);");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_moodboard_conversations_board ON moodboard_conversations(board_id);");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_moodboard_messages_conversation ON moodboard_messages(conversation_id);");
  }

  close(): void {
    this.db.close();
  }

  // ── projects ──────────────────────────────────────────────────────────────
  createProject(input: CreateProjectInput): Project {
    const id = this.clock.id();
    const now = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO projects (id, name, skill_id, design_system_id, mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.skillId ?? null, input.designSystemId ?? null, input.mode ?? "prototype", now, now);
    return this.getProject(id)!;
  }

  createImportedProject(input: CreateProjectInput & { createdAt?: number; updatedAt?: number; archivedAt?: number | null }): Project {
    const id = this.clock.id();
    const now = this.clock.now();
    const createdAt = Number.isFinite(input.createdAt) ? Number(input.createdAt) : now;
    const updatedAt = Number.isFinite(input.updatedAt) ? Number(input.updatedAt) : createdAt;
    const archivedAt = input.archivedAt == null || !Number.isFinite(input.archivedAt) ? null : Number(input.archivedAt);
    this.db
      .prepare(
        `INSERT INTO projects (id, name, skill_id, design_system_id, mode, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.skillId ?? null, input.designSystemId ?? null, input.mode ?? "prototype", createdAt, updatedAt, archivedAt);
    return this.getProject(id)!;
  }

  getProject(id: string): Project | null {
    const r = this.db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Row | undefined;
    return r ? asProject(r) : null;
  }

  listProjects(): Project[] {
    const rows = this.db.prepare(`SELECT * FROM projects ORDER BY updated_at DESC, rowid DESC`).all() as Row[];
    return rows.map(asProject);
  }

  updateProject(
    id: string,
    patch: Partial<Pick<Project, "name" | "skillId" | "designSystemId">>,
  ): Project {
    const cur = this.getProject(id);
    if (!cur) throw new Error(`project not found: ${id}`);
    const next = {
      name: patch.name ?? cur.name,
      skillId: patch.skillId !== undefined ? patch.skillId : cur.skillId,
      designSystemId: patch.designSystemId !== undefined ? patch.designSystemId : cur.designSystemId,
    };
    this.db
      .prepare(
        `UPDATE projects SET name = ?, skill_id = ?, design_system_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(next.name, next.skillId, next.designSystemId, this.clock.now(), id);
    return this.getProject(id)!;
  }

  setArchived(id: string, archived: boolean): Project | null {
    this.db.prepare(`UPDATE projects SET archived_at = ? WHERE id = ?`).run(archived ? this.clock.now() : null, id);
    return this.getProject(id);
  }

  deleteProject(id: string): void {
    this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
  }

  // ── moodboards ────────────────────────────────────────────────────────────
  createMoodboard(input: CreateMoodboardInput): Moodboard {
    const id = this.clock.id();
    const now = this.clock.now();
    this.db
      .prepare(`INSERT INTO moodboards (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(id, input.name, now, now);
    return this.getMoodboard(id)!;
  }

  getMoodboard(id: string): Moodboard | null {
    const r = this.db.prepare(`SELECT * FROM moodboards WHERE id = ?`).get(id) as Row | undefined;
    return r ? asMoodboard(r) : null;
  }

  listMoodboards(): Moodboard[] {
    const rows = this.db.prepare(`SELECT * FROM moodboards ORDER BY updated_at DESC, rowid DESC`).all() as Row[];
    return rows.map(asMoodboard);
  }

  updateMoodboard(
    id: string,
    patch: Partial<Pick<Moodboard, "name" | "archivedAt" | "coverAssetId">>,
  ): Moodboard {
    const cur = this.getMoodboard(id);
    if (!cur) throw new Error(`moodboard not found: ${id}`);
    this.db
      .prepare(`UPDATE moodboards SET name = ?, archived_at = ?, cover_asset_id = ?, updated_at = ? WHERE id = ?`)
      .run(
        patch.name ?? cur.name,
        patch.archivedAt !== undefined ? patch.archivedAt : cur.archivedAt,
        patch.coverAssetId !== undefined ? patch.coverAssetId : cur.coverAssetId,
        this.clock.now(),
        id,
      );
    return this.getMoodboard(id)!;
  }

  setMoodboardArchived(id: string, archived: boolean): Moodboard | null {
    this.db
      .prepare(`UPDATE moodboards SET archived_at = ?, updated_at = ? WHERE id = ?`)
      .run(archived ? this.clock.now() : null, this.clock.now(), id);
    return this.getMoodboard(id);
  }

  deleteMoodboard(id: string): void {
    this.db.prepare(`DELETE FROM moodboards WHERE id = ?`).run(id);
  }

  listMoodboardNodes(boardId: string): MoodboardNode[] {
    const rows = this.db
      .prepare(`SELECT * FROM moodboard_nodes WHERE board_id = ? ORDER BY z_index ASC, created_at ASC, rowid ASC`)
      .all(boardId) as Row[];
    return rows.map(asMoodboardNode);
  }

  replaceMoodboardNodes(boardId: string, nodes: SaveMoodboardNodeInput[]): MoodboardNode[] {
    if (!this.getMoodboard(boardId)) throw new Error(`moodboard not found: ${boardId}`);
    const now = this.clock.now();
    const existingRows = this.db.prepare(`SELECT id, created_at FROM moodboard_nodes WHERE board_id = ?`).all(boardId) as Row[];
    const existingCreatedAt = new Map(existingRows.map((r) => [r.id as string, Number(r.created_at)]));
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`DELETE FROM moodboard_nodes WHERE board_id = ?`).run(boardId);
      const stmt = this.db.prepare(
        `INSERT INTO moodboard_nodes (
           id, board_id, type, x, y, width, height, rotation, z_index, data_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const [index, node] of nodes.entries()) {
        const id = node.id || this.clock.id();
        const createdAt = existingCreatedAt.get(id) ?? now;
        stmt.run(
          id,
          boardId,
          node.type,
          Number.isFinite(node.x) ? node.x : 0,
          Number.isFinite(node.y) ? node.y : 0,
          Number.isFinite(node.width) ? Math.max(32, node.width) : 240,
          Number.isFinite(node.height) ? Math.max(32, node.height) : 180,
          Number.isFinite(node.rotation ?? 0) ? (node.rotation ?? 0) : 0,
          Number.isFinite(node.zIndex ?? index) ? (node.zIndex ?? index) : index,
          JSON.stringify(node.data ?? {}),
          createdAt,
          now,
        );
      }
      this.db.prepare(`UPDATE moodboards SET updated_at = ? WHERE id = ?`).run(now, boardId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.listMoodboardNodes(boardId);
  }

  createMoodboardAsset(
    boardId: string,
    input: Pick<MoodboardAsset, "kind" | "fileName" | "mimeType" | "width" | "height" | "source">,
  ): MoodboardAsset {
    if (!this.getMoodboard(boardId)) throw new Error(`moodboard not found: ${boardId}`);
    const id = this.clock.id();
    const now = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO moodboard_assets (id, board_id, kind, file_name, mime_type, width, height, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, boardId, input.kind, input.fileName, input.mimeType, input.width, input.height, input.source, now);
    this.db.prepare(`UPDATE moodboards SET updated_at = ?, cover_asset_id = COALESCE(cover_asset_id, ?) WHERE id = ?`).run(now, id, boardId);
    return this.getMoodboardAsset(id)!;
  }

  getMoodboardAsset(id: string): MoodboardAsset | null {
    const r = this.db.prepare(`SELECT * FROM moodboard_assets WHERE id = ?`).get(id) as Row | undefined;
    return r ? asMoodboardAsset(r) : null;
  }

  listMoodboardAssets(boardId: string): MoodboardAsset[] {
    const rows = this.db
      .prepare(`SELECT * FROM moodboard_assets WHERE board_id = ? ORDER BY created_at DESC, rowid DESC`)
      .all(boardId) as Row[];
    return rows.map(asMoodboardAsset);
  }

  private adoptMoodboardLegacyMessages(boardId: string, conversationId: string): void {
    this.db
      .prepare(`UPDATE moodboard_messages SET conversation_id = ? WHERE board_id = ? AND conversation_id IS NULL`)
      .run(conversationId, boardId);
  }

  ensureMoodboardConversation(boardId: string): MoodboardConversation {
    if (!this.getMoodboard(boardId)) throw new Error(`moodboard not found: ${boardId}`);
    const existing = this.db
      .prepare(`SELECT * FROM moodboard_conversations WHERE board_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1`)
      .get(boardId) as Row | undefined;
    const conversation = existing ? asMoodboardConversation(existing) : this.createMoodboardConversation(boardId, "Conversation 1");
    this.adoptMoodboardLegacyMessages(boardId, conversation.id);
    return conversation;
  }

  createMoodboardConversation(boardId: string, title = "Conversation 1"): MoodboardConversation {
    if (!this.getMoodboard(boardId)) throw new Error(`moodboard not found: ${boardId}`);
    const id = this.clock.id();
    const now = this.clock.now();
    this.db
      .prepare(`INSERT INTO moodboard_conversations (id, board_id, title, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, boardId, title.trim() || "Conversation 1", now);
    this.db.prepare(`UPDATE moodboards SET updated_at = ? WHERE id = ?`).run(now, boardId);
    const r = this.db.prepare(`SELECT * FROM moodboard_conversations WHERE id = ?`).get(id) as Row;
    return asMoodboardConversation(r);
  }

  getMoodboardConversation(id: string): MoodboardConversation | null {
    const r = this.db.prepare(`SELECT * FROM moodboard_conversations WHERE id = ?`).get(id) as Row | undefined;
    return r ? asMoodboardConversation(r) : null;
  }

  listMoodboardConversations(boardId: string): MoodboardConversation[] {
    this.ensureMoodboardConversation(boardId);
    const rows = this.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM moodboard_messages m WHERE m.conversation_id = c.id AND m.role = 'user') AS turns
         FROM moodboard_conversations c WHERE c.board_id = ? ORDER BY c.created_at ASC, c.rowid ASC`,
      )
      .all(boardId) as Row[];
    return rows.map(asMoodboardConversation);
  }

  renameMoodboardConversation(id: string, title: string): MoodboardConversation | null {
    this.db.prepare(`UPDATE moodboard_conversations SET title = ? WHERE id = ?`).run(title.trim() || "Conversation 1", id);
    return this.getMoodboardConversation(id);
  }

  deleteMoodboardConversation(id: string): void {
    const conversation = this.getMoodboardConversation(id);
    this.db.prepare(`DELETE FROM moodboard_conversations WHERE id = ?`).run(id);
    if (conversation) this.ensureMoodboardConversation(conversation.boardId);
  }

  addMoodboardMessage(boardId: string, role: MessageRole, content: string, conversationId?: string): MoodboardMessage {
    if (!this.getMoodboard(boardId)) throw new Error(`moodboard not found: ${boardId}`);
    const conversation = conversationId ? this.getMoodboardConversation(conversationId) : this.ensureMoodboardConversation(boardId);
    if (!conversation || conversation.boardId !== boardId) throw new Error(`moodboard conversation not found: ${conversationId}`);
    const id = this.clock.id();
    const now = this.clock.now();
    this.db
      .prepare(`INSERT INTO moodboard_messages (id, board_id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, boardId, conversation.id, role, content, now);
    this.db.prepare(`UPDATE moodboards SET updated_at = ? WHERE id = ?`).run(now, boardId);
    const r = this.db.prepare(`SELECT * FROM moodboard_messages WHERE id = ?`).get(id) as Row;
    return asMoodboardMessage(r);
  }

  listMoodboardMessages(boardId: string, conversationId?: string): MoodboardMessage[] {
    const conversation = conversationId ? this.getMoodboardConversation(conversationId) : this.ensureMoodboardConversation(boardId);
    if (!conversation || conversation.boardId !== boardId) throw new Error(`moodboard conversation not found: ${conversationId}`);
    const rows = this.db
      .prepare(`SELECT * FROM moodboard_messages WHERE board_id = ? AND conversation_id = ? ORDER BY created_at ASC, rowid ASC`)
      .all(boardId, conversation.id) as Row[];
    return rows.map(asMoodboardMessage);
  }

  // ── custom effects ─────────────────────────────────────────────────────────
  createEffect(input: CreateEffectInput): Effect {
    const id = this.clock.id();
    const now = this.clock.now();
    const name = input.name.trim() || "Untitled effect";
    this.db
      .prepare(
        `INSERT INTO custom_effects (id, name, category, summary, code, parameters_json, presets_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        name,
        input.category?.trim() || "Custom",
        input.summary?.trim() || "Editable local effect.",
        input.code?.trim() || "function renderEffect(ctx) { ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height); }",
        JSON.stringify(input.parameters ?? []),
        JSON.stringify(input.presets ?? []),
        now,
        now,
      );
    return this.getEffect(id)!;
  }

  getEffect(id: string): Effect | null {
    const r = this.db.prepare(`SELECT * FROM custom_effects WHERE id = ?`).get(id) as Row | undefined;
    return r ? asEffect(r) : null;
  }

  listEffects(): Effect[] {
    const rows = this.db.prepare(`SELECT * FROM custom_effects ORDER BY updated_at DESC, rowid DESC`).all() as Row[];
    return rows.map(asEffect);
  }

  updateEffect(id: string, patch: UpdateEffectInput): Effect {
    const cur = this.getEffect(id);
    if (!cur) throw new Error(`effect not found: ${id}`);
    this.db
      .prepare(
        `UPDATE custom_effects
         SET name = ?, category = ?, summary = ?, code = ?, parameters_json = ?, presets_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.name !== undefined ? patch.name.trim() || cur.name : cur.name,
        patch.category !== undefined ? patch.category.trim() || cur.category : cur.category,
        patch.summary !== undefined ? patch.summary.trim() : cur.summary,
        patch.code !== undefined ? patch.code : cur.code,
        JSON.stringify(patch.parameters ?? cur.parameters),
        JSON.stringify(patch.presets ?? cur.presets),
        this.clock.now(),
        id,
      );
    return this.getEffect(id)!;
  }

  deleteEffect(id: string): void {
    this.db.prepare(`DELETE FROM custom_effects WHERE id = ?`).run(id);
  }

  // ── variants (design branches) ──────────────────────────────────────────────
  /** Get the active branch, creating/adopting a "Main" branch for legacy projects. */
  ensureMainVariant(projectId: string): Variant {
    const active = this.getActiveVariantId(projectId);
    if (active) {
      const r = this.db.prepare(`SELECT * FROM variants WHERE id = ?`).get(active) as Row | undefined;
      if (r) return asVariant(r);
    }
    const existing = this.db
      .prepare(`SELECT * FROM variants WHERE project_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1`)
      .get(projectId) as Row | undefined;
    const v = existing ? asVariant(existing) : this.createVariant(projectId, "Main");
    if (!existing) {
      // First branch for a legacy project — attribute its existing runs to Main.
      this.db.prepare(`UPDATE runs SET variant_id = ? WHERE project_id = ? AND variant_id IS NULL`).run(v.id, projectId);
    }
    this.setActiveVariant(projectId, v.id);
    return v;
  }

  getActiveVariantId(projectId: string): string | null {
    const r = this.db.prepare(`SELECT active_variant_id FROM projects WHERE id = ?`).get(projectId) as Row | undefined;
    return (r?.active_variant_id as string | null) ?? null;
  }

  getVariant(id: string): Variant | null {
    const r = this.db.prepare(`SELECT * FROM variants WHERE id = ?`).get(id) as Row | undefined;
    return r ? asVariant(r) : null;
  }

  listVariants(projectId: string): Variant[] {
    const active = this.getActiveVariantId(projectId);
    const rows = this.db
      .prepare(`SELECT * FROM variants WHERE project_id = ? ORDER BY created_at ASC, rowid ASC`)
      .all(projectId) as Row[];
    return rows.map((r) => ({ ...asVariant(r), active: r.id === active }));
  }

  createVariant(projectId: string, name = "Variant"): Variant {
    const id = this.clock.id();
    this.db.prepare(`INSERT INTO variants (id, project_id, name, created_at) VALUES (?, ?, ?, ?)`).run(id, projectId, name, this.clock.now());
    return asVariant(this.db.prepare(`SELECT * FROM variants WHERE id = ?`).get(id) as Row);
  }

  createImportedVariant(projectId: string, input: { name: string; createdAt?: number }): Variant {
    const id = this.clock.id();
    const createdAt = Number.isFinite(input.createdAt) ? Number(input.createdAt) : this.clock.now();
    this.db.prepare(`INSERT INTO variants (id, project_id, name, created_at) VALUES (?, ?, ?, ?)`).run(id, projectId, input.name, createdAt);
    return asVariant(this.db.prepare(`SELECT * FROM variants WHERE id = ?`).get(id) as Row);
  }

  renameVariant(id: string, name: string): Variant | null {
    this.db.prepare(`UPDATE variants SET name = ? WHERE id = ?`).run(name, id);
    return this.getVariant(id);
  }

  deleteVariant(id: string): void {
    this.db.prepare(`DELETE FROM runs WHERE variant_id = ?`).run(id);
    this.db.prepare(`DELETE FROM variants WHERE id = ?`).run(id);
  }

  setActiveVariant(projectId: string, variantId: string): void {
    this.db.prepare(`UPDATE projects SET active_variant_id = ? WHERE id = ?`).run(variantId, projectId);
  }

  // ── conversations ───────────────────────────────────────────────────────────
  createConversation(projectId: string, title = "Untitled"): Conversation {
    const id = this.clock.id();
    this.db
      .prepare(`INSERT INTO conversations (id, project_id, title, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, projectId, title, this.clock.now());
    const r = this.db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as Row;
    return asConversation(r);
  }

  createImportedConversation(projectId: string, input: { title: string; createdAt?: number }): Conversation {
    const id = this.clock.id();
    const createdAt = Number.isFinite(input.createdAt) ? Number(input.createdAt) : this.clock.now();
    this.db
      .prepare(`INSERT INTO conversations (id, project_id, title, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, projectId, input.title, createdAt);
    const r = this.db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as Row;
    return asConversation(r);
  }

  getConversation(id: string): Conversation | null {
    const r = this.db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as Row | undefined;
    return r ? asConversation(r) : null;
  }

  listConversations(projectId: string): Conversation[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') AS turns
         FROM conversations c WHERE c.project_id = ? ORDER BY c.created_at ASC, c.rowid ASC`,
      )
      .all(projectId) as Row[];
    return rows.map((r) => ({ ...asConversation(r), turns: Number(r.turns ?? 0) }));
  }

  renameConversation(id: string, title: string): Conversation | null {
    this.db.prepare(`UPDATE conversations SET title = ? WHERE id = ?`).run(title, id);
    return this.getConversation(id);
  }

  deleteConversation(id: string): void {
    this.db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
  }

  // ── messages ────────────────────────────────────────────────────────────────
  addMessage(conversationId: string, role: MessageRole, content: string): Message {
    const id = this.clock.id();
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, conversationId, role, content, this.clock.now());
    const r = this.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as Row;
    return asMessage(r);
  }

  /** Replace a message's content in place (e.g., the live-research card as it accrues activities). */
  updateMessage(id: string, content: string): void {
    this.db.prepare(`UPDATE messages SET content = ? WHERE id = ?`).run(content, id);
  }

  addImportedMessage(conversationId: string, input: { role: MessageRole; content: string; createdAt?: number }): Message {
    const id = this.clock.id();
    const createdAt = Number.isFinite(input.createdAt) ? Number(input.createdAt) : this.clock.now();
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, conversationId, input.role, input.content, createdAt);
    const r = this.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as Row;
    return asMessage(r);
  }

  getMessage(id: string): Message | null {
    const r = this.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as Row | undefined;
    return r ? asMessage(r) : null;
  }

  listMessages(conversationId: string): Message[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC`)
      .all(conversationId) as Row[];
    return rows.map(asMessage);
  }

  listMessagesThrough(conversationId: string, messageId: string): Message[] {
    const target = this.db
      .prepare(`SELECT rowid, created_at FROM messages WHERE id = ? AND conversation_id = ?`)
      .get(messageId, conversationId) as Row | undefined;
    if (!target) return [];
    const createdAt = Number(target.created_at);
    const rowid = Number(target.rowid);
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE conversation_id = ?
           AND (created_at < ? OR (created_at = ? AND rowid <= ?))
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(conversationId, createdAt, createdAt, rowid) as Row[];
    return rows.map(asMessage);
  }

  // ── runs ──────────────────────────────────────────────────────────────────
  createRun(
    projectId: string,
    conversationId: string,
    variantId?: string,
    userMessageId?: string,
    ownerId?: string,
    attribution?: { model?: string | null; agentCommand?: string | null; skillId?: string | null },
  ): Run {
    const id = this.clock.id();
    const vid = variantId ?? this.ensureMainVariant(projectId).id;
    this.db
      .prepare(
        `INSERT INTO runs (id, project_id, conversation_id, variant_id, user_message_id, owner_id, status, created_at, model, agent_command, skill_id)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(
        id,
        projectId,
        conversationId,
        vid,
        userMessageId ?? null,
        ownerId ?? null,
        this.clock.now(),
        attribution?.model ?? null,
        attribution?.agentCommand ?? null,
        attribution?.skillId ?? null,
      );
    return this.getRun(id)!;
  }

  /** Record (or clear) the user's feedback verdict + gap tag on a run. */
  setRunFeedback(id: string, feedback: RunFeedback | null): Run {
    if (!this.getRun(id)) throw new Error(`run not found: ${id}`);
    this.db.prepare(`UPDATE runs SET feedback = ? WHERE id = ?`).run(feedback ? JSON.stringify(feedback) : null, id);
    return this.getRun(id)!;
  }

  createImportedRun(
    projectId: string,
    conversationId: string,
    input: {
      variantId?: string | null;
      userMessageId?: string | null;
      assistantMessageId?: string | null;
      commitHash?: string | null;
      status?: RunStatus;
      repairRounds?: number;
      lintPassed?: boolean;
      score?: number | null;
      findings?: QualityFinding[];
      createdAt?: number;
      finishedAt?: number | null;
      model?: string | null;
      agentCommand?: string | null;
      skillId?: string | null;
    },
  ): Run {
    const id = this.clock.id();
    const createdAt = Number.isFinite(input.createdAt) ? Number(input.createdAt) : this.clock.now();
    const finishedAt = input.finishedAt == null || !Number.isFinite(input.finishedAt) ? null : Number(input.finishedAt);
    const status = input.status ?? "cancelled";
    this.db
      .prepare(
        `INSERT INTO runs (
           id, project_id, conversation_id, variant_id, user_message_id, assistant_message_id, commit_hash,
           status, repair_rounds, lint_passed, score, final_findings, created_at, finished_at,
           model, agent_command, skill_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        projectId,
        conversationId,
        input.variantId ?? null,
        input.userMessageId ?? null,
        input.assistantMessageId ?? null,
        input.commitHash ?? null,
        status,
        Math.max(0, Math.floor(input.repairRounds ?? 0)),
        input.lintPassed ? 1 : 0,
        input.score ?? null,
        JSON.stringify(input.findings ?? []),
        createdAt,
        finishedAt,
        input.model ?? null,
        input.agentCommand ?? null,
        input.skillId ?? null,
      );
    return this.getRun(id)!;
  }

  getRun(id: string): Run | null {
    const r = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as Row | undefined;
    return r ? asRun(r) : null;
  }

  updateRun(
    id: string,
    patch: Partial<
      Pick<Run, "status" | "repairRounds" | "lintPassed" | "score" | "findings" | "finishedAt" | "userMessageId" | "assistantMessageId" | "commitHash">
    >,
  ): Run {
    const cur = this.getRun(id);
    if (!cur) throw new Error(`run not found: ${id}`);
    const next = {
      status: patch.status ?? cur.status,
      repairRounds: patch.repairRounds ?? cur.repairRounds,
      lintPassed: patch.lintPassed ?? cur.lintPassed,
      score: patch.score !== undefined ? patch.score : cur.score,
      findings: patch.findings !== undefined ? patch.findings : cur.findings,
      finishedAt: patch.finishedAt !== undefined ? patch.finishedAt : cur.finishedAt,
      userMessageId: patch.userMessageId !== undefined ? patch.userMessageId : cur.userMessageId,
      assistantMessageId: patch.assistantMessageId !== undefined ? patch.assistantMessageId : cur.assistantMessageId,
      commitHash: patch.commitHash !== undefined ? patch.commitHash : cur.commitHash,
    };
    this.db
      .prepare(
        `UPDATE runs SET status = ?, repair_rounds = ?, lint_passed = ?, score = ?, final_findings = ?, finished_at = ?, user_message_id = ?, assistant_message_id = ?, commit_hash = ? WHERE id = ?`,
      )
      .run(
        next.status,
        next.repairRounds,
        next.lintPassed ? 1 : 0,
        next.score,
        JSON.stringify(next.findings),
        next.finishedAt,
        next.userMessageId,
        next.assistantMessageId,
        next.commitHash,
        id,
      );
    return this.getRun(id)!;
  }

  findSucceededRunForAssistantMessage(messageId: string): Run | null {
    const exact = this.db
      .prepare(`SELECT * FROM runs WHERE assistant_message_id = ? AND status = 'succeeded' ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(messageId) as Row | undefined;
    if (exact) return asRun(exact);

    const fallback = this.db
      .prepare(
        `SELECT r.* FROM runs r
         JOIN messages m ON m.id = ?
         WHERE r.conversation_id = m.conversation_id
           AND r.status = 'succeeded'
           AND r.created_at <= m.created_at
         ORDER BY r.created_at DESC, r.rowid DESC
         LIMIT 1`,
      )
      .get(messageId) as Row | undefined;
    return fallback ? asRun(fallback) : null;
  }

  /** Mark runs left "running"/"pending" (a previous process died mid-run) as cancelled. Run
   *  at daemon startup so interrupted runs don't look perpetually in-progress. */
  findActiveRun(projectId: string, variantId?: string | null): Run | null {
    const row =
      variantId == null
        ? (this.db
            .prepare(
              `SELECT * FROM runs
               WHERE project_id = ? AND variant_id IS NULL AND status IN ('running', 'pending')
               ORDER BY created_at DESC, rowid DESC LIMIT 1`,
            )
            .get(projectId) as Row | undefined)
        : (this.db
            .prepare(
              `SELECT * FROM runs
               WHERE project_id = ? AND variant_id = ? AND status IN ('running', 'pending')
               ORDER BY created_at DESC, rowid DESC LIMIT 1`,
            )
            .get(projectId, variantId) as Row | undefined);
    return row ? asRun(row) : null;
  }

  markInterruptedRuns(ownerId?: string): number {
    const res = ownerId
      ? this.db
          .prepare(`UPDATE runs SET status = 'cancelled', finished_at = ? WHERE status IN ('running', 'pending') AND owner_id = ?`)
          .run(this.clock.now(), ownerId)
      : this.db.prepare(`UPDATE runs SET status = 'cancelled', finished_at = ? WHERE status IN ('running', 'pending')`).run(this.clock.now());
    return Number(res.changes ?? 0);
  }

  /** A project's runs, newest-first (createdAt desc, rowid desc tiebreak). */
  listRuns(projectId: string, variantId?: string): Run[] {
    const rows = variantId
      ? (this.db
          .prepare(`SELECT * FROM runs WHERE project_id = ? AND variant_id = ? ORDER BY created_at DESC, rowid DESC`)
          .all(projectId, variantId) as Row[])
      : (this.db.prepare(`SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC`).all(projectId) as Row[]);
    return rows.map(asRun);
  }

  /** Add a persistent quality false-positive suppression (selector null = suppress the whole rule). */
  addQualityIgnore(projectId: string, ruleId: string, selector: string | null = null): QualityIgnoreEntry {
    const id = this.clock.id();
    const createdAt = this.clock.now();
    this.db
      .prepare(`INSERT INTO quality_ignores (id, project_id, rule_id, selector, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, projectId, ruleId, selector, createdAt);
    return { id, projectId, ruleId, selector, createdAt };
  }

  listQualityIgnores(projectId: string): QualityIgnoreEntry[] {
    const rows = this.db.prepare(`SELECT * FROM quality_ignores WHERE project_id = ? ORDER BY created_at DESC`).all(projectId) as Row[];
    return rows.map((r) => ({
      id: r.id as string,
      projectId: r.project_id as string,
      ruleId: r.rule_id as string,
      selector: (r.selector as string | null) ?? null,
      createdAt: r.created_at as number,
    }));
  }

  removeQualityIgnore(id: string): void {
    this.db.prepare(`DELETE FROM quality_ignores WHERE id = ?`).run(id);
  }

  /** Recent runs the user marked 👍 (most recent first) — exemplars to ground future builds. */
  listUpvotedRuns(projectId: string, limit = 3): Run[] {
    const rows = this.db
      .prepare(`SELECT * FROM runs WHERE project_id = ? AND status = 'succeeded' AND feedback IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(projectId, Math.max(1, limit) * 4) as Row[];
    return rows
      .map(asRun)
      .filter((r) => r.feedback?.verdict === "up")
      .slice(0, Math.max(1, limit));
  }

  /** Recent 👍 runs across ALL projects (optionally by skill) — cross-project exemplars. */
  listExemplarRuns(opts: { skillId?: string; excludeProjectId?: string; limit?: number } = {}): Run[] {
    const limit = Math.max(1, opts.limit ?? 3);
    const rows = this.db
      .prepare(`SELECT * FROM runs WHERE status = 'succeeded' AND feedback IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(limit * 8) as Row[];
    return rows
      .map(asRun)
      .filter((r) => r.feedback?.verdict === "up")
      .filter((r) => (opts.excludeProjectId ? r.projectId !== opts.excludeProjectId : true))
      .filter((r) => (opts.skillId ? r.skillId === opts.skillId : true))
      .slice(0, limit);
  }

  /** Recent runs carrying any user feedback (👍 or 👎), most recent first — for reflection. */
  listFeedbackRuns(limit = 40): Run[] {
    const rows = this.db
      .prepare(`SELECT * FROM runs WHERE feedback IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(Math.max(1, limit)) as Row[];
    return rows.map(asRun).filter((r) => r.feedback !== null);
  }

  // ── artifacts ───────────────────────────────────────────────────────────────
  recordArtifact(projectId: string, path: string, lintPassed: boolean): Artifact {
    const id = this.clock.id();
    this.db
      .prepare(
        `INSERT INTO artifacts (id, project_id, path, lint_passed, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, projectId, path, lintPassed ? 1 : 0, this.clock.now());
    const r = this.db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id) as Row;
    return asArtifact(r);
  }

  importArtifact(projectId: string, input: { path: string; lintPassed: boolean; createdAt?: number }): Artifact {
    const id = this.clock.id();
    const createdAt = Number.isFinite(input.createdAt) ? Number(input.createdAt) : this.clock.now();
    this.db
      .prepare(
        `INSERT INTO artifacts (id, project_id, path, lint_passed, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, projectId, input.path, input.lintPassed ? 1 : 0, createdAt);
    const r = this.db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id) as Row;
    return asArtifact(r);
  }

  listArtifacts(projectId: string): Artifact[] {
    const rows = this.db
      .prepare(`SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at DESC, rowid DESC`)
      .all(projectId) as Row[];
    return rows.map(asArtifact);
  }

  // ── settings (single row) ─────────────────────────────────────────────────
  getSettings(): Settings {
    const r = this.db.prepare(`SELECT * FROM settings WHERE id = 'app'`).get() as Row | undefined;
    if (!r) return { ...DEFAULT_SETTINGS };
    const str = (v: unknown, d: string): string => (typeof v === "string" ? v : d);
    const int = (v: unknown, d: number): number => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : d;
    };
    return {
      agentCommand: str(r.agent_command, DEFAULT_SETTINGS.agentCommand),
      model: str(r.model, DEFAULT_SETTINGS.model),
      apiBaseUrl: str(r.api_base_url, DEFAULT_SETTINGS.apiBaseUrl),
      apiKey: str(r.api_key, DEFAULT_SETTINGS.apiKey),
      defaultDesignSystemId: str(r.default_design_system_id, DEFAULT_SETTINGS.defaultDesignSystemId),
      customInstructions: str(r.custom_instructions, DEFAULT_SETTINGS.customInstructions),
      imageApiBaseUrl: str(r.image_api_base_url, DEFAULT_SETTINGS.imageApiBaseUrl),
      imageApiKey: str(r.image_api_key, DEFAULT_SETTINGS.imageApiKey),
      imageModel: str(r.image_model, DEFAULT_SETTINGS.imageModel),
      removeBackgroundModel: str(r.remove_background_model, DEFAULT_SETTINGS.removeBackgroundModel),
      editRegionModel: str(r.edit_region_model, DEFAULT_SETTINGS.editRegionModel),
      extractLayerModel: str(r.extract_layer_model, DEFAULT_SETTINGS.extractLayerModel),
      videoApiBaseUrl: str(r.video_api_base_url, DEFAULT_SETTINGS.videoApiBaseUrl),
      videoApiKey: str(r.video_api_key, DEFAULT_SETTINGS.videoApiKey),
      videoModel: str(r.video_model, DEFAULT_SETTINGS.videoModel),
      aiProviderId: str(r.ai_provider_id, DEFAULT_SETTINGS.aiProviderId),
      aiProviderEnabled: Number(r.ai_provider_enabled ?? 0) === 1,
      aiProviderModels: str(r.ai_provider_models, DEFAULT_SETTINGS.aiProviderModels),
      aiProviderOrganization: str(r.ai_provider_organization, DEFAULT_SETTINGS.aiProviderOrganization),
      aiProviderProfiles: str(r.ai_provider_profiles, DEFAULT_SETTINGS.aiProviderProfiles),
      visualQaEnabled: Number(r.visual_qa_enabled ?? 0) === 1,
      autoFixLiveRuntimeErrors: Number(r.auto_fix_live_runtime_errors ?? 0) === 1,
      researchEnabled: Number(r.research_enabled ?? 0) === 1,
      visualQaAgentCommand: str(r.visual_qa_agent_command, DEFAULT_SETTINGS.visualQaAgentCommand),
      visualQaModel: str(r.visual_qa_model, DEFAULT_SETTINGS.visualQaModel),
      autoImproveEnabled: Number(r.auto_improve_enabled ?? 1) === 1,
      autoImproveMaxRounds: int(r.auto_improve_max_rounds, DEFAULT_SETTINGS.autoImproveMaxRounds),
    };
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const cur = this.getSettings();
    const next: Settings = {
      agentCommand: patch.agentCommand ?? cur.agentCommand,
      model: patch.model ?? cur.model,
      apiBaseUrl: patch.apiBaseUrl ?? cur.apiBaseUrl,
      apiKey: patch.apiKey ?? cur.apiKey,
      defaultDesignSystemId: patch.defaultDesignSystemId ?? cur.defaultDesignSystemId,
      customInstructions: patch.customInstructions ?? cur.customInstructions,
      imageApiBaseUrl: patch.imageApiBaseUrl ?? cur.imageApiBaseUrl,
      imageApiKey: patch.imageApiKey ?? cur.imageApiKey,
      imageModel: patch.imageModel ?? cur.imageModel,
      removeBackgroundModel: patch.removeBackgroundModel ?? cur.removeBackgroundModel,
      editRegionModel: patch.editRegionModel ?? cur.editRegionModel,
      extractLayerModel: patch.extractLayerModel ?? cur.extractLayerModel,
      videoApiBaseUrl: patch.videoApiBaseUrl ?? cur.videoApiBaseUrl,
      videoApiKey: patch.videoApiKey ?? cur.videoApiKey,
      videoModel: patch.videoModel ?? cur.videoModel,
      aiProviderId: patch.aiProviderId ?? cur.aiProviderId,
      aiProviderEnabled: patch.aiProviderEnabled ?? cur.aiProviderEnabled,
      aiProviderModels: patch.aiProviderModels ?? cur.aiProviderModels,
      aiProviderOrganization: patch.aiProviderOrganization ?? cur.aiProviderOrganization,
      aiProviderProfiles: patch.aiProviderProfiles ?? cur.aiProviderProfiles,
      visualQaEnabled: patch.visualQaEnabled ?? cur.visualQaEnabled,
      autoFixLiveRuntimeErrors: patch.autoFixLiveRuntimeErrors ?? cur.autoFixLiveRuntimeErrors,
      visualQaAgentCommand: patch.visualQaAgentCommand ?? cur.visualQaAgentCommand,
      visualQaModel: patch.visualQaModel ?? cur.visualQaModel,
      autoImproveEnabled: patch.autoImproveEnabled ?? cur.autoImproveEnabled,
      autoImproveMaxRounds: patch.autoImproveMaxRounds ?? cur.autoImproveMaxRounds,
      researchEnabled: patch.researchEnabled ?? cur.researchEnabled,
    };
    this.db
      .prepare(
        `INSERT INTO settings (id, agent_command, model, api_base_url, api_key, default_design_system_id, custom_instructions,
                               image_api_base_url, image_api_key, image_model, remove_background_model, edit_region_model, extract_layer_model,
                               video_api_base_url, video_api_key, video_model,
                               ai_provider_id, ai_provider_enabled, ai_provider_models, ai_provider_organization, ai_provider_profiles,
                               visual_qa_enabled, auto_fix_live_runtime_errors, visual_qa_agent_command, visual_qa_model, auto_improve_enabled, auto_improve_max_rounds, research_enabled)
         VALUES ('app', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           agent_command = excluded.agent_command,
           model = excluded.model,
           api_base_url = excluded.api_base_url,
           api_key = excluded.api_key,
           default_design_system_id = excluded.default_design_system_id,
           custom_instructions = excluded.custom_instructions,
           image_api_base_url = excluded.image_api_base_url,
           image_api_key = excluded.image_api_key,
           image_model = excluded.image_model,
           remove_background_model = excluded.remove_background_model,
           edit_region_model = excluded.edit_region_model,
           extract_layer_model = excluded.extract_layer_model,
           video_api_base_url = excluded.video_api_base_url,
           video_api_key = excluded.video_api_key,
           video_model = excluded.video_model,
           ai_provider_id = excluded.ai_provider_id,
           ai_provider_enabled = excluded.ai_provider_enabled,
           ai_provider_models = excluded.ai_provider_models,
           ai_provider_organization = excluded.ai_provider_organization,
           ai_provider_profiles = excluded.ai_provider_profiles,
           visual_qa_enabled = excluded.visual_qa_enabled,
           auto_fix_live_runtime_errors = excluded.auto_fix_live_runtime_errors,
           visual_qa_agent_command = excluded.visual_qa_agent_command,
           visual_qa_model = excluded.visual_qa_model,
           auto_improve_enabled = excluded.auto_improve_enabled,
           auto_improve_max_rounds = excluded.auto_improve_max_rounds,
           research_enabled = excluded.research_enabled`,
      )
      .run(
        next.agentCommand,
        next.model,
        next.apiBaseUrl,
        next.apiKey,
        next.defaultDesignSystemId,
        next.customInstructions,
        next.imageApiBaseUrl,
        next.imageApiKey,
        next.imageModel,
        next.removeBackgroundModel,
        next.editRegionModel,
        next.extractLayerModel,
        next.videoApiBaseUrl,
        next.videoApiKey,
        next.videoModel,
        next.aiProviderId,
        next.aiProviderEnabled ? 1 : 0,
        next.aiProviderModels,
        next.aiProviderOrganization,
        next.aiProviderProfiles,
        next.visualQaEnabled ? 1 : 0,
        next.autoFixLiveRuntimeErrors ? 1 : 0,
        next.visualQaAgentCommand,
        next.visualQaModel,
        next.autoImproveEnabled ? 1 : 0,
        next.autoImproveMaxRounds,
        next.researchEnabled ? 1 : 0,
      );
    return next;
  }
}
