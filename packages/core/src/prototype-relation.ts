import type {
  DesignNodeLocator,
  PrototypeBinding,
  PrototypeTransition,
  WorkspaceEdge,
} from "./workspace-types.ts";
import {
  RENDER_FRAME_NAME_LIMIT,
  isExactRenderFrameCaptureViewport,
} from "./render-frame-constraints.ts";

export const DEFAULT_PROTOTYPE_TRANSITION_DURATION_MS = 180;
export const MAX_PROTOTYPE_TRANSITION_DURATION_MS = 2_000;

const MAX_DESIGN_NODE_ID = 256;
const MAX_SOURCE_PATH = 1_024;
const MAX_SELECTOR = 4_096;
const MAX_EASING = 128;
const MAX_RENDER_FRAMES = 64;
const MAX_FRAME_TEXT = 256;
const MAX_FRAME_BACKGROUND = 4_096;
const CONTROL = /[\u0000-\u001f\u007f]/;

type FrozenPrototypeEdge = Extract<WorkspaceEdge, { kind: "prototype" }>;

export interface FrozenPrototypeEndpoint {
  readonly nodeId: string;
  readonly artifactId: string;
  readonly revisionId: string | null;
  /** Exact RenderSpec states; duplicates are valid across viewport Frames. Null means unavailable/invalid. */
  readonly targetStates: readonly string[] | null;
}

export interface ResolvedPrototypeTransition {
  readonly type: "none" | "fade" | "slide";
  readonly durationMs: number;
  readonly easing?: string;
}

export interface FrozenPrototypeRenderFrame {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly initialState?: string;
  readonly fixture?: Readonly<Record<string, unknown>>;
  readonly background?: string;
}

export interface FrozenPrototypeFrameSelectionInput {
  readonly currentFrame: Readonly<FrozenPrototypeRenderFrame> | null;
  readonly targetState: string | null;
}

interface ResolvedPrototypeRelationBase {
  readonly edgeId: string;
  readonly detail: string;
  readonly binding: Readonly<PrototypeBinding> | null;
  readonly transition: Readonly<ResolvedPrototypeTransition> | null;
}

export type ResolvedFrozenPrototypeRelation =
  | (ResolvedPrototypeRelationBase & { readonly status: "planned" })
  | (ResolvedPrototypeRelationBase & { readonly status: "broken" })
  | (ResolvedPrototypeRelationBase & {
      readonly status: "interactive";
      readonly binding: Readonly<PrototypeBinding>;
      readonly transition: Readonly<ResolvedPrototypeTransition>;
      readonly sourceArtifactId: string;
      readonly sourceRevisionId: string;
      readonly targetArtifactId: string;
      readonly targetRevisionId: string;
      readonly targetState: string | null;
    });

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !CONTROL.test(value);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreezeJson<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreezeJson(nested);
  return Object.freeze(value);
}

/** Parses the exact frozen frame surface used to validate prototype target states. */
export function readFrozenPrototypeRenderFrames(
  renderSpec: unknown,
): readonly Readonly<FrozenPrototypeRenderFrame>[] | null {
  if (!plainRecord(renderSpec) || !Array.isArray(renderSpec.frames)
    || renderSpec.frames.length === 0 || renderSpec.frames.length > MAX_RENDER_FRAMES) return null;
  const frames: FrozenPrototypeRenderFrame[] = [];
  const ids = new Set<string>();
  try {
    for (const value of renderSpec.frames) {
      if (!plainRecord(value)
        || !boundedString(value.id, MAX_FRAME_TEXT) || value.id !== value.id.trim() || ids.has(value.id)
        || !boundedString(value.name, RENDER_FRAME_NAME_LIMIT) || value.name !== value.name.trim()
        || !isExactRenderFrameCaptureViewport(value.width, value.height)
        || (value.initialState !== undefined
          && (!boundedString(value.initialState, MAX_FRAME_TEXT) || value.initialState !== value.initialState.trim()))
        || (value.fixture !== undefined && !plainRecord(value.fixture))
        || (value.background !== undefined
          && (!boundedString(value.background, MAX_FRAME_BACKGROUND) || value.background !== value.background.trim()))) {
        return null;
      }
      ids.add(value.id);
      frames.push(Object.freeze({
        id: value.id,
        name: value.name.trim(),
        width: value.width as number,
        height: value.height as number,
        ...(value.initialState === undefined ? {} : { initialState: value.initialState }),
        ...(value.fixture === undefined
          ? {}
          : { fixture: deepFreezeJson(structuredClone(value.fixture)) }),
        ...(value.background === undefined ? {} : { background: value.background }),
      }));
    }
  } catch {
    return null;
  }
  return Object.freeze(frames);
}

