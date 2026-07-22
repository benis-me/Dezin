import { expect, test } from "vitest";
import type { WorkspaceSnapshot } from "../../lib/api.ts";
import {
  buildPrototypeModeCommand,
  createPrototypeFlowSession,
  parsePrototypeActivation,
  prototypeFlowHealth,
  resolvePrototypeActivation,
} from "./prototype-flow.ts";
import { flowRevisions } from "./prototype-flow-test-fixtures.ts";

const NONCE = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";

function snapshot(): WorkspaceSnapshot {
  const workspaceId = "workspace-flow";
  return {
    id: "snapshot-exact",
    workspaceId,
    sequence: 7,
    parentSnapshotId: "snapshot-6",
    graphRevision: 12,
    kernelRevisionId: "kernel-3",
    reason: "prototype-flow-test",
    provenance: { kind: "graph-command", commandIds: ["bind-flow"] },
    createdByRunId: null,
    createdAt: 7,
    graph: {
      workspaceId,
      revision: 12,
      nodes: [
        { id: "node-z", workspaceId, kind: "page", artifactId: "page-z", name: "Zulu" },
        { id: "node-a", workspaceId, kind: "page", artifactId: "page-a", name: "Alpha" },
        { id: "node-b", workspaceId, kind: "page", artifactId: "page-b", name: "Beta" },
        { id: "node-component", workspaceId, kind: "component", artifactId: "component", name: "Button" },
      ],
      edges: [
        {
          id: "edge-click",
          workspaceId,
          sourceNodeId: "node-a",
          targetNodeId: "node-b",
          kind: "prototype",
          prototype: {
            status: "interactive",
            binding: {
              sourceArtifactId: "page-a",
              sourceRevisionId: "revision-a",
              sourceLocator: { designNodeId: "checkout", selector: "[data-design-node-id=\"checkout\"]" },
              trigger: "click",
              targetArtifactId: "page-b",
              transition: { type: "slide", durationMs: 900 },
            },
          },
        },
        {
          id: "edge-submit",
          workspaceId,
          sourceNodeId: "node-a",
          targetNodeId: "node-z",
          kind: "prototype",
          prototype: {
            status: "interactive",
            binding: {
              sourceArtifactId: "page-a",
              sourceRevisionId: "revision-a",
              sourceLocator: { designNodeId: "checkout-form", sourcePath: "src/Checkout.tsx" },
              trigger: "submit",
              targetArtifactId: "page-z",
            },
          },
        },
        {
          id: "edge-planned",
          workspaceId,
          sourceNodeId: "node-a",
          targetNodeId: "node-z",
          kind: "prototype",
          prototype: { status: "planned" },
        },
        {
          id: "edge-broken",
          workspaceId,
          sourceNodeId: "node-a",
          targetNodeId: "node-z",
          kind: "prototype",
          prototype: {
            status: "broken",
            brokenReason: "Checkout confirmation is not generated yet.",
            binding: {
              sourceArtifactId: "page-a",
              sourceRevisionId: "revision-a",
              sourceLocator: { designNodeId: "broken-action" },
              trigger: "click",
              targetArtifactId: "page-z",
            },
          },
        },
        {
          id: "edge-broken-unbound",
          workspaceId,
          sourceNodeId: "node-a",
          targetNodeId: "node-z",
          kind: "prototype",
          prototype: { status: "broken", brokenReason: "Missing source locator." },
        },
      ],
    },
    artifactTracks: { "page-a": "track-a", "page-b": "track-b", "page-z": "track-z" },
    artifactRevisions: {
      "page-a": "revision-a",
      "page-b": "revision-b",
      "page-z": "revision-z",
      component: "revision-component",
    },
    resourceRevisions: {},
  };
}

test("flow session freezes the exact Snapshot and prefers a selected revision-backed Page", () => {
  const mutable = snapshot();
  const selected = createPrototypeFlowSession(mutable, ["node-z"]);
  const fallback = createPrototypeFlowSession(snapshot(), []);

  expect(selected.startArtifactId).toBe("page-z");
  expect(fallback.startArtifactId).toBe("page-a");
  expect(selected.snapshotId).toBe("snapshot-exact");
  expect(selected.artifactRevisions["page-a"]).toBe("revision-a");

  mutable.id = "snapshot-head-drifted";
  mutable.artifactRevisions["page-a"] = "revision-head";
  mutable.graph.edges.splice(0);
  expect(selected.snapshotId).toBe("snapshot-exact");
  expect(selected.artifactRevisions["page-a"]).toBe("revision-a");
  expect(selected.prototypeEdges).toHaveLength(5);
  expect(Object.isFrozen(selected.prototypeEdges)).toBe(true);
});

