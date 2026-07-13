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

function graphWithQuality(quality: unknown): WorkspaceGraph {
  return graphWith({ ...pageNode("page-1"), quality } as unknown as WorkspaceNode);
}

function largeComponentGraph(size: number, cycleTarget?: number): WorkspaceGraph {
  const nodes = new Array<WorkspaceNode>(size);
  const edges: WorkspaceGraph["edges"] = new Array(size - 1 + (cycleTarget === undefined ? 0 : 1));
  for (let index = 0; index < size; index += 1) {
    nodes[index] = componentNode(`component-${index}`);
    if (index > 0) {
      edges[index - 1] = {
        id: `uses-${index - 1}-${index}`,
        workspaceId: WORKSPACE_ID,
        kind: "uses",
        sourceNodeId: `component-${index - 1}`,
        targetNodeId: `component-${index}`,
      };
    }
  }
  if (cycleTarget !== undefined) {
    edges[edges.length - 1] = {
      id: `uses-${size - 1}-${cycleTarget}`,
      workspaceId: WORKSPACE_ID,
      kind: "uses",
      sourceNodeId: `component-${size - 1}`,
      targetNodeId: `component-${cycleTarget}`,
    };
  }
  return { workspaceId: WORKSPACE_ID, revision: 0, nodes, edges };
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

test("graph-resident prototype strings and broken reasons must already be canonical", () => {
  const binding = bindingFixture();
  const nonCanonicalBindings: unknown[] = [
    { ...binding, sourceArtifactId: " artifact-page-1 " },
    { ...binding, sourceRevisionId: " revision-page-1 " },
    { ...binding, sourceLocator: { ...binding.sourceLocator, designNodeId: " checkout-cta " } },
    { ...binding, trigger: " click " },
    { ...binding, targetArtifactId: " artifact-page-2 " },
    { ...binding, targetState: " default " },
    { ...binding, transition: { ...binding.transition, type: " fade " } },
    { ...binding, transition: { ...binding.transition, easing: " ease-in-out " } },
  ];
  for (const candidate of nonCanonicalBindings) {
    const graph = {
      ...graphWith(pageNode("page-1"), pageNode("page-2")),
      edges: [{
        id: "edge-1",
        workspaceId: WORKSPACE_ID,
        kind: "prototype",
        sourceNodeId: "page-1",
        targetNodeId: "page-2",
        prototype: { status: "interactive", binding: candidate },
      }],
    } as unknown as WorkspaceGraph;
    assert.throws(() => validateWorkspaceGraph(graph), WorkspaceGraphValidationError);
  }

  const broken = {
    ...graphWith(pageNode("page-1"), pageNode("page-2")),
    edges: [{
      id: "edge-1",
      workspaceId: WORKSPACE_ID,
      kind: "prototype",
      sourceNodeId: "page-1",
      targetNodeId: "page-2",
      prototype: { status: "broken", brokenReason: " locator missing " },
    }],
  } as unknown as WorkspaceGraph;
  assert.throws(() => validateWorkspaceGraph(broken), WorkspaceGraphValidationError);
});

test("graph revisions are safe integers and cannot advance beyond MAX_SAFE_INTEGER", () => {
  const unsafe = { ...emptyWorkspaceGraph(), revision: Number.MAX_SAFE_INTEGER + 1 };
  assert.throws(() => validateWorkspaceGraph(unsafe), WorkspaceGraphValidationError);

  const exhausted = { ...graphWith(pageNode("page-1")), revision: Number.MAX_SAFE_INTEGER };
  assert.throws(
    () => applyWorkspaceGraphCommands(exhausted, [
      { id: "command-rename", type: "rename-node", nodeId: "page-1", name: "Renamed" },
    ]),
    WorkspaceGraphValidationError,
  );
  assert.equal(exhausted.nodes[0]?.name, "page-1");

  const lastAvailable = { ...graphWith(pageNode("page-1")), revision: Number.MAX_SAFE_INTEGER - 1 };
  const next = applyWorkspaceGraphCommands(lastAvailable, [
    { id: "command-rename", type: "rename-node", nodeId: "page-1", name: "Renamed" },
  ]);
  assert.equal(next.revision, Number.MAX_SAFE_INTEGER);
});

test("standalone normalization rejects duplicate canonical command ids", () => {
  assert.throws(
    () => normalizeWorkspaceGraphCommands([
      { id: " command-1 ", type: "rename-node", nodeId: "page-1", name: "First" },
      { id: "command-1", type: "rename-node", nodeId: "page-1", name: "Second" },
    ]),
    /duplicate command id command-1/,
  );
});

test("object and array accessors are rejected without invocation", () => {
  let getterCalls = 0;
  const command = { id: "command-1", type: "rename-node", nodeId: "page-1" } as Record<string, unknown>;
  Object.defineProperty(command, "name", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "Renamed";
    },
  });
  assert.throws(() => normalizeWorkspaceGraphCommands([command]), WorkspaceGraphValidationError);
  assert.equal(getterCalls, 0);

  const throwing = { type: "rename-node", nodeId: "page-1", name: "Renamed" } as Record<string, unknown>;
  Object.defineProperty(throwing, "id", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("getter escaped");
    },
  });
  assert.throws(() => normalizeWorkspaceGraphCommands([throwing]), WorkspaceGraphValidationError);
  assert.equal(getterCalls, 0);

  const commands: unknown[] = [{ id: "command-1", type: "rename-node", nodeId: "page-1", name: "Renamed" }];
  const first = commands[0];
  Object.defineProperty(commands, "0", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return first;
    },
  });
  assert.throws(() => normalizeWorkspaceGraphCommands(commands), WorkspaceGraphValidationError);
  assert.equal(getterCalls, 0);
});

