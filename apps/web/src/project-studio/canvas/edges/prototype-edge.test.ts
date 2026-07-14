import { describe, expect, test } from "vitest";
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
});