test("prototype-mode descriptors are bounded, exact, and never disclose a target", () => {
  const session = createPrototypeFlowSession(snapshot(), ["node-a"]);
  const command = buildPrototypeModeCommand(session, "page-a");

  expect(command.type).toBe("set-prototype-bindings");
  expect(command.bindings).toHaveLength(2);
  expect(command.bindings.map((descriptor) => descriptor.trigger)).toEqual(["click", "submit"]);
  expect(JSON.stringify(command)).not.toContain("page-b");
  expect(JSON.stringify(command)).not.toContain("targetArtifactId");
  expect(command.bindings.every((descriptor) => Object.keys(descriptor).sort().join(",") === "bindingId,locator,trigger")).toBe(true);
});

test("parent accepts only an exact bounded prototype activation envelope", () => {
  const valid = {
    source: "dezin",
    type: "prototype-binding-activated",
    nonce: NONCE,
    protocol: 1,
    bindingId: "binding-0",
    locator: { designNodeId: "checkout", selector: "[data-design-node-id=\"checkout\"]" },
    trigger: "click",
  };
  expect(parsePrototypeActivation(valid, NONCE)).toEqual(valid);
  expect(parsePrototypeActivation({ ...valid, targetUrl: "https://attacker.invalid" }, NONCE)).toBeNull();
  expect(parsePrototypeActivation({ ...valid, nonce: "x".repeat(43) }, NONCE)).toBeNull();
  expect(parsePrototypeActivation({ ...valid, bindingId: "x".repeat(129) }, NONCE)).toBeNull();
  expect(parsePrototypeActivation({ ...valid, locator: { ...valid.locator, extra: true } }, NONCE)).toBeNull();
});

test("interactive activation revalidates the frozen source Revision and target before navigating", () => {
  const session = createPrototypeFlowSession(snapshot(), ["node-a"]);
  const command = buildPrototypeModeCommand(session, "page-a");
  const descriptor = command.bindings.find((candidate) => candidate.locator.designNodeId === "checkout")!;
  const result = resolvePrototypeActivation(session, "page-a", {
    bindingId: descriptor.bindingId,
    locator: descriptor.locator,
    trigger: descriptor.trigger,
  });

  expect(result).toEqual({
    kind: "navigate",
    edgeId: "edge-click",
    targetArtifactId: "page-b",
    targetRevisionId: "revision-b",
    targetState: null,
    targetFrame: null,
    transition: { type: "slide", durationMs: 900 },
  });
});

test("broken bindings block with their reason while planned and unbound broken edges remain visible in health", () => {
  const session = createPrototypeFlowSession(snapshot(), ["node-a"]);
  const bindingId = Object.entries(session.bindingEdgeIds).find(([, edgeId]) => edgeId === "edge-broken")?.[0];
  expect(bindingId).toBeDefined();

  expect(resolvePrototypeActivation(session, "page-a", {
    bindingId: bindingId!,
    locator: { designNodeId: "broken-action" },
    trigger: "click",
  })).toEqual({
    kind: "blocked",
    reason: "Checkout confirmation is not generated yet.",
  });
  expect(prototypeFlowHealth(session, "page-a").items).toEqual(expect.arrayContaining([
    expect.objectContaining({ edgeId: "edge-planned", status: "planned" }),
    expect.objectContaining({ edgeId: "edge-broken-unbound", status: "broken", detail: "Missing source locator." }),
  ]));
});

test("multiple frozen bindings with the same locator and trigger are ambiguous and blocked", () => {
  const mutable = snapshot();
  const duplicate = structuredClone(mutable.graph.edges[0]!);
  duplicate.id = "edge-click-duplicate";
  duplicate.targetNodeId = "node-z";
  if (duplicate.kind === "prototype" && duplicate.prototype.binding) {
    duplicate.prototype.binding.targetArtifactId = "page-z";
  }
  mutable.graph.edges.push(duplicate);
  const session = createPrototypeFlowSession(mutable, ["node-a"]);
  const command = buildPrototypeModeCommand(session, "page-a");
  expect(command.bindings.some((descriptor) => descriptor.locator.designNodeId === "checkout")).toBe(false);
  const bindingId = Object.entries(session.bindingEdgeIds).find(([, edgeId]) => edgeId === "edge-click")?.[0];
  expect(bindingId).toBeDefined();

  expect(resolvePrototypeActivation(session, "page-a", {
    bindingId: bindingId!,
    locator: { designNodeId: "checkout", selector: "[data-design-node-id=\"checkout\"]" },
    trigger: "click",
  })).toEqual({ kind: "blocked", reason: "Ambiguous prototype binding: 2 exact matches." });
  expect(prototypeFlowHealth(session, "page-a").items.filter((item) => (
    item.edgeId === "edge-click" || item.edgeId === "edge-click-duplicate"
  ))).toEqual([
    expect.objectContaining({ status: "broken" }),
    expect.objectContaining({ status: "broken" }),
  ]);
});

