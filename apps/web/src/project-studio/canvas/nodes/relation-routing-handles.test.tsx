import { render, screen } from "@testing-library/react";
import type { NodeProps } from "@xyflow/react";
import { describe, expect, test, vi } from "vitest";
import type { WorkspaceFlowNode, WorkspaceFlowNodeData } from "../workspace-graph-adapter.ts";
import { ComponentNode } from "./ComponentNode.tsx";
import { ResourceNode } from "./ResourceNode.tsx";

vi.mock("@xyflow/react", () => ({
  Handle: ({
    id,
    className,
    position,
  }: {
    id: string;
    className?: string;
    position: string;
  }) => <span data-testid={`handle-${id}`} data-class={className} data-position={position} />,
  Position: {
    Left: "left",
    Right: "right",
    Top: "top",
    Bottom: "bottom",
  },
}));

vi.mock("./ArtifactNodePreview.tsx", () => ({
  ArtifactNodePreview: () => <div data-testid="artifact-preview" />,
}));

const baseData: WorkspaceFlowNodeData = {
  objectId: "node-1",
  kind: "component",
  name: "Navigation",
  projectId: "project-1",
  artifactId: "artifact-1",
  resourceId: null,
  revisionId: null,
  zoomLevel: "compact",
  incomingCount: 1,
  outgoingCount: 0,
  qualityState: "unassessed",
  qualityScore: null,
  generationState: "idle",
  collapsed: false,
  parentGroupId: null,
  groupRole: null,
  memberCount: 0,
  minimumGroupWidth: 0,
  minimumGroupHeight: 0,
};

function expectRoutingHandles(kind: "component" | "resource") {
  for (const side of ["left", "right", "top", "bottom"] as const) {
    expect(screen.getByTestId(`handle-${kind}-source-${side}`)).toHaveAttribute("data-position", side);
    expect(screen.getByTestId(`handle-${kind}-target-${side}`)).toHaveAttribute(
      "data-class",
      expect.stringContaining("dezin-flow-handle--routing"),
    );
  }
}

describe("semantic relation routing handles", () => {
  test("component nodes expose four edge-aligned source and target anchors", () => {
    render(<ComponentNode {...{
      data: baseData,
      selected: false,
    } as unknown as NodeProps<WorkspaceFlowNode>} />);

    expectRoutingHandles("component");
  });

  test("resource nodes expose four edge-aligned source and target anchors", () => {
    render(<ResourceNode {...{
      data: {
        ...baseData,
        kind: "resource",
        artifactId: null,
        resourceId: "resource-1",
      },
      selected: false,
    } as unknown as NodeProps<WorkspaceFlowNode>} />);

    expectRoutingHandles("resource");
  });
});
