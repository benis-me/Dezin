import type {
  Effect,
  EffectParamDefinition,
  EffectPreset,
  ExtensionCredentialRecord,
  ExtensionScope,
  MessageRole,
  Moodboard,
  MoodboardAsset,
  MoodboardConversation,
  MoodboardMessage,
  MoodboardNode,
  Project,
} from "./types.ts";

export type Row = Record<string, unknown>;

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is invalid`);
  return value;
}

function requiredNumber(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} is invalid`);
  return number;
}

export function asProject(row: Row): Project {
  if (row.mode !== "standard" || Number(row.sharingan) !== 1) {
    throw new Error("SQLite Project row is not Sharingan-owned");
  }
  return {
    id: requiredString(row.id, "Project id"),
    name: requiredString(row.name, "Project name"),
    mode: "standard",
    sharingan: true,
    sourceUrl: requiredString(row.source_url, "Sharingan source URL"),
    createdAt: requiredNumber(row.created_at, "Project created at"),
    updatedAt: requiredNumber(row.updated_at, "Project updated at"),
    archivedAt: row.archived_at == null ? null : requiredNumber(row.archived_at, "Project archived at"),
  };
}

export function asExtensionCredential(row: Row): ExtensionCredentialRecord {
  let decoded: unknown = [];
  try {
    decoded = JSON.parse(typeof row.scopes_json === "string" ? row.scopes_json : "[]");
  } catch {
    decoded = [];
  }
  return {
    id: requiredString(row.id, "Extension credential id"),
    tokenHash: requiredString(row.token_hash, "Extension credential token hash"),
    extensionId: requiredString(row.extension_id, "Extension id"),
    scopes: Array.isArray(decoded)
      ? decoded.filter((scope): scope is ExtensionScope => scope === "capture:write" || scope === "image:analyze")
      : [],
    createdAt: requiredNumber(row.created_at, "Extension credential created at"),
    lastUsedAt: row.last_used_at == null ? null : requiredNumber(row.last_used_at, "Extension credential last used at"),
    revokedAt: row.revoked_at == null ? null : requiredNumber(row.revoked_at, "Extension credential revoked at"),
  };
}

function asJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function asMoodboard(row: Row): Moodboard {
  return {
    id: requiredString(row.id, "Moodboard id"),
    name: requiredString(row.name, "Moodboard name"),
    createdAt: requiredNumber(row.created_at, "Moodboard created at"),
    updatedAt: requiredNumber(row.updated_at, "Moodboard updated at"),
    archivedAt: row.archived_at == null ? null : requiredNumber(row.archived_at, "Moodboard archived at"),
    coverAssetId: row.cover_asset_id == null ? null : requiredString(row.cover_asset_id, "Moodboard cover Asset id"),
  };
}

export function asMoodboardNode(row: Row): MoodboardNode {
  const type = row.type === "video" || row.type === "note" || row.type === "section" || row.type === "image-generator"
    ? row.type
    : "image";
  return {
    id: requiredString(row.id, "Moodboard Node id"),
    boardId: requiredString(row.board_id, "Moodboard Node board id"),
    type,
    x: requiredNumber(row.x, "Moodboard Node x"),
    y: requiredNumber(row.y, "Moodboard Node y"),
    width: requiredNumber(row.width, "Moodboard Node width"),
    height: requiredNumber(row.height, "Moodboard Node height"),
    rotation: requiredNumber(row.rotation ?? 0, "Moodboard Node rotation"),
    zIndex: requiredNumber(row.z_index ?? 0, "Moodboard Node z index"),
    data: asJsonObject(row.data_json),
    createdAt: requiredNumber(row.created_at, "Moodboard Node created at"),
    updatedAt: requiredNumber(row.updated_at, "Moodboard Node updated at"),
  };
}

