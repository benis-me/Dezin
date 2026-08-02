import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Viewport } from "@xyflow/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { DesignCanvasApi } from "./api.ts";
import { DesignCanvasScreen } from "./DesignCanvasScreen.tsx";
import type {
  DesignAgentTurnResult,
  DesignCanvas,
  DesignCanvasIntent,
  DesignJob,
  DesignNode,
  DesignThread,
} from "./types.ts";

const flowHarness = vi.hoisted(() => ({
  props: null as Record<string, any> | null,
  viewport: { x: 0, y: 0, zoom: 1 },
  setViewport: vi.fn(),
}));

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  const React = await import("react");
  const instance = {
    getViewport: () => ({ ...flowHarness.viewport }),
    getZoom: () => flowHarness.viewport.zoom,
    setViewport: async (viewport: Viewport, options?: unknown) => {
      flowHarness.viewport = { ...viewport };
      flowHarness.setViewport(viewport, options);
      flowHarness.props?.onMove?.(null, viewport);
      flowHarness.props?.onMoveEnd?.(null, viewport);
      return true;
    },
    screenToFlowPosition: (point: { x: number; y: number }) => point,
    zoomIn: async () => true,
    zoomOut: async () => true,
    fitView: async () => true,
  };
  function ReactFlowMock(props: Record<string, any>) {
    flowHarness.props = props;
    React.useEffect(() => {
      props.onInit?.(instance);
    }, []);
    return React.createElement("div", { "data-testid": "mock-react-flow" });
  }
  return {
    ...actual,
    ReactFlow: ReactFlowMock,
    Background: () => null,
  };
});

const PROJECT_ID = "interaction-project";

