import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReactFlow } from "@xyflow/react";
import { afterEach, expect, test, vi } from "vitest";
import { ApiProvider } from "../lib/api-context.tsx";
import {
  ApiError,
  createApiClient,
  type FetchLike,
  type Project,
  type ReadyProjectWorkspacePayload,
  type WorkspaceGraph,
  type WorkspaceLayout,
  type WorkspaceLayoutPatch,
  type WorkspaceProposal,
} from "../lib/api.ts";
import { makeFakeApi } from "../test/fake-api.ts";
import {
  buildProposalDiff,
  type ProposalDiffProposal,
} from "./proposal/proposal-diff.ts";
import {
  ProposalOverlay,
  ProposalOverlayEdge,
  createProposalOverlayModel,
  mergeProposalOverlay,
  proposalOverlayId,
} from "./proposal/ProposalOverlay.tsx";
import { workspaceGraphToFlow } from "./canvas/workspace-graph-adapter.ts";
import { workspaceEdgeTypes } from "./canvas/edge-types.tsx";
import { workspaceNodeTypes } from "./canvas/node-types.tsx";
import { ProjectCanvas } from "./canvas/ProjectCanvas.tsx";
import { ProjectStudioScreen } from "./ProjectStudioScreen.tsx";
import { ProposalReviewPanel } from "./proposal/ProposalReviewPanel.tsx";
import { useProjectStudio } from "./useProjectStudio.ts";

const baseGraph: WorkspaceGraph = {
  workspaceId: "workspace-1",
  revision: 7,
  nodes: [
    { id: "page-home", workspaceId: "workspace-1", kind: "page", artifactId: "artifact-home", name: "Home" },
  ],
  edges: [],
};

