/** SQLite for independent app domains and Sharingan capture state only. */

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isEncryptedSecret, type SecretCipher } from "./secret-cipher.ts";

import type {
  CreateEffectInput,
  CreateMoodboardInput,
  CreateProjectInput,
  Effect,
  ExtensionCredentialRecord,
  ExtensionScope,
  MessageRole,
  Moodboard,
  MoodboardAsset,
  MoodboardConversation,
  MoodboardMessage,
  MoodboardNode,
  Project,
  SaveMoodboardNodeInput,
  Settings,
  UpdateEffectInput,
} from "./types.ts";
import {
  asEffect,
  asExtensionCredential,
  asMoodboard,
  asMoodboardAsset,
  asMoodboardConversation,
  asMoodboardMessage,
  asMoodboardNode,
  asProject,
  type Row,
} from "./store-codecs.ts";
import { SharinganWorkspaceStore } from "./sharingan-workspace-store.ts";
import { discardLegacyDesignStore, STORE_SCHEMA } from "./store-schema.ts";

const DEFAULT_SETTINGS = {
  agentCommand: "claude",
  model: "",
  apiBaseUrl: "",
  apiKey: "",
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
  sharinganAffirmed: false,
} satisfies Settings;

const SETTINGS_KEYS = Object.freeze(Object.keys(DEFAULT_SETTINGS) as Array<keyof typeof DEFAULT_SETTINGS>);
/** Settings that hold credentials; encrypted at rest when a SecretCipher is configured. */
const SECRET_SETTINGS_KEYS: ReadonlySet<string> = new Set(["apiKey", "imageApiKey", "videoApiKey", "aiProviderProfiles"]);