test("presentation transitions stay within the none, fade, slide and bounded-duration surface", () => {
  const mutable = snapshot();
  const edge = mutable.graph.edges[0];
  if (edge?.kind !== "prototype" || edge.prototype.status !== "interactive") throw new Error("interactive fixture required");
  edge.prototype.binding.transition = { type: "fade", durationMs: 99_999 };
  const session = createPrototypeFlowSession(mutable, ["node-a"]);
  const descriptor = buildPrototypeModeCommand(session, "page-a").bindings
    .find((candidate) => candidate.locator.designNodeId === "checkout")!;

  expect(resolvePrototypeActivation(session, "page-a", descriptor)).toEqual(expect.objectContaining({
    kind: "navigate",
    transition: { type: "fade", durationMs: 2_000 },
  }));
});

test("targetState is frozen from the exact target Revision and missing states are not live", () => {
  const mutable = snapshot();
  const edge = mutable.graph.edges[0];
  if (edge?.kind !== "prototype" || edge.prototype.status !== "interactive") throw new Error("interactive fixture required");
  edge.prototype.binding.targetState = "receipt-ready";
  const missingStateEdge = structuredClone(edge);
  if (missingStateEdge.prototype.status !== "interactive") throw new Error("interactive clone required");
  missingStateEdge.id = "edge-missing-state";
  missingStateEdge.prototype.binding.sourceLocator = { designNodeId: "missing-state" };
  missingStateEdge.prototype.binding.targetState = "not-in-render-spec";
  mutable.graph.edges.push(missingStateEdge);

  const session = createPrototypeFlowSession(mutable, ["node-a"], flowRevisions());
  const command = buildPrototypeModeCommand(session, "page-a");
  const descriptor = command.bindings.find((candidate) => candidate.locator.designNodeId === "checkout")!;

  expect(command.bindings.some((candidate) => candidate.locator.designNodeId === "missing-state")).toBe(false);
  expect(resolvePrototypeActivation(session, "page-a", descriptor)).toEqual(expect.objectContaining({
    kind: "navigate",
    targetArtifactId: "page-b",
    targetRevisionId: "revision-b",
    targetState: "receipt-ready",
    targetFrame: expect.objectContaining({ id: "receipt", initialState: "receipt-ready" }),
  }));
  expect(prototypeFlowHealth(session, "page-a").items).toContainEqual(expect.objectContaining({
    edgeId: "edge-missing-state",
    status: "broken",
    detail: expect.stringMatching(/not-in-render-spec|RenderSpec state/i),
  }));
});

test("stale source Revision, invalid locator, and mismatched target are uniformly broken", () => {
  const mutable = snapshot();
  const template = mutable.graph.edges[0];
  if (template?.kind !== "prototype" || template.prototype.status !== "interactive") throw new Error("interactive fixture required");
  const stale = structuredClone(template);
  const invalidLocator = structuredClone(template);
  const wrongTarget = structuredClone(template);
  if (stale.prototype.status !== "interactive"
    || invalidLocator.prototype.status !== "interactive"
    || wrongTarget.prototype.status !== "interactive") throw new Error("interactive clones required");
  stale.id = "edge-stale";
  stale.prototype.binding.sourceRevisionId = "revision-head-drift";
  invalidLocator.id = "edge-invalid-locator";
  invalidLocator.prototype.binding.sourceLocator = { designNodeId: "" };
  wrongTarget.id = "edge-wrong-target";
  wrongTarget.prototype.binding.sourceLocator = { designNodeId: "wrong-target" };
  wrongTarget.prototype.binding.targetArtifactId = "page-z";
  mutable.graph.edges = [stale, invalidLocator, wrongTarget];

  const session = createPrototypeFlowSession(mutable, ["node-a"], flowRevisions());
  expect(buildPrototypeModeCommand(session, "page-a").bindings).toEqual([]);
  const staleBindingId = Object.entries(session.bindingEdgeIds)
    .find(([, edgeId]) => edgeId === "edge-stale")?.[0];
  expect(resolvePrototypeActivation(session, "page-a", {
    bindingId: staleBindingId!,
    locator: stale.prototype.binding.sourceLocator,
    trigger: stale.prototype.binding.trigger,
  })).toEqual({ kind: "blocked", reason: expect.stringMatching(/stale/i) });
  expect(prototypeFlowHealth(session, "page-a").items).toEqual([
    expect.objectContaining({ edgeId: "edge-stale", status: "broken", detail: expect.stringMatching(/stale/i) }),
    expect.objectContaining({ edgeId: "edge-invalid-locator", status: "broken", detail: expect.stringMatching(/locator/i) }),
    expect.objectContaining({ edgeId: "edge-wrong-target", status: "broken", detail: expect.stringMatching(/target/i) }),
  ]);
});
