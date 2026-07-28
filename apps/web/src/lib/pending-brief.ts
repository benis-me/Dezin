import {
  RUN_CONTEXT_MAX_ITEMS,
  decodeContextItemRef,
  decodeSelectionRef,
  type ContextItemRef,
  type SelectionRef,
  type WorkspaceAgentTurnInput,
} from "./api.ts";
import { workspaceAgentRequestFingerprint } from "./workspace-agent-request-fingerprint.ts";

/**
 * A tiny module-level handoff for the initial brief: HomeScreen creates a project
 * and navigates to its workspace; the workspace picks up the brief on mount and
 * kicks off the first run. Keeps the flow simple without query params or a store.
 */

let pending: string | null = null;

export function setPendingBrief(brief: string): void {
  pending = brief;
}

export function takePendingBrief(): string | null {
  const b = pending;
  pending = null;
  return b;
}

/** Reference images (e.g. a dropped screenshot) handed to the new project's first run. */
export interface PendingImage {
  name: string;
  /** base64 (no data: prefix). */
  base64: string;
  /** Exact browser-validated image type; omitted only by legacy Prototype handoffs. */
  mimeType?: "image/png" | "image/jpeg";
}

export interface PendingProjectAttachments {
  images: PendingImage[];
  refs: PendingRef[];
}

let pendingImages: PendingImage[] = [];

export function setPendingImages(images: PendingImage[]): void {
  pendingImages = images;
}

export function takePendingImages(): PendingImage[] {
  const i = pendingImages;
  pendingImages = [];
  return i;
}

/** Agent + model chosen on the home composer, used for the new project's first run. */
let pendingAgent: string | null = null;
let pendingModel: string | null = null;

export function setPendingAgent(command: string, model?: string): void {
  pendingAgent = command;
  pendingModel = model ?? null;
}

export function takePendingAgent(): string | null {
  const a = pendingAgent;
  pendingAgent = null;
  return a;
}

export function takePendingModel(): string | null {
  const m = pendingModel;
  pendingModel = null;
  return m;
}

export interface PendingDesignWorkspaceTurn {
  projectId: string;
  turnId: string;
  /** A durable replacement turn prevents a reload from replaying the original Home turn. */
  supersededByTurnId?: string;
  brief: string;
  agentCommand?: string;
  model?: string;
  attachmentCount: number;
  attachmentsStaged: boolean;
  attachments?: PendingDesignWorkspaceAttachment[];
  /**
   * Exact facts of the active manual replacement. This record is written
   * before the Agent outbox, so a quota failure in the larger session record
   * cannot lose the replacement prompt or immutable Context on reload.
   */
  recoveryRequest?: PendingDesignWorkspaceRecoveryRequest;
  /** Append-only ancestry for replacements whose immutable facts changed. */
  supersessionLineage?: PendingDesignWorkspaceSupersession[];
}

export interface PendingDesignWorkspaceRecoveryContextItem {
  id: string;
  title: string;
  subtitle?: string;
  ref: ContextItemRef;
  projectId?: string;
  artifactId?: string;
  revisionId?: string;
  targetKey?: string;
  assemblyHash?: string;
  frameId?: string;
  designNodeId?: string;
}

export interface PendingDesignWorkspaceRecoveryRequest {
  turnId: string;
  parentTurnId: string;
  fingerprint: string;
  request: WorkspaceAgentTurnInput;
  contextItems: PendingDesignWorkspaceRecoveryContextItem[];
}

export interface PendingDesignWorkspaceSupersession {
  turnId: string;
  parentTurnId: string;
  fingerprint: string;
}

/**
 * A daemon-owned upload identity is safe to persist across renderer reloads.
 * Attachment bytes stay in the Home composer only until they have been staged.
 */
export interface PendingDesignWorkspaceAttachment {
  title: string;
  uploadedFileId?: string;
  projectReference?: PendingProjectReferenceIdentity;
  preview?: boolean;
}

export interface PendingProjectReferenceIdentity {
  sourceProjectId: string;
  sourceWorkspaceId: string;
  sourceSnapshotId: string;
  sourceArtifactId: string;
  sourceArtifactRevisionId: string;
}

