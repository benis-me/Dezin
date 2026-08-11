import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Viewport } from "@xyflow/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { AgentInfo } from "../lib/api.ts";
import { ApiProvider } from "../lib/api-context.tsx";
import { ToastProvider } from "../components/Toast.tsx";
import { makeFakeApi } from "../test/fake-api.ts";
import type { DesignCanvasApi } from "./api.ts";
import { DesignCanvasScreen } from "./DesignCanvasScreen.tsx";
import type {
  DesignAgentTurnResult,
  DesignCanvas,
  DesignCanvasIntent,
  DesignJob,
  DesignNode,
  DesignThread,
  FigmaCanvasImportResponse,
} from "./types.ts";

const flowHarness = vi.hoisted(() => ({
  props: null as Record<string, any> | null,
  viewport: { x: 0, y: 0, zoom: 1 },
  setViewport: vi.fn(),
  fitView: vi.fn(),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  moveEndDelayMs: null as number | null,
}));
const reducedMotionHarness = vi.hoisted(() => ({
  reduced: false,
  listeners: new Set<(event: MediaQueryListEvent) => void>(),
}));

function reducedMotionMediaQuery(query: string): MediaQueryList {
  return {
    get matches() {
      return query === "(prefers-reduced-motion: reduce)" && reducedMotionHarness.reduced;
    },
    media: query,
    onchange: null,
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === "change") reducedMotionHarness.listeners.add(listener as (event: MediaQueryListEvent) => void);
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === "change") reducedMotionHarness.listeners.delete(listener as (event: MediaQueryListEvent) => void);
    },
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: () => true,
  } as unknown as MediaQueryList;
}

function setReducedMotion(reduced: boolean): void {
  reducedMotionHarness.reduced = reduced;
  const event = { matches: reduced, media: "(prefers-reduced-motion: reduce)" } as MediaQueryListEvent;
  for (const listener of reducedMotionHarness.listeners) listener(event);
}

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  const React = await import("react");
  const instance = {
    getViewport: () => ({ ...flowHarness.viewport }),
    getZoom: () => flowHarness.viewport.zoom,
    setViewport: async (viewport: Viewport, options?: unknown) => {
      flowHarness.viewport = { ...viewport };
      flowHarness.setViewport(viewport, options);
      const notifyMove = () => {
        flowHarness.props?.onMove?.(null, viewport);
        flowHarness.props?.onMoveEnd?.(null, viewport);
      };
      if (flowHarness.moveEndDelayMs === null) notifyMove();
      else window.setTimeout(notifyMove, flowHarness.moveEndDelayMs);
      return true;
    },
    screenToFlowPosition: (point: { x: number; y: number }) => point,
    zoomIn: async (options?: unknown) => {
      flowHarness.zoomIn(options);
      return true;
    },
    zoomOut: async (options?: unknown) => {
      flowHarness.zoomOut(options);
      return true;
    },
    fitView: async (options?: unknown) => {
      flowHarness.fitView(options);
      return true;
    },
  };
  function ReactFlowMock(props: Record<string, any>) {
    flowHarness.props = props;
    React.useEffect(() => {
      props.onInit?.(instance);
    }, []);
    return React.createElement(
      "div",
      { "data-testid": "mock-react-flow" },
      props.nodes.map((node: { id: string }) => React.createElement("div", {
        key: node.id,
        "data-design-node-id": node.id,
      })),
    );
  }
  return {
    ...actual,
    ReactFlow: ReactFlowMock,
    Background: () => null,
  };
});

const PROJECT_ID = "interaction-project";
const CLAUDE_AGENT: AgentInfo = {
  id: "claude",
  command: "claude",
  available: true,
  availability: "ready",
  models: ["sonnet"],
};

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
    schemaVersion: 2,
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
  schemaVersion: 2,
  id: "thread-main",
  scope: { type: "main" },
  messages: [],
  createdAt: 1,
  updatedAt: 1,
};

const mainJob: DesignJob = {
  schemaVersion: 2,
  id: "main-job",
  kind: "main-agent",
  runnerId: "fixture",
  model: null,
  status: "ready",
  nodeId: null,
  parentJobId: null,
  contextHash: "context",
  canvasRevision: 1,
  expectedHeadVersionId: null,
  versionId: null,
  exportId: null,
  error: null,
  cancelRequested: false,
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
    appendMaterialVersion: vi.fn(async () => current),
    importProjectVersion: vi.fn(async () => current),
    listNodeVersions: vi.fn(async () => []),
    getExactVersionPreview: vi.fn(async (_projectId, nodeId, versionId) => ({ nodeId, versionId, url: "about:blank" })),
    downloadExactVersionHtml: vi.fn(async () => new Blob(["<!doctype html>"])),
    getThread: vi.fn(async (_projectId, scope) => ({ ...thread, scope })),
    // eslint-disable-next-line require-yield
    streamInvalidations: vi.fn(async function* () {}),
    submitAgentTurn,
    listJobs: vi.fn(async () => []),
    cancelJob: vi.fn(async () => mainJob),
    retryJob: vi.fn(async (_projectId, jobId) => ({
      retryOfJobId: jobId,
      thread,
      job: { ...mainJob, id: `retry-${jobId}`, status: "queued" as const },
      canvas: current,
    })),
    startImplementationExport: vi.fn(async () => ({ exportId: "export", job: mainJob })),
  };
  return { api, applyIntents };
}

