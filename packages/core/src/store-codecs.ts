import type {
  Artifact,
  Conversation,
  Effect,
  EffectParamDefinition,
  EffectPreset,
  ExtensionCredentialRecord,
  ExtensionScope,
  Message,
  MessageRole,
  Moodboard,
  MoodboardAsset,
  MoodboardConversation,
  MoodboardMessage,
  MoodboardNode,
  Project,
  QualityFinding,
  Run,
  RunFeedback,
  RunStatus,
  Variant,
} from "./types.ts";

export type Row = Record<string, unknown>;

export function asProject(r: Row): Project {
  return {
    id: r.id as string,
    name: r.name as string,
    skillId: (r.skill_id as string | null) ?? null,
    designSystemId: (r.design_system_id as string | null) ?? null,
    mode: r.mode === "standard" ? "standard" : "prototype",
    sharingan: Number(r.sharingan ?? 0) === 1,
    sourceUrl: (r.source_url as string | null | undefined) ?? undefined,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    archivedAt: r.archived_at == null ? null : Number(r.archived_at),
  };
}

export function asExtensionCredential(r: Row): ExtensionCredentialRecord {
  const scopes = JSON.parse((r.scopes_json as string) || "[]") as unknown;
  return {
    id: r.id as string,
    tokenHash: r.token_hash as string,
    extensionId: r.extension_id as string,
    scopes: Array.isArray(scopes)
      ? scopes.filter((scope): scope is ExtensionScope => scope === "capture:write" || scope === "image:analyze")
      : [],
    createdAt: r.created_at as number,
    lastUsedAt: (r.last_used_at as number | null) ?? null,
    revokedAt: (r.revoked_at as number | null) ?? null,
  };
}
export function asConversation(r: Row): Conversation {
  const projectId = r.project_id as string;
  const scopeType = r.scope_type;
  const scopeId = r.scope_id;
  const scope: Conversation["scope"] | null = scopeType == null && scopeId == null
    ? { type: "workspace" as const, id: projectId }
    : (scopeType === "workspace" || scopeType === "artifact" || scopeType === "resource")
        && typeof scopeId === "string" && scopeId.length > 0
      ? { type: scopeType, id: scopeId }
      : null;
  if (scope === null) throw new Error("Conversation scope is invalid");
  return {
    id: r.id as string,
    projectId,
    title: r.title as string,
    scope,
    createdAt: Number(r.created_at),
  };
}
export function asVariant(r: Row): Variant {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    name: r.name as string,
    createdAt: Number(r.created_at),
  };
}
export function asMessage(r: Row): Message {
  return {
    id: r.id as string,
    conversationId: r.conversation_id as string,
    role: r.role as MessageRole,
    content: r.content as string,
    createdAt: Number(r.created_at),
  };
}
export function asQualityFindings(value: unknown): QualityFinding[] {
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
export function parseRunFeedback(value: unknown): RunFeedback | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const p = JSON.parse(value) as { verdict?: unknown; gap?: unknown };
    if (p.verdict === "up" || p.verdict === "down") return { verdict: p.verdict, gap: typeof p.gap === "string" ? p.gap : undefined };
  } catch {
    /* ignore malformed feedback */
  }
  return null;
}

export function asRun(r: Row): Run {
  const attempt = Number(r.attempt ?? 1);
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Run attempt is invalid");
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    conversationId: r.conversation_id as string,
    userMessageId: (r.user_message_id as string | null | undefined) ?? null,
    assistantMessageId: (r.assistant_message_id as string | null | undefined) ?? null,
    variantId: (r.variant_id as string | null | undefined) ?? null,
    commitHash: (r.commit_hash as string | null | undefined) ?? null,
    artifactId: (r.artifact_id as string | null | undefined) ?? null,
    artifactTrackId: (r.artifact_track_id as string | null | undefined) ?? null,
    planId: (r.plan_id as string | null | undefined) ?? null,
    taskId: (r.task_id as string | null | undefined) ?? null,
    baseRevisionId: (r.base_revision_id as string | null | undefined) ?? null,
    contextPackId: (r.context_pack_id as string | null | undefined) ?? null,
    contextPackHash: (r.context_pack_hash as string | null | undefined) ?? null,
    attempt,
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
export function asArtifact(r: Row): Artifact {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    path: r.path as string,
    lintPassed: Number(r.lint_passed) === 1,
    createdAt: Number(r.created_at),
  };
}
export function asJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
export function asMoodboard(r: Row): Moodboard {
  return {
    id: r.id as string,
    name: r.name as string,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    archivedAt: r.archived_at == null ? null : Number(r.archived_at),
    coverAssetId: (r.cover_asset_id as string | null | undefined) ?? null,
  };
}
export function asMoodboardNode(r: Row): MoodboardNode {
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
export function asMoodboardAsset(r: Row): MoodboardAsset {
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
export function asMoodboardConversation(r: Row): MoodboardConversation {
  return {
    id: r.id as string,
    boardId: r.board_id as string,
    title: r.title as string,
    createdAt: Number(r.created_at),
    ...(r.turns == null ? {} : { turns: Number(r.turns) }),
  };
}
export function asMoodboardMessage(r: Row): MoodboardMessage {
  return {
    id: r.id as string,
    boardId: r.board_id as string,
    conversationId: (r.conversation_id as string | null) ?? undefined,
    role: r.role as MessageRole,
    content: r.content as string,
    createdAt: Number(r.created_at),
  };
}
export function asEffectParamValue(value: unknown): string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : "";
}
export function asEffectParameters(value: unknown): EffectParamDefinition[] {
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
export function asEffectPresets(value: unknown): EffectPreset[] {
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
export function asEffect(r: Row): Effect {
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
