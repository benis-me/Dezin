import { render, screen } from "@testing-library/react";
import { Position, type EdgeProps } from "@xyflow/react";
import { describe, expect, test, vi } from "vitest";
import type { WorkspaceFlowEdge } from "../workspace-graph-adapter.ts";
import { PrototypeEdge, prototypeEdgeGeometry } from "./PrototypeEdge.tsx";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    BaseEdge: ({
      className,
      interactionWidth,
      style,
    }: {
      className?: string;
      interactionWidth?: number;
      style?: React.CSSProperties;
    }) => (
      <>
        <path
          data-testid={className === "dezin-flow-edge__path" ? "prototype-path" : "prototype-halo"}
          style={style}
        />
        {interactionWidth ? <path className="react-flow__edge-interaction" /> : null}
      </>
    ),
    EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

const baseProps = {
  id: "prototype-1",
  source: "page-home",
  target: "page-search",
  sourceX: 280,
  sourceY: 111,
  targetX: 440,
  targetY: 111,
  sourcePosition: Position.Right,
  targetPosition: Position.Left,
  markerEnd: undefined,
  selected: false,
  data: {
    kind: "prototype",
    status: "planned",
    label: "to Search",
    zoomLevel: "compact",
  },
} as unknown as EdgeProps<WorkspaceFlowEdge>;

describe("prototype edge", () => {
  test("routes non-self relations as one continuous curve", () => {
    const geometry = prototypeEdgeGeometry({
      source: "page-home",
      target: "page-search",
      sourceX: 280,
      sourceY: 111,
      targetX: 440,
      targetY: 111,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    });

    expect(geometry.path).toContain("C");
    expect(geometry.labelX).toBeGreaterThan(280);
    expect(geometry.labelX).toBeLessThan(440);
  });

  test("keeps planned flows continuous at overview zoom", () => {
    render(<PrototypeEdge {...baseProps} />);

    expect(screen.getByTestId("prototype-path").style.strokeDasharray).toBe("");
  });

  test("uses a semantic direction mark instead of a decorative status dot", () => {
    const { container } = render(<PrototypeEdge {...{
      ...baseProps,
      selected: true,
    } as unknown as EdgeProps<WorkspaceFlowEdge>} />);

    const label = container.querySelector("[data-edge-kind='prototype']");
    expect(label).toHaveTextContent("to Search");
    expect(label?.querySelector("svg")).not.toBeNull();
    expect(label?.querySelector("i")).toBeNull();
  });
});
