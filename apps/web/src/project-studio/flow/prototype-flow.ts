import type {
  ArtifactRevision,
  WorkspaceDesignNodeLocator,
  WorkspaceEdge,
  WorkspacePrototypeBinding,
  WorkspaceRenderFrameSpec,
  WorkspaceSnapshot,
} from "../../lib/api.ts";

const MAX_BINDINGS = 64;
const MAX_BINDING_ID = 128;
const MAX_DESIGN_NODE_ID = 256;
const MAX_SOURCE_PATH = 1_024;
const MAX_SELECTOR = 4_096;
const MAX_TRANSITION_MS = 2_000;
const CONTROL = /[\u0000-\u001f\u007f]/;

type PrototypeWorkspaceEdge = Extract<WorkspaceEdge, { kind: "prototype" }>;
type PrototypeTrigger = WorkspacePrototypeBinding["trigger"];

export interface FrozenPrototypeFlowPage {
  readonly nodeId: string;
  readonly artifactId: string;
  readonly revisionId: string;
  readonly name: string;
  readonly renderSpec: Readonly<Record<string, unknown>> | null;
  readonly frames: readonly Readonly<WorkspaceRenderFrameSpec>[] | null;
}

export interface PrototypeFlowSession {
  readonly snapshotId: string;
  readonly workspaceId: string;
  readonly graphRevision: number;
  readonly startArtifactId: string;
  readonly pages: readonly FrozenPrototypeFlowPage[];
  readonly artifactRevisions: Readonly<Record<string, string | null>>;
  readonly prototypeEdges: readonly Readonly<PrototypeWorkspaceEdge>[];
  readonly bindingEdgeIds: Readonly<Record<string, string>>;
}

export interface PrototypeBindingDescriptor {
  readonly bindingId: string;
  readonly locator: Readonly<WorkspaceDesignNodeLocator>;
  readonly trigger: PrototypeTrigger;
}

export interface PrototypeModeCommand {
  readonly type: "set-prototype-bindings";
  readonly bindings: readonly PrototypeBindingDescriptor[];
}

export interface PrototypeActivation {
  readonly bindingId: string;
  readonly locator: WorkspaceDesignNodeLocator;
  readonly trigger: PrototypeTrigger;
}

export interface PrototypeActivationMessage extends PrototypeActivation {
  readonly source: "dezin";
  readonly type: "prototype-binding-activated";
  readonly nonce: string;
  readonly protocol: 1;
}

export type PrototypeActivationResult =
  | {
      kind: "navigate";
      edgeId: string;
      targetArtifactId: string;
      targetRevisionId: string;
      targetState: string | null;
      targetFrame: Readonly<WorkspaceRenderFrameSpec> | null;
      transition: { type: "none" | "fade" | "slide"; durationMs: number; easing?: string };
    }
  | { kind: "blocked"; reason: string };

export interface PrototypeFlowHealthItem {
  edgeId: string;
  status: "interactive" | "planned" | "broken";
  label: string;
  detail: string;
}

export type FrozenPrototypeEdgeValidation =
  | { status: "planned"; detail: string }
  | { status: "broken"; detail: string }
  | {
      status: "interactive";
      binding: Readonly<WorkspacePrototypeBinding>;
      sourceArtifactId: string;
      sourceRevisionId: string;
      targetArtifactId: string;
      targetRevisionId: string;
      targetState: string | null;
      targetFrame: Readonly<WorkspaceRenderFrameSpec> | null;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every((key) => fields.includes(key));
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !CONTROL.test(value);
}

function cloneLocator(locator: WorkspaceDesignNodeLocator): WorkspaceDesignNodeLocator {
  return Object.freeze({
    designNodeId: locator.designNodeId,
    ...(locator.sourcePath === undefined ? {} : { sourcePath: locator.sourcePath }),
    ...(locator.selector === undefined ? {} : { selector: locator.selector }),
  });
}

function parseLocator(value: unknown): WorkspaceDesignNodeLocator | null {
  if (!isRecord(value)) return null;
  const fields = [
    "designNodeId",
    ...(Object.hasOwn(value, "sourcePath") ? ["sourcePath"] : []),
    ...(Object.hasOwn(value, "selector") ? ["selector"] : []),
  ];
  if (!exactFields(value, fields)
    || !boundedString(value.designNodeId, MAX_DESIGN_NODE_ID)
    || (value.sourcePath !== undefined && !boundedString(value.sourcePath, MAX_SOURCE_PATH))
    || (value.selector !== undefined && !boundedString(value.selector, MAX_SELECTOR))) return null;
  return cloneLocator(value as unknown as WorkspaceDesignNodeLocator);
}

