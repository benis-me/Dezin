import { describe, expect, test } from "vitest";
import { Position } from "@xyflow/react";
import { prototypeEdgeGeometry } from "./PrototypeEdge.tsx";

describe("prototype edge geometry", () => {
  test("routes page self-links around the node instead of through its body", () => {
    const geometry = prototypeEdgeGeometry({
      source: "page-1",
      target: "page-1",
      sourceX: 280,
      sourceY: 100,
      targetX: 0,
      targetY: 100,
    });

    expect(geometry.path).toMatch(/^M 280 100 C /);
    expect(geometry.path).toContain(" 0 100");
    expect(geometry.labelX).toBe(140);
    expect(geometry.labelY).toBeLessThan(0);
  });

  test("moves an outer same-side lane away from its inner sibling without changing the anchors", () => {
    const base = {
      source: "page-1",
      target: "page-2",
      sourceX: 80,
      sourceY: 80,
      targetX: 440,
      targetY: 80,
      sourcePosition: Position.Top,
      targetPosition: Position.Top,
    };

    const inner = prototypeEdgeGeometry({ ...base, lane: -0.5 });
    const outer = prototypeEdgeGeometry({ ...base, lane: -1.5 });

    expect(inner.path).toBe("M80,80 C80,80 440,80 440,80");
    expect(outer).toEqual({
      path: "M 80 80 C 80 32 440 32 440 80",
      labelX: 260,
      labelY: 44,
    });
  });
});
