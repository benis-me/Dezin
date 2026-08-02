import { expect, test } from "vitest";

import { arrangeDesignNodes } from "./auto-layout.ts";
import type { DesignNode } from "./types.ts";

function node(id: string, width: number, height: number, createdAt: number): DesignNode {
  return {
    id,
    kind: "component",
    name: id,
    geometry: { x: 900, y: 900, width, height },
    state: "empty",
    currentVersionId: null,
    selectedVersionId: null,
    versionCount: 0,
    assetId: null,
    activeJobId: null,
    error: null,
    createdAt,
    updatedAt: createdAt,
  };
}

test("smart arrange is deterministic, respects node order, and never overlaps shelves", () => {
  const nodes = [node("wide", 620, 260, 2), node("small", 260, 220, 1), node("tall", 340, 500, 3)];
  const first = arrangeDesignNodes(nodes, ["small", "wide"], { targetWidth: 980, gap: 60 });
  const second = arrangeDesignNodes(nodes, ["small", "wide"], { targetWidth: 980, gap: 60 });
  expect(first).toEqual(second);
  expect(first.map((item) => item.nodeId)).toEqual(["small", "wide", "tall"]);

  for (const [index, item] of first.entries()) {
    for (const other of first.slice(index + 1)) {
      const separated = item.geometry.x + item.geometry.width <= other.geometry.x
        || other.geometry.x + other.geometry.width <= item.geometry.x
        || item.geometry.y + item.geometry.height <= other.geometry.y
        || other.geometry.y + other.geometry.height <= item.geometry.y;
      expect(separated).toBe(true);
    }
  }
});