const LEGACY_PENDING_DESIGN_WORKSPACE_TURN_KEY = "dezin.pending.design-workspace-turn";
const PENDING_DESIGN_WORKSPACE_TURN_KEY_PREFIX = "dezin.pending.design-workspace-turn:";
const ACKNOWLEDGED_DESIGN_WORKSPACE_TURN_KEY_PREFIX = "dezin.pending.design-workspace-turn-ack:";
const CANONICAL_TURN_ID = /^turn-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const memoryOnlyPendingDesignWorkspaceTurns = new Map<string, PendingDesignWorkspaceTurn>();

function storedRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function storedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= maxLength;
}

function storedTurnId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_TURN_ID.test(value);
}

function pendingDesignWorkspaceTurnStorageKey(projectId: string): string {
  return `${PENDING_DESIGN_WORKSPACE_TURN_KEY_PREFIX}${encodeURIComponent(projectId)}`;
}

function acknowledgedDesignWorkspaceTurnStorageKey(projectId: string, turnId: string): string {
  return `${ACKNOWLEDGED_DESIGN_WORKSPACE_TURN_KEY_PREFIX}${encodeURIComponent(projectId)}:${turnId}`;
}

function storedPendingAttachments(value: unknown): PendingDesignWorkspaceAttachment[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > RUN_CONTEXT_MAX_ITEMS) return null;
  const attachments: PendingDesignWorkspaceAttachment[] = [];
  for (const item of value) {
    const attachment = storedRecord(item);
    if (attachment === null) return null;
    const projectReference = attachment.projectReference;
    const normalizedProjectReference = projectReference === undefined
      ? undefined
      : storedPendingProjectReference(projectReference);
    const uploadedFileId = typeof attachment.uploadedFileId === "string"
      && /^\.refs\/[A-Za-z0-9._-]{1,80}$/.test(attachment.uploadedFileId)
      ? attachment.uploadedFileId
      : undefined;
    if ((projectReference !== undefined && normalizedProjectReference === null)
      || typeof attachment.title !== "string"
      || !attachment.title.trim()
      || attachment.title.length > 256
      || (uploadedFileId === undefined) === (normalizedProjectReference === undefined)
      || (attachment.preview !== undefined && typeof attachment.preview !== "boolean")) {
      return null;
    }
    const normalized: PendingDesignWorkspaceAttachment = { title: attachment.title };
    if (uploadedFileId !== undefined) normalized.uploadedFileId = uploadedFileId;
    if (normalizedProjectReference) normalized.projectReference = normalizedProjectReference;
    if (attachment.preview === true) normalized.preview = true;
    attachments.push(normalized);
  }
  return attachments;
}

function storedPendingProjectReference(value: unknown): PendingProjectReferenceIdentity | null {
  const reference = storedRecord(value);
  if (reference === null) return null;
  const fields = [
    "sourceProjectId",
    "sourceWorkspaceId",
    "sourceSnapshotId",
    "sourceArtifactId",
    "sourceArtifactRevisionId",
  ] as const;
  if (Object.keys(reference).length !== fields.length
    || fields.some((field) => !storedString(reference[field], 256))) return null;
  return Object.fromEntries(fields.map((field) => [field, reference[field]])) as unknown as PendingProjectReferenceIdentity;
}

function storedRecoveryContextItems(value: unknown): PendingDesignWorkspaceRecoveryContextItem[] | null {
  if (!Array.isArray(value) || value.length > RUN_CONTEXT_MAX_ITEMS) return null;
  const items: PendingDesignWorkspaceRecoveryContextItem[] = [];
  for (const candidate of value) {
    const item = storedRecord(candidate);
    if (item === null || !storedString(item.id, 512) || !storedString(item.title, 500)) return null;
    let ref: ContextItemRef;
    try {
      ref = decodeContextItemRef(item.ref);
    } catch {
      return null;
    }
    if (ref.kind !== "inline" && ref.revisionId === undefined) return null;
    const optionalFields = [
      "subtitle",
      "projectId",
      "artifactId",
      "revisionId",
      "targetKey",
      "assemblyHash",
      "frameId",
      "designNodeId",
    ] as const;
    if (optionalFields.some((field) => item[field] !== undefined
      && (typeof item[field] !== "string" || (item[field] as string).length > 500))) return null;
    items.push({
      id: item.id,
      title: item.title,
      ref,
      ...Object.fromEntries(optionalFields.flatMap((field) => (
        typeof item[field] === "string" ? [[field, item[field]]] : []
      ))),
    } as PendingDesignWorkspaceRecoveryContextItem);
  }
  return items;
}

