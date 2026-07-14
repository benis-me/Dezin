import { memo } from "react";
import { PrototypeEdge } from "./edges/PrototypeEdge.tsx";
import { RelationshipEdge } from "./edges/RelationshipEdge.tsx";

export const workspaceEdgeTypes = {
  prototype: memo(PrototypeEdge),
  relation: memo(RelationshipEdge),
};
