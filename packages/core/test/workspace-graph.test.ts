import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WorkspaceGraphValidationError,
  applyWorkspaceGraphCommands,
  normalizeWorkspaceGraphCommands,
  validateWorkspaceGraph,
  type NewWorkspaceEdge,
  type PrototypeBinding,
  type WorkspaceGraph,
  type WorkspaceGraphCommand,
  type WorkspaceNode,
} from "../src/index.ts";

const WORKSPACE_ID = "workspace-1";

function emptyWorkspaceGraph(workspaceId = WORKSPACE_ID): WorkspaceGraph {
  return { workspaceId, revision: 0, nodes: [], edges: [] };
}

function pageNode(id: string, workspaceId = WORKSPACE_ID): WorkspaceNode {
  return { id, workspaceId, kind: "page", name: id, artifactId: `artifact-${id}` };
}

function componentNode(id: string, workspaceId = WORKSPACE_ID): WorkspaceNode {
  return { id, workspaceId, kind: "component", name: id, artifactId: `artifact-${id}` };
}

function resourceNode(id: string, workspaceId = WORKSPACE_ID): WorkspaceNode {
  return { id, workspaceId, kind: "resource", name: id, resourceId: `resource-${id}` };
}

function graphWith(...nodes: WorkspaceNode[]): WorkspaceGraph {
  return { workspaceId: WORKSPACE_ID, revision: 0, nodes, edges: [] };
}

function addEdgeCommand(id: string, edge: NewWorkspaceEdge): WorkspaceGraphCommand {
  return { id, type: "add-edge", edge };
}

function prototypeCommand(sourceNodeId: string, targetNodeId: string, id = "command-prototype"): WorkspaceGraphCommand {
  return addEdgeCommand(id, {
    id: `edge-${sourceNodeId}-${targetNodeId}`,
    workspaceId: WORKSPACE_ID,
    kind: "prototype",
    sourceNodeId,
    targetNodeId,
  });
}

function normalizeCommands(input: unknown): WorkspaceGraphCommand[] {
  return normalizeWorkspaceGraphCommands(input);
}

function bindingFixture(): PrototypeBinding {
  return {
    sourceArtifactId: "artifact-page-1",
    sourceRevisionId: "revision-page-1",
    sourceLocator: { designNodeId: "checkout-cta" },
    trigger: "click",
    targetArtifactId: "artifact-page-2",
    targetState: "default",
    transition: { type: "fade", durationMs: 180 },
  };
}

test("adds, renames, and archives nodes without mutating the input graph", () => {
  const graph = graphWith(pageNode("page-existing"));
  const next = applyWorkspaceGraphCommands(graph, [
    {
      id: "command-add",
      type: "add-node",
      node: {
        id: "page-new",
        kind: "page",
        name: "Draft",
        artifactId: "artifact-page-new",
        createIdentity: { initialTrackId: "track-main" },
      },
    },
    { id: "command-rename", type: "rename-node", nodeId: "page-new", name: "Checkout" },
    { id: "command-archive", type: "archive-node", nodeId: "page-existing" },
  ]);

  assert.equal(graph.revision, 0);
  assert.deepEqual(graph.nodes.map((node) => node.id), ["page-existing"]);
  assert.equal(next.revision, 1);
  assert.deepEqual(next.nodes, [
    {
      id: "page-new",
      workspaceId: WORKSPACE_ID,
      kind: "page",
      name: "Checkout",
      artifactId: "artifact-page-new",
    },
  ]);
});

test("a command batch is atomic and rejects duplicate command ids", () => {
  const graph = emptyWorkspaceGraph();
  const commands: WorkspaceGraphCommand[] = [
    {
      id: "command-1",
      type: "add-node",
      node: { id: "page-1", kind: "page", name: "Page", artifactId: "artifact-page-1" },
    },
    { id: "command-1", type: "rename-node", nodeId: "page-1", name: "Renamed" },
  ];

  assert.throws(() => applyWorkspaceGraphCommands(graph, commands), /duplicate command id/);
  assert.deepEqual(graph, emptyWorkspaceGraph());
});

