import { describe, expect, test } from "vitest";
import type { WorkspaceGraph, WorkspaceLayout } from "../../lib/api.ts";
import {
  createPlannedPrototypeCommand,
  isValidWorkspaceConnection,
  semanticZoomLevel,
  workspaceGraphToFlow,
} from "./workspace-graph-adapter.ts";
import {
  COMPONENT_LIBRARY_GROUP_ID,
  WORKSPACE_NODE_SIZES,
  applyWorkspaceLayoutCommands,
  buildComponentLibraryCommands,
  buildDeleteGroupCommands,
  buildGroupCommands,
  buildMoveCommands,
  buildReparentCommands,
  buildUngroupCommands,
  decodeWorkspaceLayout,
  isValidLayoutParent,
  topmostSelectedLayoutIds,
} from "./workspace-layout.ts";

const graph: WorkspaceGraph = {
  workspaceId: "workspace-1",
  revision: 4,
  nodes: [
    { id: "page-1", workspaceId: "workspace-1", kind: "page", artifactId: "artifact-page-1", name: "Checkout" },
    { id: "page-2", workspaceId: "workspace-1", kind: "page", artifactId: "artifact-page-2", name: "Receipt" },
    { id: "component-1", workspaceId: "workspace-1", kind: "component", artifactId: "artifact-component-1", name: "Order summary" },
    { id: "resource-1", workspaceId: "workspace-1", kind: "resource", resourceId: "research-1", name: "Checkout research" },
  ],
  edges: [
    {
      id: "prototype-1",
      workspaceId: "workspace-1",
      kind: "prototype",
      sourceNodeId: "page-1",
      targetNodeId: "page-2",
      prototype: { status: "planned" },
    },
    {
      id: "uses-1",
      workspaceId: "workspace-1",
      kind: "uses",
      sourceNodeId: "page-1",
      targetNodeId: "component-1",
    },
  ],
};

const layout: WorkspaceLayout = {
  workspaceId: "workspace-1",
  layoutId: "default",
  objects: [
    { id: "journey", kind: "group", x: 100, y: 80, width: 720, height: 440, parentGroupId: null, label: "Purchase journey", collapsed: false },
    { id: "page-1", kind: "node", x: 44, y: 72, parentGroupId: "journey" },
    { id: "page-2", kind: "node", x: 370, y: 72, parentGroupId: "journey" },
    { id: "component-1", kind: "node", x: 920, y: 120, parentGroupId: null },
    { id: "resource-1", kind: "node", x: 920, y: 390, parentGroupId: null },
  ],
  viewport: { x: 20, y: 30, zoom: 0.8 },
  checksum: "layout-1",
};

test("semantic zoom uses the exact overview, compact, and full boundaries", () => {
  expect(semanticZoomLevel(0.3799)).toBe("overview");
  expect(semanticZoomLevel(0.38)).toBe("compact");
  expect(semanticZoomLevel(0.7199)).toBe("compact");
  expect(semanticZoomLevel(0.72)).toBe("full");
});

test("adapter uses immutable revision thumbnails, parent-relative layout, and stable outer sizes", () => {
  const baseView = {
    projectId: "project 1",
    zoom: 0.8,
    edgeFilter: "flow" as const,
    artifactRevisionIds: { "artifact-page-1": "revision-1" },
    selectedNodeIds: new Set<string>(),
  };
  const compact = workspaceGraphToFlow(graph, layout, baseView);
  const overview = workspaceGraphToFlow(graph, layout, { ...baseView, zoom: 0.2 });
  const page = compact.nodes.find((node) => node.id === "page-1")!;

  expect(page.parentId).toBe("journey");
  expect(page.extent).toBe("parent");
  expect(page.position).toEqual({ x: 44, y: 72 });
  expect(page.data.projectId).toBe("project 1");
  expect(page.data).not.toHaveProperty("thumbnailUrl");
  expect(page.data.revisionId).toBe("revision-1");
  expect(overview.nodes.find((node) => node.id === "page-1")?.style).toEqual(page.style);
  expect(overview.nodes.find((node) => node.id === "page-1")?.data.zoomLevel).toBe("overview");
});

test("adapter binds Research quality and awaiting-selection state to the exact active Resource revision", () => {
  const flow = workspaceGraphToFlow(graph, layout, {
    zoom: 0.8,
    edgeFilter: "all",
    resourceRevisionStates: {
      "research-1": {
        revisionId: "research-revision-7",
        resourceKind: "research",
        qualityState: "needs-review",
      },
    },
    awaitingSelectionResourceIds: new Set(["research-1"]),
  });
  const research = flow.nodes.find((node) => node.id === "resource-1")!;

  expect(research.data.revisionId).toBe("research-revision-7");
  expect(research.data.resourceKind).toBe("research");
  expect(research.data.resourceQualityState).toBe("needs-review");
  expect(research.data.generationState).toBe("awaiting-selection");
  expect(research.ariaLabel).toContain("quality needs-review");
});

test("layout groups are adapter-only parents and recursively collapsed descendants hide with incident edges", () => {
  const nested: WorkspaceLayout = {
    ...layout,
    objects: [
      { id: "phase", kind: "group", x: 20, y: 50, width: 600, height: 300, parentGroupId: "journey", label: "Phase", collapsed: false },
      { id: "journey", kind: "group", x: 100, y: 80, width: 720, height: 440, parentGroupId: null, label: "Journey", collapsed: true },
      { id: "page-1", kind: "node", x: 30, y: 40, parentGroupId: "phase" },
      { id: "page-2", kind: "node", x: 400, y: 80, parentGroupId: null },
      { id: "component-1", kind: "node", x: 800, y: 80, parentGroupId: null },
      { id: "resource-1", kind: "node", x: 800, y: 360, parentGroupId: null },
    ],
  };
  const flow = workspaceGraphToFlow(graph, nested, { zoom: 0.8, edgeFilter: "all" });

  expect(graph.nodes.some((node) => node.id === "journey" || node.id === "phase")).toBe(false);
  expect(flow.nodes.slice(0, 2).map((node) => node.id)).toEqual(["journey", "phase"]);
  expect(flow.nodes.find((node) => node.id === "journey")?.style).toMatchObject({ width: 264, height: 48 });
  expect(flow.nodes.find((node) => node.id === "phase")?.hidden).toBe(true);
  expect(flow.nodes.find((node) => node.id === "page-1")?.hidden).toBe(true);
  expect(flow.edges.find((edge) => edge.id === "prototype-1")?.hidden).toBe(true);
  expect(flow.edges.find((edge) => edge.id === "uses-1")?.hidden).toBe(true);
});