beforeEach(() => {
  flowHarness.props = null;
  flowHarness.viewport = { x: 0, y: 0, zoom: 1 };
  flowHarness.setViewport.mockClear();
  flowHarness.fitView.mockClear();
  flowHarness.zoomIn.mockClear();
  flowHarness.zoomOut.mockClear();
  flowHarness.moveEndDelayMs = null;
  reducedMotionHarness.reduced = false;
  reducedMotionHarness.listeners.clear();
  vi.stubGlobal("matchMedia", vi.fn(reducedMotionMediaQuery));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.unstubAllGlobals();
});

test("focusable Canvas Nodes expose their persisted identity, kind, and state", async () => {
  const research = {
    ...designNode("research-a", 80),
    kind: "research" as const,
    name: "Checkout field study",
    state: "validating" as const,
  };
  const { api } = createApi(designCanvas([research]));

  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Interactions" api={api} agents={[CLAUDE_AGENT]} />);

  await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(1));
  expect(flowHarness.props?.nodes[0]).toMatchObject({
    ariaLabel: "Checkout field study, Research, Preparing preview",
  });
});

test("a successful Figma import adopts its response Canvas before a best-effort refresh", async () => {
  const initial = designCanvas([]);
  const importedNodes: DesignNode[] = [
    { ...designNode("figma-design", 321), kind: "design-document", name: "Design.md" },
    { ...designNode("figma-tokens", 761), kind: "design-tokens", name: "Tokens" },
    { ...designNode("figma-components", 1201), kind: "component", name: "Components" },
  ];
  const canonical = designCanvas(importedNodes, 2);
  const { api } = createApi(initial);
  vi.mocked(api.getCanvas)
    .mockResolvedValueOnce(initial)
    .mockRejectedValueOnce(new Error("transient refresh failure"));
  const response: FigmaCanvasImportResponse = {
    canvas: canonical,
    import: {
      reused: false,
      manifest: {
        schemaVersion: 1,
        importId: "figma-import-1",
        projectId: PROJECT_ID,
        source: {
          normalizedUrl: "https://www.figma.com/design/AbCdEf123456/Checkout",
          fileType: "design",
          fileKey: "AbCdEf123456",
          branchKey: null,
          fileName: "Checkout",
          requestedVersionId: null,
          resolvedVersion: "1",
          selectedNodeIds: [],
          depth: 4,
        },
        access: { editorType: null, role: null, linkAccess: null },
        credential: { mode: "personal-access-token", subject: "fake" },
        tokenAuthority: "style-values-inferred",
        artifacts: importedNodes.map((item, index) => ({
          kind: index === 0 ? "design-document" : index === 1 ? "tokens" : "components",
          path: `artifact-${index}.json`,
          mimeType: "application/json",
          sha256: String(index).repeat(64),
          bytes: 100,
          nodeId: item.id,
        })),
        incomplete: ["Variables unavailable"],
        warnings: ["Tokens inferred"],
        canvasRevision: canonical.revision,
        createdAt: 2,
      },
    },
  };
  const importFigmaProject = vi.fn(async () => response);
  const routeBefore = window.location.pathname;
  const user = userEvent.setup();
  render(
    <ApiProvider client={makeFakeApi({ importFigmaProject })}>
      <ToastProvider>
        <DesignCanvasScreen projectId={PROJECT_ID} projectName="Interactions" api={api} />
      </ToastProvider>
    </ApiProvider>,
  );
  await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(0));

  fireEvent.contextMenu(screen.getByLabelText("Infinite Design canvas"), { clientX: 320.6, clientY: 259.6 });
  await user.click(screen.getByRole("menuitem", { name: "Import from Figma" }));
  await user.type(
    await screen.findByRole("textbox", { name: "Figma file URL" }),
    "https://www.figma.com/design/AbCdEf123456/Checkout",
  );
  await user.click(screen.getByRole("checkbox", { name: "I have permission to import and use this Figma file" }));
  await user.click(screen.getByRole("button", { name: "Import into canvas" }));

  await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(3));
  expect(flowHarness.props?.nodes.every((item: { selected?: boolean }) => item.selected)).toBe(true);
  await waitFor(() => expect(flowHarness.fitView).toHaveBeenCalledTimes(1));
  expect(flowHarness.fitView).toHaveBeenCalledWith(expect.objectContaining({
    nodes: expect.arrayContaining(importedNodes.map((item) => expect.objectContaining({ id: item.id }))),
  }));
  expect(importFigmaProject).toHaveBeenCalledWith(
    PROJECT_ID,
    expect.objectContaining({ anchor: { x: 321, y: 260 } }),
    expect.any(AbortSignal),
  );
  expect(api.getCanvas).toHaveBeenCalledTimes(2);
  expect(window.location.pathname).toBe(routeBefore);
  expect(await screen.findByText(
    "Figma imported with limited metadata: Variables unavailable; Tokens inferred",
  )).toBeVisible();
});

