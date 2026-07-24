import { render, screen } from "@testing-library/react";
import type { NodeProps } from "@xyflow/react";
import { describe, expect, test, vi } from "vitest";
import type { WorkspaceFlowNode, WorkspaceFlowNodeData } from "../workspace-graph-adapter.ts";
import { ComponentNode } from "./ComponentNode.tsx";

vi.mock("@xyflow/react", () => ({
  Handle: ({ id }: { id: string }) => <span data-testid={`handle-${id}`} />,
  Position: {
    Left: "left",
    Right: "right",
    Top: "top",
    Bottom: "bottom",
  },
}));

vi.mock("./ArtifactNodePreview.tsx", () => ({
  ArtifactNodePreview: ({
    artifactKind,
    zoomLevel,
  }: {
    artifactKind: string;
    zoomLevel: string;
  }) => (
    <div
      data-testid="artifact-preview"
      data-artifact-kind={artifactKind}
      data-zoom={zoomLevel}
    />
  ),
}));

const data: WorkspaceFlowNodeData = {
  objectId: "component-order-summary",
  kind: "component",
  name: "Order summary",
  projectId: "project-1",
  artifactId: "artifact-order-summary",
  resourceId: null,
  revisionId: "revision-order-summary",
  zoomLevel: "overview",
  incomingCount: 3,
  outgoingCount: 0,
  qualityState: "passed",
  qualityScore: 94,
  generationState: "idle",
  collapsed: false,
  parentGroupId: "components-group",
  groupRole: "component-library",
  memberCount: 0,
  minimumGroupWidth: 0,
  minimumGroupHeight: 0,
};

describe("component node", () => {
  test("keeps the component title, kind, and quality status legible at overview zoom", () => {
    const { container } = render(<ComponentNode {...{
      data,
      selected: false,
      isConnectable: false,
    } as unknown as NodeProps<WorkspaceFlowNode>} />);

    expect(screen.getByRole("heading", { name: "Order summary" })).toBeInTheDocument();
    expect(screen.getByTestId("artifact-preview")).toHaveAttribute("data-artifact-kind", "component");
    expect(screen.getByTestId("artifact-preview")).toHaveAttribute("data-zoom", "overview");
    expect(screen.getByLabelText("Order summary status: passed")).toHaveTextContent("passed");
    expect(screen.queryByText(/consumers?/i)).toBeNull();
    expect(screen.queryByText(/rev revision/i)).toBeNull();
    expect(container.querySelector(".dezin-flow-card__title-mark")).toHaveAttribute("data-kind", "component");
  });
});
