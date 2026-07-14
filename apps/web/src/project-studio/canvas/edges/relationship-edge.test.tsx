import { fireEvent, render, screen } from "@testing-library/react";
import type { EdgeProps } from "@xyflow/react";
import { describe, expect, test, vi } from "vitest";
import type { WorkspaceFlowEdge } from "../workspace-graph-adapter.ts";
import { RelationshipEdge } from "./RelationshipEdge.tsx";

vi.mock("@xyflow/react", () => ({
  BaseEdge: ({ onMouseEnter, onMouseLeave }: { onMouseEnter?: () => void; onMouseLeave?: () => void }) => (
    <path data-testid="relation-path" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} />
  ),
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  getBezierPath: () => ["M 0 0 C 1 1 2 2 3 3", 10, 20],
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
  data: { kind: "uses", status: null, label: "uses" },
};

describe("relationship edge", () => {
  test("shows its semantic label on selection and hover", () => {
    const selectedProps = { ...baseProps, selected: true } as unknown as EdgeProps<WorkspaceFlowEdge>;
    const idleProps = { ...baseProps, selected: false } as unknown as EdgeProps<WorkspaceFlowEdge>;
    const { rerender } = render(<RelationshipEdge {...selectedProps} />);
    expect(screen.getByText("uses")).toBeInTheDocument();

    rerender(<RelationshipEdge {...idleProps} />);
    expect(screen.queryByText("uses")).toBeNull();
    fireEvent.mouseEnter(screen.getByTestId("relation-path"));
    expect(screen.getByText("uses")).toBeInTheDocument();
  });
});