function sameLocator(left: WorkspaceDesignNodeLocator, right: WorkspaceDesignNodeLocator): boolean {
  return left.designNodeId === right.designNodeId
    && left.sourcePath === right.sourcePath
    && left.selector === right.selector;
}

function cloneBinding(binding: WorkspacePrototypeBinding): WorkspacePrototypeBinding {
  const transition = binding.transition === undefined
    ? undefined
    : Object.freeze({
        type: binding.transition.type,
        ...(binding.transition.durationMs === undefined ? {} : { durationMs: binding.transition.durationMs }),
        ...(binding.transition.easing === undefined ? {} : { easing: binding.transition.easing }),
      });
  return Object.freeze({
    sourceArtifactId: binding.sourceArtifactId,
    sourceRevisionId: binding.sourceRevisionId,
    sourceLocator: cloneLocator(binding.sourceLocator),
    trigger: binding.trigger,
    targetArtifactId: binding.targetArtifactId,
    ...(binding.targetState === undefined ? {} : { targetState: binding.targetState }),
    ...(transition === undefined ? {} : { transition }),
  });
}

function clonePrototypeEdge(edge: PrototypeWorkspaceEdge): Readonly<PrototypeWorkspaceEdge> {
  const prototype = edge.prototype.status === "interactive"
    ? Object.freeze({ status: "interactive" as const, binding: cloneBinding(edge.prototype.binding) })
    : edge.prototype.status === "planned"
      ? Object.freeze({ status: "planned" as const })
      : Object.freeze({
          status: "broken" as const,
          brokenReason: edge.prototype.brokenReason,
          ...(edge.prototype.binding === undefined ? {} : { binding: cloneBinding(edge.prototype.binding) }),
        });
  return Object.freeze({
    id: edge.id,
    workspaceId: edge.workspaceId,
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
    kind: "prototype" as const,
    prototype,
  });
}

function deepFreezeJson<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreezeJson(nested);
  return Object.freeze(value);
}

function cloneFrame(frame: WorkspaceRenderFrameSpec): Readonly<WorkspaceRenderFrameSpec> {
  const fixture = frame.fixture === undefined ? undefined : deepFreezeJson(structuredClone(frame.fixture));
  return Object.freeze({
    id: frame.id,
    name: frame.name,
    width: frame.width,
    height: frame.height,
    ...(frame.initialState === undefined ? {} : { initialState: frame.initialState }),
    ...(fixture === undefined ? {} : { fixture }),
    ...(frame.background === undefined ? {} : { background: frame.background }),
  });
}

function framesForRevision(revision: ArtifactRevision | undefined): readonly Readonly<WorkspaceRenderFrameSpec>[] | null {
  if (revision === undefined || !Array.isArray(revision.renderSpec.frames) || revision.renderSpec.frames.length > 64) return null;
  const frames: WorkspaceRenderFrameSpec[] = [];
  const ids = new Set<string>();
  for (const value of revision.renderSpec.frames) {
    if (!isRecord(value)) return null;
    if (!boundedString(value.id, 256) || value.id !== value.id.trim() || ids.has(value.id)
      || !boundedString(value.name, 256)
      || typeof value.width !== "number" || !Number.isFinite(value.width) || value.width <= 0 || value.width > 16_384
      || typeof value.height !== "number" || !Number.isFinite(value.height) || value.height <= 0 || value.height > 16_384
      || (value.initialState !== undefined && !boundedString(value.initialState, 256))
      || (value.fixture !== undefined && !isRecord(value.fixture))
      || (value.background !== undefined && typeof value.background !== "string")) return null;
    ids.add(value.id);
    frames.push({
      id: value.id,
      name: value.name.trim(),
      width: value.width,
      height: value.height,
      ...(value.initialState === undefined ? {} : { initialState: value.initialState }),
      ...(value.fixture === undefined ? {} : { fixture: structuredClone(value.fixture) }),
      ...(value.background === undefined ? {} : { background: value.background }),
    });
  }
  return frames.length > 0 ? Object.freeze(frames.map(cloneFrame)) : null;
}