test("uses edges are derived and cannot be inserted or removed manually", () => {
  const graph = graphWith(pageNode("page-1"), componentNode("component-1"));
  assert.throws(
    () => applyWorkspaceGraphCommands(graph, [
      addEdgeCommand("command-add", {
        id: "edge-1",
        workspaceId: WORKSPACE_ID,
        kind: "uses",
        sourceNodeId: "page-1",
        targetNodeId: "component-1",
      }),
    ]),
    /uses edges are derived/,
  );

  const graphWithDerivedEdge: WorkspaceGraph = {
    ...graph,
    edges: [{
      id: "edge-1",
      workspaceId: WORKSPACE_ID,
      kind: "uses",
      sourceNodeId: "page-1",
      targetNodeId: "component-1",
    }],
  };
  assert.throws(
    () => applyWorkspaceGraphCommands(graphWithDerivedEdge, [{ id: "command-remove", type: "remove-edge", edgeId: "edge-1" }]),
    /uses edges are derived/,
  );
});

test("prototype edges only connect pages and start planned", () => {
  const pageAndComponent = graphWith(pageNode("page-1"), componentNode("component-1"));
  assert.throws(
    () => applyWorkspaceGraphCommands(pageAndComponent, [prototypeCommand("page-1", "component-1")]),
    /page to page/,
  );

  const twoPages = graphWith(pageNode("page-1"), pageNode("page-2"));
  const next = applyWorkspaceGraphCommands(twoPages, [prototypeCommand("page-1", "page-2")]);
  assert.equal(next.edges[0]?.prototype?.status, "planned");
});

test("prototype cycles are valid", () => {
  const graph = graphWith(pageNode("page-1"), pageNode("page-2"));
  const next = applyWorkspaceGraphCommands(graph, [
    prototypeCommand("page-1", "page-2", "command-forward"),
    prototypeCommand("page-2", "page-1", "command-back"),
  ]);

  assert.equal(next.edges.length, 2);
  assert.doesNotThrow(() => validateWorkspaceGraph(next));
});

test("component uses dependencies cannot form a cycle", () => {
  const graph: WorkspaceGraph = {
    ...graphWith(componentNode("component-1"), componentNode("component-2")),
    edges: [
      {
        id: "uses-1",
        workspaceId: WORKSPACE_ID,
        kind: "uses",
        sourceNodeId: "component-1",
        targetNodeId: "component-2",
      },
      {
        id: "uses-2",
        workspaceId: WORKSPACE_ID,
        kind: "uses",
        sourceNodeId: "component-2",
        targetNodeId: "component-1",
      },
    ],
  };

  assert.throws(() => validateWorkspaceGraph(graph), /component dependency cycle/);
});

test("edge directions reflect prototype, uses, informs, and derives-from semantics", () => {
  const nodes = [pageNode("page-1"), componentNode("component-1"), resourceNode("resource-1")];
  const valid: WorkspaceGraph = {
    ...graphWith(...nodes),
    edges: [
      {
        id: "prototype-1",
        workspaceId: WORKSPACE_ID,
        kind: "prototype",
        sourceNodeId: "page-1",
        targetNodeId: "page-1",
        prototype: { status: "planned" },
      },
      {
        id: "uses-1",
        workspaceId: WORKSPACE_ID,
        kind: "uses",
        sourceNodeId: "page-1",
        targetNodeId: "component-1",
      },
      {
        id: "informs-1",
        workspaceId: WORKSPACE_ID,
        kind: "informs",
        sourceNodeId: "resource-1",
        targetNodeId: "page-1",
      },
      {
        id: "derives-1",
        workspaceId: WORKSPACE_ID,
        kind: "derives-from",
        sourceNodeId: "component-1",
        targetNodeId: "resource-1",
      },
    ],
  };
  assert.doesNotThrow(() => validateWorkspaceGraph(valid));

  const reversedInforms: WorkspaceGraph = {
    ...graphWith(...nodes),
    edges: [{
      id: "informs-1",
      workspaceId: WORKSPACE_ID,
      kind: "informs",
      sourceNodeId: "page-1",
      targetNodeId: "resource-1",
    }],
  };
  assert.throws(() => validateWorkspaceGraph(reversedInforms), /resource to page or component/);
});