function settingColumn(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export interface StoreClock {
  now(): number;
  id(): string;
}

const DEFAULT_CLOCK: StoreClock = { now: () => Date.now(), id: () => randomUUID() };

export interface StoreOptions {
  /** Encrypts secret settings at rest; when absent they are stored as plain text. */
  secretCipher?: SecretCipher | null;
}

export class Store {
  readonly db: DatabaseSync;
  readonly workspace: SharinganWorkspaceStore;
  readonly legacyDesignBackupPath: string | null;
  private readonly clock: StoreClock;
  private readonly secretCipher: SecretCipher | null;

  constructor(path = ":memory:", clock: StoreClock = DEFAULT_CLOCK, options: StoreOptions = {}) {
    this.secretCipher = options.secretCipher ?? null;
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.legacyDesignBackupPath = discardLegacyDesignStore(this.db);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(STORE_SCHEMA);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the schema failure when SQLite already ended the transaction.
      }
      throw error;
    }
    this.clock = clock;
    this.workspace = new SharinganWorkspaceStore(this.db, clock);
  }

  close(): void {
    this.db.close();
  }

  // ── browser extension credentials ───────────────────────────────────────

  createExtensionCredential(input: {
    tokenHash: string;
    extensionId: string;
    scopes: ExtensionScope[];
  }): ExtensionCredentialRecord {
    if (!/^[a-f0-9]{64}$/.test(input.tokenHash)) throw new Error("expected a SHA-256 token hash");
    const scopes = [...new Set(input.scopes)];
    if (scopes.some((scope) => scope !== "capture:write" && scope !== "image:analyze")) {
      throw new Error("extension credential scope is unsupported");
    }
    const id = this.clock.id();
    const now = this.clock.now();
    this.db.prepare(
      `INSERT INTO extension_credentials
        (id, token_hash, extension_id, scopes_json, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(id, input.tokenHash, input.extensionId, JSON.stringify(scopes), now);
    return this.listExtensionCredentials({ includeRevoked: true })
      .find((credential) => credential.id === id)!;
  }

  listExtensionCredentials(options: { includeRevoked?: boolean } = {}): ExtensionCredentialRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM extension_credentials
       ${options.includeRevoked ? "" : "WHERE revoked_at IS NULL"}
       ORDER BY created_at DESC, rowid DESC`,
    ).all() as Row[];
    return rows.map(asExtensionCredential);
  }

  touchExtensionCredential(id: string): boolean {
    return Number(this.db.prepare(
      "UPDATE extension_credentials SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL",
    ).run(this.clock.now(), id).changes) > 0;
  }

  revokeExtensionCredential(id: string): boolean {
    return Number(this.db.prepare(
      "UPDATE extension_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    ).run(this.clock.now(), id).changes) > 0;
  }

  // ── Sharingan Project identity ──────────────────────────────────────────

  createProject(input: CreateProjectInput): Project {
    if (input.sharingan !== true || (input.mode !== undefined && input.mode !== "standard")) {
      throw new Error("SQLite stores Sharingan Projects only");
    }
    const name = input.name.trim();
    if (!name) throw new Error("Sharingan Project name is required");
    let sourceUrl: string;
    try {
      const parsed = new URL(input.sourceUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
      sourceUrl = parsed.href;
    } catch {
      throw new Error("Sharingan Project source URL must use http(s)");
    }
    const id = this.clock.id();
    const now = this.clock.now();
    this.db.prepare(
      `INSERT INTO projects (id, name, mode, sharingan, source_url, created_at, updated_at)
       VALUES (?, ?, 'standard', 1, ?, ?, ?)`,
    ).run(id, name, sourceUrl, now, now);
    return this.getProject(id)!;
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare(
      "SELECT * FROM projects WHERE id = ? AND sharingan = 1",
    ).get(id) as Row | undefined;
    return row ? asProject(row) : null;
  }

  listProjects(): Project[] {
    return (this.db.prepare(
      "SELECT * FROM projects WHERE sharingan = 1 ORDER BY updated_at DESC, rowid DESC",
    ).all() as Row[]).map(asProject);
  }

  updateProject(id: string, patch: Pick<Project, "name">): Project {
    if (!this.getProject(id)) throw new Error(`project not found: ${id}`);
    const name = patch.name.trim();
    if (!name) throw new Error("Sharingan Project name is required");
    this.db.prepare(
      "UPDATE projects SET name = ?, updated_at = ? WHERE id = ? AND sharingan = 1",
    ).run(name, this.clock.now(), id);
    return this.getProject(id)!;
  }

  setArchived(id: string, archived: boolean): Project | null {
    this.db.prepare(
      "UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ? AND sharingan = 1",
    ).run(archived ? this.clock.now() : null, this.clock.now(), id);
    return this.getProject(id);
  }

  deleteProject(id: string): void {
    this.db.prepare("DELETE FROM projects WHERE id = ? AND sharingan = 1").run(id);
  }

  // ── Moodboards ──────────────────────────────────────────────────────────

  createMoodboard(input: CreateMoodboardInput, options: { status?: "starting" | "ready" } = {}): Moodboard {
    const id = this.clock.id();
    const now = this.clock.now();
    this.db.prepare(
      "INSERT INTO moodboards (id, name, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?)",
    ).run(id, input.name, now, now, options.status ?? "ready");
    return this.getMoodboard(id)!;
  }

  getMoodboard(id: string): Moodboard | null {
    const row = this.db.prepare("SELECT * FROM moodboards WHERE id = ?").get(id) as Row | undefined;
    return row ? asMoodboard(row) : null;
  }

  getPublishedMoodboard(id: string): Moodboard | null {
    const row = this.db.prepare(
      "SELECT * FROM moodboards WHERE id = ? AND status = 'ready'",
    ).get(id) as Row | undefined;
    return row ? asMoodboard(row) : null;
  }

  listMoodboards(): Moodboard[] {
    return (this.db.prepare(
      "SELECT * FROM moodboards WHERE status = 'ready' ORDER BY updated_at DESC, rowid DESC",
    ).all() as Row[]).map(asMoodboard);
  }

  listStartingMoodboards(): Moodboard[] {
    return (this.db.prepare(
      "SELECT * FROM moodboards WHERE status = 'starting' ORDER BY created_at ASC, rowid ASC",
    ).all() as Row[]).map(asMoodboard);
  }

  publishMoodboard(id: string): Moodboard {
    const result = this.db.prepare(
      "UPDATE moodboards SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'starting'",
    ).run(this.clock.now(), id);
    if (Number(result.changes) === 0) throw new Error(`starting moodboard not found: ${id}`);
    return this.getMoodboard(id)!;
  }

  updateMoodboard(
    id: string,
    patch: Partial<Pick<Moodboard, "name" | "archivedAt" | "coverAssetId">>,
  ): Moodboard {
    const current = this.getMoodboard(id);
    if (!current) throw new Error(`moodboard not found: ${id}`);
    this.db.prepare(
      "UPDATE moodboards SET name = ?, archived_at = ?, cover_asset_id = ?, updated_at = ? WHERE id = ?",
    ).run(
      patch.name ?? current.name,
      patch.archivedAt !== undefined ? patch.archivedAt : current.archivedAt,
      patch.coverAssetId !== undefined ? patch.coverAssetId : current.coverAssetId,
      this.clock.now(),
      id,
    );
    return this.getMoodboard(id)!;
  }

  setMoodboardArchived(id: string, archived: boolean): Moodboard | null {
    const now = this.clock.now();
    this.db.prepare(
      "UPDATE moodboards SET archived_at = ?, updated_at = ? WHERE id = ?",
    ).run(archived ? now : null, now, id);
    return this.getMoodboard(id);
  }

  deleteMoodboard(id: string): void {
    this.db.prepare("DELETE FROM moodboards WHERE id = ?").run(id);
  }

  listMoodboardNodes(boardId: string): MoodboardNode[] {
    return (this.db.prepare(
      "SELECT * FROM moodboard_nodes WHERE board_id = ? ORDER BY z_index ASC, created_at ASC, rowid ASC",
    ).all(boardId) as Row[]).map(asMoodboardNode);
  }

  replaceMoodboardNodes(boardId: string, nodes: SaveMoodboardNodeInput[]): MoodboardNode[] {
    if (!this.getMoodboard(boardId)) throw new Error(`moodboard not found: ${boardId}`);
    const now = this.clock.now();
    const existing = this.db.prepare(
      "SELECT id, created_at FROM moodboard_nodes WHERE board_id = ?",
    ).all(boardId) as Row[];
    const createdAtById = new Map(existing.map((row) => [String(row.id), Number(row.created_at)]));
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM moodboard_nodes WHERE board_id = ?").run(boardId);
      const insert = this.db.prepare(
        `INSERT INTO moodboard_nodes
          (id, board_id, type, x, y, width, height, rotation, z_index, data_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const [index, node] of nodes.entries()) {
        const id = node.id || this.clock.id();
        insert.run(
          id,
          boardId,
          node.type,
          Number.isFinite(node.x) ? node.x : 0,
          Number.isFinite(node.y) ? node.y : 0,
          Number.isFinite(node.width) ? Math.max(32, node.width) : 240,
          Number.isFinite(node.height) ? Math.max(32, node.height) : 180,
          Number.isFinite(node.rotation ?? 0) ? node.rotation ?? 0 : 0,
          Number.isFinite(node.zIndex ?? index) ? node.zIndex ?? index : index,
          JSON.stringify(node.data ?? {}),
          createdAtById.get(id) ?? now,
          now,
        );
      }
      this.db.prepare("UPDATE moodboards SET updated_at = ? WHERE id = ?").run(now, boardId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
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
    this.db.prepare(
      `INSERT INTO moodboard_assets
        (id, board_id, kind, file_name, mime_type, width, height, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, boardId, input.kind, input.fileName, input.mimeType, input.width, input.height, input.source, now);
    this.db.prepare(
      "UPDATE moodboards SET updated_at = ?, cover_asset_id = COALESCE(cover_asset_id, ?) WHERE id = ?",
    ).run(now, id, boardId);
    return this.getMoodboardAsset(id)!;
  }

  getMoodboardAsset(id: string): MoodboardAsset | null {
    const row = this.db.prepare("SELECT * FROM moodboard_assets WHERE id = ?").get(id) as Row | undefined;
    return row ? asMoodboardAsset(row) : null;
  }

  listMoodboardAssets(boardId: string): MoodboardAsset[] {
    return (this.db.prepare(
      "SELECT * FROM moodboard_assets WHERE board_id = ? ORDER BY created_at DESC, rowid DESC",
    ).all(boardId) as Row[]).map(asMoodboardAsset);
  }

  private adoptUnscopedMoodboardMessages(boardId: string, conversationId: string): void {
    this.db.prepare(
      "UPDATE moodboard_messages SET conversation_id = ? WHERE board_id = ? AND conversation_id IS NULL",
    ).run(conversationId, boardId);
  }

  ensureMoodboardConversation(boardId: string): MoodboardConversation {
    if (!this.getMoodboard(boardId)) throw new Error(`moodboard not found: ${boardId}`);
    const row = this.db.prepare(
      "SELECT * FROM moodboard_conversations WHERE board_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1",
    ).get(boardId) as Row | undefined;
    const conversation = row
      ? asMoodboardConversation(row)
      : this.createMoodboardConversation(boardId, "Conversation 1");
    this.adoptUnscopedMoodboardMessages(boardId, conversation.id);
    return conversation;
  }

  createMoodboardConversation(boardId: string, title = "Conversation 1"): MoodboardConversation {
    if (!this.getMoodboard(boardId)) throw new Error(`moodboard not found: ${boardId}`);
    const id = this.clock.id();
    const now = this.clock.now();
    this.db.prepare(
      "INSERT INTO moodboard_conversations (id, board_id, title, created_at) VALUES (?, ?, ?, ?)",
    ).run(id, boardId, title.trim() || "Conversation 1", now);
    this.db.prepare("UPDATE moodboards SET updated_at = ? WHERE id = ?").run(now, boardId);
    return asMoodboardConversation(
      this.db.prepare("SELECT * FROM moodboard_conversations WHERE id = ?").get(id) as Row,
    );
  }

  getMoodboardConversation(id: string): MoodboardConversation | null {
    const row = this.db.prepare(
      "SELECT * FROM moodboard_conversations WHERE id = ?",
    ).get(id) as Row | undefined;
    return row ? asMoodboardConversation(row) : null;
  }

  listMoodboardConversations(boardId: string): MoodboardConversation[] {
    this.ensureMoodboardConversation(boardId);
    return (this.db.prepare(
      `SELECT conversation.*,
          (SELECT COUNT(*) FROM moodboard_messages message
            WHERE message.conversation_id = conversation.id AND message.role = 'user') AS turns
         FROM moodboard_conversations conversation
        WHERE conversation.board_id = ?
        ORDER BY conversation.created_at ASC, conversation.rowid ASC`,
    ).all(boardId) as Row[]).map(asMoodboardConversation);
  }

  renameMoodboardConversation(id: string, title: string): MoodboardConversation | null {
    this.db.prepare(
      "UPDATE moodboard_conversations SET title = ? WHERE id = ?",
    ).run(title.trim() || "Conversation 1", id);
    return this.getMoodboardConversation(id);
  }

  deleteMoodboardConversation(id: string): void {
    const conversation = this.getMoodboardConversation(id);
    this.db.prepare("DELETE FROM moodboard_conversations WHERE id = ?").run(id);
    if (conversation) this.ensureMoodboardConversation(conversation.boardId);
  }

  addMoodboardMessage(
    boardId: string,
    role: MessageRole,
    content: string,
    conversationId?: string,
  ): MoodboardMessage {
    if (!this.getMoodboard(boardId)) throw new Error(`moodboard not found: ${boardId}`);
    const conversation = conversationId
      ? this.getMoodboardConversation(conversationId)
      : this.ensureMoodboardConversation(boardId);
    if (!conversation || conversation.boardId !== boardId) {
      throw new Error(`moodboard conversation not found: ${String(conversationId)}`);
    }
    const id = this.clock.id();
    const now = this.clock.now();
    this.db.prepare(
      `INSERT INTO moodboard_messages
        (id, board_id, conversation_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, boardId, conversation.id, role, content, now);
    this.db.prepare("UPDATE moodboards SET updated_at = ? WHERE id = ?").run(now, boardId);
    return asMoodboardMessage(
      this.db.prepare("SELECT * FROM moodboard_messages WHERE id = ?").get(id) as Row,
    );
  }

  listMoodboardMessages(boardId: string, conversationId?: string): MoodboardMessage[] {
    const conversation = conversationId
      ? this.getMoodboardConversation(conversationId)
      : this.ensureMoodboardConversation(boardId);
    if (!conversation || conversation.boardId !== boardId) {
      throw new Error(`moodboard conversation not found: ${String(conversationId)}`);
    }
    return (this.db.prepare(
      `SELECT * FROM moodboard_messages
        WHERE board_id = ? AND conversation_id = ?
        ORDER BY created_at ASC, rowid ASC`,
    ).all(boardId, conversation.id) as Row[]).map(asMoodboardMessage);
  }

  // ── Custom effects ──────────────────────────────────────────────────────

  createEffect(input: CreateEffectInput): Effect {
    const id = this.clock.id();
    const now = this.clock.now();
    this.db.prepare(
      `INSERT INTO custom_effects
        (id, name, category, summary, code, parameters_json, presets_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name.trim() || "Untitled effect",
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
    const row = this.db.prepare("SELECT * FROM custom_effects WHERE id = ?").get(id) as Row | undefined;
    return row ? asEffect(row) : null;
  }

  listEffects(): Effect[] {
    return (this.db.prepare(
      "SELECT * FROM custom_effects ORDER BY updated_at DESC, rowid DESC",
    ).all() as Row[]).map(asEffect);
  }

  updateEffect(id: string, patch: UpdateEffectInput): Effect {
    const current = this.getEffect(id);
    if (!current) throw new Error(`effect not found: ${id}`);
    this.db.prepare(
      `UPDATE custom_effects
          SET name = ?, category = ?, summary = ?, code = ?,
              parameters_json = ?, presets_json = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      patch.name !== undefined ? patch.name.trim() || current.name : current.name,
      patch.category !== undefined ? patch.category.trim() || current.category : current.category,
      patch.summary !== undefined ? patch.summary.trim() : current.summary,
      patch.code !== undefined ? patch.code : current.code,
      JSON.stringify(patch.parameters ?? current.parameters),
      JSON.stringify(patch.presets ?? current.presets),
      this.clock.now(),
      id,
    );
    return this.getEffect(id)!;
  }

  deleteEffect(id: string): void {
    this.db.prepare("DELETE FROM custom_effects WHERE id = ?").run(id);
  }

  // ── App settings ────────────────────────────────────────────────────────

  private readSettingsRow(): Row | undefined {
    return this.db.prepare("SELECT * FROM settings WHERE id = 'app'").get() as Row | undefined;
  }

  /** Stored → in-memory. An unreadable ciphertext reads as "not configured" but is never overwritten. */
  private revealSecret(stored: string): string {
    if (!isEncryptedSecret(stored)) return stored;
    if (this.secretCipher === null) return "";
    try {
      return this.secretCipher.decrypt(stored);
    } catch {
      return "";
    }
  }

  private sealSecret(plain: string): string {
    return this.secretCipher === null || plain === "" ? plain : this.secretCipher.encrypt(plain);
  }

  getSettings(): Settings {
    const row = this.readSettingsRow();
    if (!row) return { ...DEFAULT_SETTINGS };
    const result = { ...DEFAULT_SETTINGS } as Record<keyof typeof DEFAULT_SETTINGS, string | number | boolean>;
    for (const key of SETTINGS_KEYS) {
      const fallback = DEFAULT_SETTINGS[key];
      const value = row[settingColumn(key)];
      if (typeof fallback === "boolean") result[key] = Number(value ?? Number(fallback)) === 1;
      else if (typeof fallback === "number") {
        const numeric = Number(value);
        result[key] = Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : fallback;
      } else if (SECRET_SETTINGS_KEYS.has(key)) result[key] = typeof value === "string" ? this.revealSecret(value) : fallback;
      else result[key] = typeof value === "string" ? value : fallback;
    }
    return result as Settings;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const row = this.readSettingsRow();
    const current = this.getSettings();
    const next = { ...current };
    for (const key of SETTINGS_KEYS) {
      const value = patch[key];
      if (value !== undefined) (next as Record<string, unknown>)[key] = value;
    }
    const columns = SETTINGS_KEYS.map(settingColumn);
    const values = SETTINGS_KEYS.map((key) => {
      const value = next[key];
      if (SECRET_SETTINGS_KEYS.has(key)) {
        // A new value is sealed with the current key. An untouched value keeps its
        // stored bytes (so a ciphertext we cannot read today is not destroyed),
        // except legacy plain text, which is migrated to ciphertext on this write.
        if (patch[key] !== undefined) return this.sealSecret(String(value));
        const stored = row?.[settingColumn(key)];
        if (typeof stored !== "string" || stored === "") return "";
        return isEncryptedSecret(stored) ? stored : this.sealSecret(stored);
      }
      return typeof value === "boolean" ? (value ? 1 : 0) : value;
    });
    this.db.prepare(
      `INSERT INTO settings (id, ${columns.join(", ")})
       VALUES ('app', ${columns.map(() => "?").join(", ")})
       ON CONFLICT(id) DO UPDATE SET
       ${columns.map((column) => `${column} = excluded.${column}`).join(", ")}`,
    ).run(...values);
    return next;
  }
}
