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

function expectSideRoutingHandles(kind: "component" | "resource") {
  for (const side of ["left", "right"] as const) {
    expect(screen.getByTestId(`handle-${kind}-source-${side}`)).toHaveAttribute("data-position", side);
    expect(screen.getByTestId(`handle-${kind}-target-${side}`)).toHaveAttribute(
      "data-class",
      expect.stringContaining("dezin-flow-handle--routing"),
    );
  }
  for (const side of ["top", "bottom"] as const) {
    expect(screen.queryByTestId(`handle-${kind}-source-${side}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`handle-${kind}-target-${side}`)).not.toBeInTheDocument();
  }
}

describe("semantic relation routing handles", () => {
  test("component nodes expose only left and right source and target anchors", () => {
    render(<ComponentNode {...{
      data: baseData,
      selected: false,
    } as unknown as NodeProps<WorkspaceFlowNode>} />);

    expectSideRoutingHandles("component");
  });

  test("resource nodes expose only left and right source and target anchors", () => {
    render(<ResourceNode {...{
      data: {
        ...baseData,
        kind: "resource",
        artifactId: null,
        resourceId: "resource-1",
      },
      selected: false,
    } as unknown as NodeProps<WorkspaceFlowNode>} />);

    expectSideRoutingHandles("resource");
  });

  test("a published Resource shows its Revision quality instead of a stale completed generation state", () => {
    render(<ResourceNode {...{
      data: {
        ...baseData,
        kind: "resource",
        artifactId: null,
        resourceId: "resource-1",
        revisionId: "revision-1",
        resourceQualityState: "grounded",
        generationState: "complete",
      },
      selected: false,
    } as unknown as NodeProps<WorkspaceFlowNode>} />);

    expect(screen.getByText("Grounded")).toBeInTheDocument();
    expect(screen.queryByText("Finalizing revision")).not.toBeInTheDocument();
  });
});