test("graph validation rejects foreign ownership and missing endpoints", () => {
  const foreignNode = graphWith(pageNode("page-1", "workspace-2"));
  assert.throws(() => validateWorkspaceGraph(foreignNode), /node .* belongs to workspace/);

  const missingEndpoint: WorkspaceGraph = {
    ...graphWith(pageNode("page-1")),
    edges: [{
      id: "edge-1",
      workspaceId: WORKSPACE_ID,
      kind: "prototype",
      sourceNodeId: "page-1",
      targetNodeId: "page-missing",
      prototype: { status: "planned" },
    }],
  };
  assert.throws(() => validateWorkspaceGraph(missingEndpoint), /target node .* does not exist/);
});

test("graph validation rejects duplicate ids and mismatched node identities", () => {
  const duplicateNodes = graphWith(pageNode("page-1"), { ...componentNode("component-1"), id: "page-1" });
  assert.throws(() => validateWorkspaceGraph(duplicateNodes), /duplicate node id/);

  const invalidIdentity = graphWith({
    id: "resource-1",
    workspaceId: WORKSPACE_ID,
    kind: "resource",
    name: "Resource",
    artifactId: "artifact-not-allowed",
  } as unknown as WorkspaceNode);
  assert.throws(() => validateWorkspaceGraph(invalidIdentity), /resource node .* resourceId/);
});

test("prototype bindings make an existing planned edge interactive", () => {
  const graph = applyWorkspaceGraphCommands(
    graphWith(pageNode("page-1"), pageNode("page-2")),
    [prototypeCommand("page-1", "page-2")],
  );
  const binding: PrototypeBinding = {
    sourceArtifactId: "artifact-page-1",
    sourceRevisionId: "revision-page-1",
    sourceLocator: { designNodeId: "checkout-cta" },
    trigger: "click",
    targetArtifactId: "artifact-page-2",
    targetState: "default",
    transition: { type: "fade", durationMs: 180 },
  };

  const next = applyWorkspaceGraphCommands(graph, [{
    id: "command-bind",
    type: "bind-prototype",
    edgeId: "edge-page-1-page-2",
    binding,
  }]);

  assert.deepEqual(next.edges[0]?.prototype, { status: "interactive", binding });
});

test("commands reject missing targets and duplicate graph identities", () => {
  const graph = graphWith(pageNode("page-1"));
  assert.throws(
    () => applyWorkspaceGraphCommands(graph, [{ id: "command-rename", type: "rename-node", nodeId: "missing", name: "Nope" }]),
    WorkspaceGraphValidationError,
  );
  assert.throws(
    () => applyWorkspaceGraphCommands(graph, [{
      id: "command-add",
      type: "add-node",
      node: { id: "page-2", kind: "page", name: "Duplicate identity", artifactId: "artifact-page-1" },
    }]),
    /duplicate artifact identity/,
  );
});

test("normalizes graph commands deeply without mutating the untrusted input", () => {
  const input = [
    {
      id: " command-add-resource ",
      type: " add-node ",
      node: {
        id: " resource-node ",
        kind: " resource ",
        name: " Research library ",
        resourceId: " resource-1 ",
        createIdentity: {
          resourceKind: " research ",
          defaultPinPolicy: " follow-head ",
        },
      },
    },
    {
      id: " command-bind ",
      type: " bind-prototype ",
      edgeId: " edge-1 ",
      binding: {
        sourceArtifactId: " artifact-page-1 ",
        sourceRevisionId: " revision-page-1 ",
        sourceLocator: {
          designNodeId: " checkout-cta ",
          sourcePath: " src/Page.tsx ",
          selector: " [data-dezin-id='checkout-cta'] ",
        },
        trigger: " click ",
        targetArtifactId: " artifact-page-2 ",
        targetState: " default ",
        transition: { type: " fade ", durationMs: 180, easing: " ease-in-out " },
      },
    },
  ];
  const before = structuredClone(input);

  const normalized = normalizeCommands(input);

  assert.deepEqual(input, before);
  assert.notStrictEqual(normalized, input);
  assert.deepEqual(normalized, [
    {
      id: "command-add-resource",
      type: "add-node",
      node: {
        id: "resource-node",
        kind: "resource",
        name: "Research library",
        resourceId: "resource-1",
        createIdentity: { resourceKind: "research", defaultPinPolicy: "follow-head" },
      },
    },
    {
      id: "command-bind",
      type: "bind-prototype",
      edgeId: "edge-1",
      binding: {
        sourceArtifactId: "artifact-page-1",
        sourceRevisionId: "revision-page-1",
        sourceLocator: {
          designNodeId: "checkout-cta",
          sourcePath: "src/Page.tsx",
          selector: "[data-dezin-id='checkout-cta']",
        },
        trigger: "click",
        targetArtifactId: "artifact-page-2",
        targetState: "default",
        transition: { type: "fade", durationMs: 180, easing: "ease-in-out" },
      },
    },
  ]);
});

