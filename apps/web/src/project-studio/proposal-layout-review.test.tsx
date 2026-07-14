import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
  WorkspaceGraph,
  WorkspaceLayout,
  WorkspaceLayoutCommand,
  WorkspaceViewport,
} from "../lib/api.ts";
import { ProjectCanvas } from "./canvas/ProjectCanvas.tsx";
import {
  workspaceGraphToFlow,
} from "./canvas/workspace-graph-adapter.ts";
import {
  ProposalOverlay,
  ProposalOverlayEdge,
  createProposalOverlayModel,
} from "./proposal/ProposalOverlay.tsx";
import {
  buildProposalDiff,
  type ProposalDiffProposal,
} from "./proposal/proposal-diff.ts";

const flowHarness = vi.hoisted(() => {
  const state = { viewport: { x: 0, y: 0, zoom: 1 } };
  const setViewport = vi.fn(async (viewport: WorkspaceViewport) => {
    state.viewport = viewport;
    return true;
  });
  return {
    state,
    setViewport,
    getViewport: vi.fn(() => state.viewport),
    fitView: vi.fn(async () => true),
    getNodes: vi.fn(() => []),
  };
});

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  return {
    ...actual,
    Background: () => null,
    EdgeLabelRenderer: ({ children }: { children?: ReactNode }) => <>{children}</>,
    ReactFlow: ({
      onInit,
      defaultViewport,
      children,
      "aria-label": ariaLabel,
    }: {
      onInit?: (instance: unknown) => void;
      defaultViewport: WorkspaceViewport;
      children?: ReactNode;
      "aria-label"?: string;
    }) => {
      const initialized = useRef(false);
      useEffect(() => {
        if (initialized.current) return;
        initialized.current = true;
        flowHarness.state.viewport = defaultViewport;
        onInit?.(flowHarness);
      }, [defaultViewport, onInit]);
      return <div role="application" aria-label={ariaLabel}>{children}</div>;
    },
  };
});

const baseGraph: WorkspaceGraph = {
  workspaceId: "workspace-1",
  revision: 7,
  nodes: [
    { id: "page-home", workspaceId: "workspace-1", kind: "page", artifactId: "artifact-home", name: "Home" },
    { id: "page-details", workspaceId: "workspace-1", kind: "page", artifactId: "artifact-details", name: "Details" },
  ],
  edges: [{
    id: "edge-next",
    workspaceId: "workspace-1",
    kind: "prototype",
    sourceNodeId: "page-home",
    targetNodeId: "page-details",
    prototype: { status: "planned" },
  }],
};

const baseLayout: WorkspaceLayout = {
  workspaceId: "workspace-1",
  layoutId: "default",
  objects: [
    { id: "journey", kind: "group", x: 20, y: 30, width: 640, height: 420, parentGroupId: null, label: "Journey", collapsed: false },
    { id: "page-home", kind: "node", x: 40, y: 60, parentGroupId: "journey" },
    { id: "page-details", kind: "node", x: 340, y: 60, parentGroupId: "journey" },
  ],
  viewport: { x: 0, y: 0, zoom: 1 },
  checksum: "layout-7",
};

function proposal(overrides: Partial<ProposalDiffProposal> = {}): ProposalDiffProposal {
  return {
    id: "proposal-1",
    baseGraphRevision: 7,
    baseSnapshotId: "snapshot-7",
    baseGraph,
    baseLayoutChecksum: "layout-7",
    baseLayout,
    operations: [],
    layoutOperations: [],
    ...overrides,
  };
}

function current(graph = baseGraph, layoutChecksum = "layout-7") {
  return { graph, activeSnapshotId: "snapshot-7", layoutChecksum };
}

