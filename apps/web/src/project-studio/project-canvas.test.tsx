import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiProvider } from "../lib/api-context.tsx";
import {
  ApiError,
  type GraphCommandRequest,
  type Project,
  type ReadyProjectWorkspacePayload,
  type WorkspaceGraph,
  type WorkspaceGraphCommand,
  type WorkspaceLayout,
  type WorkspaceLayoutCommand,
} from "../lib/api.ts";
import { makeFakeApi } from "../test/fake-api.ts";
import {
  ProjectCanvas,
  isCanvasShortcutTarget,
  reconcileCanvasEdges,
  reconcileCanvasNodes,
} from "./canvas/ProjectCanvas.tsx";
import {
  workspaceGraphToFlow,
  type WorkspaceFlowEdge,
  type WorkspaceFlowNode,
} from "./canvas/workspace-graph-adapter.ts";
import { applyWorkspaceLayoutCommands } from "./canvas/workspace-layout.ts";
import { useProjectStudio } from "./useProjectStudio.ts";

const graph: WorkspaceGraph = {
  workspaceId: "workspace-1",
  revision: 1,
  nodes: [
    { id: "page-1", workspaceId: "workspace-1", kind: "page", artifactId: "artifact-page-1", name: "Checkout" },
    { id: "page-2", workspaceId: "workspace-1", kind: "page", artifactId: "artifact-page-2", name: "Receipt" },
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

function graphWithRelationship(
  kind: WorkspaceGraph["edges"][number]["kind"],
  edgeId = `${kind}-1`,
): WorkspaceGraph {
  const edge = {
    id: edgeId,
    workspaceId: graph.workspaceId,
    kind,
    sourceNodeId: "page-1",
    targetNodeId: "page-2",
    ...(kind === "prototype" ? { prototype: { status: "planned" as const } } : {}),
  } as WorkspaceGraph["edges"][number];
  return { ...graph, edges: [edge] };
}

const layout: WorkspaceLayout = {
  workspaceId: "workspace-1",
  layoutId: "default",
  objects: [
    { id: "journey", kind: "group", x: 40, y: 40, width: 700, height: 380, parentGroupId: null, label: "Purchase journey", collapsed: false },
    { id: "page-1", kind: "node", x: 40, y: 70, parentGroupId: "journey" },
    { id: "page-2", kind: "node", x: 370, y: 70, parentGroupId: "journey" },
  ],
  viewport: { x: 0, y: 0, zoom: 0.8 },
  checksum: "layout-1",
};

const fullZoomLayout: WorkspaceLayout = {
  ...layout,
  viewport: { ...layout.viewport, zoom: 1 },
};

interface ReactFlowMeasurementController {
  (width?: number, height?: number, left?: number, top?: number): void;
  observedCanvasSurfaces: () => number;
}

function installReactFlowMeasurements(initialLeft = 0, initialTop = 0): ReactFlowMeasurementController {
  let measuredWidth = 960;
  let measuredHeight = 640;
  let measuredLeft = initialLeft;
  let measuredTop = initialTop;
  vi.stubGlobal("DOMMatrixReadOnly", class MockDOMMatrixReadOnly {
    readonly m22 = 1;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function elementWidth(this: HTMLElement) {
    return Number.parseFloat(this.style.width) || measuredWidth;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function elementHeight(this: HTMLElement) {
    return Number.parseFloat(this.style.height) || measuredHeight;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function measuredRect(this: HTMLElement) {
    const width = this.offsetWidth;
    const height = this.offsetHeight;
    return {
      x: measuredLeft,
      y: measuredTop,
      top: measuredTop,
      right: measuredLeft + width,
      bottom: measuredTop + height,
      left: measuredLeft,
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
  const measure = ((width = 960, height = 640, left = measuredLeft, top = measuredTop) => {
    measuredWidth = width;
    measuredHeight = height;
    measuredLeft = left;
    measuredTop = top;
    for (const observer of observers) {
      const entries = [...observer.targets].map((target) => {
        const contentRect = target.getBoundingClientRect();
        const boxSize = [{ inlineSize: contentRect.width, blockSize: contentRect.height }];
        return {
          target,
          contentRect,
          borderBoxSize: boxSize,
          contentBoxSize: boxSize,
          devicePixelContentBoxSize: boxSize,
        } as ResizeObserverEntry;
      });
      if (entries.length > 0) observer.callback(entries, observer.instance);
    }
  }) as ReactFlowMeasurementController;
  measure.observedCanvasSurfaces = () => observers.reduce((count, observer) => (
    count + [...observer.targets].filter((target) => target.classList.contains("dezin-project-canvas__surface")).length
  ), 0);
  return measure;
}

function CanvasHarness({
  onSaveLayout,
  onApplyGraphCommands = async () => {},
  onOpenArtifact = () => {},
  onOpenResource,
  onPresentFlow,
  canvasLayout = layout,
  canvasGraph = graph,
  artifactRevisionIds = { "artifact-page-1": "revision-1" },
  resourceRevisionStates,
  initialSelectedNodeIds = [],
  proposal = null,
}: {
  onSaveLayout: (commands: readonly WorkspaceLayoutCommand[]) => Promise<WorkspaceLayout>;
  onApplyGraphCommands?: (commands: readonly WorkspaceGraphCommand[]) => Promise<void>;
  onOpenArtifact?: (artifactId: string) => void;
  onOpenResource?: (resourceId: string, revisionId: string | null) => void;
  onPresentFlow?: () => void;
  canvasLayout?: WorkspaceLayout;
  canvasGraph?: WorkspaceGraph;
  artifactRevisionIds?: Readonly<Record<string, string | null>>;
  resourceRevisionStates?: Readonly<Record<string, {
    revisionId: string;
    resourceKind: "research" | "moodboard" | "sharingan-capture" | "file" | "asset" | "effect" | "external-reference";
    qualityState: "grounded" | "needs-review" | null;
  }>>;
  initialSelectedNodeIds?: readonly string[];
  proposal?: { id: string } | null;
}) {
  const [selection, setSelection] = useState<string[]>([...initialSelectedNodeIds]);
  return (
    <ProjectCanvas
      projectId="project-1"
      projectName="Storefront system"
      graph={canvasGraph}
      layout={canvasLayout}
      artifactRevisionIds={artifactRevisionIds}
      resourceRevisionStates={resourceRevisionStates}
      selectedNodeIds={selection}
      onSelectionChange={setSelection}
      onSaveLayout={onSaveLayout}
      onApplyGraphCommands={onApplyGraphCommands}
      onOpenArtifact={onOpenArtifact}
      onOpenResource={onOpenResource}
      onPresentFlow={onPresentFlow}
      proposal={proposal}
    />
  );
}

function AuthoritativeCanvasHarness({
  onSaveLayout,
}: {
  onSaveLayout: (commands: readonly WorkspaceLayoutCommand[]) => Promise<WorkspaceLayout>;
}) {
  const [canvasLayout, setCanvasLayout] = useState(layout);
  const saveLayout = useCallback(async (commands: readonly WorkspaceLayoutCommand[]) => {
    const saved = await onSaveLayout(commands);
    setCanvasLayout(saved);
    return saved;
  }, [onSaveLayout]);
  return (
    <>
      <button
        type="button"
        onClick={() => setCanvasLayout((current) => ({
          ...current,
          checksum: `${current.checksum}-external-refresh`,
        }))}
      >
        Refresh workspace model
      </button>
      <CanvasHarness
        canvasLayout={canvasLayout}
        initialSelectedNodeIds={["page-1"]}
        onSaveLayout={saveLayout}
      />
    </>
  );
}

function openWorkspaceOutline(): void {
  fireEvent.click(screen.getByRole("button", { name: "Toggle workspace outline" }));
}

const researchGraph: WorkspaceGraph = {
  ...graph,
  nodes: [
    ...graph.nodes,
    { id: "research-node", workspaceId: graph.workspaceId, kind: "resource", resourceId: "research-1", name: "Checkout research" },
  ],
  edges: [
    ...graph.edges,
    {
      id: "research-informs-checkout",
      workspaceId: graph.workspaceId,
      kind: "informs",
      sourceNodeId: "research-node",
      targetNodeId: "page-1",
    },
  ],
};

const researchLayout: WorkspaceLayout = {
  ...layout,
  objects: [
    ...layout.objects,
    { id: "research-node", kind: "node", x: 40, y: 260, parentGroupId: "journey" },
  ],
};

beforeEach(() => {
  window.history.pushState({}, "", "/projects/project-1/canvas");
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("canvas renders immutable-node Outline parity and never mounts iframe content", () => {
  const { container } = render(
    <CanvasHarness onSaveLayout={async () => layout} />,
  );

  expect(screen.getByRole("application", { name: "Project canvas" })).toBeInTheDocument();
  openWorkspaceOutline();
  expect(screen.getByRole("list", { name: "Workspace outline" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Select Page Checkout.*outgoing 1/i })).toBeInTheDocument();
  expect(container.querySelector("iframe")).toBeNull();

  const open = screen.getByRole("link", { name: "Open Page Checkout" });
  expect(open).toHaveAttribute("href", "/projects/project-1/artifacts/artifact-page-1");
});

test("component library migration does not invalidate a proposal's sealed layout checksum", async () => {
  const onSaveLayout = vi.fn(async () => layout);
  const graphWithComponent: WorkspaceGraph = {
    ...graph,
    nodes: [
      ...graph.nodes,
      {
        id: "component-1",
        workspaceId: graph.workspaceId,
        kind: "component",
        artifactId: "artifact-component-1",
        name: "Order summary",
      },
    ],
  };

  render(
    <CanvasHarness
      canvasGraph={graphWithComponent}
      onSaveLayout={onSaveLayout}
      proposal={{ id: "proposal-1" }}
    />,
  );
  await act(async () => {});

  expect(onSaveLayout).not.toHaveBeenCalled();
});

test("component library migration retries after a transient background save failure", async () => {
  const onSaveLayout = vi.fn()
    .mockRejectedValueOnce(new Error("temporary write failure"))
    .mockResolvedValue(layout);
  const graphWithComponent: WorkspaceGraph = {
    ...graph,
    nodes: [
      ...graph.nodes,
      {
        id: "component-1",
        workspaceId: graph.workspaceId,
        kind: "component",
        artifactId: "artifact-component-1",
        name: "Order summary",
      },
    ],
  };
  render(
    <CanvasHarness canvasGraph={graphWithComponent} onSaveLayout={onSaveLayout} />,
  );

  await waitFor(() => expect(onSaveLayout).toHaveBeenCalledTimes(2));
});

test("Outline opens the same exact Resource revision as the canvas keyboard path", () => {
  render(
    <CanvasHarness
      onSaveLayout={async () => researchLayout}
      canvasGraph={researchGraph}
      canvasLayout={researchLayout}
      resourceRevisionStates={{
        "research-1": {
          revisionId: "research-revision-1",
          resourceKind: "research",
          qualityState: "grounded",
        },
      }}
    />,
  );

  openWorkspaceOutline();
  expect(screen.getByRole("link", { name: "Open Resource Checkout research" })).toHaveAttribute(
    "href",
    "/projects/project-1/resources/research-1/revisions/research-revision-1",
  );
});

test("ReactFlow mounts before the first ResizeObserver delivery and disconnects under StrictMode", () => {
  const measureReactFlow = installReactFlowMeasurements();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const animationFrames = new Map<number, FrameRequestCallback>();
  let nextAnimationFrameId = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextAnimationFrameId++;
    animationFrames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    animationFrames.delete(id);
  });
  const rendered = render(
    <StrictMode>
      <CanvasHarness onSaveLayout={async () => layout} />
    </StrictMode>,
  );

  expect(screen.getByRole("application", { name: "Project canvas" })).toBeInTheDocument();
  act(() => measureReactFlow(0, 640));
  expect(screen.getByRole("application", { name: "Project canvas" })).toBeInTheDocument();

  act(() => measureReactFlow(960, 640));
  expect(screen.getByRole("application", { name: "Project canvas" })).toBeInTheDocument();

  act(() => {
    const pending = [...animationFrames.values()];
    animationFrames.clear();
    for (const callback of pending) callback(0);
  });
  expect(screen.getByRole("application", { name: "Project canvas" })).toBeInTheDocument();
  expect(warn.mock.calls.flat().join(" ")).not.toContain("reactflow.dev/error#004");

  rendered.unmount();
  expect(measureReactFlow.observedCanvasSurfaces()).toBe(0);
});

test("panel resizing keeps canvas objects fixed in screen space instead of recentering the camera", async () => {
  const measureReactFlow = installReactFlowMeasurements(240);
  const onSaveLayout = vi.fn(async (commands: readonly WorkspaceLayoutCommand[]) => (
    applyWorkspaceLayoutCommands(layout, commands)
  ));
  const animationFrames = new Map<number, FrameRequestCallback>();
  let nextAnimationFrameId = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextAnimationFrameId++;
    animationFrames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    animationFrames.delete(id);
  });
  const flushAnimationFrames = () => {
    const pending = [...animationFrames.values()];
    animationFrames.clear();
    for (const callback of pending) callback(0);
  };
  const { container } = render(
    <CanvasHarness onSaveLayout={onSaveLayout} />,
  );
  await act(async () => {
    measureReactFlow(960, 640, 240);
    flushAnimationFrames();
  });
  const viewport = container.querySelector<HTMLElement>(".react-flow__viewport");
  expect(viewport).not.toBeNull();
  expect(viewport).toHaveStyle({ transform: "translate(0px,0px) scale(0.8)" });

  await act(async () => {
    measureReactFlow(1120, 640, 240);
    flushAnimationFrames();
  });
  expect(viewport).toHaveStyle({ transform: "translate(0px,0px) scale(0.8)" });
  expect(onSaveLayout).not.toHaveBeenCalled();

  await act(async () => {
    measureReactFlow(1040, 640, 320);
    flushAnimationFrames();
  });

  await waitFor(() => expect(viewport).toHaveStyle({
    transform: "translate(-80px,0px) scale(0.8)",
  }));
  await waitFor(() => expect(onSaveLayout).toHaveBeenCalledWith([
    { type: "set-viewport", viewport: { x: -80, y: 0, zoom: 0.8 } },
  ]));
  expect(onSaveLayout).toHaveBeenCalledTimes(1);
});

test("a surface shift during pan debounce is folded into that viewport save without a delayed jump", async () => {
  const measureReactFlow = installReactFlowMeasurements(240);
  const onSaveLayout = vi.fn(async (commands: readonly WorkspaceLayoutCommand[]) => (
    applyWorkspaceLayoutCommands(layout, commands)
  ));
  const animationFrames = new Map<number, FrameRequestCallback>();
  let nextAnimationFrameId = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextAnimationFrameId++;
    animationFrames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    animationFrames.delete(id);
  });
  const flushAnimationFrames = () => {
    const pending = [...animationFrames.values()];
    animationFrames.clear();
    for (const callback of pending) callback(0);
  };
  const { container } = render(<CanvasHarness onSaveLayout={onSaveLayout} />);
  await act(async () => {
    measureReactFlow(960, 640, 240);
    flushAnimationFrames();
  });
  fireEvent.click(screen.getByRole("button", { name: "Hand tool" }));
  const pane = container.querySelector<HTMLElement>(".react-flow__pane")!;
  const viewport = container.querySelector<HTMLElement>(".react-flow__viewport")!;
  const eventWindow = pane.ownerDocument.defaultView!;
  const mouseEvent = (type: string, init: MouseEventInit): MouseEvent => {
    const event = new eventWindow.MouseEvent(type, { bubbles: true, ...init });
    Object.defineProperty(event, "view", { configurable: true, value: eventWindow });
    return event;
  };

  pane.dispatchEvent(mouseEvent("mousedown", {
    button: 0,
    buttons: 1,
    clientX: 400,
    clientY: 300,
  }));
  eventWindow.dispatchEvent(mouseEvent("mousemove", {
    button: 0,
    buttons: 1,
    clientX: 440,
    clientY: 300,
  }));
  eventWindow.dispatchEvent(mouseEvent("mouseup", {
    button: 0,
    buttons: 0,
    clientX: 440,
    clientY: 300,
  }));
  await waitFor(() => expect(viewport).toHaveStyle({
    transform: "translate(40px,0px) scale(0.8)",
  }));

  await act(async () => {
    measureReactFlow(880, 640, 320);
    flushAnimationFrames();
  });

  await waitFor(() => expect(onSaveLayout).toHaveBeenCalledWith([
    { type: "set-viewport", viewport: { x: -40, y: 0, zoom: 0.8 } },
  ]));
  expect(viewport).toHaveStyle({ transform: "translate(-40px,0px) scale(0.8)" });

  await act(async () => {
    measureReactFlow(800, 640, 400);
    flushAnimationFrames();
  });
  await waitFor(() => expect(onSaveLayout).toHaveBeenCalledWith([
    { type: "set-viewport", viewport: { x: -120, y: 0, zoom: 0.8 } },
  ]));
});

test("an older viewport save cannot snap back a newer surface resize", async () => {
  const measureReactFlow = installReactFlowMeasurements(240);
  const animationFrames = new Map<number, FrameRequestCallback>();
  let nextAnimationFrameId = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextAnimationFrameId++;
    animationFrames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    animationFrames.delete(id);
  });
  const flushAnimationFrames = () => {
    const pending = [...animationFrames.values()];
    animationFrames.clear();
    for (const callback of pending) callback(0);
  };
  let resolveFirstSave!: (saved: WorkspaceLayout) => void;
  const firstSave = new Promise<WorkspaceLayout>((resolve) => {
    resolveFirstSave = resolve;
  });
  let authoritative = layout;
  const onSaveLayout = vi.fn()
    .mockImplementationOnce(() => firstSave)
    .mockImplementation(async (commands: readonly WorkspaceLayoutCommand[]) => {
      authoritative = applyWorkspaceLayoutCommands(authoritative, commands);
      return authoritative;
    });
  const { container } = render(<CanvasHarness onSaveLayout={onSaveLayout} />);
  await act(async () => {
    measureReactFlow(960, 640, 240);
    flushAnimationFrames();
  });
  await act(async () => {
    measureReactFlow(880, 640, 320);
    flushAnimationFrames();
  });
  await waitFor(() => expect(onSaveLayout).toHaveBeenCalledTimes(1));
  const firstSavedLayout = applyWorkspaceLayoutCommands(layout, onSaveLayout.mock.calls[0]![0]);
  const viewport = container.querySelector<HTMLElement>(".react-flow__viewport")!;
  expect(viewport).toHaveStyle({ transform: "translate(-80px,0px) scale(0.8)" });

  await act(async () => {
    measureReactFlow(800, 640, 400);
    flushAnimationFrames();
  });
  await waitFor(() => expect(viewport).toHaveStyle({
    transform: "translate(-160px,0px) scale(0.8)",
  }));

  await act(async () => {
    authoritative = firstSavedLayout;
    resolveFirstSave(firstSavedLayout);
    await firstSave;
  });

  expect(viewport).toHaveStyle({ transform: "translate(-160px,0px) scale(0.8)" });
  await waitFor(() => expect(onSaveLayout).toHaveBeenCalledTimes(2));
});

test("unmount flushes a pending resize viewport instead of restoring the old camera on return", async () => {
  const measureReactFlow = installReactFlowMeasurements(240);
  const animationFrames = new Map<number, FrameRequestCallback>();
  let nextAnimationFrameId = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextAnimationFrameId++;
    animationFrames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    animationFrames.delete(id);
  });
  const flushAnimationFrames = () => {
    const pending = [...animationFrames.values()];
    animationFrames.clear();
    for (const callback of pending) callback(0);
  };
  const onSaveLayout = vi.fn(async (commands: readonly WorkspaceLayoutCommand[]) => (
    applyWorkspaceLayoutCommands(layout, commands)
  ));
  const rendered = render(<CanvasHarness onSaveLayout={onSaveLayout} />);
  await act(async () => {
    measureReactFlow(960, 640, 240);
    flushAnimationFrames();
  });
  await act(async () => {
    measureReactFlow(880, 640, 320);
    flushAnimationFrames();
  });
  const viewport = rendered.container.querySelector<HTMLElement>(".react-flow__viewport");
  await waitFor(() => expect(viewport).toHaveStyle({
    transform: "translate(-80px,0px) scale(0.8)",
  }));

  await act(async () => rendered.unmount());

  await waitFor(() => expect(onSaveLayout).toHaveBeenCalledWith([
    { type: "set-viewport", viewport: { x: -80, y: 0, zoom: 0.8 } },
  ]));
  expect(onSaveLayout).toHaveBeenCalledTimes(1);
});