test("normalization rejects unknown fields throughout the command payload", () => {
  const page = {
    id: "page-1",
    kind: "page",
    name: "Page",
    artifactId: "artifact-page-1",
    createIdentity: { initialTrackId: "track-main" },
  };
  const binding = bindingFixture();
  const cases: unknown[] = [
    [{ id: "command-1", type: "rename-node", nodeId: "page-1", name: "Page", extra: true }],
    [{ id: "command-1", type: "add-node", node: { ...page, sourceRoot: "/tmp/client-root" } }],
    [{ id: "command-1", type: "add-node", node: { ...page, createIdentity: { ...page.createIdentity, extra: true } } }],
    [{
      id: "command-1",
      type: "add-edge",
      edge: {
        id: "edge-1",
        workspaceId: WORKSPACE_ID,
        kind: "prototype",
        sourceNodeId: "page-1",
        targetNodeId: "page-2",
        prototype: { status: "interactive" },
      },
    }],
    [{ id: "command-1", type: "bind-prototype", edgeId: "edge-1", binding: { ...binding, extra: true } }],
    [{
      id: "command-1",
      type: "bind-prototype",
      edgeId: "edge-1",
      binding: { ...binding, sourceLocator: { ...binding.sourceLocator, xpath: "//button" } },
    }],
    [{
      id: "command-1",
      type: "bind-prototype",
      edgeId: "edge-1",
      binding: { ...binding, transition: { ...binding.transition, unsafe: true } },
    }],
  ];

  for (const commands of cases) {
    assert.throws(() => normalizeCommands(commands), /unexpected field/);
  }
});

test("normalization rejects malformed nested command objects and required fields", () => {
  const cases: unknown[] = [
    [null],
    [{ id: "command-1", type: "add-node", node: null }],
    [{
      id: "command-1",
      type: "add-node",
      node: {
        id: "page-1",
        kind: "page",
        name: "Page",
        artifactId: "artifact-page-1",
        createIdentity: {},
      },
    }],
    [{
      id: "command-1",
      type: "add-edge",
      edge: { id: "edge-1", workspaceId: WORKSPACE_ID, kind: "prototype", sourceNodeId: "page-1" },
    }],
    [{
      id: "command-1",
      type: "bind-prototype",
      edgeId: "edge-1",
      binding: { ...bindingFixture(), sourceLocator: null },
    }],
  ];

  for (const commands of cases) {
    assert.throws(() => normalizeCommands(commands), WorkspaceGraphValidationError);
  }
});

test("apply rejects malformed and empty batches without advancing the graph", () => {
  const graph = graphWith(pageNode("page-1"));
  const applyUntrusted = (commands: unknown): WorkspaceGraph => applyWorkspaceGraphCommands(graph, commands);
  const invalidBatches: unknown[] = [
    null,
    {},
    [],
    Array(1),
    [null],
    [{ id: "command-unknown", type: "explode" }],
  ];

  for (const commands of invalidBatches) {
    assert.throws(() => applyUntrusted(commands), WorkspaceGraphValidationError);
  }
  assert.equal(graph.revision, 0);
  assert.deepEqual(graph.nodes, [pageNode("page-1")]);
});

