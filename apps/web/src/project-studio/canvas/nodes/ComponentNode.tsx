import type { NodeProps } from "@xyflow/react";
import type { WorkspaceFlowNode } from "../workspace-graph-adapter.ts";
import { ArtifactFlowNode } from "./ArtifactFlowNode.tsx";

export function ComponentNode(props: NodeProps<WorkspaceFlowNode>) {
  return <ArtifactFlowNode {...props} />;
}