function renderSpecForRevision(revision: ArtifactRevision | undefined): Readonly<Record<string, unknown>> | null {
  return revision === undefined ? null : deepFreezeJson(structuredClone(revision.renderSpec));
}

function bindingFor(edge: Readonly<PrototypeWorkspaceEdge>): WorkspacePrototypeBinding | undefined {
  return edge.prototype.status === "interactive" || edge.prototype.status === "broken"
    ? edge.prototype.binding
    : undefined;
}

export function presentablePrototypeFlowPages(
  snapshot: WorkspaceSnapshot,
  revisions: readonly ArtifactRevision[] = [],
): FrozenPrototypeFlowPage[] {
  return snapshot.graph.nodes
    .flatMap((node): FrozenPrototypeFlowPage[] => {
      if (node.kind !== "page") return [];
      const revisionId = snapshot.artifactRevisions[node.artifactId];
      const revision = revisions.find((candidate) => (
        candidate.id === revisionId
        && candidate.artifactId === node.artifactId
        && candidate.workspaceId === snapshot.workspaceId
      ));
      return typeof revisionId === "string" && revisionId.length > 0
        ? [{
            nodeId: node.id,
            artifactId: node.artifactId,
            revisionId,
            name: node.name,
            renderSpec: renderSpecForRevision(revision),
            frames: framesForRevision(revision),
          }]
        : [];
    })
    .sort((left, right) => left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0);
}

export function createPrototypeFlowSession(
  snapshot: WorkspaceSnapshot,
  selectedNodeIds: readonly string[],
  revisions: readonly ArtifactRevision[] = [],
): PrototypeFlowSession {
  const pages = presentablePrototypeFlowPages(snapshot, revisions).map((page) => Object.freeze({ ...page }));
  if (pages.length === 0) throw new Error("This Snapshot has no revision-backed Page to present.");
  const selected = selectedNodeIds.map((nodeId) => pages.find((page) => page.nodeId === nodeId)).find(Boolean);
  const prototypeEdges = snapshot.graph.edges
    .filter((edge): edge is PrototypeWorkspaceEdge => edge.kind === "prototype")
    .map(clonePrototypeEdge);
  const artifactRevisions = Object.freeze(Object.fromEntries(
    Object.entries(snapshot.artifactRevisions).map(([artifactId, revisionId]) => [artifactId, revisionId]),
  ));
  const bindingEdgeIds: Record<string, string> = {};
  let bindingIndex = 0;
  for (const edge of prototypeEdges) {
    if (bindingFor(edge) === undefined) continue;
    bindingEdgeIds[`binding-${bindingIndex.toString(36)}`] = edge.id;
    bindingIndex += 1;
  }
  return Object.freeze({
    snapshotId: snapshot.id,
    workspaceId: snapshot.workspaceId,
    graphRevision: snapshot.graphRevision,
    startArtifactId: selected?.artifactId ?? pages[0]!.artifactId,
    pages: Object.freeze(pages),
    artifactRevisions,
    prototypeEdges: Object.freeze(prototypeEdges),
    bindingEdgeIds: Object.freeze(bindingEdgeIds),
  });
}

function sourceNodeArtifactId(session: PrototypeFlowSession, edge: Readonly<PrototypeWorkspaceEdge>): string | null {
  return session.pages.find((page) => page.nodeId === edge.sourceNodeId)?.artifactId ?? null;
}

