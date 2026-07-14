import { describe, expect, test } from "vitest";
import type { WorkspaceGraph, WorkspaceLayout } from "../../lib/api.ts";
import {
  createPlannedPrototypeCommand,
  isValidWorkspaceConnection,
  semanticZoomLevel,
  workspaceGraphToFlow,
} from "./workspace-graph-adapter.ts";
import {
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
  expect(page.data.thumbnailUrl).toContain("project%201");
  expect(page.data.thumbnailUrl).toContain("revision-1");
  expect(page.data.revisionId).toBe("revision-1");
  expect(overview.nodes.find((node) => node.id === "page-1")?.style).toEqual(page.style);
  expect(overview.nodes.find((node) => node.id === "page-1")?.data.zoomLevel).toBe("overview");
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
        bounds: { x: 32, y: 32, width: 376, height: 284 },
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
    expect(flow.nodes.find((node) => node.id === "page-1")?.position).toEqual({ x: 440, y: 80 });
    expect(new Set(flow.nodes.map((node) => `${node.position.x}:${node.position.y}`)).size).toBe(flow.nodes.length);
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
