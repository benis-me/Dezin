import { Position } from "@xyflow/react";
import { describe, expect, test } from "vitest";
import { prototypeEdgeGeometry } from "./PrototypeEdge.tsx";
import { relationshipEdgeGeometry } from "./RelationshipEdge.tsx";

describe("workspace edge geometry", () => {
  test.each([
    { lane: undefined, name: "direct route" },
    { lane: -1.5, name: "outer sibling lane" },
  ])("keeps prototype and semantic $name geometry aligned for the same anchors", ({ lane }) => {
    const anchors = {
      sourceX: 80,
      sourceY: 80,
      targetX: 440,
      targetY: 80,
      sourcePosition: Position.Top,
      targetPosition: Position.Top,
      lane,
    };

    const prototype = prototypeEdgeGeometry({
      ...anchors,
      source: "page-1",
      target: "page-2",
    });
    const relationship = relationshipEdgeGeometry(anchors);

    expect(prototype).toEqual(relationship);
  });
});