test("offscreen workspace nodes stay mounted after measurement so selection drags only use initialized nodes", async () => {
  const measureReactFlow = installReactFlowMeasurements();
  const offscreenLayout: WorkspaceLayout = {
    ...layout,
    objects: layout.objects.map((object) => object.id === "page-2"
      ? { ...object, x: 5_000, parentGroupId: null }
      : object),
    checksum: "layout-offscreen-node",
  };
  const { container } = render(
    <CanvasHarness canvasLayout={offscreenLayout} onSaveLayout={async () => offscreenLayout} />,
  );

  await act(async () => measureReactFlow());
  await act(async () => measureReactFlow());

  expect(container.querySelector('.react-flow__node[data-id="page-1"]')).not.toBeNull();
  expect(container.querySelector('.react-flow__node[data-id="page-2"]')).not.toBeNull();
});

test("canvas exposes a restrained Present flow entry when exact Snapshot playback is available", () => {
  const onPresentFlow = vi.fn();
  render(<CanvasHarness onSaveLayout={async () => layout} onPresentFlow={onPresentFlow} />);

  fireEvent.click(screen.getByRole("button", { name: "Present prototype flow" }));
  expect(onPresentFlow).toHaveBeenCalledTimes(1);
});

test("Research awaiting-selection treats sparse and explicit-null artifact revision pins identically", () => {
  const shared = {
    onSaveLayout: async () => researchLayout,
    canvasGraph: researchGraph,
    canvasLayout: researchLayout,
    resourceRevisionStates: {
      "research-1": {
        revisionId: "research-revision-1",
        resourceKind: "research" as const,
        qualityState: "grounded" as const,
      },
    },
  };
  const rendered = render(<CanvasHarness {...shared} artifactRevisionIds={{}} />);

  expect(screen.getByText(/Grounded · choose direction/i).closest("[data-awaiting-selection]"))
    .toHaveAttribute("data-awaiting-selection", "true");

  rendered.rerender(<CanvasHarness {...shared} artifactRevisionIds={{ "artifact-page-1": null }} />);
  expect(screen.getByText(/Grounded · choose direction/i).closest("[data-awaiting-selection]"))
    .toHaveAttribute("data-awaiting-selection", "true");
});