export function asMoodboardAsset(row: Row): MoodboardAsset {
  const source = row.source === "generated" || row.source === "edited" ? row.source : "upload";
  return {
    id: requiredString(row.id, "Moodboard Asset id"),
    boardId: requiredString(row.board_id, "Moodboard Asset board id"),
    kind: row.kind === "video" ? "video" : "image",
    fileName: requiredString(row.file_name, "Moodboard Asset filename"),
    mimeType: requiredString(row.mime_type, "Moodboard Asset MIME"),
    width: row.width == null ? null : requiredNumber(row.width, "Moodboard Asset width"),
    height: row.height == null ? null : requiredNumber(row.height, "Moodboard Asset height"),
    source,
    createdAt: requiredNumber(row.created_at, "Moodboard Asset created at"),
  };
}

export function asMoodboardConversation(row: Row): MoodboardConversation {
  return {
    id: requiredString(row.id, "Moodboard Conversation id"),
    boardId: requiredString(row.board_id, "Moodboard Conversation board id"),
    title: requiredString(row.title, "Moodboard Conversation title"),
    createdAt: requiredNumber(row.created_at, "Moodboard Conversation created at"),
    ...(row.turns == null ? {} : { turns: requiredNumber(row.turns, "Moodboard Conversation turns") }),
  };
}

export function asMoodboardMessage(row: Row): MoodboardMessage {
  const role: MessageRole = row.role === "assistant" || row.role === "system" ? row.role : "user";
  return {
    id: requiredString(row.id, "Moodboard Message id"),
    boardId: requiredString(row.board_id, "Moodboard Message board id"),
    conversationId: row.conversation_id == null
      ? undefined
      : requiredString(row.conversation_id, "Moodboard Message Conversation id"),
    role,
    content: typeof row.content === "string" ? row.content : "",
    createdAt: requiredNumber(row.created_at, "Moodboard Message created at"),
  };
}

function effectParamValue(value: unknown): string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : "";
}

function effectParameters(value: unknown): EffectParamDefinition[] {
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): EffectParamDefinition[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const label = typeof record.label === "string" ? record.label.trim() : "";
      const type = record.type === "color" || record.type === "select" || record.type === "boolean"
        || record.type === "image" || record.type === "number"
        ? record.type
        : "number";
      if (!id || !label) return [];
      const options = Array.isArray(record.options)
        ? record.options.flatMap((option): Array<{ label: string; value: string }> => {
            if (!option || typeof option !== "object" || Array.isArray(option)) return [];
            const optionRecord = option as Record<string, unknown>;
            const optionValue = typeof optionRecord.value === "string" ? optionRecord.value : "";
            if (!optionValue) return [];
            return [{
              value: optionValue,
              label: typeof optionRecord.label === "string" ? optionRecord.label : optionValue,
            }];
          })
        : undefined;
      return [{
        id,
        label,
        type,
        defaultValue: effectParamValue(record.defaultValue),
        ...(typeof record.min === "number" ? { min: record.min } : {}),
        ...(typeof record.max === "number" ? { max: record.max } : {}),
        ...(typeof record.step === "number" ? { step: record.step } : {}),
        ...(options?.length ? { options } : {}),
        ...(typeof record.description === "string" ? { description: record.description } : {}),
      }];
    });
  } catch {
    return [];
  }
}

function effectPresets(value: unknown): EffectPreset[] {
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): EffectPreset[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const name = typeof record.name === "string" ? record.name.trim() : "";
      if (!id || !name) return [];
      const values = record.values && typeof record.values === "object" && !Array.isArray(record.values)
        ? Object.fromEntries(Object.entries(record.values as Record<string, unknown>)
            .map(([key, entry]) => [key, effectParamValue(entry)]))
        : {};
      return [{ id, name, values }];
    });
  } catch {
    return [];
  }
}

export function asEffect(row: Row): Effect {
  return {
    id: requiredString(row.id, "Effect id"),
    name: requiredString(row.name, "Effect name"),
    origin: "custom",
    category: requiredString(row.category, "Effect category"),
    summary: typeof row.summary === "string" ? row.summary : "",
    code: typeof row.code === "string" ? row.code : "",
    parameters: effectParameters(row.parameters_json),
    presets: effectPresets(row.presets_json),
    createdAt: requiredNumber(row.created_at, "Effect created at"),
    updatedAt: requiredNumber(row.updated_at, "Effect updated at"),
  };
}
