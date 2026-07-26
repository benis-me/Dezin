import { act, fireEvent, render, screen } from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ToastProvider } from "../components/Toast.tsx";
import type {
  Project,
  ProjectWorkspacePayload,
  WorkspaceGraph,
  WorkspaceLayout,
  WorkspaceLayoutCommand,
  WorkspaceViewport,
} from "../lib/api.ts";
import { ApiProvider } from "../lib/api-context.tsx";
import { makeFakeApi } from "../test/fake-api.ts";

const flowHarness = vi.hoisted(() => {
  const state = {
    viewport: { x: 0, y: 0, zoom: 0.8 } as WorkspaceViewport,
    nextViewport: { x: 32, y: 48, zoom: 1.1 } as WorkspaceViewport,
    fitViewport: { x: 84, y: 36, zoom: 1.2 } as WorkspaceViewport,
    nodes: [] as unknown[],
  };
  const instance = {
    getViewport: vi.fn(() => state.viewport),
    getZoom: vi.fn(() => state.viewport.zoom),
    setViewport: vi.fn(async (viewport: WorkspaceViewport) => {
      state.viewport = viewport;
      return true;
    }),
    zoomTo: vi.fn(async (zoom: number) => {
      state.viewport = { ...state.viewport, zoom };
      return true;
    }),
    fitView: vi.fn(async () => {
      state.viewport = state.fitViewport;
      return true;
    }),
    getNodes: vi.fn(() => state.nodes),
  };
  return { state, instance };
});

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  const React = await import("react");
  function ReactFlow({
    onInit,
    onConnect,
    onMove,
    onMoveEnd,
    children,
    nodes,
    ...props
  }: {
    onInit?: (instance: typeof flowHarness.instance) => void;
    onConnect?: (connection: { source: string; target: string | null }) => void;
    onMove?: (event: MouseEvent, viewport: WorkspaceViewport) => void;
    onMoveEnd?: (event: MouseEvent, viewport: WorkspaceViewport) => void;
    children?: React.ReactNode;
    nodes?: unknown[];
    "aria-label"?: string;
  }) {
    flowHarness.state.nodes = nodes ?? [];
    React.useEffect(() => {
      onInit?.(flowHarness.instance);
    }, []);
    return (
      <div role="application" aria-label={props["aria-label"]}>
        <button
          type="button"
          aria-label="Simulate viewport move"
          onClick={() => {
            const viewport = { ...flowHarness.state.nextViewport };
            flowHarness.state.viewport = viewport;
            const event = new MouseEvent("pointerup");
            onMove?.(event, viewport);
            onMoveEnd?.(event, viewport);
          }}
        >
          Move viewport
        </button>
        <button
          type="button"
          aria-label="Simulate invalid relationship"
          onClick={() => onConnect?.({ source: "page-1", target: null })}
        >
          Invalid relationship
        </button>
        {children}
      </div>
    );
  }
  return {
    ...actual,
    ReactFlow,
    Background: () => null,
  };
});

import { ProjectCanvas } from "./canvas/ProjectCanvas.tsx";
import { applyWorkspaceLayoutCommands } from "./canvas/workspace-layout.ts";
import { useProjectStudio } from "./useProjectStudio.ts";

const graph: WorkspaceGraph = {
  workspaceId: "workspace-1",
  revision: 1,
  nodes: [{ id: "page-1", workspaceId: "workspace-1", kind: "page", artifactId: "artifact-1", name: "Home" }],
  edges: [],
};

const layout: WorkspaceLayout = {
  workspaceId: "workspace-1",
  layoutId: "default",
  objects: [{ id: "page-1", kind: "node", x: 20, y: 20, parentGroupId: null }],
  viewport: { x: 0, y: 0, zoom: 0.8 },
  checksum: "layout-1",
};

function project(): Project {
  return {
    id: "project-1",
    name: "Storefront",
    skillId: null,
    designSystemId: null,
    mode: "standard",
    createdAt: 1,
    updatedAt: 1,
  };
}