test("single-click selects while double-click flies only the Node and its neighbors above a stable viewport", async () => {
  const nodeA = designNode("page-a", 80);
  const nodeB = designNode("page-b", 760);
  const { api, applyIntents } = createApi(designCanvas([nodeA, nodeB]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Interactions" api={api} agents={[CLAUDE_AGENT]} />);
  await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(2));

  act(() => {
    flowHarness.props?.onNodeClick?.(new MouseEvent("click"), flowHarness.props.nodes[0]);
  });
  await waitFor(() => expect(flowHarness.props?.nodes[0]?.selected).toBe(true));
  expect(await screen.findByLabelText("Page A Agent panel")).toHaveAttribute("data-agent-size", "compact");
  expect(flowHarness.setViewport).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Close Node focus" })).not.toBeInTheDocument();

  act(() => {
    flowHarness.props?.onNodeDoubleClick?.(new MouseEvent("dblclick"), flowHarness.props.nodes[0]);
  });
  await waitFor(() => expect(flowHarness.props?.nodes[0]?.data.focusMotion).toMatchObject({
    role: "source",
    scale: expect.any(Number),
    durationMs: expect.any(Number),
  }));
  expect(screen.getByLabelText("Page A Agent panel")).toHaveAttribute("data-agent-size", "focus");
  expect(flowHarness.setViewport).not.toHaveBeenCalled();
  expect(flowHarness.props?.nodes[1]?.data.focusMotion).toMatchObject({
    role: "away",
    shiftX: expect.any(Number),
    arcX: expect.any(Number),
    durationMs: expect.any(Number),
  });
  expect(flowHarness.props?.panOnScroll).toBe(false);
  expect(flowHarness.props?.panOnDrag).toBe(false);
  expect(flowHarness.props?.zoomOnPinch).toBe(false);
  expect(flowHarness.props?.nodesDraggable).toBe(false);
  expect(flowHarness.props?.nodes[0]?.className).toBe("design-canvas-flow-node--focused");
  expect(flowHarness.props?.nodes[1]?.className).toBe("design-canvas-flow-node--inactive");
  const focusedSurface = document.querySelector<HTMLElement>(".design-canvas-surface")!;
  const modifiedWheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 80 });
  const preventWheelDefault = vi.spyOn(modifiedWheel, "preventDefault");
  fireEvent(focusedSurface, modifiedWheel);
  expect(preventWheelDefault).toHaveBeenCalled();
  act(() => {
    flowHarness.props?.onNodeDoubleClick?.(new MouseEvent("dblclick"), flowHarness.props.nodes[1]);
  });
  expect(screen.queryByLabelText("Page B Agent panel")).not.toBeInTheDocument();
  expect(focusedSurface).toHaveAttribute("data-node-focus", "opening");
  const middlePointer = new MouseEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    button: 1,
    buttons: 4,
  });
  focusedSurface.dispatchEvent(middlePointer);
  expect(middlePointer.defaultPrevented).toBe(true);
  const middleMouse = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    button: 1,
    buttons: 4,
  });
  focusedSurface.dispatchEvent(middleMouse);
  expect(middleMouse.defaultPrevented).toBe(true);

  const canonicalViewport = { ...flowHarness.viewport };
  const attemptedViewport = { x: 260, y: -180, zoom: 1.35 };
  flowHarness.viewport = attemptedViewport;
  act(() => {
    flowHarness.props?.onMove?.(new MouseEvent("mousemove"), attemptedViewport);
    flowHarness.props?.onMoveEnd?.(new MouseEvent("mouseup"), attemptedViewport);
  });
  await waitFor(() => expect(flowHarness.viewport).toEqual(canonicalViewport));
  expect(flowHarness.setViewport).toHaveBeenLastCalledWith(canonicalViewport, { duration: 0 });
  expect(screen.getByRole("button", { name: "Close Node focus" })).toBeInTheDocument();
  expect(applyIntents).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Close Node focus" }));
  await waitFor(() => expect(document.querySelector(".design-canvas-surface")).not.toHaveAttribute("data-node-focus"));
  expect(flowHarness.viewport).toEqual(canonicalViewport);
  expect(flowHarness.props?.panOnScroll).toBe(true);
  expect(applyIntents).not.toHaveBeenCalled();
});