function baseEdgeValidation(
  session: PrototypeFlowSession,
  edge: Readonly<PrototypeWorkspaceEdge>,
): FrozenPrototypeEdgeValidation {
  if (edge.prototype.status === "planned") return { status: "planned", detail: "No binding yet." };
  if (edge.prototype.status === "broken") return { status: "broken", detail: edge.prototype.brokenReason };
  const binding = edge.prototype.binding;
  const sourcePage = session.pages.find((page) => page.nodeId === edge.sourceNodeId);
  if (sourcePage === undefined || binding.sourceArtifactId !== sourcePage.artifactId) {
    return { status: "broken", detail: "Prototype source does not match the frozen graph." };
  }
  if (binding.sourceRevisionId !== sourcePage.revisionId
    || session.artifactRevisions[sourcePage.artifactId] !== sourcePage.revisionId) {
    return { status: "broken", detail: "Prototype source Revision is stale for this frozen Snapshot." };
  }
  const locator = parseLocator(binding.sourceLocator);
  if (locator === null || (binding.trigger !== "click" && binding.trigger !== "submit")) {
    return { status: "broken", detail: "Prototype source locator or trigger is invalid." };
  }
  const targetPage = session.pages.find((page) => page.nodeId === edge.targetNodeId);
  if (targetPage === undefined || binding.targetArtifactId !== targetPage.artifactId) {
    return { status: "broken", detail: "Prototype target does not match the frozen graph." };
  }
  const targetRevisionId = session.artifactRevisions[targetPage.artifactId];
  if (typeof targetRevisionId !== "string" || targetRevisionId !== targetPage.revisionId) {
    return { status: "broken", detail: "Prototype target has no exact Revision in this frozen Snapshot." };
  }
  let targetFrame: Readonly<WorkspaceRenderFrameSpec> | null = null;
  if (binding.targetState !== undefined) {
    const matches = targetPage.frames?.filter((frame) => frame.initialState === binding.targetState) ?? [];
    if (matches.length !== 1) {
      return {
        status: "broken",
        detail: matches.length > 1
          ? `Target RenderSpec state ${binding.targetState} is ambiguous.`
          : `Target RenderSpec state ${binding.targetState} does not exist in Revision ${targetRevisionId}.`,
      };
    }
    targetFrame = matches[0]!;
  }
  return {
    status: "interactive",
    binding,
    sourceArtifactId: sourcePage.artifactId,
    sourceRevisionId: sourcePage.revisionId,
    targetArtifactId: targetPage.artifactId,
    targetRevisionId,
    targetState: binding.targetState ?? null,
    targetFrame,
  };
}

export function validateFrozenPrototypeEdge(
  session: PrototypeFlowSession,
  edge: Readonly<PrototypeWorkspaceEdge>,
): FrozenPrototypeEdgeValidation {
  const validation = baseEdgeValidation(session, edge);
  if (validation.status !== "interactive") return validation;
  const collisions = session.prototypeEdges.filter((candidate) => {
    const other = baseEdgeValidation(session, candidate);
    return other.status === "interactive"
      && other.sourceArtifactId === validation.sourceArtifactId
      && other.binding.trigger === validation.binding.trigger
      && sameLocator(other.binding.sourceLocator, validation.binding.sourceLocator);
  });
  return collisions.length > 1
    ? { status: "broken", detail: `Ambiguous prototype binding: ${collisions.length} exact matches.` }
    : validation;
}

export function buildPrototypeModeCommand(
  session: PrototypeFlowSession,
  sourceArtifactId: string,
): PrototypeModeCommand {
  const revisionId = session.artifactRevisions[sourceArtifactId];
  const bindingIdByEdge = new Map(Object.entries(session.bindingEdgeIds).map(([bindingId, edgeId]) => [edgeId, bindingId]));
  const bindings = session.prototypeEdges.flatMap((edge): PrototypeBindingDescriptor[] => {
    const validation = validateFrozenPrototypeEdge(session, edge);
    const binding = validation.status === "interactive" ? validation.binding : undefined;
    const bindingId = bindingIdByEdge.get(edge.id);
    if (binding === undefined || bindingId === undefined
      || validation.status !== "interactive"
      || validation.sourceArtifactId !== sourceArtifactId
      || validation.sourceRevisionId !== revisionId) return [];
    const locator = parseLocator(binding.sourceLocator);
    if (locator === null || (binding.trigger !== "click" && binding.trigger !== "submit")) return [];
    return [Object.freeze({ bindingId, locator, trigger: binding.trigger })];
  });
  if (bindings.length > MAX_BINDINGS) throw new Error(`Prototype mode supports at most ${MAX_BINDINGS} bindings per Page.`);
  return Object.freeze({ type: "set-prototype-bindings", bindings: Object.freeze(bindings) });
}