function designNode(id: string, x: number): DesignNode {
  return {
    id,
    kind: "page",
    name: id === "page-a" ? "Page A" : "Page B",
    geometry: { x, y: 80, width: 480, height: 360 },
    state: "empty",
    currentVersionId: null,
    selectedVersionId: null,
    versionCount: 0,
    assetId: null,
    activeJobId: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function designCanvas(nodes: DesignNode[], revision = 1, viewport: Viewport = { x: 0, y: 0, zoom: 1 }): DesignCanvas {
  return {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    revision,
    viewport,
    nodeOrder: nodes.map((node) => node.id),
    nodes,
    undoDepth: revision > 1 ? 1 : 0,
    redoDepth: 0,
    createdAt: 1,
    updatedAt: revision,
  };
}

const thread: DesignThread = {
  id: "thread-main",
  scope: { type: "main" },
  messages: [],
  createdAt: 1,
  updatedAt: 1,
};

const mainJob: DesignJob = {
  id: "main-job",
  kind: "main-agent",
  status: "ready",
  nodeId: null,
  parentJobId: null,
  contextHash: "context",
  versionId: null,
  exportId: null,
  error: null,
  activity: [],
  createdAt: 1,
  updatedAt: 1,
  finishedAt: 1,
};

function createApi(initial: DesignCanvas, mainAgentViewport?: Viewport) {
  let current = initial;
  const applyIntents = vi.fn(async (_projectId: string, request: { baseRevision: number; intents: readonly DesignCanvasIntent[] }) => {
    let nodes = current.nodes;
    let viewport = current.viewport;
    for (const intent of request.intents) {
      if (intent.type === "update-node") {
        nodes = nodes.map((node) => node.id === intent.nodeId
          ? { ...node, geometry: { ...node.geometry, ...intent.patch.geometry } }
          : node);
      } else if (intent.type === "set-viewport") {
        viewport = { ...intent.viewport };
      }
    }
    current = designCanvas(nodes, request.baseRevision + 1, viewport);
    return current;
  });
  const submitAgentTurn = vi.fn(async (): Promise<DesignAgentTurnResult> => {
    if (mainAgentViewport) current = designCanvas(current.nodes, current.revision + 1, mainAgentViewport);
    return { thread, job: mainJob, canvas: current };
  });
  const api: DesignCanvasApi = {
    getCanvas: vi.fn(async () => current),
    applyIntents,
    undo: vi.fn(async () => current),
    redo: vi.fn(async () => current),
    importLocalFiles: vi.fn(async () => current),
    importProjectVersion: vi.fn(async () => current),
    listNodeVersions: vi.fn(async () => []),
    getExactVersionPreview: vi.fn(async (_projectId, nodeId, versionId) => ({ nodeId, versionId, url: "about:blank" })),
    getAssetPreviewUrl: vi.fn(() => "about:blank"),
    getThread: vi.fn(async (_projectId, scope) => ({ ...thread, scope })),
    submitAgentTurn,
    listJobs: vi.fn(async () => []),
    cancelJob: vi.fn(async () => mainJob),
    startImplementationExport: vi.fn(async () => ({ exportId: "export", job: mainJob })),
  };
  return { api, applyIntents };
}

beforeEach(() => {
  flowHarness.props = null;
  flowHarness.viewport = { x: 0, y: 0, zoom: 1 };
  flowHarness.setViewport.mockClear();
});

afterEach(() => {
  vi.clearAllTimers();
});

test("completed multi-select drags persist one geometry batch and keyboard position changes do not need drag-stop", async () => {
  const nodeA = designNode("page-a", 80);
  const nodeB = designNode("page-b", 620);
  const { api, applyIntents } = createApi(designCanvas([nodeA, nodeB]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Interactions" api={api} />);
  await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(2));

  act(() => {
    flowHarness.props?.onNodesChange?.([
      { type: "position", id: nodeA.id, position: { x: 180, y: 140 }, dragging: true },
      { type: "position", id: nodeB.id, position: { x: 720, y: 140 }, dragging: true },
    ]);
  });
  expect(applyIntents).not.toHaveBeenCalled();
  act(() => {
    flowHarness.props?.onNodesChange?.([
      { type: "position", id: nodeA.id, position: { x: 200, y: 160 }, dragging: false },
      { type: "position", id: nodeB.id, position: { x: 740, y: 160 }, dragging: false },
    ]);
    flowHarness.props?.onNodeDragStop?.(null, flowHarness.props.nodes[0]);
  });

  await waitFor(() => expect(applyIntents).toHaveBeenCalledTimes(1));
  expect(applyIntents.mock.calls[0]?.[1].intents).toEqual([
    { type: "update-node", nodeId: nodeA.id, patch: { geometry: { x: 200, y: 160, width: 480, height: 360 } } },
    { type: "update-node", nodeId: nodeB.id, patch: { geometry: { x: 740, y: 160, width: 480, height: 360 } } },
  ]);

  applyIntents.mockClear();
  act(() => {
    flowHarness.props?.onNodesChange?.([
      { type: "position", id: nodeA.id, position: { x: 208, y: 160 }, dragging: false },
    ]);
  });
  await waitFor(() => expect(applyIntents).toHaveBeenCalledTimes(1));
  expect(applyIntents.mock.calls[0]?.[1].intents).toEqual([
    { type: "update-node", nodeId: nodeA.id, patch: { geometry: { x: 208, y: 160, width: 480, height: 360 } } },
  ]);
});

test("authoritative Main Agent viewport drives the mounted flow while a local pan acknowledgement does not loop", async () => {
  const backendViewport = { x: 48, y: -32, zoom: 1.75 };
  const { api, applyIntents } = createApi(designCanvas([designNode("page-a", 80)]), backendViewport);
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Interactions" api={api} />);
  await waitFor(() => expect(flowHarness.props).not.toBeNull());

  const localViewport = { x: 18, y: 24, zoom: 1.2 };
  act(() => {
    flowHarness.viewport = { ...localViewport };
    flowHarness.props?.onMove?.(null, localViewport);
    flowHarness.props?.onMoveEnd?.(null, localViewport);
  });
  await waitFor(() => expect(applyIntents).toHaveBeenCalledTimes(1), { timeout: 1_000 });
  expect(applyIntents.mock.calls[0]?.[1].intents).toEqual([{ type: "set-viewport", viewport: localViewport }]);
  expect(flowHarness.setViewport).not.toHaveBeenCalled();

  applyIntents.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Main Agent" }));
  fireEvent.change(await screen.findByRole("textbox", { name: "Main Agent message" }), { target: { value: "Reframe the canvas" } });
  fireEvent.click(screen.getByRole("button", { name: "Send to Main Agent" }));

  await waitFor(() => expect(flowHarness.setViewport).toHaveBeenCalledWith(backendViewport, { duration: 0 }));
  expect(flowHarness.viewport).toEqual(backendViewport);
  expect(screen.getByText("175%")).toBeInTheDocument();
  await new Promise((resolve) => window.setTimeout(resolve, 240));
  expect(applyIntents).not.toHaveBeenCalled();
});
