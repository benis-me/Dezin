import { createHash } from "node:crypto";

export type ResourceKind =
  | "research"
  | "moodboard"
  | "sharingan-capture"
  | "file"
  | "asset"
  | "effect"
  | "external-reference";

/** Resource kinds backed by the shared immutable payload contract. */
export type BaseResourceKind = ResourceKind;

export interface AgentScope {
  type: "workspace" | "artifact" | "resource";
  id: string;
}

/** Stored conversation scopes are resolved by the HTTP integration boundary. */
export type ConversationScope = AgentScope;
export type ResolvedAgentScope = AgentScope & { workspaceId: string };

export interface SelectionRef {
  kind: "node" | "artifact" | "resource" | "element";
  id: string;
  revisionId?: string;
}

export type ContextItemRef =
  | { kind: "resource"; id: string; resourceKind: ResourceKind; revisionId?: string }
  | { kind: "artifact"; id: string; revisionId?: string }
  | { kind: "kernel"; id: string; revisionId?: string }
  | { kind: "inline"; id: string };

export type AgentIntent = "plan" | "generate" | "edit" | "repair" | "analyze-impact";

export interface AgentTurnRequest {
  scope: ResolvedAgentScope;
  intent: AgentIntent;
  message: string;
  explicitContext: readonly ContextItemRef[];
  graphRevision: number;
  turnId?: string;
  baseRevisionId?: string;
  selection?: readonly SelectionRef[];
}

export const AGENT_TURN_ID_PATTERN = /^turn-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** @deprecated Use the scope-neutral Agent turn identifier contract. */
export const SCOPED_AGENT_TURN_ID_PATTERN = AGENT_TURN_ID_PATTERN;

export function normalizeAgentTurnId(value: unknown): string {
  if (typeof value !== "string" || !AGENT_TURN_ID_PATTERN.test(value)) {
    throw new ContextIntegrityError("Agent turnId must be canonical turn-<lowercase UUID v4>");
  }
  return value;
}

export function normalizeScopedAgentTurnId(value: unknown): string {
  return normalizeAgentTurnId(value);
}

export type ContextItemClass =
  | "system-kernel"
  | "target"
  | "selection"
  | "explicit"
  | "direct-dependency"
  | "prototype-neighbor"
  | "conversation"
  | "indirect";

export const CONTEXT_PRIORITY: readonly ContextItemClass[] = [
  "system-kernel",
  "target",
  "selection",
  "explicit",
  "direct-dependency",
  "prototype-neighbor",
  "conversation",
  "indirect",
] as const;

export type ResolvedContextKind = "artifact-revision" | "resource-revision" | "kernel-revision" | "inline";
export type ContextTrustLevel = "system" | "trusted" | "untrusted";

export interface ContextBoundary {
  source: string;
  readOnly: true;
  mayGrantCapabilities: false;
  delimiter?: string;
}

export interface ContextCandidate {
  contextClass: ContextItemClass;
  ref: ContextItemRef;
  resolvedKind: ResolvedContextKind;
  content: string;
  compactContent?: string;
  checksum: string;
  reason: string;
  trustLevel: ContextTrustLevel;
  capabilities: readonly string[];
  boundary: ContextBoundary;
  tokenEstimate: number;
  provenance: Readonly<Record<string, unknown>>;
  provided: boolean;
}

export interface ResolvedContextItem extends Omit<ContextCandidate, "compactContent"> {
  ordinal: number;
}

export interface ContextOmission {
  ref: ContextItemRef;
  contextClass: ContextItemClass;
  reason: string;
  tokenEstimate: number;
}

export interface ContextPack {
  id: string;
  workspaceId: string;
  graphRevision: number;
  target: AgentScope;
  intent: AgentIntent;
  messageChecksum: string;
  items: readonly ResolvedContextItem[];
  omissions: readonly ContextOmission[];
  tokenEstimate: number;
  manifestPath: string;
  hash: string;
  createdAt: number;
}

export interface ContextPackDraft {
  workspaceId: string;
  graphRevision: number;
  target: AgentScope;
  intent: AgentIntent;
  messageChecksum: string;
  items: readonly ResolvedContextItem[];
  omissions: readonly ContextOmission[];
  tokenEstimate: number;
}

export type ContextPackUsageKind = "observed-read" | "agent-declared-used";

export interface ContextPackItemUsage {
  contextPackId: string;
  workspaceId: string;
  ordinal: number;
  sequence: number;
  usageKind: ContextPackUsageKind;
  runId: string | null;
  evidence: Readonly<Record<string, unknown>>;
  recordedAt: number;
}