const baseLayout: WorkspaceLayout = {
  workspaceId: "workspace-1",
  layoutId: "default",
  objects: [
    { id: "page-home", kind: "node", x: 80, y: 96, parentGroupId: null },
  ],
  viewport: { x: 0, y: 0, zoom: 1 },
  checksum: "layout-7",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function installReactFlowMeasurements(): () => void {
  vi.stubGlobal("DOMMatrixReadOnly", class MockDOMMatrixReadOnly {
    readonly m22 = 1;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function measuredWidth(this: HTMLElement) {
    return Number.parseFloat(this.style.width) || 960;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function measuredHeight(this: HTMLElement) {
    return Number.parseFloat(this.style.height) || 640;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function measuredRect(this: HTMLElement) {
    const width = this.offsetWidth;
    const height = this.offsetHeight;
    return {
      x: 0,
      y: 0,
      top: 0,
      right: width,
      bottom: height,
      left: 0,
      width,
      height,
      toJSON: () => ({}),
    };
  });
  const observers: Array<{ callback: ResizeObserverCallback; targets: Set<Element>; instance: ResizeObserver }> = [];
  vi.stubGlobal("ResizeObserver", class MockResizeObserver {
    private readonly targets = new Set<Element>();

    constructor(callback: ResizeObserverCallback) {
      observers.push({ callback, targets: this.targets, instance: this as ResizeObserver });
    }

    observe(target: Element) {
      this.targets.add(target);
    }

    unobserve(target: Element) {
      this.targets.delete(target);
    }

    disconnect() {
      this.targets.clear();
    }
  });
  return () => {
    for (const observer of observers) {
      const entries = [...observer.targets].map((target) => ({
        target,
        contentRect: target.getBoundingClientRect(),
      }) as ResizeObserverEntry);
      if (entries.length > 0) observer.callback(entries, observer.instance);
    }
  };
}

const emptyGeneration = {
  kind: "workspace-generation" as const,
  resourceOperations: [],
  artifactPlans: [],
  dependencyPlans: [],
  prototypeIntents: [],
  capabilities: [],
  responsiveFrames: [],
  qualityProfile: {
    requiredFrameIds: [],
    blockingSeverities: [],
    requireRuntimeChecks: false,
    requireVisualReview: false,
  },
};

function draftProposal(overrides: Partial<WorkspaceProposal> = {}): WorkspaceProposal {
  return {
    id: "proposal-1",
    workspaceId: "workspace-1",
    revision: 1,
    kind: "workspace-generation",
    baseGraphRevision: 7,
    baseSnapshotId: "snapshot-7",
    baseGraph,
    layoutId: "default",
    baseLayoutChecksum: "layout-7",
    baseLayout,
    status: "draft",
    operations: [{
      id: "command-add-checkout",
      type: "add-node",
      node: { id: "page-checkout", kind: "page", name: "Checkout", artifactId: "artifact-checkout" },
    }],
    layoutOperations: [],
    rationale: "Add checkout",
    assumptions: ["Existing cart state is reusable"],
    generation: emptyGeneration,
    review: { kind: "none" },
    createdByRunId: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test("proposal diff replays an addition from its immutable audited base", () => {
  const proposal: ProposalDiffProposal = {
    id: "proposal-1",
    baseGraphRevision: 7,
    baseSnapshotId: "snapshot-7",
    baseGraph,
    baseLayoutChecksum: "layout-7",
    baseLayout,
    operations: [{
      id: "command-add-checkout",
      type: "add-node",
      node: { id: "page-checkout", kind: "page", name: "Checkout", artifactId: "artifact-checkout" },
    }],
    layoutOperations: [],
  };
  const before = structuredClone(proposal);

  const diff = buildProposalDiff(proposal, {
    graph: baseGraph,
    activeSnapshotId: "snapshot-7",
    layoutChecksum: "layout-7",
  });

  expect(diff.proposedGraph.nodes).toContainEqual({
    id: "page-checkout",
    workspaceId: "workspace-1",
    kind: "page",
    name: "Checkout",
    artifactId: "artifact-checkout",
  });
  expect(diff.nodeChanges).toMatchObject([{
    objectId: "page-checkout",
    changeKind: "addition",
    operationRefs: [{ kind: "graph", commandId: "command-add-checkout" }],
    accessibleLabel: "Proposed addition: Page Checkout",
  }]);
  expect(diff.staleAgainstCurrent).toBe(false);
  expect(proposal).toEqual(before);
});

const connectedGraph: WorkspaceGraph = {
  ...baseGraph,
  nodes: [
    ...baseGraph.nodes,
    { id: "page-receipt", workspaceId: "workspace-1", kind: "page", artifactId: "artifact-receipt", name: "Receipt" },
  ],
  edges: [
    {
      id: "edge-next",
      workspaceId: "workspace-1",
      kind: "prototype",
      sourceNodeId: "page-home",
      targetNodeId: "page-receipt",
      prototype: { status: "planned" },
    },
    {
      id: "edge-uses",
      workspaceId: "workspace-1",
      kind: "uses",
      sourceNodeId: "page-home",
      targetNodeId: "page-receipt",
    },
  ],
};

test("proposal diff collapses rename and archive commands into final node and incident-edge removals", () => {
  const proposal: ProposalDiffProposal = {
    id: "proposal-archive",
    baseGraphRevision: 7,
    baseSnapshotId: "snapshot-7",
    baseGraph: connectedGraph,
    baseLayoutChecksum: "layout-7",
    baseLayout,
    operations: [
      { id: "rename-home-1", type: "rename-node", nodeId: "page-home", name: "Start" },
      { id: "rename-home-2", type: "rename-node", nodeId: "page-home", name: "Landing" },
      { id: "archive-home", type: "archive-node", nodeId: "page-home" },
    ],
    layoutOperations: [],
  };

  const diff = buildProposalDiff(proposal, {
    graph: connectedGraph,
    activeSnapshotId: "snapshot-7",
    layoutChecksum: "layout-7",
  });

  expect(diff.proposedGraph.nodes.map((node) => node.id)).toEqual(["page-receipt"]);
  expect(diff.proposedGraph.edges).toEqual([]);
  expect(diff.nodeChanges).toMatchObject([{
    objectId: "page-home",
    changeKind: "removal",
    operationRefs: [
      { kind: "graph", commandId: "rename-home-1" },
      { kind: "graph", commandId: "rename-home-2" },
      { kind: "graph", commandId: "archive-home" },
    ],
  }]);
  expect(diff.edgeChanges).toHaveLength(2);
  expect(diff.edgeChanges.every((change) => change.changeKind === "removal")).toBe(true);
  expect(diff.edgeChanges.every((change) => (
    change.operationRefs.some((ref) => ref.kind === "graph" && ref.commandId === "archive-home")
  ))).toBe(true);
});

test("proposal diff replays add remove and prototype-binding edge semantics", () => {
  const proposal: ProposalDiffProposal = {
    id: "proposal-edges",
    baseGraphRevision: 7,
    baseSnapshotId: "snapshot-7",
    baseGraph: connectedGraph,
    baseLayoutChecksum: "layout-7",
    baseLayout,
    operations: [
      {
        id: "bind-next",
        type: "bind-prototype",
        edgeId: "edge-next",
        binding: {
          sourceArtifactId: "artifact-home",
          sourceRevisionId: "revision-home",
          sourceLocator: { designNodeId: "checkout-button" },
          trigger: "click",
          targetArtifactId: "artifact-receipt",
        },
      },
      { id: "remove-uses", type: "remove-edge", edgeId: "edge-uses" },
      {
        id: "add-informs",
        type: "add-edge",
        edge: {
          id: "edge-informs",
          workspaceId: "workspace-1",
          kind: "informs",
          sourceNodeId: "page-receipt",
          targetNodeId: "page-home",
        },
      },
    ],
    layoutOperations: [],
  };

  const diff = buildProposalDiff(proposal, {
    graph: connectedGraph,
    activeSnapshotId: "snapshot-7",
    layoutChecksum: "layout-7",
  });

  expect(diff.proposedGraph.edges).toHaveLength(2);
  expect(diff.proposedGraph.edges.find((edge) => edge.id === "edge-next")).toMatchObject({
    prototype: { status: "interactive", binding: { trigger: "click" } },
  });
  expect(diff.edgeChanges.map((change) => [change.objectId, change.changeKind])).toEqual([
    ["edge-next", "modification"],
    ["edge-uses", "removal"],
    ["edge-informs", "addition"],
  ]);
  expect(diff.edgeChanges.find((change) => change.objectId === "edge-informs")?.accessibleLabel)
    .toBe("Proposed addition: Informs from Receipt to Home");
});

test("proposal diff replays layout grouping from base layout and retains operation indexes", () => {
  const proposal: ProposalDiffProposal = {
    id: "proposal-layout",
    baseGraphRevision: 7,
    baseSnapshotId: "snapshot-7",
    baseGraph,
    baseLayoutChecksum: "layout-7",
    baseLayout,
    operations: [],
    layoutOperations: [
      { type: "add-group", groupId: "group-checkout", label: "Flow", bounds: { x: 40, y: 40, width: 420, height: 280 } },
      { type: "rename-group", groupId: "group-checkout", label: "Checkout flow" },
      { type: "set-parent", objectId: "page-home", parentGroupId: "group-checkout" },
      { type: "move", objectId: "page-home", x: 112, y: 128 },
      { type: "resize-group", groupId: "group-checkout", width: 500, height: 320 },
      { type: "set-collapsed", groupId: "group-checkout", collapsed: true },
      { type: "set-viewport", viewport: { x: -20, y: 16, zoom: 0.85 } },
    ],
  };

  const diff = buildProposalDiff(proposal, {
    graph: baseGraph,
    activeSnapshotId: "snapshot-7",
    layoutChecksum: "layout-7",
  });

  expect(diff.proposedLayout).toMatchObject({
    viewport: { x: -20, y: 16, zoom: 0.85 },
    objects: [
      { id: "page-home", x: 112, y: 128, parentGroupId: "group-checkout" },
      { id: "group-checkout", label: "Checkout flow", width: 500, height: 320, collapsed: true },
    ],
  });
  expect(diff.groupChanges.find((change) => change.objectId === "group-checkout")?.operationRefs).toEqual([
    { kind: "layout", index: 0 },
    { kind: "layout", index: 1 },
    { kind: "layout", index: 4 },
    { kind: "layout", index: 5 },
  ]);
  expect(diff.groupChanges.find((change) => change.objectId === "page-home")?.operationRefs).toEqual([
    { kind: "layout", index: 2 },
    { kind: "layout", index: 3 },
  ]);
});

test("proposal diff marks staleness only from current graph snapshot or layout pointers", () => {
  const proposal: ProposalDiffProposal = {
    id: "proposal-stale",
    baseGraphRevision: 7,
    baseSnapshotId: "snapshot-7",
    baseGraph,
    baseLayoutChecksum: "layout-7",
    baseLayout,
    operations: [],
    layoutOperations: [],
  };

  expect(buildProposalDiff(proposal, {
    graph: baseGraph,
    activeSnapshotId: "snapshot-7",
    layoutChecksum: "layout-7",
  }).staleAgainstCurrent).toBe(false);
  expect(buildProposalDiff(proposal, {
    graph: { ...baseGraph, revision: 8 },
    activeSnapshotId: "snapshot-7",
    layoutChecksum: "layout-7",
  }).staleAgainstCurrent).toBe(true);
  expect(buildProposalDiff(proposal, {
    graph: baseGraph,
    activeSnapshotId: "snapshot-8",
    layoutChecksum: "layout-7",
  }).staleAgainstCurrent).toBe(true);
  expect(buildProposalDiff(proposal, {
    graph: baseGraph,
    activeSnapshotId: "snapshot-7",
    layoutChecksum: "layout-8",
  }).staleAgainstCurrent).toBe(true);
});

test("proposal API methods use the project-owned list get create edit approve and reject routes", async () => {
  const proposal = {
    id: "proposal-1",
    workspaceId: "workspace-1",
    revision: 1,
    status: "draft",
  };
  const approval = {
    graph: baseGraph,
    snapshot: { id: "snapshot-8" },
    layout: baseLayout,
    plan: null,
  };
  const fetchImpl = vi.fn<FetchLike>(async (url, init) => {
    if (url.endsWith("/approve")) return new Response(JSON.stringify(approval), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/reject")) return new Response(JSON.stringify({ ...proposal, status: "rejected" }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/proposals/proposal%2F1")) return new Response(JSON.stringify(proposal), { status: 200, headers: { "content-type": "application/json" } });
    if (init?.method === "POST" || init?.method === "PATCH") return new Response(JSON.stringify(proposal), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify([proposal]), { status: 200, headers: { "content-type": "application/json" } });
  });
  const api = createApiClient({ baseUrl: "http://dezin.local", fetchImpl });
  const createInput = {
    kind: "workspace-generation" as const,
    baseGraphRevision: 7,
    baseSnapshotId: "snapshot-7",
    baseLayoutChecksum: "layout-7",
    operations: [],
    layoutOperations: [],
    generation: {
      kind: "workspace-generation" as const,
      resourceOperations: [],
      artifactPlans: [],
      dependencyPlans: [],
      prototypeIntents: [],
      capabilities: [],
      responsiveFrames: [],
      qualityProfile: {
        requiredFrameIds: [],
        blockingSeverities: [],
        requireRuntimeChecks: false,
        requireVisualReview: false,
      },
    },
    rationale: "Add checkout",
    assumptions: [],
  };
  const updateInput = {
    expectedProposalRevision: 1,
    operations: [],
    layoutOperations: [],
    generation: createInput.generation,
    rationale: "Add checkout flow",
    assumptions: ["Desktop first"],
  };

  await api.listWorkspaceProposals("project 1");
  await api.getWorkspaceProposal("project 1", "proposal/1");
  await api.createWorkspaceProposal("project 1", createInput);
  await api.updateWorkspaceProposal("project 1", "proposal/1", updateInput);
  await api.approveWorkspaceProposal("project 1", "proposal/1", "structure-only");
  await api.rejectWorkspaceProposal("project 1", "proposal/1");

  const root = "http://dezin.local/api/projects/project%201/workspace/proposals";
  expect(fetchImpl).toHaveBeenNthCalledWith(1, root, undefined);
  expect(fetchImpl).toHaveBeenNthCalledWith(2, `${root}/proposal%2F1`, undefined);
  expect(fetchImpl).toHaveBeenNthCalledWith(3, root, expect.objectContaining({ method: "POST", body: JSON.stringify(createInput) }));
  expect(fetchImpl).toHaveBeenNthCalledWith(4, `${root}/proposal%2F1`, expect.objectContaining({ method: "PATCH", body: JSON.stringify(updateInput) }));
  expect(fetchImpl).toHaveBeenNthCalledWith(5, `${root}/proposal%2F1/approve`, expect.objectContaining({ method: "POST", body: JSON.stringify({ mode: "structure-only" }) }));
  expect(fetchImpl).toHaveBeenNthCalledWith(6, `${root}/proposal%2F1/reject`, expect.objectContaining({ method: "POST", body: JSON.stringify({}) }));
});

test("proposal approval preserves the 409 conflict body on ApiError details", async () => {
  const details = {
    code: "workspace_proposal_conflict",
    error: "Proposal base is stale",
    proposal: { id: "proposal-1", status: "conflicted", revision: 2 },
    expectedGraphRevision: 7,
    actualGraphRevision: 8,
  };
  const api = createApiClient({
    fetchImpl: async () => new Response(JSON.stringify(details), {
      status: 409,
      headers: { "content-type": "application/json" },
    }),
  });

  const error = await api.approveWorkspaceProposal("project-1", "proposal-1", "generate")
    .catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(409);
  expect((error as ApiError).details).toEqual(details);
});

test("proposal overlay uses prefixed view-only IDs and keeps changed relations visible outside the canonical filter", () => {
  const proposal: ProposalDiffProposal = {
    id: "proposal-overlay",
    baseGraphRevision: 7,
    baseSnapshotId: "snapshot-7",
    baseGraph: connectedGraph,
    baseLayoutChecksum: "layout-7",
    baseLayout,
    operations: [
      {
        id: "add-checkout",
        type: "add-node",
        node: { id: "page-checkout", kind: "page", name: "Checkout", artifactId: "artifact-checkout" },
      },
      {
        id: "add-dependency",
        type: "add-edge",
        edge: {
          id: "edge-checkout-uses",
          workspaceId: "workspace-1",
          kind: "uses",
          sourceNodeId: "page-checkout",
          targetNodeId: "page-receipt",
        },
      },
    ],
    layoutOperations: [],
  };
  const diff = buildProposalDiff(proposal, {
    graph: connectedGraph,
    activeSnapshotId: "snapshot-7",
    layoutChecksum: "layout-7",
  });
  const view = {
    zoom: 1,
    edgeFilter: "flow" as const,
    selectedNodeIds: new Set(["page-home"]),
    selectedEdgeIds: new Set<string>(),
  };
  const canonical = workspaceGraphToFlow(connectedGraph, baseLayout, view);
  const proposedAll = workspaceGraphToFlow(diff.proposedGraph, diff.proposedLayout!, {
    ...view,
    edgeFilter: "all",
    selectedNodeIds: new Set<string>(),
  });

  const overlay = createProposalOverlayModel(diff, canonical, "proposal-overlay", proposedAll);
  const merged = mergeProposalOverlay(canonical, overlay);

  expect(canonical.edges.some((edge) => edge.id === "edge-checkout-uses")).toBe(false);
  expect(overlay.edges).toHaveLength(1);
  expect(overlay.edges[0]).toMatchObject({
    id: "proposal:proposal-overlay:edge:edge-checkout-uses",
    source: "proposal:proposal-overlay:node:page-checkout",
    target: "page-receipt",
    selectable: false,
    focusable: true,
    animated: false,
  });
  expect(overlay.nodes[0]).toMatchObject({
    id: "proposal:proposal-overlay:node:page-checkout",
    draggable: false,
    connectable: false,
    selectable: false,
    focusable: true,
    selected: false,
  });
  expect(merged.nodes.filter((node) => node.id.startsWith("proposal:"))).toHaveLength(1);
  expect(merged.nodes.find((node) => node.id === "page-home")?.selected).toBe(true);
  expect(proposalOverlayId("proposal-overlay", "node", "page-checkout"))
    .toBe("proposal:proposal-overlay:node:page-checkout");
});

test("proposal overlay de-emphasizes only affected canonical objects as a view transform", () => {
  const proposal: ProposalDiffProposal = {
    id: "proposal-change",
    baseGraphRevision: 7,
    baseSnapshotId: "snapshot-7",
    baseGraph: connectedGraph,
    baseLayoutChecksum: "layout-7",
    baseLayout,
    operations: [
      { id: "rename-home", type: "rename-node", nodeId: "page-home", name: "Storefront" },
      {
        id: "bind-next",
        type: "bind-prototype",
        edgeId: "edge-next",
        binding: {
          sourceArtifactId: "artifact-home",
          sourceRevisionId: "revision-home",
          sourceLocator: { designNodeId: "cta" },
          trigger: "click",
          targetArtifactId: "artifact-receipt",
        },
      },
    ],
    layoutOperations: [],
  };
  const diff = buildProposalDiff(proposal, {
    graph: connectedGraph,
    activeSnapshotId: "snapshot-7",
    layoutChecksum: "layout-7",
  });
  const view = { zoom: 1, edgeFilter: "flow" as const };
  const canonical = workspaceGraphToFlow(connectedGraph, baseLayout, view);
  const proposed = workspaceGraphToFlow(diff.proposedGraph, diff.proposedLayout!, { ...view, edgeFilter: "all" });

  const merged = mergeProposalOverlay(
    canonical,
    createProposalOverlayModel(diff, canonical, "proposal-change", proposed),
  );

  expect(merged.nodes.find((node) => node.id === "page-home")).toMatchObject({
    focusable: false,
    className: expect.stringContaining("proposal-canonical-affected"),
  });
  expect(merged.nodes.find((node) => node.id === "page-receipt")?.className ?? "")
    .not.toContain("proposal-canonical-affected");
  expect(merged.edges.find((edge) => edge.id === "edge-next")?.className ?? "")
    .toContain("proposal-canonical-affected");
  expect(merged.nodes.find((node) => node.id === "proposal:proposal-change:node:page-home")?.ariaLabel)
    .toBe("Proposed change: Page Storefront");
});

test("proposal overlay keeps removed and modified non-prototype relations in the review model", () => {
  const relationGraph: WorkspaceGraph = {
    ...connectedGraph,
    edges: [
      ...connectedGraph.edges,
      {
        id: "edge-context",
        workspaceId: "workspace-1",
        kind: "informs",
        sourceNodeId: "page-receipt",
        targetNodeId: "page-home",
      },
    ],
  };
  const proposal: ProposalDiffProposal = {
    id: "proposal-relations",
    baseGraphRevision: 7,
    baseSnapshotId: "snapshot-7",
    baseGraph: relationGraph,
    baseLayoutChecksum: "layout-7",
    baseLayout,
    operations: [
      { id: "remove-uses", type: "remove-edge", edgeId: "edge-uses" },
      {
        id: "replace-uses",
        type: "add-edge",
        edge: {
          id: "edge-uses",
          workspaceId: "workspace-1",
          kind: "derives-from",
          sourceNodeId: "page-receipt",
          targetNodeId: "page-home",
        },
      },
      { id: "remove-context", type: "remove-edge", edgeId: "edge-context" },
    ],
    layoutOperations: [],
  };
  const diff = buildProposalDiff(proposal, {
    graph: relationGraph,
    activeSnapshotId: "snapshot-7",
    layoutChecksum: "layout-7",
  });
  const canonicalFiltered = workspaceGraphToFlow(relationGraph, baseLayout, { zoom: 1, edgeFilter: "flow" });
  const canonicalAll = workspaceGraphToFlow(relationGraph, baseLayout, { zoom: 1, edgeFilter: "all" });
  const proposedAll = workspaceGraphToFlow(diff.proposedGraph, diff.proposedLayout!, { zoom: 1, edgeFilter: "all" });

  const overlay = createProposalOverlayModel(diff, canonicalAll, proposal.id, proposedAll);

  expect(canonicalFiltered.edges.map((edge) => edge.id)).toEqual(["edge-next"]);
  expect(overlay.edges.map((edge) => [edge.id, edge.data?.proposalChangeKind])).toEqual([
    ["proposal:proposal-relations:edge:edge-uses", "modification"],
    ["proposal:proposal-relations:edge:edge-context", "removal"],
  ]);
});

test("canvas merges the proposal into one ReactFlow and keeps proposal focus out of canonical selection", async () => {
  const proposal: ProposalDiffProposal = {
    id: "proposal-canvas",
    baseGraphRevision: 7,
    baseSnapshotId: "snapshot-7",
    baseGraph: connectedGraph,
    baseLayoutChecksum: "layout-7",
    baseLayout,
    operations: [
      {
        id: "add-checkout",
        type: "add-node",
        node: { id: "page-checkout", kind: "page", name: "Checkout", artifactId: "artifact-checkout" },
      },
      {
        id: "add-dependency",
        type: "add-edge",
        edge: {
          id: "edge-checkout-uses",
          workspaceId: "workspace-1",
          kind: "uses",
          sourceNodeId: "page-checkout",
          targetNodeId: "page-receipt",
        },
      },
    ],
    layoutOperations: [],
  };
  const diff = buildProposalDiff(proposal, {
    graph: connectedGraph,
    activeSnapshotId: "snapshot-7",
    layoutChecksum: "layout-7",
  });
  const onSelectionChange = vi.fn();
  const onSaveLayout = vi.fn(async () => baseLayout);
  const onApplyGraphCommands = vi.fn(async () => {});

  const rendered = render(
    <ProjectCanvas
      projectId="project-1"
      projectName="Storefront"
      graph={connectedGraph}
      layout={baseLayout}
      artifactRevisionIds={{}}
      selectedNodeIds={[]}
      onSelectionChange={onSelectionChange}
      onSaveLayout={onSaveLayout}
      onApplyGraphCommands={onApplyGraphCommands}
      onOpenArtifact={() => {}}
      proposal={{ id: "proposal-canvas" }}
      proposalDiff={diff}
      proposalFocus={null}
    />,
  );
  const { container } = rendered;

  expect(container.querySelectorAll(".react-flow")).toHaveLength(1);
  expect(container.querySelector("iframe")).toBeNull();
  expect(screen.getByText("Added")).toBeInTheDocument();
  expect(container.querySelector('[data-shape="addition"]')).not.toBeNull();
  const overlayNode = container.querySelector<HTMLElement>('.react-flow__node[data-id="proposal:proposal-canvas:node:page-checkout"]');
  expect(overlayNode).toHaveAttribute("aria-label", "Proposed addition: Page Checkout");

  fireEvent.click(overlayNode!);
  expect(onSelectionChange).not.toHaveBeenCalled();
  expect(onSaveLayout).not.toHaveBeenCalled();
  expect(onApplyGraphCommands).not.toHaveBeenCalled();

  const reviewControl = document.createElement("button");
  reviewControl.textContent = "Review node";
  document.body.append(reviewControl);
  reviewControl.focus();
  rendered.rerender(
    <ProjectCanvas
      projectId="project-1"
      projectName="Storefront"
      graph={connectedGraph}
      layout={baseLayout}
      artifactRevisionIds={{}}
      selectedNodeIds={[]}
      onSelectionChange={onSelectionChange}
      onSaveLayout={onSaveLayout}
      onApplyGraphCommands={onApplyGraphCommands}
      onOpenArtifact={() => {}}
      proposal={{ id: "proposal-canvas" }}
      proposalDiff={diff}
      proposalFocus={{ key: "node:page-checkout", nonce: 2 }}
    />,
  );
  reviewControl.focus();
  expect(document.activeElement).toBe(reviewControl);
  await waitFor(() => expect(document.activeElement).toBe(overlayNode));
  reviewControl.remove();
});

test("real ReactFlow renderer resolves Proposal handles and paints the overlay relationship", async () => {
  const measureReactFlow = installReactFlowMeasurements();
  const proposal: ProposalDiffProposal = {
    id: "proposal-renderer",
    baseGraphRevision: 7,
    baseSnapshotId: "snapshot-7",
    baseGraph: connectedGraph,
    baseLayoutChecksum: "layout-7",
    baseLayout,
    operations: [
      {
        id: "add-checkout",
        type: "add-node",
        node: { id: "page-checkout", kind: "page", name: "Checkout", artifactId: "artifact-checkout" },
      },
      {
        id: "add-dependency",
        type: "add-edge",
        edge: {
          id: "edge-checkout-uses",
          workspaceId: "workspace-1",
          kind: "uses",
          sourceNodeId: "page-checkout",
          targetNodeId: "page-receipt",
        },
      },
    ],
    layoutOperations: [],
  };
  const diff = buildProposalDiff(proposal, {
    graph: connectedGraph,
    activeSnapshotId: "snapshot-7",
    layoutChecksum: "layout-7",
  });
  const canonicalAll = workspaceGraphToFlow(connectedGraph, baseLayout, { zoom: 1, edgeFilter: "all" });
  const proposedAll = workspaceGraphToFlow(diff.proposedGraph, diff.proposedLayout!, { zoom: 1, edgeFilter: "all" });
  const overlay = createProposalOverlayModel(diff, canonicalAll, proposal.id, proposedAll);
  expect(overlay.edges[0]).toMatchObject({
    sourceHandle: "proposal-source",
    targetHandle: undefined,
    zIndex: 28,
  });
  const model = mergeProposalOverlay(canonicalAll, overlay);
  const { container } = render(
    <div style={{ width: 960, height: 640 }}>
      <ReactFlow
        nodes={model.nodes}
        edges={model.edges}
        nodeTypes={{ ...workspaceNodeTypes, proposal: ProposalOverlay }}
        edgeTypes={{ ...workspaceEdgeTypes, proposal: ProposalOverlayEdge }}
      />
    </div>,
  );

  await act(async () => {
    measureReactFlow();
    await Promise.resolve();
    measureReactFlow();
  });

  const selector = '.react-flow__edge[data-id="proposal:proposal-renderer:edge:edge-checkout-uses"]';
  await waitFor(() => expect(container.querySelector(selector)).not.toBeNull());
  expect(screen.getByText("Uses component")).toBeInTheDocument();
  expect(container.querySelectorAll('.react-flow__node[data-id="proposal:proposal-renderer:node:page-checkout"] .dezin-proposal-node__handle')).toHaveLength(2);
});

test("proposal review panel exposes editable rationale review actions and non-color status language", async () => {
  const proposal = draftProposal();
  const diff = buildProposalDiff(proposal, {
    graph: baseGraph,
    activeSnapshotId: "snapshot-7",
    layoutChecksum: "layout-7",
  });
  const onEdit = vi.fn(async () => proposal);
  const onRevert = vi.fn(async () => proposal);
  const onFocusItem = vi.fn();
  const onApprove = vi.fn(async () => {});
  const onReject = vi.fn(async () => {});

  const { container } = render(
    <ProposalReviewPanel
      review={{ status: "draft", proposal, diff }}
      focusedChangeKey={null}
      onEdit={onEdit}
      onRevert={onRevert}
      onFocusItem={onFocusItem}
      onApprove={onApprove}
      onReject={onReject}
      onClose={() => {}}
    />,
  );

  expect(screen.getByRole("region", { name: "Proposal review" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Workspace proposal" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Review added page Checkout" })).toBeInTheDocument();
  expect(screen.getByText("Added")).toBeInTheDocument();
  expect(container.querySelector('[data-status-shape="addition"]')).not.toBeNull();
  expect(screen.getByRole("button", { name: "Apply structure only" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Approve and generate" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reject proposal" })).toBeInTheDocument();

  const rationale = screen.getByRole("textbox", { name: "Proposal rationale" });
  fireEvent.change(rationale, { target: { value: "Add a complete checkout flow" } });
  fireEvent.blur(rationale);
  await waitFor(() => expect(onEdit).toHaveBeenCalledWith({ rationale: "Add a complete checkout flow" }));

  fireEvent.click(screen.getByRole("button", { name: "Review added page Checkout" }));
  expect(onFocusItem).toHaveBeenCalledWith("node:page-checkout");
  fireEvent.click(screen.getByRole("button", { name: "Revert added page Checkout" }));
  await waitFor(() => expect(onRevert).toHaveBeenCalledWith(diff.nodeChanges[0]));
});

test("Proposal review terminal states explain rejected and superseded outcomes without approval copy", () => {
  const callbacks = {
    focusedChangeKey: null,
    onEdit: async () => {},
    onRevert: async () => {},
    onFocusItem: () => {},
    onApprove: async () => {},
    onReject: async () => {},
    onClose: () => {},
  };
  const rejected = draftProposal({ status: "rejected", review: { kind: "rejected" } });
  const rendered = render(
    <ProposalReviewPanel review={{ status: "rejected", proposal: rejected, plan: null }} {...callbacks} />,
  );

  expect(screen.getByRole("heading", { name: "Proposal rejected" })).toBeInTheDocument();
  expect(screen.getByText("No workspace changes were applied.")).toBeInTheDocument();
  expect(rendered.container.querySelector('[data-result-state="rejected"]')).not.toBeNull();

  const superseded = draftProposal({ status: "superseded", review: { kind: "none" } });
  rendered.rerender(
    <ProposalReviewPanel review={{ status: "superseded", proposal: superseded, plan: null }} {...callbacks} />,
  );
  expect(screen.getByRole("heading", { name: "Proposal superseded" })).toBeInTheDocument();
  expect(screen.getByText("A newer proposal replaced this review.")).toBeInTheDocument();
  expect(rendered.container.querySelector('[data-result-state="superseded"]')).not.toBeNull();
});

function standardProject(projectId = "project-1"): Project {
  return {
    id: projectId,
    name: "Storefront",
    skillId: null,
    designSystemId: null,
    mode: "standard",
    createdAt: 1,
    updatedAt: 1,
  };
}

function workspacePayload(revision = 7, layoutChecksum = `layout-${revision}`): ReadyProjectWorkspacePayload {
  const graph: WorkspaceGraph = {
    ...baseGraph,
    revision,
    nodes: revision === 7
      ? baseGraph.nodes
      : [
          ...baseGraph.nodes,
          { id: "page-checkout", workspaceId: "workspace-1", kind: "page", artifactId: "artifact-checkout", name: "Checkout" },
        ],
  };
  const snapshotId = `snapshot-${revision}`;
  const snapshot = {
    id: snapshotId,
    workspaceId: "workspace-1",
    sequence: revision,
    parentSnapshotId: revision === 7 ? null : "snapshot-7",
    graphRevision: revision,
    kernelRevisionId: "kernel-1",
    reason: revision === 7 ? "workspace-created" : "proposal-approval",
    provenance: revision === 7
      ? { kind: "workspace-created" as const }
      : { kind: "proposal-approval" as const, proposalId: "proposal-1", proposalRevision: 2 },
    createdByRunId: null,
    createdAt: revision,
    graph,
    artifactTracks: {},
    artifactRevisions: { "artifact-home": "revision-home" },
    resourceRevisions: {},
  };
  const layout: WorkspaceLayout = {
    ...baseLayout,
    checksum: layoutChecksum,
    objects: revision === 7
      ? baseLayout.objects
      : [...baseLayout.objects, { id: "page-checkout", kind: "node", x: 360, y: 96, parentGroupId: null }],
  };
  return {
    status: "ready",
    workspace: {
      id: "workspace-1",
      projectId: "project-1",
      mode: "standard",
      graphRevision: revision,
      activeSnapshotId: snapshotId,
      activeKernelRevisionId: "kernel-1",
      createdAt: 1,
      updatedAt: revision,
    },
    graph,
    activeSnapshot: snapshot,
    activeKernelRevision: {
      id: "kernel-1",
      workspaceId: "workspace-1",
      sequence: 1,
      parentRevisionId: null,
      tokens: {},
      typography: {},
      sharedAssetRevisionIds: [],
      brief: "",
      terminology: {},
      exclusions: [],
      responsiveFrames: [],
      qualityProfile: {
        requiredFrameIds: [],
        blockingSeverities: [],
        requireRuntimeChecks: false,
        requireVisualReview: false,
      },
      checksum: "kernel-1",
      createdAt: 1,
    },
    artifacts: [],
    tracks: [],
    revisions: [],
    snapshots: [snapshot],
    layout,
  };
}

function approvedResult(mode: "structure-only" | "generate" = "generate") {
  const workspace = workspacePayload(8);
  return {
    proposal: draftProposal({
      revision: 2,
      status: "approved",
      review: { kind: "approved", mode },
      updatedAt: 8,
    }),
    graph: workspace.graph,
    snapshot: workspace.activeSnapshot,
    layout: workspace.layout,
    plan: mode === "generate" ? {
      id: "plan-1",
      workspaceId: "workspace-1",
      proposalId: "proposal-1",
      proposalRevision: 2,
      baseSnapshotId: "snapshot-8",
      status: "approved" as const,
      compileError: null,
      createdAt: 8,
      finishedAt: null,
    } : null,
  };
}

function renderStudio(overrides: Parameters<typeof makeFakeApi>[0]) {
  return render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => standardProject(),
      getWorkspace: async () => workspacePayload(),
      listWorkspaceProposals: async () => [draftProposal()],
      ...overrides,
    })}>
      <ProjectStudioScreen
        projectId="project-1"
        artifactId={null}
        legacyFallback={() => null}
        onOpenSettings={() => {}}
      />
    </ApiProvider>,
  );
}

function ProposalStudioProbe() {
  const studio = useProjectStudio("project-1");
  if (studio.load.status !== "ready") return <span>{studio.load.status}</span>;
  const currentProposal = "proposal" in studio.proposalReview ? studio.proposalReview.proposal : null;
  const reviewable = studio.proposalReview.status === "draft"
    || studio.proposalReview.status === "saving"
    || studio.proposalReview.status === "validation-error"
    || studio.proposalReview.status === "conflicted"
    ? studio.proposalReview
    : null;
  return (
    <div>
      <output data-testid="proposal-status">{studio.proposalReview.status}</output>
      <output data-testid="proposal-stale">{String(reviewable?.diff.staleAgainstCurrent ?? false)}</output>
      <output data-testid="proposal-pointers">
        {studio.load.workspace.graph.revision}:{studio.load.workspace.activeSnapshot.id}:{studio.load.workspace.layout.checksum}
      </output>
      <output data-testid="proposal-record">
        {currentProposal ? `${currentProposal.revision}:${currentProposal.rationale}:${currentProposal.status}` : "none"}
      </output>
      <button type="button" onClick={() => void studio.editProposal({ rationale: "Latest rationale" })}>Queue edit</button>
      <button type="button" onClick={() => void studio.approveProposal("generate")}>Approve now</button>
      <button type="button" onClick={() => void studio.saveLayout([{ type: "set-viewport", viewport: { x: 10, y: 0, zoom: 1 } }])}>Save after approval</button>
    </div>
  );
}

function DoubleRevertProbe() {
  const studio = useProjectStudio("project-1");
  const review = studio.proposalReview;
  if (studio.load.status !== "ready" || review.status !== "draft") return <span>{studio.load.status}</span>;
  return (
    <button
      type="button"
      onClick={() => {
        void studio.revertProposalChange(review.diff.nodeChanges[0]!);
        void studio.revertProposalChange(review.diff.nodeChanges[1]!);
      }}
    >
      Revert both
    </button>
  );
}

function DoubleLayoutRevertProbe() {
  const studio = useProjectStudio("project-1");
  const review = studio.proposalReview;
  if (studio.load.status !== "ready" || review.status !== "draft") return <span>{studio.load.status}</span>;
  return (
    <button
      type="button"
      onClick={() => {
        void studio.revertProposalChange(review.diff.groupChanges[0]!);
        void studio.revertProposalChange(review.diff.groupChanges[1]!);
      }}
    >
      Revert both layout changes
    </button>
  );
}

function DuplicateRevertProbe() {
  const studio = useProjectStudio("project-1");
  const review = studio.proposalReview;
  if (studio.load.status !== "ready" || review.status !== "draft") return <span>{studio.load.status}</span>;
  return (
    <button
      type="button"
      onClick={() => {
        void studio.revertProposalChange(review.diff.nodeChanges[0]!);
        void studio.revertProposalChange(review.diff.nodeChanges[0]!);
      }}
    >
      Revert the same change twice
    </button>
  );
}

function SwitchingStudioProbe({ projectId }: { projectId: string }) {
  const studio = useProjectStudio(projectId);
  if (studio.load.status !== "ready") return <span>{studio.load.status}</span>;
  return (
    <div>
      <output data-testid="switch-project">{studio.load.project.id}</output>
      <output data-testid="switch-review">{studio.proposalReview.status}</output>
      <output data-testid="switch-selection">{studio.selectedGraphObjectIds.length}</output>
      <output data-testid="switch-viewport">{studio.viewport.x}</output>
      <output data-testid="switch-tasks">{studio.taskQueue.length}</output>
      <textarea aria-label="Switching Agent draft" value={studio.workspaceAgentDraft} onChange={(event) => studio.setWorkspaceAgentDraft(event.target.value)} />
      <button
        type="button"
        onClick={() => {
          studio.setSelectedGraphObjectIds(["page-home"]);
          studio.setViewport({ x: 99, y: 0, zoom: 1 });
          studio.setTaskQueue([{ id: "task-p1", label: "P1", state: "queued" }]);
        }}
      >
        Seed project state
      </button>
      <button type="button" onClick={() => void studio.editProposal({ rationale: "Delayed P1 edit" })}>Start delayed edit</button>
      <button type="button" onClick={() => void studio.approveProposal("generate")}>Start approval</button>
      <button
        type="button"
        onClick={() => {
          void studio.saveLayout([{ type: "set-viewport", viewport: { x: 12, y: 0, zoom: 1 } }]).catch(() => {});
          void studio.approveProposal("generate");
        }}
      >
        Block mutation then approve
      </button>
    </div>
  );
}

test("saving review locks draft fields so blur cannot enqueue a second edit", () => {
  const proposal = draftProposal();
  const diff = buildProposalDiff(proposal, {
    graph: baseGraph,
    activeSnapshotId: "snapshot-7",
    layoutChecksum: "layout-7",
  });
  const onEdit = vi.fn(async () => proposal);
  render(
    <ProposalReviewPanel
      review={{ status: "saving", intent: "approve", proposal, diff }}
      focusedChangeKey={null}
      onEdit={onEdit}
      onRevert={async () => proposal}
      onFocusItem={() => {}}
      onApprove={async () => {}}
      onReject={async () => {}}
      onClose={() => {}}
    />,
  );

  const rationale = screen.getByRole("textbox", { name: "Proposal rationale" });
  expect(rationale).toHaveAttribute("readonly");
  fireEvent.blur(rationale);
  expect(onEdit).not.toHaveBeenCalled();
});

test("Studio review edits and per-item revert use full Proposal CAS payloads without canonical graph writes", async () => {
  const updateWorkspaceProposal = vi.fn(async (_projectId, _proposalId, input) => draftProposal({
    revision: input.expectedProposalRevision + 1,
    operations: [...input.operations],
    layoutOperations: [...input.layoutOperations],
    generation: input.generation,
    rationale: input.rationale,
    assumptions: [...input.assumptions],
    updatedAt: input.expectedProposalRevision + 1,
  }));
  const applyWorkspaceGraphCommands = vi.fn();
  const { container } = renderStudio({ updateWorkspaceProposal, applyWorkspaceGraphCommands });

  await screen.findByRole("region", { name: "Project canvas" });
  const rationale = await screen.findByRole("textbox", { name: "Proposal rationale" });
  fireEvent.change(rationale, { target: { value: "Add a complete checkout flow" } });
  fireEvent.blur(rationale);
  await waitFor(() => expect(updateWorkspaceProposal).toHaveBeenCalledTimes(1));
  expect(updateWorkspaceProposal.mock.calls[0]?.[2]).toMatchObject({
    expectedProposalRevision: 1,
    operations: draftProposal().operations,
    layoutOperations: [],
    generation: emptyGeneration,
    rationale: "Add a complete checkout flow",
    assumptions: ["Existing cart state is reusable"],
  });

  fireEvent.click(await screen.findByRole("button", { name: "Revert added page Checkout" }));
  await waitFor(() => expect(updateWorkspaceProposal).toHaveBeenCalledTimes(2));
  expect(updateWorkspaceProposal.mock.calls[1]?.[2]).toMatchObject({
    expectedProposalRevision: 2,
    operations: [],
    layoutOperations: [],
    rationale: "Add a complete checkout flow",
  });
  expect(applyWorkspaceGraphCommands).not.toHaveBeenCalled();
  expect(container.querySelectorAll('aside[aria-label="Inspector"]')).toHaveLength(1);
  expect(container.querySelector('aside[aria-label="Inspector"]')).toHaveAttribute("data-narrow-reachable", "true");
  fireEvent.click(screen.getByRole("button", { name: "Hide proposal review" }));
  expect(container.querySelectorAll('aside[aria-label="Inspector"]')).toHaveLength(1);
  expect(container.querySelector('aside[aria-label="Inspector"]')).not.toHaveAttribute("data-narrow-reachable");
  expect(screen.getByRole("button", { name: "Show proposal review" })).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(screen.getByRole("button", { name: "Show proposal review" }));
  expect(container.querySelector('aside[aria-label="Inspector"]')).toHaveAttribute("data-narrow-reachable", "true");
});

test("approval flushes a pending edit, calls approve once, and atomically advances all canonical pointers", async () => {
  let resolveEdit!: (proposal: WorkspaceProposal) => void;
  const pendingEdit = new Promise<WorkspaceProposal>((resolve) => { resolveEdit = resolve; });
  const updateWorkspaceProposal = vi.fn(() => pendingEdit);
  const approveWorkspaceProposal = vi.fn(async () => approvedResult("generate"));
  const saveWorkspaceLayout = vi.fn(async (_projectId, input) => ({
    ...approvedResult().layout,
    viewport: { x: 10, y: 0, zoom: 1 },
    checksum: `${input.baseLayoutChecksum}-next`,
  }));
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => standardProject(),
      getWorkspace: async () => workspacePayload(),
      listWorkspaceProposals: async () => [draftProposal()],
      updateWorkspaceProposal,
      approveWorkspaceProposal,
      saveWorkspaceLayout,
    })}>
      <ProposalStudioProbe />
    </ApiProvider>,
  );

  await screen.findByTestId("proposal-pointers");
  fireEvent.click(screen.getByRole("button", { name: "Queue edit" }));
  fireEvent.click(screen.getByRole("button", { name: "Approve now" }));
  fireEvent.click(screen.getByRole("button", { name: "Queue edit" }));
  await waitFor(() => expect(updateWorkspaceProposal).toHaveBeenCalledTimes(1));
  expect(approveWorkspaceProposal).not.toHaveBeenCalled();

  resolveEdit(draftProposal({ revision: 2, rationale: "Latest rationale", updatedAt: 2 }));
  await waitFor(() => expect(approveWorkspaceProposal).toHaveBeenCalledTimes(1));
  expect(updateWorkspaceProposal).toHaveBeenCalledTimes(1);
  expect(approveWorkspaceProposal).toHaveBeenCalledWith("project-1", "proposal-1", "generate");
  expect(screen.getByTestId("proposal-pointers")).toHaveTextContent("8:snapshot-8:layout-8");
  expect(screen.getByTestId("proposal-status")).toHaveTextContent("approved");

  fireEvent.click(screen.getByRole("button", { name: "Save after approval" }));
  await waitFor(() => expect(saveWorkspaceLayout).toHaveBeenCalledTimes(1));
  expect(saveWorkspaceLayout.mock.calls[0]?.[1]).toMatchObject({
    graphRevision: 8,
    baseLayoutChecksum: "layout-8",
  });
});

