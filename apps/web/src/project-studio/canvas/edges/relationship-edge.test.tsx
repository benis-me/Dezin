import { fireEvent, render, screen } from "@testing-library/react";
import type { EdgeProps } from "@xyflow/react";
import { describe, expect, test, vi } from "vitest";
import type { WorkspaceFlowEdge } from "../workspace-graph-adapter.ts";
import { RelationshipEdge, relationshipEdgeGeometry } from "./RelationshipEdge.tsx";

vi.mock("@xyflow/react", () => ({
  BaseEdge: ({ className, interactionWidth }: { className?: string; interactionWidth?: number }) => (
    <>
      <path data-testid={className === "dezin-flow-edge__path" ? "relation-path" : "relation-halo"} />
      {interactionWidth ? <path data-testid="relation-interaction" className="react-flow__edge-interaction" /> : null}
    </>
  ),
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  getSmoothStepPath: ({ offset }: { offset: number }) => [`M 0 0 L ${offset} ${offset}`, 10, 20],
}));

const baseProps = {
  id: "uses-1",
  source: "page-1",
  target: "component-1",
  sourceX: 0,
  sourceY: 0,
  targetX: 100,
  targetY: 100,
  sourcePosition: "right",
  targetPosition: "left",
  markerEnd: undefined,
  data: { kind: "uses", status: null, label: "uses", zoomLevel: "compact" },
};

describe("relationship edge", () => {
  test("gives an outer sibling lane a larger route offset than the inner lane", () => {
    const base = {
      sourceX: 0,
      sourceY: 0,
      targetX: 100,
      targetY: 100,
    } as const;

    expect(relationshipEdgeGeometry({ ...base, lane: 0.5 }).path).toBe("M 0 0 L 30 30");
    expect(relationshipEdgeGeometry({ ...base, lane: 1.5 }).path).toBe("M 0 0 L 48 48");
  });

  test("shows its semantic label on selection and hover", () => {
    const selectedProps = { ...baseProps, selected: true } as unknown as EdgeProps<WorkspaceFlowEdge>;
    const idleProps = { ...baseProps, selected: false } as unknown as EdgeProps<WorkspaceFlowEdge>;
    const { rerender } = render(<RelationshipEdge {...selectedProps} />);
    expect(screen.getByText("uses")).toBeInTheDocument();

    rerender(<RelationshipEdge {...idleProps} />);
    expect(screen.queryByText("uses")).toBeNull();
    fireEvent.mouseEnter(screen.getByTestId("relation-interaction"));
    expect(screen.getByText("uses")).toBeInTheDocument();
  });

  test("keeps semantic labels visible at full canvas zoom", () => {
    const { container } = render(<RelationshipEdge {...{
      ...baseProps,
      selected: false,
      data: { ...baseProps.data, zoomLevel: "full" },
    } as unknown as EdgeProps<WorkspaceFlowEdge>} />);

    expect(screen.getByText("uses")).toBeInTheDocument();
    expect(screen.getByTestId("relation-halo")).toBeInTheDocument();
    const label = container.querySelector("[data-edge-kind='uses']");
    expect(label?.querySelector("svg")).not.toBeNull();
    expect(label?.querySelector("i")).toBeNull();
  });
});