function storedWorkspaceAgentRequest(value: unknown, expectedTurnId: string): WorkspaceAgentTurnInput | null {
  const request = storedRecord(value);
  if (request === null || request.turnId !== expectedTurnId || !storedString(request.message, 64 * 1024)
    || !Number.isSafeInteger(request.graphRevision)
    || !Array.isArray(request.explicitContext)
    || request.explicitContext.length > RUN_CONTEXT_MAX_ITEMS
    || (request.agentCommand !== undefined && typeof request.agentCommand !== "string")
    || (request.model !== undefined && typeof request.model !== "string")
    || (request.selection !== undefined && (!Array.isArray(request.selection)
      || request.selection.length > RUN_CONTEXT_MAX_ITEMS))) return null;
  let explicitContext: ContextItemRef[];
  let selection: SelectionRef[] | undefined;
  try {
    explicitContext = request.explicitContext.map((ref) => {
      const decoded = decodeContextItemRef(ref);
      if (decoded.kind !== "inline" && decoded.revisionId === undefined) {
        throw new TypeError("Recovery Context must name an immutable Revision");
      }
      return decoded;
    });
    selection = request.selection === undefined
      ? undefined
      : request.selection.map((ref) => decodeSelectionRef(ref));
  } catch {
    return null;
  }
  const normalized: WorkspaceAgentTurnInput = {
    turnId: expectedTurnId,
    message: request.message.trim(),
    explicitContext,
    graphRevision: Number(request.graphRevision),
  };
  if (typeof request.agentCommand === "string" && request.agentCommand.trim()) {
    normalized.agentCommand = request.agentCommand.trim();
  }
  if (typeof request.model === "string" && request.model.trim()) normalized.model = request.model.trim();
  if (selection !== undefined) normalized.selection = selection;
  return normalized;
}

function storedRecoveryRequest(
  value: unknown,
  activeTurnId: string,
): PendingDesignWorkspaceRecoveryRequest | null {
  const recovery = storedRecord(value);
  if (recovery === null || recovery.turnId !== activeTurnId || !storedTurnId(recovery.parentTurnId)
    || recovery.parentTurnId === activeTurnId || !storedString(recovery.fingerprint, 1024 * 1024)) return null;
  const request = storedWorkspaceAgentRequest(recovery.request, activeTurnId);
  const contextItems = storedRecoveryContextItems(recovery.contextItems);
  if (request === null || contextItems === null) return null;
  const { turnId: _turnId, ...immutableRequest } = request;
  if (workspaceAgentRequestFingerprint(immutableRequest) !== recovery.fingerprint) return null;
  return {
    turnId: activeTurnId,
    parentTurnId: recovery.parentTurnId,
    fingerprint: recovery.fingerprint,
    request,
    contextItems,
  };
}

function storedSupersessionLineage(value: unknown): PendingDesignWorkspaceSupersession[] | null {
  if (!Array.isArray(value) || value.length > 32) return null;
  const result: PendingDesignWorkspaceSupersession[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const entry = storedRecord(candidate);
    if (entry === null || !storedTurnId(entry.turnId) || !storedTurnId(entry.parentTurnId)
      || entry.parentTurnId === entry.turnId || seen.has(entry.turnId)
      || !storedString(entry.fingerprint, 1024 * 1024)) return null;
    seen.add(entry.turnId);
    result.push({
      turnId: entry.turnId,
      parentTurnId: entry.parentTurnId,
      fingerprint: entry.fingerprint,
    });
  }
  return result;
}

function newPendingWorkspaceTurnId(): string {
  return `turn-${globalThis.crypto.randomUUID().toLowerCase()}`;
}

function activePendingDesignWorkspaceTurnId(turn: PendingDesignWorkspaceTurn): string {
  return turn.supersededByTurnId ?? turn.turnId;
}