test("approval uses the authoritative Proposal returned by the approval result", async () => {
  const authoritativeProposal = draftProposal({
    revision: 4,
    status: "approved",
    rationale: "Authoritative concurrent review",
    assumptions: ["Approved server assumption"],
    review: { kind: "approved", mode: "generate" },
    updatedAt: 4,
  });
  const approveWorkspaceProposal = vi.fn(async () => ({
    ...approvedResult("generate"),
    proposal: authoritativeProposal,
  }));
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => standardProject(),
      getWorkspace: async () => workspacePayload(),
      listWorkspaceProposals: async () => [draftProposal()],
      approveWorkspaceProposal,
    })}>
      <ProposalStudioProbe />
    </ApiProvider>,
  );

  await screen.findByTestId("proposal-record");
  fireEvent.click(screen.getByRole("button", { name: "Approve now" }));

  await waitFor(() => expect(screen.getByTestId("proposal-status")).toHaveTextContent("approved"));
  expect(screen.getByTestId("proposal-record"))
    .toHaveTextContent("4:Authoritative concurrent review:approved");
});

test("structure-only approval calls the Proposal endpoint exactly once and never the graph command endpoint", async () => {
  const approveWorkspaceProposal = vi.fn(async () => approvedResult("structure-only"));
  const applyWorkspaceGraphCommands = vi.fn();
  const { container } = renderStudio({ approveWorkspaceProposal, applyWorkspaceGraphCommands });

  fireEvent.click(await screen.findByRole("button", { name: "Apply structure only" }));
  await waitFor(() => expect(approveWorkspaceProposal).toHaveBeenCalledTimes(1));
  expect(approveWorkspaceProposal).toHaveBeenCalledWith("project-1", "proposal-1", "structure-only");
  expect(applyWorkspaceGraphCommands).not.toHaveBeenCalled();
  expect(await screen.findByRole("heading", { name: "Proposal approved" })).toBeInTheDocument();
  await waitFor(() => expect(container.querySelector('[data-id="proposal:proposal-1:node:page-checkout"]')).toBeNull());
});

