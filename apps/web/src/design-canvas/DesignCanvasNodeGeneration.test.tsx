import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import type { DesignCanvasApi } from "./api.ts";
import { DesignCanvasNode, NodeGenerationStatus, NodeWorkingPlaceholder, type DesignFlowNode } from "./DesignCanvasNode.tsx";
import type { DesignNode } from "./types.ts";

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  const React = await import("react");
  return {
    ...actual,
    NodeResizeControl: ({ children }: { children?: React.ReactNode }) => React.createElement("div", null, children),
    useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
  };
});

afterEach(() => vi.unstubAllGlobals());

test("a generating Node uses the animated dot field without a generic spinner", () => {
  const { container } = render(<NodeWorkingPlaceholder state="generating" label="Page" />);

  expect(screen.getByRole("status")).toHaveTextContent("Creating a page");
  expect(container.querySelector(".design-canvas-node__generation-field")).not.toBeNull();
  expect(container.querySelector(".design-canvas-node__generation-glow")).not.toBeNull();
  expect(container.querySelector("svg")).toBeNull();
});

test("an in-progress next revision reuses the dot field instead of a spinner badge", () => {
  const { container } = render(<NodeGenerationStatus state="generating" />);

  expect(screen.getByRole("status")).toHaveTextContent("Creating the next version");
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
