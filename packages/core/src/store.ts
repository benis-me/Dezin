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
  ExtensionCredentialRecord,
  ExtensionScope,
} from "./types.ts";
import {
  asArtifact,
  asConversation,
  asEffect,
  asExtensionCredential,
  asMessage,
  asMoodboard,
  asMoodboardAsset,
  asMoodboardConversation,
  asMoodboardMessage,
  asMoodboardNode,
  asProject,
  asRun,
  asVariant,
  type Row,
} from "./store-codecs.ts";
import { migrateStoreSchema, STORE_SCHEMA } from "./store-schema.ts";

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
  sharinganAffirmed: false,
  visualQaAgentCommand: "",
  visualQaModel: "",
  autoImproveEnabled: true,
  autoImproveMaxRounds: 8,
  researchEnabled: false,
  researchAgentCommand: "",
  researchModel: "",
};

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
    this.db.exec(STORE_SCHEMA);
    migrateStoreSchema(this.db);
    this.clock = clock;
  }

  close(): void {
    this.db.close();
  }

  createExtensionCredential(input: {
    tokenHash: string;
    extensionId: string;
    scopes: ExtensionScope[];
  }): ExtensionCredentialRecord {
    if (!/^[a-f0-9]{64}$/.test(input.tokenHash)) throw new Error("expected a SHA-256 token hash");
    const id = this.clock.id();
    const now = this.clock.now();
    const scopes = [...new Set(input.scopes)];
    this.db
      .prepare(
        `INSERT INTO extension_credentials (id, token_hash, extension_id, scopes_json, created_at, last_used_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(id, input.tokenHash, input.extensionId, JSON.stringify(scopes), now);
    return this.listExtensionCredentials({ includeRevoked: true }).find((credential) => credential.id === id)!;
  }

  listExtensionCredentials(options: { includeRevoked?: boolean } = {}): ExtensionCredentialRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM extension_credentials
         ${options.includeRevoked ? "" : "WHERE revoked_at IS NULL"}
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all() as Row[];
    return rows.map(asExtensionCredential);
  }

  touchExtensionCredential(id: string): boolean {
    const result = this.db
      .prepare("UPDATE extension_credentials SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(this.clock.now(), id);
    return Number(result.changes) > 0;
  }

  revokeExtensionCredential(id: string): boolean {
    const result = this.db
      .prepare("UPDATE extension_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(this.clock.now(), id);
    return Number(result.changes) > 0;
  }

  // ── projects ──────────────────────────────────────────────────────────────
  createProject(input: CreateProjectInput): Project {
    const id = this.clock.id();
    const now = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO projects (id, name, skill_id, design_system_id, mode, sharingan, source_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.skillId ?? null,
        input.designSystemId ?? null,
        input.mode ?? "prototype",
        input.sharingan ? 1 : 0,
        input.sourceUrl ?? null,
        now,
        now,
      );
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
  createMoodboard(input: CreateMoodboardInput, options: { status?: "starting" | "ready" } = {}): Moodboard {
    const id = this.clock.id();
    const now = this.clock.now();
    this.db
      .prepare(`INSERT INTO moodboards (id, name, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?)`)
      .run(id, input.name, now, now, options.status ?? "ready");
    return this.getMoodboard(id)!;
  }

  getMoodboard(id: string): Moodboard | null {
    const r = this.db.prepare(`SELECT * FROM moodboards WHERE id = ?`).get(id) as Row | undefined;
    return r ? asMoodboard(r) : null;
  }

  getPublishedMoodboard(id: string): Moodboard | null {
    const r = this.db.prepare(`SELECT * FROM moodboards WHERE id = ? AND status = 'ready'`).get(id) as Row | undefined;
    return r ? asMoodboard(r) : null;
  }

  listMoodboards(): Moodboard[] {
    const rows = this.db.prepare(`SELECT * FROM moodboards WHERE status = 'ready' ORDER BY updated_at DESC, rowid DESC`).all() as Row[];
    return rows.map(asMoodboard);
  }

  listStartingMoodboards(): Moodboard[] {
    const rows = this.db.prepare(`SELECT * FROM moodboards WHERE status = 'starting' ORDER BY created_at ASC, rowid ASC`).all() as Row[];
    return rows.map(asMoodboard);
  }

  publishMoodboard(id: string): Moodboard {
    const result = this.db.prepare(`UPDATE moodboards SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'starting'`).run(this.clock.now(), id);
    if (Number(result.changes) === 0) throw new Error(`starting moodboard not found: ${id}`);
    return this.getMoodboard(id)!;
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

  terminalizeRun(
    id: string,
    status: Extract<RunStatus, "succeeded" | "failed" | "cancelled">,
    patch: Partial<
      Pick<Run, "repairRounds" | "lintPassed" | "score" | "findings" | "finishedAt" | "userMessageId" | "assistantMessageId" | "commitHash">
    >,
  ): { changed: boolean; run: Run } {
    const cur = this.getRun(id);
    if (!cur) throw new Error(`run not found: ${id}`);
    const next = {
      repairRounds: patch.repairRounds ?? cur.repairRounds,
      lintPassed: patch.lintPassed ?? cur.lintPassed,
      score: patch.score !== undefined ? patch.score : cur.score,
      findings: patch.findings !== undefined ? patch.findings : cur.findings,
      finishedAt: patch.finishedAt !== undefined ? patch.finishedAt : cur.finishedAt,
      userMessageId: patch.userMessageId !== undefined ? patch.userMessageId : cur.userMessageId,
      assistantMessageId: patch.assistantMessageId !== undefined ? patch.assistantMessageId : cur.assistantMessageId,
      commitHash: patch.commitHash !== undefined ? patch.commitHash : cur.commitHash,
    };
    const result = this.db
      .prepare(
        `UPDATE runs
         SET status = ?, repair_rounds = ?, lint_passed = ?, score = ?, final_findings = ?, finished_at = ?, user_message_id = ?, assistant_message_id = ?, commit_hash = ?
         WHERE id = ? AND status IN ('pending', 'running')`,
      )
      .run(
        status,
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
    const run = this.getRun(id)!;
    return { changed: result.changes === 1, run };
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

  /** Sweep runs left 'running'/'pending' by a dead process to 'cancelled'. Returns the swept runs
   * (id + conversationId) so the caller can persist a terminal message — their transcript is
   * incomplete (the turn never finished), and they are no longer reattached on re-entry. */
  markInterruptedRuns(ownerId?: string): Array<{ id: string; conversationId: string }> {
    const rows = (
      ownerId
        ? this.db.prepare(`SELECT id, conversation_id FROM runs WHERE status IN ('running', 'pending') AND owner_id = ?`).all(ownerId)
        : this.db.prepare(`SELECT id, conversation_id FROM runs WHERE status IN ('running', 'pending')`).all()
    ) as Row[];
    const now = this.clock.now();
    if (ownerId)
      this.db.prepare(`UPDATE runs SET status = 'cancelled', finished_at = ? WHERE status IN ('running', 'pending') AND owner_id = ?`).run(now, ownerId);
    else this.db.prepare(`UPDATE runs SET status = 'cancelled', finished_at = ? WHERE status IN ('running', 'pending')`).run(now);
    return rows.map((r) => ({ id: String(r.id), conversationId: String(r.conversation_id) }));
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
      sharinganAffirmed: Number(r.sharingan_affirmed ?? 0) === 1,
      researchEnabled: Number(r.research_enabled ?? 0) === 1,
      researchAgentCommand: str(r.research_agent_command, DEFAULT_SETTINGS.researchAgentCommand),
      researchModel: str(r.research_model, DEFAULT_SETTINGS.researchModel),
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
      sharinganAffirmed: patch.sharinganAffirmed ?? cur.sharinganAffirmed,
      visualQaAgentCommand: patch.visualQaAgentCommand ?? cur.visualQaAgentCommand,
      visualQaModel: patch.visualQaModel ?? cur.visualQaModel,
      autoImproveEnabled: patch.autoImproveEnabled ?? cur.autoImproveEnabled,
      autoImproveMaxRounds: patch.autoImproveMaxRounds ?? cur.autoImproveMaxRounds,
      researchEnabled: patch.researchEnabled ?? cur.researchEnabled,
      researchAgentCommand: patch.researchAgentCommand ?? cur.researchAgentCommand,
      researchModel: patch.researchModel ?? cur.researchModel,
    };
    this.db
      .prepare(
        `INSERT INTO settings (id, agent_command, model, api_base_url, api_key, default_design_system_id, custom_instructions,
                               image_api_base_url, image_api_key, image_model, remove_background_model, edit_region_model, extract_layer_model,
                               video_api_base_url, video_api_key, video_model,
                               ai_provider_id, ai_provider_enabled, ai_provider_models, ai_provider_organization, ai_provider_profiles,
                               visual_qa_enabled, auto_fix_live_runtime_errors, sharingan_affirmed, visual_qa_agent_command, visual_qa_model, auto_improve_enabled, auto_improve_max_rounds, research_enabled,
                               research_agent_command, research_model)
         VALUES ('app', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           sharingan_affirmed = excluded.sharingan_affirmed,
           visual_qa_agent_command = excluded.visual_qa_agent_command,
           visual_qa_model = excluded.visual_qa_model,
           auto_improve_enabled = excluded.auto_improve_enabled,
           auto_improve_max_rounds = excluded.auto_improve_max_rounds,
           research_enabled = excluded.research_enabled,
           research_agent_command = excluded.research_agent_command,
           research_model = excluded.research_model`,
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
        next.sharinganAffirmed ? 1 : 0,
        next.visualQaAgentCommand,
        next.visualQaModel,
        next.autoImproveEnabled ? 1 : 0,
        next.autoImproveMaxRounds,
        next.researchEnabled ? 1 : 0,
        next.researchAgentCommand,
        next.researchModel,
      );
    return next;
  }
}