test("approval refreshes artifact collections without replacing the exact approved graph response", async () => {
  const approvedWorkspace = workspacePayload(8);
  const refreshedWorkspace: ReadyProjectWorkspacePayload = {
    ...approvedWorkspace,
    artifacts: [{
      id: "artifact-checkout",
      workspaceId: "workspace-1",
      kind: "page",
      name: "Checkout",
      sourceRoot: "artifacts/checkout",
      legacyWrapped: false,
      activeTrackId: null,
      archivedAt: null,
      createdAt: 8,
      updatedAt: 8,
    }],
  };
  const getWorkspace = vi.fn()
    .mockResolvedValueOnce(workspacePayload())
    .mockResolvedValueOnce(refreshedWorkspace);
  const approveWorkspaceProposal = vi.fn(async () => approvedResult("structure-only"));
  renderStudio({ getWorkspace, approveWorkspaceProposal });

  fireEvent.click(await screen.findByRole("button", { name: "Apply structure only" }));
  expect(await screen.findByRole("heading", { name: "Proposal approved" })).toBeInTheDocument();
  await waitFor(() => expect(getWorkspace).toHaveBeenCalledTimes(2));
  expect(screen.getByText("1 artifact")).toBeInTheDocument();
  expect(screen.getByLabelText("2 objects at 100 percent zoom")).toBeInTheDocument();
});