test("a rapid pane deselect then Node click ignores the pane's delayed empty selection echo", async () => {
  const { api } = createApi(designCanvas([designNode("page-a", 80)]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Interactions" api={api} agents={[CLAUDE_AGENT]} />);
  await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(1));

  act(() => {
    flowHarness.props?.onNodeClick?.(new MouseEvent("click"), flowHarness.props.nodes[0]);
  });
  await waitFor(() => expect(flowHarness.props?.nodes[0]?.selected).toBe(true));
  expect(await screen.findByLabelText("Page A Agent panel")).toBeInTheDocument();

  const nodeClickTarget = flowHarness.props!.nodes[0]!;
  act(() => {
    flowHarness.props?.onPaneClick?.();
    flowHarness.props?.onNodeClick?.(new MouseEvent("click"), nodeClickTarget);
    flowHarness.props?.onSelectionChange?.({ nodes: [{ ...nodeClickTarget, selected: true }] });
    flowHarness.props?.onSelectionChange?.({ nodes: [] });
  });

  await waitFor(() => expect(flowHarness.props?.nodes[0]?.selected).toBe(true));
  expect(screen.getByLabelText("Page A Agent panel")).toBeInTheDocument();
});

test("repeated canvas clicks cannot restart or stutter the return flight", async () => {
  const { api } = createApi(designCanvas([designNode("page-a", 80)]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Interactions" api={api} agents={[CLAUDE_AGENT]} />);
  await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(1));

  act(() => {
    flowHarness.props?.onNodeDoubleClick?.(new MouseEvent("dblclick"), flowHarness.props.nodes[0]);
  });
  await waitFor(() => expect(flowHarness.props?.nodes[0]?.data.focusMotion).toMatchObject({ role: "source" }));
  const staleSelectedEcho = { ...flowHarness.props!.nodes[0]!, selected: true };

  act(() => {
    flowHarness.props?.onPaneClick?.();
    flowHarness.props?.onPaneClick?.();
    flowHarness.props?.onPaneClick?.();
  });

  expect(flowHarness.setViewport).not.toHaveBeenCalled();
  act(() => {
    flowHarness.props?.onSelectionChange?.({ nodes: [staleSelectedEcho] });
  });
  await waitFor(() => {
    expect(document.querySelector(".design-canvas-surface")).not.toHaveAttribute("data-node-focus");
    expect(flowHarness.props?.nodes[0]?.selected).toBe(false);
  });
  expect(screen.queryByLabelText("Page A Agent panel")).not.toBeInTheDocument();
  expect(flowHarness.setViewport).not.toHaveBeenCalled();
});

test("Enter opens a selected Node immediately as the keyboard alternative to double-click", async () => {
  const { api } = createApi(designCanvas([designNode("page-a", 80)]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Interactions" api={api} agents={[CLAUDE_AGENT]} />);
  await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(1));

  act(() => {
    flowHarness.props?.onNodeClick?.(new MouseEvent("click"), flowHarness.props.nodes[0]);
  });
  fireEvent.keyDown(window, { key: "Enter" });

  await waitFor(() => expect(flowHarness.props?.nodes[0]?.data.focusMotion).toMatchObject({
    role: "source",
    durationMs: 0,
  }));
  expect(flowHarness.setViewport).not.toHaveBeenCalled();
  expect(document.querySelector(".design-canvas-surface")).toHaveAttribute("data-focus-motion", "instant");
  expect(screen.getByRole("button", { name: "Close Node focus" })).toBeInTheDocument();
});

test("focus never emits a camera move that a late React Flow callback could persist", async () => {
  flowHarness.moveEndDelayMs = 430;
  const { api, applyIntents } = createApi(designCanvas([designNode("page-a", 80)]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Interactions" api={api} agents={[CLAUDE_AGENT]} />);
  await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(1));

  act(() => {
    flowHarness.props?.onNodeDoubleClick?.(new MouseEvent("dblclick"), flowHarness.props.nodes[0]);
  });
  await waitFor(() => expect(flowHarness.props?.nodes[0]?.data.focusMotion).toMatchObject({ role: "source" }));
  expect(flowHarness.setViewport).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Close Node focus" }));
  await waitFor(() => expect(document.querySelector(".design-canvas-surface")).not.toHaveAttribute("data-node-focus"));

  expect(flowHarness.setViewport).not.toHaveBeenCalled();
  expect(applyIntents).not.toHaveBeenCalled();
  expect(document.querySelector(".design-canvas-surface")).not.toHaveAttribute("data-node-focus");
});

test("Node Agent chrome can hide without moving the centered source or the canvas", async () => {
  const { api } = createApi(designCanvas([designNode("page-a", 80)]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Interactions" api={api} agents={[CLAUDE_AGENT]} />);
  await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(1));

  act(() => {
    flowHarness.props?.onNodeDoubleClick?.(new MouseEvent("dblclick"), flowHarness.props.nodes[0]);
  });
  const panel = await screen.findByLabelText("Page A Agent panel");
  await waitFor(() => expect(flowHarness.props?.nodes[0]?.data.focusMotion).toMatchObject({ role: "source" }));
  const focusedMotion = flowHarness.props!.nodes[0]!.data.focusMotion!;
  const panelClose = panel.querySelector<HTMLButtonElement>('button[aria-label="Close Page A Agent"]');
  expect(panelClose).not.toBeNull();
  fireEvent.click(panelClose!);

  await waitFor(() => expect(screen.queryByLabelText("Page A Agent panel")).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Close Node focus" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Show Node Agent" })).toBeInTheDocument();
  expect(flowHarness.setViewport).not.toHaveBeenCalled();
  expect(flowHarness.props?.nodes[0]?.data.focusMotion).toMatchObject({
    shiftX: focusedMotion.shiftX,
    shiftY: focusedMotion.shiftY,
    scale: focusedMotion.scale,
  });

  fireEvent.click(screen.getByRole("button", { name: "Show Node Agent" }));
  expect(await screen.findByLabelText("Page A Agent panel")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Hide Node Agent" })).toBeInTheDocument();
  expect(panel).not.toBeInTheDocument();
  expect(flowHarness.setViewport).not.toHaveBeenCalled();
});

test("a closing flight ignores adjacent Node double-clicks until the canvas is restored", async () => {
  const nodeA = designNode("page-a", 80);
  const nodeB = designNode("page-b", 760);
  const { api } = createApi(designCanvas([nodeA, nodeB]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Interactions" api={api} agents={[CLAUDE_AGENT]} />);
  await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(2));

  act(() => {
    flowHarness.props?.onNodeDoubleClick?.(new MouseEvent("dblclick"), flowHarness.props.nodes[0]);
  });
  await waitFor(() => expect(screen.getByRole("button", { name: "Close Node focus" })).toBeInTheDocument());

  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Close Node focus" }));
    flowHarness.props?.onNodeDoubleClick?.(new MouseEvent("dblclick"), flowHarness.props.nodes[1]);
  });

  expect(flowHarness.setViewport).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Page B Agent panel")).not.toBeInTheDocument();
  await waitFor(() => expect(document.querySelector(".design-canvas-surface")).not.toHaveAttribute("data-node-focus"));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Close Node focus" })).not.toBeInTheDocument());
});

test("double-clicking the same Node reverses an interrupted closing flight in place", async () => {
  const { api } = createApi(designCanvas([designNode("page-a", 80)]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Interactions" api={api} agents={[CLAUDE_AGENT]} />);
  await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(1));

  act(() => {
    flowHarness.props?.onNodeDoubleClick?.(new MouseEvent("dblclick"), flowHarness.props.nodes[0]);
  });
  await waitFor(() => expect(document.querySelector(".design-canvas-surface")).toHaveAttribute("data-node-focus", "opening"));
  fireEvent.click(screen.getByRole("button", { name: "Close Node focus" }));
  await waitFor(() => expect(document.querySelector(".design-canvas-surface")).toHaveAttribute("data-node-focus", "closing"));

  act(() => {
    flowHarness.props?.onNodeDoubleClick?.(new MouseEvent("dblclick"), flowHarness.props.nodes[0]);
  });
  await waitFor(() => expect(document.querySelector(".design-canvas-surface")).toHaveAttribute("data-node-focus", "opening"));
  expect(screen.getByRole("button", { name: "Close Node focus" })).toBeInTheDocument();
  expect(flowHarness.setViewport).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: "Escape" });
});

test("Escape dismisses transient Agent controls before reversing an in-progress Node flight", async () => {
  const user = userEvent.setup();
  const { api } = createApi(designCanvas([designNode("page-a", 80)]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Interactions" api={api} agents={[CLAUDE_AGENT]} />);
  await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(1));

  act(() => {
    flowHarness.props?.onNodeDoubleClick?.(new MouseEvent("dblclick"), flowHarness.props.nodes[0]);
  });
  await waitFor(() => expect(flowHarness.props?.nodes[0]?.data.focusMotion).toMatchObject({ role: "source" }));
  await user.click(await screen.findByRole("button", { name: "Agent and model" }));
  expect(await screen.findByLabelText("Choose Agent and model")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.queryByLabelText("Choose Agent and model")).not.toBeInTheDocument();
  expect(document.querySelector(".design-canvas-surface")).toHaveAttribute("data-node-focus", "opening");

  fireEvent.keyDown(window, { key: "Escape" });
  expect(document.querySelector(".design-canvas-surface")).toHaveAttribute("data-node-focus", "closing");
  expect(document.querySelector(".design-canvas-surface")).toHaveAttribute("data-focus-motion", "animated");
  await waitFor(() => expect(document.querySelector(".design-canvas-surface")).not.toHaveAttribute("data-node-focus"));
  expect(flowHarness.setViewport).not.toHaveBeenCalled();
});

test("reduced motion makes Node focus, canvas Fit, and Zoom navigation immediate", async () => {
  setReducedMotion(true);
  const { api } = createApi(designCanvas([designNode("page-a", 80)]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Interactions" api={api} agents={[CLAUDE_AGENT]} />);
  await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(1));

  act(() => {
    flowHarness.props?.onNodeDoubleClick?.(new MouseEvent("dblclick"), flowHarness.props.nodes[0]);
  });
  await waitFor(() => expect(flowHarness.props?.nodes[0]?.data.focusMotion).toMatchObject({
    role: "source",
    durationMs: 0,
  }));
  expect(flowHarness.setViewport).not.toHaveBeenCalled();
  expect(document.querySelector(".design-canvas-surface")).toHaveAttribute("data-focus-motion", "instant");
  fireEvent.click(screen.getByRole("button", { name: "Close Node focus" }));

  fireEvent.click(screen.getByRole("button", { name: "Fit canvas" }));
  expect(flowHarness.fitView).toHaveBeenCalledWith({
    padding: 0.16,
    duration: 0,
    ease: expect.any(Function),
    interpolate: "smooth",
  });
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(flowHarness.zoomIn).toHaveBeenCalledWith({ duration: 0 });
  fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
  expect(flowHarness.zoomOut).toHaveBeenCalledWith({ duration: 0 });
});

test("switching reduced motion on during a Node flight removes remaining spatial motion and closes immediately", async () => {
  const nodeA = designNode("page-a", 80);
  const nodeB = designNode("page-b", 760);
  const { api } = createApi(designCanvas([nodeA, nodeB]));
  const view = render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Interactions" api={api} agents={[CLAUDE_AGENT]} />);
  await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(2));

  act(() => {
    flowHarness.props?.onNodeDoubleClick?.(new MouseEvent("dblclick"), flowHarness.props.nodes[0]);
  });
  await waitFor(() => expect(flowHarness.props?.nodes[0]?.data.focusMotion?.durationMs).toBeGreaterThan(0));
  expect(document.querySelector(".design-canvas-surface")).toHaveAttribute("data-focus-motion", "animated");

  act(() => setReducedMotion(true));
  view.rerender(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Interactions reduced" api={api} agents={[CLAUDE_AGENT]} />);

  await waitFor(() => {
    expect(document.querySelector(".design-canvas-surface")).toHaveAttribute("data-focus-motion", "instant");
    expect(flowHarness.props?.nodes[0]?.data.focusMotion).toMatchObject({ role: "source", durationMs: 0 });
    expect(flowHarness.props?.nodes[1]?.data.focusMotion).toMatchObject({ role: "away", durationMs: 0 });
  });

  fireEvent.click(screen.getByRole("button", { name: "Close Node focus" }));
  await waitFor(() => expect(document.querySelector(".design-canvas-surface")).not.toHaveAttribute("data-node-focus"));
  expect(screen.queryByRole("button", { name: "Close Node focus" })).not.toBeInTheDocument();
});

test("completed multi-select drags persist one geometry batch and keyboard position changes do not need drag-stop", async () => {
  const nodeA = designNode("page-a", 80);
  const nodeB = designNode("page-b", 620);
  const { api, applyIntents } = createApi(designCanvas([nodeA, nodeB]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Interactions" api={api} agents={[CLAUDE_AGENT]} />);
  await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(2));
  expect(flowHarness.props?.panOnDrag).toEqual([1]);
  fireEvent.click(screen.getByRole("button", { name: "Hand tool" }));
  await waitFor(() => expect(flowHarness.props?.panOnDrag).toEqual([0, 1]));
  fireEvent.click(screen.getByRole("button", { name: "Select tool" }));
  await waitFor(() => expect(flowHarness.props?.panOnDrag).toEqual([1]));

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

test("Node resize dimensions remain live through layout measurement and persist only on release", async () => {
  const node = designNode("page-a", 80);
  const { api, applyIntents } = createApi(designCanvas([node]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Interactions" api={api} agents={[CLAUDE_AGENT]} />);
  await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(1));

  act(() => {
    flowHarness.props?.onNodesChange?.([{
      type: "dimensions",
      id: node.id,
      dimensions: { width: 640, height: 480 },
      resizing: true,
      setAttributes: true,
    }]);
  });
  await act(async () => {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  });

  expect(flowHarness.props?.nodes[0]).toMatchObject({ width: 640, height: 480 });
  expect(flowHarness.props?.nodes[0]?.data.node.geometry).toMatchObject({ width: 640, height: 480 });
  expect(applyIntents).not.toHaveBeenCalled();

  act(() => {
    flowHarness.props?.nodes[0]?.data.onResize(node.id, {
      x: node.geometry.x,
      y: node.geometry.y,
      width: 640,
      height: 480,
    });
    flowHarness.props?.onNodesChange?.([{
      type: "dimensions",
      id: node.id,
      dimensions: { width: 640, height: 480 },
      resizing: false,
    }]);
  });

  await waitFor(() => expect(applyIntents).toHaveBeenCalledTimes(1));
  expect(applyIntents.mock.calls[0]?.[1].intents).toEqual([{
    type: "update-node",
    nodeId: node.id,
    patch: { geometry: { x: 80, y: 80, width: 640, height: 480 } },
  }]);
});

test("pointer resize feedback coalesces within one animation frame and flushes the exact release geometry", async () => {
  const node = designNode("page-a", 80);
  const { api, applyIntents } = createApi(designCanvas([node]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Interactions" api={api} agents={[CLAUDE_AGENT]} />);
  await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(1));
  await act(async () => {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  });

  let nextFrameId = 1;
  const frames = new Map<number, FrameRequestCallback>();
  const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = nextFrameId;
    nextFrameId += 1;
    frames.set(id, callback);
    return id;
  });
  const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  const flushFrame = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(performance.now());
  };

  try {
    act(() => {
      flowHarness.props?.onNodesChange?.([
        { type: "position", id: node.id, position: { x: 72, y: 72 } },
        {
          type: "dimensions",
          id: node.id,
          dimensions: { width: 592, height: 416 },
          resizing: true,
          setAttributes: true,
        },
      ]);
    });
    expect(flowHarness.props?.nodes[0]).toMatchObject({
      position: { x: 80, y: 80 },
      width: 480,
      height: 360,
    });

    act(() => {
      flowHarness.props?.onNodesChange?.([
        { type: "position", id: node.id, position: { x: 64, y: 64 } },
        {
          type: "dimensions",
          id: node.id,
          dimensions: { width: 608, height: 432 },
          resizing: true,
          setAttributes: true,
        },
      ]);
    });
    expect(flowHarness.props?.nodes[0]).toMatchObject({
      position: { x: 80, y: 80 },
      width: 480,
      height: 360,
    });
    expect(applyIntents).not.toHaveBeenCalled();

    act(flushFrame);
    expect(flowHarness.props?.nodes[0]).toMatchObject({
      position: { x: 64, y: 64 },
      width: 608,
      height: 432,
    });
    expect(flowHarness.props?.nodes[0]?.data.node.geometry).toEqual({
      x: 64,
      y: 64,
      width: 608,
      height: 432,
    });

    const nextFrameGeometry = { x: 60, y: 60, width: 624, height: 444 };
    act(() => {
      flowHarness.props?.onNodesChange?.([
        {
          type: "position",
          id: node.id,
          position: { x: nextFrameGeometry.x, y: nextFrameGeometry.y },
        },
        {
          type: "dimensions",
          id: node.id,
          dimensions: { width: nextFrameGeometry.width, height: nextFrameGeometry.height },
          resizing: true,
          setAttributes: true,
        },
      ]);
    });
    expect(flowHarness.props?.nodes[0]).toMatchObject({
      position: { x: 64, y: 64 },
      width: 608,
      height: 432,
    });
    act(flushFrame);
    expect(flowHarness.props?.nodes[0]).toMatchObject({
      position: { x: nextFrameGeometry.x, y: nextFrameGeometry.y },
      width: nextFrameGeometry.width,
      height: nextFrameGeometry.height,
    });
    expect(flowHarness.props?.nodes[0]?.data.node.geometry).toEqual(nextFrameGeometry);

    const released = { x: 56, y: 56, width: 640, height: 456 };
    act(() => {
      flowHarness.props?.onNodesChange?.([
        { type: "position", id: node.id, position: { x: released.x, y: released.y } },
        {
          type: "dimensions",
          id: node.id,
          dimensions: { width: released.width, height: released.height },
          resizing: true,
          setAttributes: true,
        },
      ]);
    });
    expect(flowHarness.props?.nodes[0]).toMatchObject({
      position: { x: nextFrameGeometry.x, y: nextFrameGeometry.y },
      width: nextFrameGeometry.width,
      height: nextFrameGeometry.height,
    });

    act(() => {
      flowHarness.props?.nodes[0]?.data.onResize(node.id, released);
      flowHarness.props?.onNodesChange?.([{
        type: "dimensions",
        id: node.id,
        dimensions: { width: released.width, height: released.height },
        resizing: false,
      }]);
    });
    expect(flowHarness.props?.nodes[0]).toMatchObject({
      position: { x: released.x, y: released.y },
      width: released.width,
      height: released.height,
    });
    act(flushFrame);
    expect(flowHarness.props?.nodes[0]?.data.node.geometry).toEqual(released);

    await waitFor(() => expect(applyIntents).toHaveBeenCalledTimes(1));
    expect(applyIntents.mock.calls[0]?.[1].intents).toEqual([{
      type: "update-node",
      nodeId: node.id,
      patch: { geometry: released },
    }]);
  } finally {
    requestFrame.mockRestore();
    cancelFrame.mockRestore();
  }
});

test("a stale position save acknowledgement cannot rewind a newer local drag", async () => {
  const node = designNode("page-a", 80);
  const initial = designCanvas([node]);
  const { api, applyIntents } = createApi(initial);
  let resolveFirstSave!: (canvas: DesignCanvas) => void;
  applyIntents.mockImplementationOnce((_projectId, request) => new Promise<DesignCanvas>((resolve) => {
    resolveFirstSave = resolve;
    expect(request.intents).toEqual([{
      type: "update-node",
      nodeId: node.id,
      patch: { geometry: { x: 180, y: 140, width: 480, height: 360 } },
    }]);
  }));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Interactions" api={api} agents={[CLAUDE_AGENT]} />);
  await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(1));

  act(() => {
    flowHarness.props?.onNodesChange?.([{
      type: "position", id: node.id, position: { x: 180, y: 140 }, dragging: false,
    }]);
  });
  await waitFor(() => expect(applyIntents).toHaveBeenCalledTimes(1));
  act(() => {
    flowHarness.props?.onNodesChange?.([{
      type: "position", id: node.id, position: { x: 280, y: 240 }, dragging: false,
    }]);
  });

  await act(async () => {
    resolveFirstSave(designCanvas([{
      ...node,
      geometry: { x: 180, y: 140, width: 480, height: 360 },
      updatedAt: 2,
    }], 2));
    await Promise.resolve();
  });

  expect(flowHarness.props?.nodes[0]?.position).toEqual({ x: 280, y: 240 });
  await waitFor(() => expect(applyIntents).toHaveBeenCalledTimes(2));
});

test("the mounted viewport stays locally owned while persistence and Agent snapshots update", async () => {
  const backendViewport = { x: 48, y: -32, zoom: 1.75 };
  const { api, applyIntents } = createApi(designCanvas([designNode("page-a", 80)]), backendViewport);
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Interactions" api={api} agents={[CLAUDE_AGENT]} />);
  await waitFor(() => expect(flowHarness.props).not.toBeNull());

  const localViewport = { x: 18, y: 24, zoom: 1.2 };
  act(() => {
    flowHarness.viewport = { ...localViewport };
    flowHarness.props?.onMove?.(null, localViewport);
    flowHarness.props?.onMoveEnd?.(null, localViewport);
  });
  expect(screen.queryByText("Updating canvas")).not.toBeInTheDocument();
  await waitFor(() => expect(applyIntents).toHaveBeenCalledTimes(1), { timeout: 1_200 });
  expect(applyIntents.mock.calls[0]?.[1].intents).toEqual([{ type: "set-viewport", viewport: localViewport }]);
  expect(flowHarness.setViewport).not.toHaveBeenCalled();

  applyIntents.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Main Agent" }));
  fireEvent.change(await screen.findByRole("textbox", { name: "Main Agent message" }), { target: { value: "Reframe the canvas" } });
  fireEvent.click(screen.getByRole("button", { name: "Send to Main Agent" }));

  await waitFor(() => expect(api.submitAgentTurn).toHaveBeenCalledTimes(1));
  expect(flowHarness.setViewport).not.toHaveBeenCalled();
  expect(flowHarness.viewport).toEqual(localViewport);
  expect(screen.getByText("120%")).toBeInTheDocument();
  await new Promise((resolve) => window.setTimeout(resolve, 540));
  expect(applyIntents).not.toHaveBeenCalled();
});

test("a stale viewport save acknowledgement cannot rewind a newer local pan", async () => {
  const initial = designCanvas([designNode("page-a", 80)]);
  const { api, applyIntents } = createApi(initial);
  let resolveFirstSave!: (canvas: DesignCanvas) => void;
  applyIntents.mockImplementationOnce((_projectId, request) => new Promise<DesignCanvas>((resolve) => {
    resolveFirstSave = resolve;
    expect(request.intents).toEqual([{
      type: "set-viewport",
      viewport: { x: 10, y: 20, zoom: 1.1 },
    }]);
  }));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Interactions" api={api} agents={[CLAUDE_AGENT]} />);
  await waitFor(() => expect(flowHarness.props).not.toBeNull());

  const first = { x: 10, y: 20, zoom: 1.1 };
  act(() => {
    flowHarness.viewport = { ...first };
    flowHarness.props?.onMove?.(null, first);
    flowHarness.props?.onMoveEnd?.(null, first);
  });
  await waitFor(() => expect(applyIntents).toHaveBeenCalledTimes(1), { timeout: 1_200 });

  const latest = { x: 90, y: -40, zoom: 1.6 };
  act(() => {
    flowHarness.viewport = { ...latest };
    flowHarness.props?.onMove?.(null, latest);
    flowHarness.props?.onMoveEnd?.(null, latest);
  });
  await act(async () => {
    resolveFirstSave(designCanvas(initial.nodes, 2, first));
    await Promise.resolve();
  });

  expect(flowHarness.setViewport).not.toHaveBeenCalled();
  expect(flowHarness.viewport).toEqual(latest);
  expect(screen.getByText("160%")).toBeInTheDocument();
  await waitFor(() => expect(applyIntents).toHaveBeenCalledTimes(2), { timeout: 1_200 });
});