function readyWorkspace(
  currentLayout: WorkspaceLayout = layout,
): Extract<ProjectWorkspacePayload, { status: "ready" }> {
  const activeSnapshot = {
    id: "snapshot-1",
    workspaceId: graph.workspaceId,
    sequence: 1,
    parentSnapshotId: null,
    graphRevision: graph.revision,
    kernelRevisionId: "kernel-1",
    reason: "workspace-created",
    provenance: { kind: "workspace-created" as const },
    createdByRunId: null,
    createdAt: 1,
    graph,
    artifactTracks: {},
    artifactRevisions: { "artifact-1": "revision-1" },
    resourceRevisions: {},
  };
  return {
    status: "ready",
    workspace: {
      id: graph.workspaceId,
      projectId: "project-1",
      mode: "standard",
      graphRevision: graph.revision,
      activeSnapshotId: activeSnapshot.id,
      activeKernelRevisionId: "kernel-1",
      createdAt: 1,
      updatedAt: 1,
    },
    graph,
    activeSnapshot,
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
    snapshots: [activeSnapshot],
    layout: currentLayout,
  };
}

function renderCanvas({
  onSaveLayout,
  onViewportChange,
}: {
  onSaveLayout: (commands: readonly WorkspaceLayoutCommand[]) => Promise<WorkspaceLayout>;
  onViewportChange: (viewport: WorkspaceViewport) => void;
}) {
  return render(
    <ToastProvider>
      <ProjectCanvas
        projectId="project-1"
        projectName="Storefront"
        graph={graph}
        layout={layout}
        viewport={layout.viewport}
        artifactRevisionIds={{ "artifact-1": "revision-1" }}
        selectedNodeIds={[]}
        onSelectionChange={() => {}}
        onViewportChange={onViewportChange}
        onSaveLayout={onSaveLayout}
        onApplyGraphCommands={async () => {}}
        onOpenArtifact={() => {}}
      />
    </ToastProvider>,
  );
}

function StudioCanvasIntegrationProbe() {
  const studio = useProjectStudio("project-1");
  if (studio.load.status !== "ready") return <span>{studio.load.status}</span>;
  return (
    <>
      <button type="button" onClick={studio.reconcileGenerationPublication}>
        Reconcile same head
      </button>
      <ProjectCanvas
        projectId="project-1"
        projectName="Storefront"
        graph={studio.load.workspace.graph}
        layout={studio.load.workspace.layout}
        viewport={studio.viewport}
        artifactRevisionIds={{ "artifact-1": "revision-1" }}
        selectedNodeIds={["page-1"]}
        onSelectionChange={() => {}}
        onViewportChange={studio.setViewport}
        onSaveLayout={studio.saveLayout}
        onApplyGraphCommands={studio.applyGraphCommands}
        onOpenArtifact={() => {}}
      />
    </>
  );
}

