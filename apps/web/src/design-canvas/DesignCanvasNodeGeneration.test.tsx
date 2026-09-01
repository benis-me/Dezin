import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import type { DesignCanvasApi } from "./api.ts";
import { DesignCanvasNode, NodeGenerationStatus, NodeWorkingPlaceholder, type DesignFlowNode } from "./DesignCanvasNode.tsx";
import type { DesignNode } from "./types.ts";

const resizeControlHarness = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
}));

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  const React = await import("react");
  return {
    ...actual,
    Handle: () => React.createElement("div"),
    NodeResizeControl: (props: { children?: React.ReactNode } & Record<string, unknown>) => {
      resizeControlHarness.props.push(props);
      return React.createElement("div", null, props.children);
    },
    useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
  };
});

afterEach(() => vi.unstubAllGlobals());

test("a generating Node uses the animated dot field without a generic spinner", () => {
  const { container } = render(<NodeWorkingPlaceholder state="generating" label="Page" />);

  expect(screen.getByRole("status")).toHaveTextContent("Building a responsive page");
  expect(container.querySelector(".design-canvas-node__generation-field")).not.toBeNull();
  expect(container.querySelector(".design-canvas-node__generation-glow")).not.toBeNull();
  expect(container.querySelector("svg")).toBeNull();
});

test("an in-progress next revision reuses the dot field instead of a spinner badge", () => {
  const { container } = render(<NodeGenerationStatus state="generating" />);

  expect(screen.getByRole("status")).toHaveTextContent("Updating the page");
  expect(container.querySelector(".design-canvas-node__working-dots")).toBeInTheDocument();
  expect(container.querySelector(".design-canvas-node__generation-field")).toBeInTheDocument();
  expect(container.querySelector(".design-canvas-node__generation-glow")).toBeInTheDocument();
  expect(container.querySelector("svg")).toBeNull();
});

test("a live Node only runs its particle field while it is near the viewport", () => {
  let intersectionCallback: IntersectionObserverCallback | null = null;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) {
      intersectionCallback = callback;
    }
    observe() {}
    disconnect() {}
    unobserve() {}
    takeRecords() { return []; }
    root = null;
    rootMargin = "360px";
    thresholds = [0];
  });
  const node: DesignNode = {
    id: "page-live",
    kind: "page",
    name: "Live Page",
    geometry: { x: 0, y: 0, width: 420, height: 280 },
    state: "generating",
    currentVersionId: null,
    selectedVersionId: null,
    versionCount: 0,
    assetId: null,
    activeJobId: "job-live",
    error: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const flowNode = {
    id: node.id,
    type: "design",
    position: { x: 0, y: 0 },
    data: {
      node,
      projectId: "project-1",
      api: {} as DesignCanvasApi,
      onResize: vi.fn(),
    },
  } as DesignFlowNode;
  const props = {
    id: node.id,
    data: flowNode.data,
    selected: false,
  } as unknown as Parameters<typeof DesignCanvasNode>[0];
  const { container } = render(<DesignCanvasNode {...props} />);

  expect(container.querySelector("[data-generation-motion='paused']")).toBeInTheDocument();
  expect(container.querySelectorAll(".design-canvas-node__generation-particle")).toHaveLength(4);

  act(() => intersectionCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
  expect(container.querySelector("[data-generation-motion='active']")).toBeInTheDocument();
  expect(container.querySelectorAll(".design-canvas-node__generation-particle")).toHaveLength(14);
});

