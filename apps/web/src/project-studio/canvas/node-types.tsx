import { memo } from "react";
import { ArtifactFlowNode } from "./nodes/ArtifactFlowNode.tsx";
import { LayoutGroupNode } from "./nodes/LayoutGroupNode.tsx";
import { ResourceNode } from "./nodes/ResourceNode.tsx";

const artifactNode = memo(ArtifactFlowNode);
export const workspaceNodeTypes = {
  page: artifactNode,
  component: artifactNode,
  resource: memo(ResourceNode),
  group: memo(LayoutGroupNode),
};