test("missing layout rows receive a deterministic non-overlapping fallback grid", () => {
  const emptyLayout = { ...layout, objects: [] };
  const first = workspaceGraphToFlow(graph, emptyLayout, { zoom: 1, edgeFilter: "flow" });
  const second = workspaceGraphToFlow(graph, emptyLayout, { zoom: 1, edgeFilter: "flow" });
  const positions = first.nodes.map((node) => node.position);

  expect(new Set(positions.map((position) => `${position.x}:${position.y}`)).size).toBe(graph.nodes.length);
  expect(second.nodes.map((node) => node.position)).toEqual(positions);
});

test("unplaced pages follow prototype topology instead of semantic creation order", () => {
  const topologyGraph: WorkspaceGraph = {
    workspaceId: "workspace-topology",
    revision: 1,
    nodes: [
      { id: "album", workspaceId: "workspace-topology", kind: "page", artifactId: "album-artifact", name: "Album" },
      { id: "home", workspaceId: "workspace-topology", kind: "page", artifactId: "home-artifact", name: "Home" },
      { id: "library", workspaceId: "workspace-topology", kind: "page", artifactId: "library-artifact", name: "Library" },
      { id: "search", workspaceId: "workspace-topology", kind: "page", artifactId: "search-artifact", name: "Search" },
    ],
    edges: [
      { id: "home-library", workspaceId: "workspace-topology", kind: "prototype", sourceNodeId: "home", targetNodeId: "library", prototype: { status: "planned" } },
      { id: "home-search", workspaceId: "workspace-topology", kind: "prototype", sourceNodeId: "home", targetNodeId: "search", prototype: { status: "planned" } },
      { id: "search-album", workspaceId: "workspace-topology", kind: "prototype", sourceNodeId: "search", targetNodeId: "album", prototype: { status: "planned" } },
    ],
  };
  const topologyLayout: WorkspaceLayout = {
    workspaceId: "workspace-topology",
    layoutId: "default",
    objects: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    checksum: "empty",
  };
  const flow = workspaceGraphToFlow(topologyGraph, topologyLayout, { zoom: 1, edgeFilter: "flow" });
  const positions = Object.fromEntries(flow.nodes.map((node) => [node.id, node.position]));

  expect(positions).toEqual({
    album: { x: 800, y: 210 },
    home: { x: 80, y: 210 },
    library: { x: 440, y: 80 },
    search: { x: 440, y: 340 },
  });
});

test("cyclic prototype flows expand across columns instead of stacking one return path through every page", () => {
  const cycleGraph: WorkspaceGraph = {
    workspaceId: "workspace-cycle",
    revision: 1,
    nodes: ["a", "b", "c"].map((id) => ({
      id,
      workspaceId: "workspace-cycle",
      kind: "page" as const,
      artifactId: `artifact-${id}`,
      name: id.toUpperCase(),
    })),
    edges: [
      { id: "a-b", workspaceId: "workspace-cycle", kind: "prototype", sourceNodeId: "a", targetNodeId: "b", prototype: { status: "planned" } },
      { id: "b-c", workspaceId: "workspace-cycle", kind: "prototype", sourceNodeId: "b", targetNodeId: "c", prototype: { status: "planned" } },
      { id: "c-a", workspaceId: "workspace-cycle", kind: "prototype", sourceNodeId: "c", targetNodeId: "a", prototype: { status: "planned" } },
    ],
  };
  const flow = workspaceGraphToFlow(cycleGraph, {
    workspaceId: "workspace-cycle",
    layoutId: "default",
    objects: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    checksum: "empty",
  }, { zoom: 1, edgeFilter: "flow" });

  expect(Object.fromEntries(flow.nodes.map((node) => [node.id, node.position]))).toEqual({
    a: { x: 80, y: 80 },
    b: { x: 440, y: 80 },
    c: { x: 800, y: 80 },
  });
  const returnEdge = flow.edges.find((edge) => edge.id === "c-a")!;
  expect(returnEdge.sourceHandle).toBe("page-source-top");
  expect(returnEdge.targetHandle).toBe("page-target-top");
});

test("reciprocal prototype links use separate lanes instead of painting the same path twice", () => {
  const reciprocalGraph: WorkspaceGraph = {
    workspaceId: "workspace-reciprocal",
    revision: 1,
    nodes: ["a", "b"].map((id) => ({
      id,
      workspaceId: "workspace-reciprocal",
      kind: "page" as const,
      artifactId: `artifact-${id}`,
      name: id.toUpperCase(),
    })),
    edges: [
      { id: "a-b", workspaceId: "workspace-reciprocal", kind: "prototype", sourceNodeId: "a", targetNodeId: "b", prototype: { status: "planned" } },
      { id: "b-a", workspaceId: "workspace-reciprocal", kind: "prototype", sourceNodeId: "b", targetNodeId: "a", prototype: { status: "planned" } },
    ],
  };
  const flow = workspaceGraphToFlow(reciprocalGraph, {
    workspaceId: "workspace-reciprocal",
    layoutId: "default",
    objects: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    checksum: "empty",
  }, { zoom: 1, edgeFilter: "flow" });

  const outbound = flow.edges.find((edge) => edge.id === "a-b")!;
  const inbound = flow.edges.find((edge) => edge.id === "b-a")!;
  expect([outbound.sourceHandle, outbound.targetHandle]).toEqual(["page-source-top", "page-target-top"]);
  expect([inbound.sourceHandle, inbound.targetHandle]).toEqual(["page-source-bottom", "page-target-bottom"]);
});