test("boundary decoding does not invoke inherited array accessors", () => {
  const mapDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "map");
  let result: ReturnType<typeof normalizeWorkspaceGraphCommands> | undefined;
  let escaped: unknown;
  Object.defineProperty(Array.prototype, "map", {
    configurable: true,
    get() {
      throw new Error("inherited map getter invoked");
    },
  });
  try {
    try {
      result = normalizeWorkspaceGraphCommands([
        { id: "command-1", type: "rename-node", nodeId: "page-1", name: "Renamed" },
      ]);
    } catch (error) {
      escaped = error;
    }
  } finally {
    if (mapDescriptor) Object.defineProperty(Array.prototype, "map", mapDescriptor);
  }
  if (escaped) throw escaped;
  assert.deepEqual(result, [
    { id: "command-1", type: "rename-node", nodeId: "page-1", name: "Renamed" },
  ]);
});

test("revoked proxies are reported as graph validation errors", () => {
  const commandBatch = Proxy.revocable([], {});
  commandBatch.revoke();
  assert.throws(
    () => normalizeWorkspaceGraphCommands(commandBatch.proxy),
    WorkspaceGraphValidationError,
  );

  const graph = Proxy.revocable(emptyWorkspaceGraph(), {});
  graph.revoke();
  assert.throws(() => validateWorkspaceGraph(graph.proxy), WorkspaceGraphValidationError);
});

test("required command fields cannot come from Object.prototype", () => {
  const existing = Object.getOwnPropertyDescriptor(Object.prototype, "type");
  let getterCalls = 0;
  Object.defineProperty(Object.prototype, "type", {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      return "rename-node";
    },
  });
  try {
    assert.throws(
      () => normalizeWorkspaceGraphCommands([{ id: "command-1", nodeId: "page-1", name: "Renamed" }]),
      WorkspaceGraphValidationError,
    );
    assert.equal(getterCalls, 0);
  } finally {
    if (existing) Object.defineProperty(Object.prototype, "type", existing);
    else delete (Object.prototype as { type?: unknown }).type;
  }
});