test("a 409 approval conflict is never replayed and reloads persisted read-only Proposal plus current workspace", async () => {
  const conflict = {
    expectedGraphRevision: 7,
    actualGraphRevision: 8,
    expectedSnapshotId: "snapshot-7",
    actualSnapshotId: "snapshot-8",
    expectedLayoutChecksum: "layout-7",
    actualLayoutChecksum: "layout-8",
    graphChanged: true,
    snapshotChanged: true,
    layoutChanged: true,
  };
  const persisted = draftProposal({
    revision: 2,
    status: "conflicted",
    review: { kind: "conflict", ...conflict },
    updatedAt: 2,
  });
  const getWorkspace = vi.fn()
    .mockResolvedValueOnce(workspacePayload())
    .mockResolvedValueOnce(workspacePayload(8));
  const getWorkspaceProposal = vi.fn(async () => persisted);
  const approveWorkspaceProposal = vi.fn(async () => {
    throw new ApiError(409, "Proposal base is stale", {
      code: "workspace_revision_conflict",
      ...conflict,
      proposal: persisted,
      summary: conflict,
    });
  });
  renderStudio({ getWorkspace, getWorkspaceProposal, approveWorkspaceProposal });

  fireEvent.click(await screen.findByRole("button", { name: "Approve and generate" }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Proposal base changed");
  expect(alert).toHaveTextContent("7 → 8");
  expect(alert).toHaveTextContent("snapshot-7 → snapshot-8");
  expect(screen.getByRole("textbox", { name: "Proposal rationale" })).toHaveAttribute("readonly");
  expect(screen.queryByRole("button", { name: "Approve and generate" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Revert added page Checkout" })).toBeNull();
  expect(screen.getByRole("button", { name: "Close review" })).toBeInTheDocument();
  expect(approveWorkspaceProposal).toHaveBeenCalledTimes(1);
  expect(getWorkspaceProposal).not.toHaveBeenCalled();
  expect(getWorkspace).toHaveBeenCalledTimes(2);
});

test("Proposal validation errors retain the editable draft and focus its issue summary", async () => {
  const approveWorkspaceProposal = vi.fn(async () => {
    throw new ApiError(422, "Proposal validation failed", {
      code: "workspace_proposal_validation_error",
      error: "Resolve the invalid proposal before approval.",
      details: {},
    });
  });
  renderStudio({ approveWorkspaceProposal });

  fireEvent.click(await screen.findByRole("button", { name: "Approve and generate" }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Proposal needs attention");
  expect(alert).toHaveTextContent("Resolve the invalid proposal before approval.");
  expect(screen.getByRole("textbox", { name: "Proposal rationale" })).not.toHaveAttribute("readonly");
  expect(screen.getByRole("button", { name: "Approve and generate" })).toBeEnabled();
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Proposal needs attention" }));
  expect(approveWorkspaceProposal).toHaveBeenCalledTimes(1);
});

test("two rapid per-item reverts serialize against the latest authoritative Proposal revision", async () => {
  const proposal = draftProposal({
    operations: [
      ...draftProposal().operations,
      {
        id: "command-add-receipt",
        type: "add-node",
        node: { id: "page-receipt", kind: "page", name: "Receipt", artifactId: "artifact-receipt" },
      },
    ],
  });
  let serverProposal = proposal;
  const updateWorkspaceProposal = vi.fn(async (_projectId, _proposalId, input) => {
    serverProposal = draftProposal({
      ...serverProposal,
      revision: input.expectedProposalRevision + 1,
      operations: [...input.operations],
      layoutOperations: [...input.layoutOperations],
      generation: input.generation,
      rationale: input.rationale,
      assumptions: [...input.assumptions],
    });
    return serverProposal;
  });
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => standardProject(),
      getWorkspace: async () => workspacePayload(),
      listWorkspaceProposals: async () => [proposal],
      updateWorkspaceProposal,
    })}>
      <DoubleRevertProbe />
    </ApiProvider>,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Revert both" }));
  await waitFor(() => expect(updateWorkspaceProposal).toHaveBeenCalledTimes(2));
  expect(updateWorkspaceProposal.mock.calls[0]?.[2]).toMatchObject({
    expectedProposalRevision: 1,
    operations: [expect.objectContaining({ id: "command-add-receipt" })],
  });
  expect(updateWorkspaceProposal.mock.calls[1]?.[2]).toMatchObject({
    expectedProposalRevision: 2,
    operations: [],
  });
});

test("a successful shared-command Revert prunes validation for review items that disappear", async () => {
  const proposal = draftProposal({
    baseGraph: connectedGraph,
    operations: [{ id: "command-archive-home", type: "archive-node", nodeId: "page-home" }],
  });
  const workspace = workspacePayload();
  const connectedWorkspace: ReadyProjectWorkspacePayload = {
    ...workspace,
    graph: connectedGraph,
    activeSnapshot: { ...workspace.activeSnapshot, graph: connectedGraph },
  };
  const updateWorkspaceProposal = vi.fn()
    .mockRejectedValueOnce(new ApiError(422, "Archive review needs attention", {
      code: "workspace_proposal_validation_error",
      error: "Review the archive impact before approval.",
      details: {},
    }))
    .mockResolvedValueOnce(draftProposal({
      ...proposal,
      revision: 2,
      operations: [],
      updatedAt: 2,
    }));
  renderStudio({
    getWorkspace: async () => connectedWorkspace,
    listWorkspaceProposals: async () => [proposal],
    updateWorkspaceProposal,
  });

  const reverts = await screen.findAllByRole("button", { name: /^Revert removed/ });
  expect(reverts.length).toBeGreaterThan(1);
  fireEvent.click(reverts[0]!);
  expect(await screen.findByRole("alert")).toHaveTextContent("Review the archive impact before approval.");

  fireEvent.click(reverts[1]!);

  await waitFor(() => expect(updateWorkspaceProposal).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(screen.queryByRole("button", { name: /^Revert removed/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Approve and generate" })).toBeEnabled();
});

test("two rapid layout reverts resolve shifted indexes against the latest authoritative Proposal", async () => {
  const proposal = draftProposal({
    layoutOperations: [
      { type: "move", objectId: "page-home", x: 140, y: 160 },
      { type: "add-group", groupId: "group-checkout", label: "Checkout", bounds: { x: 40, y: 40, width: 420, height: 280 } },
    ],
  });
  let serverProposal = proposal;
  const updateWorkspaceProposal = vi.fn(async (_projectId, _proposalId, input) => {
    serverProposal = draftProposal({
      ...serverProposal,
      revision: input.expectedProposalRevision + 1,
      operations: [...input.operations],
      layoutOperations: [...input.layoutOperations],
      generation: input.generation,
      rationale: input.rationale,
      assumptions: [...input.assumptions],
    });
    return serverProposal;
  });
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => standardProject(),
      getWorkspace: async () => workspacePayload(),
      listWorkspaceProposals: async () => [proposal],
      updateWorkspaceProposal,
    })}>
      <DoubleLayoutRevertProbe />
    </ApiProvider>,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Revert both layout changes" }));
  await waitFor(() => expect(updateWorkspaceProposal).toHaveBeenCalledTimes(2));
  expect(updateWorkspaceProposal.mock.calls[0]?.[2]).toMatchObject({
    expectedProposalRevision: 1,
    layoutOperations: [expect.objectContaining({ type: "add-group", groupId: "group-checkout" })],
  });
  expect(updateWorkspaceProposal.mock.calls[1]?.[2]).toMatchObject({
    expectedProposalRevision: 2,
    layoutOperations: [],
  });
});

test("a queued stale Revert is a no-op and does not consume another Proposal revision", async () => {
  const updateWorkspaceProposal = vi.fn(async (_projectId, _proposalId, input) => draftProposal({
    revision: input.expectedProposalRevision + 1,
    operations: [...input.operations],
    layoutOperations: [...input.layoutOperations],
    generation: input.generation,
    rationale: input.rationale,
    assumptions: [...input.assumptions],
    updatedAt: input.expectedProposalRevision + 1,
  }));
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => standardProject(),
      getWorkspace: async () => workspacePayload(),
      listWorkspaceProposals: async () => [draftProposal()],
      updateWorkspaceProposal,
    })}>
      <DuplicateRevertProbe />
    </ApiProvider>,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Revert the same change twice" }));
  await waitFor(() => expect(updateWorkspaceProposal).toHaveBeenCalled());
  await act(async () => { await Promise.resolve(); });
  expect(updateWorkspaceProposal).toHaveBeenCalledTimes(1);
});

test("edit revision conflict loads the latest draft once, blocks approval, and never replays the patch", async () => {
  const latest = draftProposal({ revision: 2, rationale: "Changed in another review", updatedAt: 2 });
  const updateWorkspaceProposal = vi.fn(async () => {
    throw new ApiError(409, "Proposal revision changed", {
      code: "workspace_proposal_revision_conflict",
      proposalId: "proposal-1",
      expectedProposalRevision: 1,
      actualProposalRevision: 2,
    });
  });
  const getWorkspaceProposal = vi.fn(async () => latest);
  const approveWorkspaceProposal = vi.fn();
  renderStudio({ updateWorkspaceProposal, getWorkspaceProposal, approveWorkspaceProposal });

  await screen.findByRole("region", { name: "Project canvas" });
  const rationale = await screen.findByRole("textbox", { name: "Proposal rationale" });
  fireEvent.change(rationale, { target: { value: "My stale edit" } });
  fireEvent.blur(rationale);

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Proposal changed while you were reviewing it");
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Proposal rationale" })).toHaveValue("Changed in another review"));
  expect(screen.getByRole("button", { name: "Approve and generate" })).toBeDisabled();
  expect(updateWorkspaceProposal).toHaveBeenCalledTimes(1);
  expect(getWorkspaceProposal).toHaveBeenCalledTimes(1);
  expect(approveWorkspaceProposal).not.toHaveBeenCalled();
});

test("a Proposal CAS conflict invalidates already queued edits and a waiting approval", async () => {
  const latest = draftProposal({ revision: 2, rationale: "Changed elsewhere", updatedAt: 2 });
  const updateWorkspaceProposal = vi.fn()
    .mockRejectedValueOnce(new ApiError(409, "Proposal revision changed", {
      code: "workspace_proposal_revision_conflict",
      proposalId: "proposal-1",
      expectedProposalRevision: 1,
      actualProposalRevision: 2,
    }))
    .mockResolvedValue(latest);
  const getWorkspaceProposal = vi.fn(async () => latest);
  const approveWorkspaceProposal = vi.fn();
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => standardProject(),
      getWorkspace: async () => workspacePayload(),
      listWorkspaceProposals: async () => [draftProposal()],
      updateWorkspaceProposal,
      getWorkspaceProposal,
      approveWorkspaceProposal,
    })}>
      <ProposalStudioProbe />
    </ApiProvider>,
  );

  await screen.findByTestId("proposal-status");
  fireEvent.click(screen.getByRole("button", { name: "Queue edit" }));
  fireEvent.click(screen.getByRole("button", { name: "Queue edit" }));
  fireEvent.click(screen.getByRole("button", { name: "Approve now" }));

  await waitFor(() => expect(screen.getByTestId("proposal-status")).toHaveTextContent("validation-error"));
  expect(updateWorkspaceProposal).toHaveBeenCalledTimes(1);
  expect(getWorkspaceProposal).toHaveBeenCalledTimes(1);
  expect(approveWorkspaceProposal).not.toHaveBeenCalled();
});

test("an already-satisfied queued edit does not consume another Proposal revision", async () => {
  let resolveFirst!: (proposal: WorkspaceProposal) => void;
  const firstSave = new Promise<WorkspaceProposal>((resolve) => { resolveFirst = resolve; });
  const updateWorkspaceProposal = vi.fn()
    .mockReturnValueOnce(firstSave)
    .mockResolvedValue(draftProposal({ revision: 3, rationale: "Latest rationale", updatedAt: 3 }));
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => standardProject(),
      getWorkspace: async () => workspacePayload(),
      listWorkspaceProposals: async () => [draftProposal()],
      updateWorkspaceProposal,
    })}>
      <ProposalStudioProbe />
    </ApiProvider>,
  );

  await screen.findByTestId("proposal-status");
  fireEvent.click(screen.getByRole("button", { name: "Queue edit" }));
  fireEvent.click(screen.getByRole("button", { name: "Queue edit" }));
  await waitFor(() => expect(updateWorkspaceProposal).toHaveBeenCalledTimes(1));
  await act(async () => {
    resolveFirst(draftProposal({ revision: 2, rationale: "Latest rationale", updatedAt: 2 }));
  });
  await waitFor(() => expect(screen.getByTestId("proposal-status")).toHaveTextContent("draft"));
  await act(async () => { await Promise.resolve(); });

  expect(updateWorkspaceProposal).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("proposal-pointers")).toHaveTextContent("7:snapshot-7:layout-7");
});

test("edit state conflict loads and maps the authoritative terminal Proposal", async () => {
  const approved = draftProposal({
    revision: 2,
    status: "approved",
    review: { kind: "approved", mode: "structure-only" },
    updatedAt: 2,
  });
  const updateWorkspaceProposal = vi.fn(async () => {
    throw new ApiError(409, "Proposal is already approved", {
      code: "workspace_proposal_state_conflict",
      proposalId: "proposal-1",
      status: "approved",
    });
  });
  const getWorkspaceProposal = vi.fn(async () => approved);
  renderStudio({ updateWorkspaceProposal, getWorkspaceProposal });

  await screen.findByRole("region", { name: "Project canvas" });
  const rationale = await screen.findByRole("textbox", { name: "Proposal rationale" });
  fireEvent.change(rationale, { target: { value: "Late edit" } });
  fireEvent.blur(rationale);

  expect(await screen.findByRole("heading", { name: "Proposal approved" })).toBeInTheDocument();
  expect(updateWorkspaceProposal).toHaveBeenCalledTimes(1);
  expect(getWorkspaceProposal).toHaveBeenCalledTimes(1);
});