export type AppendContextPackItemUsageInput = Omit<ContextPackItemUsage, "sequence" | "recordedAt">;

export interface ContextPackRepository {
  findByHash(workspaceId: string, hash: string): ContextPack | null;
  insert(pack: ContextPack): ContextPack;
  get(workspaceId: string, id: string): ContextPack | null;
  appendUsage(input: AppendContextPackItemUsageInput): ContextPackItemUsage;
  listUsage(workspaceId: string, contextPackId: string, ordinal: number): readonly ContextPackItemUsage[];
}

export type ResourceSnapshotSource =
  | {
    type: "moodboard-bundle";
    board: Readonly<Record<string, unknown>>;
    nodes: readonly unknown[];
    messages: readonly unknown[];
    assets: readonly {
      id: string;
      metadata: Readonly<Record<string, unknown>>;
      bytes: Uint8Array;
    }[];
  }
  | { type: "effect-definition"; definition: Readonly<Record<string, unknown>> }
  | { type: "owned-file"; path: string; mimeType: string; label?: string }
  | {
    type: "bounded-external";
    url: string;
    finalUrl: string;
    status: number;
    mimeType: string;
    bytes: Uint8Array;
  };

export interface ResourceSnapshotInput {
  workspaceId: string;
  resourceId: string;
  revisionId: string;
  kind: ResourceKind;
  workspaceRoot: string;
  snapshotRoot: string;
  source: ResourceSnapshotSource;
  provenance: Readonly<Record<string, unknown>>;
  createdAt: number;
}

export interface ResourceRevisionSnapshot {
  id: string;
  workspaceId: string;
  resourceId: string;
  kind: ResourceKind;
  checksum: string;
  payloadChecksum: string;
  byteSize: number;
  mimeType: string;
  manifestPath: string;
  snapshotPath: string;
  storageState: "created" | "existing";
  content: string;
  provenance: Readonly<Record<string, unknown>>;
  createdAt: number;
}

export interface ResourceResolveInput {
  request: AgentTurnRequest;
  contextClass: ContextItemClass;
  requestedRef: ContextItemRef;
  revision: ResourceRevisionSnapshot;
  storageRoot: string;
}

export interface ResourceContextAdapter {
  readonly kind: BaseResourceKind;
  snapshot(input: ResourceSnapshotInput): Promise<ResourceRevisionSnapshot>;
  resolve(input: ResourceResolveInput): Promise<ContextCandidate[]>;
}

export type ExplicitContextResolution = ContextCandidate | readonly ContextCandidate[] | ResourceRevisionSnapshot | null;

export interface ContextCandidateSource {
  collect(request: AgentTurnRequest, contextClass: Exclude<ContextItemClass, "explicit">): Promise<readonly ContextCandidate[]>;
  resolveExplicit(request: AgentTurnRequest, ref: ContextItemRef): Promise<ExplicitContextResolution>;
}

export class BlockedContextError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[] | string, message?: string) {
    const values = typeof missing === "string" ? [missing] : [...missing];
    super(message ?? `Context resolution blocked: ${values.join(", ")}`);
    this.name = "BlockedContextError";
    this.missing = Object.freeze(values);
  }
}

export class ContextIntegrityError extends BlockedContextError {
  constructor(message: string) {
    super([message], message);
    this.name = "ContextIntegrityError";
  }
}

export function isWellFormedContextText(value: string): boolean {
  const native = value as string & { isWellFormed?: () => boolean };
  if (typeof native.isWellFormed === "function") return native.isWellFormed();
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

interface CanonicalizeState {
  active: WeakSet<object>;
  visited: number;
}

function canonicalize(
  value: unknown,
  state: CanonicalizeState = { active: new WeakSet<object>(), visited: 0 },
  depth = 0,
): unknown {
  state.visited += 1;
  if (state.visited > 1_000_000 || depth > 256) {
    throw new TypeError("Context values exceed their canonical structural limit");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 16 * 1024 * 1024) {
      throw new TypeError("Context string values exceed their canonical size limit");
    }
    if (!isWellFormedContextText(value)) {
      throw new TypeError("Context values must contain only well-formed UTF-16 strings");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Context values must contain only finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000_000) throw new TypeError("Context arrays exceed their canonical length limit");
    if (state.active.has(value)) throw new TypeError("Context values cannot contain cyclic references");
    state.active.add(value);
    try {
      return value.map((item) => canonicalize(item === undefined ? null : item, state, depth + 1));
    } finally {
      state.active.delete(value);
    }
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Context values must contain only plain JSON objects");
    }
    if (state.active.has(record)) throw new TypeError("Context values cannot contain cyclic references");
    state.active.add(record);
    try {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        if (key.length > 1024 * 1024) {
          throw new TypeError("Context object keys exceed their canonical size limit");
        }
        if (!isWellFormedContextText(key)) {
          throw new TypeError("Context object keys must contain only well-formed UTF-16 strings");
        }
        if (record[key] !== undefined) result[key] = canonicalize(record[key], state, depth + 1);
      }
      return result;
    } finally {
      state.active.delete(record);
    }
  }
  throw new TypeError(`Context values cannot contain ${typeof value}`);
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function checksumBytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function estimateContextTokens(content: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(content, "utf8") / 4));
}