test("symbol and non-enumerable fields are rejected on objects and arrays", () => {
  const symbolCommand = { id: "command-1", type: "rename-node", nodeId: "page-1", name: "Renamed" };
  Object.defineProperty(symbolCommand, Symbol("extra"), { value: true, enumerable: true });
  assert.throws(() => normalizeWorkspaceGraphCommands([symbolCommand]), WorkspaceGraphValidationError);

  const hiddenCommand = { id: "command-1", type: "rename-node", nodeId: "page-1", name: "Renamed" };
  Object.defineProperty(hiddenCommand, "sourceRoot", { value: "/tmp/client-root", enumerable: false });
  assert.throws(() => normalizeWorkspaceGraphCommands([hiddenCommand]), WorkspaceGraphValidationError);

  const commands = [{ id: "command-1", type: "rename-node", nodeId: "page-1", name: "Renamed" }];
  Object.defineProperty(commands, Symbol("extra"), { value: true, enumerable: true });
  assert.throws(() => normalizeWorkspaceGraphCommands(commands), WorkspaceGraphValidationError);
});

test("graph accessors are rejected without invocation", () => {
  let getterCalls = 0;
  const graph = { workspaceId: WORKSPACE_ID, nodes: [], edges: [] } as Record<string, unknown>;
  Object.defineProperty(graph, "revision", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 0;
    },
  });

  assert.throws(() => validateWorkspaceGraph(graph), WorkspaceGraphValidationError);
  assert.equal(getterCalls, 0);
});

test("graph root, nodes, and edges reject unknown fields", () => {
  assert.throws(
    () => validateWorkspaceGraph({ ...emptyWorkspaceGraph(), extra: true }),
    WorkspaceGraphValidationError,
  );
  assert.throws(
    () => validateWorkspaceGraph(graphWith(
      { ...pageNode("page-1"), sourceRoot: "/tmp/client-root" } as unknown as WorkspaceNode,
    )),
    WorkspaceGraphValidationError,
  );
  const graphWithExtraEdge = {
    ...graphWith(pageNode("page-1"), pageNode("page-2")),
    edges: [{
      id: "edge-1",
      workspaceId: WORKSPACE_ID,
      kind: "prototype",
      sourceNodeId: "page-1",
      targetNodeId: "page-2",
      prototype: { status: "planned" },
      extra: true,
    }],
  } as unknown as WorkspaceGraph;
  assert.throws(() => validateWorkspaceGraph(graphWithExtraEdge), WorkspaceGraphValidationError);
});

test("artifact quality codec reconstructs valid summaries without trimming content", () => {
  const quality = Object.freeze({
    state: "needs-attention" as const,
    score: 82.5,
    findings: Object.freeze([Object.freeze({
      severity: "P1" as const,
      id: "finding-1",
      message: "  preserve message whitespace  ",
      fix: "  preserve fix whitespace  ",
      snippet: "  <button>Buy</button>  ",
      selector: "  [data-buy]  ",
      screenshotPath: "  screenshots/buy.png  ",
      screenshotUrl: "  https://example.test/buy.png  ",
      reviewSummary: "  needs another pass  ",
      reviewStatus: "active" as const,
      reviewRound: 2,
      corroborated: false,
    })]),
  });
  const graph = graphWithQuality(quality);
  const before = structuredClone(graph);

  const next = applyWorkspaceGraphCommands(graph, [
    { id: "command-rename", type: "rename-node", nodeId: "page-1", name: "Renamed" },
  ]);

  assert.deepEqual(graph, before);
  const qualityNode = next.nodes[0];
  assert.ok(qualityNode?.kind === "page");
  assert.deepEqual(qualityNode.quality, quality);
  assert.doesNotThrow(() => validateWorkspaceGraph(graphWithQuality({
    state: "unassessed",
    score: null,
    findings: [],
  })));
});

