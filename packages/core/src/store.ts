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
  Artifact,
  MessageRole,
  QualityFinding,
  RunStatus,
  CreateProjectInput,
  Settings,
} from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  skill_id TEXT,
  design_system_id TEXT,
  mode TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
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
  status TEXT NOT NULL,
  repair_rounds INTEGER NOT NULL DEFAULT 0,
  lint_passed INTEGER NOT NULL DEFAULT 0,
  score INTEGER,
  final_findings TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  finished_at INTEGER
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
  visual_qa_enabled INTEGER NOT NULL DEFAULT 0
);
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
  visualQaEnabled: false,
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
function asRun(r: Row): Run {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    conversationId: r.conversation_id as string,
    variantId: (r.variant_id as string | null | undefined) ?? null,
    status: r.status as RunStatus,
    repairRounds: Number(r.repair_rounds),
    lintPassed: Number(r.lint_passed) === 1,
    score: r.score == null ? null : Number(r.score),
    findings: asQualityFindings(r.final_findings),
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
    ensureColumn("settings", "visual_qa_enabled", "visual_qa_enabled INTEGER NOT NULL DEFAULT 0");
    ensureColumn("projects", "archived_at", "archived_at INTEGER");
    ensureColumn("projects", "active_variant_id", "active_variant_id TEXT");
    ensureColumn("runs", "variant_id", "variant_id TEXT");
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

  listMessages(conversationId: string): Message[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC`)
      .all(conversationId) as Row[];
    return rows.map(asMessage);
  }

  // ── runs ──────────────────────────────────────────────────────────────────
  createRun(projectId: string, conversationId: string, variantId?: string): Run {
    const id = this.clock.id();
    const vid = variantId ?? this.ensureMainVariant(projectId).id;
    this.db
      .prepare(
        `INSERT INTO runs (id, project_id, conversation_id, variant_id, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run(id, projectId, conversationId, vid, this.clock.now());
    return this.getRun(id)!;
  }

  getRun(id: string): Run | null {
    const r = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as Row | undefined;
    return r ? asRun(r) : null;
  }

  updateRun(
    id: string,
    patch: Partial<Pick<Run, "status" | "repairRounds" | "lintPassed" | "score" | "findings" | "finishedAt">>,
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
    };
    this.db
      .prepare(
        `UPDATE runs SET status = ?, repair_rounds = ?, lint_passed = ?, score = ?, final_findings = ?, finished_at = ? WHERE id = ?`,
      )
      .run(next.status, next.repairRounds, next.lintPassed ? 1 : 0, next.score, JSON.stringify(next.findings), next.finishedAt, id);
    return this.getRun(id)!;
  }

  /** Mark runs left "running"/"pending" (a previous process died mid-run) as cancelled. Run
   *  at daemon startup so interrupted runs don't look perpetually in-progress. */
  markInterruptedRuns(): number {
    const res = this.db
      .prepare(`UPDATE runs SET status = 'cancelled', finished_at = ? WHERE status IN ('running', 'pending')`)
      .run(this.clock.now());
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
      visualQaEnabled: Number(r.visual_qa_enabled ?? 0) === 1,
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
      visualQaEnabled: patch.visualQaEnabled ?? cur.visualQaEnabled,
    };
    this.db
      .prepare(
        `INSERT INTO settings (id, agent_command, model, api_base_url, api_key, default_design_system_id, custom_instructions,
                               image_api_base_url, image_api_key, image_model,
                               visual_qa_enabled)
         VALUES ('app', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           visual_qa_enabled = excluded.visual_qa_enabled`,
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
        next.visualQaEnabled ? 1 : 0,
      );
    return next;
  }
}