export function cloneAndFreeze<T>(value: T): T {
  const clone = structuredClone(value);
  const seen = new WeakSet<object>();
  const freeze = (current: unknown): void => {
    if (!current || typeof current !== "object" || Object.isFrozen(current)) return;
    if (seen.has(current)) return;
    seen.add(current);
    if (ArrayBuffer.isView(current)) return;
    for (const child of Object.values(current as Record<string, unknown>)) freeze(child);
    Object.freeze(current);
  };
  freeze(clone);
  return clone;
}

export function assertIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new ContextIntegrityError(`${label} is not a safe identifier`);
  }
}

export function assertPortableContextValue(
  value: unknown,
  label = "Context provenance",
  maxBytes = 512 * 1024,
): void {
  let visited = 0;
  let bytes = 0;
  const visit = (current: unknown, depth: number): void => {
    visited += 1;
    if (visited > 16_384 || depth > 32) throw new ContextIntegrityError(`${label} exceeds its structural limit`);
    if (typeof current === "string") {
      if (!isWellFormedContextText(current)) {
        throw new ContextIntegrityError(`${label} contains invalid UTF-16 text`);
      }
      bytes += Buffer.byteLength(current, "utf8");
      if (bytes > maxBytes) throw new ContextIntegrityError(`${label} exceeds its byte limit`);
      if (current.startsWith("/") || current.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(current)) {
        throw new ContextIntegrityError(`${label} contains an absolute non-portable provenance path`);
      }
      return;
    }
    if (current === null || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new ContextIntegrityError(`${label} contains a non-finite number`);
      return;
    }
    if (current === undefined) throw new ContextIntegrityError(`${label} cannot contain undefined values`);
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
      return;
    }
    if (typeof current === "object") {
      if (ArrayBuffer.isView(current)) throw new ContextIntegrityError(`${label} cannot contain mutable byte views`);
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new ContextIntegrityError(`${label} must contain only plain JSON objects`);
      }
      for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
        if (!isWellFormedContextText(key)) {
          throw new ContextIntegrityError(`${label} contains an invalid UTF-16 object key`);
        }
        bytes += Buffer.byteLength(key, "utf8");
        if (bytes > maxBytes) throw new ContextIntegrityError(`${label} exceeds its byte limit`);
        visit(child, depth + 1);
      }
      return;
    }
    throw new ContextIntegrityError(`${label} contains an unsupported value`);
  };
  visit(value, 0);
}

function runtimeRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContextIntegrityError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ContextIntegrityError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactRuntimeFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new ContextIntegrityError(`${label} contains unsupported field ${field}`);
  }
  for (const field of required) {
    if (!Object.hasOwn(value, field)) throw new ContextIntegrityError(`${label} is missing field ${field}`);
  }
}

function runtimeId(value: unknown, label: string): string {
  if (typeof value !== "string") throw new ContextIntegrityError(`${label} must be a string`);
  assertIdentifier(value, label);
  return value;
}

export function normalizeContextItemRef(value: unknown, label = "Context item ref"): ContextItemRef {
  const input = runtimeRecord(value, label);
  if (input.kind === "resource") {
    exactRuntimeFields(input, ["kind", "id", "resourceKind"], ["revisionId"], label);
    const resourceKinds: readonly ResourceKind[] = [
      "research", "moodboard", "sharingan-capture", "file", "asset", "effect", "external-reference",
    ];
    if (!resourceKinds.includes(input.resourceKind as ResourceKind)) {
      throw new ContextIntegrityError(`${label} Resource kind is unsupported`);
    }
    return {
      kind: "resource",
      id: runtimeId(input.id, `${label} id`),
      resourceKind: input.resourceKind as ResourceKind,
      ...(input.revisionId === undefined ? {} : { revisionId: runtimeId(input.revisionId, `${label} Revision id`) }),
    };
  }
  if (input.kind !== "artifact" && input.kind !== "kernel" && input.kind !== "inline") {
    throw new ContextIntegrityError(`${label} kind is unsupported`);
  }
  exactRuntimeFields(input, ["kind", "id"], input.kind === "inline" ? [] : ["revisionId"], label);
  if (input.kind === "inline") return { kind: "inline", id: runtimeId(input.id, `${label} id`) };
  const revision = input.revisionId === undefined
    ? {}
    : { revisionId: runtimeId(input.revisionId, `${label} Revision id`) };
  return input.kind === "artifact"
    ? { kind: "artifact", id: runtimeId(input.id, `${label} id`), ...revision }
    : { kind: "kernel", id: runtimeId(input.id, `${label} id`), ...revision };
}