describe("proposal layout review parity", () => {
  beforeEach(() => {
    flowHarness.state.viewport = { x: 0, y: 0, zoom: 1 };
    flowHarness.setViewport.mockClear();
    flowHarness.getViewport.mockClear();
    flowHarness.fitView.mockClear();
    flowHarness.getNodes.mockClear();
  });

  test("materializes a newly added semantic node before move and set-parent replay", () => {
    const input = proposal({
      operations: [{
        id: "add-checkout",
        type: "add-node",
        node: { id: "page-checkout", kind: "page", artifactId: "artifact-checkout", name: "Checkout" },
      }],
      layoutOperations: [
        { type: "move", objectId: "page-checkout", x: 72, y: 144 },
        { type: "set-parent", objectId: "page-checkout", parentGroupId: "journey" },
      ],
    });
    const immutableInput = structuredClone(input);

    const diff = buildProposalDiff(input, current());

    expect(diff.proposedLayout?.objects.find((object) => object.id === "page-checkout")).toEqual({
      id: "page-checkout",
      kind: "node",
      x: 72,
      y: 144,
      parentGroupId: "journey",
    });
    expect(diff.groupChanges.find((change) => change.objectId === "page-checkout")).toMatchObject({
      changeKind: "addition",
      operationRefs: [{ kind: "layout", index: 0 }, { kind: "layout", index: 1 }],
    });
    expect(input).toEqual(immutableInput);
  });

  test("compares an existing semantic node missing from stored layout against the materialized audited baseline", () => {
    const sparseLayout: WorkspaceLayout = {
      ...baseLayout,
      objects: baseLayout.objects.filter((object) => object.id !== "page-details"),
    };
    const input = proposal({
      baseLayout: sparseLayout,
      layoutOperations: [{ type: "move", objectId: "page-details", x: 510, y: 240 }],
    });

    const diff = buildProposalDiff(input, current());
    const review = diff.groupChanges.find((change) => change.objectId === "page-details");

    expect(review).toMatchObject({
      changeKind: "modification",
      before: { id: "page-details", kind: "node", parentGroupId: null },
      after: { id: "page-details", kind: "node", x: 510, y: 240, parentGroupId: null },
    });
  });

  test("set-parent lazily creates a missing semantic layout object at the Core-owned zero position", () => {
    const sparseLayout: WorkspaceLayout = {
      ...baseLayout,
      objects: baseLayout.objects.filter((object) => object.id !== "page-details"),
    };
    const input = proposal({
      baseLayout: sparseLayout,
      layoutOperations: [{ type: "set-parent", objectId: "page-details", parentGroupId: "journey" }],
    });

    const diff = buildProposalDiff(input, current());

    expect(diff.proposedLayout?.objects.find((object) => object.id === "page-details")).toEqual({
      id: "page-details",
      kind: "node",
      x: 0,
      y: 0,
      parentGroupId: "journey",
    });
    expect(diff.groupChanges.find((change) => change.objectId === "page-details")).toMatchObject({
      changeKind: "modification",
      after: { x: 0, y: 0, parentGroupId: "journey" },
      operationRefs: [{ kind: "layout", index: 0 }],
    });
  });

  test("an added semantic node without layout commands still receives an explicit review placement", () => {
    const input = proposal({
      operations: [{
        id: "add-checkout",
        type: "add-node",
        node: { id: "page-checkout", kind: "page", artifactId: "artifact-checkout", name: "Checkout" },
      }],
    });

    const diff = buildProposalDiff(input, current());

    expect(diff.proposedLayout?.objects.find((object) => object.id === "page-checkout")).toMatchObject({
      id: "page-checkout",
      kind: "node",
      parentGroupId: null,
    });
  });

  test("set-viewport creates a dedicated review ref whose operation can be removed to revert", () => {
    const input = proposal({
      layoutOperations: [{ type: "set-viewport", viewport: { x: -48, y: 32, zoom: 0.82 } }],
    });

    const diff = buildProposalDiff(input, current());
    const viewportReview = diff.reviewItems.find((change) => change.objectKind === "viewport");

    expect(viewportReview).toMatchObject({
      key: "layout:viewport",
      objectId: "viewport",
      objectKind: "viewport",
      changeKind: "modification",
      before: { x: 0, y: 0, zoom: 1 },
      after: { x: -48, y: 32, zoom: 0.82 },
      operationRefs: [{ kind: "layout", index: 0 }],
      canvasObjectIds: [],
    });

    const revertedIndexes = new Set(viewportReview?.operationRefs.flatMap((ref) => ref.kind === "layout" ? [ref.index] : []));
    const reverted = buildProposalDiff({
      ...input,
      layoutOperations: input.layoutOperations.filter((_command, index) => !revertedIndexes.has(index)),
    }, current());
    expect(reverted.proposedLayout?.viewport).toEqual(baseLayout.viewport);
    expect(reverted.reviewItems.some((change) => change.objectKind === "viewport")).toBe(false);
  });

  test("duplicate move and viewport commands retain every ref so one review revert removes the visible change", () => {
    const moved = { type: "move" as const, objectId: "page-home", x: 96, y: 132 };
    const viewed = { type: "set-viewport" as const, viewport: { x: -80, y: 24, zoom: 0.78 } };
    const input = proposal({ layoutOperations: [moved, moved, viewed, viewed] });

    const diff = buildProposalDiff(input, current());
    const moveReview = diff.groupChanges.find((change) => change.objectId === "page-home")!;
    const viewportReview = diff.viewportChanges[0]!;

    expect(moveReview.operationRefs).toEqual([
      { kind: "layout", index: 0 },
      { kind: "layout", index: 1 },
    ]);
    expect(viewportReview.operationRefs).toEqual([
      { kind: "layout", index: 2 },
      { kind: "layout", index: 3 },
    ]);

    const withoutMove = new Set(moveReview.operationRefs.flatMap((ref) => ref.kind === "layout" ? [ref.index] : []));
    const moveReverted = buildProposalDiff({
      ...input,
      layoutOperations: input.layoutOperations.filter((_command, index) => !withoutMove.has(index)),
    }, current());
    expect(moveReverted.groupChanges.some((change) => change.objectId === "page-home")).toBe(false);

    const withoutViewport = new Set(viewportReview.operationRefs.flatMap((ref) => ref.kind === "layout" ? [ref.index] : []));
    const viewportReverted = buildProposalDiff({
      ...input,
      layoutOperations: input.layoutOperations.filter((_command, index) => !withoutViewport.has(index)),
    }, current());
    expect(viewportReverted.viewportChanges).toEqual([]);
    expect(viewportReverted.proposedLayout?.viewport).toEqual(baseLayout.viewport);
  });

  test("a stale removed node tombstone keeps its audited name and position after current deletion", () => {
    const input = proposal({
      operations: [{ id: "archive-home", type: "archive-node", nodeId: "page-home" }],
    });
    const currentGraph: WorkspaceGraph = {
      ...baseGraph,
      revision: 8,
      nodes: baseGraph.nodes.filter((node) => node.id !== "page-home"),
      edges: [],
    };
    const diff = buildProposalDiff(input, current(currentGraph));
    const currentLayout = {
      ...baseLayout,
      objects: baseLayout.objects.filter((object) => object.id !== "page-home"),
      checksum: "layout-8",
    };
    const canonical = workspaceGraphToFlow(currentGraph, currentLayout, { zoom: 1, edgeFilter: "all" });
    const proposed = workspaceGraphToFlow(diff.proposedGraph, diff.proposedLayout!, { zoom: 1, edgeFilter: "all" });
    const audited = workspaceGraphToFlow(diff.auditedGraph, diff.auditedLayout!, { zoom: 1, edgeFilter: "all" });

    const overlay = createProposalOverlayModel(diff, canonical, input.id, proposed, audited);
    const tombstone = overlay.nodes.find((node) => node.id === "proposal:proposal-1:node:page-home");

    expect(tombstone).toMatchObject({
      position: { x: 60, y: 90 },
      data: { name: "Home", proposalChangeKind: "removal" },
    });
  });

  test("a stale removed edge uses audited endpoint geometry even when current removed and moved it", () => {
    const input = proposal({
      operations: [{ id: "remove-next", type: "remove-edge", edgeId: "edge-next" }],
    });
    const currentGraph: WorkspaceGraph = {
      ...baseGraph,
      revision: 8,
      nodes: baseGraph.nodes.map((node) => ({ ...node, name: `Current ${node.name}` })),
      edges: [],
    };
    const currentLayout: WorkspaceLayout = {
      ...baseLayout,
      checksum: "layout-8",
      objects: baseLayout.objects.map((object) => object.kind === "node" ? { ...object, x: object.x + 900 } : object),
    };
    const diff = buildProposalDiff(input, current(currentGraph, currentLayout.checksum));
    const canonical = workspaceGraphToFlow(currentGraph, currentLayout, { zoom: 1, edgeFilter: "all" });
    const proposed = workspaceGraphToFlow(diff.proposedGraph, diff.proposedLayout!, { zoom: 1, edgeFilter: "all" });
    const audited = workspaceGraphToFlow(diff.auditedGraph, diff.auditedLayout!, { zoom: 1, edgeFilter: "all" });

    const overlay = createProposalOverlayModel(diff, canonical, input.id, proposed, audited);
    const removedEdge = overlay.edges.find((edge) => edge.id === "proposal:proposal-1:edge:edge-next");
    const source = overlay.nodes.find((node) => node.id === removedEdge?.source);
    const target = overlay.nodes.find((node) => node.id === removedEdge?.target);

    expect(removedEdge).toMatchObject({ data: { proposalChangeKind: "removal" } });
    expect(source).toMatchObject({ position: { x: 60, y: 90 }, data: { name: "Home" } });
    expect(target).toMatchObject({ position: { x: 360, y: 90 }, data: { name: "Details" } });
  });

  test("a changed group carries unchanged descendants with proposed visibility and full frame bounds", () => {
    const input = proposal({
      layoutOperations: [
        { type: "move", objectId: "journey", x: 180, y: 220 },
        { type: "set-collapsed", groupId: "journey", collapsed: true },
      ],
    });
    const diff = buildProposalDiff(input, current());
    const canonical = workspaceGraphToFlow(baseGraph, baseLayout, { zoom: 1, edgeFilter: "all" });
    const proposed = workspaceGraphToFlow(diff.proposedGraph, diff.proposedLayout!, { zoom: 1, edgeFilter: "all" });
    const audited = workspaceGraphToFlow(diff.auditedGraph, diff.auditedLayout!, { zoom: 1, edgeFilter: "all" });

    const overlay = createProposalOverlayModel(diff, canonical, input.id, proposed, audited);
    const group = overlay.nodes.find((node) => node.id === "proposal:proposal-1:node:journey")!;
    const child = overlay.nodes.find((node) => node.id === "proposal:proposal-1:node:page-home");

    expect(group).toMatchObject({
      position: { x: 180, y: 220 },
      style: { width: 640, height: 420 },
      data: { proposalObjectKind: "group" },
    });
    expect(child).toMatchObject({
      position: { x: 40, y: 60 },
      parentId: "proposal:proposal-1:node:journey",
      hidden: true,
    });
    expect(group.zIndex).toBeLessThan(28);
    expect(child?.zIndex).toBeGreaterThan(28);

    const rendered = render(<ProposalOverlay {...({ data: group.data } as Parameters<typeof ProposalOverlay>[0])} />);
    expect(rendered.container.querySelector<HTMLElement>('[data-object-kind="group"]')).toHaveStyle({
      width: "100%",
      height: "100%",
    });
  });

  test("a changed edge incident to a moved group's unchanged descendants follows the derived overlay nodes", () => {
    const input = proposal({
      operations: [{
        id: "bind-next",
        type: "bind-prototype",
        edgeId: "edge-next",
        binding: {
          sourceArtifactId: "artifact-home",
          sourceRevisionId: "revision-home",
          sourceLocator: { designNodeId: "details-link" },
          trigger: "click",
          targetArtifactId: "artifact-details",
        },
      }],
      layoutOperations: [{ type: "move", objectId: "journey", x: 180, y: 220 }],
    });
    const diff = buildProposalDiff(input, current());
    const canonical = workspaceGraphToFlow(baseGraph, baseLayout, { zoom: 1, edgeFilter: "all" });
    const proposed = workspaceGraphToFlow(diff.proposedGraph, diff.proposedLayout!, { zoom: 1, edgeFilter: "all" });
    const audited = workspaceGraphToFlow(diff.auditedGraph, diff.auditedLayout!, { zoom: 1, edgeFilter: "all" });

    const overlay = createProposalOverlayModel(diff, canonical, input.id, proposed, audited);
    const edge = overlay.edges.find((candidate) => candidate.id === "proposal:proposal-1:edge:edge-next");
    const proposedEdge = proposed.edges.find((candidate) => candidate.id === "edge-next");

    expect(edge).toMatchObject({
      source: "proposal:proposal-1:node:page-home",
      target: "proposal:proposal-1:node:page-details",
      sourceHandle: proposedEdge?.sourceHandle,
      targetHandle: proposedEdge?.targetHandle,
    });
    expect(edge?.sourceHandle).not.toBe("proposal-source");
    expect(edge?.targetHandle).not.toBe("proposal-target");
    expect(overlay.nodes.find((node) => node.id === edge?.source)).toMatchObject({
      parentId: "proposal:proposal-1:node:journey",
      position: { x: 40, y: 60 },
    });
  });

  test("an edge review pill names the relationship before its lifecycle status", () => {
    render(<ProposalOverlayEdge {...({
      id: "proposal-edge",
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: 80,
      sourcePosition: "right",
      targetPosition: "left",
      data: {
        kind: "uses",
        status: "planned",
        label: "planned",
        proposalChangeKind: "addition",
      },
    } as unknown as Parameters<typeof ProposalOverlayEdge>[0])} />);

    const relation = screen.getByText("Uses component");
    expect(relation).toBeInTheDocument();
    expect(screen.getByText("Planned")).toBeInTheDocument();
    expect(relation.closest(".dezin-proposal-edge-label")).toHaveStyle({
      zIndex: "28",
      transform: "translate(-50%, calc(-100% - 8px)) translate(100px, 40px)",
    });
  });

  test("an authoritative viewport prop updates the mounted flow without saving layout", async () => {
    const onSaveLayout = vi.fn(async (_commands: readonly WorkspaceLayoutCommand[]) => baseLayout);
    const props = {
      projectId: "project-1",
      projectName: "Storefront",
      graph: baseGraph,
      layout: baseLayout,
      artifactRevisionIds: {},
      selectedNodeIds: [],
      onSelectionChange: vi.fn(),
      onSaveLayout,
      onApplyGraphCommands: vi.fn(async () => {}),
      onOpenArtifact: vi.fn(),
    };
    const rendered = render(<ProjectCanvas {...props} />);
    await waitFor(() => expect(flowHarness.getViewport).toHaveBeenCalled());
    flowHarness.setViewport.mockClear();
    flowHarness.getViewport.mockClear();

    const approvedLayout: WorkspaceLayout = {
      ...baseLayout,
      viewport: { x: -120, y: 44, zoom: 0.76 },
      checksum: "layout-approved",
    };
    rendered.rerender(<ProjectCanvas {...props} layout={approvedLayout} />);

    await waitFor(() => expect(flowHarness.setViewport).toHaveBeenCalledWith(approvedLayout.viewport));
    expect(onSaveLayout).not.toHaveBeenCalled();
  });
});