async function flushCanvasMeasurementFrame(): Promise<void> {
  await act(async () => {
    vi.advanceTimersToNextFrame();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  flowHarness.state.viewport = { ...layout.viewport };
  flowHarness.state.nextViewport = { x: 32, y: 48, zoom: 1.1 };
  flowHarness.state.fitViewport = { x: 84, y: 36, zoom: 1.2 };
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

test("a narrow initial surface keeps the workspace outline out of the canvas", async () => {
  const rect = {
    x: 0,
    y: 0,
    top: 0,
    right: 800,
    bottom: 768,
    left: 0,
    width: 800,
    height: 768,
    toJSON: () => ({}),
  } as DOMRect;
  const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
  renderCanvas({
    onSaveLayout: async () => layout,
    onViewportChange: () => {},
  });

  await flushCanvasMeasurementFrame();

  expect(screen.queryByRole("complementary", { name: "Workspace structure" })).toBeNull();
  expect(screen.getByRole("button", { name: "Toggle workspace outline" })).toHaveAttribute("aria-pressed", "false");
  rectSpy.mockRestore();
});

test("a medium initial surface keeps the workspace outline available without covering the canvas by default", async () => {
  renderCanvas({
    onSaveLayout: async () => layout,
    onViewportChange: () => {},
  });

  await flushCanvasMeasurementFrame();

  expect(screen.queryByRole("complementary", { name: "Workspace structure" })).toBeNull();
  expect(screen.getByRole("button", { name: "Toggle workspace outline" })).toHaveAttribute("aria-pressed", "false");

  fireEvent.click(screen.getByRole("button", { name: "Toggle workspace outline" }));

  expect(screen.getByRole("complementary", { name: "Workspace structure" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Toggle workspace outline" })).toHaveAttribute("aria-pressed", "true");
});

test("pending local camera survives a node save and same-head generation reconcile", async () => {
  let server = readyWorkspace();
  let checksumSequence = 1;
  const getWorkspace = vi.fn(async () => structuredClone(server));
  const saveWorkspaceLayout = vi.fn(async (
    _projectId: string,
    input: {
      commands: readonly WorkspaceLayoutCommand[];
    },
  ) => {
    const saved = applyWorkspaceLayoutCommands(server.layout, input.commands);
    server = {
      ...server,
      layout: {
        ...saved,
        checksum: `layout-${++checksumSequence}`,
      },
    };
    return server.layout;
  });
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project(),
      getWorkspace,
      listWorkspaceProposals: async () => [],
      saveWorkspaceLayout,
    })}>
      <StudioCanvasIntegrationProbe />
    </ApiProvider>,
  );
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
  await flushCanvasMeasurementFrame();
  screen.getByRole("application", { name: "Project canvas" });
  flowHarness.instance.setViewport.mockClear();

  flowHarness.state.nextViewport = { x: 72, y: 36, zoom: 1.15 };
  fireEvent.click(screen.getByRole("button", { name: "Simulate viewport move" }));
  fireEvent.keyDown(screen.getByRole("application", { name: "Project canvas" }), {
    key: "ArrowRight",
  });
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });

  expect(saveWorkspaceLayout).toHaveBeenCalledTimes(1);
  expect(saveWorkspaceLayout).toHaveBeenCalledWith("project-1", expect.objectContaining({
    commands: [{ type: "move", objectId: "page-1", x: 21, y: 20 }],
  }));
  expect(flowHarness.state.viewport).toEqual({ x: 72, y: 36, zoom: 1.15 });
  expect(flowHarness.instance.setViewport).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Reconcile same head" }));
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });

  expect(getWorkspace).toHaveBeenCalledTimes(2);
  expect(flowHarness.state.viewport).toEqual({ x: 72, y: 36, zoom: 1.15 });
  expect(flowHarness.instance.setViewport).not.toHaveBeenCalled();
});