/** Reusable strict HTTP/runtime boundary for the Resolver's owned request. */
export function normalizeAgentTurnRequest(value: unknown): AgentTurnRequest {
  const input = runtimeRecord(value, "Agent turn request");
  exactRuntimeFields(
    input,
    ["scope", "intent", "message", "explicitContext", "graphRevision"],
    ["turnId", "baseRevisionId", "selection"],
    "Agent turn request",
  );
  const scope = runtimeRecord(input.scope, "Agent turn scope");
  exactRuntimeFields(scope, ["type", "id", "workspaceId"], [], "Agent turn scope");
  if (scope.type !== "workspace" && scope.type !== "artifact" && scope.type !== "resource") {
    throw new ContextIntegrityError("Agent turn scope type is unsupported");
  }
  const intents: readonly AgentIntent[] = ["plan", "generate", "edit", "repair", "analyze-impact"];
  if (!intents.includes(input.intent as AgentIntent)) throw new ContextIntegrityError("Agent turn intent is unsupported");
  if (typeof input.message !== "string" || !isWellFormedContextText(input.message)
    || Buffer.byteLength(input.message, "utf8") > 1024 * 1024) {
    throw new ContextIntegrityError("Agent turn message exceeds its byte limit or contains invalid UTF-16");
  }
  if (!Array.isArray(input.explicitContext) || input.explicitContext.length > 64) {
    throw new ContextIntegrityError("Agent explicit Context must be a bounded array");
  }
  if (!Number.isSafeInteger(input.graphRevision) || (input.graphRevision as number) < 0) {
    throw new ContextIntegrityError("Agent turn graph Revision is invalid");
  }
  const explicitContext = input.explicitContext.map(
    (ref, index) => normalizeContextItemRef(ref, `Agent Context ref ${index}`),
  );
  const explicitKeys = new Set<string>();
  for (const ref of explicitContext) {
    const key = stableStringify(ref);
    if (explicitKeys.has(key)) {
      throw new ContextIntegrityError(`Agent turn contains duplicate explicit Context reference ${ref.id}`);
    }
    explicitKeys.add(key);
  }
  let selection: SelectionRef[] | undefined;
  if (input.selection !== undefined) {
    if (!Array.isArray(input.selection) || input.selection.length > 256) {
      throw new ContextIntegrityError("Agent selection must be a bounded array");
    }
    selection = input.selection.map((value, index) => {
      const selected = runtimeRecord(value, `Agent selection ${index}`);
      exactRuntimeFields(selected, ["kind", "id"], ["revisionId"], `Agent selection ${index}`);
      if (selected.kind !== "node" && selected.kind !== "artifact"
        && selected.kind !== "resource" && selected.kind !== "element") {
        throw new ContextIntegrityError(`Agent selection ${index} kind is unsupported`);
      }
      return {
        kind: selected.kind,
        id: runtimeId(selected.id, `Agent selection ${index} id`),
        ...(selected.revisionId === undefined
          ? {}
          : { revisionId: runtimeId(selected.revisionId, `Agent selection ${index} Revision id`) }),
      };
    });
    const selectionKeys = new Set<string>();
    for (const selected of selection) {
      const key = stableStringify(selected);
      if (selectionKeys.has(key)) {
        throw new ContextIntegrityError(`Agent turn contains duplicate selection ${selected.id}`);
      }
      selectionKeys.add(key);
    }
  }
  return cloneAndFreeze({
    scope: {
      type: scope.type,
      id: runtimeId(scope.id, "Agent turn target id"),
      workspaceId: runtimeId(scope.workspaceId, "Agent turn Workspace id"),
    },
    intent: input.intent as AgentIntent,
    message: input.message,
    explicitContext,
    graphRevision: input.graphRevision as number,
    ...(input.turnId === undefined ? {} : { turnId: normalizeAgentTurnId(input.turnId) }),
    ...(input.baseRevisionId === undefined
      ? {}
      : { baseRevisionId: runtimeId(input.baseRevisionId, "Agent turn base Revision id") }),
    ...(selection === undefined ? {} : { selection }),
  });
}