test("a failed Proposal list never destroys a ready Standard canvas", async () => {
  const listWorkspaceProposals = vi.fn(async () => {
    throw new Error("proposal index unavailable");
  });
  renderStudio({ listWorkspaceProposals });

  expect(await screen.findByRole("region", { name: "Project canvas" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Proposal unavailable" })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Proposal review" })).toHaveTextContent("proposal index unavailable");
  expect(listWorkspaceProposals).toHaveBeenCalledTimes(1);
});

test("canonical layout persistence recomputes the active Proposal diff against its new checksum", async () => {
  const saveWorkspaceLayout = vi.fn(async (_projectId: string, _input: WorkspaceLayoutPatch) => ({
    ...baseLayout,
    viewport: { x: 10, y: 0, zoom: 1 },
    checksum: "layout-8",
  }));
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => standardProject(),
      getWorkspace: async () => workspacePayload(),
      listWorkspaceProposals: async () => [draftProposal()],
      saveWorkspaceLayout,
    })}>
      <ProposalStudioProbe />
    </ApiProvider>,
  );

  expect(await screen.findByTestId("proposal-stale")).toHaveTextContent("false");
  fireEvent.click(screen.getByRole("button", { name: "Save after approval" }));
  await waitFor(() => expect(screen.getByTestId("proposal-stale")).toHaveTextContent("true"));
  expect(saveWorkspaceLayout.mock.calls[0]?.[1]).toMatchObject({
    graphRevision: 7,
    baseLayoutChecksum: "layout-7",
  });
});

test("reviewing a Proposal item from an Artifact route preserves focus intent and returns to the canvas", async () => {
  window.history.pushState({}, "", "/projects/project-1/artifacts/artifact-home");
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => standardProject(),
      getWorkspace: async () => workspacePayload(),
      listWorkspaceProposals: async () => [draftProposal()],
    })}>
      <ProjectStudioScreen
        projectId="project-1"
        artifactId="artifact-home"
        legacyFallback={() => null}
        onOpenSettings={() => {}}
      />
    </ApiProvider>,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Review added page Checkout" }));
  expect(window.location.pathname).toBe("/projects/project-1/canvas");
});

test("same-project Canvas to Artifact navigation retains the authoritative Proposal revision and review text", async () => {
  const listWorkspaceProposals = vi.fn(async () => [draftProposal()]);
  const updateWorkspaceProposal = vi.fn(async (_projectId, _proposalId, input) => draftProposal({
    revision: input.expectedProposalRevision + 1,
    operations: [...input.operations],
    layoutOperations: [...input.layoutOperations],
    generation: input.generation,
    rationale: input.rationale,
    assumptions: [...input.assumptions],
  }));
  const client = makeFakeApi({
    getProject: async () => standardProject(),
    getWorkspace: async () => workspacePayload(),
    listWorkspaceProposals,
    updateWorkspaceProposal,
  });
  const { rerender } = render(
    <ApiProvider client={client}>
      <ProjectStudioScreen projectId="project-1" artifactId={null} legacyFallback={() => null} onOpenSettings={() => {}} />
    </ApiProvider>,
  );

  await screen.findByRole("region", { name: "Project canvas" });
  const rationale = await screen.findByRole("textbox", { name: "Proposal rationale" });
  fireEvent.change(rationale, { target: { value: "Reviewed checkout rationale" } });
  fireEvent.blur(rationale);
  await waitFor(() => expect(screen.getByText("r2")).toBeInTheDocument());

  rerender(
    <ApiProvider client={client}>
      <ProjectStudioScreen projectId="project-1" artifactId="artifact-home" legacyFallback={() => null} onOpenSettings={() => {}} />
    </ApiProvider>,
  );
  expect(screen.getByRole("textbox", { name: "Proposal rationale" })).toHaveValue("Reviewed checkout rationale");
  expect(screen.getByText("r2")).toBeInTheDocument();
  expect(listWorkspaceProposals).toHaveBeenCalledTimes(1);
});

test("body-persisted approval conflict remains read-only when current workspace refresh fails", async () => {
  const conflict = {
    expectedGraphRevision: 7,
    actualGraphRevision: 8,
    expectedSnapshotId: "snapshot-7",
    actualSnapshotId: "snapshot-8",
    expectedLayoutChecksum: "layout-7",
    actualLayoutChecksum: "layout-8",
    graphChanged: true,
    snapshotChanged: true,
    layoutChanged: true,
  };
  const persisted = draftProposal({
    revision: 2,
    status: "conflicted",
    review: { kind: "conflict", ...conflict },
  });
  const getWorkspace = vi.fn()
    .mockResolvedValueOnce(workspacePayload())
    .mockRejectedValueOnce(new Error("workspace refresh unavailable"));
  const getWorkspaceProposal = vi.fn();
  const approveWorkspaceProposal = vi.fn(async () => {
    throw new ApiError(409, "Proposal base is stale", {
      code: "workspace_revision_conflict",
      proposal: persisted,
      summary: conflict,
    });
  });
  renderStudio({ getWorkspace, getWorkspaceProposal, approveWorkspaceProposal });

  fireEvent.click(await screen.findByRole("button", { name: "Approve and generate" }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Proposal base changed");
  expect(screen.getByRole("textbox", { name: "Proposal rationale" })).toHaveAttribute("readonly");
  expect(getWorkspaceProposal).not.toHaveBeenCalled();
  expect(approveWorkspaceProposal).toHaveBeenCalledTimes(1);
});

test("edit validation failure blocks approval until a later edit saves successfully", async () => {
  const updateWorkspaceProposal = vi.fn()
    .mockRejectedValueOnce(new ApiError(422, "Duplicate page name", {
      code: "workspace_proposal_validation_error",
      error: "Rename the duplicate page before approval.",
      details: {},
    }))
    .mockImplementationOnce(async (_projectId, _proposalId, input) => draftProposal({
      revision: 2,
      rationale: input.rationale,
    }));
  const approveWorkspaceProposal = vi.fn();
  renderStudio({ updateWorkspaceProposal, approveWorkspaceProposal });

  await screen.findByRole("region", { name: "Project canvas" });
  const rationale = await screen.findByRole("textbox", { name: "Proposal rationale" });
  await act(async () => {
    fireEvent.change(rationale, { target: { value: "Invalid edit" } });
    expect(rationale).toHaveValue("Invalid edit");
    fireEvent.blur(rationale);
  });

  await waitFor(() => expect(updateWorkspaceProposal).toHaveBeenCalledTimes(1));
  expect(await screen.findByRole("alert")).toHaveTextContent("Rename the duplicate page before approval.");
  const approve = screen.getByRole("button", { name: "Approve and generate" });
  expect(approve).toBeDisabled();
  fireEvent.click(approve);
  expect(approveWorkspaceProposal).not.toHaveBeenCalled();

  await act(async () => {
    fireEvent.change(rationale, { target: { value: "Valid edit" } });
    expect(rationale).toHaveValue("Valid edit");
    fireEvent.blur(rationale);
  });

  await waitFor(() => expect(updateWorkspaceProposal).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByText("r2")).toBeInTheDocument());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(approve).toBeEnabled();
});

test("approval state conflict fetches the authoritative terminal Proposal without retry", async () => {
  const approved = draftProposal({
    revision: 2,
    status: "approved",
    review: { kind: "approved", mode: "generate" },
  });
  const approveWorkspaceProposal = vi.fn(async () => {
    throw new ApiError(409, "Proposal is already approved", {
      code: "workspace_proposal_state_conflict",
      proposalId: "proposal-1",
      status: "approved",
    });
  });
  const getWorkspaceProposal = vi.fn(async () => approved);
  const getWorkspace = vi.fn()
    .mockResolvedValueOnce(workspacePayload())
    .mockResolvedValueOnce(workspacePayload(8));
  renderStudio({ approveWorkspaceProposal, getWorkspaceProposal, getWorkspace });

  fireEvent.click(await screen.findByRole("button", { name: "Approve and generate" }));
  expect(await screen.findByRole("heading", { name: "Proposal approved" })).toBeInTheDocument();
  expect(approveWorkspaceProposal).toHaveBeenCalledTimes(1);
  expect(getWorkspaceProposal).toHaveBeenCalledTimes(1);
  expect(getWorkspace).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText("2 objects at 100 percent zoom")).toBeInTheDocument();
});

test("direct project switching resets all project-owned state and ignores a late old-project edit rejection", async () => {
  let rejectOldEdit!: (error: unknown) => void;
  const updateWorkspaceProposal = vi.fn(() => new Promise<WorkspaceProposal>((_resolve, reject) => {
    rejectOldEdit = reject;
  }));
  const getProject = vi.fn(async (id: string) => standardProject(id));
  const getWorkspace = vi.fn(async (id: string) => {
    const payload = workspacePayload();
    return {
      ...payload,
      workspace: { ...payload.workspace, projectId: id },
    };
  });
  const listWorkspaceProposals = vi.fn(async (id: string) => id === "project-1" ? [draftProposal()] : []);
  const client = makeFakeApi({ getProject, getWorkspace, listWorkspaceProposals, updateWorkspaceProposal });
  const { rerender } = render(
    <ApiProvider client={client}>
      <SwitchingStudioProbe projectId="project-1" />
    </ApiProvider>,
  );

  await screen.findByRole("button", { name: "Seed project state" });
  fireEvent.change(screen.getByRole("textbox", { name: "Switching Agent draft" }), { target: { value: "P1 draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Seed project state" }));
  fireEvent.click(screen.getByRole("button", { name: "Start delayed edit" }));
  await waitFor(() => expect(updateWorkspaceProposal).toHaveBeenCalledTimes(1));

  rerender(
    <ApiProvider client={client}>
      <SwitchingStudioProbe projectId="project-2" />
    </ApiProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("switch-project")).toHaveTextContent("project-2"));
  await act(async () => {
    rejectOldEdit(new ApiError(422, "Late P1 validation", {
      code: "workspace_proposal_validation_error",
      error: "Late P1 validation",
      details: {},
    }));
    await Promise.resolve();
  });

  await waitFor(() => expect(screen.getByTestId("switch-review")).toHaveTextContent("idle"));
  expect(screen.getByRole("textbox", { name: "Switching Agent draft" })).toHaveValue("");
  expect(screen.getByTestId("switch-selection")).toHaveTextContent("0");
  expect(screen.getByTestId("switch-viewport")).toHaveTextContent("0");
  expect(screen.getByTestId("switch-tasks")).toHaveTextContent("0");
});

test("a late terminal Workspace refresh cannot overwrite the newly selected project", async () => {
  let resolveOldWorkspace!: (workspace: ReadyProjectWorkspacePayload) => void;
  const oldWorkspaceRefresh = new Promise<ReadyProjectWorkspacePayload>((resolve) => {
    resolveOldWorkspace = resolve;
  });
  let projectOneReads = 0;
  const getWorkspace = vi.fn(async (id: string) => {
    const payload = workspacePayload();
    if (id === "project-1") {
      projectOneReads += 1;
      if (projectOneReads > 1) return oldWorkspaceRefresh;
      return payload;
    }
    return {
      ...payload,
      workspace: { ...payload.workspace, projectId: id },
    };
  });
  const approved = draftProposal({
    revision: 2,
    status: "approved",
    review: { kind: "approved", mode: "generate" },
  });
  const client = makeFakeApi({
    getProject: async (id) => standardProject(id),
    getWorkspace,
    listWorkspaceProposals: async (id) => id === "project-1" ? [draftProposal()] : [],
    approveWorkspaceProposal: async () => {
      throw new ApiError(409, "Proposal is already approved", {
        code: "workspace_proposal_state_conflict",
        proposalId: "proposal-1",
        status: "approved",
      });
    },
    getWorkspaceProposal: async () => approved,
  });
  const rendered = render(
    <ApiProvider client={client}>
      <SwitchingStudioProbe projectId="project-1" />
    </ApiProvider>,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Start approval" }));
  await waitFor(() => expect(projectOneReads).toBe(2));
  rendered.rerender(
    <ApiProvider client={client}>
      <SwitchingStudioProbe projectId="project-2" />
    </ApiProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("switch-project")).toHaveTextContent("project-2"));

  await act(async () => {
    resolveOldWorkspace(workspacePayload(8));
    await oldWorkspaceRefresh;
  });

  await waitFor(() => expect(screen.getByTestId("switch-review")).toHaveTextContent("idle"));
  expect(screen.getByTestId("switch-project")).toHaveTextContent("project-2");
});

