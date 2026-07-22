import {
  decodeContextItemRef,
  decodeScopedAgentTurnReceipt,
  decodeSelectionRef,
  type ContextItemRef,
  type ScopedAgentTurnInput,
  type ScopedAgentTurnReceipt,
  type WorkspaceAgentTurnInput,
} from "../lib/api.ts";
import type { AgentComposerContextItem } from "../components/AgentComposerContext.tsx";

export const WORKSPACE_AGENT_SCOPE = "workspace" as const;
export type AgentScopeKey = typeof WORKSPACE_AGENT_SCOPE | `artifact:${string}` | `resource:${string}`;
export type AgentTarget =
  | { type: "workspace" }
  | { type: "artifact"; id: string }
  | { type: "resource"; id: string };

export interface AgentTranscriptEntry {
  id: string;
  turnId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  state: "submitted" | "queued" | "proposal";
}

export type AgentTurnOutbox =
  | {
      kind: "workspace";
      turnId: string;
      fingerprint: string;
      request: WorkspaceAgentTurnInput;
      createdAt: number;
    }
  | {
      kind: "scoped";
      scopeType: "artifact" | "resource";
      targetId: string;
      turnId: string;
      fingerprint: string;
      request: ScopedAgentTurnInput;
      createdAt: number;
    };

export type AgentSessionReceipt =
  | { kind: "workspace"; turnId: string; proposalId: string; status: string; createdAt: number }
  | { kind: "scoped"; turnId: string; receipt: ScopedAgentTurnReceipt; createdAt: number };

export interface AgentSession {
  draft: string;
  contextItems: Array<Extract<AgentComposerContextItem, { type: "context-ref" }>>;
  transcript: AgentTranscriptEntry[];
  outbox: AgentTurnOutbox | null;
  receipt: AgentSessionReceipt | null;
}

const STORAGE_PREFIX = "dezin.project-studio.agent.v1";
const CANONICAL_TURN_ID = /^turn-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_TRANSCRIPT_ENTRIES = 100;
const MAX_DRAFT_LENGTH = 64 * 1024;

export function agentScopeKey(target: AgentTarget): AgentScopeKey {
  return target.type === "workspace" ? WORKSPACE_AGENT_SCOPE : `${target.type}:${target.id}`;
}

export function agentTargetFor(
  artifactId: string | null,
  resourceId: string | null,
): AgentTarget {
  if (artifactId !== null) return { type: "artifact", id: artifactId };
  if (resourceId !== null) return { type: "resource", id: resourceId };
  return { type: "workspace" };
}

export function emptyAgentSession(): AgentSession {
  return { draft: "", contextItems: [], transcript: [], outbox: null, receipt: null };
}

function storageKey(projectId: string, scopeKey: AgentScopeKey): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(projectId)}:${encodeURIComponent(scopeKey)}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalTurnId(value: unknown): string | null {
  return typeof value === "string" && CANONICAL_TURN_ID.test(value) ? value : null;
}

function decodeImmutableContextRef(value: unknown): ContextItemRef {
  const ref = decodeContextItemRef(value);
  if (ref.kind !== "inline" && ref.revisionId === undefined) {
    throw new TypeError(`${ref.kind} Agent Context must name an immutable Revision`);
  }
  return ref;
}

function parseContextItems(value: unknown): AgentSession["contextItems"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): AgentSession["contextItems"] => {
    const input = record(candidate);
    if (!input || input.type !== "context-ref" || typeof input.id !== "string"
      || typeof input.title !== "string" || input.id.length > 512 || input.title.length > 500) return [];
    try {
      const ref = decodeImmutableContextRef(input.ref);
      return [{
        id: input.id,
        type: "context-ref",
        title: input.title,
        ...(typeof input.subtitle === "string" ? { subtitle: input.subtitle.slice(0, 500) } : {}),
        ref,
        ...(typeof input.projectId === "string" ? { projectId: input.projectId } : {}),
        ...(typeof input.artifactId === "string" ? { artifactId: input.artifactId } : {}),
        ...(typeof input.revisionId === "string" ? { revisionId: input.revisionId } : {}),
        ...(typeof input.targetKey === "string" ? { targetKey: input.targetKey } : {}),
        ...(typeof input.assemblyHash === "string" ? { assemblyHash: input.assemblyHash } : {}),
        ...(typeof input.frameId === "string" ? { frameId: input.frameId } : {}),
        ...(typeof input.designNodeId === "string" ? { designNodeId: input.designNodeId } : {}),
      }];
    } catch {
      return [];
    }
  }).slice(0, 32);
}

function parseTranscript(value: unknown): AgentTranscriptEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): AgentTranscriptEntry[] => {
    const input = record(candidate);
    const turnId = canonicalTurnId(input?.turnId);
    if (!input || !turnId || typeof input.id !== "string" || typeof input.content !== "string"
      || (input.role !== "user" && input.role !== "assistant")
      || (input.state !== "submitted" && input.state !== "queued" && input.state !== "proposal")
      || !Number.isFinite(input.createdAt)) return [];
    return [{
      id: input.id,
      turnId,
      role: input.role,
      content: input.content.slice(0, MAX_DRAFT_LENGTH),
      createdAt: Number(input.createdAt),
      state: input.state,
    }];
  }).slice(-MAX_TRANSCRIPT_ENTRIES);
}

function parseContextRefs(value: unknown): ContextItemRef[] | null {
  if (!Array.isArray(value)) return null;
  try {
    return value.map(decodeImmutableContextRef);
  } catch {
    return null;
  }
}