test("four mixed links sharing endpoints preserve lane magnitude for distinct edge geometry", () => {
  const multiEdgeGraph: WorkspaceGraph = {
    workspaceId: "workspace-multi-edge",
    revision: 1,
    nodes: ["a", "b"].map((id) => ({
      id,
      workspaceId: "workspace-multi-edge",
      kind: "page" as const,
      artifactId: `artifact-${id}`,
      name: id.toUpperCase(),
    })),
    edges: [
      { id: "01-prototype-forward", workspaceId: "workspace-multi-edge", kind: "prototype", sourceNodeId: "a", targetNodeId: "b", prototype: { status: "planned" } },
      { id: "02-informs-forward", workspaceId: "workspace-multi-edge", kind: "informs", sourceNodeId: "a", targetNodeId: "b" },
      { id: "03-prototype-reverse", workspaceId: "workspace-multi-edge", kind: "prototype", sourceNodeId: "b", targetNodeId: "a", prototype: { status: "planned" } },
      { id: "04-derives-reverse", workspaceId: "workspace-multi-edge", kind: "derives-from", sourceNodeId: "b", targetNodeId: "a" },
    ],
  };
  const flow = workspaceGraphToFlow(multiEdgeGraph, {
    workspaceId: "workspace-multi-edge",
    layoutId: "default",
    objects: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    checksum: "empty",
  }, { zoom: 1, edgeFilter: "all" });

  expect(flow.edges.map((edge) => ({
    id: edge.id,
    type: edge.type,
    lane: edge.data?.lane,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
  }))).toEqual([
    {
      id: "01-prototype-forward",
      type: "prototype",
      lane: -1.5,
      sourceHandle: "page-source-top",
      targetHandle: "page-target-top",
    },
    {
      id: "02-informs-forward",
      type: "relation",
      lane: -0.5,
      sourceHandle: "page-source-top",
      targetHandle: "page-target-top",
    },
    {
      id: "03-prototype-reverse",
      type: "prototype",
      lane: 0.5,
      sourceHandle: "page-source-bottom",
      targetHandle: "page-target-bottom",
    },
    {
      id: "04-derives-reverse",
      type: "relation",
      lane: 1.5,
      sourceHandle: "page-source-bottom",
      targetHandle: "page-target-bottom",
    },
  ]);
});

test("independent pages retain a bounded fallback grid instead of one tall topology column", () => {
  const independentGraph: WorkspaceGraph = {
    workspaceId: "workspace-independent",
    revision: 1,
    nodes: Array.from({ length: 7 }, (_, index) => ({
      id: `page-${index + 1}`,
      workspaceId: "workspace-independent",
      kind: "page" as const,
      artifactId: `artifact-${index + 1}`,
      name: `Page ${index + 1}`,
    })),
    edges: [],
  };
  const independentLayout: WorkspaceLayout = {
    workspaceId: "workspace-independent",
    layoutId: "default",
    objects: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    checksum: "empty",
  };
  const flow = workspaceGraphToFlow(independentGraph, independentLayout, { zoom: 1, edgeFilter: "flow" });

  expect(flow.nodes.map((node) => node.position)).toEqual([
    { x: 80, y: 80 },
    { x: 440, y: 80 },
    { x: 800, y: 80 },
    { x: 80, y: 340 },
    { x: 440, y: 340 },
    { x: 800, y: 340 },
    { x: 80, y: 600 },
  ]);
});

test("disconnected prototype flows are laid out independently and packed into bounded rows", () => {
  const mixedGraph: WorkspaceGraph = {
    workspaceId: "workspace-mixed",
    revision: 1,
    nodes: Array.from({ length: 8 }, (_, index) => ({
      id: `p${index}`,
      workspaceId: "workspace-mixed",
      kind: "page" as const,
      artifactId: `artifact-${index}`,
      name: `Page ${index}`,
    })),
    edges: [{
      id: "p0-p1",
      workspaceId: "workspace-mixed",
      kind: "prototype",
      sourceNodeId: "p0",
      targetNodeId: "p1",
      prototype: { status: "planned" },
    }],
  };
  const mixedLayout: WorkspaceLayout = {
    workspaceId: "workspace-mixed",
    layoutId: "default",
    objects: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    checksum: "empty",
  };
  const flow = workspaceGraphToFlow(mixedGraph, mixedLayout, { zoom: 1, edgeFilter: "flow" });
  const positions = Object.fromEntries(flow.nodes.map((node) => [node.id, node.position]));

  expect(positions).toEqual({
    p0: { x: 80, y: 80 },
    p1: { x: 440, y: 80 },
    p2: { x: 800, y: 80 },
    p3: { x: 80, y: 382 },
    p4: { x: 440, y: 382 },
    p5: { x: 800, y: 382 },
    p6: { x: 80, y: 684 },
    p7: { x: 440, y: 684 },
  });
});

test("a newly materialized Resource avoids an existing prototype edge corridor without mutating stored layout", () => {
  const storedLayout: WorkspaceLayout = {
    workspaceId: "workspace-1",
    layoutId: "default",
    objects: [
      { id: "page-1", kind: "node", x: -420, y: -120, parentGroupId: null },
      { id: "page-2", kind: "node", x: 210, y: -120, parentGroupId: null },
      { id: "component-1", kind: "node", x: -110, y: 310, parentGroupId: null },
    ],
    viewport: { x: 720, y: 360, zoom: 0.82 },
    checksum: "stored-layout-checksum",
  };
  const storedSnapshot = structuredClone(storedLayout);
  const prototypeOnlyGraph = {
    ...graph,
    edges: graph.edges.filter((edge) => edge.kind === "prototype"),
  };

  const first = workspaceGraphToFlow(prototypeOnlyGraph, storedLayout, { zoom: 0.82, edgeFilter: "all" });
  const second = workspaceGraphToFlow(prototypeOnlyGraph, storedLayout, { zoom: 0.82, edgeFilter: "all" });
  const resource = first.nodes.find((node) => node.id === "resource-1")!;
  const otherBounds = first.nodes
    .filter((node) => node.id !== resource.id)
    .map((node) => ({
      x: node.position.x,
      y: node.position.y,
      width: Number(node.style?.width),
      height: Number(node.style?.height),
    }));
  const overlapsAnotherNode = otherBounds.some((bounds) => (
    resource.position.x < bounds.x + bounds.width + 24
    && resource.position.x + Number(resource.style?.width) + 24 > bounds.x
    && resource.position.y < bounds.y + bounds.height + 24
    && resource.position.y + Number(resource.style?.height) + 24 > bounds.y
  ));

  expect(resource.position).toEqual({ x: -420, y: 140 });
  expect(overlapsAnotherNode).toBe(false);
  expect(second.nodes.find((node) => node.id === "resource-1")?.position).toEqual(resource.position);
  expect(storedLayout).toEqual(storedSnapshot);
  expect(storedLayout.checksum).toBe("stored-layout-checksum");
});