test("a queued approval cannot cross projects after waiting behind a canonical mutation", async () => {
  let resolveLayout!: (layout: WorkspaceLayout) => void;
  const pendingLayout = new Promise<WorkspaceLayout>((resolve) => { resolveLayout = resolve; });
  const saveWorkspaceLayout = vi.fn(() => pendingLayout);
  const approveWorkspaceProposal = vi.fn();
  const getWorkspace = vi.fn(async (id: string) => {
    const payload = workspacePayload();
    return id === "project-1" ? payload : {
      ...payload,
      workspace: { ...payload.workspace, projectId: id },
    };
  });
  const client = makeFakeApi({
    getProject: async (id) => standardProject(id),
    getWorkspace,
    listWorkspaceProposals: async (id) => [draftProposal({ id: id === "project-1" ? "proposal-1" : "proposal-2" })],
    saveWorkspaceLayout,
    approveWorkspaceProposal,
  });
  const rendered = render(
    <ApiProvider client={client}>
      <SwitchingStudioProbe projectId="project-1" />
    </ApiProvider>,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Block mutation then approve" }));
  await waitFor(() => expect(saveWorkspaceLayout).toHaveBeenCalledTimes(1));
  rendered.rerender(
    <ApiProvider client={client}>
      <SwitchingStudioProbe projectId="project-2" />
    </ApiProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("switch-project")).toHaveTextContent("project-2"));
  expect(screen.getByTestId("switch-review")).toHaveTextContent("draft");

  await act(async () => {
    resolveLayout({ ...workspacePayload().layout, checksum: "old-project-layout" });
    await pendingLayout;
  });
  await act(async () => { await Promise.resolve(); });

  expect(approveWorkspaceProposal).not.toHaveBeenCalled();
  expect(screen.getByTestId("switch-project")).toHaveTextContent("project-2");
  expect(screen.getByTestId("switch-review")).toHaveTextContent("draft");
});

test("a terminal Proposal refresh cannot regress a newer same-project layout save", async () => {
  let resolveTerminalRefresh!: (workspace: ReadyProjectWorkspacePayload) => void;
  const terminalRefresh = new Promise<ReadyProjectWorkspacePayload>((resolve) => {
    resolveTerminalRefresh = resolve;
  });
  const getWorkspace = vi.fn()
    .mockResolvedValueOnce(workspacePayload())
    .mockReturnValueOnce(terminalRefresh);
  const approved = draftProposal({
    revision: 2,
    status: "approved",
    review: { kind: "approved", mode: "generate" },
  });
  const saveWorkspaceLayout = vi.fn(async () => ({
    ...workspacePayload().layout,
    viewport: { x: 10, y: 0, zoom: 1 },
    checksum: "layout-newer",
  }));
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => standardProject(),
      getWorkspace,
      listWorkspaceProposals: async () => [draftProposal()],
      updateWorkspaceProposal: async () => {
        throw new ApiError(409, "Proposal is already approved", {
          code: "workspace_proposal_state_conflict",
          proposalId: "proposal-1",
          status: "approved",
        });
      },
      getWorkspaceProposal: async () => approved,
      saveWorkspaceLayout,
    })}>
      <ProposalStudioProbe />
    </ApiProvider>,
  );

  await screen.findByTestId("proposal-pointers");
  fireEvent.click(screen.getByRole("button", { name: "Queue edit" }));
  await waitFor(() => expect(getWorkspace).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "Save after approval" }));
  await waitFor(() => expect(screen.getByTestId("proposal-pointers")).toHaveTextContent("7:snapshot-7:layout-newer"));

  await act(async () => {
    resolveTerminalRefresh(workspacePayload());
    await terminalRefresh;
  });

  await waitFor(() => expect(screen.getByTestId("proposal-status")).toHaveTextContent("approved"));
  expect(screen.getByTestId("proposal-pointers")).toHaveTextContent("7:snapshot-7:layout-newer");
});

test("an authoritative rationale save does not clobber a dirty assumptions field", async () => {
  const proposal = draftProposal();
  const diff = buildProposalDiff(proposal, {
    graph: baseGraph,
    activeSnapshotId: "snapshot-7",
    layoutChecksum: "layout-7",
  });
  const onEdit = vi.fn(async () => proposal);
  const callbacks = {
    focusedChangeKey: null,
    onEdit,
    onRevert: async () => proposal,
    onFocusItem: () => {},
    onApprove: async () => {},
    onReject: async () => {},
    onClose: () => {},
  };
  const rendered = render(
    <ProposalReviewPanel review={{ status: "draft", proposal, diff }} {...callbacks} />,
  );

  const assumptions = screen.getByRole("textbox", { name: "Proposal assumptions" });
  fireEvent.change(assumptions, { target: { value: "Keep this unsaved assumption" } });
  const rationale = screen.getByRole("textbox", { name: "Proposal rationale" });
  fireEvent.change(rationale, { target: { value: "Saved rationale" } });
  fireEvent.blur(rationale);
  await waitFor(() => expect(onEdit).toHaveBeenCalledWith({ rationale: "Saved rationale" }));

  const saved = draftProposal({
    revision: 2,
    rationale: "Saved rationale",
    assumptions: proposal.assumptions,
    updatedAt: 2,
  });
  rendered.rerender(
    <ProposalReviewPanel
      review={{
        status: "draft",
        proposal: saved,
        diff: buildProposalDiff(saved, {
          graph: baseGraph,
          activeSnapshotId: "snapshot-7",
          layoutChecksum: "layout-7",
        }),
      }}
      {...callbacks}
    />,
  );

  await waitFor(() => expect(screen.getByRole("textbox", { name: "Proposal assumptions" }))
    .toHaveValue("Keep this unsaved assumption"));
});

test("an in-flight rationale response preserves focused dirty assumptions that have not blurred", async () => {
  const user = userEvent.setup();
  let resolveRationale!: (proposal: WorkspaceProposal) => void;
  const updateWorkspaceProposal = vi.fn(() => new Promise<WorkspaceProposal>((resolve) => {
    resolveRationale = resolve;
  }));
  renderStudio({ updateWorkspaceProposal });

  await screen.findByRole("region", { name: "Project canvas" });
  const rationale = screen.getByRole("textbox", { name: "Proposal rationale" });
  const assumptions = screen.getByRole("textbox", { name: "Proposal assumptions" });
  await user.clear(rationale);
  await user.type(rationale, "QA rationale preserved");
  await user.click(assumptions);
  await waitFor(() => expect(updateWorkspaceProposal).toHaveBeenCalledTimes(1));
  expect(assumptions).not.toHaveAttribute("readonly");
  expect(document.activeElement).toBe(assumptions);
  await user.clear(assumptions);
  await user.type(assumptions, "First assumption{enter}Second assumption");

  await act(async () => {
    resolveRationale(draftProposal({
      revision: 2,
      rationale: "QA rationale preserved",
      assumptions: draftProposal().assumptions,
      updatedAt: 2,
    }));
  });

  await waitFor(() => expect(screen.getByText("r2")).toBeInTheDocument());
  expect(updateWorkspaceProposal).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(assumptions);
  expect(screen.getByRole("textbox", { name: "Proposal rationale" })).toHaveValue("QA rationale preserved");
  expect(screen.getByRole("textbox", { name: "Proposal assumptions" }))
    .toHaveValue("First assumption\nSecond assumption");
});

test("a second field blur queues behind an in-flight rationale save without losing either edit", async () => {
  let resolveFirst!: (proposal: WorkspaceProposal) => void;
  const firstSave = new Promise<WorkspaceProposal>((resolve) => { resolveFirst = resolve; });
  const updateWorkspaceProposal = vi.fn((_projectId, _proposalId, input) => {
    if (input.expectedProposalRevision === 1) return firstSave;
    return Promise.resolve(draftProposal({
      revision: input.expectedProposalRevision + 1,
      operations: [...input.operations],
      layoutOperations: [...input.layoutOperations],
      generation: input.generation,
      rationale: input.rationale,
      assumptions: [...input.assumptions],
      updatedAt: input.expectedProposalRevision + 1,
    }));
  });
  renderStudio({ updateWorkspaceProposal });

  await screen.findByRole("region", { name: "Project canvas" });
  const rationale = screen.getByRole("textbox", { name: "Proposal rationale" });
  const assumptions = screen.getByRole("textbox", { name: "Proposal assumptions" });
  fireEvent.change(rationale, { target: { value: "QA rationale preserved" } });
  fireEvent.blur(rationale);
  fireEvent.change(assumptions, { target: { value: "First assumption\nSecond assumption" } });
  await waitFor(() => expect(updateWorkspaceProposal).toHaveBeenCalledTimes(1));

  fireEvent.blur(assumptions);
  expect(updateWorkspaceProposal).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolveFirst(draftProposal({
      revision: 2,
      rationale: "QA rationale preserved",
      assumptions: draftProposal().assumptions,
      updatedAt: 2,
    }));
  });

  await waitFor(() => expect(updateWorkspaceProposal).toHaveBeenCalledTimes(2));
  expect(updateWorkspaceProposal.mock.calls[1]?.[2]).toMatchObject({
    expectedProposalRevision: 2,
    rationale: "QA rationale preserved",
    assumptions: ["First assumption", "Second assumption"],
  });
  await waitFor(() => expect(screen.getByText("r3")).toBeInTheDocument());
  expect(screen.getByRole("textbox", { name: "Proposal rationale" })).toHaveValue("QA rationale preserved");
  expect(screen.getByRole("textbox", { name: "Proposal assumptions" }))
    .toHaveValue("First assumption\nSecond assumption");
});

test("a queued field keeps its local value when its save is rejected after another revision advances", async () => {
  let resolveFirst!: (proposal: WorkspaceProposal) => void;
  const firstSave = new Promise<WorkspaceProposal>((resolve) => { resolveFirst = resolve; });
  const updateWorkspaceProposal = vi.fn((_projectId, _proposalId, input) => {
    if (input.expectedProposalRevision === 1) return firstSave;
    return Promise.reject(new ApiError(422, "Assumptions need attention", {
      code: "workspace_proposal_validation_error",
      error: "Revise the assumptions before approval.",
      details: {},
    }));
  });
  renderStudio({ updateWorkspaceProposal });

  await screen.findByRole("region", { name: "Project canvas" });
  const rationale = screen.getByRole("textbox", { name: "Proposal rationale" });
  const assumptions = screen.getByRole("textbox", { name: "Proposal assumptions" });
  fireEvent.change(rationale, { target: { value: "Saved first" } });
  fireEvent.blur(rationale);
  fireEvent.change(assumptions, { target: { value: "Keep local after 422" } });
  await waitFor(() => expect(updateWorkspaceProposal).toHaveBeenCalledTimes(1));
  fireEvent.blur(assumptions);
  await act(async () => {
    resolveFirst(draftProposal({ revision: 2, rationale: "Saved first", updatedAt: 2 }));
  });

  expect(await screen.findByRole("alert")).toHaveTextContent("Revise the assumptions before approval.");
  expect(updateWorkspaceProposal).toHaveBeenCalledTimes(2);
  expect(screen.getByText("r2")).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Proposal assumptions" })).toHaveValue("Keep local after 422");
});

test("an unrelated successful edit cannot clear a rejected dirty field or unblock approval", async () => {
  const updateWorkspaceProposal = vi.fn()
    .mockRejectedValueOnce(new ApiError(422, "Assumptions need attention", {
      code: "workspace_proposal_validation_error",
      error: "Revise the assumptions before approval.",
      details: {},
    }))
    .mockImplementation(async (_projectId, _proposalId, input) => draftProposal({
      revision: input.expectedProposalRevision + 1,
      operations: [...input.operations],
      layoutOperations: [...input.layoutOperations],
      generation: input.generation,
      rationale: input.rationale,
      assumptions: [...input.assumptions],
      updatedAt: input.expectedProposalRevision + 1,
    }));
  const approveWorkspaceProposal = vi.fn();
  renderStudio({ updateWorkspaceProposal, approveWorkspaceProposal });

  await screen.findByRole("region", { name: "Project canvas" });
  const assumptions = screen.getByRole("textbox", { name: "Proposal assumptions" });
  fireEvent.change(assumptions, { target: { value: "Rejected local assumption" } });
  fireEvent.blur(assumptions);
  expect(await screen.findByRole("alert")).toHaveTextContent("Revise the assumptions before approval.");

  const rationale = screen.getByRole("textbox", { name: "Proposal rationale" });
  fireEvent.change(rationale, { target: { value: "Unrelated valid rationale" } });
  fireEvent.blur(rationale);
  await waitFor(() => expect(updateWorkspaceProposal).toHaveBeenCalledTimes(2));

  expect(screen.getByRole("alert")).toHaveTextContent("Revise the assumptions before approval.");
  expect(screen.getByRole("textbox", { name: "Proposal assumptions" })).toHaveValue("Rejected local assumption");
  const approve = screen.getByRole("button", { name: "Approve and generate" });
  expect(approve).toBeDisabled();
  fireEvent.click(approve);
  expect(approveWorkspaceProposal).not.toHaveBeenCalled();
});

