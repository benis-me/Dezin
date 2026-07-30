import { fireEvent, render, screen } from "@testing-library/react";
import type { NodeProps } from "@xyflow/react";
import { describe, expect, test, vi } from "vitest";
import type { WorkspaceFlowNode, WorkspaceFlowNodeData } from "../workspace-graph-adapter.ts";
import { ResourceNode } from "./ResourceNode.tsx";

vi.mock("@xyflow/react", () => ({
  Handle: ({ id }: { id: string }) => <span data-testid={`handle-${id}`} />,
  Position: {
    Left: "left",
    Right: "right",
  },
}));

const oldRevisionPreview = {
  kind: "research" as const,
  executiveSummary: "Revision A decision brief must never appear as Revision B.",
  findingCount: 2,
  evidenceDirectionCount: 1,
  hypothesisDirectionCount: 0,
};

const data: WorkspaceFlowNodeData = {
  objectId: "resource-node-1",
  kind: "resource",
  name: "Audience Research",
  projectId: "project-1",
  artifactId: null,
  resourceId: "research-1",
  resourceKind: "research",
  resourceQualityState: "grounded",
  resourcePreview: oldRevisionPreview,
  resourcePreviewStatus: "ready",
  revisionId: "revision-b",
  zoomLevel: "full",
  incomingCount: 0,
  outgoingCount: 2,
  qualityState: "not-applicable",
  qualityScore: null,
  generationState: "idle",
  collapsed: false,
  parentGroupId: null,
  groupRole: null,
  memberCount: 0,
  minimumGroupWidth: 0,
  minimumGroupHeight: 0,
};

function renderResourceNode(overrides: Partial<WorkspaceFlowNodeData> = {}) {
  return render(<ResourceNode {...{
    data: { ...data, ...overrides },
    selected: false,
    isConnectable: true,
  } as unknown as NodeProps<WorkspaceFlowNode>} />);
}

describe("resource node Revision preview state", () => {
  test("puts an exact-Revision error and Retry ahead of retained preview content", () => {
    const retry = vi.fn();
    renderResourceNode({
      resourcePreviewStatus: "error",
      onRetryResourcePreview: retry,
    });

    expect(screen.getByRole("button", { name: "Retry Audience Research preview" })).toHaveTextContent(
      "Preview unavailable",
    );
    expect(screen.queryByText(oldRevisionPreview.executiveSummary)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry Audience Research preview" }));
    expect(retry).toHaveBeenCalledWith("research-1");
  });

  test("shows refreshing state instead of retained preview content", () => {
    renderResourceNode({ resourcePreviewStatus: "refreshing" });

    expect(screen.getByRole("status")).toHaveTextContent("Refreshing preview");
    expect(screen.queryByText(oldRevisionPreview.executiveSummary)).toBeNull();
  });

  test("does not label an overview error as grounded or Revision ready", () => {
    const { container } = renderResourceNode({
      zoomLevel: "overview",
      resourcePreview: null,
      resourcePreviewStatus: "error",
    });

    expect(container.querySelector(".dezin-flow-card__overview-meta")).toHaveTextContent("Preview unavailable");
    expect(screen.queryByText("Grounded")).toBeNull();
    expect(screen.queryByText("Revision ready")).toBeNull();
    expect(screen.getByText("Research")).toBeInTheDocument();
  });
});