test("fallback placement keeps the original nearby slot when the graph has no edge corridor", () => {
  const storedLayout: WorkspaceLayout = {
    workspaceId: "workspace-1",
    layoutId: "default",
    objects: [
      { id: "page-1", kind: "node", x: -420, y: -120, parentGroupId: null },
      { id: "page-2", kind: "node", x: 210, y: -120, parentGroupId: null },
      { id: "component-1", kind: "node", x: -110, y: 310, parentGroupId: null },
    ],
    viewport: { x: 720, y: 360, zoom: 0.82 },
    checksum: "stored-layout-checksum",
  };
  const graphWithoutEdges = { ...graph, edges: [] };

  const flow = workspaceGraphToFlow(graphWithoutEdges, storedLayout, { zoom: 0.82, edgeFilter: "all" });

  expect(flow.nodes.find((node) => node.id === "resource-1")?.position).toEqual({ x: -60, y: -120 });
});

test("edge-corridor avoidance resolves grouped endpoints to root coordinates", () => {
  const groupedGraph: WorkspaceGraph = {
    workspaceId: "workspace-1",
    revision: 5,
    nodes: [
      { id: "page-1", workspaceId: "workspace-1", kind: "page", artifactId: "artifact-page-1", name: "Overview" },
      { id: "page-2", workspaceId: "workspace-1", kind: "page", artifactId: "artifact-page-2", name: "System detail" },
      { id: "resource-1", workspaceId: "workspace-1", kind: "resource", resourceId: "research-1", name: "Research" },
    ],
    edges: [{
      id: "prototype-1",
      workspaceId: "workspace-1",
      kind: "prototype",
      sourceNodeId: "page-1",
      targetNodeId: "page-2",
      prototype: { status: "planned" },
    }],
  };
  const groupedLayout: WorkspaceLayout = {
    workspaceId: "workspace-1",
    layoutId: "default",
    objects: [
      { id: "overview-group", kind: "group", x: -500, y: -120, width: 280, height: 188, parentGroupId: null, label: "Overview frame", collapsed: false },
      { id: "page-1", kind: "node", x: 0, y: 0, parentGroupId: "overview-group" },
      { id: "page-2", kind: "node", x: 210, y: -120, parentGroupId: null },
    ],
    viewport: { x: 720, y: 360, zoom: 0.82 },
    checksum: "grouped-layout-checksum",
  };
  const storedSnapshot = structuredClone(groupedLayout);

  const flow = workspaceGraphToFlow(groupedGraph, groupedLayout, { zoom: 0.82, edgeFilter: "all" });

  expect(flow.nodes.find((node) => node.id === "resource-1")?.position).toEqual({ x: -500, y: 140 });
  expect(groupedLayout).toEqual(storedSnapshot);
});