test("canvas exposes truthful keyboard instructions for editable and derived relationships", () => {
  const { container } = render(<CanvasHarness onSaveLayout={async () => layout} />);
  const node = container.querySelector<HTMLElement>('.react-flow__node[data-id="page-1"]');
  expect(node).not.toBeNull();

  const nodeDescriptionId = node!.getAttribute("aria-describedby")!;
  const nodeDescription = document.getElementById(nodeDescriptionId);
  const edgeDescription = document.getElementById(nodeDescriptionId.replace("node-desc", "edge-desc"));
  expect(nodeDescription).toHaveTextContent("Enter opens");
  expect(nodeDescription).toHaveTextContent("Nodes are not deleted with the keyboard");
  expect(edgeDescription).toHaveTextContent("Delete or Backspace removes selected editable relationships");
  expect(edgeDescription).toHaveTextContent("Uses relationships are derived and read-only");
});

test.each(["prototype", "informs", "derives-from"] as const)(
  "toolbar removes a selected editable %s relationship and clears selection after success",
  async (kind) => {
    const measureReactFlow = installReactFlowMeasurements();
    const onApplyGraphCommands = vi.fn(async (_commands: readonly WorkspaceGraphCommand[]) => {});
    const canvasGraph = graphWithRelationship(kind);
    const { container } = render(
      <CanvasHarness
        canvasGraph={canvasGraph}
        onSaveLayout={async () => layout}
        onApplyGraphCommands={onApplyGraphCommands}
        initialSelectedNodeIds={kind === "prototype" ? [] : ["page-1"]}
      />,
    );
    await act(async () => measureReactFlow());
    await act(async () => measureReactFlow());
    const edge = await waitFor(() => {
      const candidate = container.querySelector<HTMLElement>(`.react-flow__edge[data-id="${kind}-1"]`);
      expect(candidate).not.toBeNull();
      return candidate!;
    });
    fireEvent.click(edge);

    const remove = screen.getByRole("button", { name: "Delete selected relationship" });
    expect(remove).toBeEnabled();
    fireEvent.click(remove);

    await waitFor(() => expect(onApplyGraphCommands).toHaveBeenCalledWith([
      expect.objectContaining({ type: "remove-edge", edgeId: `${kind}-1` }),
    ]));
    await waitFor(() => expect(remove).toBeDisabled());
    expect(screen.getByRole("status", { name: "Canvas status" })).toHaveTextContent("Relationship removed");
  },
);

test.each(["Delete", "Backspace"])("%s removes a selected editable relationship", async (key) => {
  const measureReactFlow = installReactFlowMeasurements();
  const onApplyGraphCommands = vi.fn(async (_commands: readonly WorkspaceGraphCommand[]) => {});
  const { container } = render(
    <CanvasHarness onSaveLayout={async () => layout} onApplyGraphCommands={onApplyGraphCommands} />,
  );
  await act(async () => measureReactFlow());
  await act(async () => measureReactFlow());
  const edge = await waitFor(() => {
    const candidate = container.querySelector<HTMLElement>('.react-flow__edge[data-id="prototype-1"]');
    expect(candidate).not.toBeNull();
    return candidate!;
  });
  fireEvent.click(edge);
  await waitFor(() => expect(screen.getByRole("button", { name: "Delete selected relationship" })).toBeEnabled());

  fireEvent.keyDown(screen.getByRole("application", { name: "Project canvas" }), { key });

  await waitFor(() => expect(onApplyGraphCommands).toHaveBeenCalledWith([
    expect.objectContaining({ type: "remove-edge", edgeId: "prototype-1" }),
  ]));
});

test("a failed relationship removal keeps the relationship selected and exposes the failure", async () => {
  const measureReactFlow = installReactFlowMeasurements();
  const onApplyGraphCommands = vi.fn(async () => { throw new Error("Relationship removal failed"); });
  const { container } = render(
    <CanvasHarness onSaveLayout={async () => layout} onApplyGraphCommands={onApplyGraphCommands} />,
  );
  await act(async () => measureReactFlow());
  await act(async () => measureReactFlow());
  const edge = await waitFor(() => {
    const candidate = container.querySelector<HTMLElement>('.react-flow__edge[data-id="prototype-1"]');
    expect(candidate).not.toBeNull();
    return candidate!;
  });
  fireEvent.click(edge);
  const remove = screen.getByRole("button", { name: "Delete selected relationship" });

  fireEvent.click(remove);

  await waitFor(() => expect(screen.getByRole("status", { name: "Canvas status" })).toHaveTextContent("Relationship removal failed"));
  expect(remove).toBeEnabled();
});

test("derived uses relationships are explicitly read-only and never submit a remove command", async () => {
  const measureReactFlow = installReactFlowMeasurements();
  const onApplyGraphCommands = vi.fn(async () => {});
  const user = userEvent.setup();
  const { container } = render(
    <CanvasHarness
      canvasGraph={graphWithRelationship("uses")}
      onSaveLayout={async () => layout}
      onApplyGraphCommands={onApplyGraphCommands}
      initialSelectedNodeIds={["page-1"]}
    />,
  );
  await act(async () => measureReactFlow());
  await act(async () => measureReactFlow());
  const edge = await waitFor(() => {
    const candidate = container.querySelector<HTMLElement>('.react-flow__edge[data-id="uses-1"]');
    expect(candidate).not.toBeNull();
    return candidate!;
  });
  fireEvent.click(edge);

  const remove = screen.getByRole("button", { name: "Uses relationships are derived and read-only" });
  expect(remove).toHaveAttribute("aria-disabled", "true");
  expect(remove).toHaveAttribute("tabindex", "0");
  await user.hover(remove);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Uses relationships are derived and read-only");
  expect(screen.getByRole("tooltip")).not.toHaveTextContent("Select a relationship to delete");
  fireEvent.keyDown(screen.getByRole("application", { name: "Project canvas" }), { key: "Delete" });

  expect(onApplyGraphCommands).not.toHaveBeenCalled();
  expect(screen.getByRole("status", { name: "Canvas status" })).toHaveTextContent("Uses relationships are derived and read-only");
});

test("changing the relationship filter clears a selected relationship before hiding it", async () => {
  const user = userEvent.setup();
  const measureReactFlow = installReactFlowMeasurements();
  const onApplyGraphCommands = vi.fn(async () => {});
  const { container } = render(
    <CanvasHarness onSaveLayout={async () => layout} onApplyGraphCommands={onApplyGraphCommands} />,
  );
  await act(async () => measureReactFlow());
  await act(async () => measureReactFlow());
  const edge = await waitFor(() => {
    const candidate = container.querySelector<HTMLElement>('.react-flow__edge[data-id="prototype-1"]');
    expect(candidate).not.toBeNull();
    return candidate!;
  });
  fireEvent.click(edge);
  await waitFor(() => expect(screen.getByRole("button", { name: "Delete selected relationship" })).toBeEnabled());

  await user.click(screen.getByRole("button", { name: "Relationship filter: Prototype flow" }));
  await user.click(screen.getByRole("menuitemradio", { name: "Semantic relations" }));

  await waitFor(() => expect(screen.queryByRole("button", { name: "Delete selected relationship" })).toBeNull());
  expect(container.querySelector('.react-flow__edge[data-id="prototype-1"]')).toBeNull();
  expect(onApplyGraphCommands).not.toHaveBeenCalled();
});

test("a graph revision change clears relationship selection even when an edge id is reused", async () => {
  const measureReactFlow = installReactFlowMeasurements();
  const onApplyGraphCommands = vi.fn(async () => {});
  const rendered = render(
    <CanvasHarness onSaveLayout={async () => layout} onApplyGraphCommands={onApplyGraphCommands} />,
  );
  await act(async () => measureReactFlow());
  await act(async () => measureReactFlow());
  const edge = await waitFor(() => {
    const candidate = rendered.container.querySelector<HTMLElement>('.react-flow__edge[data-id="prototype-1"]');
    expect(candidate).not.toBeNull();
    return candidate!;
  });
  fireEvent.click(edge);
  await waitFor(() => expect(screen.getByRole("button", { name: "Delete selected relationship" })).toBeEnabled());

  rendered.rerender(
    <CanvasHarness
      canvasGraph={{ ...graphWithRelationship("uses", "prototype-1"), revision: 2 }}
      onSaveLayout={async () => layout}
      onApplyGraphCommands={onApplyGraphCommands}
    />,
  );

  await waitFor(() => expect(screen.queryByRole("button", { name: "Delete selected relationship" })).toBeNull());
  expect(screen.queryByRole("button", { name: "Uses relationships are derived and read-only" })).toBeNull();
  expect(onApplyGraphCommands).not.toHaveBeenCalled();
});