function normalizedPendingDesignWorkspaceTurn(
  value: unknown,
  options: { legacy?: boolean } = {},
): PendingDesignWorkspaceTurn | null {
  const turn = storedRecord(value);
  if (turn === null || typeof turn.projectId !== "string" || typeof turn.brief !== "string") return null;
  const turnId = storedTurnId(turn.turnId)
    ? turn.turnId
    : options.legacy ? newPendingWorkspaceTurnId() : null;
  if (turnId === null) return null;
  const supersededByTurnId = turn.supersededByTurnId === undefined
    ? undefined
    : storedTurnId(turn.supersededByTurnId)
        && turn.supersededByTurnId !== turnId
      ? turn.supersededByTurnId
      : null;
  if (supersededByTurnId === null) return null;
  if (turn.agentCommand !== undefined && typeof turn.agentCommand !== "string") return null;
  if (turn.model !== undefined && typeof turn.model !== "string") return null;
  const attachments = turn.attachments === undefined
    ? undefined
    : storedPendingAttachments(turn.attachments);
  if (attachments === null) return null;
  const attachmentCount = options.legacy && turn.attachmentCount === undefined
    ? attachments?.length ?? 0
    : turn.attachmentCount;
  const attachmentsStaged = options.legacy && turn.attachmentsStaged === undefined
    ? true
    : turn.attachmentsStaged;
  if (!Number.isInteger(attachmentCount)
    || (attachmentCount as number) < 0
    || (attachmentCount as number) > RUN_CONTEXT_MAX_ITEMS
    || typeof attachmentsStaged !== "boolean"
    || (attachments?.length ?? 0) > (attachmentCount as number)
    || (attachmentsStaged && (attachments?.length ?? 0) !== attachmentCount)) {
    return null;
  }
  const activeTurnId = supersededByTurnId ?? turnId;
  const recoveryRequest = turn.recoveryRequest === undefined
    ? undefined
    : storedRecoveryRequest(turn.recoveryRequest, activeTurnId);
  const supersessionLineage = turn.supersessionLineage === undefined
    ? undefined
    : storedSupersessionLineage(turn.supersessionLineage);
  if ((turn.recoveryRequest !== undefined && recoveryRequest === null)
    || (turn.supersessionLineage !== undefined && supersessionLineage === null)
    || (recoveryRequest !== undefined && supersededByTurnId === undefined)
    || (supersessionLineage !== undefined && supersessionLineage !== null
      && supersessionLineage.length > 0
      && (recoveryRequest === undefined || recoveryRequest === null
        || supersessionLineage.at(-1)?.turnId !== recoveryRequest.turnId
        || supersessionLineage.at(-1)?.fingerprint !== recoveryRequest.fingerprint))) {
    return null;
  }
  if (recoveryRequest !== undefined && recoveryRequest !== null
    && (recoveryRequest.request.message !== turn.brief
      || (recoveryRequest.request.agentCommand ?? undefined)
        !== (typeof turn.agentCommand === "string" && turn.agentCommand.trim()
          ? turn.agentCommand.trim()
          : undefined)
      || (recoveryRequest.request.model ?? undefined)
        !== (typeof turn.model === "string" && turn.model.trim() ? turn.model.trim() : undefined))) {
    return null;
  }
  const normalized: PendingDesignWorkspaceTurn = {
    projectId: turn.projectId,
    turnId,
    brief: turn.brief,
    attachmentCount: attachmentCount as number,
    attachmentsStaged,
  };
  if (supersededByTurnId !== undefined) normalized.supersededByTurnId = supersededByTurnId;
  if (typeof turn.agentCommand === "string") normalized.agentCommand = turn.agentCommand;
  if (typeof turn.model === "string") normalized.model = turn.model;
  if (attachments !== undefined) normalized.attachments = attachments;
  if (recoveryRequest) normalized.recoveryRequest = recoveryRequest;
  if (supersessionLineage) normalized.supersessionLineage = supersessionLineage;
  return normalized;
}

function storedPendingDesignWorkspaceTurn(projectId: string): PendingDesignWorkspaceTurn | null {
  try {
    const current = normalizedPendingDesignWorkspaceTurn(
      JSON.parse(localStorage.getItem(pendingDesignWorkspaceTurnStorageKey(projectId)) ?? "null") as unknown,
    );
    if (current?.projectId === projectId) return current;
    const legacy = normalizedPendingDesignWorkspaceTurn(
      JSON.parse(localStorage.getItem(LEGACY_PENDING_DESIGN_WORKSPACE_TURN_KEY) ?? "null") as unknown,
      { legacy: true },
    );
    if (legacy?.projectId !== projectId) return null;
    try {
      localStorage.setItem(
        pendingDesignWorkspaceTurnStorageKey(projectId),
        JSON.stringify(legacy),
      );
      localStorage.removeItem(LEGACY_PENDING_DESIGN_WORKSPACE_TURN_KEY);
    } catch {
      memoryOnlyPendingDesignWorkspaceTurns.set(projectId, legacy);
    }
    return legacy;
  } catch {
    return null;
  }
}