test("fallback placement follows the visible vertical edge corridor instead of a ghost horizontal route", () => {
  const verticalGraph: WorkspaceGraph = {
    workspaceId: "workspace-vertical-corridor",
    revision: 1,
    nodes: [
      { id: "page-a", workspaceId: "workspace-vertical-corridor", kind: "page", artifactId: "artifact-a", name: "A" },
      { id: "page-b", workspaceId: "workspace-vertical-corridor", kind: "page", artifactId: "artifact-b", name: "B" },
      ...["left-top", "right-top", "left-bottom", "new"].map((id) => ({
        id: `resource-${id}`,
        workspaceId: "workspace-vertical-corridor",
        kind: "resource" as const,
        resourceId: `revision-${id}`,
        name: id,
      })),
    ],
    edges: [{
      id: "a-b",
      workspaceId: "workspace-vertical-corridor",
      kind: "prototype",
      sourceNodeId: "page-a",
      targetNodeId: "page-b",
      prototype: { status: "planned" },
    }],
  };
  const verticalLayout: WorkspaceLayout = {
    workspaceId: "workspace-vertical-corridor",
    layoutId: "default",
    objects: [
      { id: "page-a", kind: "node", x: 80, y: 100, parentGroupId: null },
      { id: "page-b", kind: "node", x: 80, y: 620, parentGroupId: null },
      { id: "resource-left-top", kind: "node", x: -60, y: 100, parentGroupId: null },
      { id: "resource-right-top", kind: "node", x: 660, y: 100, parentGroupId: null },
      { id: "resource-left-bottom", kind: "node", x: -60, y: 360, parentGroupId: null },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    checksum: "vertical-corridor",
  };

  const flow = workspaceGraphToFlow(verticalGraph, verticalLayout, { zoom: 1, edgeFilter: "all" });
  const edge = flow.edges.find((candidate) => candidate.id === "a-b")!;

  expect([edge.sourceHandle, edge.targetHandle]).toEqual(["page-source-bottom", "page-target-top"]);
  expect(flow.nodes.find((node) => node.id === "resource-new")?.position).toEqual({ x: 300, y: 360 });
});

test("edge filters and connection validation preserve semantic rules", () => {
  expect(workspaceGraphToFlow(graph, layout, { zoom: 1, edgeFilter: "flow" }).edges.map((edge) => edge.id)).toEqual(["prototype-1"]);
  expect(workspaceGraphToFlow(graph, layout, { zoom: 1, edgeFilter: "relations" }).edges.map((edge) => edge.id)).toEqual(["uses-1"]);
  expect(workspaceGraphToFlow(graph, layout, { zoom: 1, edgeFilter: "all" }).edges).toHaveLength(2);
  expect(isValidWorkspaceConnection({ source: "page-1", target: "page-2" }, graph)).toBe(true);
  expect(isValidWorkspaceConnection({ source: "page-1", target: "page-1" }, graph)).toBe(true);
  expect(isValidWorkspaceConnection({ source: "journey", target: "page-2" }, graph)).toBe(false);
  expect(isValidWorkspaceConnection({ source: "resource-1", target: "page-2" }, graph)).toBe(false);
  const command = createPlannedPrototypeCommand(graph, { source: "page-1", target: "page-2" }, { commandId: "command-1", edgeId: "edge-1" });
  expect(command).toEqual({
    id: "command-1",
    type: "add-edge",
    edge: { id: "edge-1", kind: "prototype", workspaceId: "workspace-1", sourceNodeId: "page-1", targetNodeId: "page-2" },
  });
  expect(command.edge).not.toHaveProperty("prototype");
  const selectedRelations = workspaceGraphToFlow(graph, layout, {
    zoom: 1,
    edgeFilter: "flow",
    selectedNodeIds: new Set(["component-1"]),
  });
  expect(selectedRelations.edges.map((edge) => edge.id)).toEqual(["prototype-1", "uses-1"]);
  expect(selectedRelations.edges.find((edge) => edge.id === "uses-1")?.type).toBe("relation");
  expect(selectedRelations.edges.find((edge) => edge.id === "uses-1")?.ariaLabel).toBe(
    "uses relation from Checkout to Order summary",
  );

  const selectedEdge = workspaceGraphToFlow(graph, layout, {
    zoom: 1,
    edgeFilter: "flow",
    selectedNodeIds: new Set(),
    selectedEdgeIds: new Set(["uses-1"]),
  });
  expect(selectedEdge.edges.map((edge) => edge.id)).toEqual(["prototype-1", "uses-1"]);
  expect(selectedEdge.edges.find((edge) => edge.id === "uses-1")?.selected).toBe(true);
});

test("prototype edges select edge-aligned routing handles for forward, vertical, and reverse layouts", () => {
  const forward = workspaceGraphToFlow(graph, layout, { zoom: 1, edgeFilter: "flow" })
    .edges.find((edge) => edge.id === "prototype-1")!;
  expect(forward.sourceHandle).toBe("page-source-right");
  expect(forward.targetHandle).toBe("page-target-left");
  expect(forward.markerEnd).toMatchObject({ width: 12, height: 12 });

  const verticalLayout: WorkspaceLayout = {
    ...layout,
    objects: [
      { id: "page-1", kind: "node", x: 80, y: 80, parentGroupId: null },
      { id: "page-2", kind: "node", x: 80, y: 420, parentGroupId: null },
      { id: "component-1", kind: "node", x: 800, y: 80, parentGroupId: null },
      { id: "resource-1", kind: "node", x: 800, y: 340, parentGroupId: null },
    ],
  };
  const vertical = workspaceGraphToFlow(graph, verticalLayout, { zoom: 1, edgeFilter: "flow" })
    .edges.find((edge) => edge.id === "prototype-1")!;
  expect(vertical.sourceHandle).toBe("page-source-bottom");
  expect(vertical.targetHandle).toBe("page-target-top");

  const reverseLayout: WorkspaceLayout = {
    ...verticalLayout,
    objects: verticalLayout.objects.map((object) => object.id === "page-1"
      ? { ...object, x: 520, y: 80 }
      : object.id === "page-2"
        ? { ...object, x: 80, y: 80 }
        : object),
  };
  const reverse = workspaceGraphToFlow(graph, reverseLayout, { zoom: 1, edgeFilter: "flow" })
    .edges.find((edge) => edge.id === "prototype-1")!;
  expect(reverse.sourceHandle).toBe("page-source-left");
  expect(reverse.targetHandle).toBe("page-target-right");
});

test("semantic relations select directional handles across node kinds", () => {
  const forward = workspaceGraphToFlow(graph, layout, { zoom: 1, edgeFilter: "all" })
    .edges.find((edge) => edge.id === "uses-1")!;
  expect(forward.sourceHandle).toBe("page-source-top");
  expect(forward.targetHandle).toBe("component-target-top");

  const verticalLayout: WorkspaceLayout = {
    ...layout,
    objects: layout.objects.map((object) => object.id === "component-1"
      ? { ...object, x: 144, y: 620 }
      : object),
  };
  const vertical = workspaceGraphToFlow(graph, verticalLayout, { zoom: 1, edgeFilter: "all" })
    .edges.find((edge) => edge.id === "uses-1")!;
  expect(vertical.sourceHandle).toBe("page-source-bottom");
  expect(vertical.targetHandle).toBe("component-target-top");
});

describe("layout command conversion", () => {
  test("decodes kind and objectKind rows without leaking transport names", () => {
    const decoded = decodeWorkspaceLayout({
      workspaceId: "workspace-1",
      layoutId: "default",
      viewport: { x: 0, y: 0, zoom: 1 },
      objects: [
        { id: "page-1", objectKind: "node", x: 1, y: 2, parentGroupId: null },
        { id: "group-1", objectKind: "group", x: 3, y: 4, width: 200, height: 100, parentGroupId: null, label: "Group", collapsed: false },
      ],
    });
    expect(decoded.objects.map((object) => object.kind)).toEqual(["node", "group"]);
  });

  test("reparent, ungroup, and delete batches preserve root-space positions", () => {
    const nested: WorkspaceLayout = {
      ...layout,
      objects: [
        { id: "outer", kind: "group", x: 100, y: 80, width: 600, height: 400, parentGroupId: null, label: "Outer", collapsed: false },
        { id: "inner", kind: "group", x: 40, y: 30, width: 400, height: 260, parentGroupId: "outer", label: "Inner", collapsed: false },
        { id: "subgroup", kind: "group", x: 210, y: 90, width: 160, height: 120, parentGroupId: "inner", label: "Subgroup", collapsed: false },
        { id: "page-1", kind: "node", x: 25, y: 20, parentGroupId: "inner" },
      ],
    };
    expect(buildReparentCommands(nested, "page-1", null)).toEqual([
      { type: "move", objectId: "page-1", x: 165, y: 130 },
      { type: "set-parent", objectId: "page-1", parentGroupId: null },
    ]);
    expect(buildReparentCommands(nested, "page-1", "outer")).toEqual([
      { type: "move", objectId: "page-1", x: 65, y: 50 },
      { type: "set-parent", objectId: "page-1", parentGroupId: "outer" },
    ]);
    expect(buildDeleteGroupCommands(nested, "inner")).toEqual([
      { type: "move", objectId: "subgroup", x: 350, y: 200 },
      { type: "move", objectId: "page-1", x: 165, y: 130 },
      { type: "delete-group", groupId: "inner", ungroupChildren: true },
    ]);
    expect(buildUngroupCommands(nested, ["subgroup", "page-1"])).toEqual([
      { type: "move", objectId: "subgroup", x: 350, y: 200 },
      { type: "set-parent", objectId: "subgroup", parentGroupId: null },
      { type: "move", objectId: "page-1", x: 165, y: 130 },
      { type: "set-parent", objectId: "page-1", parentGroupId: null },
    ]);
  });

  test("group creation converts selected root coordinates and parent validation rejects cycles", () => {
    const commands = buildGroupCommands(layout, ["component-1", "resource-1"], {
      groupId: "group-new",
      label: "References",
      graph,
    });
    expect(commands).toEqual([
      {
        type: "add-group",
        groupId: "group-new",
        label: "References",
        bounds: { x: 872, y: 72, width: 376, height: 478 },
      },
      { type: "move", objectId: "component-1", x: 48, y: 48 },
      { type: "set-parent", objectId: "component-1", parentGroupId: "group-new" },
      { type: "move", objectId: "resource-1", x: 48, y: 318 },
      { type: "set-parent", objectId: "resource-1", parentGroupId: "group-new" },
    ]);
    expect(isValidLayoutParent(layout, "journey", "journey")).toBe(false);
    const nested = { ...layout, objects: [...layout.objects, { id: "phase", kind: "group" as const, x: 20, y: 20, width: 200, height: 100, parentGroupId: "journey", label: "Phase", collapsed: false }] };
    expect(isValidLayoutParent(nested, "journey", "phase")).toBe(false);
  });

  test("component library normalization creates one semantic group and places every component on a stable grid", () => {
    const emptyLayout = { ...layout, objects: [] };
    const commands = buildComponentLibraryCommands(graph, emptyLayout);

    expect(commands).toEqual([
      { type: "move", objectId: "page-1", x: 80, y: 80 },
      { type: "move", objectId: "page-2", x: 440, y: 80 },
      { type: "move", objectId: "resource-1", x: 80, y: 340 },
      {
        type: "add-group",
        groupId: COMPONENT_LIBRARY_GROUP_ID,
        label: "Components",
        bounds: { x: 80, y: 548, width: 360, height: 300 },
      },
      { type: "move", objectId: "component-1", x: 40, y: 64 },
      { type: "set-parent", objectId: "component-1", parentGroupId: COMPONENT_LIBRARY_GROUP_ID },
    ]);
  });

  test("component library initialization persists materialized roots before the semantic group", () => {
    const emptyLayout = { ...layout, objects: [] };
    const commands = buildComponentLibraryCommands(graph, emptyLayout);
    const persisted = applyWorkspaceLayoutCommands(emptyLayout, commands);
    const rematerialized = workspaceGraphToFlow(graph, persisted, { zoom: 1, edgeFilter: "all" });
    const componentLibrary = persisted.objects.find((object) => object.id === COMPONENT_LIBRARY_GROUP_ID);
    const rootNodes = persisted.objects.filter(
      (object) => object.kind === "node" && object.parentGroupId === null,
    );

    expect(rootNodes.map((object) => object.id)).toEqual(["page-1", "page-2", "resource-1"]);
    expect(rematerialized.nodes.find((node) => node.id === "page-1")?.position).toEqual({ x: 80, y: 80 });
    expect(rematerialized.nodes.find((node) => node.id === "page-2")?.position).toEqual({ x: 440, y: 80 });
    expect(componentLibrary?.kind).toBe("group");
    if (componentLibrary?.kind !== "group") throw new Error("expected component library group");
    const lowestRootEdge = Math.max(
      ...rootNodes.map((object) => {
        const node = graph.nodes.find((candidate) => candidate.id === object.id)!;
        const height = WORKSPACE_NODE_SIZES[node.kind].height;
        return object.y + height;
      }),
    );
    expect(componentLibrary.y).toBeGreaterThanOrEqual(lowestRootEdge + 96);
    expect(buildComponentLibraryCommands(graph, persisted)).toEqual([]);
  });

  test("new pages claim their topology slot before the component library moves below them", () => {
    const graphWithNewPage: WorkspaceGraph = {
      workspaceId: "workspace-1",
      revision: 5,
      nodes: [
        ...["page-1", "page-2", "page-3", "page-4"].map((id) => ({
          id,
          workspaceId: "workspace-1",
          kind: "page" as const,
          artifactId: `artifact-${id}`,
          name: id,
        })),
        {
          id: "component-1",
          workspaceId: "workspace-1",
          kind: "component",
          artifactId: "artifact-component-1",
          name: "Navigation",
        },
      ],
      edges: [],
    };
    const layoutBeforeNewPage: WorkspaceLayout = {
      ...layout,
      objects: [
        { id: "page-1", kind: "node", x: 80, y: 80, parentGroupId: null },
        { id: "page-2", kind: "node", x: 440, y: 80, parentGroupId: null },
        { id: "page-3", kind: "node", x: 800, y: 80, parentGroupId: null },
        {
          id: COMPONENT_LIBRARY_GROUP_ID,
          kind: "group",
          x: 80,
          y: 398,
          width: 360,
          height: 300,
          parentGroupId: null,
          label: "Components",
          collapsed: false,
        },
        { id: "component-1", kind: "node", x: 40, y: 64, parentGroupId: COMPONENT_LIBRARY_GROUP_ID },
      ],
    };

    expect(buildComponentLibraryCommands(graphWithNewPage, layoutBeforeNewPage)).toEqual([
      { type: "move", objectId: "page-4", x: 80, y: 340 },
      { type: "move", objectId: COMPONENT_LIBRARY_GROUP_ID, x: 80, y: 658 },
    ]);
  });

  test("component library normalization preserves existing members and expands for newly generated components", () => {
    const graphWithNewComponent: WorkspaceGraph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        {
          id: "component-2",
          workspaceId: "workspace-1",
          kind: "component",
          artifactId: "artifact-component-2",
          name: "Payment badge",
        },
      ],
    };
    const groupedLayout: WorkspaceLayout = {
      ...layout,
      objects: [
        { id: COMPONENT_LIBRARY_GROUP_ID, kind: "group", x: 100, y: 600, width: 360, height: 300, parentGroupId: null, label: "Components", collapsed: false },
        { id: "component-1", kind: "node", x: 40, y: 64, parentGroupId: COMPONENT_LIBRARY_GROUP_ID },
        { id: "page-1", kind: "node", x: 100, y: 80, parentGroupId: null },
        { id: "page-2", kind: "node", x: 460, y: 80, parentGroupId: null },
        { id: "resource-1", kind: "node", x: 100, y: 360, parentGroupId: null },
      ],
    };

    expect(buildComponentLibraryCommands(graphWithNewComponent, groupedLayout)).toEqual([
      { type: "resize-group", groupId: COMPONENT_LIBRARY_GROUP_ID, width: 668, height: 300 },
      { type: "move", objectId: "component-2", x: 348, y: 64 },
      { type: "set-parent", objectId: "component-2", parentGroupId: COMPONENT_LIBRARY_GROUP_ID },
    ]);
    expect(buildComponentLibraryCommands(graph, groupedLayout)).toEqual([]);
  });

  test("component library normalization restores breathing room below root content", () => {
    const crowdedLayout: WorkspaceLayout = {
      ...layout,
      objects: [
        { id: "page-1", kind: "node", x: 100, y: 80, parentGroupId: null },
        { id: "page-2", kind: "node", x: 460, y: 340, parentGroupId: null },
        {
          id: COMPONENT_LIBRARY_GROUP_ID,
          kind: "group",
          x: 100,
          y: 610,
          width: 360,
          height: 300,
          parentGroupId: null,
          label: "Components",
          collapsed: false,
        },
        { id: "component-1", kind: "node", x: 40, y: 64, parentGroupId: COMPONENT_LIBRARY_GROUP_ID },
        { id: "resource-1", kind: "node", x: 920, y: 80, parentGroupId: null },
      ],
    };

    expect(buildComponentLibraryCommands(graph, crowdedLayout)).toEqual([
      { type: "move", objectId: COMPONENT_LIBRARY_GROUP_ID, x: 100, y: 658 },
    ]);
  });

  test("component library normalization migrates components out of legacy custom groups", () => {
    const customGroupedLayout: WorkspaceLayout = {
      ...layout,
      objects: [
        ...layout.objects.filter((object) => object.id !== "component-1"),
        { id: "legacy-components", kind: "group", x: 900, y: 120, width: 360, height: 300, parentGroupId: null, label: "Legacy components", collapsed: false },
        { id: "component-1", kind: "node", x: 40, y: 64, parentGroupId: "legacy-components" },
      ],
    };

    expect(buildComponentLibraryCommands(graph, customGroupedLayout)).toEqual([
      {
        type: "add-group",
        groupId: COMPONENT_LIBRARY_GROUP_ID,
        label: "Components",
        bounds: { x: 100, y: 616, width: 360, height: 300 },
      },
      { type: "move", objectId: "component-1", x: 40, y: 64 },
      { type: "set-parent", objectId: "component-1", parentGroupId: COMPONENT_LIBRARY_GROUP_ID },
    ]);
  });

  test("component library normalization uses a vacant slot and clears root group bounds", () => {
    const graphWithNewComponent: WorkspaceGraph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        {
          id: "component-2",
          workspaceId: "workspace-1",
          kind: "component",
          artifactId: "artifact-component-2",
          name: "Payment badge",
        },
      ],
    };
    const groupedLayout: WorkspaceLayout = {
      ...layout,
      objects: [
        { id: "journey", kind: "group", x: 100, y: 80, width: 720, height: 940, parentGroupId: null, label: "Purchase journey", collapsed: false },
        { id: "page-1", kind: "node", x: 44, y: 72, parentGroupId: "journey" },
        { id: "page-2", kind: "node", x: 370, y: 72, parentGroupId: "journey" },
        { id: COMPONENT_LIBRARY_GROUP_ID, kind: "group", x: 100, y: 1116, width: 976, height: 300, parentGroupId: null, label: "Components", collapsed: false },
        { id: "component-1", kind: "node", x: 656, y: 64, parentGroupId: COMPONENT_LIBRARY_GROUP_ID },
        { id: "resource-1", kind: "node", x: 920, y: 390, parentGroupId: null },
      ],
    };

    expect(buildComponentLibraryCommands(graphWithNewComponent, groupedLayout)).toEqual([
      { type: "move", objectId: "component-2", x: 40, y: 64 },
      { type: "set-parent", objectId: "component-2", parentGroupId: COMPONENT_LIBRARY_GROUP_ID },
    ]);

    const withoutLibrary: WorkspaceLayout = {
      ...groupedLayout,
      objects: groupedLayout.objects.filter((object) => (
        object.id !== COMPONENT_LIBRARY_GROUP_ID
        && object.id !== "component-1"
        && object.id !== "component-2"
      )),
    };
    const commands = buildComponentLibraryCommands(graph, withoutLibrary);
    const addGroup = commands.find((command) => command.type === "add-group");
    expect(addGroup?.type).toBe("add-group");
    if (addGroup?.type !== "add-group") throw new Error("expected component library group");
    expect(addGroup.bounds.y).toBe(1116);
  });

  test("component library normalization expands around manually spaced existing members", () => {
    const sparseLibrary: WorkspaceLayout = {
      ...layout,
      objects: [
        { id: "page-1", kind: "node", x: 100, y: 80, parentGroupId: null },
        { id: "page-2", kind: "node", x: 460, y: 80, parentGroupId: null },
        { id: "resource-1", kind: "node", x: 100, y: 360, parentGroupId: null },
        {
          id: COMPONENT_LIBRARY_GROUP_ID,
          kind: "group",
          x: 100,
          y: 900,
          width: 360,
          height: 300,
          parentGroupId: null,
          label: "Components",
          collapsed: false,
        },
        { id: "component-1", kind: "node", x: 656, y: 280, parentGroupId: COMPONENT_LIBRARY_GROUP_ID },
      ],
    };

    expect(buildComponentLibraryCommands(graph, sparseLibrary)).toEqual([
      { type: "resize-group", groupId: COMPONENT_LIBRARY_GROUP_ID, width: 976, height: 516 },
    ]);
  });

  test("adapter marks the component library as a protected semantic group with content-aware resize bounds", () => {
    const groupedLayout: WorkspaceLayout = {
      ...layout,
      objects: [
        { id: COMPONENT_LIBRARY_GROUP_ID, kind: "group", x: 100, y: 600, width: 668, height: 300, parentGroupId: null, label: "Components", collapsed: true },
        { id: "component-1", kind: "node", x: 348, y: 64, parentGroupId: COMPONENT_LIBRARY_GROUP_ID },
        { id: "page-1", kind: "node", x: 44, y: 72, parentGroupId: null },
        { id: "page-2", kind: "node", x: 370, y: 72, parentGroupId: null },
        { id: "resource-1", kind: "node", x: 920, y: 390, parentGroupId: null },
      ],
    };
    const flow = workspaceGraphToFlow(graph, groupedLayout, {
      zoom: 1,
      edgeFilter: "all",
      onRenameGroup: () => {
        throw new Error("system group must never expose rename");
      },
    });
    const componentLibrary = flow.nodes.find((node) => node.id === COMPONENT_LIBRARY_GROUP_ID)!;

    expect(componentLibrary.data.groupRole).toBe("component-library");
    expect(componentLibrary.data.memberCount).toBe(1);
    expect(componentLibrary.data.minimumGroupWidth).toBe(668);
    expect(componentLibrary.data.minimumGroupHeight).toBe(300);
    expect(componentLibrary.style).toMatchObject({ width: 312, height: 48 });
    expect(componentLibrary.data.onRenameGroup).toBeUndefined();
  });

  test("grouping a graph node without a stored row uses its materialized fallback position", () => {
    const emptyLayout = { ...layout, objects: [] };
    expect(buildGroupCommands(emptyLayout, ["page-1"], {
      groupId: "fallback-group",
      label: "New frame",
      graph,
    })).toEqual([
      {
        type: "add-group",
        groupId: "fallback-group",
        label: "New frame",
        bounds: { x: 32, y: 32, width: 376, height: 318 },
      },
      { type: "move", objectId: "page-1", x: 48, y: 48 },
      { type: "set-parent", objectId: "page-1", parentGroupId: "fallback-group" },
    ]);
  });

  test("materialized fallback nodes avoid occupied persisted root bounds", () => {
    const occupied: WorkspaceLayout = {
      ...layout,
      objects: [{ id: "page-2", kind: "node", x: 80, y: 80, parentGroupId: null }],
    };
    const flow = workspaceGraphToFlow(graph, occupied, { zoom: 1, edgeFilter: "flow" });
    expect(flow.nodes.find((node) => node.id === "page-1")?.position).toEqual({ x: -280, y: 80 });
    expect(new Set(flow.nodes.map((node) => `${node.position.x}:${node.position.y}`)).size).toBe(flow.nodes.length);
  });

  test("ordinary materialization still treats an empty component library as occupied", () => {
    const pageOnlyGraph: WorkspaceGraph = {
      workspaceId: "workspace-1",
      revision: 5,
      nodes: ["page-1", "page-2", "page-3", "page-4"].map((id) => ({
        id,
        workspaceId: "workspace-1",
        kind: "page" as const,
        artifactId: `artifact-${id}`,
        name: id,
      })),
      edges: [],
    };
    const layoutWithEmptyLibrary: WorkspaceLayout = {
      ...layout,
      objects: [
        { id: "page-1", kind: "node", x: 80, y: 80, parentGroupId: null },
        { id: "page-2", kind: "node", x: 440, y: 80, parentGroupId: null },
        { id: "page-3", kind: "node", x: 800, y: 80, parentGroupId: null },
        {
          id: COMPONENT_LIBRARY_GROUP_ID,
          kind: "group",
          x: 80,
          y: 398,
          width: 360,
          height: 300,
          parentGroupId: null,
          label: "Components",
          collapsed: false,
        },
      ],
    };
    const flow = workspaceGraphToFlow(pageOnlyGraph, layoutWithEmptyLibrary, { zoom: 1, edgeFilter: "all" });

    expect(flow.nodes.find((node) => node.id === "page-4")?.position).toEqual({ x: 80, y: 860 });
  });

  test("move batches persist only topmost selected objects in nested groups", () => {
    const nested: WorkspaceLayout = {
      ...layout,
      objects: [
        { id: "outer", kind: "group", x: 100, y: 80, width: 600, height: 400, parentGroupId: null, label: "Outer", collapsed: false },
        { id: "inner", kind: "group", x: 40, y: 30, width: 400, height: 260, parentGroupId: "outer", label: "Inner", collapsed: false },
        { id: "page-1", kind: "node", x: 25, y: 20, parentGroupId: "inner" },
        { id: "page-2", kind: "node", x: 760, y: 90, parentGroupId: null },
      ],
    };
    expect(topmostSelectedLayoutIds(nested, ["page-1", "inner", "outer", "page-2"])).toEqual(["outer", "page-2"]);
    expect(buildMoveCommands(nested, ["outer", "inner", "page-1"], new Map([
      ["outer", { x: 101, y: 80 }],
      ["inner", { x: 41, y: 30 }],
      ["page-1", { x: 26, y: 20 }],
    ]))).toEqual([{ type: "move", objectId: "outer", x: 101, y: 80 }]);
  });
});