test("artifact quality summary rejects missing, unknown, and invalid fields", () => {
  const sparseFindings = new Array(1);
  const invalidSummaries: unknown[] = [
    null,
    [],
    { state: "unassessed", score: null, findings: [], extra: true },
    { score: null, findings: [] },
    { state: undefined, score: null, findings: [] },
    { state: " passed ", score: null, findings: [] },
    { state: "unknown", score: null, findings: [] },
    { state: "passed", findings: [] },
    { state: "passed", score: undefined, findings: [] },
    { state: "passed", score: Number.NaN, findings: [] },
    { state: "passed", score: Number.POSITIVE_INFINITY, findings: [] },
    { state: "passed", score: "100", findings: [] },
    { state: "passed", score: null },
    { state: "passed", score: null, findings: undefined },
    { state: "passed", score: null, findings: {} },
    { state: "passed", score: null, findings: sparseFindings },
  ];

  for (const quality of invalidSummaries) {
    assert.throws(() => validateWorkspaceGraph(graphWithQuality(quality)), WorkspaceGraphValidationError);
  }
});

test("artifact quality findings enforce the complete core contract", () => {
  const validFinding = {
    severity: "P2",
    id: "finding-1",
    message: "message",
    fix: "fix",
  };
  const invalidFindings: unknown[] = [
    null,
    [],
    { ...validFinding, extra: true },
    { id: "finding-1", message: "message", fix: "fix" },
    { severity: "P2", message: "message", fix: "fix" },
    { severity: "P2", id: "finding-1", fix: "fix" },
    { severity: "P2", id: "finding-1", message: "message" },
    { ...validFinding, severity: undefined },
    { ...validFinding, severity: " P2 " },
    { ...validFinding, severity: "P3" },
    { ...validFinding, id: undefined },
    { ...validFinding, id: " finding-1 " },
    { ...validFinding, id: "" },
    { ...validFinding, message: undefined },
    { ...validFinding, message: 1 },
    { ...validFinding, fix: undefined },
    { ...validFinding, fix: false },
    { ...validFinding, snippet: undefined },
    { ...validFinding, selector: 1 },
    { ...validFinding, screenshotPath: null },
    { ...validFinding, screenshotUrl: false },
    { ...validFinding, reviewSummary: 1 },
    { ...validFinding, reviewStatus: undefined },
    { ...validFinding, reviewStatus: " active " },
    { ...validFinding, reviewStatus: "pending" },
    { ...validFinding, reviewRound: undefined },
    { ...validFinding, reviewRound: -1 },
    { ...validFinding, reviewRound: 1.5 },
    { ...validFinding, reviewRound: Number.MAX_SAFE_INTEGER + 1 },
    { ...validFinding, corroborated: undefined },
    { ...validFinding, corroborated: "true" },
  ];

  for (const finding of invalidFindings) {
    const quality = { state: "failed", score: 0, findings: [finding] };
    assert.throws(() => validateWorkspaceGraph(graphWithQuality(quality)), WorkspaceGraphValidationError);
  }
});

test("component dependency validation accepts a 5,000-node acyclic chain", () => {
  assert.doesNotThrow(() => validateWorkspaceGraph(largeComponentGraph(5_000)));
});

test("component dependency validation reports a deep cycle as a graph validation error", () => {
  assert.throws(
    () => validateWorkspaceGraph(largeComponentGraph(5_000, 2_500)),
    WorkspaceGraphValidationError,
  );
});

test("frozen and null-prototype JSON-shaped commands remain accepted", () => {
  const frozen = Object.freeze({ id: "command-1", type: "rename-node", nodeId: "page-1", name: "Renamed" });
  const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, {
    id: "command-2",
    type: "archive-node",
    nodeId: "page-2",
  });
  assert.deepEqual(normalizeWorkspaceGraphCommands([frozen, nullPrototype]), [
    { id: "command-1", type: "rename-node", nodeId: "page-1", name: "Renamed" },
    { id: "command-2", type: "archive-node", nodeId: "page-2" },
  ]);
});
