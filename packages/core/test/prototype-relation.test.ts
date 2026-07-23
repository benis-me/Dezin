import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFrozenPrototypeRenderFrames,
  resolveFrozenPrototypeRelations,
  resolvePrototypeTransition,
  selectFrozenPrototypeRenderFrame,
  type FrozenPrototypeEndpoint,
  type WorkspaceEdge,
} from "../src/index.ts";

const WORKSPACE_ID = "workspace-prototype-contract";

function endpoint(
  nodeId: string,
  artifactId: string,
  revisionId: string | null,
  targetStates: readonly string[] | null = null,
): FrozenPrototypeEndpoint {
  return { nodeId, artifactId, revisionId, targetStates };
}

function interactiveEdge(input: {
  id: string;
  sourceRevisionId?: string;
  sourceLocator?: { designNodeId: string; sourcePath?: string; selector?: string };
  targetState?: string;
  durationMs?: number;
}): Extract<WorkspaceEdge, { kind: "prototype" }> {
  return {
    id: input.id,
    workspaceId: WORKSPACE_ID,
    sourceNodeId: "node-a",
    targetNodeId: "node-b",
    kind: "prototype",
    prototype: {
      status: "interactive",
      binding: {
        sourceArtifactId: "artifact-a",
        sourceRevisionId: input.sourceRevisionId ?? "revision-a",
        sourceLocator: input.sourceLocator ?? { designNodeId: "checkout" },
        trigger: "click",
        targetArtifactId: "artifact-b",
        ...(input.targetState === undefined ? {} : { targetState: input.targetState }),
        transition: { type: "fade", ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }) },
      },
    },
  };
}

test("prototype transition resolution is the single rounded and bounded runtime contract", () => {
  assert.deepEqual(resolvePrototypeTransition({ type: "fade", durationMs: 180.5 }), {
    type: "fade",
    durationMs: 181,
  });
  assert.deepEqual(resolvePrototypeTransition({ type: "slide", durationMs: 10_000 }), {
    type: "slide",
    durationMs: 2_000,
  });
  assert.deepEqual(resolvePrototypeTransition({ type: "fade", durationMs: 0 }), {
    type: "fade",
    durationMs: 0,
  });
  assert.deepEqual(resolvePrototypeTransition({ type: "fade", durationMs: 2_000 }), {
    type: "fade",
    durationMs: 2_000,
  });
  assert.deepEqual(resolvePrototypeTransition({ type: "none", durationMs: 2_000 }), {
    type: "none",
    durationMs: 0,
  });
});

test("prototype target states come only from one exact bounded RenderSpec frame parser", () => {
  assert.deepEqual(readFrozenPrototypeRenderFrames({
    frames: [{ id: "default", name: "Default", width: 1_440, height: 900 }, {
      id: "ready-a",
      name: "Ready A",
      width: 1_440,
      height: 900,
      initialState: "ready",
    }, {
      id: "ready-b",
      name: "Ready B",
      width: 390,
      height: 844,
      initialState: "ready",
    }],
  })?.map((frame) => frame.initialState ?? null), [null, "ready", "ready"]);
  assert.equal(readFrozenPrototypeRenderFrames({
    frames: [{ id: "bad", name: "Bad", width: 0, height: 900, initialState: "ready" }],
  }), null);
  assert.equal(readFrozenPrototypeRenderFrames({
    frames: [{ id: "fractional", name: "Fractional", width: 390.5, height: 844 }],
  }), null);
  assert.equal(readFrozenPrototypeRenderFrames({
    frames: [{ id: "huge", name: "Huge", width: 10_000, height: 10_000 }],
  }), null);
  assert.equal(readFrozenPrototypeRenderFrames({
    frames: [{ id: "control", name: "Control", width: 390, height: 844, background: "red\u0000blue" }],
  }), null);
  assert.equal(readFrozenPrototypeRenderFrames({
    frames: [{ id: "long-name", name: "n".repeat(512), width: 390, height: 844 }],
  })?.[0]?.name.length, 512);
});

test("prototype target Revision authority comes only from the frozen endpoint", () => {
  const edge = interactiveEdge({ id: "edge-target-endpoint" });
  const resolved = resolveFrozenPrototypeRelations({
    endpoints: [
      endpoint("node-a", "artifact-a", "revision-a"),
      endpoint("node-b", "artifact-b", null),
    ],
    edges: [edge],
  });

  assert.equal(resolved.get(edge.id)?.status, "broken");
  assert.match(resolved.get(edge.id)?.detail ?? "", /no exact Revision/i);
});