function parseSelection(value: unknown): ScopedAgentTurnInput["selection"] | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  try {
    return value.map(decodeSelectionRef);
  } catch {
    return null;
  }
}

function parseOutbox(value: unknown, scopeKey: AgentScopeKey): AgentTurnOutbox | null {
  const input = record(value);
  const turnId = canonicalTurnId(input?.turnId);
  const request = record(input?.request);
  if (!input || !turnId || !request || typeof input.fingerprint !== "string"
    || !Number.isFinite(input.createdAt) || request.turnId !== turnId
    || typeof request.message !== "string" || request.message.trim().length === 0
    || !Number.isSafeInteger(request.graphRevision)) return null;
  const explicitContext = parseContextRefs(request.explicitContext);
  const selection = parseSelection(request.selection);
  if (explicitContext === null || selection === null) return null;
  if (input.kind === "workspace") {
    if (scopeKey !== WORKSPACE_AGENT_SCOPE) return null;
    return {
      kind: "workspace",
      turnId,
      fingerprint: input.fingerprint,
      createdAt: Number(input.createdAt),
      request: {
        turnId,
        message: request.message.trim(),
        explicitContext,
        graphRevision: Number(request.graphRevision),
        ...(selection === undefined ? {} : { selection }),
      },
    };
  }
  if (input.kind !== "scoped" || (input.scopeType !== "artifact" && input.scopeType !== "resource")
    || typeof input.targetId !== "string" || input.targetId.length === 0
    || scopeKey !== `${input.scopeType}:${input.targetId}`
    || (request.intent !== "generate" && request.intent !== "edit" && request.intent !== "repair")
    || typeof request.baseRevisionId !== "string" || request.baseRevisionId.length === 0) return null;
  return {
    kind: "scoped",
    scopeType: input.scopeType,
    targetId: input.targetId,
    turnId,
    fingerprint: input.fingerprint,
    createdAt: Number(input.createdAt),
    request: {
      turnId,
      intent: request.intent,
      message: request.message.trim(),
      explicitContext,
      graphRevision: Number(request.graphRevision),
      baseRevisionId: request.baseRevisionId,
      ...(selection === undefined ? {} : { selection }),
    },
  };
}

function parseReceipt(value: unknown, scopeKey: AgentScopeKey): AgentSessionReceipt | null {
  const input = record(value);
  const turnId = canonicalTurnId(input?.turnId);
  if (!input || !turnId || !Number.isFinite(input.createdAt)) return null;
  if (input.kind === "workspace" && typeof input.proposalId === "string" && typeof input.status === "string") {
    if (scopeKey !== WORKSPACE_AGENT_SCOPE) return null;
    return {
      kind: "workspace",
      turnId,
      proposalId: input.proposalId,
      status: input.status,
      createdAt: Number(input.createdAt),
    };
  }
  if (input.kind !== "scoped") return null;
  try {
    const receipt = decodeScopedAgentTurnReceipt(input.receipt);
    if ((receipt.task.target.type !== "artifact" && receipt.task.target.type !== "resource")
      || scopeKey !== `${receipt.task.target.type}:${receipt.task.target.id}`) return null;
    return { kind: "scoped", turnId, receipt, createdAt: Number(input.createdAt) };
  } catch {
    return null;
  }
}

export function readAgentSession(projectId: string, scopeKey: AgentScopeKey): AgentSession {
  try {
    const stored = localStorage.getItem(storageKey(projectId, scopeKey));
    if (!stored) return emptyAgentSession();
    const input = record(JSON.parse(stored));
    if (!input || input.version !== 1 || input.projectId !== projectId || input.scopeKey !== scopeKey) {
      return emptyAgentSession();
    }
    return {
      draft: typeof input.draft === "string" ? input.draft.slice(0, MAX_DRAFT_LENGTH) : "",
      contextItems: parseContextItems(input.contextItems),
      transcript: parseTranscript(input.transcript),
      outbox: parseOutbox(input.outbox, scopeKey),
      receipt: parseReceipt(input.receipt, scopeKey),
    };
  } catch {
    return emptyAgentSession();
  }
}

export function writeAgentSession(projectId: string, scopeKey: AgentScopeKey, session: AgentSession): void {
  try {
    // Preview URLs are presentation-only capabilities. In particular, arbitrary
    // URLs restored from writable browser storage must never trigger a request.
    const contextItems = session.contextItems.slice(0, 32).map(({ previewUrl: _previewUrl, ...item }) => item);
    localStorage.setItem(storageKey(projectId, scopeKey), JSON.stringify({
      version: 1,
      projectId,
      scopeKey,
      draft: session.draft.slice(0, MAX_DRAFT_LENGTH),
      contextItems,
      transcript: session.transcript.slice(-MAX_TRANSCRIPT_ENTRIES),
      outbox: session.outbox,
      receipt: session.receipt,
    }));
  } catch {
    // Storage may be unavailable or quota-limited; the live session remains usable.
  }
}

export function upsertTranscriptEntry(
  entries: readonly AgentTranscriptEntry[],
  entry: AgentTranscriptEntry,
): AgentTranscriptEntry[] {
  const next = entries.some((candidate) => candidate.id === entry.id)
    ? entries.map((candidate) => candidate.id === entry.id ? entry : candidate)
    : [...entries, entry];
  return next.slice(-MAX_TRANSCRIPT_ENTRIES);
}