/**
 * Project-scoped one-shot handoff for a newly created Standard workspace.
 * Binding the payload after project creation prevents failed creates or unrelated
 * project navigation from inheriting another composer's Agent selection.
 */
export function setPendingDesignWorkspaceTurn(value: PendingDesignWorkspaceTurn): boolean {
  const normalized = normalizedPendingDesignWorkspaceTurn(value);
  if (normalized === null) throw new TypeError("Pending Design Workspace turn is invalid");
  const storageKey = pendingDesignWorkspaceTurnStorageKey(normalized.projectId);
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify(normalized),
    );
    memoryOnlyPendingDesignWorkspaceTurns.delete(normalized.projectId);
    return true;
  } catch {
    memoryOnlyPendingDesignWorkspaceTurns.set(normalized.projectId, normalized);
    return false;
  }
}

/** Read without consuming so async attachment work can be resumed after failure or reload. */
export function peekPendingDesignWorkspaceTurn(projectId: string): PendingDesignWorkspaceTurn | null {
  const value = memoryOnlyPendingDesignWorkspaceTurns.get(projectId)
    ?? storedPendingDesignWorkspaceTurn(projectId);
  if (value === null) return null;
  try {
    if (localStorage.getItem(
      acknowledgedDesignWorkspaceTurnStorageKey(projectId, activePendingDesignWorkspaceTurnId(value)),
    ) === "1") {
      memoryOnlyPendingDesignWorkspaceTurns.delete(projectId);
      return null;
    }
  } catch {
    /* A memory-only handoff is still usable while durable storage is unavailable. */
  }
  return value;
}

/** Project Studio owns durable acknowledgement; this only releases its same-renderer cache. */
export function forgetPendingDesignWorkspaceTurn(projectId: string): void {
  memoryOnlyPendingDesignWorkspaceTurns.delete(projectId);
}

/** Unconditional cleanup is reserved for a project that was itself successfully deleted. */
export function discardPendingDesignWorkspaceTurn(projectId: string): boolean {
  let existed = memoryOnlyPendingDesignWorkspaceTurns.delete(projectId);
  try {
    const scopedKey = pendingDesignWorkspaceTurnStorageKey(projectId);
    if (localStorage.getItem(scopedKey) !== null) existed = true;
    localStorage.removeItem(scopedKey);
    const acknowledgedPrefix = `${ACKNOWLEDGED_DESIGN_WORKSPACE_TURN_KEY_PREFIX}${encodeURIComponent(projectId)}:`;
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(acknowledgedPrefix)) {
        localStorage.removeItem(key);
        existed = true;
      }
    }
    const rawLegacy = JSON.parse(
      localStorage.getItem(LEGACY_PENDING_DESIGN_WORKSPACE_TURN_KEY) ?? "null",
    ) as unknown;
    if (storedRecord(rawLegacy)?.projectId === projectId) {
      localStorage.removeItem(LEGACY_PENDING_DESIGN_WORKSPACE_TURN_KEY);
      existed = true;
    }
  } catch {
    return false;
  }
  return existed;
}

/** Other projects referenced on the home composer — their artifact is uploaded as a
 *  read-only reference on the new project's first run so the agent reads the real design. */
export interface PendingRef {
  /** Source project name, used to label the uploaded reference file. */
  name: string;
  /** Prototype compatibility artifact, base64 (no data: prefix). */
  base64: string;
  /** Exact immutable Standard design identity; the daemon exports its bounded reference bundle. */
  projectReference?: PendingProjectReferenceIdentity;
}

let pendingRefs: PendingRef[] = [];

export function setPendingRefs(refs: PendingRef[]): void {
  pendingRefs = refs;
}

export function takePendingRefs(): PendingRef[] {
  const r = pendingRefs;
  pendingRefs = [];
  return r;
}
