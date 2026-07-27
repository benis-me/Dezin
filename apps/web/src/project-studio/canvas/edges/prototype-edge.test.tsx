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
  test("routes non-self relations as a calm orthogonal connector", () => {
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

    expect(geometry.path).toContain("L");
    expect(geometry.path).not.toContain("C");
    expect(geometry.labelX).toBeGreaterThan(280);
    expect(geometry.labelX).toBeLessThan(440);
  });

  test("routes symmetric parallel lanes on opposite sides of the direct path", () => {
    const base = {
      source: "page-home",
      target: "page-search",
      sourceX: 280,
      sourceY: 111,
      targetX: 440,
      targetY: 111,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    } as const;

    const upper = prototypeEdgeGeometry({ ...base, lane: -0.5 });
    const lower = prototypeEdgeGeometry({ ...base, lane: 0.5 });

    expect(upper.path).not.toBe(lower.path);
    expect(upper.labelY).toBeLessThan(111);
    expect(lower.labelY).toBeGreaterThan(111);
  });

  test("separates sibling self-loop lanes above and below the page", () => {
    const upper = prototypeEdgeGeometry({
      source: "page-home",
      target: "page-home",
      sourceX: 440,
      sourceY: 111,
      targetX: 280,
      targetY: 111,
      lane: -0.5,
    });
    const lower = prototypeEdgeGeometry({
      source: "page-home",
      target: "page-home",
      sourceX: 440,
      sourceY: 111,
      targetX: 280,
      targetY: 111,
      lane: 0.5,
    });

    expect(upper.path).not.toBe(lower.path);
    expect(upper.labelY).toBeLessThan(111);
    expect(lower.labelY).toBeGreaterThan(111);
  });

  test("keeps planned flows continuous at overview zoom", () => {
    render(<PrototypeEdge {...baseProps} />);

    expect(screen.getByTestId("prototype-path").style.strokeDasharray).toBe("");
  });

  test("keeps the halo and foreground stroke widths stable while the canvas zooms", () => {
    render(<PrototypeEdge {...baseProps} />);

    expect(screen.getByTestId("prototype-halo").style.stroke).toBe("var(--dezin-canvas-plane, var(--background))");
    expect(screen.getByTestId("prototype-halo").style.vectorEffect).toBe("non-scaling-stroke");
    expect(screen.getByTestId("prototype-path").style.vectorEffect).toBe("non-scaling-stroke");
    expect(screen.getByTestId("prototype-path").style.stroke).toBe("var(--foreground-2)");
    expect(screen.getByTestId("prototype-path").style.strokeWidth).toBe("1.35");
    expect(screen.getByTestId("prototype-path").style.opacity).toBe("0.74");
  });

  test("keeps idle labels quiet even at full zoom and reveals them for interaction", () => {
    const fullProps = {
      ...baseProps,
      data: { ...baseProps.data, zoomLevel: "full" },
    } as unknown as EdgeProps<WorkspaceFlowEdge>;
    const { rerender } = render(<PrototypeEdge {...fullProps} />);
    expect(screen.queryByText("to Search")).toBeNull();

    rerender(<PrototypeEdge {...{ ...fullProps, selected: true }} />);
    expect(screen.getByText("to Search")).toBeInTheDocument();
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
