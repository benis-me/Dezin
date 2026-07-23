import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useState } from "react";
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
import { ProjectCanvas, isCanvasShortcutTarget } from "./canvas/ProjectCanvas.tsx";
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

interface ReactFlowMeasurementController {
  (width?: number, height?: number): void;
  observedCanvasSurfaces: () => number;
}

function installReactFlowMeasurements(): ReactFlowMeasurementController {
  let measuredWidth = 960;
  let measuredHeight = 640;
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
  const measure = ((width = 960, height = 640) => {
    measuredWidth = width;
    measuredHeight = height;
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
    />
  );
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
  expect(screen.getByRole("list", { name: "Workspace outline" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Select Page Checkout.*outgoing 1/i })).toBeInTheDocument();
  expect(container.querySelector("iframe")).toBeNull();

  const open = screen.getByRole("link", { name: "Open Checkout" });
  expect(open).toHaveAttribute("href", "/projects/project-1/artifacts/artifact-page-1");
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

  expect(screen.getByRole("link", { name: "Open Checkout research" })).toHaveAttribute(
    "href",
    "/projects/project-1/resources/research-1/revisions/research-revision-1",
  );
});

test("ReactFlow mounts only after a non-zero ResizeObserver measurement and disconnects under StrictMode", () => {
  const measureReactFlow = installReactFlowMeasurements();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const rendered = render(
    <StrictMode>
      <CanvasHarness onSaveLayout={async () => layout} />
    </StrictMode>,
  );

  expect(screen.queryByRole("application", { name: "Project canvas" })).not.toBeInTheDocument();
  act(() => measureReactFlow(0, 640));
  expect(screen.queryByRole("application", { name: "Project canvas" })).not.toBeInTheDocument();

  act(() => measureReactFlow(960, 640));
  expect(screen.getByRole("application", { name: "Project canvas" })).toBeInTheDocument();
  expect(warn.mock.calls.flat().join(" ")).not.toContain("reactflow.dev/error#004");

  rendered.unmount();
  expect(measureReactFlow.observedCanvasSurfaces()).toBe(0);
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

  expect(screen.getByRole("button", { name: "Uses relationships are derived and read-only" })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("application", { name: "Project canvas" }), { key: "Delete" });

  expect(onApplyGraphCommands).not.toHaveBeenCalled();
  expect(screen.getByRole("status", { name: "Canvas status" })).toHaveTextContent("Uses relationships are derived and read-only");
});

test("changing the relationship filter clears a selected relationship before hiding it", async () => {
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

  fireEvent.click(screen.getByRole("button", { name: "Show semantic relations" }));

  await waitFor(() => expect(screen.getByRole("button", { name: "Delete selected relationship" })).toBeDisabled());
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

  await waitFor(() => expect(screen.getByRole("button", { name: "Delete selected relationship" })).toBeDisabled());
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
      onSaveLayout={async () => layout}
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
  expect(screen.getByRole("button", { name: "Group selection" })).toBeDisabled();
});

test("full semantic zoom exposes keyboard Page handles and compact zoom removes them from the accessibility tree", async () => {
  const onApplyGraphCommands = vi.fn(async (_commands: readonly WorkspaceGraphCommand[]) => {});
  const { unmount } = render(
    <CanvasHarness onSaveLayout={async () => layout} onApplyGraphCommands={onApplyGraphCommands} />,
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