test("a failed viewport save never promotes the pending viewport and restores the authoritative one", async () => {
  const onViewportChange = vi.fn();
  const onSaveLayout = vi.fn(async () => { throw new Error("Viewport save failed"); });
  renderCanvas({ onSaveLayout, onViewportChange });
  await flushCanvasMeasurementFrame();

  fireEvent.click(screen.getByRole("button", { name: "Simulate viewport move" }));
  await act(async () => {
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(onSaveLayout).toHaveBeenCalledWith([{
    type: "set-viewport",
    viewport: { x: 32, y: 48, zoom: 1.1 },
  }]);
  expect(onViewportChange).not.toHaveBeenCalledWith({ x: 32, y: 48, zoom: 1.1 });
  expect(onViewportChange).toHaveBeenLastCalledWith(layout.viewport);
  expect(flowHarness.instance.setViewport).toHaveBeenLastCalledWith(layout.viewport);
  expect(screen.getByRole("status", { name: "Canvas status" })).toHaveTextContent("Viewport save failed");
  expect(screen.getByRole("alert")).toHaveTextContent("Viewport save failed");
});

test("an invalid Page relationship reports a deduplicated global error without occupying canvas layout", async () => {
  renderCanvas({ onSaveLayout: async () => layout, onViewportChange: () => {} });
  await flushCanvasMeasurementFrame();

  fireEvent.click(screen.getByRole("button", { name: "Simulate invalid relationship" }));
  fireEvent.click(screen.getByRole("button", { name: "Simulate invalid relationship" }));

  expect(screen.getByRole("status", { name: "Canvas status" })).toHaveClass("sr-only");
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.getByRole("alert")).toHaveTextContent("Prototype links connect Page nodes.");
});

test("routine pan and zoom persistence stays silent while saving and after success", async () => {
  let resolveSave!: (saved: WorkspaceLayout) => void;
  const save = new Promise<WorkspaceLayout>((resolve) => {
    resolveSave = resolve;
  });
  const onSaveLayout = vi.fn(() => save);
  const onViewportChange = vi.fn();
  renderCanvas({ onSaveLayout, onViewportChange });
  await flushCanvasMeasurementFrame();
  const status = screen.getByRole("status", { name: "Canvas status" });

  fireEvent.click(screen.getByRole("button", { name: "Simulate viewport move" }));
  await act(async () => {
    vi.advanceTimersByTime(300);
    await Promise.resolve();
  });

  expect(onSaveLayout).toHaveBeenCalledWith([{
    type: "set-viewport",
    viewport: { x: 32, y: 48, zoom: 1.1 },
  }]);
  expect(status).toHaveTextContent("Canvas ready");
  expect(status).toHaveClass("sr-only");
  expect(screen.getByRole("region", { name: "Notifications" })).toBeEmptyDOMElement();

  await act(async () => {
    resolveSave({
      ...layout,
      viewport: { x: 32, y: 48, zoom: 1.1 },
      checksum: "layout-panned",
    });
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(status).toHaveTextContent("Canvas ready");
  expect(onViewportChange).toHaveBeenLastCalledWith({ x: 32, y: 48, zoom: 1.1 });
});

test("toolbar zoom persistence stays silent while saving and after success", async () => {
  let resolveSave!: (saved: WorkspaceLayout) => void;
  const save = new Promise<WorkspaceLayout>((resolve) => {
    resolveSave = resolve;
  });
  const onSaveLayout = vi.fn(() => save);
  const onViewportChange = vi.fn();
  renderCanvas({ onSaveLayout, onViewportChange });
  await flushCanvasMeasurementFrame();
  const status = screen.getByRole("status", { name: "Canvas status" });

  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  const zoomedViewport = { x: 0, y: 0, zoom: 0.9119999999999999 };
  expect(onSaveLayout).toHaveBeenCalledWith([{
    type: "set-viewport",
    viewport: {
      x: 0,
      y: 0,
      zoom: expect.closeTo(0.912, 12),
    },
  }]);
  expect(status).toHaveTextContent("Canvas ready");

  await act(async () => {
    resolveSave({
      ...layout,
      viewport: zoomedViewport,
      checksum: "layout-zoomed",
    });
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(status).toHaveTextContent("Canvas ready");
  expect(onViewportChange).toHaveBeenLastCalledWith(zoomedViewport);
});

test("a failed Fit workspace save follows the same authoritative rollback semantics", async () => {
  const onViewportChange = vi.fn();
  const onSaveLayout = vi.fn(async () => { throw new Error("Fit save failed"); });
  const fittedViewport = flowHarness.state.fitViewport;
  renderCanvas({ onSaveLayout, onViewportChange });
  await flushCanvasMeasurementFrame();

  fireEvent.click(screen.getByRole("button", { name: "Fit workspace" }));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(flowHarness.instance.fitView).toHaveBeenCalledWith({
    padding: {
      top: 0.18,
      right: 0.18,
      bottom: 0.32,
      left: 0.18,
    },
    duration: expect.any(Number),
  });
  expect(onSaveLayout).toHaveBeenCalledWith([{
    type: "set-viewport",
    viewport: fittedViewport,
  }]);
  expect(onViewportChange).not.toHaveBeenCalledWith(fittedViewport);
  expect(onViewportChange).toHaveBeenLastCalledWith(layout.viewport);
  expect(flowHarness.instance.setViewport).toHaveBeenLastCalledWith(layout.viewport);
  expect(screen.getByRole("status", { name: "Canvas status" })).toHaveTextContent("Fit save failed");
  expect(screen.getByRole("alert")).toHaveTextContent("Fit save failed");
});

test.each([
  { label: "both saves succeed", firstFails: false, secondFails: false },
  { label: "the earlier save fails", firstFails: true, secondFails: false },
  { label: "the newer save fails", firstFails: false, secondFails: true },
])("an earlier authoritative viewport acknowledgement never drops a newer pending pan when $label", async ({
  firstFails,
  secondFails,
}) => {
  const firstViewport = { x: 32, y: 48, zoom: 1.1 };
  const secondViewport = { x: 96, y: 72, zoom: 1.25 };
  let resolveFirst!: (saved: WorkspaceLayout) => void;
  let rejectFirst!: (reason?: unknown) => void;
  let resolveSecond!: (saved: WorkspaceLayout) => void;
  let rejectSecond!: (reason?: unknown) => void;
  const firstSave = new Promise<WorkspaceLayout>((resolve, reject) => {
    resolveFirst = resolve;
    rejectFirst = reject;
  });
  const secondSave = new Promise<WorkspaceLayout>((resolve, reject) => {
    resolveSecond = resolve;
    rejectSecond = reject;
  });
  const onSaveLayout = vi.fn((commands: readonly WorkspaceLayoutCommand[]) => {
    const command = commands[0];
    if (command?.type !== "set-viewport") throw new Error("expected a viewport command");
    if (onSaveLayout.mock.calls.length === 1) return firstSave;
    return secondSave;
  });
  const onViewportChange = vi.fn();

  function ControlledCanvas() {
    const [authoritativeLayout, setAuthoritativeLayout] = useState(layout);
    const [authoritativeViewport, setAuthoritativeViewport] = useState(layout.viewport);
    const handleViewportChange = useCallback((next: WorkspaceViewport) => {
      onViewportChange(next);
      setAuthoritativeViewport(next);
    }, []);
    const handleSaveLayout = useCallback(async (commands: readonly WorkspaceLayoutCommand[]) => {
      const saved = await onSaveLayout(commands);
      setAuthoritativeLayout(saved);
      return saved;
    }, []);
    return (
      <ProjectCanvas
        projectId="project-1"
        projectName="Storefront"
        graph={graph}
        layout={authoritativeLayout}
        viewport={authoritativeViewport}
        artifactRevisionIds={{ "artifact-1": "revision-1" }}
        selectedNodeIds={[]}
        onSelectionChange={() => {}}
        onViewportChange={handleViewportChange}
        onSaveLayout={handleSaveLayout}
        onApplyGraphCommands={async () => {}}
        onOpenArtifact={() => {}}
      />
    );
  }

  render(<ControlledCanvas />);
  await flushCanvasMeasurementFrame();
  flowHarness.state.nextViewport = firstViewport;
  fireEvent.click(screen.getByRole("button", { name: "Simulate viewport move" }));
  await act(async () => {
    vi.advanceTimersByTime(300);
    await Promise.resolve();
  });
  expect(onSaveLayout).toHaveBeenCalledTimes(1);

  flowHarness.state.nextViewport = secondViewport;
  fireEvent.click(screen.getByRole("button", { name: "Simulate viewport move" }));
  await act(async () => {
    if (firstFails) rejectFirst(new Error("First viewport save failed"));
    else resolveFirst({ ...layout, viewport: firstViewport, checksum: "layout-first" });
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => { await Promise.resolve(); });

  expect(flowHarness.state.viewport).toEqual(secondViewport);

  await act(async () => {
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(onSaveLayout).toHaveBeenCalledTimes(2);
  expect(onSaveLayout).toHaveBeenLastCalledWith([{ type: "set-viewport", viewport: secondViewport }]);
  await act(async () => {
    if (secondFails) rejectSecond(new Error("Second viewport save failed"));
    else resolveSecond({ ...layout, viewport: secondViewport, checksum: "layout-second" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  const expectedFinalViewport = secondFails ? firstViewport : secondViewport;
  expect(onViewportChange).toHaveBeenLastCalledWith(expectedFinalViewport);
  expect(flowHarness.state.viewport).toEqual(expectedFinalViewport);
});