test("a logical target state may be present in multiple exact viewport Frames", () => {
  const edge = interactiveEdge({ id: "edge-multi-viewport", targetState: "ready" });
  const resolved = resolveFrozenPrototypeRelations({
    endpoints: [
      endpoint("node-a", "artifact-a", "revision-a"),
      endpoint("node-b", "artifact-b", "revision-b", ["ready", "ready"]),
    ],
    edges: [edge],
  });

  assert.equal(resolved.get(edge.id)?.status, "interactive");
});

test("prototype Frame selection preserves viewport identity before choosing the deterministic nearest state Frame", () => {
  const frames = readFrozenPrototypeRenderFrames({
    frames: [
      { id: "desktop", name: "Desktop", width: 1440, height: 900 },
      { id: "mobile", name: "Mobile", width: 390, height: 844 },
      { id: "desktop-ready", name: "Desktop ready", width: 1440, height: 900, initialState: "ready" },
      { id: "mobile-ready", name: "Mobile ready", width: 393, height: 852, initialState: "ready" },
    ],
  });
  assert.ok(frames);

  assert.equal(selectFrozenPrototypeRenderFrame(frames, {
    currentFrame: frames[1]!,
    targetState: null,
  })?.id, "mobile");
  assert.equal(selectFrozenPrototypeRenderFrame(frames, {
    currentFrame: frames[1]!,
    targetState: "ready",
  })?.id, "mobile-ready");
  assert.equal(selectFrozenPrototypeRenderFrame(frames, {
    currentFrame: frames[0]!,
    targetState: "missing",
  }), null);
});

test("frozen prototype resolution derives stale, missing, and ambiguous status instead of trusting graph labels", () => {
  const endpoints = [
    endpoint("node-a", "artifact-a", "revision-a"),
    endpoint("node-b", "artifact-b", "revision-b", ["ready"]),
  ];
  const stale = interactiveEdge({ id: "edge-stale", sourceRevisionId: "revision-old" });
  const missingTargetRevision = interactiveEdge({ id: "edge-missing-target" });
  const missingState = interactiveEdge({ id: "edge-missing-state", targetState: "absent" });
  const duplicateA = interactiveEdge({ id: "edge-duplicate-a", sourceLocator: { designNodeId: "same" } });
  const duplicateB = interactiveEdge({ id: "edge-duplicate-b", sourceLocator: { designNodeId: "same" } });

  const resolved = resolveFrozenPrototypeRelations({
    endpoints: [endpoints[0]!, endpoint("node-b", "artifact-b", null, ["ready"])],
    edges: [stale, missingTargetRevision],
  });
  assert.match(resolved.get(stale.id)?.detail ?? "", /stale/i);
  assert.equal(resolved.get(stale.id)?.status, "broken");
  assert.match(resolved.get(missingTargetRevision.id)?.detail ?? "", /no exact Revision/i);
  assert.equal(resolved.get(missingTargetRevision.id)?.status, "broken");

  const withTargetRevision = resolveFrozenPrototypeRelations({
    endpoints,
    edges: [missingState, duplicateA, duplicateB],
  });
  assert.match(withTargetRevision.get(missingState.id)?.detail ?? "", /does not exist/i);
  assert.equal(withTargetRevision.get(missingState.id)?.status, "broken");
  assert.match(withTargetRevision.get(duplicateA.id)?.detail ?? "", /Ambiguous prototype binding: 2 exact matches/i);
  assert.equal(withTargetRevision.get(duplicateA.id)?.status, "broken");
  assert.equal(withTargetRevision.get(duplicateB.id)?.status, "broken");
});

test("frozen prototype resolution exposes the same effective transition consumed by the Viewer", () => {
  const endpoints = [
    endpoint("node-a", "artifact-a", "revision-a"),
    endpoint("node-b", "artifact-b", "revision-b", ["ready"]),
  ];
  const fractional = interactiveEdge({ id: "edge-fractional", durationMs: 180.5 });
  const oversized = interactiveEdge({
    id: "edge-oversized",
    sourceLocator: { designNodeId: "other" },
    durationMs: 10_000,
  });
  const resolved = resolveFrozenPrototypeRelations({ endpoints, edges: [fractional, oversized] });

  assert.equal(resolved.get(fractional.id)?.status, "interactive");
  assert.deepEqual(resolved.get(fractional.id)?.transition, { type: "fade", durationMs: 181 });
  assert.equal(resolved.get(oversized.id)?.status, "interactive");
  assert.deepEqual(resolved.get(oversized.id)?.transition, { type: "fade", durationMs: 2_000 });
});