function viewportOrientation(frame: Readonly<FrozenPrototypeRenderFrame>): -1 | 0 | 1 {
  return frame.width === frame.height ? 0 : frame.width > frame.height ? 1 : -1;
}

/**
 * Selects one exact frozen Frame for prototype playback. State is a logical
 * filter, while viewport identity remains independent: preserve an exact Frame
 * id first, then the closest dimensions/profile with a stable id tie-break.
 */
export function selectFrozenPrototypeRenderFrame(
  frames: readonly Readonly<FrozenPrototypeRenderFrame>[] | null,
  input: FrozenPrototypeFrameSelectionInput,
): Readonly<FrozenPrototypeRenderFrame> | null {
  if (frames === null) return null;
  const candidates = input.targetState === null
    ? [...frames]
    : frames.filter((frame) => frame.initialState === input.targetState);
  if (candidates.length === 0) return null;
  const current = input.currentFrame;
  if (current === null) return candidates[0]!;
  const sameId = candidates.find((frame) => frame.id === current.id);
  if (sameId !== undefined) return sameId;
  const currentOrientation = viewportOrientation(current);
  return candidates.sort((left, right) => {
    const leftExactSize = left.width === current.width && left.height === current.height ? 0 : 1;
    const rightExactSize = right.width === current.width && right.height === current.height ? 0 : 1;
    if (leftExactSize !== rightExactSize) return leftExactSize - rightExactSize;
    const leftProfile = viewportOrientation(left) === currentOrientation ? 0 : 1;
    const rightProfile = viewportOrientation(right) === currentOrientation ? 0 : 1;
    if (leftProfile !== rightProfile) return leftProfile - rightProfile;
    const leftDistance = Math.abs(left.width - current.width) / current.width
      + Math.abs(left.height - current.height) / current.height;
    const rightDistance = Math.abs(right.width - current.width) / current.width
      + Math.abs(right.height - current.height) / current.height;
    if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  })[0]!;
}

function validLocator(locator: DesignNodeLocator): boolean {
  return boundedString(locator.designNodeId, MAX_DESIGN_NODE_ID)
    && (locator.sourcePath === undefined || boundedString(locator.sourcePath, MAX_SOURCE_PATH))
    && (locator.selector === undefined || boundedString(locator.selector, MAX_SELECTOR));
}

/**
 * Resolves the single presentation contract consumed by Agent Context and the
 * Viewer. The graph keeps the authored value for backward compatibility; all
 * runtime surfaces consume this rounded and bounded effective transition.
 */
export function resolvePrototypeTransition(
  transition: Readonly<PrototypeTransition> | undefined,
): ResolvedPrototypeTransition {
  if (transition === undefined || transition.type === "none") {
    return { type: "none", durationMs: 0 };
  }
  const durationMs = typeof transition.durationMs === "number" && Number.isFinite(transition.durationMs)
    ? Math.min(
        MAX_PROTOTYPE_TRANSITION_DURATION_MS,
        Math.max(0, Math.round(transition.durationMs)),
      )
    : DEFAULT_PROTOTYPE_TRANSITION_DURATION_MS;
  const easing = boundedString(transition.easing, MAX_EASING) ? transition.easing : undefined;
  return {
    type: transition.type === "slide" ? "slide" : "fade",
    durationMs,
    ...(easing === undefined ? {} : { easing }),
  };
}

function broken(
  edge: Readonly<FrozenPrototypeEdge>,
  detail: string,
  binding: Readonly<PrototypeBinding> | null,
): ResolvedFrozenPrototypeRelation {
  return {
    edgeId: edge.id,
    status: "broken",
    detail,
    binding,
    transition: binding === null ? null : resolvePrototypeTransition(binding.transition),
  };
}