test("apply detects duplicate command ids after canonical trimming", () => {
  const graph = graphWith(pageNode("page-1"));
  assert.throws(
    () => applyWorkspaceGraphCommands(graph, [
      { id: " command-1 ", type: "rename-node", nodeId: "page-1", name: "First" },
      { id: "command-1", type: "rename-node", nodeId: "page-1", name: "Second" },
    ]),
    /duplicate command id command-1/,
  );
  assert.equal(graph.nodes[0]?.name, "page-1");
});

test("graph validation wraps null, non-object, and invalid collection inputs", () => {
  const validateUntrusted = validateWorkspaceGraph as (graph: unknown) => void;
  const invalidGraphs: unknown[] = [
    null,
    "workspace",
    [],
    { workspaceId: WORKSPACE_ID, revision: 0, nodes: null, edges: [] },
    { workspaceId: WORKSPACE_ID, revision: 0, nodes: [], edges: {} },
    { workspaceId: WORKSPACE_ID, revision: 0, nodes: Array(1), edges: [] },
  ];

  for (const graph of invalidGraphs) {
    assert.throws(() => validateUntrusted(graph), WorkspaceGraphValidationError);
  }
});

test("planned prototype edges reject bindings and broken reasons", () => {
  const base = {
    id: "edge-1",
    workspaceId: WORKSPACE_ID,
    kind: "prototype",
    sourceNodeId: "page-1",
    targetNodeId: "page-2",
  };
  const nodes = [pageNode("page-1"), pageNode("page-2")];
  for (const prototype of [
    { status: "planned", binding: bindingFixture() },
    { status: "planned", brokenReason: "old locator is missing" },
  ]) {
    const graph = { ...graphWith(...nodes), edges: [{ ...base, prototype }] } as unknown as WorkspaceGraph;
    assert.throws(() => validateWorkspaceGraph(graph), WorkspaceGraphValidationError);
  }
});

test("interactive prototype edges require only a valid binding payload", () => {
  const base = {
    id: "edge-1",
    workspaceId: WORKSPACE_ID,
    kind: "prototype",
    sourceNodeId: "page-1",
    targetNodeId: "page-2",
  };
  const nodes = [pageNode("page-1"), pageNode("page-2")];
  const missingBinding = {
    ...graphWith(...nodes),
    edges: [{ ...base, prototype: { status: "interactive" } }],
  } as unknown as WorkspaceGraph;
  const mixedState = {
    ...graphWith(...nodes),
    edges: [{ ...base, prototype: { status: "interactive", binding: bindingFixture(), brokenReason: "stale" } }],
  } as unknown as WorkspaceGraph;

  assert.throws(() => validateWorkspaceGraph(missingBinding), /requires a binding/);
  assert.throws(() => validateWorkspaceGraph(mixedState), WorkspaceGraphValidationError);
});

test("broken prototype edges require a reason and may retain the old binding", () => {
  const base = {
    id: "edge-1",
    workspaceId: WORKSPACE_ID,
    kind: "prototype",
    sourceNodeId: "page-1",
    targetNodeId: "page-2",
  };
  const nodes = [pageNode("page-1"), pageNode("page-2")];
  for (const brokenReason of [undefined, "   "]) {
    const graph = {
      ...graphWith(...nodes),
      edges: [{ ...base, prototype: { status: "broken", brokenReason } }],
    } as unknown as WorkspaceGraph;
    assert.throws(() => validateWorkspaceGraph(graph), WorkspaceGraphValidationError);
  }

  const valid = {
    ...graphWith(...nodes),
    edges: [{
      ...base,
      prototype: { status: "broken", brokenReason: "source locator is missing", binding: bindingFixture() },
    }],
  } as WorkspaceGraph;
  assert.doesNotThrow(() => validateWorkspaceGraph(valid));
});

test("non-prototype edges reject prototype payloads", () => {
  const graph = {
    ...graphWith(pageNode("page-1"), componentNode("component-1")),
    edges: [{
      id: "uses-1",
      workspaceId: WORKSPACE_ID,
      kind: "uses",
      sourceNodeId: "page-1",
      targetNodeId: "component-1",
      prototype: { status: "planned" },
    }],
  } as unknown as WorkspaceGraph;

  assert.throws(() => validateWorkspaceGraph(graph), WorkspaceGraphValidationError);
});