test("reverting a rejected field to its authoritative value clears the local validation without a no-op PATCH", async () => {
  const updateWorkspaceProposal = vi.fn(async () => {
    throw new ApiError(422, "Assumptions need attention", {
      code: "workspace_proposal_validation_error",
      error: "Revise the assumptions before approval.",
      details: {},
    });
  });
  renderStudio({ updateWorkspaceProposal });

  await screen.findByRole("region", { name: "Project canvas" });
  const assumptions = screen.getByRole("textbox", { name: "Proposal assumptions" });
  fireEvent.change(assumptions, { target: { value: "Rejected local assumption" } });
  fireEvent.blur(assumptions);
  expect(await screen.findByRole("alert")).toHaveTextContent("Revise the assumptions before approval.");

  fireEvent.change(assumptions, { target: { value: "Existing cart state is reusable" } });
  fireEvent.blur(assumptions);

  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(updateWorkspaceProposal).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Approve and generate" })).toBeEnabled();
});

test("reverting a rejected inline name clears operations validation without a no-op PATCH", async () => {
  const updateWorkspaceProposal = vi.fn(async () => {
    throw new ApiError(422, "Duplicate page name", {
      code: "workspace_proposal_validation_error",
      error: "Rename the duplicate page before approval.",
      details: {},
    });
  });
  renderStudio({ updateWorkspaceProposal });

  await screen.findByRole("region", { name: "Project canvas" });
  const name = screen.getByRole("textbox", { name: "Proposal name for Checkout" });
  fireEvent.change(name, { target: { value: "Duplicate checkout" } });
  fireEvent.blur(name);
  expect(await screen.findByRole("alert")).toHaveTextContent("Rename the duplicate page before approval.");

  fireEvent.change(name, { target: { value: "Checkout" } });
  fireEvent.blur(name);

  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(updateWorkspaceProposal).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Approve and generate" })).toBeEnabled();
});

test("blurring an unrelated inline name cannot clear another name's rejected validation", async () => {
  const proposal = draftProposal({
    operations: [
      ...draftProposal().operations,
      {
        id: "command-add-receipt",
        type: "add-node",
        node: { id: "page-receipt", kind: "page", name: "Receipt", artifactId: "artifact-receipt" },
      },
    ],
  });
  const updateWorkspaceProposal = vi.fn(async () => {
    throw new ApiError(422, "Duplicate page name", {
      code: "workspace_proposal_validation_error",
      error: "Rename the duplicate page before approval.",
      details: {},
    });
  });
  renderStudio({
    listWorkspaceProposals: async () => [proposal],
    updateWorkspaceProposal,
  });

  await screen.findByRole("region", { name: "Project canvas" });
  const checkout = screen.getByRole("textbox", { name: "Proposal name for Checkout" });
  fireEvent.change(checkout, { target: { value: "Duplicate checkout" } });
  fireEvent.blur(checkout);
  expect(await screen.findByRole("alert")).toHaveTextContent("Rename the duplicate page before approval.");

  fireEvent.blur(screen.getByRole("textbox", { name: "Proposal name for Receipt" }));
  await act(async () => { await Promise.resolve(); });

  expect(updateWorkspaceProposal).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("alert")).toHaveTextContent("Rename the duplicate page before approval.");
  expect(checkout).toHaveValue("Duplicate checkout");
  expect(screen.getByRole("button", { name: "Approve and generate" })).toBeDisabled();
});

test("saving an unrelated inline name cannot clear another name's rejected validation", async () => {
  const proposal = draftProposal({
    operations: [
      ...draftProposal().operations,
      {
        id: "command-add-receipt",
        type: "add-node",
        node: { id: "page-receipt", kind: "page", name: "Receipt", artifactId: "artifact-receipt" },
      },
    ],
  });
  const updateWorkspaceProposal = vi.fn()
    .mockRejectedValueOnce(new ApiError(422, "Duplicate page name", {
      code: "workspace_proposal_validation_error",
      error: "Rename the duplicate page before approval.",
      details: {},
    }))
    .mockImplementationOnce(async (_projectId, _proposalId, input) => draftProposal({
      ...proposal,
      revision: 2,
      operations: [...input.operations],
      updatedAt: 2,
    }));
  renderStudio({
    listWorkspaceProposals: async () => [proposal],
    updateWorkspaceProposal,
  });

  await screen.findByRole("region", { name: "Project canvas" });
  const checkout = screen.getByRole("textbox", { name: "Proposal name for Checkout" });
  fireEvent.change(checkout, { target: { value: "Duplicate checkout" } });
  fireEvent.blur(checkout);
  expect(await screen.findByRole("alert")).toHaveTextContent("Rename the duplicate page before approval.");

  const receipt = screen.getByRole("textbox", { name: "Proposal name for Receipt" });
  fireEvent.change(receipt, { target: { value: "Receipt route" } });
  fireEvent.blur(receipt);
  await waitFor(() => expect(updateWorkspaceProposal).toHaveBeenCalledTimes(2));

  expect(screen.getByRole("alert")).toHaveTextContent("Rename the duplicate page before approval.");
  expect(checkout).toHaveValue("Duplicate checkout");
  expect(screen.getByRole("textbox", { name: "Proposal name for Receipt route" })).toHaveValue("Receipt route");
  expect(screen.getByRole("button", { name: "Approve and generate" })).toBeDisabled();
});

test("a reject revision conflict preserves the rejected dirty field and keeps approval blocked", async () => {
  const latest = draftProposal({ revision: 2, updatedAt: 2 });
  const updateWorkspaceProposal = vi.fn(async () => {
    throw new ApiError(422, "Assumptions need attention", {
      code: "workspace_proposal_validation_error",
      error: "Revise the assumptions before approval.",
      details: {},
    });
  });
  const rejectWorkspaceProposal = vi.fn(async () => {
    throw new ApiError(409, "Proposal revision changed", {
      code: "workspace_proposal_revision_conflict",
      proposalId: "proposal-1",
      expectedProposalRevision: 1,
      actualProposalRevision: 2,
    });
  });
  const getWorkspaceProposal = vi.fn(async () => latest);
  const approveWorkspaceProposal = vi.fn();
  renderStudio({
    updateWorkspaceProposal,
    rejectWorkspaceProposal,
    getWorkspaceProposal,
    approveWorkspaceProposal,
  });

  await screen.findByRole("region", { name: "Project canvas" });
  const assumptions = screen.getByRole("textbox", { name: "Proposal assumptions" });
  fireEvent.change(assumptions, { target: { value: "Rejected local assumption" } });
  fireEvent.blur(assumptions);
  expect(await screen.findByRole("alert")).toHaveTextContent("Revise the assumptions before approval.");

  fireEvent.click(screen.getByRole("button", { name: "Reject proposal" }));

  await waitFor(() => expect(getWorkspaceProposal).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("alert")).toHaveTextContent("Revise the assumptions before approval.");
  expect(screen.getByRole("textbox", { name: "Proposal assumptions" })).toHaveValue("Rejected local assumption");
  const approve = screen.getByRole("button", { name: "Approve and generate" });
  expect(approve).toBeDisabled();
  fireEvent.click(approve);
  expect(rejectWorkspaceProposal).toHaveBeenCalledTimes(1);
  expect(approveWorkspaceProposal).not.toHaveBeenCalled();
});

test("a duplicate-name approval error can be repaired through the inline node name", async () => {
  const updateWorkspaceProposal = vi.fn(async (_projectId, _proposalId, input) => draftProposal({
    revision: input.expectedProposalRevision + 1,
    operations: [...input.operations],
    layoutOperations: [...input.layoutOperations],
    generation: input.generation,
    rationale: input.rationale,
    assumptions: [...input.assumptions],
    updatedAt: input.expectedProposalRevision + 1,
  }));
  const approveWorkspaceProposal = vi.fn()
    .mockRejectedValueOnce(new ApiError(422, "Duplicate page name", {
      code: "workspace_proposal_validation_error",
      error: "Rename the duplicate page before approval.",
      details: {},
    }))
    .mockResolvedValueOnce(approvedResult("generate"));
  const getWorkspace = vi.fn()
    .mockResolvedValueOnce(workspacePayload())
    .mockResolvedValueOnce(workspacePayload(8));
  renderStudio({ updateWorkspaceProposal, approveWorkspaceProposal, getWorkspace });

  fireEvent.click(await screen.findByRole("button", { name: "Approve and generate" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Rename the duplicate page before approval.");

  const name = screen.getByRole("textbox", { name: "Proposal name for Checkout" });
  fireEvent.change(name, { target: { value: "Checkout route" } });
  fireEvent.blur(name);
  await waitFor(() => expect(updateWorkspaceProposal).toHaveBeenCalledTimes(1));
  expect(updateWorkspaceProposal.mock.calls[0]?.[2]).toEqual({
    expectedProposalRevision: 1,
    operations: [{
      id: "command-add-checkout",
      type: "add-node",
      node: {
        id: "page-checkout",
        kind: "page",
        name: "Checkout route",
        artifactId: "artifact-checkout",
      },
    }],
    layoutOperations: [],
    generation: emptyGeneration,
    rationale: "Add checkout",
    assumptions: ["Existing cart state is reusable"],
  });
  await waitFor(() => expect(screen.getByText("r2")).toBeInTheDocument());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Proposal name for Checkout route" }))
    .toHaveValue("Checkout route");

  fireEvent.click(screen.getByRole("button", { name: "Approve and generate" }));
  expect(await screen.findByRole("heading", { name: "Proposal approved" })).toBeInTheDocument();
  expect(approveWorkspaceProposal).toHaveBeenCalledTimes(2);
});

test("queued inline renames transform the latest Proposal operations without clobbering each other", async () => {
  const proposal = draftProposal({
    operations: [
      ...draftProposal().operations,
      {
        id: "command-add-receipt",
        type: "add-node",
        node: { id: "page-receipt", kind: "page", name: "Receipt", artifactId: "artifact-receipt" },
      },
    ],
  });
  let resolveFirst!: (proposal: WorkspaceProposal) => void;
  const firstSave = new Promise<WorkspaceProposal>((resolve) => { resolveFirst = resolve; });
  const updateWorkspaceProposal = vi.fn((_projectId, _proposalId, input) => {
    if (input.expectedProposalRevision === 1) return firstSave;
    return Promise.resolve(draftProposal({
      ...proposal,
      revision: input.expectedProposalRevision + 1,
      operations: [...input.operations],
      layoutOperations: [...input.layoutOperations],
      generation: input.generation,
      rationale: input.rationale,
      assumptions: [...input.assumptions],
      updatedAt: input.expectedProposalRevision + 1,
    }));
  });
  renderStudio({
    listWorkspaceProposals: async () => [proposal],
    updateWorkspaceProposal,
  });

  await screen.findByRole("region", { name: "Project canvas" });
  const checkout = screen.getByRole("textbox", { name: "Proposal name for Checkout" });
  fireEvent.change(checkout, { target: { value: "Checkout A" } });
  fireEvent.blur(checkout);
  await waitFor(() => expect(updateWorkspaceProposal).toHaveBeenCalledTimes(1));

  const receipt = screen.getByRole("textbox", { name: "Proposal name for Receipt" });
  expect(receipt).not.toHaveAttribute("readonly");
  fireEvent.change(receipt, { target: { value: "Receipt B" } });
  fireEvent.blur(receipt);
  const firstInput = updateWorkspaceProposal.mock.calls[0]![2];
  await act(async () => {
    resolveFirst(draftProposal({
      ...proposal,
      revision: 2,
      operations: [...firstInput.operations],
      updatedAt: 2,
    }));
  });

  await waitFor(() => expect(updateWorkspaceProposal).toHaveBeenCalledTimes(2));
  const secondOperations = updateWorkspaceProposal.mock.calls[1]![2].operations as WorkspaceProposal["operations"];
  expect(secondOperations.find((command) => command.id === "command-add-checkout"))
    .toMatchObject({ node: { name: "Checkout A" } });
  expect(secondOperations.find((command) => command.id === "command-add-receipt"))
    .toMatchObject({ node: { name: "Receipt B" } });
});

test("an inline existing-node rename preserves its referenced command identity", async () => {
  const proposal = draftProposal({
    operations: [{
      id: "command-rename-home",
      type: "rename-node",
      nodeId: "page-home",
      name: "Landing",
    }],
  });
  const diff = buildProposalDiff(proposal, {
    graph: baseGraph,
    activeSnapshotId: "snapshot-7",
    layoutChecksum: "layout-7",
  });
  const onEdit = vi.fn(async () => proposal);
  render(
    <ProposalReviewPanel
      review={{ status: "draft", proposal, diff }}
      focusedChangeKey={null}
      onEdit={onEdit}
      onRevert={async () => proposal}
      onFocusItem={() => {}}
      onApprove={async () => {}}
      onReject={async () => {}}
      onClose={() => {}}
    />,
  );

  const name = screen.getByRole("textbox", { name: "Proposal name for Landing" });
  fireEvent.change(name, { target: { value: "Welcome" } });
  fireEvent.blur(name);

  await waitFor(() => expect(onEdit).toHaveBeenCalledWith({
    operations: [{
      id: "command-rename-home",
      type: "rename-node",
      nodeId: "page-home",
      name: "Welcome",
    }],
  }));
});