test("every Canvas Node exposes its persisted name through the hover label layer", () => {
  const node: DesignNode = {
    id: "page-hover-label",
    kind: "page",
    name: "Afterlight Journal",
    geometry: { x: 0, y: 0, width: 420, height: 280 },
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
  const flowNode = {
    id: node.id,
    type: "design",
    position: { x: 0, y: 0 },
    data: {
      node,
      projectId: "project-1",
      api: {} as DesignCanvasApi,
      onResize: vi.fn(),
    },
  } as DesignFlowNode;

  const { container } = render(<DesignCanvasNode {...({
    id: node.id,
    data: flowNode.data,
    selected: false,
  } as unknown as Parameters<typeof DesignCanvasNode>[0])} />);

  const label = container.querySelector(".design-canvas-node__hover-label");
  expect(label).toHaveTextContent("Afterlight Journal");
  expect(label).toHaveAttribute("aria-hidden", "true");
  expect(screen.queryByRole("button", { name: /Resize Afterlight Journal/ })).not.toBeInTheDocument();
  expect(container.querySelectorAll(".design-canvas-node__resize-corner[aria-hidden='true']")).toHaveLength(4);
});

test("a selected Node exposes keyboard-operable corner resize controls", () => {
  const onResize = vi.fn();
  const node: DesignNode = {
    id: "page-keyboard-resize",
    kind: "page",
    name: "Keyboard canvas",
    geometry: { x: 40, y: 60, width: 420, height: 280 },
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
  const flowNode = {
    id: node.id,
    type: "design",
    position: { x: 40, y: 60 },
    data: {
      node,
      projectId: "project-1",
      api: {} as DesignCanvasApi,
      onResize,
    },
  } as DesignFlowNode;

  render(<DesignCanvasNode {...({
    id: node.id,
    data: flowNode.data,
    selected: true,
  } as unknown as Parameters<typeof DesignCanvasNode>[0])} />);

  const controls = screen.getAllByRole("button", { name: /Resize Keyboard canvas from/ });
  expect(controls).toHaveLength(4);
  for (const control of controls) {
    expect(control).toHaveClass("design-canvas-node__resize-hit-target");
    expect(control.tabIndex).toBe(0);
    expect(control.querySelector(".design-canvas-node__resize-corner[aria-hidden='true']"))
      .toBeInTheDocument();
  }
  const topLeft = screen.getByRole("button", { name: "Resize Keyboard canvas from top left" });
  expect(topLeft).toHaveAttribute("aria-keyshortcuts", "ArrowUp ArrowDown ArrowLeft ArrowRight");
  expect(topLeft).toHaveAttribute("aria-description", "Use arrow keys to resize. Hold Shift for larger steps.");

  fireEvent.keyDown(topLeft, { key: "ArrowLeft" });
  expect(onResize).toHaveBeenLastCalledWith(node.id, {
    x: 32,
    y: 60,
    width: 428,
    height: 280,
  });

  fireEvent.keyDown(topLeft, { key: "ArrowUp", shiftKey: true });
  expect(onResize).toHaveBeenLastCalledWith(node.id, {
    x: 32,
    y: 36,
    width: 428,
    height: 304,
  });
});

test("corner resize subscriptions stay stable across unrelated Node renders", () => {
  resizeControlHarness.props = [];
  const node: DesignNode = {
    id: "page-stable-resize",
    kind: "page",
    name: "Stable resize",
    geometry: { x: 40, y: 60, width: 420, height: 280 },
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
  const onResize = vi.fn();
  const props = {
    id: node.id,
    data: {
      node,
      projectId: "project-1",
      api: {} as DesignCanvasApi,
      onResize,
    },
    selected: true,
  } as unknown as Parameters<typeof DesignCanvasNode>[0];
  const view = render(<DesignCanvasNode {...props} />);
  const firstRender = resizeControlHarness.props.slice(-4);

  resizeControlHarness.props = [];
  view.rerender(<DesignCanvasNode {...props} />);
  const secondRender = resizeControlHarness.props.slice(-4);

  expect(secondRender).toHaveLength(4);
  for (let index = 0; index < 4; index += 1) {
    expect(secondRender[index]?.shouldResize).toBe(firstRender[index]?.shouldResize);
    expect(secondRender[index]?.onResizeStart).toBe(firstRender[index]?.onResizeStart);
    expect(secondRender[index]?.onResizeEnd).toBe(firstRender[index]?.onResizeEnd);
  }
});

test("keyboard corner resizing preserves intrinsic media aspect ratio", () => {
  const onResize = vi.fn();
  const node: DesignNode = {
    id: "image-keyboard-resize",
    kind: "image",
    name: "Wide reference",
    geometry: { x: 40, y: 60, width: 400, height: 200 },
    state: "ready",
    currentVersionId: null,
    selectedVersionId: null,
    versionCount: 0,
    assetId: "asset-wide",
    activeJobId: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
  };

  render(<DesignCanvasNode {...({
    id: node.id,
    data: {
      node,
      projectId: "project-1",
      api: {} as DesignCanvasApi,
      onResize,
    },
    selected: true,
  } as unknown as Parameters<typeof DesignCanvasNode>[0])} />);

  fireEvent.keyDown(screen.getByRole("button", {
    name: "Resize Wide reference from bottom right",
  }), { key: "ArrowRight" });

  expect(onResize).toHaveBeenLastCalledWith(node.id, {
    x: 40,
    y: 60,
    width: 408,
    height: 204,
  });
});
