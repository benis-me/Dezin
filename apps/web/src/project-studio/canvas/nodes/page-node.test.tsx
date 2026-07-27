import { render, screen } from "@testing-library/react";
import type { NodeProps } from "@xyflow/react";
import { describe, expect, test, vi } from "vitest";
import type { WorkspaceFlowNode, WorkspaceFlowNodeData } from "../workspace-graph-adapter.ts";
import { PageNode } from "./PageNode.tsx";

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
  objectId: "page-home",
  kind: "page",
  name: "Home",
  projectId: "project-1",
  artifactId: "artifact-home",
  resourceId: null,
  revisionId: null,
  zoomLevel: "compact",
  incomingCount: 0,
  outgoingCount: 1,
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

describe("page node", () => {
  test("exposes edge-aligned routing handles separately from interactive connection handles", () => {
    const { container } = render(<PageNode {...{
      data,
      selected: false,
      isConnectable: true,
    } as unknown as NodeProps<WorkspaceFlowNode>} />);

    expect(screen.getByTestId("handle-page-source-right")).toHaveAttribute("data-position", "right");
    expect(screen.getByTestId("handle-page-target-left")).toHaveAttribute("data-position", "left");
    expect(screen.getByTestId("handle-page-source-right")).toHaveAttribute(
      "data-class",
      expect.stringContaining("dezin-flow-handle--routing"),
    );
    expect(container.querySelector(".dezin-flow-card__title-mark")).toHaveAttribute("data-kind", "page");
  });

  test("keeps the page title, kind, and generation status legible at overview zoom", () => {
    render(<PageNode {...{
      data: {
        ...data,
        name: "Cinematic Black/Red Home",
        zoomLevel: "overview",
        overviewDirection: "Cinematic Black/Red",
        overviewPageRole: "Home",
        revisionId: "revision-home",
        generationState: "running",
      },
      selected: false,
      isConnectable: true,
    } as unknown as NodeProps<WorkspaceFlowNode>} />);

    expect(screen.getByRole("heading", { name: "Cinematic Black/Red Home" })).toBeInTheDocument();
    expect(screen.getByText("Cinematic Black/Red")).toHaveClass("dezin-flow-card__overview-direction");
    expect(screen.getByText("Home")).toHaveClass("dezin-flow-card__overview-role");
    expect(screen.getByTestId("artifact-preview")).toHaveAttribute("data-artifact-kind", "page");
    expect(screen.getByTestId("artifact-preview")).toHaveAttribute("data-zoom", "overview");
    expect(screen.getByLabelText("Cinematic Black/Red Home status: running")).toHaveClass("dezin-flow-card__overview-meta");
    expect(screen.getByLabelText("Cinematic Black/Red Home status: running")).toHaveTextContent("running");
    expect(screen.queryByText(/rev revision/i)).toBeNull();
  });

  test("marks an overview selection for the stronger canvas selection treatment", () => {
    const { container } = render(<PageNode {...{
      data: { ...data, zoomLevel: "overview" },
      selected: true,
      isConnectable: true,
    } as unknown as NodeProps<WorkspaceFlowNode>} />);

    expect(container.querySelector(".dezin-flow-card")).toHaveAttribute("data-selection-emphasis", "overview");
  });
});
