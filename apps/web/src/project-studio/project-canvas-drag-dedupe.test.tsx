import { act, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, expect, test, vi } from "vitest";

import type {
  WorkspaceGraph,
  WorkspaceLayout,
  WorkspaceLayoutCommand,
} from "../lib/api.ts";

const flowProbe = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
}));

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    ReactFlow: (props: Record<string, unknown>) => {
      flowProbe.props = props;
      useEffect(() => {
        const initial = props.defaultViewport as { x: number; y: number; zoom: number };
        const instance = {
          getNodes: () => props.nodes,
          getViewport: () => initial,
          setViewport: async () => true,
          fitView: async () => true,
        };
        (props.onInit as ((value: typeof instance) => void) | undefined)?.(instance);
      }, [props]);
      return <div role="application" aria-label="Project canvas" />;
    },
  };
});

import { ProjectCanvas } from "./canvas/ProjectCanvas.tsx";
import type { WorkspaceFlowNode } from "./canvas/workspace-graph-adapter.ts";
import { applyWorkspaceLayoutCommands } from "./canvas/workspace-layout.ts";

const graph: WorkspaceGraph = {
  workspaceId: "workspace-1",
  revision: 1,
  nodes: [
    { id: "page-1", workspaceId: "workspace-1", kind: "page", artifactId: "artifact-1", name: "One" },
    { id: "page-2", workspaceId: "workspace-1", kind: "page", artifactId: "artifact-2", name: "Two" },
  ],
  edges: [],
};

const layout: WorkspaceLayout = {
  workspaceId: "workspace-1",
  layoutId: "default",
  objects: [
    { id: "page-1", kind: "node", x: 40, y: 70, parentGroupId: null },
    { id: "page-2", kind: "node", x: 370, y: 70, parentGroupId: null },
  ],
  viewport: { x: 0, y: 0, zoom: 0.8 },
  checksum: "layout-1",
};

beforeEach(() => {
  flowProbe.props = null;
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
    unobserve() {}
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    right: 960,
    bottom: 640,
    left: 0,
    width: 960,
    height: 640,
    toJSON: () => ({}),
  });
});

test("the same selection-drag interaction persists one move even when both XYFlow stop callbacks arrive later", async () => {
  let now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let authoritative = layout;
  const onSaveLayout = vi.fn(async (commands: readonly WorkspaceLayoutCommand[]) => {
    authoritative = applyWorkspaceLayoutCommands(authoritative, commands);
    return authoritative;
  });
  render(
    <ProjectCanvas
      projectId="project-1"
      projectName="Workspace"
      graph={graph}
      layout={layout}
      artifactRevisionIds={{}}
      selectedNodeIds={["page-1", "page-2"]}
      onSelectionChange={() => {}}
      onSaveLayout={onSaveLayout}
      onApplyGraphCommands={async () => {}}
      onOpenArtifact={() => {}}
    />,
  );
  await waitFor(() => expect(flowProbe.props).not.toBeNull());
  const props = flowProbe.props!;
  const movedNodes = (props.nodes as WorkspaceFlowNode[]).map((node) => ({
    ...node,
    position: { x: node.position.x + 24, y: node.position.y + 12 },
  }));
  const interaction = new MouseEvent("mouseup");

  await act(async () => {
    (props.onNodeDragStop as (
      event: MouseEvent,
      node: WorkspaceFlowNode,
      nodes: WorkspaceFlowNode[],
    ) => void)(interaction, movedNodes[0]!, movedNodes);
  });
  await waitFor(() => expect(onSaveLayout).toHaveBeenCalledTimes(1));

  now += 250;
  await act(async () => {
    (props.onSelectionDragStop as (
      event: MouseEvent,
      nodes: WorkspaceFlowNode[],
    ) => void)(interaction, movedNodes);
  });

  await waitFor(() => expect(onSaveLayout).toHaveBeenCalledTimes(1));
});