export function parsePrototypeActivation(value: unknown, nonce: string): PrototypeActivationMessage | null {
  if (!isRecord(value) || !exactFields(value, [
    "source",
    "type",
    "nonce",
    "protocol",
    "bindingId",
    "locator",
    "trigger",
  ])) return null;
  const locator = parseLocator(value.locator);
  if (value.source !== "dezin"
    || value.type !== "prototype-binding-activated"
    || value.protocol !== 1
    || value.nonce !== nonce
    || !boundedString(value.bindingId, MAX_BINDING_ID)
    || (value.trigger !== "click" && value.trigger !== "submit")
    || locator === null) return null;
  return {
    source: "dezin",
    type: "prototype-binding-activated",
    nonce,
    protocol: 1,
    bindingId: value.bindingId,
    locator,
    trigger: value.trigger,
  };
}

function normalizedTransition(binding: WorkspacePrototypeBinding): {
  type: "none" | "fade" | "slide";
  durationMs: number;
  easing?: string;
} {
  const transition = binding.transition;
  if (!transition || transition.type === "none") return { type: "none", durationMs: 0 };
  const durationMs = typeof transition.durationMs === "number" && Number.isFinite(transition.durationMs)
    ? Math.min(MAX_TRANSITION_MS, Math.max(0, Math.round(transition.durationMs)))
    : 180;
  const easing = boundedString(transition.easing, 128) ? transition.easing : undefined;
  return {
    type: transition.type === "slide" ? "slide" : "fade",
    durationMs,
    ...(easing === undefined ? {} : { easing }),
  };
}

export function resolvePrototypeActivation(
  session: PrototypeFlowSession,
  sourceArtifactId: string,
  activation: PrototypeActivation,
): PrototypeActivationResult {
  const edgeId = session.bindingEdgeIds[activation.bindingId];
  const edge = session.prototypeEdges.find((candidate) => candidate.id === edgeId);
  if (edge === undefined) {
    return { kind: "blocked", reason: "Prototype binding did not match this frozen Snapshot." };
  }
  const validation = validateFrozenPrototypeEdge(session, edge);
  if (validation.status !== "interactive") {
    return { kind: "blocked", reason: validation.detail };
  }
  if (validation.sourceArtifactId !== sourceArtifactId
    || validation.binding.trigger !== activation.trigger
    || !sameLocator(validation.binding.sourceLocator, activation.locator)) {
    return { kind: "blocked", reason: "Prototype binding did not match this frozen Snapshot." };
  }
  return {
    kind: "navigate",
    edgeId: edge.id,
    targetArtifactId: validation.targetArtifactId,
    targetRevisionId: validation.targetRevisionId,
    targetState: validation.targetState,
    targetFrame: validation.targetFrame,
    transition: normalizedTransition(validation.binding),
  };
}

export function prototypeFlowHealth(
  session: PrototypeFlowSession,
  sourceArtifactId: string,
): { interactive: number; planned: number; broken: number; items: PrototypeFlowHealthItem[] } {
  const relevant = session.prototypeEdges.filter((edge) => sourceNodeArtifactId(session, edge) === sourceArtifactId);
  const evaluated = relevant.map((edge) => ({ edge, validation: validateFrozenPrototypeEdge(session, edge) }));
  const overInteractiveLimit = evaluated.filter(({ validation }) => validation.status === "interactive").length > MAX_BINDINGS;
  const items = evaluated.map(({ edge, validation }): PrototypeFlowHealthItem => {
    const targetName = session.pages.find((page) => page.nodeId === edge.targetNodeId)?.name ?? "Unknown Page";
    if (validation.status === "planned") {
      return { edgeId: edge.id, status: "planned", label: "Planned connection", detail: `To ${targetName} · no binding yet` };
    }
    if (validation.status === "broken") {
      return { edgeId: edge.id, status: "broken", label: "Broken connection", detail: validation.detail };
    }
    if (overInteractiveLimit) {
      return {
        edgeId: edge.id,
        status: "broken",
        label: "Disabled connection",
        detail: `This Page exceeds the ${MAX_BINDINGS} interactive binding limit.`,
      };
    }
    return {
      edgeId: edge.id,
      status: "interactive",
      label: `${validation.binding.trigger === "submit" ? "Submit" : "Click"} to ${targetName}`,
      detail: validation.targetState === null
        ? validation.binding.sourceLocator.designNodeId
        : `${validation.binding.sourceLocator.designNodeId} · state ${validation.targetState}`,
    };
  });
  return {
    interactive: items.filter((item) => item.status === "interactive").length,
    planned: items.filter((item) => item.status === "planned").length,
    broken: items.filter((item) => item.status === "broken").length,
    items,
  };
}
