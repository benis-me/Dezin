import { act, fireEvent, render, screen } from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  WorkspaceGraph,
  WorkspaceLayout,
  WorkspaceLayoutCommand,
  WorkspaceViewport,
} from "../lib/api.ts";

const flowHarness = vi.hoisted(() => {
  const state = {
    viewport: { x: 0, y: 0, zoom: 0.8 } as WorkspaceViewport,
    nextViewport: { x: 32, y: 48, zoom: 1.1 } as WorkspaceViewport,
    fitViewport: { x: 84, y: 36, zoom: 1.2 } as WorkspaceViewport,
  };
  const instance = {
    getViewport: vi.fn(() => state.viewport),
    setViewport: vi.fn(async (viewport: WorkspaceViewport) => {
      state.viewport = viewport;
      return true;
    }),
    fitView: vi.fn(async () => {
      state.viewport = state.fitViewport;
      return true;
    }),
    getNodes: vi.fn(() => []),
  };
  return { state, instance };
});

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  const React = await import("react");
  function ReactFlow({
    onInit,
    onMove,
    onMoveEnd,
    children,
    ...props
  }: {
    onInit?: (instance: typeof flowHarness.instance) => void;
    onMove?: (event: MouseEvent, viewport: WorkspaceViewport) => void;
    onMoveEnd?: (event: MouseEvent, viewport: WorkspaceViewport) => void;
    children?: React.ReactNode;
    "aria-label"?: string;
  }) {
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

function renderCanvas({
  onSaveLayout,
  onViewportChange,
}: {
  onSaveLayout: (commands: readonly WorkspaceLayoutCommand[]) => Promise<WorkspaceLayout>;
  onViewportChange: (viewport: WorkspaceViewport) => void;
}) {
  return render(
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
    />,
  );
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

  await act(async () => { await Promise.resolve(); });

  expect(screen.queryByRole("complementary", { name: "Workspace structure" })).toBeNull();
  expect(screen.getByRole("button", { name: "Toggle workspace outline" })).toHaveAttribute("aria-pressed", "false");
  rectSpy.mockRestore();
});

test("a medium initial surface keeps the workspace outline available without covering the canvas by default", async () => {
  renderCanvas({
    onSaveLayout: async () => layout,
    onViewportChange: () => {},
  });

  await act(async () => { await Promise.resolve(); });

  expect(screen.queryByRole("complementary", { name: "Workspace structure" })).toBeNull();
  expect(screen.getByRole("button", { name: "Toggle workspace outline" })).toHaveAttribute("aria-pressed", "false");

  fireEvent.click(screen.getByRole("button", { name: "Toggle workspace outline" }));

  expect(screen.getByRole("complementary", { name: "Workspace structure" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Toggle workspace outline" })).toHaveAttribute("aria-pressed", "true");
});

test("a failed viewport save never promotes the pending viewport and restores the authoritative one", async () => {
  const onViewportChange = vi.fn();
  const onSaveLayout = vi.fn(async () => { throw new Error("Viewport save failed"); });
  renderCanvas({ onSaveLayout, onViewportChange });

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
});

test("a failed Fit workspace save follows the same authoritative rollback semantics", async () => {
  const onViewportChange = vi.fn();
  const onSaveLayout = vi.fn(async () => { throw new Error("Fit save failed"); });
  const fittedViewport = flowHarness.state.fitViewport;
  renderCanvas({ onSaveLayout, onViewportChange });

  fireEvent.click(screen.getByRole("button", { name: "Fit workspace" }));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(onSaveLayout).toHaveBeenCalledWith([{
    type: "set-viewport",
    viewport: fittedViewport,
  }]);
  expect(onViewportChange).not.toHaveBeenCalledWith(fittedViewport);
  expect(onViewportChange).toHaveBeenLastCalledWith(layout.viewport);
  expect(flowHarness.instance.setViewport).toHaveBeenLastCalledWith(layout.viewport);
  expect(screen.getByRole("status", { name: "Canvas status" })).toHaveTextContent("Fit save failed");
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