test("Resource nodes announce that Enter opens the exact revision viewer", () => {
  const { container } = render(
    <CanvasHarness
      onSaveLayout={async () => researchLayout}
      canvasGraph={researchGraph}
      canvasLayout={researchLayout}
      artifactRevisionIds={{ "artifact-page-1": null }}
      resourceRevisionStates={{
        "research-1": {
          revisionId: "research-revision-1",
          resourceKind: "research",
          qualityState: "grounded",
        },
      }}
    />,
  );
  const resource = container.querySelector<HTMLElement>('.react-flow__node[data-id="research-node"]');
  expect(resource).not.toBeNull();

  const description = document.getElementById(resource!.getAttribute("aria-describedby")!);
  expect(description).toHaveTextContent("For Resource nodes, Enter opens the exact revision viewer");
});

test("double-clicking a connection Handle never opens the artifact", () => {
  const onOpenArtifact = vi.fn();
  render(
    <CanvasHarness
      canvasLayout={fullZoomLayout}
      onSaveLayout={async () => fullZoomLayout}
      onOpenArtifact={onOpenArtifact}
    />,
  );

  fireEvent.doubleClick(screen.getByRole("button", { name: "Connect from Checkout" }));
  expect(onOpenArtifact).not.toHaveBeenCalled();
});