function baseResolution(
  edge: Readonly<FrozenPrototypeEdge>,
  endpointsByNodeId: ReadonlyMap<string, Readonly<FrozenPrototypeEndpoint>>,
): ResolvedFrozenPrototypeRelation {
  if (edge.prototype.status === "planned") {
    return {
      edgeId: edge.id,
      status: "planned",
      detail: "No binding yet.",
      binding: null,
      transition: null,
    };
  }
  if (edge.prototype.status === "broken") {
    return broken(edge, edge.prototype.brokenReason, edge.prototype.binding ?? null);
  }
  const binding = edge.prototype.binding;
  const source = endpointsByNodeId.get(edge.sourceNodeId);
  if (source === undefined || binding.sourceArtifactId !== source.artifactId) {
    return broken(edge, "Prototype source does not match the frozen graph.", binding);
  }
  if (source.revisionId === null || binding.sourceRevisionId !== source.revisionId) {
    return broken(edge, "Prototype source Revision is stale for this frozen Snapshot.", binding);
  }
  if (!validLocator(binding.sourceLocator) || (binding.trigger !== "click" && binding.trigger !== "submit")) {
    return broken(edge, "Prototype source locator or trigger is invalid.", binding);
  }
  const target = endpointsByNodeId.get(edge.targetNodeId);
  if (target === undefined || binding.targetArtifactId !== target.artifactId) {
    return broken(edge, "Prototype target does not match the frozen graph.", binding);
  }
  if (target.revisionId === null) {
    return broken(edge, "Prototype target has no exact Revision in this frozen Snapshot.", binding);
  }
  const targetState = binding.targetState ?? null;
  if (targetState !== null) {
    const matches = target.targetStates?.filter((state) => state === targetState).length ?? 0;
    if (matches === 0) {
      return broken(
        edge,
        `Target RenderSpec state ${targetState} does not exist in Revision ${target.revisionId}.`,
        binding,
      );
    }
  }
  return {
    edgeId: edge.id,
    status: "interactive",
    detail: "Exact frozen prototype binding.",
    binding,
    transition: resolvePrototypeTransition(binding.transition),
    sourceArtifactId: source.artifactId,
    sourceRevisionId: source.revisionId,
    targetArtifactId: target.artifactId,
    targetRevisionId: target.revisionId,
    targetState,
  };
}

export function resolveFrozenPrototypeRelations(input: {
  readonly endpoints: readonly Readonly<FrozenPrototypeEndpoint>[];
  readonly edges: readonly Readonly<FrozenPrototypeEdge>[];
}): ReadonlyMap<string, ResolvedFrozenPrototypeRelation> {
  const endpointsByNodeId = new Map(input.endpoints.map((endpoint) => [endpoint.nodeId, endpoint]));
  const resolutions = new Map<string, ResolvedFrozenPrototypeRelation>();
  for (const edge of input.edges) resolutions.set(edge.id, baseResolution(edge, endpointsByNodeId));

  const interactive = [...resolutions.values()].filter(
    (resolution): resolution is Extract<ResolvedFrozenPrototypeRelation, { status: "interactive" }> => (
      resolution.status === "interactive"
    ),
  );
  const edgesById = new Map(input.edges.map((edge) => [edge.id, edge]));
  const collisionCounts = new Map<string, number>();
  const collisionKey = (resolution: Extract<ResolvedFrozenPrototypeRelation, { status: "interactive" }>) => (
    JSON.stringify([
      resolution.sourceArtifactId,
      resolution.binding.trigger,
      resolution.binding.sourceLocator.designNodeId,
      resolution.binding.sourceLocator.sourcePath ?? null,
      resolution.binding.sourceLocator.selector ?? null,
    ])
  );
  for (const resolution of interactive) {
    const key = collisionKey(resolution);
    collisionCounts.set(key, (collisionCounts.get(key) ?? 0) + 1);
  }
  for (const resolution of interactive) {
    const collisionCount = collisionCounts.get(collisionKey(resolution)) ?? 0;
    if (collisionCount > 1) {
      const edge = edgesById.get(resolution.edgeId);
      if (edge === undefined) continue;
      resolutions.set(
        resolution.edgeId,
        broken(edge, `Ambiguous prototype binding: ${collisionCount} exact matches.`, resolution.binding),
      );
    }
  }
  return resolutions;
}