test("Group and Delete Group toolbar actions persist layout commands only", async () => {
  const onSaveLayout = vi.fn(async (_commands: readonly WorkspaceLayoutCommand[]) => layout);
  const onApplyGraphCommands = vi.fn(async () => {});
  render(<CanvasHarness onSaveLayout={onSaveLayout} onApplyGraphCommands={onApplyGraphCommands} />);

  openWorkspaceOutline();
  fireEvent.click(screen.getByRole("button", { name: /Select Page Checkout/i }));
  fireEvent.click(screen.getByRole("button", { name: "Group selection" }));
  await waitFor(() => expect(onSaveLayout).toHaveBeenCalledTimes(1));
  expect(onSaveLayout.mock.calls[0]?.[0][0]).toMatchObject({ type: "add-group" });
  expect(onApplyGraphCommands).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: /Select Group Purchase journey/i }));
  fireEvent.click(screen.getByRole("button", { name: "Delete group" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove frame" }));
  await waitFor(() => expect(onSaveLayout).toHaveBeenCalledTimes(2));
  expect(onSaveLayout.mock.calls[1]?.[0].at(-1)).toEqual({ type: "delete-group", groupId: "journey", ungroupChildren: true });
  expect(onApplyGraphCommands).not.toHaveBeenCalled();
});

test("a quick move then Group computes structural commands from the saved move", async () => {
  let resolveMove!: (next: WorkspaceLayout) => void;
  const moveResponse = new Promise<WorkspaceLayout>((resolve) => { resolveMove = resolve; });
  const onSaveLayout = vi.fn()
    .mockImplementationOnce(() => moveResponse)
    .mockImplementationOnce(async (commands: readonly WorkspaceLayoutCommand[]) => applyWorkspaceLayoutCommands(
      applyWorkspaceLayoutCommands(layout, [{ type: "move", objectId: "page-1", x: 41, y: 70 }]),
      commands,
    ));
  render(<CanvasHarness onSaveLayout={onSaveLayout} />);

  openWorkspaceOutline();
  fireEvent.click(screen.getByRole("button", { name: /Select Page Checkout/i }));
  fireEvent.keyDown(screen.getByRole("application", { name: "Project canvas" }), { key: "ArrowRight" });
  await waitFor(() => expect(onSaveLayout).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Group selection" }));
  expect(onSaveLayout).toHaveBeenCalledTimes(1);

  resolveMove(applyWorkspaceLayoutCommands(layout, onSaveLayout.mock.calls[0]![0]));
  await waitFor(() => expect(onSaveLayout).toHaveBeenCalledTimes(2));
  expect(onSaveLayout.mock.calls[1]![0][0]).toMatchObject({
    type: "add-group",
    bounds: { x: 33 },
  });
});

test("changing selection closes a pending group removal confirmation", () => {
  render(<CanvasHarness onSaveLayout={async () => layout} />);
  openWorkspaceOutline();
  fireEvent.click(screen.getByRole("button", { name: /Select Group Purchase journey/i }));
  fireEvent.click(screen.getByRole("button", { name: "Delete group" }));
  expect(screen.getByRole("button", { name: "Remove frame" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /Select Page Checkout/i }));
  expect(screen.queryByRole("button", { name: "Remove frame" })).toBeNull();
});

test("canvas keyboard controls open, clear, switch tools, fit, and persist one owned arrow movement", async () => {
  const onOpenArtifact = vi.fn();
  const onSaveLayout = vi.fn(async (_commands: readonly WorkspaceLayoutCommand[]) => layout);
  render(<CanvasHarness onSaveLayout={onSaveLayout} onOpenArtifact={onOpenArtifact} />);
  openWorkspaceOutline();
  fireEvent.click(screen.getByRole("button", { name: /Select Page Checkout/i }));
  const canvas = screen.getByRole("application", { name: "Project canvas" });

  fireEvent.keyDown(canvas, { key: "Enter" });
  expect(onOpenArtifact).toHaveBeenCalledWith("artifact-page-1");
  fireEvent.keyDown(canvas, { key: "h" });
  expect(screen.getByRole("button", { name: "Hand tool" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.keyDown(canvas, { key: "v" });
  expect(screen.getByRole("button", { name: "Select tool" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.keyDown(canvas, { key: "1", shiftKey: true });
  expect(screen.getByRole("status", { name: "Canvas status" })).toHaveTextContent("Fit workspace");
  fireEvent.keyDown(canvas, { key: "ArrowRight" });
  await waitFor(() => expect(onSaveLayout).toHaveBeenCalledWith([
    { type: "move", objectId: "page-1", x: 41, y: 70 },
  ]));
  fireEvent.keyDown(canvas, { key: "Escape" });
  expect(screen.queryByRole("button", { name: "Group selection" })).toBeNull();
});

test("an older move response cannot overwrite a newer optimistic node position", async () => {
  let resolveFirst!: (next: WorkspaceLayout) => void;
  let resolveSecond!: (next: WorkspaceLayout) => void;
  const first = new Promise<WorkspaceLayout>((resolve) => { resolveFirst = resolve; });
  const second = new Promise<WorkspaceLayout>((resolve) => { resolveSecond = resolve; });
  const onSaveLayout = vi.fn()
    .mockImplementationOnce(() => first)
    .mockImplementationOnce(() => second)
    .mockImplementationOnce(async (commands: readonly WorkspaceLayoutCommand[]) => (
      applyWorkspaceLayoutCommands(
        applyWorkspaceLayoutCommands(
          applyWorkspaceLayoutCommands(layout, [{ type: "move", objectId: "page-1", x: 41, y: 70 }]),
          [{ type: "move", objectId: "page-1", x: 42, y: 70 }],
        ),
        commands,
      )
    ));
  render(<AuthoritativeCanvasHarness onSaveLayout={onSaveLayout} />);
  const canvas = screen.getByRole("application", { name: "Project canvas" });

  fireEvent.keyDown(canvas, { key: "ArrowRight" });
  await waitFor(() => expect(onSaveLayout).toHaveBeenCalledTimes(1));
  fireEvent.keyDown(canvas, { key: "ArrowRight" });

  await act(async () => {
    resolveFirst(applyWorkspaceLayoutCommands(layout, onSaveLayout.mock.calls[0]![0]));
  });
  await waitFor(() => expect(onSaveLayout).toHaveBeenCalledTimes(2));
  fireEvent.keyDown(canvas, { key: "ArrowRight" });

  await act(async () => {
    resolveSecond(applyWorkspaceLayoutCommands(
      applyWorkspaceLayoutCommands(layout, onSaveLayout.mock.calls[0]![0]),
      onSaveLayout.mock.calls[1]![0],
    ));
  });
  await waitFor(() => expect(onSaveLayout).toHaveBeenCalledTimes(3));
  expect(onSaveLayout.mock.calls[2]![0]).toEqual([
    { type: "move", objectId: "page-1", x: 43, y: 70 },
  ]);
});

test("an older move failure cannot roll back a newer optimistic node position", async () => {
  let rejectFirst!: (reason: Error) => void;
  let resolveSecond!: (next: WorkspaceLayout) => void;
  const first = new Promise<WorkspaceLayout>((_resolve, reject) => { rejectFirst = reject; });
  const second = new Promise<WorkspaceLayout>((resolve) => { resolveSecond = resolve; });
  const onSaveLayout = vi.fn()
    .mockImplementationOnce(() => first)
    .mockImplementationOnce(() => second)
    .mockImplementationOnce(async (commands: readonly WorkspaceLayoutCommand[]) => (
      applyWorkspaceLayoutCommands(
        applyWorkspaceLayoutCommands(layout, [{ type: "move", objectId: "page-1", x: 42, y: 70 }]),
        commands,
      )
    ));
  render(<AuthoritativeCanvasHarness onSaveLayout={onSaveLayout} />);
  const canvas = screen.getByRole("application", { name: "Project canvas" });

  fireEvent.keyDown(canvas, { key: "ArrowRight" });
  await waitFor(() => expect(onSaveLayout).toHaveBeenCalledTimes(1));
  fireEvent.keyDown(canvas, { key: "ArrowRight" });

  await act(async () => {
    rejectFirst(new Error("first move failed"));
  });
  await waitFor(() => expect(onSaveLayout).toHaveBeenCalledTimes(2));
  fireEvent.keyDown(canvas, { key: "ArrowRight" });

  await act(async () => {
    resolveSecond(applyWorkspaceLayoutCommands(layout, onSaveLayout.mock.calls[1]![0]));
  });
  await waitFor(() => expect(onSaveLayout).toHaveBeenCalledTimes(3));
  expect(onSaveLayout.mock.calls[2]![0]).toEqual([
    { type: "move", objectId: "page-1", x: 43, y: 70 },
  ]);
});

test("a workspace model refresh preserves the optimistic node position while its move is pending", async () => {
  let resolveFirst!: (next: WorkspaceLayout) => void;
  const first = new Promise<WorkspaceLayout>((resolve) => { resolveFirst = resolve; });
  const movedOnce = applyWorkspaceLayoutCommands(
    layout,
    [{ type: "move", objectId: "page-1", x: 41, y: 70 }],
  );
  const onSaveLayout = vi.fn()
    .mockImplementationOnce(() => first)
    .mockImplementationOnce(async (commands: readonly WorkspaceLayoutCommand[]) => (
      applyWorkspaceLayoutCommands(movedOnce, commands)
    ));
  render(<AuthoritativeCanvasHarness onSaveLayout={onSaveLayout} />);
  const canvas = screen.getByRole("application", { name: "Project canvas" });

  fireEvent.keyDown(canvas, { key: "ArrowRight" });
  await waitFor(() => expect(onSaveLayout).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Refresh workspace model" }));
  fireEvent.keyDown(canvas, { key: "ArrowRight" });

  await act(async () => {
    resolveFirst(movedOnce);
  });
  await waitFor(() => expect(onSaveLayout).toHaveBeenCalledTimes(2));
  expect(onSaveLayout.mock.calls[1]![0]).toEqual([
    { type: "move", objectId: "page-1", x: 42, y: 70 },
  ]);
});

test("a late save from the previous project cannot contaminate the next project's layout queue", async () => {
  const measureReactFlow = installReactFlowMeasurements();
  const firstProjectLayout: WorkspaceLayout = {
    workspaceId: "workspace-1",
    layoutId: "default",
    objects: [
      { id: "page-1", kind: "node", x: 40, y: 70, parentGroupId: null },
      { id: "page-2", kind: "node", x: 370, y: 70, parentGroupId: null },
    ],
    viewport: { x: 0, y: 0, zoom: 0.8 },
    checksum: "project-1-layout",
  };
  const secondProjectGraph: WorkspaceGraph = {
    ...graph,
    workspaceId: "workspace-2",
    nodes: graph.nodes.map((node) => ({ ...node, workspaceId: "workspace-2" })),
    edges: graph.edges.map((edge) => ({ ...edge, workspaceId: "workspace-2" })),
  };
  const secondProjectLayout: WorkspaceLayout = {
    ...layout,
    workspaceId: "workspace-2",
    checksum: "project-2-layout",
  };
  let resolveFirstProjectSave!: (saved: WorkspaceLayout) => void;
  const firstProjectSave = new Promise<WorkspaceLayout>((resolve) => {
    resolveFirstProjectSave = resolve;
  });
  const onSaveFirstProject = vi.fn((_commands: readonly WorkspaceLayoutCommand[]) => firstProjectSave);
  const onSaveSecondProject = vi.fn(async (commands: readonly WorkspaceLayoutCommand[]) => (
    applyWorkspaceLayoutCommands(secondProjectLayout, commands)
  ));
  const common = {
    projectName: "Storefront system",
    artifactRevisionIds: { "artifact-page-1": "revision-1" },
    selectedNodeIds: ["page-1"] as const,
    onSelectionChange: vi.fn(),
    onApplyGraphCommands: vi.fn(async () => {}),
    onOpenArtifact: vi.fn(),
  };
  const rendered = render(
    <ProjectCanvas
      {...common}
      projectId="project-1"
      graph={graph}
      layout={firstProjectLayout}
      onSaveLayout={onSaveFirstProject}
    />,
  );
  await act(async () => measureReactFlow());
  const canvas = await screen.findByRole("application", { name: "Project canvas" });

  fireEvent.keyDown(canvas, { key: "ArrowRight" });
  await waitFor(() => expect(onSaveFirstProject).toHaveBeenCalledTimes(1));

  rendered.rerender(
    <ProjectCanvas
      {...common}
      projectId="project-2"
      graph={secondProjectGraph}
      layout={secondProjectLayout}
      onSaveLayout={onSaveSecondProject}
    />,
  );
  await act(async () => measureReactFlow());
  await waitFor(() => expect(screen.getByRole("button", { name: "Ungroup selection" })).toBeEnabled());

  fireEvent.click(screen.getByRole("button", { name: "Ungroup selection" }));

  await waitFor(() => expect(onSaveSecondProject).toHaveBeenCalledWith([
    { type: "move", objectId: "page-1", x: 80, y: 110 },
    { type: "set-parent", objectId: "page-1", parentGroupId: null },
  ]));

  await act(async () => {
    resolveFirstProjectSave(applyWorkspaceLayoutCommands(
      firstProjectLayout,
      onSaveFirstProject.mock.calls[0]![0],
    ));
    await firstProjectSave;
  });
});

test("a stale collapse save cannot restore the previous project's selection", async () => {
  const measureReactFlow = installReactFlowMeasurements();
  const secondProjectGraph: WorkspaceGraph = {
    ...graph,
    workspaceId: "workspace-2",
    nodes: graph.nodes.map((node) => ({ ...node, workspaceId: "workspace-2" })),
    edges: graph.edges.map((edge) => ({ ...edge, workspaceId: "workspace-2" })),
  };
  const secondProjectLayout: WorkspaceLayout = {
    ...layout,
    workspaceId: "workspace-2",
    checksum: "project-2-layout",
  };
  let resolveFirstProjectSave!: (saved: WorkspaceLayout) => void;
  const firstProjectSave = new Promise<WorkspaceLayout>((resolve) => {
    resolveFirstProjectSave = resolve;
  });
  const onSaveFirstProject = vi.fn((_commands: readonly WorkspaceLayoutCommand[]) => firstProjectSave);
  const onSelectionChange = vi.fn();
  const common = {
    projectName: "Storefront system",
    artifactRevisionIds: { "artifact-page-1": "revision-1" },
    onSelectionChange,
    onApplyGraphCommands: vi.fn(async () => {}),
    onOpenArtifact: vi.fn(),
  };
  const rendered = render(
    <ProjectCanvas
      {...common}
      projectId="project-1"
      graph={graph}
      layout={layout}
      selectedNodeIds={["journey", "page-1"]}
      onSaveLayout={onSaveFirstProject}
    />,
  );
  await act(async () => measureReactFlow());

  fireEvent.click(await screen.findByRole("button", { name: "Collapse group Purchase journey" }));
  await waitFor(() => expect(onSaveFirstProject).toHaveBeenCalledTimes(1));
  expect(onSelectionChange).toHaveBeenCalledTimes(1);

  rendered.rerender(
    <ProjectCanvas
      {...common}
      projectId="project-2"
      graph={secondProjectGraph}
      layout={secondProjectLayout}
      selectedNodeIds={[]}
      onSaveLayout={vi.fn(async () => secondProjectLayout)}
    />,
  );
  await act(async () => measureReactFlow());

  await act(async () => {
    resolveFirstProjectSave(applyWorkspaceLayoutCommands(
      layout,
      onSaveFirstProject.mock.calls[0]![0],
    ));
    await firstProjectSave;
  });

  expect(onSelectionChange).toHaveBeenCalledTimes(1);
});

test("full semantic zoom exposes keyboard Page handles and compact zoom removes them from the accessibility tree", async () => {
  const onApplyGraphCommands = vi.fn(async (_commands: readonly WorkspaceGraphCommand[]) => {});
  const { unmount } = render(
    <CanvasHarness
      canvasLayout={fullZoomLayout}
      onSaveLayout={async () => fullZoomLayout}
      onApplyGraphCommands={onApplyGraphCommands}
    />,
  );

  const source = screen.getByRole("button", { name: "Connect from Checkout" });
  const target = screen.getByRole("button", { name: "Connect into Receipt" });
  let pointedElement: Element = source;
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => pointedElement,
  });
  fireEvent.keyDown(source, { key: "Enter" });
  pointedElement = target;
  fireEvent.keyDown(target, { key: "Enter" });
  await waitFor(() => expect(onApplyGraphCommands).toHaveBeenCalledTimes(1));
  expect(onApplyGraphCommands.mock.calls[0]?.[0][0]).toMatchObject({ type: "add-edge" });
  Reflect.deleteProperty(document, "elementFromPoint");

  unmount();
  render(
    <CanvasHarness
      canvasLayout={{ ...layout, viewport: { ...layout.viewport, zoom: 0.6 } }}
      onSaveLayout={async () => layout}
    />,
  );
  expect(screen.queryByRole("button", { name: "Connect from Checkout" })).not.toBeInTheDocument();
});

test("canvas reconciliation reuses unchanged nodes and edges across workspace polling", () => {
  const original = workspaceGraphToFlow(graph, layout, {
    zoom: layout.viewport.zoom,
    edgeFilter: "all",
    projectId: "project-1",
    artifactRevisionIds: { "artifact-page-1": "revision-1" },
  });
  const incoming = workspaceGraphToFlow(graph, layout, {
    zoom: layout.viewport.zoom,
    edgeFilter: "all",
    projectId: "project-1",
    artifactRevisionIds: { "artifact-page-1": "revision-1" },
  });
  const measuredNode = {
    ...original.nodes[1]!,
    measured: { width: 312, height: 220 },
  } satisfies WorkspaceFlowNode;
  const currentEdges = [{ ...original.edges[0]! }] satisfies WorkspaceFlowEdge[];

  const nextNodes = reconcileCanvasNodes(
    [original.nodes[0]!, measuredNode, original.nodes[2]!],
    incoming.nodes,
    new Map(),
  );
  const nextEdges = reconcileCanvasEdges(currentEdges, incoming.edges);

  expect(nextNodes[1]).toBe(measuredNode);
  expect(nextNodes[1]?.measured).toEqual({ width: 312, height: 220 });
  expect(nextEdges[0]).toBe(currentEdges[0]);
});

test("canvas reconciliation keeps measured geometry when semantic node data changes", () => {
  const original = workspaceGraphToFlow(graph, layout, {
    zoom: layout.viewport.zoom,
    edgeFilter: "all",
    projectId: "project-1",
    artifactRevisionIds: { "artifact-page-1": "revision-1" },
  });
  const current = {
    ...original.nodes[1]!,
    measured: { width: 312, height: 220 },
  } satisfies WorkspaceFlowNode;
  const incoming = {
    ...original.nodes[1]!,
    data: {
      ...original.nodes[1]!.data,
      generationState: "running" as const,
      generationMessage: "Refining the page",
    },
  } satisfies WorkspaceFlowNode;

  const [next] = reconcileCanvasNodes([current], [incoming], new Map());

  expect(next).not.toBe(current);
  expect(next?.data.generationState).toBe("running");
  expect(next?.measured).toEqual({ width: 312, height: 220 });
});

test("canvas reconciliation keeps measured geometry during an optimistic move", () => {
  const original = workspaceGraphToFlow(graph, layout, {
    zoom: layout.viewport.zoom,
    edgeFilter: "all",
    projectId: "project-1",
    artifactRevisionIds: { "artifact-page-1": "revision-1" },
  }).nodes[1]!;
  const current = {
    ...original,
    measured: { width: 312, height: 220 },
  } satisfies WorkspaceFlowNode;

  const [next] = reconcileCanvasNodes(
    [current],
    [{ ...original, position: { x: 52, y: 70 } }],
    new Map([["page-1", { generation: 1, position: { x: 64, y: 70 } }]]),
  );

  expect(next?.position).toEqual({ x: 64, y: 70 });
  expect(next?.measured).toEqual({ width: 312, height: 220 });
});

test("canvas reconciliation invalidates measured geometry when declared node geometry changes", () => {
  const original = workspaceGraphToFlow(graph, layout, {
    zoom: layout.viewport.zoom,
    edgeFilter: "all",
    projectId: "project-1",
    artifactRevisionIds: { "artifact-page-1": "revision-1" },
  }).nodes[1]!;
  const current = {
    ...original,
    measured: { width: 312, height: 220 },
  } satisfies WorkspaceFlowNode;
  const incoming = {
    ...original,
    style: { ...original.style, width: 420 },
  } satisfies WorkspaceFlowNode;

  const [next] = reconcileCanvasNodes([current], [incoming], new Map());

  expect(next?.style).toMatchObject({ width: 420 });
  expect(next?.measured).toBeUndefined();
});

test("canvas reconciliation preserves active resizer geometry across semantic model refreshes", () => {
  const original = workspaceGraphToFlow(graph, layout, {
    zoom: layout.viewport.zoom,
    edgeFilter: "all",
    projectId: "project-1",
    artifactRevisionIds: { "artifact-page-1": "revision-1" },
  }).nodes[0]!;
  const current = {
    ...original,
    width: 760,
    height: 420,
    measured: { width: 760, height: 420 },
    resizing: true,
  } satisfies WorkspaceFlowNode;
  const incoming = {
    ...original,
    data: { ...original.data, name: "Purchase journey refreshed" },
  } satisfies WorkspaceFlowNode;

  const [next] = reconcileCanvasNodes([current], [incoming], new Map());

  expect(next).toMatchObject({
    width: 760,
    height: 420,
    measured: { width: 760, height: 420 },
    resizing: true,
  });
});

test("canvas reconciliation keeps a new live drag ahead of an older pending move acknowledgement", () => {
  const original = workspaceGraphToFlow(graph, layout, {
    zoom: layout.viewport.zoom,
    edgeFilter: "all",
    projectId: "project-1",
    artifactRevisionIds: { "artifact-page-1": "revision-1" },
  }).nodes[1]!;
  const current = {
    ...original,
    position: { x: 112, y: 96 },
    dragging: true,
    measured: { width: 312, height: 220 },
  } satisfies WorkspaceFlowNode;
  const incoming = {
    ...original,
    data: { ...original.data, generationState: "running" as const },
  } satisfies WorkspaceFlowNode;

  const [next] = reconcileCanvasNodes(
    [current],
    [incoming],
    new Map([["page-1", { generation: 1, position: { x: 72, y: 80 } }]]),
  );

  expect(next).toMatchObject({
    position: { x: 112, y: 96 },
    dragging: true,
  });
});

test("canvas reconciliation keeps a new live resize ahead of an older pending resize acknowledgement", () => {
  const original = workspaceGraphToFlow(graph, layout, {
    zoom: layout.viewport.zoom,
    edgeFilter: "all",
    projectId: "project-1",
    artifactRevisionIds: { "artifact-page-1": "revision-1" },
  }).nodes[0]!;
  const current = {
    ...original,
    position: { x: 4, y: 12 },
    width: 820,
    height: 460,
    measured: { width: 820, height: 460 },
    resizing: true,
  } satisfies WorkspaceFlowNode;
  const incoming = {
    ...original,
    data: { ...original.data, name: "Purchase journey refreshed" },
  } satisfies WorkspaceFlowNode;

  const [next] = reconcileCanvasNodes(
    [current],
    [incoming],
    new Map(),
    new Map([[
      "journey",
      {
        generation: 1,
        position: { x: 20, y: 24 },
        width: 760,
        height: 420,
      },
    ]]),
  );

  expect(next).toMatchObject({
    position: { x: 4, y: 12 },
    width: 820,
    height: 460,
    measured: { width: 820, height: 460 },
    resizing: true,
  });
});

test("canvas reconciliation uses the newest completed position across move and resize saves", () => {
  const original = workspaceGraphToFlow(graph, layout, {
    zoom: layout.viewport.zoom,
    edgeFilter: "all",
    projectId: "project-1",
    artifactRevisionIds: { "artifact-page-1": "revision-1" },
  }).nodes[0]!;

  const [resizeAfterMove] = reconcileCanvasNodes(
    [original],
    [original],
    new Map([["journey", { generation: 1, position: { x: 72, y: 80 } }]]),
    new Map([[
      "journey",
      {
        generation: 2,
        position: { x: 18, y: 22 },
        width: 760,
        height: 420,
      },
    ]]),
  );
  const [moveAfterResize] = reconcileCanvasNodes(
    [original],
    [original],
    new Map([["journey", { generation: 4, position: { x: 96, y: 104 } }]]),
    new Map([[
      "journey",
      {
        generation: 3,
        position: { x: 18, y: 22 },
        width: 760,
        height: 420,
      },
    ]]),
  );

  expect(resizeAfterMove?.position).toEqual({ x: 18, y: 22 });
  expect(moveAfterResize?.position).toEqual({ x: 96, y: 104 });
});

test("canvas reconciliation preserves completed group resize geometry while its save is pending", () => {
  const original = workspaceGraphToFlow(graph, layout, {
    zoom: layout.viewport.zoom,
    edgeFilter: "all",
    projectId: "project-1",
    artifactRevisionIds: { "artifact-page-1": "revision-1" },
  }).nodes[0]!;
  const current = {
    ...original,
    position: { x: 10, y: 20 },
    width: 760,
    height: 420,
    measured: { width: 760, height: 420 },
    resizing: false,
  } satisfies WorkspaceFlowNode;
  const incoming = {
    ...original,
    data: { ...original.data, name: "Purchase journey refreshed" },
  } satisfies WorkspaceFlowNode;

  const [next] = reconcileCanvasNodes(
    [current],
    [incoming],
    new Map(),
    new Map([[
      "journey",
      {
        generation: 1,
        position: { x: 10, y: 20 },
        width: 760,
        height: 420,
      },
    ]]),
  );

  expect(next).toMatchObject({
    position: { x: 10, y: 20 },
    style: { width: 760, height: 420 },
    width: 760,
    height: 420,
    measured: { width: 760, height: 420 },
    resizing: false,
  });
  expect(next?.data.name).toBe("Purchase journey refreshed");
});

test("canvas reconciliation rolls an unsaved completed resize back to authoritative geometry", () => {
  const original = workspaceGraphToFlow(graph, layout, {
    zoom: layout.viewport.zoom,
    edgeFilter: "all",
    projectId: "project-1",
    artifactRevisionIds: { "artifact-page-1": "revision-1" },
  }).nodes[0]!;
  const current = {
    ...original,
    width: 760,
    height: 420,
    measured: { width: 760, height: 420 },
    resizing: false,
  } satisfies WorkspaceFlowNode;

  const [next] = reconcileCanvasNodes([current], [original], new Map());

  expect(next).not.toBe(current);
  expect(next?.style).toEqual(original.style);
  expect(next?.width).toBeUndefined();
  expect(next?.height).toBeUndefined();
  expect(next?.measured).toBeUndefined();
});

test("canvas reconciliation follows authoritative node and edge ordering", () => {
  const model = workspaceGraphToFlow(graph, layout, {
    zoom: layout.viewport.zoom,
    edgeFilter: "all",
    projectId: "project-1",
    artifactRevisionIds: { "artifact-page-1": "revision-1" },
  });
  const currentNodes = [...model.nodes];
  const incomingNodes = [...model.nodes].reverse().map((node) => ({ ...node }));
  const secondEdge = {
    ...model.edges[0]!,
    id: "prototype-2",
  } satisfies WorkspaceFlowEdge;
  const currentEdges = [model.edges[0]!, secondEdge];
  const incomingEdges = [{ ...secondEdge }, { ...model.edges[0]! }];

  const nextNodes = reconcileCanvasNodes(currentNodes, incomingNodes, new Map());
  const nextEdges = reconcileCanvasEdges(currentEdges, incomingEdges);

  expect(nextNodes).not.toBe(currentNodes);
  expect(nextNodes.map((node) => node.id)).toEqual(incomingNodes.map((node) => node.id));
  expect(nextEdges).not.toBe(currentEdges);
  expect(nextEdges.map((edge) => edge.id)).toEqual(["prototype-2", "prototype-1"]);
});

test("shortcut target guard uses closest and ignores nested interactive/contenteditable targets", () => {
  const host = document.createElement("div");
  host.innerHTML = `
    <button><span id="inside-button">Icon</span></button>
    <div contenteditable="true"><span id="inside-editable">Text</span></div>
    <div id="plain">Canvas</div>
  `;
  expect(isCanvasShortcutTarget(host.querySelector("#inside-button"))).toBe(true);
  expect(isCanvasShortcutTarget(host.querySelector("#inside-editable"))).toBe(true);
  expect(isCanvasShortcutTarget(host.querySelector("#plain"))).toBe(false);
});

function project(): Project {
  return { id: "project-1", name: "Storefront", skillId: null, designSystemId: null, mode: "standard", createdAt: 1, updatedAt: 1 };
}

function readyWorkspace(
  revision = 1,
  nextLayout = layout,
  nextGraph: WorkspaceGraph = graph,
): ReadyProjectWorkspacePayload {
  const currentGraph = { ...nextGraph, revision };
  const snapshotId = `snapshot-${revision}`;
  const snapshot = {
    id: snapshotId,
    workspaceId: graph.workspaceId,
    sequence: revision,
    parentSnapshotId: revision === 1 ? null : `snapshot-${revision - 1}`,
    graphRevision: revision,
    kernelRevisionId: "kernel-1",
    reason: "graph-command",
    provenance: revision === 1 ? { kind: "workspace-created" as const } : { kind: "graph-command" as const, commandIds: ["command"] },
    createdByRunId: null,
    createdAt: revision,
    graph: currentGraph,
    artifactTracks: {},
    artifactRevisions: { "artifact-page-1": "revision-1", "artifact-page-2": null },
    resourceRevisions: {},
  };
  return {
    status: "ready",
    workspace: { id: graph.workspaceId, projectId: "project-1", mode: "standard", graphRevision: revision, activeSnapshotId: snapshotId, activeKernelRevisionId: "kernel-1", createdAt: 1, updatedAt: revision },
    graph: currentGraph,
    activeSnapshot: snapshot,
    activeKernelRevision: {
      id: "kernel-1",
      workspaceId: graph.workspaceId,
      sequence: 1,
      parentRevisionId: null,
      tokens: {},
      typography: {},
      sharedAssetRevisionIds: [],
      brief: "",
      terminology: {},
      exclusions: [],
      responsiveFrames: [],
      qualityProfile: { requiredFrameIds: [], blockingSeverities: [], requireRuntimeChecks: false, requireVisualReview: false },
      checksum: "kernel",
      createdAt: 1,
    },
    artifacts: [],
    tracks: [],
    revisions: [],
    snapshots: [snapshot],
    layout: nextLayout,
  };
}

function StudioMutationProbe() {
  const studio = useProjectStudio("project-1");
  const [layoutError, setLayoutError] = useState("");
  const [graphResult, setGraphResult] = useState("");
  if (studio.load.status !== "ready") return <div>{studio.load.status}</div>;
  const applyAndReport = (commands: readonly WorkspaceGraphCommand[]) => {
    setGraphResult("");
    void studio.applyGraphCommands(commands)
      .then(() => setGraphResult("ok"))
      .catch((error: unknown) => setGraphResult(error instanceof Error ? error.message : String(error)));
  };
  return (
    <div>
      <output data-testid="studio-pointers">
        {studio.load.workspace.graph.revision}:{studio.load.workspace.activeSnapshot.id}:{studio.load.workspace.layout.viewport.x}
      </output>
      <output data-testid="layout-error">{layoutError}</output>
      <output data-testid="graph-result">{graphResult}</output>
      <button
        type="button"
        onClick={() => void studio.saveLayout([{
          type: "set-viewport",
          viewport: { x: 44, y: 0, zoom: 1 },
        }]).catch((error: unknown) => {
          setLayoutError(error instanceof Error ? error.message : String(error));
        })}
      >
        Save layout
      </button>
      <button
        type="button"
        onClick={() => applyAndReport([{
          id: "command-next",
          type: "rename-node",
          nodeId: "page-1",
          name: "Checkout next",
        }])}
      >
        Apply graph
      </button>
      <button
        type="button"
        onClick={() => applyAndReport([{
          id: "command-edge",
          type: "add-edge",
          edge: {
            id: "prototype-conflict",
            workspaceId: graph.workspaceId,
            kind: "prototype",
            sourceNodeId: "page-1",
            targetNodeId: "page-2",
          },
        }])}
      >
        Add graph edge
      </button>
      <button
        type="button"
        onClick={() => applyAndReport([{
          id: "command-remove-edge",
          type: "remove-edge",
          edgeId: "prototype-1",
        }])}
      >
        Remove graph edge
      </button>
      <button
        type="button"
        onClick={() => applyAndReport([
          { id: "command-remove-edge-a", type: "remove-edge", edgeId: "prototype-1" },
          { id: "command-remove-edge-b", type: "remove-edge", edgeId: "prototype-1" },
        ])}
      >
        Remove graph edge twice
      </button>
    </div>
  );
}

describe("Project Studio authoritative persistence", () => {
  test("layout save rebases once on graph revision conflict", async () => {
    const refreshed = readyWorkspace(2);
    const getWorkspace = vi.fn()
      .mockResolvedValueOnce(readyWorkspace(1))
      .mockResolvedValueOnce(refreshed);
    const savedLayout = { ...layout, viewport: { x: 44, y: 0, zoom: 1 } };
    const saveWorkspaceLayout = vi.fn()
      .mockRejectedValueOnce(new ApiError(409, "stale", { code: "workspace_revision_conflict" }))
      .mockResolvedValueOnce(savedLayout);
    render(
      <ApiProvider client={makeFakeApi({ getProject: async () => project(), getWorkspace, saveWorkspaceLayout })}>
        <StudioMutationProbe />
      </ApiProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Save layout" }));
    await waitFor(() => expect(saveWorkspaceLayout).toHaveBeenCalledTimes(2));
    expect(saveWorkspaceLayout.mock.calls.map((call) => call[1].graphRevision)).toEqual([1, 2]);
    expect(getWorkspace).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("studio-pointers")).toHaveTextContent("2:snapshot-2:44");
  });

  test("layout checksum conflict refreshes authoritative layout without replaying an absolute command", async () => {
    const refreshedLayout = {
      ...layout,
      viewport: { x: 96, y: 0, zoom: 1 },
      checksum: "layout-2",
    };
    const getWorkspace = vi.fn()
      .mockResolvedValueOnce(readyWorkspace(1))
      .mockResolvedValueOnce(readyWorkspace(1, refreshedLayout));
    const saveWorkspaceLayout = vi.fn()
      .mockRejectedValueOnce(new ApiError(409, "layout stale", { code: "workspace_layout_conflict" }));
    render(
      <ApiProvider client={makeFakeApi({ getProject: async () => project(), getWorkspace, saveWorkspaceLayout })}>
        <StudioMutationProbe />
      </ApiProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Save layout" }));
    await waitFor(() => expect(screen.getByTestId("layout-error")).toHaveTextContent("layout stale"));
    expect(saveWorkspaceLayout).toHaveBeenCalledTimes(1);
    expect(saveWorkspaceLayout.mock.calls[0]?.[1]).toMatchObject({
      graphRevision: 1,
      baseLayoutChecksum: "layout-1",
    });
    expect(getWorkspace).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("studio-pointers")).toHaveTextContent("1:snapshot-1:96");
  });

  test("overlapping layout saves serialize so an older full-layout response cannot clobber a newer one", async () => {
    let resolveFirst!: (value: WorkspaceLayout) => void;
    const first = new Promise<WorkspaceLayout>((resolve) => { resolveFirst = resolve; });
    const saveWorkspaceLayout = vi.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce({ ...layout, viewport: { x: 88, y: 0, zoom: 1 } });
    render(
      <ApiProvider client={makeFakeApi({
        getProject: async () => project(),
        getWorkspace: async () => readyWorkspace(1),
        saveWorkspaceLayout,
      })}>
        <StudioMutationProbe />
      </ApiProvider>,
    );

    const save = await screen.findByRole("button", { name: "Save layout" });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(saveWorkspaceLayout).toHaveBeenCalledTimes(1));
    resolveFirst({ ...layout, viewport: { x: 44, y: 0, zoom: 1 } });
    await waitFor(() => expect(saveWorkspaceLayout).toHaveBeenCalledTimes(2));
    expect(saveWorkspaceLayout.mock.invocationCallOrder[0]).toBeLessThan(saveWorkspaceLayout.mock.invocationCallOrder[1]!);
  });

  test("graph mutation atomically advances graph and Snapshot pointers for the next CAS", async () => {
    const next = readyWorkspace(2);
    const applyWorkspaceGraphCommands = vi.fn(async (_projectId: string, _input: GraphCommandRequest) => ({ graph: next.graph, snapshot: next.activeSnapshot }));
    render(
      <ApiProvider client={makeFakeApi({
        getProject: async () => project(),
        getWorkspace: async () => readyWorkspace(1),
        applyWorkspaceGraphCommands,
      })}>
        <StudioMutationProbe />
      </ApiProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Apply graph" }));
    await waitFor(() => expect(screen.getByTestId("studio-pointers")).toHaveTextContent("2:snapshot-2"));
    fireEvent.click(screen.getByRole("button", { name: "Apply graph" }));
    await waitFor(() => expect(applyWorkspaceGraphCommands).toHaveBeenCalledTimes(2));
    expect(applyWorkspaceGraphCommands.mock.calls[0]?.[1]).toMatchObject({ baseGraphRevision: 1, expectedSnapshotId: "snapshot-1" });
    expect(applyWorkspaceGraphCommands.mock.calls[1]?.[1]).toMatchObject({ baseGraphRevision: 2, expectedSnapshotId: "snapshot-2" });
  });

  test("a graph conflict refreshes authoritative pointers and safely replays an add-edge command once", async () => {
    const refreshed = readyWorkspace(2);
    const published = readyWorkspace(3);
    const getWorkspace = vi.fn()
      .mockResolvedValueOnce(readyWorkspace(1))
      .mockResolvedValueOnce(refreshed);
    const applyWorkspaceGraphCommands = vi.fn()
      .mockRejectedValueOnce(new ApiError(409, "stale", { code: "workspace_revision_conflict" }))
      .mockResolvedValueOnce({ graph: published.graph, snapshot: published.activeSnapshot });
    render(
      <ApiProvider client={makeFakeApi({
        getProject: async () => project(),
        getWorkspace,
        applyWorkspaceGraphCommands,
      })}>
        <StudioMutationProbe />
      </ApiProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Add graph edge" }));
    await waitFor(() => expect(applyWorkspaceGraphCommands).toHaveBeenCalledTimes(2));
    expect(applyWorkspaceGraphCommands.mock.calls.map((call) => call[1])).toMatchObject([
      { baseGraphRevision: 1, expectedSnapshotId: "snapshot-1" },
      { baseGraphRevision: 2, expectedSnapshotId: "snapshot-2" },
    ]);
    expect(getWorkspace).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("studio-pointers")).toHaveTextContent("3:snapshot-3");
  });

  test("a graph conflict does not replay add-edge after an endpoint identity was replaced", async () => {
    const replacementGraph: WorkspaceGraph = {
      ...graph,
      nodes: graph.nodes.map((node) => node.kind !== "resource" && node.id === "page-1"
        ? { ...node, artifactId: "artifact-concurrent-replacement", name: "Concurrent replacement" }
        : node),
    };
    const refreshed = readyWorkspace(2, layout, replacementGraph);
    const published = readyWorkspace(3, layout, replacementGraph);
    const getWorkspace = vi.fn()
      .mockResolvedValueOnce(readyWorkspace(1))
      .mockResolvedValueOnce(refreshed);
    const applyWorkspaceGraphCommands = vi.fn()
      .mockRejectedValueOnce(new ApiError(409, "stale", { code: "workspace_revision_conflict" }))
      .mockResolvedValueOnce({ graph: published.graph, snapshot: published.activeSnapshot });
    render(
      <ApiProvider client={makeFakeApi({ getProject: async () => project(), getWorkspace, applyWorkspaceGraphCommands })}>
        <StudioMutationProbe />
      </ApiProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Add graph edge" }));

    await waitFor(() => expect(screen.getByTestId("graph-result")).toHaveTextContent("stale"));
    expect(applyWorkspaceGraphCommands).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("studio-pointers")).toHaveTextContent("2:snapshot-2");
  });

  test("a graph conflict still replays add-edge after a concurrent endpoint rename", async () => {
    const renamedGraph: WorkspaceGraph = {
      ...graph,
      nodes: graph.nodes.map((node) => node.id === "page-1" ? { ...node, name: "Checkout renamed" } : node),
    };
    const refreshed = readyWorkspace(2, layout, renamedGraph);
    const published = readyWorkspace(3, layout, renamedGraph);
    const getWorkspace = vi.fn()
      .mockResolvedValueOnce(readyWorkspace(1))
      .mockResolvedValueOnce(refreshed);
    const applyWorkspaceGraphCommands = vi.fn()
      .mockRejectedValueOnce(new ApiError(409, "stale", { code: "workspace_revision_conflict" }))
      .mockResolvedValueOnce({ graph: published.graph, snapshot: published.activeSnapshot });
    render(
      <ApiProvider client={makeFakeApi({ getProject: async () => project(), getWorkspace, applyWorkspaceGraphCommands })}>
        <StudioMutationProbe />
      </ApiProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Add graph edge" }));

    await waitFor(() => expect(screen.getByTestId("graph-result")).toHaveTextContent("ok"));
    expect(applyWorkspaceGraphCommands).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("studio-pointers")).toHaveTextContent("3:snapshot-3");
  });

  test("a graph conflict safely replays a remove-edge command when the relationship still exists", async () => {
    const refreshed = readyWorkspace(2);
    const published = readyWorkspace(3, layout, { ...graph, edges: [] });
    const getWorkspace = vi.fn()
      .mockResolvedValueOnce(readyWorkspace(1))
      .mockResolvedValueOnce(refreshed);
    const applyWorkspaceGraphCommands = vi.fn()
      .mockRejectedValueOnce(new ApiError(409, "stale", { code: "workspace_revision_conflict" }))
      .mockResolvedValueOnce({ graph: published.graph, snapshot: published.activeSnapshot });
    render(
      <ApiProvider client={makeFakeApi({ getProject: async () => project(), getWorkspace, applyWorkspaceGraphCommands })}>
        <StudioMutationProbe />
      </ApiProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Remove graph edge" }));

    await waitFor(() => expect(screen.getByTestId("graph-result")).toHaveTextContent("ok"));
    expect(applyWorkspaceGraphCommands).toHaveBeenCalledTimes(2);
    expect(applyWorkspaceGraphCommands.mock.calls.map((call) => call[1])).toMatchObject([
      { baseGraphRevision: 1, expectedSnapshotId: "snapshot-1", commands: [{ type: "remove-edge", edgeId: "prototype-1" }] },
      { baseGraphRevision: 2, expectedSnapshotId: "snapshot-2", commands: [{ type: "remove-edge", edgeId: "prototype-1" }] },
    ]);
    expect(screen.getByTestId("studio-pointers")).toHaveTextContent("3:snapshot-3");
  });

  test.each(["source", "target"] as const)(
    "a graph conflict does not replay removal after the %s endpoint identity was replaced",
    async (endpoint) => {
      const endpointId = endpoint === "source" ? "page-1" : "page-2";
      const replacementGraph: WorkspaceGraph = {
        ...graph,
        nodes: graph.nodes.map((node) => node.kind !== "resource" && node.id === endpointId
          ? {
              ...node,
              artifactId: `artifact-concurrent-${endpoint}-replacement`,
              name: `Concurrent ${endpoint} replacement`,
            }
          : node),
      };
      const refreshed = readyWorkspace(2, layout, replacementGraph);
      const getWorkspace = vi.fn()
        .mockResolvedValueOnce(readyWorkspace(1))
        .mockResolvedValueOnce(refreshed);
      const applyWorkspaceGraphCommands = vi.fn()
        .mockRejectedValueOnce(new ApiError(409, "stale", { code: "workspace_revision_conflict" }));
      render(
        <ApiProvider client={makeFakeApi({ getProject: async () => project(), getWorkspace, applyWorkspaceGraphCommands })}>
          <StudioMutationProbe />
        </ApiProvider>,
      );

      fireEvent.click(await screen.findByRole("button", { name: "Remove graph edge" }));

      await waitFor(() => expect(screen.getByTestId("graph-result")).toHaveTextContent("stale"));
      expect(applyWorkspaceGraphCommands).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("studio-pointers")).toHaveTextContent("2:snapshot-2");
    },
  );

  test("a graph conflict converges without replay when the relationship was already removed", async () => {
    const refreshed = readyWorkspace(2, layout, { ...graph, edges: [] });
    const getWorkspace = vi.fn()
      .mockResolvedValueOnce(readyWorkspace(1))
      .mockResolvedValueOnce(refreshed);
    const applyWorkspaceGraphCommands = vi.fn()
      .mockRejectedValueOnce(new ApiError(409, "stale", { code: "workspace_revision_conflict" }));
    render(
      <ApiProvider client={makeFakeApi({ getProject: async () => project(), getWorkspace, applyWorkspaceGraphCommands })}>
        <StudioMutationProbe />
      </ApiProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Remove graph edge" }));

    await waitFor(() => expect(screen.getByTestId("graph-result")).toHaveTextContent("ok"));
    expect(applyWorkspaceGraphCommands).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("studio-pointers")).toHaveTextContent("2:snapshot-2");
  });

  test("a graph conflict does not replay removal when the refreshed relationship is a derived uses edge", async () => {
    const refreshed = readyWorkspace(2, layout, graphWithRelationship("uses", "prototype-1"));
    const getWorkspace = vi.fn()
      .mockResolvedValueOnce(readyWorkspace(1))
      .mockResolvedValueOnce(refreshed);
    const applyWorkspaceGraphCommands = vi.fn()
      .mockRejectedValueOnce(new ApiError(409, "stale", { code: "workspace_revision_conflict" }));
    render(
      <ApiProvider client={makeFakeApi({ getProject: async () => project(), getWorkspace, applyWorkspaceGraphCommands })}>
        <StudioMutationProbe />
      </ApiProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Remove graph edge" }));

    await waitFor(() => expect(screen.getByTestId("graph-result")).toHaveTextContent("stale"));
    expect(applyWorkspaceGraphCommands).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("studio-pointers")).toHaveTextContent("2:snapshot-2");
  });

  test.each(["endpoints", "prototype payload"] as const)(
    "a graph conflict does not replay removal after same-id %s drift",
    async (drift) => {
      const baselineEdge = graph.edges[0]!;
      const driftedEdge = (drift === "endpoints"
        ? { ...baselineEdge, sourceNodeId: "page-2", targetNodeId: "page-1" }
        : {
            ...baselineEdge,
            kind: "prototype",
            prototype: { status: "broken", brokenReason: "Concurrent replacement" },
          }) as WorkspaceGraph["edges"][number];
      const refreshed = readyWorkspace(2, layout, { ...graph, edges: [driftedEdge] });
      const published = readyWorkspace(3, layout, { ...graph, edges: [] });
      const getWorkspace = vi.fn()
        .mockResolvedValueOnce(readyWorkspace(1))
        .mockResolvedValueOnce(refreshed);
      const applyWorkspaceGraphCommands = vi.fn()
        .mockRejectedValueOnce(new ApiError(409, "stale", { code: "workspace_revision_conflict" }))
        .mockResolvedValueOnce({ graph: published.graph, snapshot: published.activeSnapshot });
      render(
        <ApiProvider client={makeFakeApi({ getProject: async () => project(), getWorkspace, applyWorkspaceGraphCommands })}>
          <StudioMutationProbe />
        </ApiProvider>,
      );

      fireEvent.click(await screen.findByRole("button", { name: "Remove graph edge" }));

      await waitFor(() => expect(screen.getByTestId("graph-result")).toHaveTextContent("stale"));
      expect(applyWorkspaceGraphCommands).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("studio-pointers")).toHaveTextContent("2:snapshot-2");
    },
  );

  test("a graph conflict does not replay an unsafe non-edge command", async () => {
    const getWorkspace = vi.fn()
      .mockResolvedValueOnce(readyWorkspace(1))
      .mockResolvedValueOnce(readyWorkspace(2));
    const applyWorkspaceGraphCommands = vi.fn()
      .mockRejectedValueOnce(new ApiError(409, "stale", { code: "workspace_revision_conflict" }));
    render(
      <ApiProvider client={makeFakeApi({ getProject: async () => project(), getWorkspace, applyWorkspaceGraphCommands })}>
        <StudioMutationProbe />
      </ApiProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Apply graph" }));

    await waitFor(() => expect(screen.getByTestId("graph-result")).toHaveTextContent("stale"));
    expect(applyWorkspaceGraphCommands).toHaveBeenCalledTimes(1);
  });

  test("a graph conflict does not replay duplicate remove-edge targets", async () => {
    const refreshed = readyWorkspace(2);
    const published = readyWorkspace(3, layout, { ...graph, edges: [] });
    const getWorkspace = vi.fn()
      .mockResolvedValueOnce(readyWorkspace(1))
      .mockResolvedValueOnce(refreshed);
    const applyWorkspaceGraphCommands = vi.fn()
      .mockRejectedValueOnce(new ApiError(409, "stale", { code: "workspace_revision_conflict" }))
      .mockResolvedValueOnce({ graph: published.graph, snapshot: published.activeSnapshot });
    render(
      <ApiProvider client={makeFakeApi({ getProject: async () => project(), getWorkspace, applyWorkspaceGraphCommands })}>
        <StudioMutationProbe />
      </ApiProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Remove graph edge twice" }));

    await waitFor(() => expect(screen.getByTestId("graph-result")).toHaveTextContent("stale"));
    expect(applyWorkspaceGraphCommands).toHaveBeenCalledTimes(1);
  });
});
